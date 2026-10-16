import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const emergency = await loadPage(registered, new URL('../dist/pages/patient/emergency.js', import.meta.url).href);
const { loadSupportPlan, loadSupportKit, loadSupportCard } = await import('../dist/support.js');
const currentSession = { accessToken: 'a', refreshToken: 'r', userId: 'user-a', actorIds: ['actor-a'], actorId: 'actor-a', role: 'PATIENT', patientId: 'patient-a' };
const instant = '2026-10-14T00:00:00.000Z';
function plan(status = 'CONFIRMED', nightCapable = 'TRUE') {
  return {
    id: 'plan-a', patientId: 'patient-a', status, step: 4, version: 2, createdAt: instant, updatedAt: instant,
    caregiver: { primaryHospital: { name: '医院', nightCapable: 'TRUE' }, route: { minutesNight: 30, minutesDay: 20 }, customThresholds: [] },
    clinician: status === 'CONFIRMED' ? { nightCapable, triageScript: '请评估当前情况。' } : {},
    decisionThresholds: ['抽搐', '高热伴精神差', '出血', '剧烈头痛'].map((label, index) => ({ code: `s${index}`, label, alwaysRequired: true })),
  };
}
function kit(locationNote = '门边柜子') {
  return {
    id: 'kit-a', patientId: 'patient-a', locationNote, familyInformed: false, version: 1, createdAt: instant, updatedAt: instant,
    status: 'NOT_VERIFIED', verificationStatus: 'NOT_VERIFIED', completedCount: 0, totalCount: 1, needsReprintCount: 0,
    items: [{ id: 'item-a', type: 'DOC', label: '资料', source: 'CLINICIAN', prepared: false, needsReprint: false }],
  };
}
async function setup(planValue, kitValue = null, role = 'PATIENT') {
  const scrolls = [];
  const environment = installWx(path => {
    if (path.endsWith('/emergency-plan')) return [200, { data: { plan: planValue } }];
    if (path.endsWith('/emergency-kit')) return [200, { data: { kit: kitValue } }];
    if (path.endsWith('/emergency-card')) return [200, { data: { card: null } }];
    return [200, { data: [] }];
  }, { session: { ...currentSession, role }, extra: { pageScrollTo(options) { scrolls.push(options); } } });
  const page = instantiate(emergency);
  const setData = page.setData;
  page.setData = function (patch, callback) { setData.call(this, patch); callback?.(); };
  page.onShow();
  await settle();
  return { ...environment, page, scrolls };
}

test('医生确认后返回同一档案会重新核对预案并开放流程卡生成', async () => {
  let currentPlan = plan('PENDING_CLINICIAN');
  installWx(path => {
    if (path.endsWith('/emergency-plan')) return [200, { data: { plan: currentPlan } }];
    if (path.endsWith('/emergency-kit')) return [200, { data: { kit: kit() } }];
    if (path.endsWith('/emergency-card')) return [200, { data: { card: null } }];
    return [200, { data: [] }];
  }, { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  assert.equal(page.data.cardReady, false);
  assert.equal(page.data.planStatusText, '等待医生确认');
  currentPlan = plan('CONFIRMED');
  page.onShow();
  await settle();
  assert.equal(page.data.plan.status, 'CONFIRMED');
  assert.equal(page.data.planStatusText, '医生已确认');
  assert.equal(page.data.cardReady, true);
});

test('刷新会更新服务端状态，同时保留原有草稿和请求期间继续输入的内容', async () => {
  let delayed = false;
  const responses = [];
  installWx(path => {
    if (path.endsWith('/emergency-plan') || path.endsWith('/emergency-kit')) {
      const response = path.endsWith('/emergency-plan') ? [200, { data: { plan: plan() } }] : [200, { data: { kit: kit('新服务端位置') } }];
      return delayed ? new Promise(resolve => responses.push(() => resolve(response))) : response;
    }
    if (path.endsWith('/emergency-card')) return [200, { data: { card: null } }];
    return [200, { data: [] }];
  }, { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  page.input({ currentTarget: { dataset: { field: 'hospitalName' } }, detail: { value: '未保存医院' } });
  delayed = true;
  page.refresh();
  await settle();
  page.input({ currentTarget: { dataset: { field: 'kitLocation' } }, detail: { value: '正在输入的新位置' } });
  page.pickNight({ detail: { value: 1 } });
  page.pickTransport({ detail: { value: 1 } });
  page.changeFamily({ detail: { value: true } });
  responses.splice(0).forEach(finish => finish());
  await settle();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.plan.hospital.name, '医院');
  assert.equal(page.data.kit.locationNote, '新服务端位置');
  assert.equal(page.data.hospitalName, '未保存医院');
  assert.equal(page.data.kitLocation, '正在输入的新位置');
  assert.equal(page.data.hospitalNightCapable, 'FALSE');
  assert.equal(page.data.nightText, '不能夜间收治');
  assert.equal(page.data.transportPrimary, 'TAXI');
  assert.equal(page.data.transportText, '出租车 / 网约车');
  assert.equal(page.data.familyInformed, true);
  assert.equal(page.data.cardReady, true, '生成条件仍按已保存资料判断');
});

test('预案和急诊包草稿收到保存确认后，恢复从最新服务端资料同步表单', async () => {
  let currentPlan = plan('DRAFT');
  let currentKit = kit();
  installWx((path, options) => {
    if (path.endsWith('/emergency-plan')) {
      if (options.method === 'POST') {
        currentPlan = { ...currentPlan, locationKey: options.data.locationKey, caregiver: options.data.caregiver, version: currentPlan.version + 1 };
        return [200, { data: { plan: currentPlan, created: true } }];
      }
      return [200, { data: { plan: currentPlan } }];
    }
    if (path.endsWith('/emergency-kit')) {
      if (options.method === 'POST') {
        currentKit = { ...currentKit, locationNote: options.data.locationNote, familyInformed: options.data.familyInformed, version: currentKit.version + 1 };
        return [200, { data: { kit: currentKit, created: true } }];
      }
      return [200, { data: { kit: currentKit } }];
    }
    if (path.endsWith('/emergency-card')) return [200, { data: { card: null } }];
    return [200, { data: [] }];
  }, { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  for (const [field, value] of Object.entries({ locationKey: '上海', hospitalName: '本次保存的医院', transportBackup: '出租车', driverName: '家属', kitLocation: '本次保存的位置' })) page.input({ currentTarget: { dataset: { field } }, detail: { value } });
  page.savePlan();
  await settle();
  assert.equal(page.outbox.entries().length, 0);
  assert.equal(page.data.plan.hospital.name, '本次保存的医院');
  assert.equal(page.data.kitLocation, '本次保存的位置', '保存预案不清除急诊包草稿');
  page.saveKit();
  await settle();
  assert.equal(page.outbox.entries().length, 0);
  assert.equal(page.data.kit.locationNote, '本次保存的位置');
  currentPlan = { ...currentPlan, caregiver: { ...currentPlan.caregiver, primaryHospital: { ...currentPlan.caregiver.primaryHospital, name: '其他设备确认的医院' } } };
  currentKit = { ...currentKit, locationNote: '其他设备确认的位置' };
  page.onShow();
  await settle();
  assert.equal(page.data.hospitalName, '其他设备确认的医院');
  assert.equal(page.data.kitLocation, '其他设备确认的位置');
});

test('晚到的旧读取不能覆盖更晚读取确认的预案状态', async () => {
  let reads = 0;
  let finishOld;
  installWx(path => {
    if (path.endsWith('/emergency-plan')) {
      reads += 1;
      if (reads === 2) return new Promise(resolve => { finishOld = () => resolve([200, { data: { plan: plan('PENDING_CLINICIAN') } }]); });
      return [200, { data: { plan: plan(reads === 1 ? 'PENDING_CLINICIAN' : 'CONFIRMED') } }];
    }
    if (path.endsWith('/emergency-kit')) return [200, { data: { kit: kit() } }];
    if (path.endsWith('/emergency-card')) return [200, { data: { card: null } }];
    return [200, { data: [] }];
  }, { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  page.refresh();
  await settle();
  page.load(page.scope);
  await settle();
  assert.equal(page.data.cardReady, true);
  finishOld();
  await settle();
  assert.equal(page.data.plan.status, 'CONFIRMED');
  assert.equal(page.data.cardReady, true);
});

test('未建、草稿与待确认预案不产生失败的流程卡写入，设置入口展开并定位预案', async () => {
  for (const value of [null, plan('DRAFT'), plan('PENDING_CLINICIAN')]) {
    const { page, calls, scrolls } = await setup(value);
    assert.equal(page.data.cardReady, false);
    assert.equal(page.data.cardSetupTarget, 'plan');
    const requestCount = calls.requests.length;
    page.generateCard();
    assert.equal(calls.requests.length, requestCount);
    assert.equal(page.outbox.entries().length, 0);
    page.openCardSetup();
    assert.equal(page.data.planSettingsOpen, true);
    assert.equal(scrolls.at(-1).selector, '#emergency-plan');
  }
});

test('患者填写医院夜间可收治不能替代医生确认；旧投影缺少确认字段时也不可生成', async () => {
  for (const capability of ['FALSE', 'UNKNOWN', undefined]) {
    const value = plan();
    if (capability === undefined) delete value.clinician.nightCapable;
    else value.clinician.nightCapable = capability;
    const { page } = await setup(value, kit());
    assert.equal(page.data.plan.hospital.nightCapable, 'TRUE');
    assert.equal(page.data.cardReady, false);
    assert.match(page.data.cardPrerequisiteHint, /医生.*夜间收治/);
    page.generateCard();
    assert.equal(page.outbox.entries().length, 0);
  }
});

test('急诊包无存放位置时引导实际准备入口；未核对和零物品完成不额外阻止生成', async () => {
  for (const value of [null, kit('')]) {
    const { page, scrolls } = await setup(plan(), value);
    assert.equal(page.data.cardReady, false);
    assert.equal(page.data.cardSetupTarget, 'kit');
    page.openCardSetup();
    assert.equal(scrolls.at(-1).selector, '#emergency-kit');
  }
  const { page } = await setup(plan(), kit());
  assert.equal(page.data.cardReady, true);
  assert.equal(page.data.kit.status, 'NOT_VERIFIED');
  assert.equal(page.data.kit.completedCount, 0);
  page.flush = () => {};
  page.generateCard();
  assert.equal(page.outbox.entries().length, 1);
  assert.equal(page.outbox.entries()[0].operation, 'EMERGENCY_CARD');
});

test('照护者不能通过设置入口提交预案，待医生确认预案也不产生草稿写入', async () => {
  const caregiver = await setup(null, null, 'CAREGIVER');
  assert.match(caregiver.page.data.cardPrerequisiteHint, /患者本人或法定监护人/);
  caregiver.page.savePlan();
  assert.equal(caregiver.page.outbox.entries().length, 0);
  const pending = await setup(plan('PENDING_CLINICIAN'));
  pending.page.savePlan();
  assert.equal(pending.page.outbox.entries().length, 0);
  assert.match(pending.page.data.message, /等待医生确认/);
});

test('新急诊包不能用空白位置建立；身份失效清除上一档案的生成状态', async () => {
  const { page, storage } = await setup(plan(), kit());
  page.setData({ kit: null, kitLocation: '   ' });
  page.saveKit();
  assert.equal(page.outbox.entries().length, 0);
  assert.match(page.data.error, /填写急诊包存放位置/);
  storage.delete(SESSION_KEY);
  page.onShow();
  assert.equal(page.data.cardReady, false);
  assert.equal(page.data.cardSetupTarget, '');
  assert.equal(page.data.cardPrerequisiteHint, '');
});

test('读取失败不当作首次建档，提供重读入口且不把生成写入离线队列', async () => {
  const { calls } = installWx(() => 'NETWORK', { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  assert.equal(page.data.cardReady, false);
  assert.equal(page.data.cardSetupTarget, 'reload');
  assert.match(page.data.cardPrerequisiteHint, /暂未读全/);
  page.generateCard();
  assert.equal(page.outbox.entries().length, 0);
  const requestCount = calls.requests.length;
  page.openCardSetup();
  assert.ok(calls.requests.length > requestCount);
  await settle();
});

test('仅流程卡读取失败时也禁止生成，避免把未知旧卡当作版本零覆盖', async () => {
  installWx(path => {
    if (path.endsWith('/emergency-plan')) return [200, { data: { plan: plan() } }];
    if (path.endsWith('/emergency-kit')) return [200, { data: { kit: kit() } }];
    if (path.endsWith('/emergency-card')) return 'NETWORK';
    return [200, { data: [] }];
  }, { session: currentSession });
  const page = instantiate(emergency);
  page.onShow();
  await settle();
  assert.equal(page.data.plan.status, 'CONFIRMED');
  assert.equal(page.data.kit.locationNote, '门边柜子');
  assert.equal(page.data.cardReady, false);
  assert.equal(page.data.cardSetupTarget, 'reload');
  page.generateCard();
  assert.equal(page.outbox.entries().length, 0);
});

test('只有明确空资源表示尚未建立，格式错误与患者不匹配均要求重读', async () => {
  for (const [key, load, valid] of [['plan', loadSupportPlan, plan()], ['kit', loadSupportKit, kit()], ['card', loadSupportCard, { patientId: 'patient-a' }]]) {
    installWx(() => [200, { data: { [key]: null } }], { session: currentSession });
    assert.equal(await load(), null);
    for (const data of [{}, { [key]: {} }, { [key]: { ...valid, patientId: 'another-patient' } }]) {
      installWx(() => [200, { data }], { session: currentSession });
      await assert.rejects(load(), /资料格式无效/);
    }
  }
});

test('非空应急投影解析失败时，页面引导重读而不是新建', async () => {
  for (const brokenKey of ['plan', 'kit', 'card']) {
    installWx(path => {
      for (const [key, value] of [['plan', plan()], ['kit', kit()], ['card', null]]) {
        if (path.endsWith(`/emergency-${key}`)) return [200, { data: { [key]: key === brokenKey ? { incompatible: true } : value } }];
      }
      return [200, { data: [] }];
    }, { session: currentSession });
    const page = instantiate(emergency);
    page.onShow();
    await settle();
    assert.equal(page.data.cardSetupTarget, 'reload');
    assert.equal(page.data.cardReady, false);
  }
});

test('切换档案立即清空全部表单和同步状态，旧同步结果及异常均不回写新档案', async () => {
  const outcomes = [
    { sent: 1 }, { networkError: true }, { rejected: 1 }, { denied: true }, new Error('旧档案存储错误'),
  ];
  for (const outcome of outcomes) {
    for (const switchBack of [false, true]) {
      const { storage } = installWx(path => {
        for (const key of ['plan', 'kit', 'card']) if (path.endsWith(`/emergency-${key}`)) return [200, { data: { [key]: null } }];
        return [200, { data: [] }];
      }, { session: currentSession });
      const page = instantiate(emergency);
      page.onShow();
      await settle();
      page.setData({ hospitalName: '旧医院', hospitalAddress: '旧地址', hospitalNightCapable: 'TRUE', locationKey: '旧城市', routeNight: '20', routeDay: '30', routeNotes: '旧路线', transportPrimary: 'TAXI', transportBackup: '旧备用', driverName: '旧陪同', driverPhone: '13800000000', kitLocation: '旧位置', familyInformed: true, nightText: '旧收治', transportText: '旧交通', saving: true, recipients: [{ code: 'FRIEND', label: '朋友', selected: true }] });
      const oldOutbox = page.outbox;
      oldOutbox.enqueue({ operation: 'EMERGENCY_CARD', idempotencyKey: 'old-card', payload: { action: 'GENERATE', idempotencyKey: 'old-card', expectedVersion: 0 } });
      let finish;
      oldOutbox.flush = () => new Promise((resolve, reject) => { finish = () => outcome instanceof Error ? reject(outcome) : resolve({ sent: 0, rejected: 0, pending: 0, networkError: false, denied: false, ...outcome }); });
      const inFlight = page.flush();
      assert.equal(page.data.syncing, true);
      storage.set(SESSION_KEY, { ...currentSession, actorId: 'actor-b', actorIds: ['actor-b'], patientId: 'patient-b' });
      page.onShow();
      for (const field of ['hospitalName', 'hospitalAddress', 'locationKey', 'routeNight', 'routeDay', 'routeNotes', 'transportBackup', 'driverName', 'driverPhone', 'kitLocation']) assert.equal(page.data[field], '', field);
      assert.equal(page.data.hospitalNightCapable, 'UNKNOWN');
      assert.equal(page.data.transportPrimary, 'DRIVE');
      assert.equal(page.data.familyInformed, false);
      assert.equal(page.data.syncing, false);
      assert.equal(page.data.saving, false);
      assert.ok(page.data.recipients.every(item => !item.selected));
      assert.equal(oldOutbox.entries().length, 1, '切换身份不删除原身份待提交记录');
      await settle();
      if (switchBack) { storage.set(SESSION_KEY, currentSession); page.onShow(); await settle(); }
      page.setData({ message: '当前档案消息', error: '当前档案提示', syncing: true });
      const expected = structuredClone(page.data);
      let refreshCount = 0;
      page.refreshQueue = () => { refreshCount += 1; };
      finish();
      await inFlight;
      assert.deepEqual(page.data, expected);
      assert.equal(refreshCount, 0);
    }
  }
});

test('撤回分享的迟到成功或失败不覆盖切换后档案的提示和同步状态', async () => {
  for (const reply of [[200, { data: { revoked: true } }], [503, { message: '暂不可用' }]]) {
    let finish;
    const { storage } = installWx(path => {
      if (path.endsWith('/revoke')) return new Promise(resolve => { finish = () => resolve(reply); });
      for (const key of ['plan', 'kit', 'card']) if (path.endsWith(`/emergency-${key}`)) return [200, { data: { [key]: null } }];
      return [200, { data: [] }];
    }, { session: currentSession });
    const page = instantiate(emergency);
    page.onShow();
    await settle();
    const pending = page.revoke({ currentTarget: { dataset: { code: 'abc1234' } } });
    await settle();
    storage.set(SESSION_KEY, { ...currentSession, actorId: 'actor-b', actorIds: ['actor-b'], patientId: 'patient-b' });
    page.onShow();
    await settle();
    page.setData({ message: '当前档案消息', error: '当前档案提示', syncing: true });
    const expected = structuredClone(page.data);
    finish();
    await pending;
    assert.deepEqual(page.data, expected);
  }
});
