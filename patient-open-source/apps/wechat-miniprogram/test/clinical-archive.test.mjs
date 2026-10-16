import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const archive = await import(new URL('clinical-archive.js', dist).href);
const config = createRequire(import.meta.url)(fileURLToPath(new URL('config.js', dist)));
const scanPage = await loadPage(registered, new URL('pages/patient/scan.js', dist).href);
const reportPage = await loadPage(registered, new URL('pages/patient/report.js', dist).href);
const archivePage = await loadPage(registered, new URL('pages/patient/archive.js', dist).href);
const scope = { userId: 'user-1', actorId: 'actor-1', patientId: 'patient-1' };
const session = { ...scope, accessToken: 'access', refreshToken: 'refresh', actorIds: [scope.actorId], role: 'PATIENT' };
const input = (patch = {}) => ({ ...archive.emptyArchive(), title: '血常规', hospital: '市医院', department: '风湿科', diagnosis: 'sJIA', doctor: '王医生', date: '2026-10-14', ...patch });
const fill = page => page.setData({ draft: input({ ...page.data.draft, title: '化验单', hospital: '市医院' }) });

function serverFixture() {
  const records = new Map(); let next = 1;
  const respond = (path, options) => {
    if (path.endsWith('/artifacts')) return [201, { data: { id: 'image-id', patientId: scope.patientId, status: 'READY' } }];
    const match = /\/clinical-archives(?:\/([^/]+))?$/.exec(path);
    if (!match) return [404, {}];
    if ((options.method ?? 'GET') === 'GET') return [200, { data: { records: [...records.values()] } }];
    const old = records.get(match[1]);
    if (options.method === 'DELETE') { records.delete(match[1]); return [200, { data: { record: { ...old, deletedAt: new Date().toISOString() }, created: true } }]; }
    const now = new Date().toISOString(); const row = { ...options.data, id: old?.id ?? `server-${next++}`, patientId: scope.patientId, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, recordedBy: scope.actorId, imagePath: '' };
    records.set(row.id, row); return [201, { data: { record: row, created: true } }];
  };
  return { records, respond };
}
const jpegBytes = () => new Uint8Array([255, 216, 255, 224, 0, 1]).buffer;

test('四类档案新增、编辑、删除保留独立语义，按用户/身份/患者隔离', () => {
  installWx(() => [404, {}], { session });
  const check = archive.saveArchive(scope, input());
  const hospital = archive.saveArchive(scope, input({ kind: 'hospital', title: '住院记录', dischargeDate: '2026-10-15' }));
  archive.saveArchive(scope, input({ kind: 'outpatient', title: '门诊病历', content: '复查血常规' }));
  archive.saveArchive(scope, input({ kind: 'prescription', title: '门诊处方', drugs: [{ name: '处方药', dose: '见原处方', usage: '遵医嘱' }] }));
  assert.equal(archive.readArchives(scope).length, 4);
  for (const key of ['userId', 'actorId', 'patientId']) {
    const other = { ...scope, [key]: 'another' };
    assert.deepEqual(archive.readArchives(other), []);
    assert.throws(() => archive.saveArchive(other, check), /已不存在/);
  }
  const updated = archive.saveArchive(scope, { ...check, abnormal: 'CRP 18 mg/L' });
  assert.equal(updated.id, check.id);
  assert.equal(updated.createdAt, check.createdAt);
  assert.equal(archive.readArchives(scope).find(item => item.id === check.id).abnormal, 'CRP 18 mg/L');
  archive.deleteArchive(scope, hospital.id);
  assert.equal(archive.readArchives(scope).length, 3);
  assert.throws(() => archive.deleteArchive(scope, hospital.id), /已不存在/);
});

test('历史筛选真正组合关键词、时间、医院、科室、疾病且不混类型', () => {
  const rows = [input({ id: 'a', date: '2026-10-14', abnormal: 'CRP 18' }), input({ id: 'b', date: '2026-10-01' }), input({ id: 'c', hospital: '另一医院', date: '2026-10-12' }), input({ id: 'd', kind: 'outpatient', content: '门诊记录', date: '2026-10-14' })];
  const filter = { ...archive.emptyArchiveFilter(), keyword: 'crp', time: '近 7 天', hospital: '市医院', department: '风湿科', disease: 'sJIA' };
  assert.deepEqual(archive.filterArchives(rows, filter, 'check', '2026-10-14').map(row => row.id), ['a']);
  assert.deepEqual(archive.filterArchives(rows, { ...archive.emptyArchiveFilter(), time: '自定义', start: '2026-10-01', end: '2026-10-12' }).map(row => row.id), ['b', 'c']);
  assert.deepEqual(archive.archiveOptions(rows).hospitalOptions, ['全部医院', '另一医院', '市医院']);
});

test('无效日期、住院日期倒置、缺少处方药不入档；存储失败不报成功', () => {
  installWx(() => [404, {}], { session });
  for (const row of [input({ date: '2026-02-30' }), input({ kind: 'hospital', dischargeDate: '2026-10-01' }), input({ kind: 'prescription' })]) assert.throws(() => archive.saveArchive(scope, row));
  assert.deepEqual(archive.readArchives(scope), []);
  wx.setStorageSync = () => { throw new Error('quota'); };
  assert.throws(() => archive.saveArchive(scope, input()), /尚未入档/);
});

test('损坏的本机档案不会被静默覆盖成新列表', () => {
  const { storage } = installWx(() => [404, {}], { session });
  const broken = { version: 1, records: [{ title: '无法解析的旧资料' }] };
  storage.set(archive.archiveScopeKey(scope), broken);
  assert.throws(() => archive.readArchives(scope), /原数据已保留/);
  assert.throws(() => archive.saveArchive(scope, input()), /原数据已保留/);
  assert.deepEqual(storage.get(archive.archiveScopeKey(scope)), broken);
});

test('拍照取消和权限拒绝均不会填入示例、冒充识别或生成档案', () => {
  for (const message of ['chooseImage:fail cancel', 'chooseImage:fail auth deny']) {
    installWx(() => [404, {}], { session, extra: { chooseImage: options => options.fail({ errMsg: message }) } });
    const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseCamera();
    assert.equal(page.data.step, 'choose');
    assert.equal(page.data.draft.title, '');
    assert.equal(page.data.draft.demo, false);
    assert.equal(page.data.picking, false);
    assert.deepEqual(archive.readArchives(scope), []);
    assert.equal(page.data.permissionDenied, message.includes('auth'));
  }
});

test('相册选图上传原始字节并关联服务端附件，保存回执后才显示入档', async () => {
  const server = serverFixture(); const previews = [];
  const { calls } = installWx(server.respond, { session, extra: {
    chooseImage: options => options.success({ tempFilePaths: ['wxfile://tmp/photo.jpg'] }),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: jpegBytes() }) }),
    previewImage: options => previews.push(options.current),
  } });
  const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseAlbum(); page.preview();
  assert.deepEqual(previews, ['wxfile://tmp/photo.jpg']); fill(page); await page.save();
  assert.equal(page.data.step, 'saved'); assert.equal(server.records.size, 1);
  const row = [...server.records.values()][0]; assert.equal(row.artifactId, 'image-id'); assert.equal(row.source, 'album');
  const upload = calls.requests.find(call => call.path.endsWith('/artifacts'));
  assert.equal(upload.header['content-type'], 'image/jpeg'); assert.ok(upload.data instanceof ArrayBuffer);
  const write = calls.requests.find(call => call.path.endsWith('/clinical-archives'));
  assert.equal(write.data.imagePath, undefined); assert.deepEqual(archive.readArchives(scope), []);
});

test('原图读取失败保留待确认内容，不向服务端保存无原图档案', async () => {
  const server = serverFixture(); const { calls } = installWx(server.respond, { session, extra: {
    chooseImage: options => options.success({ tempFilePaths: ['wxfile://tmp/photo.jpg'] }),
    getFileSystemManager: () => ({ readFile: options => options.fail({ errMsg: 'file unavailable' }) }),
  } });
  const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseCamera(); fill(page); await page.save();
  assert.equal(page.data.step, 'confirm'); assert.equal(page.data.draft.title, '化验单'); assert.match(page.data.error, /原图无法读取/);
  assert.equal(server.records.size, 0); assert.equal(calls.requests.length, 0);
});

test('图片读取期间切换患者，迟到回调不上传或写入任一患者档案', async () => {
  let complete; const server = serverFixture();
  const { storage, calls } = installWx(server.respond, { session, extra: {
    chooseImage: options => options.success({ tempFilePaths: ['wxfile://tmp/photo.jpg'] }),
    getFileSystemManager: () => ({ readFile: options => { complete = options.success; } }),
  } });
  const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseCamera(); fill(page); const pending = page.save();
  storage.set(SESSION_KEY, { ...session, patientId: 'patient-2' }); complete({ data: jpegBytes() }); await pending;
  assert.equal(server.records.size, 0); assert.equal(calls.requests.length, 0); assert.notEqual(page.data.step, 'saved');
});

test('报告四入口跳转对应类型，历史查询携带筛选而非跳至复诊摘要', () => {
  const { calls } = installWx(() => [404, {}], { session });
  const page = instantiate(reportPage); page.onShow();
  for (const kind of ['hospital', 'check', 'outpatient', 'prescription']) page.openArchive({ currentTarget: { dataset: { kind } } });
  page.setData({ filter: { ...archive.emptyArchiveFilter(), keyword: 'CRP' } }); page.search();
  assert.deepEqual(calls.navigations.slice(0, 4).map(row => row[1]), ['hospital', 'check', 'outpatient', 'prescription'].map(kind => `/pages/patient/archive?kind=${kind}`));
  const query = calls.navigations.at(-1)[1]; assert.match(query, /kind=history/); assert.match(decodeURIComponent(query), /CRP/);
});

test('档案页通过服务端新增编辑和筛选，重开页面从API回读', async () => {
  const server = serverFixture(); installWx(server.respond, { session, extra: { pageScrollTo() {} } });
  const page = instantiate(archivePage); page.onLoad({ kind: 'check' }); await page.onShow(); page.add();
  page.setData({ draft: input() }); await page.save(); assert.equal(page.data.mode, 'detail'); assert.equal(page.data.detail.version, 1);
  page.edit(); page.changeField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '复查血常规' } }); await page.save();
  assert.equal(page.data.detail.title, '复查血常规'); assert.equal(page.data.detail.version, 2);
  const reopened = instantiate(archivePage); reopened.onLoad({ kind: 'check' }); await reopened.onShow(); assert.equal(reopened.data.rows[0].title, '复查血常规');
  reopened.changeFilter({ currentTarget: { dataset: { field: 'keyword' } }, detail: { value: '不存在' } }); assert.equal(reopened.data.rows.length, 0); reopened.resetFilter(); assert.equal(reopened.data.rows.length, 1);
});

test('删除和处方状态弹窗迟到确认不能向切换后的患者发送写请求', async () => {
  for (const action of ['remove', 'togglePrescription']) {
    let confirm; const server = serverFixture(); const row = { ...input({ kind: 'prescription', title: '处方', drugs: [{ name: '药品', dose: '见处方', usage: '遵医嘱' }] }), id: 'shared', patientId: scope.patientId, recordedBy: scope.actorId, version: 1, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' }; server.records.set(row.id, row);
    const { storage, calls } = installWx(server.respond, { session, extra: { pageScrollTo() {}, showModal: options => { confirm = options.success; } } });
    const page = instantiate(archivePage); page.onLoad({ kind: 'prescription', id: row.id }); await page.onShow(); page[action]();
    storage.set(SESSION_KEY, { ...session, patientId: 'patient-2' }); await page.onShow(); await confirm({ confirm: true, cancel: false });
    assert.equal(calls.requests.filter(call => call.method !== 'GET').length, 0); assert.equal(server.records.get(row.id).status, 'active');
  }
});

test('选图中切换身份或退出登录会解除忙碌，旧回调不覆盖新身份的选图', () => {
  for (const logout of [false, true]) {
    const callbacks = [];
    const { storage } = installWx(() => [404, {}], { session, extra: { chooseImage: options => callbacks.push(options) } });
    const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseCamera();
    assert.equal(page.data.picking, true);
    page.setData({ permissionDenied: true, hasImage: true });
    const nextSession = { ...session, patientId: 'patient-2' };
    if (logout) storage.delete(SESSION_KEY); else storage.set(SESSION_KEY, nextSession);
    page.onShow();
    assert.equal(page.data.picking, false); assert.equal(page.data.saving, false);
    assert.equal(page.data.hasImage, false); assert.equal(page.data.permissionDenied, false);
    assert.equal(page.data.step, 'choose'); assert.equal(page.data.previewPath, '');
    if (logout) { storage.set(SESSION_KEY, nextSession); page.onShow(); }
    page.chooseAlbum(); assert.equal(page.data.picking, true);
    callbacks[0].success({ tempFilePaths: ['wxfile://tmp/old-patient.jpg'] });
    assert.equal(page.data.picking, true); assert.equal(page.data.previewPath, '');
    callbacks[1].success({ tempFilePaths: ['wxfile://tmp/new-patient.jpg'] });
    assert.equal(page.data.step, 'confirm'); assert.equal(page.data.previewPath, 'wxfile://tmp/new-patient.jpg');
    assert.equal(page.data.picking, false);
  }
});

test('读取原图中切换身份或退出登录解除saving，迟到回调不覆盖新草稿', async () => {
  for (const logout of [false, true]) {
    let complete; const server = serverFixture(); const { storage } = installWx(server.respond, { session, extra: {
      chooseImage: options => options.success({ tempFilePaths: ['wxfile://tmp/old.jpg'] }),
      getFileSystemManager: () => ({ readFile: options => { complete = options.success; } }),
    } });
    const page = instantiate(scanPage); page.onLoad(); page.onShow(); page.chooseCamera(); fill(page); const pending = page.save();
    const next = { ...session, patientId: 'patient-2' }; if (logout) storage.delete(SESSION_KEY); else storage.set(SESSION_KEY, next); page.onShow();
    assert.equal(page.data.saving, false); if (logout) { storage.set(SESSION_KEY, next); page.onShow(); }
    page.manual(); page.changeField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '新患者手动报告' } }); complete({ data: jpegBytes() }); await pending;
    assert.equal(page.data.draft.title, '新患者手动报告'); assert.equal(page.data.saving, false); assert.equal(server.records.size, 0);
  }
});

test('参考儿童档案的九项检验与同一病例当前值、两日前对照及处方一致', () => {
  const rows = archive.referenceDemoArchiveSamples(new Date('2026-10-14T15:18:00.000Z'));
  const current = rows.find(row => row.id === 'demo-0');
  const previous = rows.find(row => row.id === 'demo-check-before');
  assert.equal(current.date, '2026-10-14'); assert.equal(previous.date, '2026-10-12');
  assert.deepEqual(current.items.map(({ name, value, unit }) => [name, value, unit]), [
    ['血小板计数', '152', '10^9/L'], ['铁蛋白', '3400', 'ng/mL'], ['AST', '86', 'U/L'],
    ['甘油三酯', '320', 'mg/dL'], ['纤维蛋白原', '2.4', 'g/L'], ['白细胞', '12.8', '10^9/L'], ['CRP', '168', 'mg/L'],
  ]);
  assert.deepEqual(previous.items.map(({ name, value, unit }) => [name, value, unit]), [['血小板计数', '210', '10^9/L'], ['铁蛋白', '1060', 'ng/mL']]);
  assert.equal(rows.filter(row => row.kind === 'check').reduce((sum, row) => sum + row.items.length, 0), 9);
  assert.deepEqual(rows.find(row => row.kind === 'prescription').drugs.map(drug => [drug.name, drug.dose]), [['泼尼松', '15 mg'], ['甲氨蝶呤', '7.5 mg']]);
  for (const row of rows) {
    assert.equal(row.hospital, '示例儿童医院'); assert.equal(row.doctor, '李医生'); assert.equal(row.department, '风湿免疫科');
    assert.equal(row.demo, true); assert.doesNotMatch(row.diagnosis, /MAS/); archive.validateArchive(row);
  }
});

test('自动档案仅在免邀请码模式为 patient-demo 首次创建，其他患者保持空档案', () => {
  const initial = config.AUTO_DEMO_LOGIN;
  try {
    config.AUTO_DEMO_LOGIN = true;
    installWx(() => [404, {}], { session });
    archive.ensureDemoArchives(scope);
    assert.deepEqual(archive.readArchives(scope), []);
    const reference = { ...scope, patientId: 'patient-demo' };
    archive.ensureDemoArchives(reference);
    assert.equal(archive.readArchives(reference).length, 5);
    archive.ensureDemoArchives(reference);
    assert.equal(archive.readArchives(reference).length, 5);
    config.AUTO_DEMO_LOGIN = false;
    const standard = { ...reference, actorId: 'standard-actor' };
    archive.ensureDemoArchives(standard);
    assert.deepEqual(archive.readArchives(standard), []);
  } finally { config.AUTO_DEMO_LOGIN = initial; }
});

test('旧内置示例只升级未编辑数据，保留用户新增、修改和主动删除', () => {
  const initial = config.AUTO_DEMO_LOGIN;
  try {
    config.AUTO_DEMO_LOGIN = true;
    const { storage } = installWx(() => [404, {}], { session });
    const reference = { ...scope, patientId: 'patient-demo' };
    const key = archive.archiveScopeKey(reference);
    const samples = archive.referenceDemoArchiveSamples(new Date('2026-10-13T00:00:00Z'));
    const oldCurrent = { ...samples[0], abnormal: '旧示例：铁蛋白 680', items: [{ name: '铁蛋白', value: '680', unit: 'μg/L', range: '见原报告', abnormal: true }] };
    const editedHospital = { ...samples[1], title: '用户修改的住院记录', updatedAt: '2026-10-13T01:00:00Z' };
    const own = { ...input(), id: 'own', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
    storage.set(key, { version: 1, records: [oldCurrent, editedHospital, own] }); storage.set(`${key}:demo-seeded`, true);
    archive.ensureDemoArchives(reference);
    const migrated = archive.readArchives(reference);
    assert.equal(migrated.find(row => row.id === 'demo-0').items.find(item => item.name === '铁蛋白').value, '3400');
    assert.equal(migrated.find(row => row.id === 'demo-1').title, '用户修改的住院记录');
    assert.equal(migrated.find(row => row.id === 'own').title, own.title);
    assert.equal(migrated.some(row => row.id === 'demo-2' || row.id === 'demo-3'), false);
    assert.equal(migrated.some(row => row.id === 'demo-check-before'), true);
    archive.deleteArchive(reference, 'demo-0'); archive.ensureDemoArchives(reference);
    assert.equal(archive.readArchives(reference).some(row => row.id === 'demo-0'), false);
  } finally { config.AUTO_DEMO_LOGIN = initial; }
});

test('服务端档案更新时间按北京时间显示', async () => {
  const server = serverFixture(); const row = { ...input(), id: 'time-test', patientId: scope.patientId, recordedBy: scope.actorId, version: 1, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T02:05:00Z' }; server.records.set(row.id, row);
  installWx(server.respond, { session, extra: { pageScrollTo() {} } }); const page = instantiate(archivePage); page.onLoad({ kind: 'check', id: row.id }); await page.onShow();
  assert.match(page.data.detail.recordedAt, /10:05/); assert.doesNotMatch(page.data.detail.recordedAt, /02:05/);
});
