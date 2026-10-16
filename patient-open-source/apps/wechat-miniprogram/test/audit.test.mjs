import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditPath, parseAuditPage } from '../dist/pages/patient/audit.js';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const homePage = await loadPage(registered, new URL('../dist/pages/home/index.js', import.meta.url).href);
const accountPage = await loadPage(registered, new URL('../dist/pages/patient/account.js', import.meta.url).href);

const now = Date.parse('2026-10-09T12:00:00.000Z');
const page = {
  patientId: 'p/1',
  from: '2026-09-09T12:00:00.000Z',
  to: '2026-10-09T12:00:00.000Z',
  items: [{ at: '2026-10-08T04:05:06.000Z', action: '查看了相关记录', category: '临床记录', viewer: { displayName: '张医生', relation: '医护人员', context: '随诊', visibility: 'G1' } }],
  nextAfter: 'opaque.cursor/1',
};

test('O-03 小程序患者审计 parser 严格保留人话字段并格式化时间', () => {
  const parsed = parseAuditPage(page, 'p/1', now);
  assert.equal(parsed.items[0].viewerLabel, '张医生（随诊 · 完整共享）');
  assert.match(parsed.items[0].timeLabel, /2026/);
  assert.equal(parsed.nextAfter, page.nextAfter);
});

test('O-03 小程序患者审计 parser 拒绝跨患者、技术字段、越界时间和非法角色', () => {
  assert.throws(() => parseAuditPage({ ...page, patientId: 'other' }, 'p/1', now), /响应格式无效/);
  assert.throws(() => parseAuditPage({ ...page, items: [{ ...page.items[0], actorId: 'doctor-1' }] }, 'p/1', now), /条目格式无效/);
  assert.throws(() => parseAuditPage({ ...page, items: [{ ...page.items[0], at: '2026-11-08T04:05:06.000Z' }] }, 'p/1', now), /条目格式无效/);
  assert.throws(() => parseAuditPage({ ...page, items: [{ ...page.items[0], viewer: { ...page.items[0].viewer, relation: 'CLINICIAN' } }] }, 'p/1', now), /条目格式无效/);
});

test('O-03 小程序请求只透传不透明游标并编码患者 ID', () => {
  assert.equal(auditPath('p/1'), '/api/v1/patients/p%2F1/audit?limit=20');
  assert.equal(auditPath('p/1', 'opaque.cursor/1'), '/api/v1/patients/p%2F1/audit?limit=20&after=opaque.cursor%2F1');
});

test('O-03 小程序页面具备入口、失权清屏和迟到回包保护', async () => {
  const source = await readFile(new URL('../src/pages/patient/audit.ts', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.json', import.meta.url), 'utf8');
  const home = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(app, /pages\/patient\/audit/);
  assert.match(home, /bindtap="openAccount"/);
  const accountMarkup = await readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8');
  assert.match(accountMarkup, /data-key="\{\{entry.key\}\}" bindtap="openFeature"/);
  const current = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId: 'patient-1' };
  const { calls } = installWx(path => {
    if (path.endsWith('/summary')) return [200, { data: { patientId: current.patientId, patientDisplayName: '演示患者', lifeStage: 'ADULT', sex: 'FEMALE', observationsCount: 0, alerts: [] } }];
    if (path.endsWith('/lifecycle')) return [200, { data: { patientId: current.patientId, status: 'ACTIVE', version: 1, notifyContacts: [] } }];
    return [404, {}];
  }, { session: current });
  instantiate(homePage).openAccount();
  const accountInstance = instantiate(accountPage);
  accountInstance.onShow(); await settle();
  assert.ok(accountInstance.data.profileGroups.some(group => group.entries.some(entry => entry.key === 'audit' && entry.title === '谁看过我的数据')));
  accountInstance.openFeature({ currentTarget: { dataset: { key: 'audit' } } });
  assert.deepEqual(calls.navigations, [['switchTab', '/pages/patient/account'], ['navigateTo', '/pages/patient/audit']]);
  assert.match(source, /onHide\(\)\s*\{\s*this\.invalidate\(\)/);
  assert.match(source, /onUnload\(\)\s*\{\s*this\.invalidate\(\)/);
  assert.match(source, /\[401, 403\]\.includes/);
  assert.match(source, /\[401, 403\]\.includes\(error\.status\)[\s\S]*?this\.invalidate\(\)[\s\S]*?revision !== this\.data\.revision/);
  assert.match(source, /revision !== this\.data\.revision/);
  assert.match(source, /seenCursors/);
});
