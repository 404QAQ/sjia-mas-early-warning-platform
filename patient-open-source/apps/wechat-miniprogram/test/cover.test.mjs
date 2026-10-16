import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const coverPage = await loadPage(registered, new URL('../dist/pages/cover/index.js', import.meta.url).href);
const config = createRequire(import.meta.url)('../dist/config.js');

const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['x'], actorId: 'x', role: 'LEGAL_GUARDIAN', patientId: 'patient-lin' };

test('封面页是小程序启动页，且排在登录页之前', async () => {
  const app = JSON.parse(await readFile(new URL('../dist/app.json', import.meta.url), 'utf8'));
  assert.equal(app.pages[0], 'pages/cover/index', '启动页必须是封面页：否则一打开就是「MAS 预警平台」登录页');
  assert.ok(app.pages.includes('pages/auth/index'));
  // tabBar 不动：封面页不是 tab，登录后仍然落在「记录」这一栏。
  assert.equal(app.tabBar.list[0].pagePath, 'pages/home/index');
});

test('封面页不读接口、不显示任何患者信息', async () => {
  const { calls } = installWx(() => [200, {}]);
  const page = instantiate(coverPage);
  page.onShow();
  assert.equal(calls.requests.length, 0, '封面页不得发任何请求：它是旁观者看到的第一屏');
  const rendered = JSON.stringify(page.data);
  for (const leaked of ['林小雨', '患者', 'sJIA', 'MAS', '体温', '激素', '告警', '医生']) {
    assert.equal(rendered.includes(leaked), false, `封面页不得渲染「${leaked}」`);
  }
  // 屏幕上写的都是本机真实事实，不编造体重、步数、睡眠这类数字。
  assert.match(page.data.today, /^\d+ 月 \d+ 日$/);
  assert.match(page.data.weekday, /^星期[日一二三四五六]$/);
  assert.equal(page.data.status, '还没有记录。');
  const markup = await readFile(new URL('../src/pages/cover/index.wxml', import.meta.url), 'utf8');
  for (const invented of ['体重', '步数', '睡眠', '心率', '血压', '卡路里']) {
    assert.equal(markup.includes(invented), false, `封面页不得出现编造的指标「${invented}」`);
  }
  // 不冒用任何真实产品或机构。
  assert.equal(/微信|腾讯|医院|附属|大学|医科/.test(markup), false);
});

test('封面页的那一颗按钮：有会话进首页，没有会话回登录页，且不向服务端问身份', async () => {
  const anonymous = installWx(() => [200, {}]);
  const anonPage = instantiate(coverPage);
  anonPage.onShow();
  anonPage.enter();
  assert.deepEqual(anonymous.calls.navigations, [['redirectTo', '/pages/auth/index']]);
  assert.equal(anonymous.calls.requests.length, 0);

  const signedIn = installWx(() => [200, {}], { session });
  const page = instantiate(coverPage);
  page.onShow();
  page.enter();
  assert.deepEqual(signedIn.calls.navigations, [['switchTab', '/pages/home/index']]);
  assert.equal(signedIn.calls.requests.length, 0);
  // 连点不能叠加两次跳转。
  page.enter();
  assert.equal(signedIn.calls.navigations.length, 1);
});

test('免登录包失败时留在生活封面并显示可执行错误，不回退到男女登录页', async () => {
  const previous = config.AUTO_DEMO_LOGIN;
  config.AUTO_DEMO_LOGIN = true;
  try {
    const runtime = installWx(() => 'NETWORK', { extra: {
      login() { throw new Error('免登录包不应调用 wx.login'); },
    } });
    const page = instantiate(coverPage);
    page.onShow();
    await page.enter();
    await settle();
    assert.equal(runtime.calls.navigations.length, 0);
    assert.match(page.data.error, /网络连接失败/);
    assert.equal(page.data.opening, false);
    const markup = await readFile(new URL('../src/pages/cover/index.wxml', import.meta.url), 'utf8');
    assert.match(markup, /error \? '重新连接' : '进入日常记录'/);
    assert.match(markup, /class="entry-error" role="alert"/);
  } finally {
    config.AUTO_DEMO_LOGIN = previous;
  }
});
