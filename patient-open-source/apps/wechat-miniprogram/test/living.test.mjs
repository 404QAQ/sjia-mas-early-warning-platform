import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const living = await import('../dist/pages/patient/living.js');

const PATIENT = 'patient-adult';

function view(overrides = {}) {
  return { patientId: PATIENT, enabled: false, version: 0, ...overrides };
}

test('F-09-B：严格解析独居模式读响应，未知字段一律拒绝', () => {
  const parsed = living.parseLivingMode(view({ enabled: true, version: 3, updatedAt: '2026-10-06T04:00:00.000Z' }), PATIENT);
  assert.equal(parsed.patientId, PATIENT);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.updatedAt, '2026-10-06T04:00:00.000Z');

  // updatedAt 可选：没有就不带这个字段。
  const minimal = living.parseLivingMode(view(), PATIENT);
  assert.equal(minimal.updatedAt, undefined);
  assert.equal(Object.hasOwn(minimal, 'updatedAt'), false);

  for (const extra of ['updatedBy', 'created', 'setting', 'extra', 'lifeStage']) {
    assert.throws(() => living.parseLivingMode(view({ [extra]: 1 }), PATIENT), /独居模式响应无效/, `${extra} 必须被拒绝`);
  }
  assert.throws(() => living.parseLivingMode(view(), 'other-patient'), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode({ ...view(), enabled: 'true' }, PATIENT), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode(view({ version: -1 }), PATIENT), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode(view({ version: 1.5 }), PATIENT), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode(view({ version: '1' }), PATIENT), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode(view({ updatedAt: 'not-a-time' }), PATIENT), /独居模式响应无效/);
  assert.throws(() => living.parseLivingMode(view({ updatedAt: '' }), PATIENT), /独居模式响应无效/);
});

test('F-09-B：只有本人（SELF → role PATIENT）才出现可操作开关', () => {
  assert.equal(living.writableForRole('PATIENT'), true);
  for (const role of ['LEGAL_GUARDIAN', 'CAREGIVER', 'SPOUSE', 'PROXY', 'CONTACT']) {
    assert.equal(living.writableForRole(role), false, `${role} 不得出现可操作开关`);
  }
  // 非本人只读时必须说明原因，且不编造权限。
  const reason = living.readOnlyReason('LEGAL_GUARDIAN', false);
  assert.match(reason, /只有成年患者本人/);
  // 本人且未被服务端拒绝时没有只读提示。
  assert.equal(living.readOnlyReason('PATIENT', false), '');
});

test('F-09-B：写入体只含 enabled/expectedVersion/idempotencyKey', async () => {
  const source = await readFile(new URL('../src/pages/patient/living.ts', import.meta.url), 'utf8');
  // 精确取 POST 调用的字面区间：从 'POST' 到紧随其后的 '});'。
  const postIndex = source.indexOf(`'POST'`);
  assert.ok(postIndex > 0, '页面必须用 POST 提交独居模式');
  const body = source.slice(postIndex, source.indexOf('});', postIndex));
  assert.match(body, /enabled: command\.enabled/);
  assert.match(body, /expectedVersion: command\.expectedVersion/);
  assert.match(body, /idempotencyKey: command\.idempotencyKey/);
  // 服务端只接受这三个字段，页面不得夹带任何动作枚举或其他键。
  for (const extra of ['action', 'role', 'patientId:', 'relation', 'secondConfirmation']) {
    assert.equal(body.includes(extra), false, `写入体不得包含 ${extra}`);
  }
  assert.match(source, /expectedVersion/);
  assert.match(source, /sameScope/);
  assert.match(source, /LIVING_MODE_VERSION_CONFLICT/);
});

test('F-09-B：页面文案不得给出未经证实的因果承诺', async () => {
  const [source, markup] = await Promise.all([
    readFile(new URL('../src/pages/patient/living.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/living.wxml', import.meta.url), 'utf8'),
  ]);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const literals = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join('\n');
  // 这些是把设置包装成必然后果或承诺的词组，代码里查不到依据，绝不能出现。
  const banned = ['更频繁', '会更快', '立刻联系', '马上联系', '自动通知', '会自动', '就会提醒', '会派人', '会有人联系', '会救', '更安全', '一定'];
  for (const phrase of banned) {
    assert.equal(literals.includes(phrase), false, `文案不得承诺「${phrase}」`);
    assert.equal(markup.includes(phrase), false, `模板不得承诺「${phrase}」`);
  }
  // 只允许描述能证实的事实：进入安全网投影，供照护团队参考。
  assert.match(literals, /供照护团队参考/);
  assert.match(literals, /安全网/);
  // 只读时展示原因，不能只给一个干开关或空白。
  assert.match(markup, /readOnlyReason/);
  assert.match(markup, /wx:if="\{\{canOperate\}\}"/);
  assert.match(markup, /else/);
  // 原生 switch 展示当前真实值，保存期间禁用，变更仍走同一服务端操作。
  assert.match(markup, /<switch[^>]+checked="\{\{living.enabled\}\}"[^>]+bindchange="onToggle"[^>]+disabled="\{\{saving\}\}"/);
});

test('服务端 403 之后的只读回退必须是粘性的，不能被随后的 load() 抹掉', async () => {
  // 回归：apply() 原先无条件用 writableForRole(role) 重置 canOperate，而
  // role === 'PATIENT' 时它恒为 true（客户端只有 role，看不到 lifeStage，
  // 未成年本人也是 PATIENT）。于是写 403 之后设的只读态被紧接着的 load() 覆盖，
  // 用户看到的是一个永远失败、且页面上没有任何解释的开关。
  const source = await readFile(new URL('../src/pages/patient/living.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/patient/living.wxml', import.meta.url), 'utf8');
  // 粘性标志存在，且 apply() 与写 403 分支都尊重它。
  assert.match(source, /serverDeniedWrite/);
  assert.match(source, /writableForRole\(role\) && !this\.serverDeniedWrite/);
  // 顺序：必须先置粘性标志、再 load，最后才置只读，否则 apply() 会覆盖只读态。
  const branch = source.slice(source.indexOf('if (status === 403)'));
  assert.ok(branch.indexOf('this.serverDeniedWrite = true') < branch.indexOf('await this.load(expected)'), '先置标志再 load');
  assert.ok(branch.indexOf('await this.load(expected)') < branch.indexOf('canOperate: false'), 'load 之后再置只读');
  // 换身份必须清掉粘性标志，否则新身份一进来就是只读。
  assert.match(source, /serverDeniedWrite = false/);
  // 未知结果必须能重放同一命令：有 pendingText 提示，也有可点的重试入口。
  assert.match(source, /pendingText/);
  assert.match(markup, /bindtap="retry"/);
  assert.match(markup, /重试原操作/);
});

test('读被拒与写被拒用不同文案：能看不能改 ≠ 看不到这项设置', async () => {
  const source = await readFile(new URL('../src/pages/patient/living.ts', import.meta.url), 'utf8');
  assert.match(source, /当前身份无权查看独居模式/);
  // 读 403 分支不得套用写被拒的文案，也不得展示事实说明（连这项设置都不该看到）。
  const readBranch = source.slice(source.indexOf('const denied = error instanceof ApiFailure'), source.indexOf('独居模式读取失败'));
  assert.match(readBranch, /unreadableReason/);
  assert.equal(readBranch.includes('readOnlyReason(this.data.role as Role, true)'), false);
  assert.match(readBranch, /factLines: \[\]/);
});
