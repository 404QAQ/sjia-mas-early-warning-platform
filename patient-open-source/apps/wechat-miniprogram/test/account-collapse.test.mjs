import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const accountPage = await loadPage(registered, new URL('../dist/pages/patient/account.js', import.meta.url).href);

const PATIENT = 'patient-lin';
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['x'], actorId: `actor-guardian@${PATIENT}`, role: 'LEGAL_GUARDIAN', patientId: PATIENT };
const view = { patientId: PATIENT, status: 'ACTIVE', notifyContacts: [], version: 1 };

/** 展开后仍然能做的那些动作，只由服务端状态决定，与是否展开无关。 */
async function open(status = 'ACTIVE', extra = {}) {
  const wx = installWx(path => path.endsWith('/lifecycle') ? [200, { data: { ...view, status, ...extra } }] : [404, {}], { session });
  const page = instantiate(accountPage);
  page.onShow();
  await settle();
  return { page, wx };
}

test('「如果孩子不在了」默认不展开：进页面只看得到一个灰色按钮', async () => {
  const { page } = await open();
  assert.equal(page.data.showingChoices, false);
  assert.equal(page.data.lifecycle.status, 'ACTIVE');
  const markup = await readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8');
  // 措辞一个字都没有删，只是被收进展开分支里 —— 收起不等于删掉这个选项。
  // 「这两件事都不需要你现在决定。」来自服务端的 note，在 data 里，不在模板里。
  assert.equal(page.data.note, '这两件事都不需要你现在决定。');
  for (const copy of ['如果孩子不在了', '转为纪念档案', '全部删除']) {
    assert.ok(markup.includes(copy), `文案不得删减：${copy}`);
  }
  // 两个动作卡都在 showingChoices 分支内；展开按钮是唯一的常驻控件。
  const gated = markup.split('<block wx:if="{{showingChoices}}">')[1];
  assert.match(gated, /bindtap="memorial"/);
  assert.match(gated, /bindtap="askDelete"/);
  assert.match(markup, /bindtap="showChoices"/);
});

test('展开只改本机显示状态：不读接口、不写审计、不动版本号', async () => {
  const { page, wx } = await open();
  const before = wx.calls.requests.length;
  page.showChoices();
  await settle();
  assert.equal(page.data.showingChoices, true);
  assert.equal(wx.calls.requests.length, before, '展开不得产生任何请求');
  assert.equal(page.data.lifecycle.version, 1);
  // 重复点不会重复触发。
  page.showChoices();
  assert.equal(page.data.showingChoices, true);
});

test('收起不挡「少做一件事」：撤回删除申请的入口始终可见', async () => {
  const { page } = await open('DELETED_REQUESTED', { deleteAfter: '2026-10-17T04:00:00.000Z' });
  assert.equal(page.data.canCancel, true);
  assert.equal(page.data.showingChoices, false, '撤回删除申请不需要先展开那一段');
  const markup = await readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8');
  // 撤回卡在展开块**之外**，要求当前 lifecycle 已读取且 canCancel 为真（已有删除申请在办），
  // 而不是 showingChoices —— 「把一件已在办的事收回」不该再被一道缓冲挡一层。
  const cancelCard = /<view wx:if="\{\{lifecycle && canCancel\}\}"/.exec(markup);
  const cancelCardAt = cancelCard?.index ?? -1;
  assert.equal(page.data.lifecycle.patientId, PATIENT, '撤回入口必须属于当前已读取的档案');
  assert.doesNotMatch(cancelCard?.[0] ?? '', /showingChoices|moreExpanded/, '撤回入口不依赖展开状态');
  assert.ok(cancelCardAt > 0, '撤回卡必须在模板里，且不带 showingChoices 条件');
  assert.match(markup.slice(cancelCardAt), /bindtap="cancelDelete"/);
  // 展开分支里只出现「转为纪念档案 / 全部删除」两个动作卡；撤回那个是独立的一张卡。
  assert.equal(markup.slice(0, cancelCardAt).includes('撤回删除申请'), false, '撤回删除申请不应出现在展开分支里');
});

test('展开也挡不住二次确认：全部删除仍然是先展开说明再提交', async () => {
  const { page, wx } = await open('DECEASED', { registeredAt: '2026-10-01T04:00:00.000Z', recordRetention: 'MEMORIAL' });
  page.showChoices();
  assert.equal(page.data.canDelete, true);
  assert.equal(page.data.confirmingDelete, false, '展开不等于同意删除');
  // 直接调用提交会被页面自己拦下（服务端也会 409 PATIENT_LIFECYCLE_CONFIRMATION_REQUIRED）。
  const before = wx.calls.requests.length;
  page.requestDelete();
  await settle();
  assert.equal(wx.calls.requests.length, before);
  // 展开说明后才出现「了解详情」，第二步才是提交。
  const markup = await readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8');
  assert.match(markup, /bindtap="askDelete"/);
  assert.match(markup, /bindtap="requestDelete"/);
  assert.match(markup, /bindtap="cancelDeleteAsk"/);
});

test('切换身份后展开态回到收起：不让下一位患者的家属继承上一位的展开', async () => {
  const { page } = await open();
  page.showChoices();
  assert.equal(page.data.showingChoices, true);
  const other = { ...session, actorId: 'actor-guardian@patient-sun', patientId: 'patient-sun' };
  installWx(path => path.endsWith('/lifecycle') ? [200, { data: { ...view, patientId: 'patient-sun' } }] : [404, {}], { session: other });
  page.onShow();
  await settle();
  assert.equal(page.data.showingChoices, false);
});

test('展开按钮是整页最低调的控件：灰底灰字、无强调色', async () => {
  const wxss = await readFile(new URL('../src/pages/patient/account.wxss', import.meta.url), 'utf8');
  const rule = /button\.quiet\s*\{([^}]*)\}/.exec(wxss);
  assert.ok(rule, 'account.wxss 必须有 button.quiet');
  const body = rule[1];
  assert.match(body, /background:\s*(#f0ece5|var\(--mas-surface-soft\))/);
  assert.match(body, /color:\s*(#7a716a|var\(--mas-text-subtle\))/);
  // 不得借用品牌色 / 警示色来强调这个按钮。
  for (const loud of ['#0c6b68', '#9d3c34', '#9a3d37', '#e6f1ef']) {
    assert.equal(body.includes(loud), false, `展开按钮不得使用强调色 ${loud}`);
  }
});
