import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('微信小程序只包含非医生角色页面并保留联系人入口', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  const requiredPages = ['pages/auth/index', 'pages/home/index', 'pages/patient/records', 'pages/patient/joint', 'pages/patient/emergency', 'pages/patient/life-event', 'pages/patient/work-support', 'pages/patient/transition', 'pages/patient/pregnancy', 'pages/patient/support', 'pages/patient/health', 'pages/patient/screening', 'pages/patient/more', 'pages/patient/menstrual', 'pages/patient/medications', 'pages/contact/index'];
  for (const page of requiredPages) assert.ok(app.pages.includes(page), `missing page ${page}`);
  assert.equal(new Set(app.pages).size, app.pages.length, 'app.json 不应注册重复页面');
  assert.equal(app.pages.some(page => page.includes('doctor')), false);
  const project = JSON.parse(await readFile(new URL('../project.config.json', import.meta.url), 'utf8'));
  assert.equal(project.compileType, 'miniprogram');
  assert.equal(project.miniprogramRoot, 'dist/');
  const distApp = JSON.parse(await readFile(new URL('../dist/app.json', import.meta.url), 'utf8'));
  assert.deepEqual(distApp.pages, app.pages, '构建产物页面清单必须与源码一致');
  assert.equal(new Set(distApp.pages).size, distApp.pages.length, 'dist/app.json 不应注册重复页面');
  for (const page of distApp.pages) {
    for (const extension of ['json', 'js', 'wxml', 'wxss']) {
      await readFile(new URL(`../dist/${page}.${extension}`, import.meta.url));
    }
  }
  const appSource = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(appSource, /getLaunchOptionsSync/);
  assert.match(appSource, /pages\/contact\/index/);
});

test('微信小程序端 API 继续使用 Authorization，会话默认失效即不展示患者数据', async () => {
  const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(source, /Bearer/);
  assert.match(source, /auth\/wechat\/(?:login|session)/);
  assert.match(source, /session\(\)/);
  assert.match(source, /auth\/actors/);
  assert.match(source, /x-actor-id/);
  assert.match(source, /refreshSession/);
  assert.match(source, /parseActors/);
  assert.match(source, /sameSessionIdentity\(latest, current\)/);
  assert.match(source, /sameSessionIdentity\(expected, session\(\)\)/);
  assert.match(source, /availableActors/);
  assert.match(source, /switchActor/);
});

test('多 Actor 切换只接受服务端白名单并排除医生身份', async () => {
  const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(source, /actor\.relation !== 'CLINICIAN'/);
  assert.match(source, /latest\.actorIds\.includes\(actor\.id\)/);
  assert.match(source, /selected = actors\.find/);
  assert.match(source, /latest\.actorId !== current\.actorId/);
  assert.match(source, /Date\.parse\(actor\.revokedAt\) > now/);
  const home = await readFile(new URL('../src/pages/home/index.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(home, /changeActor/);
  assert.match(home, /openHealth/);
  assert.match(home, /openScreening/);
  assert.match(home, /openMore/);
  assert.match(home, /openEmergency/);
  assert.match(home, /openLifeEvent/);
  assert.match(home, /openWorkSupport/);
  assert.match(home, /openTransition/);
  assert.match(home, /sameActorScope/);
  assert.match(markup, /bindtap="toggleActors"/);
  assert.doesNotMatch(markup, /服务端当前授权|切换不会扩大权限/);
  assert.match(markup, /健康资料/);
  assert.match(markup, /bindtap="openAccount"/);
  assert.match(markup, /健康资料、照护团队与生活服务/);
  assert.doesNotMatch(markup, /\{\{[^}]*[A-Za-z_][A-Za-z0-9_]*\(/);
  const medications = await readFile(new URL('../src/pages/patient/medications.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(medications, /\{\{[^}]*[A-Za-z_][A-Za-z0-9_]*\(/);
});

test('Demo 小程序提供四项原生底部导航并收敛病友入口', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  assert.deepEqual(app.tabBar.list.map(item => [item.pagePath, item.text]), [
    ['pages/home/index', '指标'], ['pages/patient/records', '记录'], ['pages/patient/report', '报告'], ['pages/patient/account', '个人档案'],
  ]);
  assert.ok(app.tabBar.list.every(item => item.iconPath && item.selectedIconPath), '四项导航必须提供选中与未选中图标');
  assert.equal(app.pages.includes('pages/patient/report'), true);
  assert.equal(app.pages.includes('pages/patient/trend'), true);
  assert.equal(app.pages.includes('pages/patient/peers'), false);
  const home = await readFile(new URL('../src/pages/home/index.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  assert.match(home, /navigateTo\(\{ url: '\/pages\/patient\/medications' \}/);
  assert.match(home, /navigateTo\(\{ url: '\/pages\/patient\/inbox' \}/);
  assert.doesNotMatch(home, /openPeers/);
  assert.doesNotMatch(markup, /病友与经验/);
});

test('联系人入口区分 c/s/scene 且公共短链不携带 Bearer', async () => {
  const source = await readFile(new URL('../src/pages/contact/index.ts', import.meta.url), 'utf8');
  assert.match(source, /options\.c/);
  assert.match(source, /options\.s/);
  assert.match(source, /options\.scene/);
  assert.match(source, /contact-links/);
  assert.match(source, /emergency-shares/);
  assert.match(source, /G1/);
  assert.doesNotMatch(source, /authorization:\s*`Bearer/);
});

test('微信端应急支持入口只消费经过校验的预案、急诊包、流程卡和危机联系人', async () => {
  const source = await readFile(new URL('../src/support.ts', import.meta.url), 'utf8');
  assert.match(source, /loadSupportPlan/);
  assert.match(source, /loadSupportKit/);
  assert.match(source, /loadSupportCard/);
  assert.match(source, /loadCrisisContacts/);
  assert.match(source, /recordCrisisAction/);
  assert.match(source, /makePhoneCall/);
  assert.match(source, /emergency-plan/);
  assert.match(source, /emergency-kit/);
  assert.match(source, /emergency-card/);
  assert.match(source, /crisis-page/);
  assert.match(source, /P-06-v1/);
  assert.match(source, /verificationStatus !== 'VERIFIED'/);
  assert.match(source, /patientId\(\)/);
  assert.doesNotMatch(source, /http:\/\/|https:\/\//);
});

test('私密页面在失权或身份失效后清除敏感投影、草稿与当前身份 outbox', async () => {
  const pages = {
    pregnancy: await readFile(new URL('../src/pages/patient/pregnancy.ts', import.meta.url), 'utf8'),
    emergency: await readFile(new URL('../src/pages/patient/emergency.ts', import.meta.url), 'utf8'),
    menstrual: await readFile(new URL('../src/pages/patient/menstrual.ts', import.meta.url), 'utf8'),
    medications: await readFile(new URL('../src/pages/patient/medications.ts', import.meta.url), 'utf8'),
    support: await readFile(new URL('../src/pages/patient/support.ts', import.meta.url), 'utf8'),
  };
  for (const [name, source] of Object.entries(pages)) {
    assert.match(source, /clearSensitiveState/,
      `${name} 必须定义失权清屏边界`);
    // 共享队列：本页失权只清本页操作类型，会话真正失效（本地会话已清）时才清整个身份队列。
    assert.match(source, /outbox\?\.clear\(deniedOperations\(\[[^\]]+\], Boolean\(session\(\)\)\)\)/,
      `${name} 必须按本页操作类型清除当前身份待提交队列`);
    assert.match(source, /\[401, 403\]/,
      `${name} 必须识别 401/403 失权`);
  }
  assert.match(pages.pregnancy, /status:\s*null/);
  assert.match(pages.pregnancy, /questions:\s*null/);
  assert.match(pages.emergency, /plan:\s*null/);
  assert.match(pages.emergency, /kit:\s*null/);
  assert.match(pages.emergency, /card:\s*null/);
  assert.match(pages.menstrual, /cycle:\s*null/);
  assert.match(pages.medications, /overview:\s*null/);
  assert.match(pages.medications, /sideEffects:\s*\[\]/);
  assert.match(pages.medications, /screenings:\s*\[\]/);
  assert.match(pages.medications, /scopeKey:\s*''/);
  assert.match(pages.support, /draft:\s*''/);
  assert.match(pages.support, /messages:\s*\[\]/);
  assert.match(pages.support, /clearPending\(\)/);
});

test('正式微信端应急中心覆盖预案、急诊包、流程卡和 G2 分享，并复用隔离 outbox', async () => {
  const page = await readFile(new URL('../src/pages/patient/emergency.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/patient/emergency.wxml', import.meta.url), 'utf8');
  const outbox = await readFile(new URL('../src/mutation-outbox.ts', import.meta.url), 'utf8');
  const support = await readFile(new URL('../src/support.ts', import.meta.url), 'utf8');
  assert.match(page, /mutateSupportPlan/);
  assert.match(page, /mutateSupportKit/);
  assert.match(page, /mutateSupportCard/);
  assert.match(page, /createSupportShare/);
  assert.match(page, /pages\/contact\/index\?s=/);
  assert.match(page, /openShare/);
  assert.match(page, /newIdempotencyKey\(PLAN_OP\)/);
  assert.match(page, /newIdempotencyKey\(KIT_OP\)/);
  assert.match(page, /newIdempotencyKey\(CARD_OP\)/);
  assert.match(page, /newIdempotencyKey\(SHARE_OP\)/);
  assert.match(page, /sameScope/);
  assert.match(support, /G2_SUMMARY/);
  assert.match(markup, /家庭应急预案/);
  assert.match(markup, /急诊包/);
  assert.match(markup, /应急流程卡/);
  assert.match(markup, /分享简化应急卡/);
  assert.match(outbox, /EMERGENCY_PLAN/);
  assert.match(outbox, /EMERGENCY_KIT/);
  assert.match(outbox, /EMERGENCY_CARD/);
  assert.match(outbox, /EMERGENCY_SHARE/);
});

test('危机拨号先完成服务端动作核验，失败时清空旧联系方式', async () => {
  const source = await readFile(new URL('../src/pages/patient/support.ts', import.meta.url), 'utf8');
  const click = source.slice(source.indexOf('async callCrisis'));
  assert.ok(click.indexOf('recordCrisisAction') >= 0);
  assert.ok(click.indexOf('makePhoneCall') > click.indexOf('recordCrisisAction'));
  assert.match(click, /crisis:\s*null/);
});

test('复诊前筛查只提交服务端题面与固定答案，并通过隔离 outbox 恢复', async () => {
  const page = await readFile(new URL('../src/pages/patient/screening.ts', import.meta.url), 'utf8');
  assert.match(page, /psych-screening-form/);
  assert.match(page, /psych-screenings/);
  assert.match(page, /PSYCH_SCREENING/);
  assert.match(page, /prescreenWindow/);
  assert.match(page, /respondentRelation/);
  assert.match(page, /sameScope/);
  assert.match(page, /已留在本机/);
  const wxml = await readFile(new URL('../src/pages/patient/screening.wxml', import.meta.url), 'utf8');
  assert.match(wxml, /仅用于复诊沟通，每题都可以选择“不想回答”/);
  // 患者端不得出现量表名、分数或危险等级 —— 也不得出现具体危机条目。
  assert.doesNotMatch(wxml, /riskLevel|crisisItemCodes|SELF_HARM|PHQ|C-SSRS/);
  // 但危机处置**路径**必须存在：设计原则 3「筛查阳性必须有下一步」，
  // 「出现自伤意念 → 立即升级，不走常规路径」。这里只放行一个不含任何
  // 条目信息的处置入口，患者仍看不到自己被判了什么。
  assert.match(wxml, /crisisSupport/, '命中危机条目时必须给出可联系的人，不能只有一句已提交');
  assert.match(wxml, /系统不会替你联系任何人/);
});

test('医生消息和健康教育支持逐条已读，失败时保留原幂等键', async () => {
  const page = await readFile(new URL('../src/pages/patient/support.ts', import.meta.url), 'utf8');
  assert.match(page, /messages\/\$\{encodeURIComponent\(target\)\}\/read/);
  assert.match(page, /education\/\$\{encodeURIComponent\(target\)\}\/read/);
  assert.match(page, /MESSAGE_READ/);
  assert.match(page, /EDUCATION_READ/);
  assert.match(page, /已留在本机/);
});

test('照护页按随访条目核对患者范围，并把消息/随访详情展示给用户', async () => {
  const page = await readFile(new URL('../src/pages/patient/support.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/patient/support.wxml', import.meta.url), 'utf8');
  // followups 接口的 patientId 位于每条任务内，不能误要求响应顶层存在 patientId。
  const followupsStart = page.indexOf('function formatFollowups');
  const followupsEnd = page.indexOf('\nfunction ', followupsStart + 1);
  assert.ok(followupsStart >= 0 && followupsEnd > followupsStart, '必须截取完整随访解析函数，不能把后续教育解析混入');
  const followups = page.slice(followupsStart, followupsEnd);
  assert.match(followups, /Array\.isArray\(value\.items\)/);
  assert.match(followups, /item\.patientId !== expectedPatientId/);
  assert.doesNotMatch(followups, /value\.patientId !== expectedPatientId \|\| !Array\.isArray\(value\.items\)/);
  assert.match(followups, /stateLabels/);
  assert.match(markup, /发生时间/);
  assert.match(markup, /医生不一定实时在线/);
});

test('经期页显示阶段，并固定患者端的事实标签', async () => {
  const page = await readFile(new URL('../src/pages/patient/menstrual.ts', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../src/pages/patient/menstrual.wxml', import.meta.url), 'utf8');
  // 医生端源码属于内部仓库，公开版只校验患者端固定事实标签。
  for (const [code, label] of [['BLEEDING', '经期中'], ['RECENTLY_ENDED', '刚结束'], ['BETWEEN_PERIODS', '经期之间'], ['UNKNOWN', '未知']]) {
    assert.match(page, new RegExp(`${code}: '${label}'`), `小程序缺少 ${code} 的标签`);
  }
  // 阶段必须真的渲染出来，不能只解析不展示。
  assert.match(markup, /cycle\.phaseLabel/, '阶段没有渲染到页面上');
  assert.match(markup, /cycle\.phaseNote/);
  // 边界声明必须留在页面上：不推算排卵、不诊断、不调药。
  assert.match(markup, /不推算排卵/);
  assert.match(markup, /不自动调药/);
  // 阶段不得引入任何推断性措辞。
  assert.doesNotMatch(markup, /排卵期|易孕|周期长度|黄体|预测下次/);
});

test('首页入口文案与筛查页标题一致，不向患者暴露「心理」字样', async () => {
  const home = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');
  const screening = await readFile(new URL('../src/pages/patient/screening.wxml', import.meta.url), 'utf8');
  assert.match(home, /复诊前，还有几件小事/, '首页任务卡未与筛查页对齐');
  assert.doesNotMatch(home, /心理/, '成年端首页不得出现「心理」字样');
  assert.doesNotMatch(screening, /心理/, '筛查页不得出现「心理」字样');
  // 入口本身必须还在。
  assert.match(home, /openScreening/);
});

test('应急流程卡在患者端绑定 destination 与 canDo，不只看版本号', async () => {
  const markup = await readFile(new URL('../src/pages/patient/emergency.wxml', import.meta.url), 'utf8');
  // 「去哪里 / 到了说什么 / 联系谁 / 可以做什么」缺一不可，否则卡片无法自救。
  assert.match(markup, /card\.destination\.hospitalName/);
  assert.match(markup, /card\.destination\.triageScript/);
  assert.match(markup, /card\.destination\.followUpClinicianPhone/);
  assert.match(markup, /card\.destination\.onCallContact\.phone/);
  assert.match(markup, /card\.canDo/);
  assert.match(markup, /card\.neverDo/);
  assert.match(markup, /card\.kitLocation/);
  // 夜间入口与到院分钟数是夜间就医的关键字段。
  assert.match(markup, /card\.destination\.nightEntrance/);
  assert.match(markup, /card\.destination\.arrivalMinutesNight/);
});
