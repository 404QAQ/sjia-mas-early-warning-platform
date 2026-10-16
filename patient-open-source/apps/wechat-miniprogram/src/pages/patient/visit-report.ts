import { patientId, request, session } from '../../api';
import { at } from '../../date-format.js';
import { displayUnit, formatMeasurement } from '../../measurement-format';
import { buildTrendChart } from '../../trend-chart';
import { symptoms } from '../../patient-records';
import { observationActionCopy } from '../../action-card-presentation';

interface ReportPoint { at: string; value: number; unit: string; label: string; height: string; }
interface ReportSeries { display: string; unit: string; latest: string; latestAt: string; change: string; direction: 'up' | 'down' | 'flat'; points: ReportPoint[]; ticks: string[]; comparable: boolean; }
interface ReportAlert { title: string; detail: string; tone: 'urgent' | 'watch' | 'normal'; }
interface ReportMedication { name: string; detail: string; status: string; sourceLabel: string; prescriptionNote: string; }
interface ReportScreening { state: 'AVAILABLE' | 'SUBMITTED' | 'UNAVAILABLE' | 'UNCONFIRMED'; title: string; detail: string; buttonText: string; }
interface ReportRecord { at: string; atText: string; code: string; display: string; sourceLabel: string; }
interface ReportView {
  patientName: string;
  asOf: string;
  asOfText: string;
  riskLabel: string;
  riskTone: 'urgent' | 'watch' | 'normal';
  actionTitle: string;
  action: string;
  series: ReportSeries[];
  trendUnavailable: boolean;
  seriesNotice: string;
  narrative: string[];
  symptoms: ReportRecord[];
  symptomsNotice: string;
  alerts: ReportAlert[];
  medications: ReportMedication[];
  medicationsNotice: string;
  screening: ReportScreening;
  recentCount: number;
  recordCountLabel: string;
  reportStatus: string;
}

type Obj = Record<string, unknown>;
function object(value: unknown): value is Obj { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value); }
function finiteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function asDateText(value: string): string { try { return at(value); } catch { return value.slice(0, 10).replace(/-/g, '/'); } }
function riskPresentation(value: unknown): { label: string; tone: ReportView['riskTone'] } {
  const key = String(value ?? '').toUpperCase();
  if (key === 'ACT_NOW') return { label: '需要立即行动', tone: 'urgent' };
  if (key === 'REVIEW') return { label: '建议复核', tone: 'watch' };
  if (key === 'OBSERVE') return { label: '按计划观察', tone: 'normal' };
  return { label: '等待更多记录', tone: 'watch' };
}
function actionLabel(value: unknown, riskLevel?: unknown): string {
  const key = String(value ?? '').toUpperCase();
  const observationCopy = observationActionCopy(key, riskLevel);
  if (observationCopy) return observationCopy.action;
  if (key === 'ACT_NOW') return '请立即联系照护团队；如果出现明显不适或无法联系，请按家庭应急预案前往急诊。';
  if (key === 'REVIEW') return '请在 24 小时内联系医生，并提供最近记录与趋势。';
  return '行动建议暂不可用，请刷新核对；如有明显不适，请及时联系照护团队。';
}

function parseTrend(value: unknown, expectedId: string): { patientName: string; asOf: string; series: Obj[]; narrative: string[]; card: Obj } {
  if (!object(value) || value.patientId !== expectedId || !text(value.asOf, 100) || !Number.isFinite(Date.parse(value.asOf)) || !Array.isArray(value.series) || !Array.isArray(value.narrative) || !object(value.decisionCard)) throw new Error('趋势报告响应格式无效。');
  const series = value.series.filter(object).map(item => {
    if (!text(item.display, 120) || !text(item.unit, 40) || !Array.isArray(item.points)) throw new Error('趋势指标格式无效。');
    const points = item.points.filter(object);
    if (!points.every(point => text(point.at, 100) && Number.isFinite(Date.parse(point.at)) && finiteNumber(point.value) && text(point.unit, 40))) throw new Error('趋势数据点格式无效。');
    return { ...item, points };
  });
  return { patientName: text(value.patientDisplayName, 100) ? value.patientDisplayName : '当前患者', asOf: value.asOf, series, narrative: value.narrative.filter(item => text(item, 500)), card: value.decisionCard };
}
function parseSummary(value: unknown, expectedId: string): { patientName: string; alerts: Obj[]; recentCount: number } | null {
  if (!object(value) || value.patientId !== expectedId) return null;
  const alerts = Array.isArray(value.alerts) ? value.alerts.filter(object) : [];
  return { patientName: text(value.patientDisplayName, 100) ? value.patientDisplayName : '当前患者', alerts, recentCount: finiteNumber(value.observationsCount) ? Math.max(0, Math.floor(value.observationsCount)) : 0 };
}
function parseVisit(value: unknown, expectedId: string): { asOf?: string; narrative: string[]; medications: Obj[]; recentCount: number; records: ReportRecord[] | null; actionLevel: unknown } | null {
  if (!object(value) || value.patientId !== expectedId) return null;
  const trend = object(value.trend) ? value.trend : {};
  const sourceLabels: Record<string, string> = { CAREGIVER_REPORTED: '家属代录', PATIENT_REPORTED: '本人记录', CLINIC: '门诊记录', LAB: '检验记录', DEVICE: '设备记录' };
  const records = Array.isArray(value.recentRecords) ? value.recentRecords.filter(object)
    .filter(item => text(item.at, 100) && Number.isFinite(Date.parse(item.at)) && text(item.code, 120) && text(item.display, 200))
    .map(item => ({ at: String(item.at), atText: asDateText(String(item.at)), code: String(item.code), display: String(item.code).startsWith('SYMPTOM_') ? symptoms.find(symptom => `SYMPTOM_${symptom.code}` === item.code)?.label ?? (String(item.display).startsWith('SYMPTOM_') ? '症状记录（待核对）' : String(item.display)) : String(item.display), sourceLabel: sourceLabels[String(item.source)] ?? '来源待核对' }))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)) : null;
  return { asOf: text(value.asOf, 100) && Number.isFinite(Date.parse(value.asOf)) ? value.asOf : undefined, actionLevel: trend.actionLevel, narrative: Array.isArray(trend.narrative) ? trend.narrative.filter(item => text(item, 500)) : [], medications: Array.isArray(value.medications) ? value.medications.filter(object) : [], recentCount: records?.length ?? 0, records };
}
function parseMedications(value: unknown, expectedId: string): Obj[] | null {
  if (!object(value) || value.patientId !== expectedId || !Array.isArray(value.plans) || !value.plans.every(item => object(item) && (item.patientId === undefined || item.patientId === expectedId))) return null;
  return value.plans as Obj[];
}
function screeningPreparation(value: unknown, expectedId: string): ReportScreening {
  const unconfirmed: ReportScreening = { state: 'UNCONFIRMED', title: '复诊前事项', detail: '填写状态暂未确认，可以打开查看。', buttonText: '查看' };
  if (!object(value) || value.patientId !== expectedId || !Array.isArray(value.visits)) return unconfirmed;
  const visits = value.visits.filter(object);
  if (visits.length !== value.visits.length || !visits.every(visit => text(visit.id, 200) && text(visit.startsAt, 100) && Number.isFinite(Date.parse(visit.startsAt)) && ['PENDING', 'AVAILABLE', 'SUBMITTED', 'EXPIRED'].includes(String(visit.status)) && (visit.expiresAt === undefined || text(visit.expiresAt, 100) && Number.isFinite(Date.parse(visit.expiresAt))))) return unconfirmed;
  if (visits.some(visit => visit.status === 'AVAILABLE' && (visit.expiresAt === undefined || Date.parse(String(visit.expiresAt)) > Date.now()))) return { state: 'AVAILABLE', title: '复诊前事项', detail: '还有一项待填写，帮助医生了解最近的状态。', buttonText: '去填写' };
  if (visits.some(visit => visit.status === 'SUBMITTED')) return { state: 'SUBMITTED', title: '复诊前事项 · 已完成', detail: '本次已提交，复诊时可和医生一起确认近况。', buttonText: '查看' };
  return { state: 'UNAVAILABLE', title: '复诊前事项', detail: '当前没有开放的填写窗口，可以查看复诊安排。', buttonText: '查看' };
}

/** 只为与实际趋势最新值一致、且缺少单位的摘要补上单位，不换算或改写原始数值。 */
function formatNarrative(rows: string[], series: Obj[]): string[] {
  return rows.map(line => series.reduce((current, item) => {
    const latest = Array.isArray(item.points) ? item.points.at(-1) : undefined;
    if (!text(item.display, 120) || !object(latest) || !finiteNumber(latest.value)) return current;
    const unit = text(latest.unit, 40) ? latest.unit : text(item.unit, 40) ? item.unit : '';
    if (!unit) return current;
    const prefix = `${item.display}最近记录为 ${latest.value}`;
    if (!current.startsWith(prefix) || !['', '，', '。'].includes(current.slice(prefix.length, prefix.length + 1))) return current;
    return `${item.display}最近记录为 ${formatMeasurement(latest.value, unit)}${current.slice(prefix.length)}`;
  }, line));
}
function formatMedication(item: Obj, asOf?: string): ReportMedication {
  const name = text(item.drug, 120) ? item.drug : text(item.name, 120) ? item.name : '当前用药';
  const routeLabels: Record<string, string> = { ORAL: '口服', SC_INJECTION: '皮下注射' };
  const frequencyLabels: Record<string, string> = { DAILY: '每日', WEEKLY: '每周', EVERY_4_WEEKS: '每 4 周', AS_NEEDED: '按需' };
  const route = text(item.route, 60) ? routeLabels[item.route] ?? '按医嘱给药' : '';
  const frequency = text(item.frequency, 120) ? frequencyLabels[item.frequency] ?? '按计划' : '按计划';
  const statusKey = String(item.status ?? '').toUpperCase();
  const at = asOf && Number.isFinite(Date.parse(asOf)) ? Date.parse(asOf) : null;
  const notStarted = at !== null && text(item.startedAt, 100) && Number.isFinite(Date.parse(item.startedAt)) && Date.parse(item.startedAt) > at;
  const schedule = Array.isArray(item.schedule) && item.schedule.every(point => object(point) && text(point.effectiveFrom, 100) && Number.isFinite(Date.parse(point.effectiveFrom)) && finiteNumber(point.plannedDose) && point.plannedDose > 0) ? item.schedule as Obj[] : null;
  const current = at !== null && schedule ? schedule.filter(point => Date.parse(String(point.effectiveFrom)) <= at).sort((a, b) => Date.parse(String(a.effectiveFrom)) - Date.parse(String(b.effectiveFrom))).at(-1) : undefined;
  const dose = notStarted ? '尚未开始' : current && finiteNumber(current.plannedDose) && text(item.unit, 40) ? formatMeasurement(current.plannedDose, item.unit) : item.schedule !== undefined ? '剂量待核对' : finiteNumber(item.dose) && text(item.unit, 40) ? `计划 ${formatMeasurement(item.dose, item.unit)}` : '';
  const sourceLabel = item.source === 'PATIENT_REPORTED' ? '自行录入 · 待核对' : item.source === undefined || item.source === 'CLINICIAN' ? '医生计划' : '来源待核对';
  return { name, detail: [dose, route, frequency].filter(Boolean).join(' · '), sourceLabel, prescriptionNote: text(item.prescriptionNote, 500) ? item.prescriptionNote : '', status: statusKey === 'ACTIVE' ? notStarted ? '尚未开始' : '进行中' : statusKey === 'PAUSED' ? '已暂停' : statusKey === 'STOPPED' ? '已停止' : '待复核' };
}
function formatAlert(item: Obj): ReportAlert {
  const risk = riskPresentation(item.actionLevel);
  const observationCopy = observationActionCopy(item.actionLevel, item.riskLevel);
  const title = observationCopy?.title ?? (text(item.title, 120) ? item.title : risk.label);
  const detail = text(item.actionLevel, 120) ? actionLabel(item.actionLevel, item.riskLevel) : '请打开趋势并按提示处理';
  return { title, detail, tone: risk.tone };
}
function buildSeries(rows: Obj[]): ReportSeries[] {
  return rows.slice(0, 3).map(row => {
    const rawPoints = (Array.isArray(row.points) ? row.points : []).filter(object).filter(point => text(point.at, 100) && finiteNumber(point.value))
      .map(point => ({ at: String(point.at), value: Number(point.value), unit: text(point.unit, 40) ? point.unit : String(row.unit ?? '') }));
    const chart = buildTrendChart(rawPoints, String(row.unit ?? ''), row.code === 'TEMP' || row.display === '体温');
    const points = chart.points.map(point => ({ ...point, height: `${point.height}%` }));
    const values = points.map(point => point.value);
    const first = values[0]; const last = values.at(-1); const delta = first !== undefined && last !== undefined ? last - first : 0;
    const direction: ReportSeries['direction'] = Math.abs(delta) < 0.001 ? 'flat' : delta > 0 ? 'up' : 'down';
    const sign = delta > 0 ? '+' : '';
    const unit = text(row.unit, 40) ? row.unit : '';
    return { display: text(row.display, 120) ? row.display : '指标', unit: displayUnit(unit), latest: last === undefined ? '暂无记录' : formatMeasurement(last, points.at(-1)?.unit || unit), latestAt: points.length ? asDateText(points[points.length - 1]!.at) : '', change: values.length > 1 && chart.comparable ? formatMeasurement(`${sign}${delta.toFixed(1)}`, unit) : '—', direction: chart.comparable ? direction : 'flat', points, ticks: chart.ticks, comparable: chart.comparable };
  });
}

Page({
  data: {
    loading: true,
    error: '',
    report: null as ReportView | null,
  },
  scopeKey: '',
  loadGeneration: 0,
  onLoad() { this.onShow(); },
  onShow() {
    const current = session(); const id = patientId();
    if (!current || !id) { this.scopeKey = ''; this.loadGeneration += 1; this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。', report: null }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const key = `${current.userId}:${current.actorId}:${id}`;
    if (key !== this.scopeKey) this.setData({ report: null, error: '' });
    this.scopeKey = key;
    void this.load(id, key);
  },
  async load(id: string, expectedKey: string) {
    if (!id || !expectedKey) return;
    const generation = ++this.loadGeneration;
    this.setData({ loading: true, error: '' });
    const [summaryResult, trendResult, visitResult, medicationResult, screeningResult] = await Promise.allSettled([
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/summary`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/trend`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/visit-summary`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/medications`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/psych-screening-form`),
    ]);
    const current = session();
    if (generation !== this.loadGeneration || !current || patientId() !== id || `${current.userId}:${current.actorId}:${id}` !== expectedKey) return;
    try {
      const trend = trendResult.status === 'fulfilled' ? parseTrend(trendResult.value, id) : null;
      const summary = summaryResult.status === 'fulfilled' ? parseSummary(summaryResult.value, id) : null;
      const visit = visitResult.status === 'fulfilled' ? parseVisit(visitResult.value, id) : null;
      const medicationRows = medicationResult.status === 'fulfilled' ? parseMedications(medicationResult.value, id) : null;
      if (!trend && !visit && !summary) throw new Error('报告暂不可用，请稍后刷新。');
      const priority: Record<string, number> = { ACT_NOW: 3, REVIEW: 2, OBSERVE: 1 };
      const fallbackLevel = [visit?.actionLevel, ...(summary?.alerts ?? []).map(item => item.actionLevel)]
        .filter(value => typeof value === 'string' && value in priority)
        .sort((a, b) => (priority[String(b)] ?? 0) - (priority[String(a)] ?? 0))[0];
      const card: Obj = trend?.card ?? { actionLevel: fallbackLevel };
      const observationCopy = observationActionCopy(card.actionLevel, card.riskLevel);
      const risk = riskPresentation(card.actionLevel ?? 'UNKNOWN');
      const alerts = (summary?.alerts ?? []).slice(0, 3).map(formatAlert);
      if (!alerts.length) alerts.push({ title: observationCopy?.title ?? risk.label, detail: actionLabel(card.actionLevel, card.riskLevel), tone: risk.tone });
      const medicationAsOf = medicationRows !== null && medicationResult.status === 'fulfilled' && object(medicationResult.value) && text(medicationResult.value.asOf, 100) ? medicationResult.value.asOf : undefined;
      const medications = (medicationRows ?? visit?.medications ?? []).filter(item => item.status !== 'STOPPED').map(item => formatMedication(item, medicationAsOf));
      const asOf = trend?.asOf ?? visit?.asOf ?? new Date().toISOString();
      const symptoms = (visit?.records ?? []).filter(item => item.code.startsWith('SYMPTOM_')).slice(0, 3);
      const report: ReportView = {
        patientName: summary?.patientName ?? trend?.patientName ?? '当前患者',
        asOf,
        asOfText: asDateText(asOf),
        riskLabel: risk.label,
        riskTone: risk.tone,
        actionTitle: observationCopy?.title ?? (text(card.title, 160) ? card.title : risk.label),
        action: observationCopy?.action ?? (text(card.action, 500) ? card.action : actionLabel(card.actionLevel, card.riskLevel)),
        series: trend ? buildSeries(trend.series) : [],
        trendUnavailable: !trend,
        seriesNotice: !trend ? '指标趋势暂不可用，请重新读取后核对。' : '暂无可展示的指标记录，补充测量后会在这里更新。',
        narrative: formatNarrative((trend?.narrative.length ? trend.narrative : visit?.narrative ?? []).slice(0, 4), trend?.series ?? []),
        symptoms,
        symptomsNotice: !visit?.records ? '症状记录暂未读到，请到记录页核对。' : symptoms.length ? `摘自最近 ${visit.records.length} 条健康记录，完整信息请查看记录。` : '最近记录中未读到症状信息。未记录不代表没有症状。',
        alerts,
        medications,
        medicationsNotice: medicationRows === null ? medications.length ? '用药详情暂不可用，当前展示已读取的复诊摘要，请进入用药页核对。' : '用药详情暂不可用，尚未确认是否已有计划，请进入用药页重新读取。' : '',
        screening: screeningPreparation(screeningResult.status === 'fulfilled' ? screeningResult.value : null, id),
        recentCount: visit?.recentCount ?? summary?.recentCount ?? 0,
        recordCountLabel: visit?.records ? `最近 ${visit.recentCount} 条记录` : summary ? `累计 ${summary.recentCount} 条记录` : '记录数量待核对',
        reportStatus: '复诊摘要 · 请与医生一起确认',
      };
      this.setData({ report, error: '' });
    } catch (error) {
      this.setData({ report: null, error: error instanceof Error ? error.message : '报告读取失败，请稍后重试。' });
    } finally { this.setData({ loading: false }); }
  },
  refresh() { const id = patientId(); if (id) void this.load(id, this.scopeKey); },
  openRecords() { wx.switchTab({ url: '/pages/patient/records' }); },
  openMedications() { wx.navigateTo({ url: '/pages/patient/medications' }); },
  openScreening() { wx.navigateTo({ url: '/pages/patient/screening' }); },
  openTrend() { wx.navigateTo({ url: '/pages/patient/trend' }); },
  openEmergency() { wx.navigateTo({ url: '/pages/patient/emergency' }); },
});

export { buildSeries, riskPresentation };
