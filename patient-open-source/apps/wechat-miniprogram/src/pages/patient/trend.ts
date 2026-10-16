import { patientId, request, session } from '../../api';
import { monthDay } from '../../date-format.js';
import { formatMeasurement } from '../../measurement-format';
import { buildTrendChart, type ChartView } from '../../trend-chart';
import { observationActionCopy } from '../../action-card-presentation';

interface TrendPoint { at: string; value: number; unit: string; source: string }
interface TrendSeries { display: string; unit: string; points: TrendPoint[] }
interface TrendView {
  patientId: string;
  asOf: string;
  narrative: string[];
  decisionCard: { riskLevel: string; actionLevel: string; title: string; action: string };
  series: TrendSeries[];
}
interface TrendRow { display: string; latest: string; points: string; chart: ChartView; records: Array<{ at: string; value: string; source: string }>; }

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value); }
function parseTrend(value: unknown, expectedPatientId: string): TrendView {
  if (!object(value) || value.patientId !== expectedPatientId || !text(value.asOf, 100) || !Number.isFinite(Date.parse(value.asOf)) ||
    !Array.isArray(value.narrative) || !value.narrative.every(item => text(item)) || !object(value.decisionCard) ||
    !text(value.decisionCard.riskLevel, 32) || !text(value.decisionCard.actionLevel, 32) || !text(value.decisionCard.title, 200) || !text(value.decisionCard.action, 1000) || !Array.isArray(value.series)) throw new Error('趋势响应格式无效。');
  const series: TrendSeries[] = [];
  for (const raw of value.series) {
    if (!object(raw) || !text(raw.display, 200) || !text(raw.unit, 100) || !Array.isArray(raw.points)) throw new Error('趋势指标格式无效。');
    const points: TrendPoint[] = [];
    for (const point of raw.points) {
      if (!object(point) || !text(point.at, 100) || !Number.isFinite(Date.parse(point.at)) || typeof point.value !== 'number' || !Number.isFinite(point.value) || !text(point.unit, 100) || !text(point.source, 100)) throw new Error('趋势数据点格式无效。');
      points.push({ at: point.at, value: point.value, unit: point.unit, source: point.source });
    }
    series.push({ display: raw.display, unit: raw.unit, points });
  }
  const decisionCard = value.decisionCard as TrendView['decisionCard'];
  return { patientId: expectedPatientId, asOf: value.asOf, narrative: value.narrative as string[], decisionCard: { ...decisionCard, ...observationActionCopy(decisionCard.actionLevel, decisionCard.riskLevel) }, series };
}
function formatAt(value: string): string { return monthDay(value); }
function rowsOf(trend: TrendView): TrendRow[] {
  return trend.series.slice(0, 8).map(item => {
    const points = item.points.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-7);
    const last = points.at(-1);
    const sourceLabels: Record<string, string> = { LAB: '检验记录', MANUAL: '手动记录', PATIENT: '患者记录', DEVICE: '设备记录', DOCTOR: '医生记录', WECHAT: '小程序记录', IMPORT: '导入记录' };
    return { display: item.display, latest: last ? formatMeasurement(last.value, last.unit || item.unit) : '暂无记录',
      points: points.map(point => `${formatAt(point.at)} ${point.value}`).join(' · '),
      chart: buildTrendChart(points, item.unit, item.display === '体温'),
      records: points.slice().reverse().map(point => ({ at: formatAt(point.at), value: formatMeasurement(point.value, point.unit || item.unit), source: sourceLabels[point.source] ?? '健康记录' })),
    };
  });
}

Page({
  data: {
    loading: true,
    error: '',
    trend: null as TrendView | null,
    rows: [] as TrendRow[],
    narrative: [] as string[],
    asOfText: '',
    actionTone: 'normal',
    expandedMetric: '',
  },
  scopeKey: '',
  generation: 0,
  onLoad() { this.onShow(); },
  onShow() {
    const current = session();
    const id = patientId();
    if (!current || !id) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。', trend: null, rows: [], narrative: [] }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const key = `${current.userId}:${current.actorId}:${id}`;
    if (key !== this.scopeKey) { this.setData({ trend: null, rows: [], narrative: [], expandedMetric: '' }); this.scopeKey = key; }
    this.load(id, key);
  },
  load(id: string, key?: string) {
    const expectedKey = key ?? this.scopeKey;
    const generation = ++this.generation;
    this.setData({ loading: true, error: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/trend`).then(value => {
      const current = session();
      if (generation !== this.generation || !current || patientId() !== id || `${current.userId}:${current.actorId}:${id}` !== expectedKey) return;
      const trend = parseTrend(value, id);
      this.setData({ trend, rows: rowsOf(trend), narrative: trend.narrative.slice(0, 4), asOfText: formatAt(trend.asOf), actionTone: trend.decisionCard.actionLevel === 'ACT_NOW' ? 'urgent' : trend.decisionCard.actionLevel === 'REVIEW' ? 'watch' : 'normal', error: '' });
    }).catch(error => {
      if (generation === this.generation && this.scopeKey === expectedKey) this.setData({ trend: null, rows: [], narrative: [], asOfText: '', error: error instanceof Error ? error.message : '趋势暂不可用。' });
    }).finally(() => { if (generation === this.generation && this.scopeKey === expectedKey) this.setData({ loading: false }); });
  },
  toggleRecords(event: { currentTarget: { dataset: { display: string } } }) {
    const display = event.currentTarget.dataset.display;
    this.setData({ expandedMetric: this.data.expandedMetric === display ? '' : display });
  },
  refresh() { const id = patientId(); if (id) this.load(id); },
});

export { parseTrend, rowsOf };
