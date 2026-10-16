import { parseCareCapabilities, type CareCapabilities } from '../../care-capabilities';
import { loadAuxiliaryVitals, type ServerVital } from '../../clinical-data';
import { loadSelfFollowups, nextSelfFollowup } from '../../self-followups';
import { displayUnit, formatMeasurement } from '../../measurement-format';
import { buildTrendChart } from '../../trend-chart';
import { at as formatRecordTime } from '../../date-format';
import { observationActionCopy } from '../../action-card-presentation';
import { ApiFailure, availableActors, patientId, pushTemplate, request, requestSubscribeConsent, session, switchActor, unbindWechat, type MiniActor, type MiniSession } from '../../api';
import { ENTRY_SEX_INTENT_KEY, roleLabel, type MiniRole } from '../../config';
import { careInviteEntry, featureScopeKey, roleAllows, unavailableReason, type GatedFeature } from '../../feature-gate';

interface ActorChoice extends MiniActor {
  title: string;
  relationLabel: string;
  selected: boolean;
}

type PatientSex = 'FEMALE' | 'MALE' | 'INTERSEX' | 'UNKNOWN';
interface HomeSummary { patientDisplayName: string; sex: PatientSex; lifeStage: string; observationsCount: number; birthDate?: string; diseaseType?: string; }
interface PreVisitTask { status: 'AVAILABLE' | 'SUBMITTED'; startsAt: string; detail: string; completed: boolean; }
interface TemperaturePoint { key: string; label: string; value: string; height: number; }
interface HealthMetric { label: string; value: string; unit: string; tone: 'normal' | 'alert'; recordedAt: string; }
interface LabFinding { label: string; value: string; unit: string; direction: 'up' | 'down' | 'flat'; recordedAt: string; }
type SnapshotSource = 'LIVE' | 'PARTIAL' | 'UNAVAILABLE';
interface HomeSnapshot {
  trendAvailable: boolean;
  medicationsAvailable: boolean;
  symptomsAvailable: boolean;
  messagesAvailable: boolean;
  source: SnapshotSource;
  sourceLabel: string;
  asOf: string;
  updatedAtLabel: string;
  followUpCard: { date: string; hospital: string; doctor: string; status: string; source: 'NONE' | 'FOLLOWUP' | 'SCREENING' | 'LOCAL' };
  doctorMessage: { unread: number; title: string; body: string; time: string };
  temperatureSummary: string;
  temperatureNarrative?: string;
  temperatureRecordedAt: string;
  temperatureTrend: TemperaturePoint[];
  temperatureTicks: string[];
  temperatureComparable: boolean;
  urgentCard: { title: string; body: string; primary: string; secondary: string; tone: 'alert' | 'watch' | 'normal' | 'unavailable' };
  healthMetrics: HealthMetric[];
  dashboardMetrics?: HealthMetric[];
  vitalsNotice?: string;
  labFindings: LabFinding[];
  labAlertCount: number;
  symptomSummary: string;
  symptomUpdatedAt: string;
  medicationAdherence: number | null;
  medicationSummary: string;
  medicationTags: string[];
}

interface TrendPoint { at: string; value: number; unit: string; }
interface TrendSeries { code: string; display: string; unit: string; points: TrendPoint[]; }
interface TrendPayload {
  patientId: string;
  asOf: string;
  series: TrendSeries[];
  narrative: string[];
  decisionCard: { riskLevel: string; actionLevel: string; title: string; action: string };
}
interface MedicationTrajectory { source?: 'CLINICIAN' | 'PATIENT_REPORTED'; planId: string; drug: string; status: string; frequency: string; unit: string; points: Array<{ at: string; kind: 'PLAN' | 'ACTUAL'; plannedDose?: number; actualDose?: number; comparison: string }>; missingWindows: Array<{ dueAt: string; plannedDose: number; unit: string }>; deviation?: { direction: string; daysDeviation: number; missingDays?: number } }
interface MedicationPayload { patientId: string; asOf: string; plans: Array<{ id?: string; drug: string; status: string; source?: 'CLINICIAN' | 'PATIENT_REPORTED' }>; trajectories: MedicationTrajectory[]; }
interface MessagePayload { patientId: string; records: Array<{ message?: { title?: string; body?: string; createdAt?: string }; read?: unknown }> }
interface FollowupPayload { patientId: string; items: Array<{ title?: string; label?: string; type?: string; dueAt?: string; state?: string }> }

/**
 * 患者首页只接收服务端已经判定的安全网投影。倒计时、联系人和按钮能力
 * 都来自这份投影；页面不会根据本地的告警或「沉默时长」自行猜测安全网状态。
 */
type ContactSafetyState = 'INACTIVE' | 'COUNTDOWN' | 'NOTIFIED' | 'CONTACTED' | 'EXHAUSTED' | 'CANCELLED';
type ContactVisibility = 'G1_NOTIFY' | 'G2_SUMMARY' | 'G3_FULL';
interface ContactSafetyView {
  patientId: string;
  runId: string;
  state: ContactSafetyState;
  triggeredAt: string;
  deadlineAt: string;
  asOf: string;
  remainingSeconds?: number;
  lastRecordAt?: string;
  silentHours?: number;
  snoozedAt?: string;
  generation: number;
  contact?: { displayName: string; relation?: string; visibility?: ContactVisibility };
  canCancel: boolean;
  canSnooze: boolean;
  canSelfContact: boolean;
}

const CONTACT_SAFETY_STATES: readonly ContactSafetyState[] = ['INACTIVE', 'COUNTDOWN', 'NOTIFIED', 'CONTACTED', 'EXHAUSTED', 'CANCELLED'];

function safetyRelationLabel(value: unknown): string | undefined {
  if (!text(value, 80)) return undefined;
  const labels: Record<string, string> = {
    MOTHER: '母亲', FATHER: '父亲', PARENT: '家长', SPOUSE: '配偶',
    CAREGIVER: '照护者', FRIEND: '朋友', ROOMMATE: '室友', SIBLING: '兄弟姐妹', OTHER: '联系人',
  };
  return labels[value] ?? value;
}

function parseContactSafetyView(value: unknown, expectedPatientId: string): ContactSafetyView[] | null {
  const container = object(value) ? value : undefined;
  const rawRuns = container && Array.isArray(container.runs) ? container.runs : Array.isArray(value) ? value : null;
  // 当前接口返回单个患者投影；保留 runs 解析只是为了兼容演示包旧 API。
  const single = container && !Array.isArray(container.runs) && container.patientId === expectedPatientId ? [container] : null;
  const candidates = single ?? rawRuns;
  if (!candidates) return null;
  const containerAsOf = container && instant(container.asOf) ? container.asOf : undefined;
  const firstRunAsOf = candidates.find(item => object(item) && instant(item.asOf)) as Record<string, unknown> | undefined;
  const parsed: ContactSafetyView[] = [];
  for (const raw of candidates) {
    if (!object(raw)) return null;
    const asOf = containerAsOf ?? (instant(raw.asOf) ? raw.asOf : firstRunAsOf && instant(firstRunAsOf.asOf) ? firstRunAsOf.asOf : undefined);
    if (!asOf || raw.patientId !== expectedPatientId) return null;
    const runId = text(raw.runId, 256) ? raw.runId : raw.id;
    const state = raw.state;
    if (state === 'INACTIVE' || state === 'CONTACTED' || state === 'EXHAUSTED' || state === 'CANCELLED') continue;
    const deadlineAt = raw.deadlineAt;
    const triggeredAt = raw.triggeredAt;
    if (!text(runId, 256) || raw.patientId !== expectedPatientId || !CONTACT_SAFETY_STATES.includes(state as ContactSafetyState) ||
      !instant(triggeredAt) || !instant(deadlineAt)) return null;
    const contactValue = object(raw.contact) ? raw.contact : object(raw.currentContact) ? raw.currentContact : undefined;
    let contact: ContactSafetyView['contact'];
    if (contactValue) {
      if (!text(contactValue.displayName, 200) || (contactValue.visibility !== undefined && !['G1_NOTIFY', 'G2_SUMMARY', 'G3_FULL'].includes(String(contactValue.visibility)))) return null;
      contact = {
        displayName: contactValue.displayName,
        ...(safetyRelationLabel(contactValue.relation) ? { relation: safetyRelationLabel(contactValue.relation) } : {}),
        ...(contactValue.visibility === undefined ? {} : { visibility: contactValue.visibility as ContactVisibility }),
      };
    }
    if (raw.lastRecordAt !== undefined && raw.lastRecordAt !== null && !instant(raw.lastRecordAt)) return null;
    if (raw.remainingSeconds !== undefined && raw.remainingSeconds !== null && (!Number.isSafeInteger(raw.remainingSeconds) || Number(raw.remainingSeconds) < 0 || Number(raw.remainingSeconds) > 3153600000)) return null;
    if (raw.silentHours !== undefined && raw.silentHours !== null && (typeof raw.silentHours !== 'number' || !Number.isFinite(raw.silentHours) || raw.silentHours < 0 || raw.silentHours > 10000)) return null;
    if (raw.snoozedAt !== undefined && raw.snoozedAt !== null && !instant(raw.snoozedAt)) return null;
    if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1) return null;
    const bool = (key: string, fallback: boolean): boolean => raw[key] === undefined ? fallback : raw[key] === true;
    parsed.push({
      patientId: expectedPatientId, runId, state: state as ContactSafetyState, triggeredAt, deadlineAt, asOf,
      ...(raw.remainingSeconds === undefined || raw.remainingSeconds === null ? {} : { remainingSeconds: Number(raw.remainingSeconds) }),
      ...(raw.lastRecordAt === undefined || raw.lastRecordAt === null ? {} : { lastRecordAt: raw.lastRecordAt }),
      ...(raw.silentHours === undefined || raw.silentHours === null ? {} : { silentHours: raw.silentHours }),
      ...(raw.snoozedAt === undefined || raw.snoozedAt === null ? {} : { snoozedAt: raw.snoozedAt }),
      generation: Number(raw.generation),
      ...(contact ? { contact } : {}),
      canCancel: bool('canCancel', state === 'COUNTDOWN' || state === 'NOTIFIED'),
      canSnooze: bool('canSnooze', state === 'COUNTDOWN' && (raw.snoozedAt === undefined || raw.snoozedAt === null)),
      canSelfContact: bool('canSelfContact', state === 'COUNTDOWN' || state === 'NOTIFIED'),
    });
  }
  return parsed.sort((left, right) => Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt));
}

function safetyHeading(view: ContactSafetyView): string {
  return view.state === 'COUNTDOWN' ? '我们即将联系你的紧急联系人' : view.state === 'NOTIFIED' ? '正在联系你的紧急联系人' : '紧急联系人安全网';
}

function formatSafetyCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function emptyHomeSnapshot(): HomeSnapshot {
  return {
    trendAvailable: false, medicationsAvailable: false, symptomsAvailable: false, messagesAvailable: false,
    source: 'UNAVAILABLE', sourceLabel: '正在同步当前档案', asOf: '', updatedAtLabel: '尚未同步',
    followUpCard: { date: '暂无已确认日期', hospital: '可先记下医院预约日期，复诊时核对', doctor: '', status: '待安排', source: 'NONE' },
    doctorMessage: { unread: 0, title: '暂无医生消息', body: '医生发来的消息会显示在这里。', time: '' },
    temperatureSummary: '暂无体温趋势，记录后会在这里更新。', temperatureRecordedAt: '', temperatureTrend: [], temperatureTicks: [], temperatureComparable: true,
    urgentCard: { title: '暂无行动卡', body: '读取当前档案的趋势后展示照护指引。', primary: '查看详细趋势', secondary: '急诊须知', tone: 'unavailable' },
    healthMetrics: [], labFindings: [], labAlertCount: 0,
    symptomSummary: '暂无症状记录', symptomUpdatedAt: '',
    medicationAdherence: null, medicationSummary: '暂无用药记录', medicationTags: [],
  };
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 2000): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function messageBody(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 20000 && !/\0/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function formatSnapshotTime(value: string): string { const date = new Date(Date.parse(value) + 8 * 3600000); return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`; }
function displaySource(source: SnapshotSource): string { return source === 'LIVE' ? '已同步当前档案' : source === 'PARTIAL' ? '部分内容暂未同步' : '暂时无法同步'; }

// 导航是产品结构的一部分，不能因为生命阶段变化而改变页面含义。
// 阶段差异放在首页状态卡和个人档案里，底部四项保持稳定，用户才不会迷路。
const TAB_BAR_LABELS = ['指标', '记录', '报告', '个人档案'] as const;

function updateTabBar(): void {
  TAB_BAR_LABELS.forEach((text, index) => wx.setTabBarItem?.({ index, text }));
}

function parseSummary(value: unknown, expectedPatientId: string): HomeSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('当前档案暂不可用。');
  const item = value as Record<string, unknown>;
  if (item.patientId !== expectedPatientId || typeof item.patientDisplayName !== 'string' || !item.patientDisplayName.trim() ||
    !['CHILD', 'TRANSITION', 'ADULT'].includes(String(item.lifeStage)) || !Number.isSafeInteger(item.observationsCount) || Number(item.observationsCount) < 0) throw new Error('当前档案响应格式无效。');
  const sex = ['FEMALE', 'MALE', 'INTERSEX'].includes(String(item.sex)) ? item.sex as PatientSex : 'UNKNOWN';
  return { patientDisplayName: item.patientDisplayName, sex, lifeStage: String(item.lifeStage), observationsCount: Number(item.observationsCount), ...(typeof item.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.birthDate) ? { birthDate: item.birthDate } : {}), ...(item.diseaseType === 'sJIA' || item.diseaseType === 'AOSD' ? { diseaseType: item.diseaseType } : {}) };
}

function parseTrend(value: unknown, expectedPatientId: string): TrendPayload | null {
  if (!object(value) || value.patientId !== expectedPatientId || !instant(value.asOf) || !Array.isArray(value.series) || !Array.isArray(value.narrative) || !object(value.decisionCard)) return null;
  const series: TrendSeries[] = [];
  for (const candidate of value.series) {
    if (!object(candidate) || !text(candidate.code, 80) || !text(candidate.display, 200) || !text(candidate.unit, 80) || !Array.isArray(candidate.points)) return null;
    const points: TrendPoint[] = [];
    for (const point of candidate.points) {
      if (!object(point) || !instant(point.at) || typeof point.value !== 'number' || !Number.isFinite(point.value) || !text(point.unit, 80)) return null;
      points.push({ at: point.at, value: point.value, unit: point.unit });
    }
    series.push({ code: candidate.code, display: candidate.display, unit: candidate.unit, points });
  }
  const card = value.decisionCard;
  if (!text(card.title, 500) || !text(card.action, 2000) || !text(card.actionLevel, 80) || !text(card.riskLevel, 80)) return null;
  const narrative = value.narrative.filter((item): item is string => text(item, 1000)).slice(0, 5);
  return { patientId: expectedPatientId, asOf: value.asOf, series, narrative, decisionCard: { riskLevel: card.riskLevel, actionLevel: card.actionLevel, title: card.title, action: card.action } };
}

function parseMedication(value: unknown, expectedPatientId: string): MedicationPayload | null {
  if (!object(value) || value.patientId !== expectedPatientId || !instant(value.asOf) || !Array.isArray(value.plans) || !Array.isArray(value.trajectories)) return null;
  const plans = value.plans.filter((item): item is MedicationPayload['plans'][number] => object(item) && text(item.drug, 300) && text(item.status, 40) && (item.source === undefined || item.source === 'CLINICIAN' || item.source === 'PATIENT_REPORTED') && (item.source !== 'PATIENT_REPORTED' || text(item.id, 256)));
  if (plans.length !== value.plans.length) return null;
  const trajectories: MedicationTrajectory[] = [];
  for (const candidate of value.trajectories) {
    if (object(candidate) && candidate.source !== undefined && candidate.source !== 'CLINICIAN' && candidate.source !== 'PATIENT_REPORTED') return null;
    if (!object(candidate) || !text(candidate.planId, 256) || !text(candidate.drug, 300) || !text(candidate.status, 40) || !text(candidate.frequency, 40) || !text(candidate.unit, 80) || !Array.isArray(candidate.points) || !Array.isArray(candidate.missingWindows)) return null;
    const points = candidate.points.filter((point): point is MedicationTrajectory['points'][number] => object(point) && instant(point.at) && (point.kind === 'PLAN' || point.kind === 'ACTUAL') && text(point.comparison, 40) && (point.plannedDose === undefined || typeof point.plannedDose === 'number' && Number.isFinite(point.plannedDose)) && (point.actualDose === undefined || typeof point.actualDose === 'number' && Number.isFinite(point.actualDose)));
    const missingWindows = candidate.missingWindows.filter((item): item is MedicationTrajectory['missingWindows'][number] => object(item) && instant(item.dueAt) && typeof item.plannedDose === 'number' && Number.isFinite(item.plannedDose) && text(item.unit, 80));
    if (points.length !== candidate.points.length || missingWindows.length !== candidate.missingWindows.length) return null;
    trajectories.push({ ...(candidate.source === 'PATIENT_REPORTED' || candidate.source === 'CLINICIAN' ? { source: candidate.source } : {}), planId: candidate.planId, drug: candidate.drug, status: candidate.status, frequency: candidate.frequency, unit: candidate.unit, points, missingWindows, ...(object(candidate.deviation) && text(candidate.deviation.direction, 40) && typeof candidate.deviation.daysDeviation === 'number' ? { deviation: { direction: candidate.deviation.direction, daysDeviation: candidate.deviation.daysDeviation, ...(typeof candidate.deviation.missingDays === 'number' ? { missingDays: candidate.deviation.missingDays } : {}) } } : {}) });
  }
  return { patientId: expectedPatientId, asOf: value.asOf, plans, trajectories };
}

function parseMessages(value: unknown, expectedPatientId: string): MessagePayload | null {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.records)) return null;
  const records = value.records.filter(item => object(item) && object(item.message) && text(item.message.title, 200) && messageBody(item.message.body) && (item.read === null || object(item.read))).map(item => ({ message: { title: item.message!.title, body: item.message!.body, ...(instant(item.message!.createdAt) ? { createdAt: item.message!.createdAt } : {}) }, read: item.read }));
  return records.length === value.records.length ? { patientId: expectedPatientId, records } : null;
}

function parseFollowups(value: unknown, expectedPatientId: string): FollowupPayload | null {
  if (!object(value) || (value.patientId !== undefined && value.patientId !== expectedPatientId) || !Array.isArray(value.items)) return null;
  const items = value.items.filter(item => object(item) && item.patientId === expectedPatientId && text(item.type, 80) && text(item.state, 80) && instant(item.dueAt)).map(item => ({ type: String(item.type), dueAt: String(item.dueAt), state: String(item.state) }));
  return items.length === value.items.length ? { patientId: expectedPatientId, items } : null;
}

function trendProjection(trend: TrendPayload, fallback: HomeSnapshot): Partial<HomeSnapshot> {
  const metricCodes = new Set(['TEMP', 'BLOOD_PRESSURE', 'SPO2', 'HEART_RATE']);
  const metrics: HealthMetric[] = [];
  const labs: LabFinding[] = [];
  const temperature: TemperaturePoint[] = [];
  let temperatureTicks: string[] = [];
  let temperatureComparable = true;
  let temperatureRecordedAt = '';
  for (const series of trend.series) {
    const points = series.points.slice().sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const latest = points.at(-1);
    if (!latest) continue;
    const metric = metricCodes.has(series.code) || /体温|血压|血氧|心率/.test(series.display);
    const isTemperature = series.code === 'TEMP' || series.display === '体温';
    if (metric && !isTemperature) metrics.push({ label: series.display, value: String(latest.value), unit: displayUnit(latest.unit || series.unit), tone: 'normal', recordedAt: formatRecordTime(latest.at) });
    else if (!metric && !isTemperature) {
      const previous = points.at(-2);
      labs.push({ label: series.display, value: String(latest.value), unit: displayUnit(latest.unit || series.unit), direction: !previous || previous.unit !== latest.unit || latest.value === previous.value ? 'flat' : latest.value < previous.value ? 'down' : 'up', recordedAt: formatRecordTime(latest.at) });
    }
    if (series.code === 'TEMP' || series.display === '体温') {
      const chart = buildTrendChart(points, series.unit, true, 6);
      temperatureTicks = chart.ticks;
      temperatureComparable = chart.comparable;
      temperatureRecordedAt = formatRecordTime(latest.at);
      for (const point of chart.points) temperature.push({ key: `${point.at}-${temperature.length}`, label: point.label, value: formatMeasurement(point.value, point.unit || series.unit), height: point.height });
    }
  }
  const narrative = temperature.length ? `${temperature.at(-1)!.value}` : fallback.temperatureSummary;
  const actionCopy = observationActionCopy(trend.decisionCard.actionLevel, trend.decisionCard.riskLevel) ?? trend.decisionCard;
  return {
    temperatureNarrative: temperature.length > 1 ? `近${Math.min(3, temperature.length)}次体温 ${temperature.slice(-3).map(point => point.value).join(' / ')}。这是变化趋势，具体情况请与医生确认。` : '',
    asOf: trend.asOf, updatedAtLabel: `更新于 ${formatSnapshotTime(trend.asOf)}`, temperatureSummary: narrative, temperatureRecordedAt, temperatureTicks, temperatureComparable,
    ...(temperature.length ? { temperatureTrend: temperature } : {}), ...(metrics.length ? { healthMetrics: metrics.slice(0, 6) } : {}), ...(labs.length ? { labFindings: labs.slice(0, 8), labAlertCount: labs.length } : {}),
    urgentCard: { title: actionCopy.title, body: actionCopy.action, primary: trend.decisionCard.actionLevel === 'ACT_NOW' ? '查看急诊须知' : trend.decisionCard.actionLevel === 'REVIEW' ? '准备就诊沟通' : '查看详细趋势', secondary: '急诊须知', tone: trend.decisionCard.actionLevel === 'ACT_NOW' ? 'alert' : trend.decisionCard.actionLevel === 'REVIEW' ? 'watch' : 'normal' },
  };
}

function withDashboardMetrics(snapshot: HomeSnapshot, vitals: ServerVital | null, available: boolean): HomeSnapshot {
  const measured = vitals ? formatRecordTime(vitals.recordedAt) : '尚未记录';
  const dashboardMetrics: HealthMetric[] = [
    { label: '体温', unit: '', value: snapshot.temperatureTrend.length ? snapshot.temperatureSummary : '—', tone: 'normal', recordedAt: snapshot.temperatureRecordedAt || '尚未记录' },
    { label: '血压', unit: 'mmHg', value: vitals ? `${vitals.systolic}/${vitals.diastolic}` : '—', tone: 'normal', recordedAt: measured },
    { label: '血氧', unit: '%', value: vitals ? String(vitals.spo2) : '—', tone: 'normal', recordedAt: measured },
    { label: '心率', unit: '次/分', value: vitals ? String(vitals.heartRate) : '—', tone: 'normal', recordedAt: measured },
  ];
  return { ...snapshot, dashboardMetrics, vitalsNotice: available ? '各项按最近一次测量展示' : '血压、血氧和心率暂未读取，请重新同步' };
}

function medicationProjection(medication: MedicationPayload, fallback: HomeSnapshot): Partial<HomeSnapshot> {
  let planned = 0; let actual = 0; let missed = 0;
  const selfRecorded = new Set(medication.plans.filter(plan => plan.source === 'PATIENT_REPORTED').map(plan => plan.id));
  for (const trajectory of medication.trajectories) {
    if (trajectory.source === 'PATIENT_REPORTED' || selfRecorded.has(trajectory.planId) || trajectory.frequency === 'AS_NEEDED') continue;
    const actualDays = new Set(trajectory.points.filter(point => point.kind === 'ACTUAL' && point.comparison !== 'UNPLANNED').map(point => new Date(Date.parse(point.at) + 8 * 3_600_000).toISOString().slice(0, 10)));
    actual += actualDays.size;
    planned += actualDays.size + trajectory.missingWindows.length;
    missed += trajectory.missingWindows.length;
  }
  const adherence = planned > 0 ? Math.max(0, Math.min(100, Math.round(actual / planned * 100))) : fallback.medicationAdherence;
  const names = medication.plans.filter(plan => plan.status === 'ACTIVE').map(plan => plan.source === 'PATIENT_REPORTED' ? `${plan.drug}（自记·待核对）` : plan.drug).slice(0, 4);
  const hasDeviation = medication.trajectories.some(item => item.source !== 'PATIENT_REPORTED' && !selfRecorded.has(item.planId) && item.deviation && item.deviation.direction !== 'ON_PLAN' && item.deviation.direction !== 'INSUFFICIENT_DATA');
  return { medicationAdherence: adherence, medicationTags: names, medicationSummary: planned === 0 ? selfRecorded.size ? '已录入自记用药，可继续记录；请按原处方执行，并在就诊时核对。自记用药不计入医嘱完成度。' : '暂无应服记录，可录入已有处方或查看当前用药计划。' : missed || hasDeviation ? `历史计划中有 ${missed} 个待核对记录窗口，请按医生确认的方案核对，不要自行加减药。` : `医嘱记录完成度 ${adherence}%，请继续按照护团队确认的方案记录。` };
}

function messageProjection(messages: MessagePayload): Partial<HomeSnapshot> {
  const latest = messages.records[0]?.message;
  if (!latest) return {};
  return { doctorMessage: { unread: messages.records.filter(item => item.read === null).length, title: latest.title!, body: latest.body!, time: latest.createdAt ? formatSnapshotTime(latest.createdAt) : '近期' } };
}

function followupProjection(followups: FollowupPayload, fallback: HomeSnapshot): Partial<HomeSnapshot> {
  const item = followups.items.filter(item => item.type === 'CLINIC_VISIT' && item.state !== 'COMPLETED' && item.state !== 'CANCELLED').sort((left, right) => Date.parse(left.dueAt ?? '') - Date.parse(right.dueAt ?? ''))[0];
  if (!item) return {};
  return { followUpCard: { date: item.dueAt ? formatSnapshotTime(item.dueAt) : fallback.followUpCard.date, hospital: item.title ?? item.label ?? '照护团队安排', doctor: '', status: item.state === 'OVERDUE' ? '待确认' : '待复诊', source: 'FOLLOWUP' } };
}

function symptomProjection(value: unknown, expectedPatientId: string): Partial<HomeSnapshot> | null {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.records)) return null;
  const symptoms = value.records.filter(item => object(item) && item.patientId === expectedPatientId && String(item.code).startsWith('SYMPTOM_') && instant(item.observedAt) && text(item.display, 200));
  const latest = symptoms.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  if (!latest) return { symptomSummary: '暂无症状记录', symptomUpdatedAt: '' };
  const sameDay = symptoms.filter(item => String(item.observedAt).slice(0, 10) === String(latest.observedAt).slice(0, 10));
  const active = sameDay.filter(item => item.valueCoded !== 'ABSENT' && item.valueNumeric !== 0);
  return { symptomSummary: active.length ? [...new Set(active.map(item => String(item.display)))].join('、') : '最近一次记录未报告症状', symptomUpdatedAt: formatSnapshotTime(String(latest.observedAt)) };
}

function parsePreVisitTask(value: unknown, expectedPatientId: string): PreVisitTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.patientId !== expectedPatientId || !Array.isArray(item.visits)) return null;
  const now = Date.now();
  const visit = item.visits.find(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    if (typeof row.startsAt !== 'string' || !Number.isFinite(Date.parse(row.startsAt))) return false;
    if (row.status === 'AVAILABLE') return !row.expiresAt || (typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) > now);
    return row.status === 'SUBMITTED';
  }) as Record<string, unknown> | undefined;
  if (!visit || typeof visit.startsAt !== 'string') return null;
  const completed = visit.status === 'SUBMITTED';
  return {
    status: completed ? 'SUBMITTED' : 'AVAILABLE',
    startsAt: formatSnapshotTime(visit.startsAt),
    completed,
    detail: completed ? '已记录，可在复诊时与医生一起查看。' : '还有一项待填写，填好后复诊时可以直接和医生聊。',
  };
}

function withScreeningVisit(snapshot: HomeSnapshot, task: PreVisitTask | null): HomeSnapshot {
  if (!task || snapshot.followUpCard.source !== 'NONE') return snapshot;
  return { ...snapshot, followUpCard: { date: task.startsAt, hospital: '复诊前事项关联日期，请按医院预约信息核对', doctor: '', status: '待核对', source: 'SCREENING' } };
}

/**
 * 读取 Actor 列表时允许服务端轮换 access token。只有业务身份范围变化
 * 才能使迟到结果失效，不能把正常的 token 刷新误判成过期响应。
 */
function sameActorScope(left: ReturnType<typeof session>, right: ReturnType<typeof session>): boolean {
  return Boolean(left && right && left.userId === right.userId && left.actorId === right.actorId);
}

const RELATION_LABELS: Record<MiniActor['relation'], string> = {
  SELF: '患者本人', LEGAL_GUARDIAN: '法定监护人', CAREGIVER: '照护者', SPOUSE: '配偶/家庭支持者', PROXY: '授权代理人', CLINICIAN: '医生（网页端）',
};

function actorChoices(actors: MiniActor[], selectedId: string): ActorChoice[] {
  return actors.map(actor => ({ ...actor, title: actor.displayName ?? '患者档案', relationLabel: RELATION_LABELS[actor.relation], selected: actor.id === selectedId }));
}

/**
 * 经期、妊娠、职场、邀请医生入口按当前身份收起，并在原位置说明为什么看不到 —— 不能让监护人点进去
 * 只看到一句「无权查看」。性别来自当前患者摘要；未读到时不猜测。
 * 对应页面已有的服务端 403 回执仍优先，回执在同一身份下一直有效。
 */
function featureGates(current: MiniSession, sex: PatientSex = 'UNKNOWN', lifeStage = 'UNKNOWN'): Record<string, unknown> {
  const key = current.patientId ? featureScopeKey({ userId: current.userId, actorId: current.actorId, patientId: current.patientId }) : '';
  const gate = (feature: GatedFeature, label: string): { show: boolean; note: string } => {
    if (!roleAllows(feature, current.role)) return { show: false, note: '' };
    const reason = key ? unavailableReason(key, feature) : null;
    return reason ? { show: false, note: `${label}已收起：${reason}` } : { show: true, note: '' };
  };
  const menstrual = gate('MENSTRUAL', '经期与用药关注');
  const pregnancy = gate('PREGNANCY', '生育与妊娠');
  const work = gate('WORK_SUPPORT', '工作与职场支持');
  const womenNotes = sex === 'FEMALE' || !roleAllows('MENSTRUAL', current.role) ? [
    ...(roleAllows('MENSTRUAL', current.role) ? [] : ['经期、生育与妊娠只对患者本人开放，当前身份下不显示。']),
    ...((sex === 'FEMALE' || !roleAllows('MENSTRUAL', current.role)) && lifeStage !== 'ADULT'
      ? ['生育与妊娠只适用于成人患者，当前阶段不显示。']
      : []),
    ...[menstrual.note, pregnancy.note].filter(Boolean),
  ] : [];
  const workStageAllowed = lifeStage === 'ADULT' || lifeStage === 'TRANSITION' || lifeStage === 'UNKNOWN';
  const workNote = lifeStage === 'CHILD'
    ? '工作与职场支持只适用于过渡期和成人患者，当前阶段不显示。'
    : roleAllows('WORK_SUPPORT', current.role) ? work.note : '工作与职场支持只对患者本人或法定监护人开放，当前身份下不显示。';
  return { showMenstrual: sex === 'FEMALE' && menstrual.show, showPregnancy: sex === 'FEMALE' && lifeStage === 'ADULT' && pregnancy.show, showFertility: sex === 'MALE' && lifeStage === 'ADULT' && current.role === 'PATIENT', fertilityLabel: '男性生育与用药关注', healthTitle: sex === 'FEMALE' ? '女性健康' : sex === 'MALE' ? '男性健康' : '健康关注', showWorkSupport: work.show && workStageAllowed, womenNotes, workNote, ...careInviteEntry(current) };
}

Page({
  data: {
    role: 'PATIENT' as MiniRole,
    roleText: '患者本人',
    patientId: '',
    actorId: '',
    entrySexIntent: 'UNKNOWN' as 'MALE' | 'FEMALE' | 'UNKNOWN',
    entrySexIntentLabel: '',
    actorOptions: [] as ActorChoice[],
    actorLoading: false,
    profileLoading: false,
    patientName: '当前患者',
    patientSexLabel: '性别未登记',
    patientStageLabel: '',
    patientAgeLabel: '',
    patientDiagnosis: '',
    adultContactDecision: 'UNSET' as 'UNSET' | 'DEFERRED',
    recordCount: 0,
    profileNotice: '',
    preVisitLoading: false,
    preVisitTask: null as PreVisitTask | null,
    showDetails: false,
    showObservationDetails: false,
    showActorPicker: false,
    switching: false,
    unbinding: false,
    error: '',
    pushReady: false,
    pushSubscribed: false,
    pushTemplates: '',
    pushNotice: '',
    showMenstrual: false,
    showPregnancy: false,
    showFertility: true,
    fertilityLabel: '生育与用药关注',
    healthTitle: '健康关注',
    showWorkSupport: false,
    womenNotes: [] as string[],
    workNote: '',
    showCareInvite: false,
    careInviteNote: '',
    careCapabilities: null as CareCapabilities | null,
    snapshotLoading: true,
    snapshotNotice: '',
    homeSnapshot: null as HomeSnapshot | null,
    contactSafety: null as ContactSafetyView | null,
    safetyCountdown: '',
    safetyHeading: '',
    contactSafetyLoading: false,
    contactSafetyNotice: '',
    safetyActionBusy: false,
  },
  actorLoadVersion: 0,
  safetyTimer: null as ReturnType<typeof setInterval> | null,
  safetyClockOffsetMs: 0,
  safetyExpiryRefreshKey: '',
  safetyMutationKey: '' as string,
  readEntrySexIntent(): 'MALE' | 'FEMALE' | 'UNKNOWN' {
    const value = wx.getStorageSync<unknown>(ENTRY_SEX_INTENT_KEY);
    return value === 'MALE' || value === 'FEMALE' ? value : 'UNKNOWN';
  },
  entrySexIntentLabel(intent: 'MALE' | 'FEMALE' | 'UNKNOWN', actual: PatientSex): string {
    if (intent === 'UNKNOWN' || intent === actual) return '';
    const actualLabel = actual === 'MALE' ? '男性患者' : actual === 'FEMALE' ? '女性患者' : '已登记的患者';
    return `当前查看${actualLabel}的档案，可通过「切换档案」选择其他患者。`;
  },
  async loadHomeSnapshot(current: MiniSession, version: number): Promise<void> {
    if (!current.patientId) { this.setData({ homeSnapshot: null, snapshotLoading: false, snapshotNotice: '尚未绑定患者档案，当前没有可展示的临床数据。' }); return; }
    const expectedId = current.patientId;
    this.setData({ snapshotLoading: true, snapshotNotice: '' });
    const fallback = emptyHomeSnapshot();
    const results = await Promise.allSettled([
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/trend`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/medications`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/messages?limit=3`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/followups?limit=100`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/observations?limit=100`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/care-summary`),
      loadAuxiliaryVitals({ userId: current.userId, actorId: current.actorId, patientId: expectedId }),
      loadSelfFollowups({ userId: current.userId, actorId: current.actorId, patientId: expectedId }),
    ]);
    if (version !== this.actorLoadVersion || !sameActorScope(session(), current)) return;
    let snapshot = { ...fallback, temperatureTrend: [...fallback.temperatureTrend], healthMetrics: [...fallback.healthMetrics], labFindings: [...fallback.labFindings], medicationTags: [...fallback.medicationTags] };
    let liveCount = 0;
    const trend = results[0].status === 'fulfilled' ? parseTrend(results[0].value, expectedId) : null;
    if (trend) { snapshot = { ...snapshot, ...trendProjection(trend, snapshot), trendAvailable: true, source: 'LIVE' }; liveCount += 1; }
    const medication = results[1].status === 'fulfilled' ? parseMedication(results[1].value, expectedId) : null;
    if (medication) { snapshot = { ...snapshot, ...medicationProjection(medication, snapshot), medicationsAvailable: true, source: 'LIVE' }; liveCount += 1; }
    const messages = results[2].status === 'fulfilled' ? parseMessages(results[2].value, expectedId) : null;
    if (messages) { snapshot = { ...snapshot, ...messageProjection(messages), messagesAvailable: true, source: 'LIVE' }; liveCount += 1; }
    const followups = results[3].status === 'fulfilled' ? parseFollowups(results[3].value, expectedId) : null;
    if (followups) { snapshot = { ...snapshot, ...followupProjection(followups, snapshot), source: 'LIVE' }; liveCount += 1; }
    else snapshot.followUpCard = { ...snapshot.followUpCard, date: '复诊安排暂未读取', hospital: '可重新读取，或按医院预约信息核对', status: '待同步' };
    const symptoms = results[4].status === 'fulfilled' ? symptomProjection(results[4].value, expectedId) : null;
    if (symptoms) { snapshot = { ...snapshot, ...symptoms, symptomsAvailable: true }; liveCount += 1; }
    const source: SnapshotSource = liveCount === 5 ? 'LIVE' : liveCount > 0 ? 'PARTIAL' : 'UNAVAILABLE';
    snapshot = { ...snapshot, source, sourceLabel: displaySource(source), updatedAtLabel: liveCount ? `本次同步：${formatSnapshotTime(new Date().toISOString())}` : '尚未同步', asOf: snapshot.asOf || fallback.asOf };
    const selfFollowup = results[7].status === 'fulfilled' ? nextSelfFollowup(results[7].value, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)) : undefined;
    if (selfFollowup) snapshot = { ...snapshot, followUpCard: { date: selfFollowup.date, hospital: [selfFollowup.hospital, selfFollowup.department].filter(Boolean).join(' · ') || '医院待确认', doctor: selfFollowup.doctor, status: '自记安排', source: 'LOCAL' } };
    snapshot = withScreeningVisit(snapshot, this.data.preVisitTask);
    const careCapabilities = results[5].status === 'fulfilled' ? parseCareCapabilities(results[5].value, expectedId) : null;
    if (snapshot.urgentCard.tone === 'alert') snapshot.urgentCard = { ...snapshot.urgentCard, primary: '查看急诊须知' };
    else if (snapshot.urgentCard.tone === 'watch') snapshot.urgentCard = { ...snapshot.urgentCard, primary: careCapabilities?.canMessageCareTeam ? '给照护团队留言' : '准备就诊沟通', body: `${snapshot.urgentCard.body}${careCapabilities?.canMessageCareTeam === false ? ' 当前没有站内医护收件人，请线下联系就诊医生核对；紧急情况请直接就医。' : !careCapabilities ? ' 站内接收状态尚未确认，可先整理记录，就诊时与医生核对。' : ''}` };
    snapshot = withDashboardMetrics(snapshot, results[6].status === 'fulfilled' ? results[6].value.latest : null, results[6].status === 'fulfilled');
    this.setData({ homeSnapshot: snapshot, careCapabilities, snapshotLoading: false, snapshotNotice: source === 'UNAVAILABLE' ? '数据读取失败，请检查网络并刷新。' : source === 'PARTIAL' ? '部分内容暂时未能更新，可稍后刷新。' : '' });
  },
  clearSafetyTimer() {
    if (this.safetyTimer !== null) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
  },
  clearContactSafetyState(message = '') {
    this.clearSafetyTimer();
    this.safetyClockOffsetMs = 0;
    this.safetyExpiryRefreshKey = '';
    this.safetyMutationKey = '';
    this.setData({ contactSafety: null, safetyCountdown: '', safetyHeading: '', contactSafetyLoading: false, contactSafetyNotice: message, safetyActionBusy: false });
  },
  updateSafetyCountdown() {
    const view = this.data.contactSafety as ContactSafetyView | null;
    if (!view || (view.state !== 'COUNTDOWN' && view.state !== 'NOTIFIED')) { this.clearSafetyTimer(); this.setData({ safetyCountdown: '' }); return; }
    const deadline = Date.parse(view.deadlineAt);
    const asOf = Date.parse(view.asOf);
    if (!Number.isFinite(deadline) || !Number.isFinite(asOf)) { this.clearSafetyTimer(); this.setData({ safetyCountdown: '' }); return; }
    const now = Date.now() + this.safetyClockOffsetMs;
    // 取整秒时向上显示，避免网络回包耗时让首帧提前少显示一秒；真正到期仍会归零。
    const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
    this.setData({ safetyCountdown: formatSafetyCountdown(remaining) });
    if (remaining === 0 && this.safetyExpiryRefreshKey !== view.runId) {
      this.safetyExpiryRefreshKey = view.runId;
      const current = session();
      if (current && current.patientId) void this.loadContactSafety(current, this.actorLoadVersion, true);
    }
  },
  startSafetyTimer(initialSeconds?: number) {
    this.clearSafetyTimer();
    if (initialSeconds !== undefined && Number.isSafeInteger(initialSeconds) && initialSeconds >= 0) this.setData({ safetyCountdown: formatSafetyCountdown(initialSeconds) });
    else this.updateSafetyCountdown();
    if (this.data.contactSafety && ((this.data.contactSafety as ContactSafetyView).state === 'COUNTDOWN' || (this.data.contactSafety as ContactSafetyView).state === 'NOTIFIED')) {
      this.safetyTimer = setInterval(() => this.updateSafetyCountdown(), 1000);
    }
  },
  async loadContactSafety(current: MiniSession, version: number, silent = false): Promise<void> {
    const expectedId = current.patientId;
    // 安全网是成年患者本人签署的授权投影；照护者/代理只从联系人页读取各自被授权范围。
    if (!expectedId || current.role !== 'PATIENT') { this.clearContactSafetyState(); return; }
    if (!silent) this.setData({ contactSafetyLoading: true, contactSafetyNotice: '' });
    try {
      const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/contact-safety/runs/current`);
      if (version !== this.actorLoadVersion || !sameActorScope(session(), current)) return;
      const runs = parseContactSafetyView(value, expectedId);
      if (!runs) throw new Error('安全网状态响应格式无效。');
      // 首页只展示当前进行中的一轮；已结束流程保留在后端和医生端，不在患者首页制造旧警报。
      const active = runs.find(item => item.state === 'COUNTDOWN' || item.state === 'NOTIFIED') ?? null;
      const previous = this.data.contactSafety as ContactSafetyView | null;
      const previousExpired = Boolean(previous && (previous.state === 'COUNTDOWN' || previous.state === 'NOTIFIED') &&
        previous.runId === active?.runId && Date.parse(previous.deadlineAt) <= Date.now() + this.safetyClockOffsetMs);
      this.clearSafetyTimer();
      this.safetyClockOffsetMs = active ? Date.parse(active.asOf) - Date.now() : 0;
      this.safetyExpiryRefreshKey = previousExpired && active ? active.runId : '';
      this.safetyMutationKey = '';
      this.setData({ contactSafety: active, safetyHeading: active ? safetyHeading(active) : '', safetyCountdown: '', contactSafetyLoading: false, contactSafetyNotice: '' });
      if (active && !previousExpired) this.startSafetyTimer(active.remainingSeconds);
      else if (active) this.updateSafetyCountdown();
    } catch (error) {
      if (version !== this.actorLoadVersion || !sameActorScope(session(), current)) return;
      this.clearContactSafetyState(silent ? '' : error instanceof Error ? error.message : '安全网状态暂时无法读取，请重新读取。');
    }
  },
  async safetyAction(action: 'self-contact' | 'snooze' | 'revoke') {
    const current = session();
    const view = this.data.contactSafety as ContactSafetyView | null;
    if (!current?.patientId || !view || this.data.safetyActionBusy) return;
    const allowed = action === 'self-contact' ? view.canSelfContact : action === 'snooze' ? view.canSnooze : view.canCancel;
    if (!allowed) { this.setData({ contactSafetyNotice: '这项操作已不再适用，请重新读取当前状态。' }); return; }
    if (action === 'revoke') {
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: '取消这次联系人通知？', content: '取消后本轮安全网不会继续联系紧急联系人；如果你仍需要帮助，请直接联系医生或急诊。', confirmText: '取消授权', cancelText: '先不取消', confirmColor: '#b4232c', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
      if (!confirmed || !sameActorScope(session(), current)) return;
    }
    const operationKey = `${action}:${view.runId}`;
    if (!this.safetyMutationKey.startsWith(operationKey)) this.safetyMutationKey = `${operationKey}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const idempotencyKey = this.safetyMutationKey;
    this.setData({ safetyActionBusy: true, contactSafetyNotice: '' });
    const path = `/api/v1/patients/${encodeURIComponent(current.patientId)}/contact-safety/runs/${encodeURIComponent(view.runId)}/${action}`;
    try {
      const payload = { expectedVersion: view.generation, idempotencyKey };
      await request<unknown>(path, 'POST', payload);
      if (!sameActorScope(session(), current)) return;
      this.safetyMutationKey = '';
      wx.showToast({ title: action === 'revoke' ? '已取消授权' : action === 'snooze' ? '已延后 2 小时' : '已记录你会自行联系', icon: 'success' });
      await this.loadContactSafety(current, this.actorLoadVersion);
    } catch (error) {
      if (sameActorScope(session(), current)) {
        this.setData({ contactSafetyNotice: error instanceof Error ? error.message : '操作未确认，请稍后重试。' });
        if (error instanceof ApiFailure && error.status === 409) void this.loadContactSafety(current, this.actorLoadVersion);
      }
    } finally {
      if (sameActorScope(session(), current)) this.setData({ safetyActionBusy: false });
    }
  },
  safetySelfContact() { void this.safetyAction('self-contact'); },
  safetySnooze() { void this.safetyAction('snooze'); },
  safetyCancel() { void this.safetyAction('revoke'); },
  onShow() {
    const current = session();
    if (!current) { this.clearContactSafetyState(); this.setData({ homeSnapshot: null, snapshotLoading: false }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const version = ++this.actorLoadVersion;
    const entrySexIntent = this.readEntrySexIntent();
    this.clearContactSafetyState();
    this.setData({ role: current.role, roleText: roleLabel(current.role), patientId: patientId() ?? '', actorId: current.actorId, entrySexIntent, entrySexIntentLabel: '', showActorPicker: false, showObservationDetails: false, adultContactDecision: 'UNSET', actorOptions: [], actorLoading: true, preVisitLoading: Boolean(current.patientId), preVisitTask: null, snapshotLoading: Boolean(current.patientId), snapshotNotice: '', homeSnapshot: emptyHomeSnapshot(), error: '', ...featureGates(current) });
    this.loadProfile(current, version);
    this.loadHomeSnapshot(current, version);
    this.loadContactSafety(current, version);
    this.loadPreVisitTask(current, version);
    this.loadPushConfig();
    availableActors().then(actors => {
      const latest = session();
      if (version !== this.actorLoadVersion || !sameActorScope(latest, current)) return;
      if (!latest) return;
      this.setData({ actorOptions: actorChoices(actors, latest.actorId), actorLoading: false });
    }).catch(error => {
      if (version !== this.actorLoadVersion) return;
      this.setData({ actorLoading: false, error: error instanceof Error ? error.message : '身份列表暂不可用，请刷新重试。' });
    });
  },
  loadProfile(current: MiniSession, version: number) {
    this.setData({ profileLoading: true, patientName: '当前患者', patientSexLabel: '性别未登记', patientStageLabel: '', patientAgeLabel: '', patientDiagnosis: '', recordCount: 0, profileNotice: '' });
    if (!current.patientId) { this.setData({ profileLoading: false, profileNotice: '当前微信身份尚未绑定患者档案。' }); return; }
    const expectedId = current.patientId;
    request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/summary`).then(value => {
      if (version !== this.actorLoadVersion || !sameActorScope(session(), current)) return;
      const summary = parseSummary(value, expectedId);
      const patientSexLabel = ({ FEMALE: '女性患者', MALE: '男性患者', INTERSEX: '其他性别', UNKNOWN: '性别未登记' } as Record<PatientSex, string>)[summary.sex];
      updateTabBar();
      const entrySexIntent = this.data.entrySexIntent as 'MALE' | 'FEMALE' | 'UNKNOWN';
      const birth = summary.birthDate ? new Date(summary.birthDate + 'T00:00:00+08:00') : null;
      const now = new Date();
      const months = birth ? (now.getFullYear() - birth.getFullYear()) * 12 + now.getMonth() - birth.getMonth() - (now.getDate() < birth.getDate() ? 1 : 0) : -1;
      const patientAgeLabel = months >= 0 && months < 1440 ? `${Math.floor(months / 12)}岁${months % 12 ? months % 12 + '个月' : ''}` : '';
      const patientDiagnosis = summary.diseaseType === 'sJIA' ? '全身型幼年特发性关节炎（sJIA）' : summary.diseaseType === 'AOSD' ? '成人斯蒂尔病（AOSD）' : '';
      this.setData({ patientAgeLabel, patientDiagnosis, patientName: summary.patientDisplayName, patientSexLabel, patientStageLabel: ({ CHILD: '儿童期', TRANSITION: '成长过渡期', ADULT: '成人' } as Record<string, string>)[summary.lifeStage], recordCount: summary.observationsCount, entrySexIntentLabel: this.entrySexIntentLabel(entrySexIntent, summary.sex), ...featureGates(current, summary.sex, summary.lifeStage) });
    }).catch(error => {
      if (version === this.actorLoadVersion && sameActorScope(session(), current)) this.setData({ profileNotice: error instanceof Error ? error.message : '当前档案暂不可用。' });
    }).finally(() => {
      if (version === this.actorLoadVersion && sameActorScope(session(), current)) this.setData({ profileLoading: false });
    });
  },
  loadPreVisitTask(current: MiniSession, version: number) {
    if (!current.patientId) { this.setData({ preVisitLoading: false, preVisitTask: null }); return; }
    const expectedId = current.patientId;
    request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedId)}/psych-screening-form`).then(value => {
      if (version !== this.actorLoadVersion || !sameActorScope(session(), current)) return;
      const preVisitTask = parsePreVisitTask(value, expectedId);
      this.setData({ preVisitTask, ...(this.data.homeSnapshot ? { homeSnapshot: withScreeningVisit(this.data.homeSnapshot, preVisitTask) } : {}) });
    }).catch(() => {
      // 任务卡是首页的增强信息；服务端暂时不可用时不阻塞记录、趋势和用药入口。
      if (version === this.actorLoadVersion && sameActorScope(session(), current)) this.setData({ preVisitTask: null });
    }).finally(() => {
      if (version === this.actorLoadVersion && sameActorScope(session(), current)) this.setData({ preVisitLoading: false });
    });
  },
  /**
   * 读取订阅消息配置并如实展示。未接入时显示「暂未开通」，不给出会让用户白点的按钮。
   * 授权结果只在本次操作内提示，不做本地「已授权」缓存 —— 微信的一次性订阅会随
   * 推送次数消耗，缓存会让用户以为还有授权而实际收不到。
   */
  loadPushConfig() {
    pushTemplate().then(info => {
      const ready = Boolean(info.ready && info.templateId?.trim());
      this.setData({ pushReady: ready, pushSubscribed: false, pushTemplates: ready ? info.templateId! : '', pushNotice: ready ? '' : '微信提醒暂未开通，医生消息和用药提醒可在小程序内查看。' });
    }).catch(() => {
      this.setData({ pushReady: false, pushSubscribed: false, pushTemplates: '', pushNotice: '暂时无法读取微信提醒状态，可稍后重试；站内消息仍可查看。' });
    });
  },
  askPushConsent() {
    const templateId = this.data.pushTemplates;
    if (!this.data.pushReady || typeof templateId !== 'string' || !templateId) {
      this.setData({ pushNotice: '微信提醒暂未开通，请在小程序内查看消息。' });
      return;
    }
    requestSubscribeConsent(templateId).then(outcome => {
      if (outcome === 'ACCEPTED') this.setData({ pushSubscribed: true, pushNotice: '已开通消息提醒。医生发消息时你会收到一条提醒。' });
      else if (outcome === 'REJECTED') this.setData({ pushNotice: '已保留原有设置。需要提醒时随时可以再点一次开通。' });
      else this.setData({ pushNotice: '当前微信版本暂不支持订阅提醒。' });
    });
  },
  changeActor(event: { currentTarget?: { dataset?: { actorId?: unknown } } }) {
    if (this.data.switching) return;
    const actorId = event.currentTarget?.dataset?.actorId;
    if (typeof actorId !== 'string' || !actorId) return;
    const current = session();
    if (!current || actorId === current.actorId) return;
    const version = ++this.actorLoadVersion;
    this.setData({ switching: true, error: '' });
    switchActor(actorId).then(next => {
      if (version !== this.actorLoadVersion) return;
      const entrySexIntent = this.readEntrySexIntent();
      this.clearContactSafetyState();
      this.setData({ role: next.role, roleText: roleLabel(next.role), patientId: next.patientId ?? '', actorId: next.actorId, entrySexIntent, entrySexIntentLabel: '', showActorPicker: false, showObservationDetails: false, adultContactDecision: 'UNSET', actorOptions: actorChoices(this.data.actorOptions as ActorChoice[], next.actorId), preVisitLoading: Boolean(next.patientId), preVisitTask: null, snapshotLoading: Boolean(next.patientId), snapshotNotice: '', homeSnapshot: emptyHomeSnapshot(), error: '', ...featureGates(next) });
      this.loadProfile(next, version);
      this.loadPreVisitTask(next, version);
      this.loadHomeSnapshot(next, version);
      this.loadContactSafety(next, version);
      wx.showToast({ title: '已切换身份', icon: 'success' });
    }).catch(error => {
      if (version !== this.actorLoadVersion) return;
      this.setData({ error: error instanceof Error ? error.message : '身份切换失败，请刷新重试。' });
    }).finally(() => {
      if (version === this.actorLoadVersion) this.setData({ switching: false });
    });
  },
  openVitals() { wx.navigateTo({ url: '/pages/patient/vitals' }); },
  openTemperature() { wx.navigateTo({ url: '/pages/patient/observation?mode=temperature' }); },
  openSymptoms() { wx.navigateTo({ url: '/pages/patient/observation?mode=symptom' }); },
  openRecords() { wx.switchTab({ url: '/pages/patient/records' }); },
  openSupport() { wx.navigateTo({ url: '/pages/patient/support' }); },
  openEmergency() { wx.navigateTo({ url: '/pages/patient/emergency' }); },
  contactDoctor() { if (this.data.homeSnapshot?.urgentCard.tone === 'alert') this.openEmergency(); else if (this.data.homeSnapshot?.urgentCard.primary === '查看详细趋势') this.openTrend(); else this.openDoctorMessages(); },
  openDoctorMessages() { wx.navigateTo({ url: '/pages/patient/support?section=messages' }); },
  openFollowup() { wx.navigateTo({ url: '/pages/patient/life-event?section=followup' }); },
  refreshSnapshot() { this.onShow(); },
  onHide() { this.clearSafetyTimer(); },
  onUnload() { this.clearSafetyTimer(); },
  openCareInvite() { wx.navigateTo({ url: '/pages/patient/care-invite' }); },
  openMedications() { wx.navigateTo({ url: '/pages/patient/medications' }); },
  openTrend() { wx.navigateTo({ url: '/pages/patient/trend' }); },
  openMenstrual() { wx.navigateTo({ url: '/pages/patient/menstrual' }); },
  openScreening() { wx.navigateTo({ url: '/pages/patient/screening' }); },
  openSchool() { wx.navigateTo({ url: '/pages/patient/school' }); },
  openHealth() { wx.navigateTo({ url: '/pages/patient/health' }); },
  openMore() { wx.navigateTo({ url: '/pages/patient/more' }); },
  openLabArchive() { wx.navigateTo({ url: '/pages/patient/archive?kind=check' }); },
  openFertility() { wx.navigateTo({ url: '/pages/patient/more' }); },
  toggleObservationDetails() { this.setData({ showObservationDetails: !this.data.showObservationDetails }); },
  toggleDetails() { this.setData({ showDetails: !this.data.showDetails }); },
  toggleActors() { this.setData({ showActorPicker: !this.data.showActorPicker }); },
  openAudit() { wx.navigateTo({ url: '/pages/patient/audit' }); },
  // T-06 刻意不进任何显眼导航：放成低强调入口，只在需要时找得到。
  openAccount() { wx.switchTab({ url: '/pages/patient/account' }); },
  // 跨院共享、联系人授权、独居模式都与隐私 / 档案相关，同样只做低强调入口。
  openSharing() { wx.navigateTo({ url: '/pages/patient/sharing' }); },
  openContacts() { wx.navigateTo({ url: '/pages/patient/contacts' }); },
  deferContact() {
    this.setData({ adultContactDecision: 'DEFERRED' });
    wx.showToast({ title: '已选择暂不通知', icon: 'none' });
  },
  openLiving() { wx.navigateTo({ url: '/pages/patient/living' }); },
  openInbox() { wx.navigateTo({ url: '/pages/patient/inbox' }); },
  openLifeEvent() { wx.navigateTo({ url: '/pages/patient/life-event' }); },
  openWorkSupport() { wx.navigateTo({ url: '/pages/patient/work-support' }); },
  openTransition() { wx.navigateTo({ url: '/pages/patient/transition' }); },
  openPregnancy() { wx.navigateTo({ url: '/pages/patient/pregnancy' }); },
  logout() { getApp<{ logout: () => void }>().logout(); },
  /** 换手机或不再照护时由本人解除；解除后要医生重新生成邀请码才能再绑定，所以先二次确认。 */
  unbind(): Promise<void> | undefined {
    if (this.data.unbinding) return undefined;
    return new Promise<boolean>(resolve => wx.showModal({
      title: '解除本微信的绑定',
      content: '解除后，这个微信不能再直接登录，需要请主管医生重新生成邀请码才能再次绑定。本账户在其他设备上的登录也会一并退出。',
      confirmText: '解除绑定', cancelText: '先不解除', confirmColor: '#9a3d37',
      success: result => resolve(result.confirm),
      fail: () => resolve(false),
    })).then(confirmed => {
      if (!confirmed) return undefined;
      this.setData({ unbinding: true, error: '' });
      return unbindWechat().then(outcome => {
        if (!outcome.revoked) { this.setData({ error: '当前账户没有生效中的微信绑定，无需解除。' }); return; }
        wx.showToast({ title: '已解除绑定', icon: 'success' });
        wx.reLaunch({ url: '/pages/auth/index' });
      }).catch(error => {
        this.setData({ error: error instanceof Error ? error.message : '解除绑定失败，请稍后重试。' });
      }).finally(() => this.setData({ unbinding: false }));
    });
  },
});
