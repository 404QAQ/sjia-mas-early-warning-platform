/**
 * 回测 / 影响预估 —— docs/02 §11、tech/01 §8。
 *
 * 实现 = 用历史数据重放引擎：对每个时间点调用 evaluate()，传入「那一刻」的观测值快照。
 * 这让「阈值调整」从盲调变成有依据的决策，也是「提前 N 天预警」这个头号验收指标的算法基础。
 *
 * 一期用同步实现（纯函数），api 层把它放进 worker_threads 或队列里跑。
 */
import type { EngineInput, Observation, ThresholdConfig } from '@mas/domain';
import { evaluate } from './index.js';
import { toMs } from './time.js';

export interface BacktestCase {
  patientId: string;
  /** 完整观测值（已按时间升序，含诊断日之前与之后） */
  observations: Observation[];
  /** 临床诊断（或人工认定的「应该报警」）时间；缺省则只统计告警量 */
  diagnosedAt?: string;
  /** 基线等其他输入的固定部分 */
  baseInput: Omit<EngineInput, 'observations' | 'now'>;
}

export interface CaseResult {
  patientId: string;
  /** 首次告警时间（各自配置下） */
  firstAlertAt: Record<string, string | null>;
  /** 相对诊断日的提前量（天，正数 = 提前） */
  leadTimeDays: Record<string, number | null>;
  alertCounts: Record<string, number>;
}

export interface BacktestResult {
  configs: string[];
  cases: CaseResult[];
  summary: Record<
    string,
    {
      totalAlerts: number;
      patientsAlerted: number;
      meanLeadTimeDays: number | null;
      /** 降低敏感性会让哪些病例晚被发现 —— 这句话只有在能算出「晚几天」时才有分量 */
      lateDiscoveries: Array<
        { patientId: string; status: 'DELAYED'; days: number } |
        { patientId: string; status: 'NOT_DETECTED'; days: null }
      >;
    }
  >;
}

export function backtest(
  cases: BacktestCase[],
  configs: ThresholdConfig[],
  options: { stepHours?: number; from?: string; to?: string } = {},
): BacktestResult {
  const stepHours = options.stepHours ?? 6;
  const labels = configs.map((c) => c.version);
  if (new Set(labels).size !== labels.length || labels.some((label) => !label.trim())) throw new RangeError('回测配置版本必须非空且唯一');
  timeSlices([], stepHours, options.from, options.to); // 即使没有病例也校验参数

  const caseResults: CaseResult[] = cases.map((c) => {
    if (c.patientId !== c.baseInput.patient.id || c.observations.some((o) => o.patientId !== c.patientId)) throw new RangeError('回测病例包含其他患者的数据');
    if (c.diagnosedAt !== undefined) toMs(c.diagnosedAt);
    const firstAlertAt: Record<string, string | null> = Object.create(null);
    const alertCounts: Record<string, number> = Object.create(null);
    // 历史重放按当时已经录入的数据计算；默认区间涵盖最后一条补录的到达时刻。
    const lastKnownAt = c.observations.reduce((max, o) => Math.max(max, toMs(o.observedAt), toMs(o.recordedAt)), -Infinity);
    const end = options.to ?? (Number.isFinite(lastKnownAt) ? new Date(lastKnownAt).toISOString() : undefined);
    const slices = timeSlices(c.observations, stepHours, options.from, end);

    for (const cfg of configs) {
      let first: string | null = null;
      let count = 0;
      for (const t of slices) {
        const snapshot = c.observations.filter((o) => toMs(o.observedAt) <= toMs(t) && toMs(o.recordedAt) <= toMs(t));
        if (snapshot.length === 0) continue;
        const out = evaluate({ ...c.baseInput, thresholds: cfg, observations: snapshot, now: t });
        const isAlert = out.actionLevel !== 'OBSERVE' || out.riskLevel === 'HIGH' || out.riskLevel === 'CRITICAL';
        if (isAlert) {
          count += 1;
          if (first === null) first = t;
        }
      }
      firstAlertAt[cfg.version] = first;
      alertCounts[cfg.version] = count;
    }

    const leadTimeDays: Record<string, number | null> = Object.create(null);
    for (const cfg of configs) {
      const f = firstAlertAt[cfg.version];
      leadTimeDays[cfg.version] =
        f && c.diagnosedAt ? Math.round(((toMs(c.diagnosedAt) - toMs(f)) / 86_400_000) * 10) / 10 : null;
    }

    return { patientId: c.patientId, firstAlertAt, leadTimeDays, alertCounts };
  });

  const summary: BacktestResult['summary'] = Object.create(null);
  for (const cfg of configs) {
    const leads = caseResults.map((c) => c.leadTimeDays[cfg.version]).filter((x): x is number => x !== null);
    const totalAlerts = caseResults.reduce((s, c) => s + (c.alertCounts[cfg.version] ?? 0), 0);
    const patientsAlerted = caseResults.filter((c) => c.firstAlertAt[cfg.version] !== null).length;

    const late: BacktestResult['summary'][string]['lateDiscoveries'] = [];
    if (configs.length > 1) {
      const baselineVersion = configs[0]!.version;
      for (const c of caseResults) {
        const base = c.firstAlertAt[baselineVersion];
        const cur = c.firstAlertAt[cfg.version];
        if (base && cur) {
          const d = Math.round(((toMs(cur) - toMs(base)) / 86_400_000) * 10) / 10;
          if (d > 0) late.push({ patientId: c.patientId, status: 'DELAYED', days: d });
        } else if (base && !cur) {
          late.push({ patientId: c.patientId, status: 'NOT_DETECTED', days: null });
        }
      }
    }

    summary[cfg.version] = {
      totalAlerts,
      patientsAlerted,
      meanLeadTimeDays: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null,
      lateDiscoveries: late,
    };
  }

  return { configs: labels, cases: caseResults, summary };
}

/** 时间切片：从最早观测值到最晚（或显式区间），按 stepHours 前进 */
export function timeSlices(observations: Observation[], stepHours: number, from?: string, to?: string): string[] {
  const stepMs = stepHours * 3_600_000;
  if (!Number.isFinite(stepMs) || stepMs < 1) {
    throw new RangeError('回测时间步长必须是至少 1 毫秒的有限正数');
  }
  const explicitStart = from === undefined ? undefined : toMs(from);
  const explicitEnd = to === undefined ? undefined : toMs(to);
  if (explicitStart !== undefined && explicitEnd !== undefined && explicitStart > explicitEnd) throw new RangeError('回测起始时间不能晚于结束时间');
  if (observations.length === 0) return [];
  const sorted = [...observations].map((o) => toMs(o.observedAt)).sort((a, b) => a - b);
  const start = explicitStart ?? sorted[0]!;
  const end = explicitEnd ?? sorted[sorted.length - 1]!;
  if (start > end) throw new RangeError('回测起始时间不能晚于结束时间');
  const count = Math.floor((end - start) / stepMs) + 1;
  if (Math.ceil((end - start) / stepMs) + 1 > 100_000) throw new RangeError('单次回测最多生成 100000 个时间切片，请缩小区间或增大步长');
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(start + i * stepMs).toISOString());
  }
  const endIso = new Date(end).toISOString();
  if (out[out.length - 1] !== endIso) out.push(endIso);
  return out;
}
