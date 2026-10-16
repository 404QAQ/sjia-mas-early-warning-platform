import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = new Map();
let loadingPage = '';
globalThis.Page = options => { pages.set(loadingPage, options); };
loadingPage = 'auth'; await import('../dist/pages/auth/index.js');
loadingPage = 'bind'; await import('../dist/pages/auth/bind.js');
const { ApiFailure, bindWechatWithInvite, loginWithWechat, session, unbindWechat } = await import('../dist/api.js');
const { INVITE_CODE_ALPHABET, formatInviteCode, normalizeInviteCode } = await import('../dist/invite-code.js');

const SESSION_KEY = 'mas.wechat.session.v1';
const oldSession = { accessToken: 'old-access', refreshToken: 'old-refresh', userId: 'user-old', actorIds: ['actor-old'], actorId: 'actor-old', role: 'PATIENT', patientId: 'patient-old' };
const tokens = { accessToken: 'new-access', refreshToken: 'new-refresh', userId: 'user-caregiver', actorIds: ['actor-caregiver'], accessExpiresAt: '2099-01-01T00:00:00.000Z', refreshExpiresAt: '2099-01-02T00:00:00.000Z' };
const actors = [{ id: 'actor-caregiver', patientId: 'patient-1', relation: 'LEGAL_GUARDIAN', activeFrom: '2000-01-01T00:00:00.000Z' }];

/** 微信运行时桩：记录 wx.login 次数、请求与跳转；respond 按路径返回 HTTP 状态与响应体。 */
function installWx(respond, { stored } = {}) {
  const storage = new Map(stored ? [[SESSION_KEY, structuredClone(stored)]] : []);
  const calls = { login: 0, requests: [], navigations: [], storage };
  globalThis.wx = {
    login(options) { calls.login += 1; options.success({ code: `wx-code-${calls.login}` }); },
    request(options) {
      const path = new URL(options.url).pathname;
      calls.requests.push({ path, method: options.method, data: options.data, header: options.header });
      const [statusCode, data] = respond(path, options);
      options.success({ statusCode, data });
      return { abort() {} };
    },
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, structuredClone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    redirectTo(options) { calls.navigations.push(['redirectTo', options.url]); },
    reLaunch(options) { calls.navigations.push(['reLaunch', options.url]); },
    navigateTo(options) { calls.navigations.push(['navigateTo', options.url]); },
    switchTab(options) { calls.navigations.push(['switchTab', options.url]); },
    showToast() {},
  };
  return calls;
}

function pageContext() {
  return { data: {}, setData(value) { Object.assign(this.data, value); } };
}

function bindFlow(bindReply) {
  return path => {
    if (path === '/api/v1/auth/wechat/bind') return bindReply();
    if (path === '/api/v1/auth/actors') return [200, { data: actors }];
    throw new Error(`unexpected request ${path}`);
  };
}

test('邀请码规范化只容忍抄写差异，并遵守公开患者端字母表', async () => {
  assert.equal(normalizeInviteCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeInviteCode(' ＡＢＣＤ　ｅｆｇｈ '), 'ABCDEFGH');
  assert.equal(normalizeInviteCode('AB CD_EF·GH'), 'ABCDEFGH');
  for (const invalid of ['ABCDEFG', 'ABCDEFGHJ', 'ABCD0EFG', 'ABCD1EFG', 'ABCDIEFG', 'ABCDOEFG', '', 123, undefined, 'A'.repeat(65)]) {
    assert.equal(normalizeInviteCode(invalid), null, `应拒绝 ${String(invalid)}`);
  }
  assert.equal(formatInviteCode('ABCDEFGH'), 'ABCD-EFGH');
  // 医生端绑定实现属于内部仓库，公开版只发布患者输入契约。
  assert.equal(INVITE_CODE_ALPHABET, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
});

test('邀请码格式不对时本地报错，不消耗微信 code，也不请求服务端', async () => {
  const calls = installWx(() => { throw new Error('不应发出请求'); });
  await assert.rejects(bindWechatWithInvite('ABC'), /8 位字母或数字/);
  assert.equal(calls.login, 0);
  assert.equal(calls.requests.length, 0);
});

test('绑定使用新的一次性 code、不带旧会话，并保存服务端签发的会话', async () => {
  const calls = installWx(bindFlow(() => [200, { data: tokens }]), { stored: oldSession });
  const next = await bindWechatWithInvite('abcd-efgh');
  assert.equal(calls.login, 1);
  const [bind, actorList] = calls.requests;
  assert.equal(bind.path, '/api/v1/auth/wechat/bind');
  assert.equal(bind.method, 'POST');
  assert.deepEqual(bind.data, { code: 'wx-code-1', inviteCode: 'ABCDEFGH' });
  assert.equal(bind.header.authorization, undefined, '绑定请求不能带旧账户的会话');
  assert.equal(bind.header['x-actor-id'], undefined);
  assert.equal(actorList.path, '/api/v1/auth/actors');
  assert.equal(actorList.header.authorization, 'Bearer new-access');
  assert.equal(next.actorId, 'actor-caregiver');
  assert.equal(session()?.userId, 'user-caregiver');
  assert.equal(session()?.role, 'LEGAL_GUARDIAN');
  assert.equal(session()?.patientId, 'patient-1');
});

test('服务端错误码进入 ApiFailure；未绑定时登录页突出邀请码入口', async () => {
  const notBound = { error: { code: 'WECHAT_IDENTITY_NOT_BOUND', message: '这个微信还没有绑定患者或家属身份。请向主管医生索取邀请码，然后点「我有医生给的邀请码」完成绑定', details: { bindable: true } } };
  const calls = installWx(() => [403, notBound]);
  await assert.rejects(loginWithWechat(), error => error instanceof ApiFailure && error.status === 403 && error.code === 'WECHAT_IDENTITY_NOT_BOUND');
  const auth = pageContext();
  await pages.get('auth').login.call(auth);
  assert.equal(auth.data.notBound, true);
  assert.match(auth.data.error, /邀请码/);
  assert.equal(auth.data.loading, false);
  assert.equal(session(), null, '未绑定时不能留下会话');
  assert.deepEqual(calls.navigations, [], '未绑定时不能跳进首页');
  pages.get('auth').openBind.call(auth);
  assert.deepEqual(calls.navigations, [['navigateTo', '/pages/auth/bind']]);

  installWx(() => [503, { error: { code: 'WECHAT_AUTH_UNAVAILABLE', message: '微信身份服务暂不可用，请稍后重试' } }]);
  const unavailable = pageContext();
  await pages.get('auth').login.call(unavailable);
  assert.equal(unavailable.data.notBound, false, '服务不可用不能被说成「没绑定」');
  assert.match(unavailable.data.error, /暂不可用/);
});

test('绑定页每次提交都重新取 code；服务端拒绝时不保存会话、不跳转', async () => {
  let reply = () => [400, { error: { code: 'WECHAT_INVITE_CODE_INVALID', message: '邀请码不正确或已被使用，请核对后重试，或联系医生重新生成' } }];
  const calls = installWx(bindFlow(() => reply()));
  const bind = pageContext();
  pages.get('bind').onCodeInput.call(bind, { detail: { value: 'abcd efgh' } });
  assert.equal(bind.data.preview, 'ABCD-EFGH');
  pages.get('bind').onCodeInput.call(bind, { detail: { value: 'abcd' } });
  assert.equal(bind.data.preview, '');
  pages.get('bind').onCodeInput.call(bind, { detail: { value: 'abcd efgh' } });
  await pages.get('bind').submit.call(bind);
  assert.match(bind.data.error, /邀请码不正确/);
  assert.equal(bind.data.submitting, false);
  assert.equal(session(), null);
  assert.deepEqual(calls.navigations, []);

  reply = () => [200, { data: tokens }];
  await pages.get('bind').submit.call(bind);
  assert.equal(calls.login, 2, 'wx.login 的 code 只能用一次，重试必须重新获取');
  assert.deepEqual(calls.requests.filter(item => item.path === '/api/v1/auth/wechat/bind').map(item => item.data.code), ['wx-code-1', 'wx-code-2']);
  assert.deepEqual(calls.navigations, [['switchTab', '/pages/home/index']]);
  assert.equal(session()?.actorId, 'actor-caregiver');
});

test('解除绑定只在服务端确认后清除本地会话，畸形响应不清除', async () => {
  const current = { ...oldSession, userId: 'user-caregiver', actorIds: ['actor-caregiver'], actorId: 'actor-caregiver', role: 'LEGAL_GUARDIAN', patientId: 'patient-1' };
  for (const [data, revoked] of [[{ revoked: true, sessionsRevoked: true }, true], [{ revoked: false, sessionsRevoked: false }, false]]) {
    const calls = installWx(() => [200, { data }], { stored: current });
    assert.deepEqual(await unbindWechat(), { revoked });
    assert.equal(calls.requests[0].path, '/api/v1/auth/wechat/binding');
    assert.equal(calls.requests[0].method, 'DELETE');
    assert.equal(calls.requests[0].header.authorization, 'Bearer old-access');
    assert.equal(session() === null, revoked);
  }
  for (const data of [{ revoked: 'yes', sessionsRevoked: true }, { revoked: true }, { revoked: true, sessionsRevoked: true, bindingId: 'x' }]) {
    installWx(() => [200, { data }], { stored: current });
    await assert.rejects(unbindWechat(), /格式无效/);
    assert.equal(session()?.actorId, 'actor-caregiver');
  }
});

test('退出或解除绑定后清理上一次的男女入口意向', async () => {
  const entryKey = 'mas.wechat.entry-sex-intent.v1';
  const current = { ...oldSession, userId: 'user-caregiver', actorIds: ['actor-caregiver'], actorId: 'actor-caregiver', role: 'LEGAL_GUARDIAN', patientId: 'patient-1' };
  const calls = installWx(() => [200, { data: { revoked: true, sessionsRevoked: true } }], { stored: current });
  calls.storage.set(entryKey, 'FEMALE');
  await unbindWechat();
  assert.equal(calls.storage.has(entryKey), false);
  const { logout } = await import('../dist/api.js');
  const loggedOut = installWx(() => [204, { data: {} }], { stored: current });
  loggedOut.storage.set(entryKey, 'MALE');
  await logout();
  assert.equal(loggedOut.storage.has(entryKey), false);
});

test('绑定页已注册，登录页与首页提供邀请码入口和本人解绑入口', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(app.pages.includes('pages/auth/bind'));
  // 启动页现在是封面页（伪装页），但「登录页必须仍是入口页」这条要求没有放松：
  // 封面页只有一颗按钮，且必须指向登录页 / 首页，不允许出现第二条看起来更有吸引力的路。
  assert.equal(app.pages[0], 'pages/cover/index', '启动页应为封面页');
  const coverMarkup = await readFile(new URL('../src/pages/cover/index.wxml', import.meta.url), 'utf8');
  assert.equal((coverMarkup.match(/<button/g) ?? []).length, 1, '封面页只能有一颗按钮');
  const coverSource = await readFile(new URL('../src/pages/cover/index.ts', import.meta.url), 'utf8');
  assert.match(coverSource, /\/pages\/auth\/index/);
  assert.match(coverSource, /\/pages\/home\/index/);
  const authMarkup = await readFile(new URL('../src/pages/auth/index.wxml', import.meta.url), 'utf8');
  assert.match(authMarkup, /我有医生给的邀请码/);
  const bindMarkup = await readFile(new URL('../src/pages/auth/bind.wxml', import.meta.url), 'utf8');
  assert.match(bindMarkup, /10 分钟内有效，只能使用一次/);
  assert.match(bindMarkup, /请不要转发/);
  assert.doesNotMatch(bindMarkup, /\{\{[^}]*[A-Za-z_][A-Za-z0-9_]*\(/);
  const homeMarkup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(homeMarkup, /bindtap="unbind"/);
});

test('订阅消息授权只在服务端确认接入后请求，用户拒绝不当成错误', async () => {
  const { pushTemplate, requestSubscribeConsent } = await import('../dist/api.js');
  const current = { userId: 'user-caregiver', actorIds: ['actor-caregiver'], actorId: 'actor-caregiver', patientId: 'patient-demo', accessToken: 'access', refreshToken: 'refresh', role: 'CAREGIVER' };

  // 未接入：必须如实返回未就绪与原因，绝不返回一个推不出去的模板 ID。
  installWx(() => [200, { data: { ready: false, reason: '患者订阅消息通道未接入' } }], { stored: current });
  const notReady = await pushTemplate();
  assert.equal(notReady.ready, false);
  assert.equal(notReady.templateId, undefined);
  assert.match(notReady.reason, /未接入/);

  // 已接入：返回模板 ID。
  const calls = installWx(() => [200, { data: { ready: true, templateId: 'TPL-MESSAGE' } }], { stored: current });
  const ready = await pushTemplate();
  assert.equal(ready.ready, true);
  assert.equal(ready.templateId, 'TPL-MESSAGE');
  assert.equal(calls.requests[0].path, '/api/v1/patient/push-template');
  assert.equal(calls.requests[0].header.authorization, 'Bearer access');

  // 授权：同意 / 拒绝 / 微信版本不支持，三种结果都不能抛错或清会话。
  const prepare = outcome => {
    const c = installWx(() => [200, { data: { ready: true, templateId: 'TPL-MESSAGE' } }], { stored: current });
    globalThis.wx.requestSubscribeMessage = options => {
      c.subscribed = options.tmplIds;
      if (outcome === 'fail') options.fail({ errMsg: 'requestSubscribeMessage:fail' });
      else options.success({ 'TPL-MESSAGE': outcome });
    };
    return c;
  };
  const accepted = prepare('accept');
  assert.equal(await requestSubscribeConsent('TPL-MESSAGE'), 'ACCEPTED');
  assert.deepEqual(accepted.subscribed, ['TPL-MESSAGE'], '必须订阅服务端下发的那个模板');
  assert.equal(await requestSubscribeConsent('TPL-MESSAGE') !== undefined, true);
  assert.equal(session()?.actorId, 'actor-caregiver', '授权流程不得清空会话');

  prepare('reject');
  assert.equal(await requestSubscribeConsent('TPL-MESSAGE'), 'REJECTED');
  prepare('fail');
  assert.equal(await requestSubscribeConsent('TPL-MESSAGE'), 'NOT_READY');

  // 缺少授权接口的运行环境（旧基础库）同样不能抛错。
  installWx(() => [200, { data: { ready: true, templateId: 'TPL-MESSAGE' } }], { stored: current });
  delete globalThis.wx.requestSubscribeMessage;
  assert.equal(await requestSubscribeConsent('TPL-MESSAGE'), 'NOT_READY');
});

test('首页订阅卡片如实展示未接入，并只在就绪时允许点开通', async () => {
  const homeMarkup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(homeMarkup, /bindtap="askPushConsent"/);
  // 未就绪时必须禁用按钮，否则用户会点一个必然失败的授权。
  assert.match(homeMarkup, /disabled="\{\{!pushReady\}\}"/);
  const home = await readFile(new URL('../src/pages/home/index.ts', import.meta.url), 'utf8');
  assert.match(homeMarkup, /不会显示内容/, '订阅提醒的文案必须说明站外不显示消息内容');
  assert.match(home, /requestSubscribeConsent/);
  // 明确不做本地「已授权」缓存：一次性订阅会随推送消耗。
  assert.doesNotMatch(home, /已授权[^\n]*setData|subscribeCached/);
});
