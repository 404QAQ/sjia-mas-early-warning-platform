import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const pages = {};
for (const name of ['health', 'menstrual', 'support']) {
  pages[name] = await loadPage(registered, new URL(`../dist/pages/patient/${name}.js`, import.meta.url).href);
}
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['act'], actorId: 'act', role: 'PATIENT', patientId: 'p' };
const tapEvent = { type: 'tap', detail: { x: 100, y: 200 }, currentTarget: { dataset: {} } };

for (const [name, label, loadingField] of [
  ['health', '刷新健康资料', 'loading'], ['menstrual', '刷新', 'loading'], ['support', '刷新应急资料', 'emergencyLoading'],
]) {
  test(`${name} 原生刷新事件不会被误当成身份参数，请求结束后可再次刷新`, async () => {
    const { calls } = installWx(() => [503, { message: '暂时不可用' }], { session });
    const page = instantiate(pages[name]);
    // 原生点击发生在 onShow 之后；让页面按实际生命周期建立身份与读取代次。
    page.onShow();
    await settle();
    const initialCount = calls.requests.length;
    const markup = await readFile(new URL(`../src/pages/patient/${name}.wxml`, import.meta.url), 'utf8');
    const method = new RegExp(`<button[^>]*bindtap="([^"]+)"[^>]*>${label}</button>`).exec(markup)?.[1];
    assert.ok(method, '当前按钮应有可执行的事件');
    await page[method](tapEvent);
    await settle();
    assert.equal(page.data[loadingField], false);
    assert.doesNotMatch(page.data.error, /身份已切换/);
    const count = calls.requests.length;
    assert.ok(count > initialCount, '刷新按钮必须发起新请求，而不是沿用首次加载');
    await page[method](tapEvent);
    await settle();
    assert.ok(calls.requests.length > count);
    assert.equal(page.data[loadingField], false);
  });
}

test('经期选择日期后更新可见值，结束日期不覆盖开始日期', () => {
  const page = instantiate(pages.menstrual);
  page.dateChange({ currentTarget: { dataset: { field: 'periodStartDate' } }, detail: { value: '2026-10-01' } });
  page.dateChange({ currentTarget: { dataset: { field: 'periodEndDate' } }, detail: { value: '2026-10-05' } });
  assert.equal(page.data.periodStartDate, '2026-10-01');
  assert.equal(page.data.periodEndDate, '2026-10-05');
  page.dateChange({ currentTarget: { dataset: { field: 'cycle' } }, detail: { value: '2026-10-03' } });
  assert.equal(page.data.cycle, null);
});
