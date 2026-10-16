import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const inbox = await import('../dist/pages/patient/inbox.js');

const PATIENT = 'patient-demo';
const ACTOR = 'actor-self-1';

/** 患者通知视图的真实形状。 */
function view(overrides = {}) {
  return {
    id: 'n-1',
    alertId: 'alert-1',
    patientId: PATIENT,
    recipientId: ACTOR,
    channel: 'IN_APP',
    attempt: 1,
    generation: 3,
    deliveryState: 'SUBMITTED',
    submittedAt: '2026-10-07T04:00:00.000Z',
    deliveredAt: null,
    confirmedAt: null,
    failedAt: null,
    confirmationSource: null,
    createdAt: '2026-10-07T03:59:00.000Z',
    updatedAt: '2026-10-07T04:00:00.000Z',
    timing: null,
    ...overrides,
  };
}
const expected = { patientId: PATIENT, actorId: ACTOR };

test('收件箱：按 notificationView 的真实字段解析，缺一不可', () => {
  const parsed = inbox.parseItem(view(), expected);
  assert.ok(parsed);
  assert.equal(parsed.channel, 'IN_APP');
  assert.equal(parsed.deliveryState, 'SUBMITTED');
  assert.equal(parsed.recipientId, ACTOR);
  assert.equal(parsed.timing, null);
  // timing 存在时四个子字段齐全才算合法。
  const timed = inbox.parseItem(view({ timing: { mode: 'DEFERRED', reason: '夜间免打扰', eligibleAt: '2026-10-08T00:00:00.000Z', policyVersion: 7 } }), expected);
  assert.deepEqual(timed.timing, { mode: 'DEFERRED', reason: '夜间免打扰', eligibleAt: '2026-10-08T00:00:00.000Z', policyVersion: 7 });
});

test('收件箱：未知字段、内部字段、跨患者、跨接收人必须拒绝', () => {
  assert.equal(inbox.parseItem({ ...view(), extra: 1 }, expected), null);
  // 供应商回执与幂等键绝不能下发给接收人；出现即契约破坏。
  for (const field of ['channelMessageId', 'channelRaw', 'channelStatus', 'payload', 'idempotencyKey', 'leaseToken', 'routingGeneration', 'failureReason']) {
    assert.equal(inbox.parseItem({ ...view(), [field]: 'x' }, expected), null, `${field} 必须被拒绝`);
  }
  assert.equal(inbox.parseItem(view({ patientId: 'other' }), expected), null);
  assert.equal(inbox.parseItem(view({ recipientId: 'other-actor' }), expected), null);
});

test('收件箱：channel / deliveryState 非法枚举与越界字段必须拒绝', () => {
  assert.equal(inbox.parseItem(view({ channel: 'EMAIL' }), expected), null);
  assert.equal(inbox.parseItem(view({ deliveryState: 'SENT' }), expected), null);
  assert.equal(inbox.parseItem(view({ deliveryState: 'DELIVERED' }), expected), null, 'DELIVERED 不是 deliveryState 的合法取值');
  assert.equal(inbox.parseItem(view({ attempt: -1 }), expected), null);
  assert.equal(inbox.parseItem(view({ generation: 1.5 }), expected), null);
  assert.equal(inbox.parseItem(view({ createdAt: 'not-a-time' }), expected), null);
  assert.equal(inbox.parseItem(view({ submittedAt: 'not-a-time' }), expected), null);
  assert.equal(inbox.parseItem(view({ timing: { mode: 'SOON', reason: 'x', eligibleAt: null, policyVersion: null } }), expected), null);
  // 可空字段接受 null，但空串不行。
  assert.equal(inbox.parseItem(view({ confirmationSource: '' }), expected), null);
});

test('三级状态都有人话标签，且「已提交」绝不写成「已送达」', () => {
  const labels = ['PENDING', 'LEASED', 'SUBMITTED', 'FAILED', 'UNKNOWN', 'CANCELLED'].map(state => {
    const parsed = inbox.parseItem(view({ deliveryState: state, submittedAt: state === 'PENDING' || state === 'LEASED' ? null : view().submittedAt }), expected);
    return parsed.label ?? inbox.describe(parsed).stateLabel;
  });
  for (const label of labels) assert.equal(typeof label === 'string' && label.length > 0, true, `每个 deliveryState 都必须有人话标签：${label}`);
  const submitted = inbox.describe(inbox.parseItem(view({ deliveryState: 'SUBMITTED' }), expected));
  assert.equal(submitted.stateLabel.includes('送达'), false, '「已提交」的标签不得出现「送达」二字');
  assert.equal(submitted.timeline.find(row => row.label === '已提交').at.length > 0, true, '已提交要带上提交时间');
  assert.equal(submitted.timeline.some(row => row.label === '已送达'), false, '未送达就不能出现「已送达」行');
});

test('按钮只出现在服务端会接受的动作上，且已确认显示确认时间', () => {
  // 已提交、未失败、未确认 → 可确认，时间线有动作行。
  const open = inbox.describe(inbox.parseItem(view(), expected));
  assert.equal(open.canConfirm, true);
  assert.equal(open.timeline.some(row => row.action === 'CONFIRM'), true);

  // 已确认 → 显示确认时间，不再给按钮。
  const done = inbox.parseItem(view({ confirmedAt: '2026-10-07T05:00:00.000Z', deliveryState: 'FAILED' }), expected);
  assert.equal(inbox.canConfirm(done), false);
  const described = inbox.describe(done);
  assert.equal(described.timeline.some(row => row.action === 'CONFIRM'), false);
  const confirmRow = described.timeline.find(row => row.label === '我已确认');
  assert.ok(confirmRow && confirmRow.at, '已确认必须显示确认时间');
  assert.match(described.detail, /已确认/);

  // 发送失败 → 不给确认按钮，文案如实说没有送达记录。
  const failed = inbox.describe(inbox.parseItem(view({ deliveryState: 'FAILED', failedAt: '2026-10-07T04:30:00.000Z' }), expected));
  assert.equal(failed.canConfirm, false);
  assert.equal(failed.stateLabel.includes('送达'), false);
  assert.match(failed.detail, /没有发出去|没有成功送达/);

  // 结果未知 → 如实说没收到回执，不谎称送达。
  const unknown = inbox.describe(inbox.parseItem(view({ deliveryState: 'UNKNOWN' }), expected));
  assert.match(unknown.detail, /未知|回执/);
  assert.equal(unknown.stateLabel.includes('送达'), false, 'UNKNOWN 不得被说成已送达');

  // 尚未提交（PENDING）→ 没有提交时间，因而不可确认。
  const pending = inbox.describe(inbox.parseItem(view({ deliveryState: 'PENDING', submittedAt: null }), expected));
  assert.equal(pending.canConfirm, false);
});

test('页面只用服务端患者范围，confirm 不带请求体，且时间按亚洲/上海', async () => {
  const [source, markup, wxss] = await Promise.all([
    readFile(new URL('../src/pages/patient/inbox.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/inbox.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/inbox.wxss', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /\/api\/v1\/notifications/);
  assert.match(source, /patientId\(\)/);
  assert.match(source, /session\(\)/);
  assert.match(source, /sameScope/);
  assert.match(source, /Asia\/Shanghai/);
  // confirm 的调用形状：POST 到 /:id/confirm，且不传第三个参数（没有请求体）。
  assert.match(source, /request<unknown>\(`\/api\/v1\/notifications\/\$\{encodeURIComponent\(id\)\}\/confirm`, 'POST'\)/);
  // confirm 的调用行里既没有请求体，也没有幂等键/版本。只查**调用行**：源码别处出现
  // `idempotencyKey` 是 FORBIDDEN_FIELDS 里的守护（拒绝服务端误下发该字段），
  // 不能因此判红 —— 那正是本页该有的防线。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const confirmCall = code.split('\n').filter(line => line.includes('/confirm'));
  assert.equal(confirmCall.length >= 1, true, '必须存在 confirm 调用行');
  for (const line of confirmCall) assert.doesNotMatch(line, /idempotencyKey|expectedVersion|body/);
  // 页面文案不得把「已提交」说成送达：模板里给按钮的措辞是「我看到了」，不是「已送达」。
  assert.match(markup, /我看到了/);
  assert.match(markup, /已提交/);
  assert.doesNotMatch(markup, /已提交且已送达/);
  // 未确认的提示语必须点明「提交不等于送达」。
  assert.match(source, /提交不等于已经送达|提交不等于/);
  // 顶部注释必须如实声明本页没有屏级设计规格。
  assert.match(source, /没有屏级设计规格|完全没有屏级设计规格/);
  // 收件箱沿用患者端统一冷灰底、白卡片与语义色 token。
  assert.match(wxss, /@import "..\/..\/styles\/patient.wxss"/);
  const shared = await readFile(new URL('../src/styles/patient.wxss', import.meta.url), 'utf8');
  assert.match(shared, /var\(--mas-bg\)/);
  assert.match(shared, /var\(--mas-surface\)/);
  assert.match(wxss, /var\(--mas-primary\)|var\(--mas-success\)|var\(--mas-warning\)/);
});
