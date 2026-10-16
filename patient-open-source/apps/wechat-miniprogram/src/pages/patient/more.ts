import { ApiFailure, patientId, request, session } from '../../api';

type PanelState = 'LOADING' | 'READY' | 'UNAVAILABLE' | 'DENIED';
interface MoreSection { key: string; title: string; state: PanelState; message: string; items: string[]; }
interface Scope { userId: string; actorId: string; patientId: string; }

const LABS = new Map<string, { display: string; units: string[] }>([
  ['FERRITIN', { display: '铁蛋白', units: ['ng/mL', 'μg/L', 'ug/L', 'µg/L'] }],
  ['PLATELET', { display: '血小板计数', units: ['10^9/L', '×10⁹/L', '10*9/L'] }],
  ['AST', { display: 'AST', units: ['U/L'] }],
  ['TRIGLYCERIDE', { display: '甘油三酯', units: ['mg/dL', 'mmol/L', 'g/L'] }],
  ['FIBRINOGEN', { display: '纤维蛋白原', units: ['mg/dL', 'g/L'] }],
  ['LDH', { display: 'LDH', units: ['U/L'] }],
  ['CRP', { display: 'CRP', units: ['mg/L', 'mg/dL'] }],
  ['ESR', { display: 'ESR', units: ['mm/h'] }],
  ['D_DIMER', { display: 'D-二聚体', units: ['ug/mL FEU', 'mg/L FEU', 'μg/mL FEU'] }],
  ['SODIUM', { display: '血钠', units: ['mmol/L'] }],
  ['HEMOGLOBIN', { display: '血红蛋白', units: ['g/L', 'g/dL'] }],
  ['WBC', { display: '白细胞', units: ['10^9/L', '×10⁹/L'] }],
  ['NEUTROPHIL_PCT', { display: '中性粒细胞%', units: ['%'] }],
  ['PCT', { display: '降钙素原', units: ['ng/mL', 'ng/L'] }],
]);
const FERTILITY_SECTION_IDS = ['PRECONCEPTION', 'MEDICATIONS', 'GENETICS', 'FOLLOWUP'];
const MONITORING_INTENSITIES = ['INTENSIFIED', 'STANDARD', 'MAINTENANCE', 'REMISSION'];
const REMISSION_WATCH_STATUS = ['NONE', 'WATCHING', 'REVIEW_DUE', 'EXITED'];
const FOLLOWUP_STATES = ['OPEN', 'REMINDER_SENT', 'OVERDUE', 'ESCALATED', 'COMPLETED', 'CANCELLED'];

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 512): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now(); }
function futureOrInstant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function date(value: string): string { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function statusLabel(value: string): string { return ({ NOT_STARTED: '未开始', IN_PROGRESS: '进行中', COMPLETED: '已完成', DRAFT: '草稿', PREPARING: '准备中', REFERRAL_SENT: '转介已发出', ACCEPTED: '已接收', DECLINED_BY_PATIENT: '暂不转介', CONSIDERING: '考虑中', PLANNING: '计划中', PREGNANT: '妊娠中', POSTPARTUM: '产后', NONE: '未提供', OPEN: '待完成', REMINDER_SENT: '已提醒', OVERDUE: '已逾期', ESCALATED: '已升级', CANCELLED: '已取消', FULL: '基本都能做', LIMITED: '有些事情费劲', SEVERE: '很多事情做不了', WORK_DISCLOSURE: '沟通与披露', FATIGUE_MGMT: '疲劳管理', WORK_RETURN: '回到工作', OPENED: '已开始' } as Record<string, string>)[value] ?? value; }
function scopeNow(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(scope: Scope): boolean { const latest = scopeNow(); return Boolean(latest && latest.userId === scope.userId && latest.actorId === scope.actorId && latest.patientId === scope.patientId); }
function section(key: string, title: string): MoreSection { return { key, title, state: 'LOADING', message: '读取中…', items: [] }; }
function unavailable(key: string, title: string, error: unknown): MoreSection {
  const message = error instanceof Error ? error.message : '当前暂不可用。';
  if (error instanceof ApiFailure && [401, 403].includes(error.status)) return { key, title, state: 'DENIED', message, items: [] };
  return { key, title, state: 'UNAVAILABLE', message, items: [] };
}

interface LabRecord { id: string; display: string; value: number; unit: string; observedAt: string; recordedAt: string; recordedBy: string; }
function parseLabPage(value: unknown, id: string): { records: LabRecord[]; nextCursor?: string } {
  if (!object(value) || !only(value, ['patientId', 'records', 'nextCursor']) || value.patientId !== id || !Array.isArray(value.records) || value.records.length > 100) throw new Error('化验历史响应格式无效。');
  const records = value.records.map(item => {
    if (!object(item) || !only(item, ['id', 'patientId', 'code', 'display', 'valueNumeric', 'unit', 'observedAt', 'recordedAt', 'source', 'recordedBy']) || item.patientId !== id || !text(item.id, 200) || item.source !== 'LAB' || !text(item.recordedBy, 200) || typeof item.valueNumeric !== 'number' || !Number.isFinite(item.valueNumeric) || !instant(item.observedAt) || !instant(item.recordedAt)) throw new Error('化验记录格式无效。');
    const definition = LABS.get(String(item.code));
    if (!definition || item.display !== definition.display || typeof item.unit !== 'string' || !definition.units.includes(item.unit)) throw new Error('化验指标或单位未通过白名单校验。');
    return { id: item.id, display: item.display, value: item.valueNumeric, unit: item.unit, observedAt: item.observedAt, recordedAt: item.recordedAt, recordedBy: item.recordedBy };
  });
  if (value.nextCursor !== undefined && !text(value.nextCursor, 512)) throw new Error('化验历史分页游标无效。');
  return { records, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) };
}
async function loadLabs(id: string): Promise<string[]> {
  const records = new Map<string, LabRecord>(); const cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = cursor ? `source=LAB&limit=100&after=${encodeURIComponent(cursor)}` : 'source=LAB&limit=100';
    const data = parseLabPage(await request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/observations?${query}`), id);
    for (const item of data.records) { const previous = records.get(item.id); if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('化验历史分页重复记录不一致。'); records.set(item.id, item); }
    if (!data.nextCursor) return [...records.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id)).map(item => `${item.display}：${item.value} ${item.unit} · 发生 ${date(item.observedAt)} · 录入 ${date(item.recordedAt)}`);
    if (cursors.has(data.nextCursor) || data.nextCursor === cursor) throw new Error('化验历史分页游标未推进。'); cursors.add(data.nextCursor); cursor = data.nextCursor;
  }
  throw new Error('化验历史超过安全读取上限。');
}

function parseFertility(value: unknown, id: string): string[] {
  if (!object(value) || !only(value, ['patientId', 'sex', 'mode', 'title', 'intro', 'sections', 'affectedMedications']) || value.patientId !== id || !['FEMALE', 'MALE', 'INTERSEX', 'UNKNOWN'].includes(String(value.sex)) || !['PREGNANCY', 'FERTILITY', 'GENERAL'].includes(String(value.mode)) || !text(value.title, 200) || !text(value.intro, 1000) || !Array.isArray(value.sections) || value.sections.length > 4 || !Array.isArray(value.affectedMedications) || value.affectedMedications.length > 50 || !value.affectedMedications.every(item => text(item, 200))) throw new Error('生育内容响应格式无效。');
  const sectionIds = new Set<string>(); const lines = [String(value.title), String(value.intro)]; for (const sectionValue of value.sections) { if (!object(sectionValue) || !only(sectionValue, ['id', 'title', 'items']) || !text(sectionValue.id, 100) || !FERTILITY_SECTION_IDS.includes(String(sectionValue.id)) || sectionIds.has(String(sectionValue.id)) || !text(sectionValue.title, 200) || !Array.isArray(sectionValue.items) || sectionValue.items.length > 20 || !sectionValue.items.every(item => text(item, 500))) throw new Error('生育内容分段格式无效。'); sectionIds.add(String(sectionValue.id)); lines.push(sectionValue.title, ...sectionValue.items.map(item => `• ${item}`)); } if (value.affectedMedications.length) lines.push(`需要和医生核对的用药：${value.affectedMedications.join('、')}`); return lines;
}
export function parseMonitoringIntensity(value: unknown, id: string): string[] {
  if (!object(value) || !only(value, ['patientId', 'intensity', 'setAt', 'reason', 'reviewAt', 'autoRaisedUntil', 'version', 'history']) || value.patientId !== id || !MONITORING_INTENSITIES.includes(String(value.intensity)) || !instant(value.setAt) || !text(value.reason, 500) || !integer(value.version) || !Array.isArray(value.history) || value.history.length > 100 || value.history.length > value.version) throw new Error('监测强度响应格式无效。');
  if (value.reviewAt !== undefined && !futureOrInstant(value.reviewAt)) throw new Error('监测强度复核时间无效。');
  if (value.autoRaisedUntil !== undefined && !futureOrInstant(value.autoRaisedUntil)) throw new Error('临时加强监测到期时间无效。');
  const history = value.history.map(item => {
    if (!object(item) || !only(item, ['from', 'to', 'reason', 'at']) || !MONITORING_INTENSITIES.includes(String(item.to)) || item.from !== undefined && !MONITORING_INTENSITIES.includes(String(item.from)) || !text(item.reason, 500) || !instant(item.at)) throw new Error('监测强度历史格式无效。');
    return item;
  });
  const current = `当前档位：${monitoringLabel(String(value.intensity))}`;
  const reason = `最近设置：${String(value.reason)}（${date(value.setAt)}）`;
  const review = value.reviewAt ? `复核时间：${date(String(value.reviewAt))}` : '尚未设置复核时间。';
  const temporary = value.autoRaisedUntil ? `临时加强监测至：${date(String(value.autoRaisedUntil))}` : '';
  return [current, reason, review, ...(temporary ? [temporary] : []), `已有 ${history.length} 次档位记录。`, '监测档位由医生维护，页面不会自行修改，也不会因为缓解期隐藏记录。'];
}

function parseRemission(value: unknown, id: string): string[] {
  if (!object(value) || !only(value, ['patientId', 'active', 'version', 'state', 'watchStatus', 'recordEnabled', 'trendEnabled', 'trend', 'notice', 'followup']) || value.patientId !== id || typeof value.active !== 'boolean' || !integer(value.version) || !REMISSION_WATCH_STATUS.includes(String(value.watchStatus)) || value.recordEnabled !== true || value.trendEnabled !== true || !Array.isArray(value.trend) || value.trend.length > 30 || !text(value.notice, 1000)) throw new Error('缓解期响应格式无效。');
  if (value.state !== null) {
    if (!object(value.state) || !only(value.state, ['patientId', 'active', 'enteredAt', 'relapseWatchUntil', 'drugStops', 'followupIntervalMonths', 'version', 'exitedAt', 'exitReason', 'history']) || value.state.patientId !== id || typeof value.state.active !== 'boolean' || !instant(value.state.enteredAt) || !futureOrInstant(value.state.relapseWatchUntil) || !Array.isArray(value.state.drugStops) || value.state.drugStops.length > 50 || !integer(value.state.followupIntervalMonths, 1, 24) || !integer(value.state.version, 1) || !Array.isArray(value.state.history) || value.state.history.length !== value.state.version || value.state.exitedAt !== undefined && !instant(value.state.exitedAt) || value.state.exitReason !== undefined && !text(value.state.exitReason, 500)) throw new Error('缓解期状态格式无效。');
    for (const stop of value.state.drugStops) if (!object(stop) || !only(stop, ['drug', 'stoppedAt']) || !text(stop.drug, 200) || !instant(stop.stoppedAt)) throw new Error('停药事实格式无效。');
    for (const item of value.state.history) if (!object(item) || !only(item, ['operation', 'at', 'reason', 'drug', 'stoppedAt']) || !['ENTER', 'RECORD_STOP', 'EXIT'].includes(String(item.operation)) || !instant(item.at) || item.reason !== undefined && !text(item.reason, 500) || item.drug !== undefined && !text(item.drug, 200) || item.stoppedAt !== undefined && !instant(item.stoppedAt)) throw new Error('缓解期历史格式无效。');
  }
  for (const point of value.trend) if (!object(point) || !only(point, ['code', 'observedAt', 'unit', 'valueNumeric', 'valueText', 'valueCoded']) || !text(point.code, 100) || !instant(point.observedAt) || !text(point.unit, 100) || point.valueNumeric !== undefined && (typeof point.valueNumeric !== 'number' || !Number.isFinite(point.valueNumeric)) || point.valueText !== undefined && !text(point.valueText, 500) || point.valueCoded !== undefined && !text(point.valueCoded, 200)) throw new Error('缓解期趋势格式无效。');
  if (value.followup !== null && (!object(value.followup) || !only(value.followup, ['id', 'dueAt', 'state', 'version']) || !text(value.followup.id, 200) || !futureOrInstant(value.followup.dueAt) || !FOLLOWUP_STATES.includes(String(value.followup.state)) || !integer(value.followup.version, 1))) throw new Error('缓解期随访任务格式无效。');
  const status = value.active ? (value.watchStatus === 'REVIEW_DUE' ? '复发监测窗口已到复核时间' : '缓解期监测中') : '当前不在缓解期';
  const followup = value.followup ? `低扰随访：${date(String(value.followup.dueAt))} · ${statusLabel(String(value.followup.state))}` : '暂无缓解期随访任务。';
  return [status, String(value.notice), followup, `已保留 ${value.trend.length} 条趋势记录；页面不会自动结束缓解或调整用药。`];
}

function monitoringLabel(value: string): string { return ({ INTENSIFIED: '临时加强', STANDARD: '标准', MAINTENANCE: '维持', REMISSION: '缓解期' } as Record<string, string>)[value] ?? value; }
type PatientSex = 'FEMALE' | 'MALE' | 'INTERSEX' | 'UNKNOWN';
type LifeStage = 'CHILD' | 'TRANSITION' | 'ADULT' | 'UNKNOWN';
interface SummaryProfile { sex: PatientSex; lifeStage: LifeStage; }
function summaryProfile(value: unknown, id: string): SummaryProfile {
  if (!object(value) || value.patientId !== id) return { sex: 'UNKNOWN', lifeStage: 'UNKNOWN' };
  const sex = ['FEMALE', 'MALE', 'INTERSEX'].includes(String(value.sex)) ? value.sex as PatientSex : 'UNKNOWN';
  const lifeStage = ['CHILD', 'TRANSITION', 'ADULT'].includes(String(value.lifeStage)) ? value.lifeStage as LifeStage : 'UNKNOWN';
  return { sex, lifeStage };
}

if (typeof Page === 'function') Page({
  data: {
    loading: true,
    error: '',
    scopeKey: '',
    sections: [] as MoreSection[],
  },
  loadGeneration: 0,
  targetSection: '',
  onLoad(options: { section?: string } = {}) { this.targetSection = options.section === 'fertility' ? 'fertility' : ''; this.onShow(); },
  onShow() {
    const current = session(); if (!current) { this.loadGeneration += 1; this.setData({ scopeKey: '', loading: false, error: '', sections: [] }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const scope = scopeNow(); if (!scope) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。', sections: [] }); return; }
    const key = `${scope.userId}:${scope.actorId}:${scope.patientId}`;
    if (key !== this.data.scopeKey) { this.setData({ scopeKey: key }); this.load(scope); }
  },
  load(scope: Scope = scopeNow() as Scope) {
    if (!scope || !sameScope(scope)) { this.setData({ loading: false, error: '身份已切换，请返回首页后重新打开。', sections: [] }); return; }
    const generation = ++this.loadGeneration;
    const id = scope.patientId;
    this.setData({ loading: true, error: '', sections: [] });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/summary`).then(value => summaryProfile(value, id)).catch(() => ({ sex: 'UNKNOWN', lifeStage: 'UNKNOWN' } as SummaryProfile)).then(profile => {
      if (generation !== this.loadGeneration || !sameScope(scope)) return;
      const { sex, lifeStage } = profile;
      const adult = lifeStage === 'ADULT';
      const keys: Array<readonly [string, string]> = [['labs', '化验历史'], ['monitoring', '监测强度'], ['remission', '缓解期与低扰随访']];
      if (adult && sex === 'MALE') keys.push(['fertility', '男性生育与用药关注']);
      this.setData({ sections: keys.map(item => section(item[0], item[1])) });
      const loaders: Array<Promise<MoreSection>> = [
        loadLabs(id).then(items => ({ key: 'labs', title: '化验历史', state: 'READY' as PanelState, message: items.length ? '' : '暂无已确认化验记录。', items })),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/monitoring-intensity`).then(value => ({ key: 'monitoring', title: '监测强度', state: 'READY' as PanelState, message: '', items: parseMonitoringIntensity(value, id) })),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/remission`).then(value => ({ key: 'remission', title: '缓解期与低扰随访', state: 'READY' as PanelState, message: '', items: parseRemission(value, id) })),
      ];
      if (adult && sex === 'MALE') loaders.push(request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/fertility-content`).then(value => ({ key: 'fertility', title: '男性生育与用药关注', state: 'READY' as PanelState, message: '', items: parseFertility(value, id) })));
      Promise.all(loaders.map((loader, index) => loader.catch(error => unavailable(keys[index]![0], keys[index]![1], error)))).then(next => {
        if (generation !== this.loadGeneration || !sameScope(scope)) return;
        this.setData({ sections: next, loading: false }, () => {
          if (this.targetSection && next.some(item => item.key === this.targetSection)) { wx.pageScrollTo({ selector: `#section-${this.targetSection}`, duration: 200 }); this.targetSection = ''; }
        });
        if (next.some(item => item.state === 'DENIED')) this.setData({ error: '部分内容当前身份不可见，页面已按服务端权限隐藏。' });
        else if (next.some(item => item.state === 'UNAVAILABLE')) this.setData({ error: '部分健康资料暂不可用，请重新读取。' });
      });
    });
  },
  refresh() { const scope = scopeNow(); if (scope) this.load(scope); },
  onUnload() { this.loadGeneration += 1; },
});
