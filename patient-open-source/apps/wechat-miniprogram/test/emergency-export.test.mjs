import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const emergency = await loadPage(registered, new URL('../dist/pages/patient/emergency.js', import.meta.url).href);
const currentSession = { accessToken: 'current-token', refreshToken: 'refresh', userId: 'user-a', actorIds: ['actor-a'], actorId: 'actor-a', role: 'PATIENT', patientId: 'patient-a' };
const instant = '2026-10-14T00:00:00.000Z';
function card(overrides = {}) {
  return {
    id: 'card-a', patientId: 'patient-a', planVersion: 2, kitVersion: 1, medicationVersion: 'v1', generatedAt: instant,
    createdAt: instant, updatedAt: instant, version: 1, needsReprint: false, verificationStatus: 'CURRENT', history: [{}],
    thresholds: ['抽搐或意识不清', '高热伴精神差', '明显出血', '剧烈头痛'].map((label, index) => ({ code: `s${index}`, label, alwaysRequired: true })),
    destination: { hospitalName: '演示医院', arrivalMinutesNight: 20, triageScript: '请评估当前状态。', followUpClinicianPhone: '医院总机转随诊医生', onCallContact: { label: '值班医生', phone: '医院总机转值班' } },
    kitLocation: '门边鞋柜', items: [], neverDo: ['不要自行加量', '不要自行停药', '不要自行使用抗生素'], canDo: ['记录体温', '带上资料', '记录症状', '按预案就医', '保持安静'],
    printHints: { size: 'A4', orientation: 'PORTRAIT', monochrome: true, suggestedLocations: ['FRIDGE', 'DOOR_INSIDE', 'CAR'] },
    ...overrides,
  };
}
function setup(value = card(), extra = {}) {
  const downloads = [], opened = [];
  const environment = installWx(path => path.endsWith('/emergency-card') ? [200, { data: { card: value } }] : [200, { data: {} }], {
    session: currentSession,
    extra: {
      downloadFile(options) { downloads.push(options); Promise.resolve().then(() => options.success({ statusCode: 200, tempFilePath: '/tmp/emergency-a.pdf' })); return { abort() {} }; },
      openDocument(options) { opened.push(options); options.success(); },
      ...extra,
    },
  });
  return { ...environment, page: instantiate(emergency), downloads, opened };
}

test('应急卡认证下载后打开 PDF 菜单，只有服务成功才提示可保存', async () => {
  const result = setup();
  await result.page.exportCard();
  assert.equal(result.calls.requests[0].path, '/api/v1/patients/patient-a/emergency-card');
  assert.equal(result.downloads.length, 1);
  assert.match(result.downloads[0].url, /\/api\/v1\/patients\/patient-a\/emergency-card\.pdf$/);
  assert.equal(result.downloads[0].header.authorization, 'Bearer current-token');
  assert.equal(result.downloads[0].header['x-actor-id'], 'actor-a');
  assert.equal(result.opened[0].showMenu, true);
  assert.equal(result.opened[0].fileType, 'pdf');
  assert.match(result.page.data.exportNotice, /保存到自己的设备/);
  assert.equal(result.page.data.exporting, false);
});

test('应急卡来源变化时拒绝导出过期卡片，保留更新入口', async () => {
  const result = setup(card({ needsReprint: true, verificationStatus: 'STALE', reprintReason: 'MEDICATION_UPDATED' }));
  await result.page.exportCard();
  assert.equal(result.downloads.length, 0);
  assert.equal(result.opened.length, 0);
  assert.equal(result.page.data.cardStatusText, '需更新');
  assert.match(result.page.data.error, /生成新版本/);
});

test('下载途中切换患者后，不打开上一患者的临时 PDF', async () => {
  let finishDownload;
  const result = setup(card(), { downloadFile(options) { finishDownload = options; return { abort() {} }; } });
  const exported = result.page.exportCard();
  await settle();
  assert.ok(finishDownload);
  result.storage.set(SESSION_KEY, { ...currentSession, actorId: 'actor-b', actorIds: ['actor-b'], patientId: 'patient-b' });
  finishDownload.success({ statusCode: 200, tempFilePath: '/tmp/patient-a.pdf' });
  await exported;
  assert.equal(result.opened.length, 0);
  assert.equal(result.page.data.exportNotice, '');
});

test('离开页面中止下载，迟到响应不打开 PDF', async () => {
  let downloadOptions; let aborted = false;
  const result = setup(card(), { downloadFile(options) { downloadOptions = options; return { abort() { aborted = true; options.fail({ errMsg: 'aborted' }); } }; } });
  const exported = result.page.exportCard();
  await settle();
  result.page.onUnload();
  await exported;
  assert.ok(downloadOptions);
  assert.equal(aborted, true);
  assert.equal(result.opened.length, 0);
  assert.equal(result.page.data.exporting, false);
});

test('切换到未绑定患者的身份后中止导出并清除上一患者应急资料', async () => {
  let aborted = false;
  const result = setup(card(), { downloadFile(options) { return { abort() { aborted = true; options.fail({ errMsg: 'aborted' }); } }; } });
  result.page.setData({ card: card(), hospitalName: '上一患者医院', canShare: true, canPlanWrite: true, scopeKey: 'user-a:actor-a:patient-a' });
  const exported = result.page.exportCard();
  await settle();
  const { patientId: _patientId, ...unboundSession } = currentSession;
  result.storage.set(SESSION_KEY, unboundSession);
  result.page.onShow();
  await exported;
  assert.equal(aborted, true);
  assert.equal(result.opened.length, 0);
  assert.equal(result.page.data.card, null);
  assert.equal(result.page.data.hospitalName, '');
  assert.equal(result.page.data.canShare, false);
  assert.equal(result.page.data.canPlanWrite, false);
  assert.equal(result.page.data.scopeKey, '');
});

test('下载失败不误称已保存；预案与分享设置默认折叠', async () => {
  const result = setup(card(), { downloadFile(options) { options.success({ statusCode: 503, tempFilePath: '/tmp/error.json' }); return { abort() {} }; } });
  assert.equal(result.page.data.planSettingsOpen, false);
  assert.equal(result.page.data.shareSettingsOpen, false);
  const before = result.calls.requests.length;
  result.page.togglePlanSettings(); result.page.toggleShareSettings();
  assert.equal(result.calls.requests.length, before);
  await result.page.exportCard();
  assert.equal(result.opened.length, 0);
  assert.equal(result.page.data.exportNotice, '');
  assert.match(result.page.data.error, /PDF 暂不可用/);
});
