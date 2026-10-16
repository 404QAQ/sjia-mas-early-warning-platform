import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const app = JSON.parse(await readFile(new URL('../dist/app.json', import.meta.url), 'utf8'));
const pages = new Map();
for (const page of app.pages) pages.set(page, await loadPage(registered, new URL(`../dist/${page}.js`, import.meta.url).href));

const session = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'LEGAL_GUARDIAN', patientId: 'patient-1' };
const now = new Date().toISOString();

function wxmlRoots(markup) {
  const roots = new Set();
  for (const [, expression] of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const stripped = expression.replace(/'[^']*'|"[^"]*"/g, ' ');
    for (const [identifier] of stripped.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) roots.add(identifier);
  }
  return roots;
}

test('每个页面的渲染状态都在 data 里：顶层只留只经 this.* 访问的实例字段', async () => {
  for (const [name, options] of pages) {
    assert.ok(options.data && typeof options.data === 'object', `${name} 缺少 data`);
    const instanceFields = Object.keys(options).filter(key => key !== 'data' && typeof options[key] !== 'function');
    const source = await readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8');
    const markup = await readFile(new URL(`../dist/${name}.wxml`, import.meta.url), 'utf8');
    const roots = wxmlRoots(markup);
    for (const field of instanceFields) {
      assert.doesNotMatch(source, new RegExp(`\\bdata\\.${field}\\b`), `${name} 用 this.data.${field} 读取了一个不在 data 里的字段`);
      assert.equal(roots.has(field), false, `${name} 的 WXML 渲染了不在 data 里的 ${field}`);
    }
  }
});

test('记录页按微信语义加载后不再永久「读取中」，revision 是数字', async () => {
  installWx(path => {
    if (path === '/api/v1/patients/patient-1/summary') return [200, { data: { patientId: 'patient-1', patientDisplayName: '小林', lifeStage: 'CHILD', observationsCount: 0, latestObservationAt: null, updatedAt: now, alerts: [] } }];
    if (path === '/api/v1/patients/patient-1/observations?limit=20') return [200, { data: { patientId: 'patient-1', records: [] } }];
    return [404, { code: 'NOT_FOUND', message: '暂无' }];
  }, { session });
  const page = instantiate(pages.get('pages/patient/records'));
  assert.equal(page.data.loading, true);
  page.onLoad(); page.onShow();
  await settle();
  assert.equal(typeof page.data.revision, 'number');
  assert.ok(Number.isFinite(page.data.revision) && page.data.revision > 0);
  assert.equal(page.data.loading, false, '记录页卡在读取中');
  assert.equal(page.data.error, '');
  assert.ok(page.data.summaryText.length > 0, '摘要没有渲染');
  page.onUnload();
});

test('记录页把生命阶段、风险行动和告警状态转换成患者可读文案', async () => {
  installWx(path => {
    if (path === '/api/v1/patients/patient-1/summary') return [200, { data: { patientId: 'patient-1', patientDisplayName: '小林', lifeStage: 'CHILD', observationsCount: 1, latestObservationAt: now, updatedAt: now, alerts: [{ status: 'OPEN', actionLevel: 'ACT_NOW' }] } }];
    if (path === '/api/v1/patients/patient-1/observations?limit=20') return [200, { data: { patientId: 'patient-1', records: [] } }];
    if (path === '/api/v1/patients/patient-1/trend') return [200, { data: { patientId: 'patient-1', asOf: now, narrative: ['请继续记录。'], decisionCard: { riskLevel: 'HIGH', actionLevel: 'ACT_NOW', title: '需要尽快联系医生', action: '今天联系照护团队。' }, series: [] } }];
    return [404, {}];
  }, { session });
  const page = instantiate(pages.get('pages/patient/records'));
  page.onLoad(); page.onShow();
  page.setTemperature({ detail: { value: '39.0' } });
  assert.equal(page.data.temperature, '', '摘要未确认前不应接受记录输入');
  await settle();
  assert.match(page.data.summaryText, /儿童期/);
  assert.match(page.data.summaryText, /立即行动（待处理）/);
  assert.doesNotMatch(page.data.summaryText, /CHILD|ACT_NOW|OPEN/);
  assert.equal(page.data.trend.decisionCard.riskLabel, '高风险');
  assert.equal(page.data.trend.decisionCard.actionLabel, '立即行动');
  const recordsMarkup = await readFile(new URL('../dist/pages/patient/observation.wxml', import.meta.url), 'utf8');
  assert.equal((recordsMarkup.match(/<input /g) ?? []).length, 1, '本次测量只保留一个输入，避免重复控件产生歧义');
  assert.match(recordsMarkup, /aria-label="本次实测体温，摄氏度，34到43"/);
  assert.equal(page.data.temperature, '', '历史值不能替代本次测量');
  page.onUnload();
});

test('访问记录页按微信语义加载出条目并结束读取', async () => {
  const item = { at: new Date(Date.now() - 3600_000).toISOString(), action: '查看了相关记录', category: '临床记录', viewer: { displayName: '张医生', relation: '医护人员', context: '随诊', visibility: 'G1' } };
  installWx(path => path.startsWith('/api/v1/patients/patient-1/audit')
    ? [200, { data: { patientId: 'patient-1', from: new Date(Date.now() - 30 * 86400_000).toISOString(), to: new Date(Date.now() - 1000).toISOString(), items: [item], nextAfter: null } }]
    : [404, {}], { session });
  const page = instantiate(pages.get('pages/patient/audit'));
  page.onLoad(); page.onShow();
  await settle();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.error, '');
});

test('应急页的分享对象来自 data，切换勾选不会因 undefined 抛错', () => {
  installWx(() => [404, {}], { session });
  const page = instantiate(pages.get('pages/patient/emergency'));
  page.toggleRecipient({ currentTarget: { dataset: { code: 'FRIEND' } } });
  assert.equal(page.data.recipients.find(item => item.code === 'FRIEND').selected, true);
});
