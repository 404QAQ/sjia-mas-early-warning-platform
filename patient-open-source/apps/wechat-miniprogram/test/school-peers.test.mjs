import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const school = await import('../dist/pages/patient/school.js');

const PATIENT = 'patient-demo';

/** L-01 服务端的真实回执形状。 */
function schoolView(overrides = {}) {
  return {
    disclosure: {
      patientId: PATIENT, term: '2026-S1', recipients: [{ role: 'HEAD_TEACHER', level: 'ESSENTIAL' }, { role: 'SCHOOL_NURSE', level: 'ESSENTIAL' }],
      peArrangement: 'FULL', peerDecision: { decision: 'DO_NOT_SHARE', setAt: '2026-10-07T12:00:00.000Z' }, version: 2, updatedAt: '2026-10-07T12:00:00.000Z',
      ...(overrides.disclosure ?? {}),
    },
    contentVersion: 'L-01-v1', guidance: '校园说明按接收对象分层生成；同学这一层由孩子自己决定，体育课不会默认免修。',
    emergencyShareBoundary: { directShare: false, visibility: 'G2_SUMMARY' },
  };
}
test('L-01 校园告知：按接收层与体育课安排解析，未知字段一律拒绝', () => {
  const parsed = school.parse(schoolView(), PATIENT);
  assert.equal(parsed.disclosure.version, 2);
  assert.equal(parsed.disclosure.peArrangement, 'FULL');
  assert.deepEqual(parsed.disclosure.recipients.map(item => item.role), ['HEAD_TEACHER', 'SCHOOL_NURSE']);
  assert.equal(parsed.disclosure.peerDecision.decision, 'DO_NOT_SHARE');
  // 三类接收层映射到固定文案，同学层不在 recipients 里（它不是「接收层」而是孩子的选择）。
  const tiers = school.tiers(parsed);
  assert.deepEqual(tiers.map(item => [item.role, item.selected]), [['HEAD_TEACHER', true], ['SCHOOL_NURSE', true], ['SUBJECT_TEACHER', false]]);
  assert.equal(school.peText('EXEMPT'), '免修（需要医生开证明）');
});

test('L-01：患者范围不一致、多余字段、非法版本都必须拒绝', () => {
  assert.throws(() => school.parse(schoolView(), 'other-patient'), /不一致/);
  assert.throws(() => school.parse({ ...schoolView(), extra: 1 }, PATIENT));
  assert.throws(() => school.parse(schoolView({ disclosure: { version: -1 } }), PATIENT), /版本无效/);
  assert.throws(() => school.parse(schoolView({ disclosure: { peArrangement: 'SOMETIMES' } }), PATIENT));
  assert.throws(() => school.parse(schoolView({ disclosure: { recipients: [{ role: 'PRINCIPAL', level: 'ESSENTIAL' }] } }), PATIENT));
  assert.throws(() => school.parse(schoolView({ disclosure: { schoolEmergencyContact: { name: '李某某', relation: '母亲', phoneMasked: '13812345678', authorized: true } } }), PATIENT), /学校联系人/);});

test('L-01：勾选的层按固定顺序归一化，避免同样内容产生不同命令', () => {
  assert.deepEqual(school.normalizePicked(['SCHOOL_NURSE', 'HEAD_TEACHER']), ['HEAD_TEACHER', 'SCHOOL_NURSE']);
  assert.deepEqual(school.normalizePicked(['SUBJECT_TEACHER']), ['SUBJECT_TEACHER']);
  assert.deepEqual(school.normalizePicked(['PRINCIPAL', 7]), []);
  assert.deepEqual(school.normalizePicked(undefined), []);
});

test('校园页遵守患者范围并可从个人档案进入，病友页面不对外开放', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.ok(app.pages.includes('pages/patient/school'), '校园告知页必须注册到 app.json');
  assert.equal(app.pages.includes('pages/patient/peers'), false, 'Demo 不注册病友与经验页面，避免从路径直接进入');
  const [schoolSource, schoolMarkup, home, accountSource, accountMarkup] = await Promise.all([
    readFile(new URL('../src/pages/patient/school.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/school.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/account.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/account.wxml', import.meta.url), 'utf8'),
  ]);
  assert.match(schoolSource, /school-disclosure/);
  assert.match(schoolSource, /expectedVersion/);
  assert.match(schoolSource, /'PEER_DECISION'/);
  assert.match(schoolSource, /patientId\(\)/);
  assert.match(schoolSource, /sameScope/);
  // 设计规格的硬约束：不做一次通知全部老师，也不为同学层代选。
  assert.doesNotMatch(schoolSource, /一键/);
  assert.match(schoolSource, /不提供「一次通知全部老师」/);
  assert.match(schoolMarkup, /同学这一层/);
  assert.ok(app.tabBar.list.some(item => item.pagePath === 'pages/patient/account'), '个人档案必须可从底部导航进入');
  assert.match(accountSource, /school: '\/pages\/patient\/school'/);
  assert.match(accountSource, /profileEntry\('school', '上学这件事'/);
  assert.match(accountMarkup, /data-key="\{\{entry.key\}\}" bindtap="openFeature"/);
  assert.doesNotMatch(home, /openPeers|病友与经验/);
  assert.doesNotMatch(accountSource, /\/pages\/patient\/peers|profileEntry\('peers'/);
});
