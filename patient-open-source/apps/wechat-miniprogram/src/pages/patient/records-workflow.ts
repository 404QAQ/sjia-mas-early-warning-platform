import { patientId, request, session } from '../../api';
import { at } from '../../date-format.js';
import { formatMeasurement } from '../../measurement-format';
import { loadSelfFollowups, nextSelfFollowup } from '../../self-followups';
import {
  HttpFailure,
  makeRecords,
  makeSymptomRecords,
  outboxForCurrentSession,
  sendRecord,
  sessionScope,
  sourceForSession,
  submitRecords,
  symptoms,
  buildSymptomGroups,
  type ObservationView,
  type RecordInput,
} from '../../patient-records';

interface Summary {
  patientId: string;
  patientDisplayName: string;
  lifeStage: 'CHILD' | 'TRANSITION' | 'ADULT';
  observationsCount: number;
  latestObservationAt: string | null;
  alerts: Array<{ status: string; actionLevel: string }>;
  updatedAt: string;
}

interface ObservationPageValue { patientId: string; records: ObservationView[]; nextCursor?: string; }
interface MedicationPreview { id: string; drug: string; dose: string; recordedAt: string; }

function medicationPreview(value: unknown, expectedPatient: string): MedicationPreview[] | null {
  if (!object(value) || value.patientId !== expectedPatient || !Array.isArray(value.plans) || !Array.isArray(value.logs)) return null;
  const plans = value.plans.filter((item): item is Record<string, unknown> => object(item) && item.patientId === expectedPatient && typeof item.id === 'string' && typeof item.drug === 'string');
  return value.logs.filter((item): item is Record<string, unknown> => object(item) && item.patientId === expectedPatient && typeof item.id === 'string' && typeof item.planId === 'string' && typeof item.takenAt === 'string' && Number.isFinite(Date.parse(item.takenAt)) && typeof item.actualDose === 'number' && Number.isFinite(item.actualDose) && typeof item.unit === 'string')
    .sort((left, right) => Date.parse(String(right.takenAt)) - Date.parse(String(left.takenAt))).slice(0, 3)
    .flatMap(item => { const plan = plans.find(plan => plan.id === item.planId); return plan ? [{ id: String(item.id), drug: String(plan.drug), dose: `${item.actualDose} ${item.unit}`, recordedAt: at(String(item.takenAt)) }] : []; });
}

function lastTemperatureLabel(records: ObservationView[]): string {
  const latest = records
    .filter(record => record.code === 'TEMP' && typeof record.valueNumeric === 'number' && Number.isFinite(record.valueNumeric) && Number.isFinite(Date.parse(record.observedAt)))
    .reduce<ObservationView | null>((current, record) => !current || Date.parse(record.observedAt) > Date.parse(current.observedAt) ? record : current, null);
  return latest?.valueNumeric === undefined ? '' : `${formatMeasurement(latest.valueNumeric, latest.unit)} · ${at(latest.observedAt)}`;
}

interface TrendView {
  patientId: string;
  asOf: string;
  narrative: string[];
  decisionCard: { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; actionLevel: 'OBSERVE' | 'REVIEW' | 'ACT_NOW'; riskLabel: string; actionLabel: string; title: string; action: string };
  series: Array<{ display: string; unit: string; points: Array<{ at: string; value: number; unit: string; source: string }> }>;
}

const LIFE_STAGE_LABELS: Record<Summary['lifeStage'], string> = {
  CHILD: '儿童期',
  TRANSITION: '成长过渡期',
  ADULT: '成人期',
};
const ACTION_LEVEL_LABELS: Record<string, string> = {
  OBSERVE: '继续观察',
  REVIEW: '安排复评',
  ACT_NOW: '立即行动',
};
const ALERT_STATUS_LABELS: Record<string, string> = {
  OPEN: '待处理',
  ACKNOWLEDGED: '已确认',
  IGNORED: '待复评',
  ESCALATED: '已升级',
  RESOLVED: '已正式处置',
};
const RISK_LEVEL_LABELS: Record<string, string> = {
  LOW: '低风险',
  MEDIUM: '中风险',
  HIGH: '高风险',
  CRITICAL: '危急风险',
};
const OBSERVATION_SOURCE_LABELS: Record<ObservationView['source'], string> = {
  PATIENT_REPORTED: '患者本人', CAREGIVER_REPORTED: '照护者 / 监护人', CLINIC: '医疗团队', LAB: '检验记录', DEVICE: '设备记录',
};

function humanLabel(value: string, labels: Record<string, string>, fallback = '待确认'): string {
  return labels[value] ?? fallback;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseSummary(value: unknown): Summary | null {
  if (!object(value) || typeof value.patientId !== 'string' || typeof value.patientDisplayName !== 'string' ||
    !['CHILD', 'TRANSITION', 'ADULT'].includes(value.lifeStage as string) || typeof value.observationsCount !== 'number' ||
    !Number.isSafeInteger(value.observationsCount) || value.observationsCount < 0 ||
    !(value.latestObservationAt === null || (typeof value.latestObservationAt === 'string' && Number.isFinite(Date.parse(value.latestObservationAt)))) ||
    typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.alerts)) return null;
  const alerts = value.alerts.filter((alert): alert is { status: string; actionLevel: string } => object(alert) && typeof alert.status === 'string' && typeof alert.actionLevel === 'string');
  if (alerts.length !== value.alerts.length) return null;
  return { patientId: value.patientId, patientDisplayName: value.patientDisplayName, lifeStage: value.lifeStage as Summary['lifeStage'], observationsCount: value.observationsCount, latestObservationAt: value.latestObservationAt, alerts, updatedAt: value.updatedAt };
}

function parseObservations(value: unknown, expectedPatient: string): ObservationPageValue | null {
  if (!object(value) || value.patientId !== expectedPatient || !Array.isArray(value.records)) return null;
  const records: ObservationView[] = [];
  for (const item of value.records) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.patientId !== 'string' || item.patientId !== expectedPatient ||
      typeof item.code !== 'string' || typeof item.display !== 'string' || typeof item.unit !== 'string' || typeof item.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.observedAt)) ||
      !['PATIENT_REPORTED', 'CAREGIVER_REPORTED', 'CLINIC', 'LAB', 'DEVICE'].includes(item.source as string) ||
      (item.valueNumeric !== undefined && (typeof item.valueNumeric !== 'number' || !Number.isFinite(item.valueNumeric))) ||
      (item.valueCoded !== undefined && typeof item.valueCoded !== 'string') ||
      (item.confidence !== undefined && item.confidence !== 'HIGH' && item.confidence !== 'LOW')) return null;
    records.push({
      id: item.id, patientId: item.patientId, code: item.code, display: item.display, unit: item.unit, observedAt: item.observedAt,
      source: item.source as ObservationView['source'], idempotencyKey: typeof item.idempotencyKey === 'string' ? item.idempotencyKey : `server:${item.id}`,
      tags: Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string') ? item.tags : [],
      ...(item.confidence === undefined ? {} : { confidence: item.confidence as 'HIGH' | 'LOW' }),
      ...(item.valueNumeric === undefined ? {} : { valueNumeric: item.valueNumeric }),
      ...(item.valueCoded === undefined ? {} : { valueCoded: item.valueCoded }),
      ...(typeof item.recordedAt === 'string' ? { recordedAt: item.recordedAt } : {}),
      ...(typeof item.recordedBy === 'string' ? { recordedBy: item.recordedBy } : {}),
    });
  }
  return { patientId: expectedPatient, records, ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}) };
}

function parseTrend(value: unknown, expectedPatient: string): TrendView | null {
  if (!object(value) || value.patientId !== expectedPatient || typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf)) ||
    !Array.isArray(value.narrative) || !value.narrative.every(item => typeof item === 'string' && item.length <= 1000) || !object(value.decisionCard) ||
    !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(value.decisionCard.riskLevel)) ||
    !['OBSERVE', 'REVIEW', 'ACT_NOW'].includes(String(value.decisionCard.actionLevel)) ||
    typeof value.decisionCard.title !== 'string' || typeof value.decisionCard.action !== 'string' || !Array.isArray(value.series)) return null;
  const series: TrendView['series'] = [];
  for (const item of value.series) {
    if (!object(item) || typeof item.display !== 'string' || typeof item.unit !== 'string' || !Array.isArray(item.points)) return null;
    const points: TrendView['series'][number]['points'] = [];
    for (const point of item.points) {
      if (!object(point) || typeof point.at !== 'string' || !Number.isFinite(Date.parse(point.at)) || typeof point.value !== 'number' || !Number.isFinite(point.value) || typeof point.unit !== 'string' || typeof point.source !== 'string') return null;
      points.push({ at: point.at, value: point.value, unit: point.unit, source: point.source });
    }
    series.push({ display: item.display, unit: item.unit, points });
  }
  const riskLevel = value.decisionCard.riskLevel as TrendView['decisionCard']['riskLevel'];
  const actionLevel = value.decisionCard.actionLevel as TrendView['decisionCard']['actionLevel'];
  return {
    patientId: expectedPatient,
    asOf: value.asOf,
    narrative: value.narrative,
    decisionCard: {
      riskLevel,
      actionLevel,
      riskLabel: humanLabel(riskLevel, RISK_LEVEL_LABELS),
      actionLabel: humanLabel(actionLevel, ACTION_LEVEL_LABELS),
      title: value.decisionCard.title,
      action: value.decisionCard.action,
    },
    series,
  };
}

function summaryText(summary: Summary): string {
  const latest = summary.latestObservationAt ? at(summary.latestObservationAt) : '暂无';
  const alerts = summary.alerts.length
    ? summary.alerts.map(alert => `${humanLabel(alert.actionLevel, ACTION_LEVEL_LABELS)}（${humanLabel(alert.status, ALERT_STATUS_LABELS)}）`).join('、')
    : '暂无';
  return `${summary.patientDisplayName} · ${humanLabel(summary.lifeStage, LIFE_STAGE_LABELS)} · ${summary.observationsCount} 条记录\n最近记录：${latest}\n告警：${alerts}\n更新时间：${at(summary.updatedAt)}`;
}

function localDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function observedAtForDate(date: string): string {
  return date === localDate() ? new Date().toISOString() : new Date(`${date}T12:00:00`).toISOString();
}

function stagePresentation(stage: Summary['lifeStage']): { stageKicker: string; stageTitle: string; stageHint: string } {
  if (stage === 'TRANSITION') return {
    stageKicker: '成长过渡期 · 自主记录',
    stageTitle: '记录本次测量',
    stageHint: '安全记录按授权共享，心情记录有独立的隐私设置。',
  };
  if (stage === 'ADULT') return {
    stageKicker: '成人期 · 自主记录',
    stageTitle: '记录本次测量',
    stageHint: '联系人与共享范围可在「个人档案」调整。',
  };
  return {
    stageKicker: '儿童期 · 家长 / 照护者代录',
    stageTitle: '记录本次测量',
    stageHint: '请按体温计的实测数值填写。',
  };
}

function eventValue(event: { detail?: { value?: unknown } }): string {
  return typeof event.detail?.value === 'string' ? event.detail.value : '';
}

function eventValues(event: { detail?: { value?: unknown } }): string[] {
  return Array.isArray(event.detail?.value) ? event.detail.value.filter((value): value is string => typeof value === 'string') : [];
}

function followupCountdown(value: string): string {
  const days = Math.round((new Date(value.slice(0, 10) + 'T00:00:00').getTime() - new Date(localDate() + 'T00:00:00').getTime()) / 86400000);
  return days < 0 ? `已过 ${Math.abs(days)} 天` : days === 0 ? '今天复诊' : `剩余 ${days} 天`;
}

export function createRecordsPage(): Record<string, unknown> & ThisType<MiniPageContext> {
return {
  data: {
    entryMode: 'temperature',
    hubSymptoms: [] as Array<{ id: string; items: string[]; at: string; source: string }>,
    followupSummary: '未设定',
    followupPlace: '',
    vaccinationSummary: '接种日历',
    diarySummary: '仅本人可见',
    canOpenDiary: false,
    loading: true,
    saving: false,
    syncing: false,
    error: '',
    message: '',
    summaryText: '',
    recordCount: 0,
    latestRecordLabel: '暂无已确认记录',
    riskLabel: '待评估',
    riskAction: '完成记录后，系统会为你整理趋势',
    riskTone: 'neutral',
    screeningStatus: '正在确认',
    screeningDetail: '状态筛查会在复诊前开放，回答后由照护医生查看。',
    screeningReady: false,
    screeningLastRecord: '暂无已确认填写',
    recentRecords: [] as ObservationView[],
    historyRecords: [] as ObservationView[],
    historyExpanded: false,
    observationsNotice: '',
    medicationRecords: [] as MedicationPreview[],
    medicationNotice: '',
    followupLabel: '暂无已确认复诊日期',
    records: [] as ObservationView[],
    trend: null as TrendView | null,
    trendError: '',
    stageReady: false,
    lifeStage: 'CHILD' as Summary['lifeStage'],
    stageKicker: '儿童期 · 家长 / 照护者代录',
    stageTitle: '记录本次测量',
    stageHint: '请按体温计的实测数值填写。',
    symptomOptions: symptoms.map(item => ({ ...item, selected: false })),
    /** 按 group 分组后的展示结构，供 wxml 按组渲染 */
    symptomGroups: buildSymptomGroups(symptoms.map(item => ({ ...item, selected: false }))),
    selectedSymptoms: [] as string[],
    symptomsExpanded: false,
    symptomSummary: '未填写症状', selectedUrgency: '',
    temperature: '',
    lastTemperatureLabel: '',
    note: '', feeling: '', feelings: ['很好', '还好', '一般', '有点难受', '很难受'],
    observedDate: localDate(),
    today: localDate(),
    pendingCount: 0,
    rejectedCount: 0,
    unsentCount: 0,
    revision: 0,
    unsent: [] as RecordInput[],
  },
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  networkListener: null as ((result: { isConnected: boolean; networkType?: string }) => void) | null,
  queueFlight: null as Promise<void> | null,

  formScope: null as string | null,

  onShow() {
    this.formScope = sessionScope();
    const current = session();
    this.setData({ trend: null, trendError: '', records: [], recentRecords: [], historyRecords: [], historyExpanded: false, lastTemperatureLabel: '', symptomsExpanded: false, symptomSummary: '未填写症状', selectedUrgency: '', observationsNotice: '', summaryText: '', pendingCount: 0, rejectedCount: 0, unsentCount: 0 });
    if (!current) { wx.redirectTo({ url: '/pages/auth/index' }); return; }
    this.clearRetryTimer();
    const revision = (this.data.revision as number) + 1;
    this.setData({ canOpenDiary: current.role === 'PATIENT', hubSymptoms: [], followupSummary: '未设定', followupPlace: '', revision, loading: true, error: '', message: '', recentRecords: [], medicationRecords: [], medicationNotice: '', screeningLastRecord: '暂无已确认填写', followupLabel: '暂无已确认复诊日期', recordCount: 0, latestRecordLabel: '正在读取记录', riskLabel: '待评估', riskAction: '正在读取当前状态', riskTone: 'neutral', screeningStatus: '正在确认', screeningDetail: '状态筛查会在复诊前开放，回答后由照护医生查看。', screeningReady: false, temperature: '', note: '', feeling: '', selectedSymptoms: [], observedDate: localDate(), today: localDate(), unsent: [], unsentCount: 0, stageReady: false, symptomOptions: symptoms.map(item => ({ ...item, selected: false })), symptomGroups: buildSymptomGroups(symptoms.map(item => ({ ...item, selected: false }))) });
    this.refresh(revision);
  },

  onLoad(options: { mode?: string } = {}) {
    this.setData({ entryMode: options.mode === 'symptom' ? 'symptom' : 'temperature' });
    if (options.mode && wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: options.mode === 'symptom' ? '症状速记' : '体温记录' });
    if (!wx.onNetworkStatusChange) return;
    const listener = (result: { isConnected: boolean; networkType?: string }) => {
      if (!result.isConnected || !session() || this.data.saving || this.data.syncing) return;
      const scope = sessionScope();
      if (scope) this.retryQueueForScope(scope);
    };
    this.networkListener = listener;
    wx.onNetworkStatusChange(listener);
  },

  onUnload() {
    this.clearRetryTimer();
    if (this.networkListener && wx.offNetworkStatusChange) wx.offNetworkStatusChange(this.networkListener);
    this.networkListener = null;
  },

  clearRetryTimer() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  },

  scheduleRetry(revision: number, scope: string | null) {
    this.clearRetryTimer();
    const outbox = outboxForCurrentSession();
    if (!outbox || !this.isCurrent(revision, scope)) return;
    const next = outbox.nextRetryAt();
    if (next === null) return;
    const delay = Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.isCurrent(revision, scope)) void this.retryQueueForScope(scope);
    }, delay);
  },

  isCurrent(revision: number, scope: string | null): boolean {
    return this.data.revision === revision && sessionScope() === scope;
  },

  async refresh(revision: number): Promise<void> {
    const id = patientId();
    const scope = sessionScope();
    if (!id || !scope) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。' }); return; }
    try {
      const [summaryResult, observationsResult, trendResult, screeningResult, medicationResult, selfFollowupResult] = await Promise.allSettled([
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/summary`),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/observations?limit=20`),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/trend`),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/psych-screening-form`),
        request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/medications`),
        loadSelfFollowups({ userId: session()!.userId, actorId: session()!.actorId, patientId: id }),
      ]);
      if (!this.isCurrent(revision, scope)) return;
      const parsedSummary = summaryResult.status === 'fulfilled' ? parseSummary(summaryResult.value) : null;
      const summary = parsedSummary?.patientId === id ? parsedSummary : null;
      const observations = observationsResult.status === 'fulfilled' ? parseObservations(observationsResult.value, id) : null;
      const trend = trendResult.status === 'fulfilled' ? parseTrend(trendResult.value, id) : null;
      const observationsNotice = observations ? '' : observationsResult.status === 'rejected' ? '症状记录暂不可用，请刷新重试；其他记录仍可查看。' : '患者记录响应格式无效，未更新当前记录。';
      const summaryNotice = summary ? '' : summaryResult.status === 'rejected' ? '患者档案暂不可用，核对成功前不能新增症状记录。' : '患者摘要响应格式无效，核对成功前不能新增症状记录。';
      const records = observations?.records ?? [];
      const historyRecords = records.slice().sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)).map(record => ({ ...record, valueText: record.valueNumeric === undefined ? '已记录' : formatMeasurement(record.valueNumeric, record.unit), sourceLabel: OBSERVATION_SOURCE_LABELS[record.source], observedAt: at(record.observedAt) }));
      const symptomGroups = new Map<string, { id: string; items: string[]; at: string; source: string }>();
      for (const record of records.filter(item => item.code.startsWith('SYMPTOM_')).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))) {
        const key = `${record.observedAt}:${record.source}`;
        const group = symptomGroups.get(key) ?? { id: record.id, items: [], at: at(record.observedAt), source: OBSERVATION_SOURCE_LABELS[record.source] };
        group.items.push(record.display); symptomGroups.set(key, group);
      }
      const latest = records.length
        ? records.slice().sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0]
        : null;
      const riskLabel = trend ? trend.decisionCard.riskLabel : summary ? summary.alerts.length ? '有待确认提醒' : '暂无提醒' : '待评估';
      const riskAction = trend ? trend.decisionCard.action : '先完成今天的体温和症状记录';
      const riskTone = trend?.decisionCard.actionLevel === 'ACT_NOW' ? 'critical' : trend?.decisionCard.actionLevel === 'REVIEW' ? 'watch' : trend ? 'safe' : 'neutral';
      const screening = screeningResult.status === 'fulfilled' && object(screeningResult.value) && screeningResult.value.patientId === id && Array.isArray(screeningResult.value.visits) ? screeningResult.value : null;
      const screeningVisits = screening ? screening.visits as unknown[] : [];
      const screeningReady = screeningVisits.some(item => object(item) && item.status === 'AVAILABLE' && (item.expiresAt === undefined || typeof item.expiresAt === 'string' && Date.parse(item.expiresAt) > Date.now()));
      const screeningComplete = screeningVisits.some(item => object(item) && item.status === 'SUBMITTED');
      const screeningStatus = screeningReady ? '待完成' : screeningComplete ? '本次已完成' : screening ? '暂未开放' : '暂时不可用';
      const screeningDetail = screeningReady ? '复诊前用 1 分钟填写，帮助医生了解最近的状态。' : screeningComplete ? '你的回答已提交，复诊时照护团队会与你确认后续安排。' : screening ? '当前没有开放的复诊窗口，可以先记录症状和自记复诊日期。' : '可以打开页面重新读取；当前状态不会影响体温和症状记录。';
      const nextVisit = screeningVisits.filter((item): item is Record<string, unknown> => object(item) && typeof item.startsAt === 'string' && Number.isFinite(Date.parse(item.startsAt)) && Date.parse(item.startsAt) >= Date.now()).sort((left, right) => Date.parse(String(left.startsAt)) - Date.parse(String(right.startsAt)))[0];
      const medicationRecords = medicationResult.status === 'fulfilled' ? medicationPreview(medicationResult.value, id) : null;
      this.setData({
        summaryText: summary ? summaryText(summary) : '', recordCount: summary?.observationsCount ?? records.length,
        latestRecordLabel: observationsNotice ? '最近记录暂不可用' : latest ? `${latest.display} · ${at(latest.observedAt)}` : '暂无已确认记录',
        riskLabel, riskAction, riskTone, screeningStatus, screeningDetail, screeningReady,
        screeningLastRecord: screeningComplete ? '本次复诊已填写 · 时间待照护团队确认' : screening ? '暂无已确认填写' : '填写状态暂不可用',
        followupLabel: nextVisit ? at(String(nextVisit.startsAt)) : screening ? '暂无已确认复诊日期' : '复诊安排暂不可用',
        medicationRecords: medicationRecords ?? [], medicationNotice: medicationRecords ? '' : '用药记录暂不可用，可进入用药管理查看。',
        recentRecords: historyRecords.slice(0, 3), historyRecords, hubSymptoms: [...symptomGroups.values()].slice(0, 2),
        followupSummary: nextVisit ? followupCountdown(String(nextVisit.startsAt)) : '未设定',
        followupPlace: nextVisit && typeof nextVisit.hospital === 'string' ? nextVisit.hospital : '',
        observationsNotice, records, trend, lastTemperatureLabel: lastTemperatureLabel(records), stageReady: Boolean(summary),
        ...(summary ? { lifeStage: summary.lifeStage, ...stagePresentation(summary.lifeStage) } : {}),
        trendError: trendResult.status === 'rejected' || !trend ? '趋势与行动卡暂不可用，记录仍可正常使用。' : '',
        error: summaryNotice,
      });
      const selfFollowup = selfFollowupResult.status === 'fulfilled' ? nextSelfFollowup(selfFollowupResult.value, localDate()) : undefined;
      if (selfFollowup) this.setData({ followupSummary: followupCountdown(selfFollowup.date), followupPlace: selfFollowup.hospital || '医院待确认', followupLabel: `${selfFollowup.date} · 自记安排${nextVisit ? `（医院安排：${at(String(nextVisit.startsAt))}）` : ''}` });
      this.syncQueue(revision, scope);
    } catch (error) {
      if (this.isCurrent(revision, scope)) this.setData({ trend: null, records: [], recentRecords: [], historyRecords: [], lastTemperatureLabel: '', summaryText: '', pendingCount: 0, rejectedCount: 0, unsentCount: 0, stageReady: false, error: error instanceof Error ? error.message : '患者记录读取失败。' });
    } finally {
      if (this.isCurrent(revision, scope)) this.setData({ loading: false });
    }
  },

  syncQueue(revision: number, scope: string | null): void {
    const outbox = outboxForCurrentSession();
    if (!outbox || !this.isCurrent(revision, scope)) return;
    try {
      const entries = outbox.entries();
      this.setData({ pendingCount: entries.filter(entry => entry.state === 'PENDING').length, rejectedCount: entries.filter(entry => entry.state === 'REJECTED').length });
      this.scheduleRetry(revision, scope);
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : '待提交记录读取失败。' }); }
  },

  setTemperature(event: { detail?: { value?: unknown } }): void {
    if (this.data.loading || !this.data.stageReady || this.data.saving) return;
    this.setData({ temperature: eventValue(event), error: '' });
  },

  setTemperatureSlider(event: { detail?: { value?: unknown } }): void {
    if (this.data.loading || !this.data.stageReady || this.data.saving) return;
    const value = event.detail?.value; if (typeof value === 'number' && value >= 34 && value <= 43) this.setData({ temperature: value.toFixed(1), error: '' });
  },
  setNote(event: { detail?: { value?: unknown } }): void { if (!this.data.saving) this.setData({ note: eventValue(event).slice(0, 1500) }); },
  selectFeeling(event: { currentTarget?: { dataset?: { feeling?: string } } }): void { const feeling = event.currentTarget?.dataset?.feeling; if (!this.data.saving && feeling && this.data.feelings.includes(feeling)) this.setData({ feeling: this.data.feeling === feeling ? '' : feeling }); },
  toggleSymptoms(): void {
    if (this.data.loading || !this.data.stageReady || this.data.saving) return;
    this.setData({ symptomsExpanded: !this.data.symptomsExpanded });
  },

  toggleHistory(): void { this.setData({ historyExpanded: !this.data.historyExpanded }); },

  setObservedDate(event: { detail?: { value?: unknown } }): void {
    if (this.data.loading || !this.data.stageReady || this.data.saving) return;
    this.setData({ observedDate: eventValue(event) || localDate(), error: '' });
  },

  setSymptoms(event: { detail?: { value?: unknown } }): void {
    if (this.data.loading || !this.data.stageReady || this.data.saving) return;
    const selected = eventValues(event);
    const updatedOpts = symptoms.map(item => ({ ...item, selected: selected.includes(item.code) }));
    this.setData({ selectedSymptoms: selected, symptomOptions: updatedOpts, symptomGroups: buildSymptomGroups(updatedOpts), symptomSummary: updatedOpts.filter(item => item.selected).map(item => item.label).join('；') || '未填写症状', selectedUrgency: updatedOpts.some(item => item.selected && item.group === '需要立即急诊') ? '已选症状属于「需要立即急诊」，请按家庭应急预案处理；不要等待保存记录或站内回复。' : '', error: '' });
  },

  toggleSymptom(event: { currentTarget?: { dataset?: { code?: unknown } } }): void {
    const code = event.currentTarget?.dataset?.code;
    if (typeof code !== 'string' || !symptoms.some(item => item.code === code)) return;
    const selected = [...(this.data.selectedSymptoms as string[])];
    const index = selected.indexOf(code);
    if (index >= 0) selected.splice(index, 1); else selected.push(code);
    this.setSymptoms({ detail: { value: selected } });
  },

  async save(): Promise<void> {
    if (this.data.saving || this.data.loading || !this.data.stageReady) {
      if (!this.data.saving && (this.data.loading || !this.data.stageReady)) this.setData({ error: '正在核对患者档案，请稍后再保存。' });
      return;
    }
    if (this.data.entryMode !== 'symptom' && !(this.data.temperature as string).trim()) { this.setData({ error: '请填写本次实测体温，上次测量仅供参考。' }); return; }
    const current = session();
    const id = patientId();
    const scope = sessionScope(current);
    const outbox = outboxForCurrentSession();
    if (!current || !id || !scope || !outbox) { this.setData({ error: '当前会话已失效，请重新登录。' }); return; }
    let records: RecordInput[];
    try { records = this.data.entryMode === 'symptom'
      ? makeSymptomRecords(id, this.data.selectedSymptoms as string[], sourceForSession(current), observedAtForDate(this.data.observedDate as string))
      : makeRecords(id, Number(this.data.temperature as string), this.data.selectedSymptoms as string[], sourceForSession(current), observedAtForDate(this.data.observedDate as string)); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : '请填写有效记录。' }); return; }
    const notes = [this.data.feeling ? `本次感受：${this.data.feeling}` : '', String(this.data.note ?? '').trim()].filter(Boolean).join('\n');
    if (notes) records = records.map(record => ({ ...record, notes }));
    this.setData({ saving: true, error: '', message: '' });
    const result = await submitRecords(records, record => sendRecord(record, scope), outbox);
    if (sessionScope() !== scope) { this.setData({ saving: false, error: '身份已切换，当前记录未继续提交。' }); return; }
    if (result.error) {
      this.setData({ saving: false, error: result.error, unsent: result.remaining, unsentCount: result.remaining.length });
      this.syncQueue(this.data.revision as number, scope);
      return;
    }
    this.setData({ saving: false, temperature: '', note: '', feeling: '', selectedSymptoms: [], symptomsExpanded: false, symptomSummary: '未填写症状', selectedUrgency: '', symptomOptions: symptoms.map(item => ({ ...item, selected: false })), symptomGroups: buildSymptomGroups(symptoms.map(item => ({ ...item, selected: false }))), unsent: [], unsentCount: 0, message: result.queued ? `网络暂不可用，${result.queued} 条记录已保存，联网后可重试。` : `已确认 ${result.confirmed} 条记录。` });
    this.syncQueue(this.data.revision as number, scope);
    if (!result.queued) this.refresh(this.data.revision as number);
  },

  async retryUnsent(): Promise<void> {
    const unsent = this.data.unsent as RecordInput[];
    if (!unsent.length || this.data.saving) return;
    const scope = sessionScope();
    const outbox = outboxForCurrentSession();
    if (!scope || !outbox) { this.setData({ error: '身份已切换，请刷新当前页面。' }); return; }
    this.setData({ saving: true, error: '', message: '' });
    const result = await submitRecords(unsent, record => sendRecord(record, scope), outbox);
    if (result.error) this.setData({ saving: false, error: result.error, unsent: result.remaining, unsentCount: result.remaining.length });
    else { this.setData({ saving: false, unsent: [], unsentCount: 0, message: result.queued ? `${result.queued} 条记录已留在待提交队列。` : `已确认 ${result.confirmed} 条记录。` }); this.syncQueue(this.data.revision as number, scope); }
  },

  async retryQueue(): Promise<void> {
    if (this.data.syncing) return;
    const scope = sessionScope();
    const outbox = outboxForCurrentSession();
    if (!scope || !outbox) { this.setData({ error: '身份已切换，请刷新当前页面。' }); return; }
    await this.retryQueueForScope(scope, outbox, true);
  },

  async retryQueueForScope(scope: string, existingOutbox?: ReturnType<typeof outboxForCurrentSession>, force = false): Promise<void> {
    const outbox = existingOutbox ?? outboxForCurrentSession();
    if (!outbox || sessionScope() !== scope || this.data.syncing || this.queueFlight) return this.queueFlight ?? Promise.resolve();
    const flight = (async () => {
      this.setData({ syncing: true, error: '', message: '' });
      try {
        const result = await outbox.flush(record => sendRecord(record, scope), true, force);
        if (sessionScope() !== scope) throw new HttpFailure('身份已切换，请刷新当前页面。', 409);
        this.setData({ message: result.networkError ? '网络仍不可用，记录已保留，将按退避时间自动重试。' : `待提交队列已处理：确认 ${result.sent} 条，剩余 ${result.pending + result.rejected} 条。` });
        this.syncQueue(this.data.revision as number, scope);
      } catch (error) {
        // 401/403 分两种：会话已死（api.ts 已清本地会话）时这条身份队列整体作废，必须清掉；
        // 会话仍在则只是这次请求不被允许，患者自己报的体温和症状还没被医生看到，不能因为一次拒绝就丢。
        if (error instanceof HttpFailure && [401, 403].includes(error.status) && !session()) { try { outbox.clear(); } catch { /* keep original error */ } }
        this.setData({ error: error instanceof Error ? error.message : '待提交记录同步失败。' });
        this.syncQueue(this.data.revision as number, scope);
      } finally { this.setData({ syncing: false }); }
    })();
    this.queueFlight = flight;
    try { await flight; }
    finally { if (this.queueFlight === flight) this.queueFlight = null; }
  },

  load() {
    if (this.data.loading || this.data.saving || this.data.syncing) return;
    if (!this.formScope || this.formScope !== sessionScope()) { this.onShow(); return; }
    const revision = (this.data.revision as number) + 1;
    this.clearRetryTimer();
    this.setData({ revision, loading: true, error: '' });
    void this.refresh(revision);
  },
  /** 继续复用各项已有记录流程和权限边界。 */
  openSymptomEntry() { wx.navigateTo({ url: '/pages/patient/observation?mode=symptom' }); },
  openTemperatureEntry() { wx.navigateTo({ url: '/pages/patient/observation?mode=temperature' }); },
  openVaccinationEntry() { wx.navigateTo({ url: '/pages/patient/health?section=vaccination' }); },
  openDiaryEntry() {
    if (session()?.role !== 'PATIENT') { wx.showToast({ title: '私人记录仅患者本人可见', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/patient/health?section=diary' });
  },
  openMedicationEntry() { wx.navigateTo({ url: '/pages/patient/medications' }); },
  openFollowupEntry() { wx.navigateTo({ url: '/pages/patient/life-event?section=followup' }); },
  openAssessmentEntry() { wx.navigateTo({ url: '/pages/patient/screening' }); },
  openJoint() { wx.navigateTo({ url: '/pages/patient/joint' }); },
};
}
