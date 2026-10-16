/** 只调整已确认的观察级文案，不重新计算风险、行动级别或推断数据缺口。 */
export function observationActionCopy(actionLevel: unknown, riskLevel: unknown): { title: string; action: string } | null {
  if (actionLevel !== 'OBSERVE') return null;
  if (riskLevel === 'MEDIUM' || riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
    return {
      title: '按计划观察，仍需关注近期记录',
      action: '当前仍有需关注的记录，观察安排不代表指标正常。请继续记录并与照护团队核对；如有明显不适，请按已确认的家庭应急预案处理。不要自行停药或取消复诊。',
    };
  }
  return {
    title: '按计划观察并继续记录',
    action: '请按计划记录体温和症状，留意变化，并与照护团队核对近期情况。观察安排不代表指标正常；如有明显不适，请按已确认的家庭应急预案处理。不要自行停药或取消复诊。',
  };
}
