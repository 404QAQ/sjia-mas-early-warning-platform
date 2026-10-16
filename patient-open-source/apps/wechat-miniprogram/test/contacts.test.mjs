import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const contacts = await import('../dist/pages/patient/contacts.js');

const PATIENT = 'patient-demo';

/** F-09-A 服务端 ContactAuthorizationView 的真实回执形状（contact-safety-service.ts:583 的 view 投影）。 */
function view(overrides = {}) {
  return {
    contactId: 'contact-1',
    patientId: PATIENT,
    displayName: '王某某',
    phoneMasked: '138****8888',
    tier: 1,
    status: 'ACTIVE',
    priority: 1,
    visibility: 'G2_SUMMARY',
    quietHours: null,
    consentText: '我授权你在紧急情况下联系我确认状态。',
    version: 2,
    grantedAt: '2026-04-01T04:00:00.000Z',
    lastConfirmedAt: '2026-04-01T04:00:00.000Z',
    freshness: 'CURRENT',
    nextConfirmAt: '2026-10-01T04:00:00.000Z',
    withdrawnAt: null,
    ...overrides,
  };
}

test('F-09-A：严格解析联系人授权列表（数组）', () => {
  const parsed = contacts.parseList([view()], PATIENT);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].contactId, 'contact-1');
  assert.equal(parsed[0].status, 'ACTIVE');
  assert.equal(parsed[0].visibility, 'G2_SUMMARY');
  assert.equal(parsed[0].phoneMasked, '138****8888');
  assert.equal(parsed[0].freshness, 'CURRENT');
});

test('F-09-A：未知字段一律拒绝（前端不静默接受契约扩张）', () => {
  assert.throws(() => contacts.parseList([view({ extra: 1 })], PATIENT), /联系人授权响应格式无效/);
  // 服务端从不返回这些字段，出现即契约破坏：明文号码、密文、盲索引、同意人/撤回人。
  for (const field of ['phone', 'phoneEncrypted', 'phoneIndex', 'grantedBy', 'withdrawnBy', 'consentRef']) {
    assert.throws(() => contacts.parseList([view({ [field]: 'x' })], PATIENT), /联系人授权响应格式无效/, `${field} 必须被拒绝`);
  }
});

test('F-09-A：非法枚举值与越界版本被拒绝', () => {
  assert.throws(() => contacts.parseList([view({ status: 'PENDING' })], PATIENT));
  assert.throws(() => contacts.parseList([view({ status: 'ACTIVE ' })], PATIENT));
  assert.throws(() => contacts.parseList([view({ visibility: 'G3_FULL' })], PATIENT), /联系人授权响应格式无效/, 'G3 不在联系人授权可见度内');
  assert.throws(() => contacts.parseList([view({ visibility: 'G1' })], PATIENT));
  assert.throws(() => contacts.parseList([view({ priority: 3 })], PATIENT));
  assert.throws(() => contacts.parseList([view({ priority: 0 })], PATIENT));
  assert.throws(() => contacts.parseList([view({ freshness: 'EXPIRED' })], PATIENT));
  assert.throws(() => contacts.parseList([view({ version: -1 })], PATIENT));
  assert.throws(() => contacts.parseList([view({ version: 1.5 })], PATIENT));
  assert.throws(() => contacts.parseList([view({ tier: 3 })], PATIENT));
  assert.throws(() => contacts.parseList([view({ patientId: 'other' })], PATIENT), /联系人授权响应格式无效/, '跨患者回执必须拒绝');
  assert.throws(() => contacts.parseList([view({ nextConfirmAt: '不是时间' })], PATIENT));
  assert.throws(() => contacts.parseList({ data: [] }, PATIENT), /联系人授权响应格式无效/, 'data 必须是数组');
});

test('F-09-A：可空字段与 NONE 状态（未见过的联系人）也能解析', () => {
  const parsed = contacts.parseList([view({ status: 'NONE', priority: null, visibility: null, quietHours: null, consentText: null, version: 0, grantedAt: null, lastConfirmedAt: null, freshness: 'NONE', nextConfirmAt: null, withdrawnAt: null, phoneMasked: undefined, tier: undefined })], PATIENT);
  assert.equal(parsed[0].status, 'NONE');
  assert.equal(parsed[0].priority, null);
  assert.equal(parsed[0].visibility, null);
  assert.equal(parsed[0].phoneMasked, null);
  assert.equal(parsed[0].tier, null);
});

test('F-09-A：动作可见性与服务端门禁一致，不制造必然失败的按钮', () => {
  const none = contacts.describeRow(contacts.parseList([view({ status: 'NONE', version: 0, priority: null, visibility: null, freshness: 'NONE' })], PATIENT)[0]);
  assert.equal(none.canGrant, true, 'NONE 可以授予');
  assert.equal(none.canWithdraw, false);
  assert.equal(none.canConfirm, false);

  const activeCurrent = contacts.describeRow(contacts.parseList([view({ status: 'ACTIVE', freshness: 'CURRENT' })], PATIENT)[0]);
  assert.equal(activeCurrent.canGrant, true, '有效授权可以调整可见度与联系顺序');
  assert.equal(activeCurrent.canWithdraw, true);
  assert.equal(activeCurrent.canConfirm, false, 'CURRENT 无需确认');

  const activeDue = contacts.describeRow(contacts.parseList([view({ status: 'ACTIVE', freshness: 'DUE' })], PATIENT)[0]);
  assert.equal(activeDue.canConfirm, true);

  const activeStale = contacts.describeRow(contacts.parseList([view({ status: 'ACTIVE', freshness: 'STALE' })], PATIENT)[0]);
  assert.equal(activeStale.canConfirm, true);
  assert.equal(activeStale.freshnessLabel, '授权已过期，需要重新确认');

  const withdrawn = contacts.describeRow(contacts.parseList([view({ status: 'WITHDRAWN', freshness: 'NONE', withdrawnAt: '2026-05-01T04:00:00.000Z' })], PATIENT)[0]);
  assert.equal(withdrawn.canGrant, true, '已撤回可以重新授予');
  assert.equal(withdrawn.canWithdraw, false, '已撤回不能再撤回');
  assert.equal(withdrawn.canConfirm, false);
});

test('F-09-A：新鲜度翻成人话，可见度含义与服务端口径一致', () => {
  assert.equal(contacts.describeRow(contacts.parseList([view({ freshness: 'DUE' })], PATIENT)[0]).freshnessLabel, '授权需要重新确认');
  assert.equal(contacts.describeRow(contacts.parseList([view({ visibility: 'G1_NOTIFY' })], PATIENT)[0]).visibilityLabel, '仅通知 · 不显示健康记录');
  assert.match(contacts.describeRow(contacts.parseList([view({ visibility: 'G2_SUMMARY' })], PATIENT)[0]).visibilityLabel, /摘要/);
  assert.equal(contacts.describeRow(contacts.parseList([view({ quietHours: { from: '22:00', to: '07:00' } })], PATIENT)[0]).quietLabel, '勿扰时段：22:00–07:00（按 UTC 计算）');
});

test('F-09-A：撤回后果文案把「失效的短链条数」说清楚', () => {
  assert.match(contacts.withdrawEffect(0), /没有需要失效的短链/);
  assert.match(contacts.withdrawEffect(3), /同时失效了 3 条已发出的联系人短链/);
});

test('F-09-A：写操作响应体解析（authorization + invalidatedLinkCount + created）', () => {
  const parsed = contacts.parseMutation({ authorization: view({ status: 'WITHDRAWN', freshness: 'NONE', withdrawnAt: '2026-06-01T04:00:00.000Z' }), invalidatedLinkCount: 2, created: true }, PATIENT);
  assert.equal(parsed.authorization.status, 'WITHDRAWN');
  assert.equal(parsed.invalidatedLinkCount, 2);
  assert.throws(() => contacts.parseMutation({ authorization: view(), invalidatedLinkCount: -1, created: true }, PATIENT), /联系人授权响应格式无效/);
  assert.throws(() => contacts.parseMutation({ authorization: view(), invalidatedLinkCount: 0, created: true, extra: 1 }, PATIENT), /联系人授权响应格式无效/);
});

test('F-09-A：页面源码只发允许字段，撤回必须二次确认，且不出现明文号码字段', async () => {
  const [source, markup] = await Promise.all([
    readFile(new URL('../src/pages/patient/contacts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/contacts.wxml', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /\/contact-authorizations/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /sameScope/);
  assert.match(source, /'G1_NOTIFY'/);
  assert.match(source, /'G2_SUMMARY'/);

  // grant 请求体只包含服务端 allowed 集合里的字段。
  assert.match(source, /priority: this\.data\.formPriority/);
  assert.match(source, /visibility: this\.data\.formVisibility/);
  assert.match(source, /consentText: consent/);
  assert.match(source, /quietHours/);

  // 撤回必须经过二次确认（confirmingWithdrawId 守卫），不是一次点击完成。
  assert.match(source, /confirmingWithdrawId/);
  assert.match(markup, /确认撤回/);
  assert.match(markup, /先不撤回/);

  // 服务端返回的是脱敏号码字段 phoneMasked；页面不得出现明文号码字段名。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const literals = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join('\n');
  for (const banned of ['phoneEncrypted', 'phoneIndex']) {
    assert.equal(literals.includes(banned), false, `前端不得引用明文/密文号码字段 ${banned}`);
    assert.equal(markup.includes(banned), false, `模板不得出现 ${banned}`);
  }
  assert.match(markup, /item\.phoneMasked/, '模板只渲染由 phoneMasked 生成的脱敏号码');

  // 未提供入口的服务端未接通能力：不出现 G3 授权入口（服务端会 400）。
  assert.equal(markup.includes('G3_FULL'), false, '联系人授权页不得提供 G3 入口');
});

test('切换身份时待重放命令必须一起清空，不得把上一身份的命令重放到新身份', async () => {
  // 回归：onShow 在 scopeKey 变化时清了 UI 状态却留下 this.pending，
  // send() 会在 (contactId, action) 命中时复用旧命令，把上一身份生成的
  // expectedVersion/幂等键 POST 到新患者的 URL 上。
  const source = await readFile(new URL('../src/pages/patient/contacts.ts', import.meta.url), 'utf8');
  const scopeChange = source.slice(source.indexOf('if (key !== this.data.scopeKey)'));
  assert.match(scopeChange.slice(0, 400), /this\.pending = null/);
});
