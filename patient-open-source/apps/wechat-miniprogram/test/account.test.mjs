import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const account = await import('../dist/pages/patient/account.js');
const accountPage = registered.at(-1);
const homePage = await loadPage(registered, new URL('../dist/pages/home/index.js', import.meta.url).href);

const PATIENT = 'patient-demo';

/** T-06 家属端拿到的回执形状（服务端已按关系裁剪）。 */
function view(overrides = {}) {
  return { patientId: PATIENT, status: 'DECEASED', registeredAt: '2026-10-01T04:00:00.000Z', reversibleUntil: '2026-10-02T04:00:00.000Z', recordRetention: 'MEMORIAL', notifyContacts: [], version: 2, ...overrides };
}

test('T-06：按亲属可见的字段解析档案状态', () => {
  const parsed = account.parseLifecycle(view(), PATIENT);
  assert.equal(parsed.status, 'DECEASED');
  assert.equal(parsed.recordRetention, 'MEMORIAL');
  assert.equal(parsed.version, 2);
  const described = account.describe(parsed);
  // 已登记离世 → 可转纪念档案、可申请删除；不可撤回删除申请。
  assert.equal(described.canMemorial, true);
  assert.equal(described.canDelete, true);
  assert.equal(described.canCancel, false);
  assert.equal(described.note, '这两件事都不需要你现在决定。');
  assert.match(described.sections.map(item => item.body).join('\n'), /都已停止/);
});

test('T-06：医护专属字段与通知联系人绝不接受（家属端契约）', () => {
  // registeredBy / updatedAt / updatedBy / history 只在医护视图出现，家属端拿到即为契约破坏。
  for (const field of ['registeredBy', 'updatedAt', 'updatedBy', 'history']) {
    assert.throws(() => account.parseLifecycle(view({ [field]: 'x' }), PATIENT), /档案状态响应无效/, `${field} 必须被拒绝`);
  }
  assert.throws(() => account.parseLifecycle(view({ notifyContacts: [{ contactId: 'c-1', method: 'PHONE' }] }), PATIENT), /档案状态响应无效/);
  assert.throws(() => account.parseLifecycle(view(), 'other-patient'));
  assert.throws(() => account.parseLifecycle(view({ status: 'UNKNOWN' }), PATIENT));
  assert.throws(() => account.parseLifecycle(view({ version: -1 }), PATIENT));
  assert.throws(() => account.parseLifecycle(view({ recordRetention: 'WHATEVER' }), PATIENT));
  assert.throws(() => account.parseLifecycle({ ...view(), extra: 1 }, PATIENT));
});

test('T-06：各状态允许的动作与服务端约束一致', () => {
  const active = account.describe(account.parseLifecycle(view({ status: 'ACTIVE', registeredAt: undefined, recordRetention: undefined }), PATIENT));
  // 尚未登记离世：可以转纪念档案，但不能申请删除（服务端 STATE_CONFLICT）。
  assert.equal(active.canMemorial, true);
  assert.equal(active.canDelete, false);
  assert.equal(active.canCancel, false);

  const requested = account.describe(account.parseLifecycle(view({ status: 'DELETED_REQUESTED', deleteAfter: '2026-10-04T04:00:00.000Z' }), PATIENT));
  assert.equal(requested.canCancel, true);
  assert.equal(requested.canDelete, false);
  assert.equal(requested.note, '', '已提交删除时不再重复「不需要现在决定」');
  assert.match(requested.sections.map(item => item.body).join('\n'), /冷静期|之后删除/);

  const memorial = account.describe(account.parseLifecycle(view({ status: 'MEMORIAL' }), PATIENT));
  assert.equal(memorial.canDelete, true);
  assert.equal(memorial.canMemorial, false);
});

test('T-06：页面文案不得出现慰问语，也不得把删除做成一次点击', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(app.pages.includes('pages/patient/account'));
  const [source, markup, home] = await Promise.all([
    readFile(new URL('../src/pages/patient/account.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /\/lifecycle/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /'REQUEST_MEMORIAL'/);
  assert.match(source, /'REQUEST_DELETE'/);
  assert.match(source, /'CANCEL_DELETE'/);
  assert.match(source, /secondConfirmation: true/);
  assert.match(source, /sameScope/);
  // 规格的硬要求：禁止慰问语，且删除必须经过二次确认。
  // 只看**去掉注释后**的字符串字面量：注释里点名禁用词或点名医护专属动作，是在声明边界，
  // 不是给用户看的文案，也不算前端调用了那个动作。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const literals = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join('\n');
  for (const banned of ['节哀', '与您同在', '愿他安息', '一路走好']) {
    assert.equal(literals.includes(banned), false, `页面文案不得出现「${banned}」`);
    assert.equal(markup.includes(banned), false, `页面不得出现「${banned}」`);
  }
  assert.match(markup, /不需要你现在决定/);
  assert.match(markup, /确认申请删除/);
  assert.match(markup, /先不删除/);
  // 登记离世只有医护能做，家属页面上不出现该动作。
  // 同样只看字面量：顶部注释里点名这两个动作是在说明「这里不做」，不是调用。
  for (const clinicianOnly of ['REGISTER_DECEASED', 'REVOKE_DECEASED']) {
    assert.equal(literals.includes(clinicianOnly), false, `家属端不得出现 ${clinicianOnly}`);
  }
  // 服务端尚未接通的两种处置不提供入口：这是刻意的（给一个必然 503 的按钮比不给更糟）。
  // 让「未接通」变成「可用」的按钮只可能是模板里出现对应选项，所以查模板。
  for (const unready of ['临床价值', '通知家属', '电话']) {
    assert.equal(markup.includes(unready), false, `未接通的处置不得出现「${unready}」入口`);
  }
  // 解析器仍然必须认识 CLINICAL_WITH_CONSENT：服务端形态合法，只是当前不提供入口。
  assert.ok(account.parseLifecycle(view({ recordRetention: 'CLINICAL_WITH_CONSENT' }), PATIENT).recordRetention === 'CLINICAL_WITH_CONSENT');
  // 首页进入个人档案；敏感的档案处置仍在档案页中低强调、默认折叠且分两步确认。
  assert.match(home, /class="footer-entry" bindtap="openAccount"/);
  assert.doesNotMatch(home, /bindtap="(?:showChoices|requestDelete|memorial)"/);
  assert.match(markup, /class="quiet" bindtap="showChoices"/);
  const { calls } = installWx(() => [404, {}]);
  instantiate(homePage).openAccount();
  assert.deepEqual(calls.navigations, [['switchTab', '/pages/patient/account']]);
  const accountInstance = instantiate(accountPage);
  accountInstance.apply(account.parseLifecycle(view(), PATIENT));
  assert.equal(accountInstance.data.showingChoices, false);
  assert.equal(accountInstance.data.confirmingDelete, false);
  accountInstance.showChoices();
  assert.equal(accountInstance.data.showingChoices, true);
  assert.equal(accountInstance.data.confirmingDelete, false, '展开处置选项不能直接确认删除');
  accountInstance.askDelete();
  assert.equal(accountInstance.data.confirmingDelete, true);
  assert.equal(calls.requests.length, 0, '进入档案、展开选项和询问删除详情均不能自动提交处置');
});
