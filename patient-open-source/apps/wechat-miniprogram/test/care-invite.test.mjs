import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SESSION_KEY, capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const pageUrl = name => new URL(`../dist/pages/${name}.js`, import.meta.url).href;
const invitePage = await loadPage(registered, pageUrl('patient/care-invite'));
const homePage = await loadPage(registered, pageUrl('home/index'));
const supportPage = await loadPage(registered, pageUrl('patient/support'));
const { parseInviteOverview, parseIssuedInvite } = await import('../dist/care-invite.js');

let sequence = 0;
/** 每个用例一个独立身份：只读回执是按身份粘性的，用例之间不能互相影响。 */
function identity(role = 'PATIENT') {
  sequence += 1;
  return { accessToken: `access-${sequence}`, refreshToken: `refresh-${sequence}`, userId: `user-${sequence}`, actorIds: [`actor-${sequence}`], actorId: `actor-${sequence}`, role, patientId: `patient-${sequence}` };
}
const base = session => `/api/v1/patients/${session.patientId}/care-invites`;
const later = hours => new Date(Date.now() + hours * 3600_000).toISOString();
const CODE = 'ABCD-EFGH';
function issued(session, code = CODE) {
  return { inviteId: 'inv-new', patientId: session.patientId, code, issuedAt: new Date().toISOString(), expiresAt: later(24), ttlHours: 24, supersededCount: 1, script: `请在医生端网页右侧「接收患者邀请」输入 ${code}。邀请码 24 小时内有效、只能使用一次，请只发给你的主管医生。` };
}
function overview(session, { pending = null, invited = [] } = {}) {
  return { patientId: session.patientId, asOf: new Date().toISOString(), pending, invited, policy: { ttlHours: 24, maxIssuesPerHour: 10 } };
}
const doctor = { inviteId: 'inv-old', acceptedAt: new Date(Date.now() - 86400_000).toISOString(), clinicianLabel: '王医生', active: true };

/** 路由表式的服务端桩：key 为 'METHOD path'，值为 [status, body] / 'NETWORK' / 函数。 */
function server(session, routes) {
  return installWx((path, options) => {
    const route = routes[`${options.method ?? 'GET'} ${path}`];
    if (!route) return [404, { code: 'NOT_FOUND', message: `unexpected ${path}` }];
    return typeof route === 'function' ? route(options) : route;
  }, { session });
}
/**
 * 有状态的签发桩：签发成功后，列表读取要像真实服务端那样把新码列为待使用，
 * 否则页面会（正确地）认为屏幕上的码已失效并拿掉它。
 */
function issuingRoutes(session, { invited = [] } = {}) {
  const state = { pending: null, invited };
  const routes = {
    [`GET ${base(session)}`]: () => [200, { data: overview(session, { pending: state.pending, invited: state.invited }) }],
    [`POST ${base(session)}`]: () => { const value = issued(session); state.pending = { inviteId: value.inviteId, issuedAt: value.issuedAt, expiresAt: value.expiresAt }; return [201, { data: value }]; },
  };
  return { state, routes };
}
async function open(session) {
  const page = instantiate(invitePage);
  page.onLoad();
  await settle();
  return page;
}
function storageText(storage) { return JSON.stringify([...storage.entries()]); }

test('邀请页已注册，照护页和首页的个人档案入口可达，首页不出现「心理」', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(app.pages.includes('pages/patient/care-invite'));
  for (const extension of ['js', 'json', 'wxml', 'wxss']) await readFile(new URL(`../dist/pages/patient/care-invite.${extension}`, import.meta.url));
  const homeMarkup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(homeMarkup, /bindtap="openAccount"/);
  const accountSource = await readFile(new URL('../src/pages/patient/account.ts', import.meta.url), 'utf8');
  assert.match(accountSource, /careInviteEntry\(current\)\.showCareInvite[\s\S]*profileEntry\('invite', '邀请我的医生'/);
  assert.doesNotMatch(homeMarkup, /心理/);
  const supportMarkup = await readFile(new URL('../src/pages/patient/support.wxml', import.meta.url), 'utf8');
  assert.match(supportMarkup, /item\.key === 'care'[\s\S]*bindtap="openCareInvite"[^>]*>邀请我的医生加入</);
  const { calls } = installWx(() => [404, {}], { session: identity() });
  instantiate(homePage).openCareInvite();
  instantiate(supportPage).openCareInvite();
  assert.deepEqual(calls.navigations, [['navigateTo', '/pages/patient/care-invite'], ['navigateTo', '/pages/patient/care-invite']]);
});

test('生成邀请码：直接请求、不带幂等键，明文码只在页面 data 里，不进本机存储和离线队列', async () => {
  const session = identity('LEGAL_GUARDIAN');
  const { storage, calls } = server(session, issuingRoutes(session).routes);
  const page = await open(session);
  assert.equal(page.data.canIssue, true);
  await page.issue();
  await settle();
  const post = calls.requests.find(item => item.method === 'POST');
  assert.equal(post.path, base(session));
  assert.deepEqual(post.data, {});
  assert.equal(post.header['idempotency-key'], undefined);
  assert.equal(post.header['x-actor-id'], session.actorId);
  assert.equal(page.data.issued.code, CODE);
  assert.match(page.data.issued.script, /ABCD-EFGH/);
  assert.match(page.data.issued.expiresText, /前有效/);
  assert.equal(page.data.notice, '之前未使用的邀请码已作废。');
  assert.equal(calls.modals.length, 0, '没有旧码时不必弹确认');
  assert.equal(storageText(storage).includes('ABCD'), false, '明文码不能写进本机存储');
  assert.equal([...storage.keys()].some(key => key.includes('mutation-outbox')), false, '签发不能进离线队列');
  page.copyCode();
  assert.deepEqual(calls.clipboard, [CODE]);
});

test('已有待使用的码时先提示「生成新码会作废尚未使用的旧码」，取消则不发请求', async () => {
  const session = identity();
  const { calls } = server(session, { [`GET ${base(session)}`]: [200, { data: overview(session, { pending: { inviteId: 'inv-p', issuedAt: new Date().toISOString(), expiresAt: later(20) } }) }] });
  const page = await open(session);
  assert.match(page.data.pending.expiresText, /前有效/);
  assert.equal(JSON.stringify(page.data.pending).includes('code'), false, '列表不显示码');
  calls.modalAnswer = false;
  await page.issue();
  assert.match(calls.modals[0].content, /生成新码会作废尚未使用的旧码/);
  assert.equal(calls.requests.some(item => item.method === 'POST'), false);
});

test('复制前先判断 setClipboardData 是否可用', async () => {
  const session = identity();
  server(session, issuingRoutes(session).routes);
  const page = await open(session);
  await page.issue();
  delete globalThis.wx.setClipboardData;
  page.copyCode();
  assert.match(page.data.notice, /长按邀请码手动复制/);
});

test('作废与移除的请求形状；移除先二次确认', async () => {
  const session = identity();
  const pending = { inviteId: 'inv-p', issuedAt: new Date().toISOString(), expiresAt: later(20) };
  const { calls } = server(session, {
    [`GET ${base(session)}`]: [200, { data: overview(session, { pending, invited: [doctor] }) }],
    [`POST ${base(session)}/inv-p/revoke`]: [200, { data: { inviteId: 'inv-p', status: 'REVOKED', closedAt: new Date().toISOString() } }],
    [`POST ${base(session)}/inv-old/remove`]: [200, { data: { inviteId: 'inv-old', membershipId: 'care-invite:inv-old', removedAt: new Date().toISOString() } }],
  });
  const page = await open(session);
  assert.deepEqual(page.data.invited.map(item => [item.label, item.active]), [['王医生', true]]);
  await page.revoke({ currentTarget: { dataset: { id: 'inv-p' } } });
  const revoke = calls.requests.find(item => item.path.endsWith('/revoke'));
  assert.equal(revoke.method, 'POST'); assert.deepEqual(revoke.data, {});
  assert.match(page.data.notice, /已作废/);
  calls.modalAnswer = false;
  await page.remove({ currentTarget: { dataset: { id: 'inv-old' } } });
  assert.equal(calls.requests.some(item => item.path.endsWith('/remove')), false, '取消确认不能移除');
  calls.modalAnswer = true;
  await page.remove({ currentTarget: { dataset: { id: 'inv-old' } } });
  const remove = calls.requests.find(item => item.path.endsWith('/remove'));
  assert.equal(remove.method, 'POST'); assert.deepEqual(remove.data, {});
  assert.equal(calls.modals.filter(item => /移除/.test(item.title)).length, 2);
  assert.match(page.data.notice, /已移除/);
});

test('没有系统确认框时退回页面内两步确认', async () => {
  const session = identity();
  const { calls } = server(session, {
    [`GET ${base(session)}`]: [200, { data: overview(session, { invited: [doctor] }) }],
    [`POST ${base(session)}/inv-old/remove`]: [200, { data: { inviteId: 'inv-old', membershipId: 'care-invite:inv-old', removedAt: new Date().toISOString() } }],
  });
  delete globalThis.wx.showModal;
  const page = await open(session);
  await page.remove({ currentTarget: { dataset: { id: 'inv-old' } } });
  assert.equal(page.data.confirmingRemoveId, 'inv-old');
  assert.equal(calls.requests.some(item => item.path.endsWith('/remove')), false);
  page.confirmRemove();
  await settle();
  assert.equal(calls.requests.filter(item => item.path.endsWith('/remove')).length, 1);
});

test('身份切换或页面卸载时清空明文码；onHide 不清（用户要去微信聊天里粘贴）', async () => {
  const session = identity();
  const next = { ...session, actorIds: [session.actorId, 'actor-other'], actorId: 'actor-other', patientId: 'patient-other' };
  const { storage } = server(session, { ...issuingRoutes(session).routes, [`GET ${base(next)}`]: [200, { data: overview(next) }] });
  const page = await open(session);
  await page.issue();
  assert.equal(page.data.issued.code, CODE);
  page.onHide?.();
  page.onShow();
  assert.equal(page.data.issued.code, CODE, '同一身份回到页面时码还在');
  storage.set(SESSION_KEY, next);
  page.onShow();
  assert.equal(page.data.issued, null, '换身份必须清掉上一身份的明文码');
  await settle();
  storage.set(SESSION_KEY, session);
  page.onShow();
  await settle();
  await page.issue();
  page.onUnload();
  assert.equal(page.data.issued, null);
});

test('签发被 403 CARE_INVITE_ISSUER_NOT_ALLOWED 拒绝后只读说明是粘性的，后续读取不会抹掉', async () => {
  const session = identity('PATIENT');
  let listReads = 0;
  server(session, {
    [`GET ${base(session)}`]: () => { listReads += 1; return [200, { data: overview(session, { invited: [doctor] }) }]; },
    [`POST ${base(session)}`]: [403, { code: 'CARE_INVITE_ISSUER_NOT_ALLOWED', message: '未成年本人不能签发' }],
  });
  const page = await open(session);
  assert.equal(page.data.canIssue, true, '客户端看不出未成年，先放出按钮');
  await page.issue();
  assert.equal(page.data.canIssue, false);
  assert.match(page.data.readOnlyReason, /法定监护人/);
  await settle();
  assert.equal(listReads, 2, '拒绝后要重新读取列表');
  assert.equal(page.data.canIssue, false, '刷新回来不能把按钮放回去');
  assert.equal(page.data.invited.length, 1, '业务拒绝不清页');
  page.refresh();
  await settle();
  assert.equal(page.data.canIssue, false);
  const reopened = await open(session);
  assert.equal(reopened.data.canIssue, false, '同一身份重新打开页面仍是只读');
});

test('角色不是本人或法定监护人：不读列表、收起两张列表，不说「只能查看」；首页和照护页收起入口并说明', async () => {
  for (const role of ['CAREGIVER', 'SPOUSE', 'PROXY']) {
    const session = identity(role);
    const { calls } = server(session, { [`GET ${base(session)}`]: [403, { code: 'CARE_INVITE_ISSUER_NOT_ALLOWED', message: '仅本人或法定监护人' }] });
    const page = await open(session);
    assert.equal(page.data.canIssue, false);
    assert.equal(page.data.denied, true, '服务端连列表都不给看，不能渲染「没有待使用的邀请码」「还没有医生加入」');
    assert.match(page.data.readOnlyReason, /只有患者本人或法定监护人/);
    assert.doesNotMatch(page.data.readOnlyReason, /只能查看/);
    assert.equal(page.data.error, '');
    assert.equal(calls.requests.some(item => item.path === base(session)), false, '角色已能判定时不必再请求');
    const home = instantiate(homePage); home.onShow();
    assert.equal(home.data.showCareInvite, false);
    assert.match(home.data.careInviteNote, /只对患者本人或法定监护人开放/);
    const support = instantiate(supportPage); support.onShow();
    assert.equal(support.data.showCareInvite, false);
    assert.match(support.data.careInviteNote, /只对患者本人或法定监护人开放/);
  }
  const markup = await readFile(new URL('../src/pages/patient/care-invite.wxml', import.meta.url), 'utf8');
  const hidden = markup.slice(markup.indexOf('<block wx:if="{{!denied}}">'));
  assert.match(hidden, /没有待使用的邀请码[\s\S]*还没有医生通过邀请码加入[\s\S]*<\/block>/, '两句空状态都在 !denied 块内');
  assert.match(await readFile(new URL('../src/pages/patient/account.ts', import.meta.url), 'utf8'), /if \(careInviteEntry\(current\)\.showCareInvite\)/);
});

test('本人身份读取被 ISSUER_NOT_ALLOWED 拒绝（未成年本人）：不显示空列表，首页同一身份下收起入口', async () => {
  const session = identity('PATIENT');
  server(session, { [`GET ${base(session)}`]: [403, { code: 'CARE_INVITE_ISSUER_NOT_ALLOWED', message: '只有患者本人或法定监护人可以邀请医生；未成年患者请由监护人操作' }] });
  const before = instantiate(homePage); before.onShow();
  assert.equal(before.data.showCareInvite, true, '客户端看不出未成年，先放出入口');
  const page = await open(session);
  assert.equal(page.data.denied, true);
  assert.equal(page.data.canIssue, false);
  assert.match(page.data.readOnlyReason, /不能查看或管理邀请/);
  assert.doesNotMatch(page.data.readOnlyReason, /只能查看/);
  assert.equal(page.data.error, '', '业务拒绝不报错、不清屏');
  const home = instantiate(homePage); home.onShow();
  assert.equal(home.data.showCareInvite, false);
  assert.match(home.data.careInviteNote, /未成年患者请由监护人操作/);
});

test('回到前台时重读：医生已用掉或码已过期，屏幕上的明文码要拿掉并说明', async () => {
  const session = identity();
  const { state, routes } = issuingRoutes(session);
  server(session, routes);
  const page = await open(session);
  await page.issue();
  await settle();
  assert.equal(page.data.issued.code, CODE);
  page.onHide?.();
  page.onShow();
  await settle();
  assert.equal(page.data.issued.code, CODE, '码还没被用时回来仍能看到');
  state.invited = [{ inviteId: 'inv-new', acceptedAt: new Date().toISOString(), clinicianLabel: '李医生', active: true }];
  state.pending = null;
  page.onHide?.();
  page.onShow();
  await settle();
  assert.equal(page.data.issued, null);
  assert.equal(page.data.pending, null);
  assert.match(page.data.notice, /医生已用这张邀请码加入/);
  assert.deepEqual(page.data.invited.map(item => item.label), ['李医生']);

  await page.issue();
  await settle();
  state.pending = null; state.invited = [];
  page.onShow();
  await settle();
  assert.equal(page.data.issued, null);
  assert.match(page.data.notice, /已过期或已作废/);
});

test('没有系统确认框时，已有待使用的码再生成也要页面内两步确认', async () => {
  const session = identity();
  const { state, routes } = issuingRoutes(session);
  state.pending = { inviteId: 'inv-p', issuedAt: new Date().toISOString(), expiresAt: later(20) };
  const { calls } = server(session, routes);
  delete globalThis.wx.showModal;
  const page = await open(session);
  await page.issue();
  assert.equal(page.data.confirmingIssue, true);
  assert.equal(calls.requests.some(item => item.method === 'POST'), false, '没确认不能作废旧码');
  page.cancelIssue();
  assert.equal(page.data.confirmingIssue, false);
  await page.issue();
  await page.confirmIssue();
  await settle();
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(page.data.issued.code, CODE);
});

test('CARE_INVITE_* 业务拒绝在页面内说明、不清页；其它 403 才清屏', async () => {
  const session = identity();
  const routes = {
    ...issuingRoutes(session, { invited: [doctor] }).routes,
    [`POST ${base(session)}/inv-x/revoke`]: [409, { code: 'CARE_INVITE_CLOSED', message: 'closed' }],
    // 会话仍有效：403 FORBIDDEN 是临床访问范围被拒，不是会话失效。
    'GET /api/v1/auth/actors': [200, { data: [{ id: session.actorId, patientId: session.patientId, relation: 'SELF', activeFrom: '2020-01-01T00:00:00.000Z' }] }],
  };
  server(session, routes);
  const page = await open(session);
  await page.issue();
  await page.revoke({ currentTarget: { dataset: { id: 'inv-x' } } });
  assert.match(page.data.error, /已被使用或已作废/);
  assert.equal(page.data.issued.code, CODE, '业务拒绝不能清掉明文码');
  assert.equal(page.data.invited.length, 1);

  routes[`POST ${base(session)}`] = [429, { code: 'RATE_LIMITED', message: 'slow down', details: { retryAfterSeconds: 600 } }];
  await page.issue();
  assert.match(page.data.error, /约 10 分钟后再试/);
  assert.equal(page.data.invited.length, 1);

  routes[`GET ${base(session)}`] = [403, { code: 'FORBIDDEN', message: '无权访问' }];
  page.refresh();
  await settle();
  assert.equal(page.data.invited.length, 0, '临床访问范围失效要清屏');
  assert.equal(page.data.issued, null);
  assert.match(page.data.error, /读不到邀请记录/);
  // 读取失败与「读到了空列表」必须能分开：页面不能一边报错一边说「没有」。
  assert.equal(page.data.readError, true);
  assert.equal(page.data.roleDenied, false, 'role 允许的身份要被拒绝读取时仍保留刷新这条路');

  routes[`GET ${base(session)}`] = [200, { data: overview(session, { invited: [doctor] }) }];
  page.refresh();
  await settle();
  assert.equal(page.data.readError, false);
  assert.equal(page.data.error, '', '读取成功后上一次的红字不能留在页面上');
  assert.deepEqual(page.data.invited.map(item => item.label), ['王医生'], '恢复后能重新读到邀请来的医生');
});

test('读取被 403 拒绝时不说「没有」，也不把「刷新」收走；刷新成功后恢复正常', async () => {
  const session = identity();
  let forbidden = false;
  server(session, {
    [`GET ${base(session)}`]: () => forbidden ? [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }] : [200, { data: overview(session, { invited: [doctor] }) }],
  });
  const page = await open(session);
  assert.equal(page.data.readError, false);
  assert.equal(page.data.invited.length, 1);

  forbidden = true;
  page.refresh();
  await settle();
  assert.equal(page.data.readError, true, '读取失败要能被界面区分出来');
  assert.equal(page.data.invited.length, 0);
  assert.equal(page.data.denied, false, '普通 403 不是「本功能不适用」，不能收起刷新');
  assert.equal(page.data.roleDenied, false);

  const markup = await readFile(new URL('../src/pages/patient/care-invite.wxml', import.meta.url), 'utf8');
  const pendingCard = markup.slice(markup.indexOf('待使用的邀请码'), markup.indexOf('我邀请的医生'));
  assert.match(pendingCard, /wx:elif="\{\{readError\}\}"/, '读取失败时「没有待使用的邀请码」不能渲染');
  assert.ok(pendingCard.includes('<view wx:else class="hint">没有待使用的邀请码。</view>'), '真正读到空列表时才说没有');
  const invitedCard = markup.slice(markup.indexOf('我邀请的医生'));
  assert.match(invitedCard, /wx:if="\{\{readError\}\}"/, '读取失败时「还没有医生通过邀请码加入」不能渲染');
  // 刷新按钮在 !denied 块之外，只按 role 收起时（roleDenied）才不出现。
  const afterBlock = markup.slice(markup.indexOf('角色本身就不允许'));
  assert.ok(/wx:if="\{\{!roleDenied\}\}"/.test(afterBlock) && afterBlock.indexOf('bindtap="refresh"') > 0, '刷新按钮在 !roleDenied 的 wx:if 里，不受服务端回执收起');

  forbidden = false;
  page.refresh();
  await settle();
  assert.equal(page.data.readError, false);
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.invited.map(item => item.label), ['王医生']);
});

test('签发网络失败提示结果未知，再次生成前要确认，且不进离线队列', async () => {
  const session = identity();
  const routes = { [`GET ${base(session)}`]: [200, { data: overview(session) }], [`POST ${base(session)}`]: 'NETWORK' };
  const { storage, calls } = server(session, routes);
  const page = await open(session);
  await page.issue();
  assert.equal(page.data.uncertain, '网络中断，未确认是否已生成；重新生成会作废之前未使用的码。');
  assert.equal(page.data.issued, null);
  assert.equal([...storage.keys()].some(key => key.includes('mutation-outbox')), false);
  calls.modalAnswer = false;
  await page.issue();
  assert.equal(calls.modals.length, 1);
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 1);
});

test('响应严格校验：脚本里的码必须与签发码一致，列表不接受明文码与未知字段', () => {
  const session = identity();
  assert.throws(() => parseIssuedInvite({ ...issued(session), script: '请输入 ZZZZ-ZZZZ。' }, session.patientId), /格式无效/);
  assert.throws(() => parseIssuedInvite({ ...issued(session), patientId: 'other' }, session.patientId), /格式无效/);
  assert.throws(() => parseIssuedInvite({ ...issued(session), code: 'ABCDEFGH' }, session.patientId), /格式无效/);
  const pending = { inviteId: 'inv-p', issuedAt: new Date().toISOString(), expiresAt: later(1) };
  assert.throws(() => parseInviteOverview(overview(session, { pending: { ...pending, code: CODE } }), session.patientId), /格式无效/);
  assert.throws(() => parseInviteOverview(overview(session, { invited: [{ ...doctor, active: true, removedAt: new Date().toISOString() }] }), session.patientId), /格式无效/);
  assert.throws(() => parseInviteOverview(overview(session, { invited: Array.from({ length: 51 }, () => doctor) }), session.patientId), /格式无效/);
  assert.equal(parseInviteOverview(overview(session, { pending, invited: [{ ...doctor, active: false, removedAt: new Date().toISOString() }] }), session.patientId).invited[0].active, false);
});
