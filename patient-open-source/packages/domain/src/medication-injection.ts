import { parseCareInstant } from './time.js';
import type {
  MedicationColdChainEvent,
  MedicationInjectionAdministeredBy,
  MedicationInjectionSite,
  MedicationLog,
  MedicationPlan,
} from './medication.js';

export interface MedicationInjectionInput {
  injectionSite: MedicationInjectionSite;
  injectionAdministeredBy: MedicationInjectionAdministeredBy;
  coldChainEvent?: MedicationColdChainEvent;
}

export interface MedicationInjectionSiteSummary {
  lastSite?: MedicationInjectionSite;
  suggestedSite?: MedicationInjectionSite;
  consecutiveCount: number;
}

const SITES: readonly MedicationInjectionSite[] = ['LUQ', 'RUQ', 'LLQ', 'RLQ'];
const COLD_CHAIN_TYPES: readonly MedicationColdChainEvent['type'][] = ['UNREFRIGERATED', 'FROZEN', 'TEMPERATURE_EXCURSION', 'TRANSPORT_DELAY', 'OTHER'];

/** M-03 写入边界：只允许皮下注射计划带注射字段，并拒绝未来事实。 */
export function validateMedicationInjection(
  plan: Pick<MedicationPlan, 'route'>,
  input: MedicationInjectionInput | undefined,
  takenAt: string,
  now: string,
): MedicationInjectionInput | undefined {
  if (plan.route !== 'SC_INJECTION') {
    if (input !== undefined) throw new RangeError('非皮下注射计划不能写入注射字段');
    return undefined;
  }
  if (!input || !SITES.includes(input.injectionSite) || !['SELF', 'FAMILY', 'NURSE'].includes(input.injectionAdministeredBy)) throw new RangeError('注射记录必须包含合法的部位和注射人');
  if (parseCareInstant(takenAt) > parseCareInstant(now)) throw new RangeError('注射时间不能晚于当前时间');
  const event = input.coldChainEvent;
  if (event !== undefined) {
    if (!COLD_CHAIN_TYPES.includes(event.type) || !Number.isFinite(event.durationHours) || event.durationHours < 0) throw new RangeError('冷链事件字段无效');
    if (parseCareInstant(event.reportedAt) > parseCareInstant(now)) throw new RangeError('冷链事件报告时间不能晚于当前时间');
  }
  return { injectionSite: input.injectionSite, injectionAdministeredBy: input.injectionAdministeredBy, ...(event ? { coldChainEvent: { ...event } } : {}) };
}

/** 只读计算连续同部位次数和轮换建议；不作药品可用性或补打判断。 */
export function summarizeInjectionSites(planId: string, logs: readonly MedicationLog[]): MedicationInjectionSiteSummary {
  const history = logs.filter(log => log.planId === planId && log.injectionSite !== undefined)
    .sort((left, right) => parseCareInstant(right.takenAt) - parseCareInstant(left.takenAt) || right.id.localeCompare(left.id));
  const lastSite = history[0]?.injectionSite;
  if (!lastSite) return { consecutiveCount: 0 };
  let consecutiveCount = 0;
  for (const log of history) {
    if (log.injectionSite !== lastSite) break;
    consecutiveCount += 1;
  }
  const suggestedSite = SITES.find(site => site !== lastSite);
  return { lastSite, suggestedSite, consecutiveCount };
}
