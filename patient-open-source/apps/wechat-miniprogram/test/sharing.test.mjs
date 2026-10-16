import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const sharing = await import('../dist/pages/patient/sharing.js');

const PATIENT = 'patient-demo';

/** O-04 患者端列表形状（与 data-sharing-service.ts listForPatient 一致）。 */
function item(fromOrgId = 'local-care', toOrgId = 'target-care', overrides = {}) {
  return {
    fromOrgId,
    toOrgId,
    scope: {
      patientId: PATIENT, fromOrgId, toOrgId,
      scopes: { observations: true, medications: true, alerts: true, psychScreening: false, moodDiary: false, lifeInfo: false },
      status: 'PENDING', version: 1, requestedAt: '2026-10-01T00:00:00.000Z',
      lastChangedAt: '2026-10-01T00:00:00.000Z', ...overrides,
    },
  };
}
function list(items = [item()], overrides = {}) {
  return {
    patientId: PATIENT, asOf: '2026-10-08T12:00:00.000Z', items,
    policy: { moodDiary: 'NEVER_SHARED', psychScreeningDefault: 'OFF', patientConfirmationRequired: true },
    ...overrides,
  };
}

test('O-04：解析共享列表，逐项范围翻译成人类可读文案', () => {
  const parsed = sharing.parseSharingList(list(), PATIENT);
  assert.equal(parsed.items.length, 1);
  const [entry] = parsed.items;
  assert.equal(entry.status, 'PENDING');
  assert.equal(entry.statusLabel, '待确认');
  // 规格句式：「XX 现在可以看到你的：…；看不到：…」
  assert.match(entry.visibleText, /target-care.*现在可以看到你的：体温、症状、化验值、用药方案、告警历史。/);
  assert.match(entry.hiddenText, /看不到：心理筛查结果、家庭与生活信息、你自己的记录/);
  assert.equal(entry.choices.find(c => c.key === 'psychScreening').checked, false);
  assert.equal(entry.moodDiaryNote, '你自己写的东西，任何医院都看不到。');
  assert.deepEqual(parsed.policy, { moodDiary: 'NEVER_SHARED', psychScreeningDefault: 'OFF', patientConfirmationRequired: true });
});

test('O-04：未知字段一律拒绝（含机构对、范围、顶层字段）', () => {
  assert.throws(() => sharing.parseSharingList({ ...list(), extra: 1 }, PATIENT), /跨院共享列表响应无效/);
  assert.throws(() => sharing.parseSharingList(list([{ ...item(), extra: 1 }]), PATIENT), /响应无效/);
  assert.throws(() => sharing.parseSharingList(list([item('a', 'b', { extra: 1 })]), PATIENT), /响应无效/);
  // 顶层 patientId 必须与当前会话患者一致。
  assert.throws(() => sharing.parseSharingList(list(), 'other-patient'), /响应无效/);
  // 机构对自洽校验：from 与 to 相同、空串都拒绝。
  assert.throws(() => sharing.parseSharingList(list([item('same', 'same')]), PATIENT), /响应无效/);
  assert.throws(() => sharing.parseSharingList(list([item('', 'target-care')]), PATIENT), /响应无效/);
  // 重复机构对拒绝。
  assert.throws(() => sharing.parseSharingList(list([item(), item()]), PATIENT), /响应无效/);
  // scope 内 fromOrgId/toOrgId 必须与条目一致。
  assert.throws(() => sharing.parseSharingList(list([{ ...item(), scope: { ...item().scope, toOrgId: 'other' } }]), PATIENT), /响应无效/);
});

test('O-04：情绪日记永久关闭——出现 true 或字段缺失都必须拒绝', () => {
  const withDiaryTrue = item('local-care', 'target-care', { scopes: { observations: true, medications: true, alerts: true, psychScreening: false, moodDiary: true, lifeInfo: false } });
  assert.throws(() => sharing.parseSharingList(list([withDiaryTrue]), PATIENT), /响应无效/);
  const missingDiary = item('local-care', 'target-care', { scopes: { observations: true, medications: true, alerts: true, psychScreening: false, lifeInfo: false } });
  assert.throws(() => sharing.parseSharingList(list([missingDiary]), PATIENT), /响应无效/);
  const badFlag = item('local-care', 'target-care', { scopes: { observations: 'yes', medications: true, alerts: true, psychScreening: false, moodDiary: false, lifeInfo: false } });
  assert.throws(() => sharing.parseSharingList(list([badFlag]), PATIENT), /响应无效/);
  // 情绪日记只能是 false；合法响应里心情日记项永远不出现为可勾选项。
  const parsed = sharing.parseSharingList(list(), PATIENT);
  assert.equal(parsed.items[0].choices.some(c => c.key === 'moodDiary'), false);
});

test('O-04：各状态允许的动作与服务端约束一致', () => {
  const [pending] = sharing.parseSharingList(list(), PATIENT).items;
  assert.deepEqual([pending.canConfirm, pending.canUpdate, pending.canRevoke], [true, false, true]);

  const active = sharing.parseSharingList(list([item('local-care', 'target-care', { status: 'ACTIVE', version: 2, patientConfirmedAt: '2026-10-02T00:00:00.000Z' })]), PATIENT).items[0];
  assert.deepEqual([active.canConfirm, active.canUpdate, active.canRevoke], [false, true, true]);
  assert.match(active.confirmedText, /已确认/);

  const revoked = sharing.parseSharingList(list([item('local-care', 'target-care', { status: 'REVOKED', version: 3, revokedAt: '2026-10-03T00:00:00.000Z' })]), PATIENT).items[0];
  assert.deepEqual([revoked.canConfirm, revoked.canUpdate, revoked.canRevoke], [false, false, false]);
  assert.equal(revoked.statusLabel, '已终止');
});

test('O-04：页面只提供患者可做的动作，不出现医护专用动作', async () => {
  const source = await readFile(new URL('../src/pages/patient/sharing.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/patient/sharing.wxml', import.meta.url), 'utf8');
  const json = JSON.parse(await readFile(new URL('../src/pages/patient/sharing.json', import.meta.url), 'utf8'));
  assert.equal(json.navigationBarTitleText, '跨院数据共享');
  assert.match(source, /\/data-sharing\/scopes/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /sameScope/);
  // 医护专用的发起请求动作绝不能出现在页面字面量里（注释不计）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const literals = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join('\n');
  assert.equal(literals.includes('REQUEST'), false, '患者端不得出现 REQUEST');
  for (const action of ['CONFIRM', 'UPDATE', 'REVOKE']) assert.match(literals, new RegExp(action), `患者端应提供 ${action}`);
  // 规格规定文案必须出现。可见性句式是**运行期拼接**的（describe 里按机构与范围拼），
  // 所以它只能在源码里断言；wxml 只渲染 {{item.visibleText}}，断言 markup 必然失败。
  assert.match(source, /现在可以看到你的：/);
  assert.match(source, /现在看不到你的任何记录。/);
  assert.match(markup, /你自己写的东西，任何医院都看不到。/);
  assert.match(markup, /每一项都要单独确认。心理相关的默认不共享。/);
  // 情绪日记只出现为只读说明，不做成可勾选项。
  assert.match(markup, /情绪日记永远不参与跨院共享，这里不提供开关。/);
  assert.equal((markup.match(/bindtap="toggle"/g) ?? []).length, 1);
});

test('切换身份时待重放命令必须一起清空', async () => {
  const source = await readFile(new URL('../src/pages/patient/sharing.ts', import.meta.url), 'utf8');
  const scopeChange = source.slice(source.indexOf('if (key !== this.data.scopeKey)'));
  assert.match(scopeChange.slice(0, 400), /this\.pending = null/);
});
