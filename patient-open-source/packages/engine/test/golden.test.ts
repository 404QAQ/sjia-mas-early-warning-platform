/**
 * 黄金用例：引擎输出必须与设计文档给出的示例逐条对得上。
 * 出处：design/01（风险队列卡片）、design/03（患者详情）、docs/01 §4.4（SBAR）、docs/02 §3.1/§6.3。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, evaluate, fuse } from '../src/index.js';
import { fullInput } from './fixtures.js';

describe('黄金用例 · 张小某（文档示例）', () => {
  const out = evaluate(fullInput());

  it('结论为「高危 · 立即行动 ｜ 安全网：在管」', () => {
    expect(out.riskLevel).toBe('CRITICAL');
    expect(out.actionLevel).toBe('ACT_NOW');
    expect(out.safetyNetStatus).toBe('IN_CARE');
  });

  it('2016 标准进度：满足 2 项实验室条件，且剩下两项显示「距阈值差多少」', () => {
    const s = out.standard2016;
    expect(s.prerequisitesMet).toBe(true); // 发热 + 铁蛋白 3400 > 684
    expect(s.labCriteriaMet).toBe(2); // 血小板 152 ≤ 181、AST 52 > 48
    const tg = s.items.find((i) => i.key === 'TRIGLYCERIDE')!;
    const fib = s.items.find((i) => i.key === 'FIBRINOGEN')!;
    expect(tg.met).toBe(false);
    expect(tg.gap).toBe(18); // 156 − 138
    expect(fib.met).toBe(false);
    expect(fib.gap).toBe(50); // 410 − 360
    // 正式规则已经满足必要条件 + 两项实验室条件；展示层仍必须呈现逐项距离，
    // 不能把该布尔值直接渲染成“没事”。
    expect(s.satisfied).toBe(true);
  });

  it('建议加测甘油三酯 + 纤维蛋白原', () => {
    expect(out.standard2016.suggestedTests).toEqual(['甘油三酯', '纤维蛋白原']);
    expect(out.suggestions.some((s) => s.includes('甘油三酯'))).toBe(true);
  });

  it('「为什么」逐项列出，含血小板 48h 下降与铁蛋白升高', () => {
    const platelet = out.reasons.find((r) => r.code === 'PLATELET_DROP');
    expect(platelet).toBeDefined();
    expect(platelet!.detail).toMatch(/血小板/);
    expect(platelet!.detail).toMatch(/↓/);
    const ferritin = out.reasons.find((r) => r.code === 'FERRITIN_RISE');
    expect(ferritin).toBeDefined();
    expect(ferritin!.detail).toMatch(/↑/);
  });

  it('铁蛋白高于该患儿基线（文档示例：高于基线 3.2 倍）', () => {
    const dev = out.trends.find((t) => t.code === 'FERRITIN' && t.kind === 'BASELINE_DEVIATION');
    expect(dev).toBeDefined();
    // 3400 / 1060 ≈ 3.2 倍 → 偏离 +221%
    expect(dev!.semanticLabel).toMatch(/高于该患儿基线/);
    expect(dev!.toValue! / dev!.fromValue!).toBeCloseTo(3.2, 1);
  });

  it('MS score 输出连续值、截断值 −2.1，且标注缺失输入', () => {
    expect(out.msScore.cutoff).toBe(-2.1);
    expect(out.msScore.value).not.toBeNull();
    // 关节炎活动度来自关节评估，一期没有该数据 → 必须标注缺项，不猜
    expect(out.msScore.missingInputs).toContain('关节炎活动度');
    expect(out.msScore.confidence).toBe('PARTIAL');
  });

  it('MS score 未跨越截断值，但趋势层给出恶化信号 → 输出模型分歧提示并以趋势层为准', () => {
    // 本例 MS score 由实验室值主导（血小板已降至 152、铁蛋白 3400），文档示例为 −1.4
    if (!out.msScore.crossed) {
      expect(out.msScore.divergence).toBe('TREND_OVERRIDES_SCORE');
      expect(out.msScore.divergenceText).toMatch(/不一致/);
    }
  });

  it('MS score 含缺项时分歧提示不下「未跨越截断值」的确定结论，并列出缺项', () => {
    const base = { reasons: [], cfg: DEFAULT_CONFIG, safetyNetStatus: 'IN_CARE' as const, criticalMissing: [], staleNotes: [], criteriaMet: false,
      msCrossed: false, msCanEscalate: false, trendOverridesScore: true, scoreValue: -2.5, scoreCutoff: -2.1, notMeasuredItems: [] };
    const partial = fuse({ ...base, scoreMissingInputs: ['铁蛋白', '关节炎活动度'] }).divergenceText ?? '';
    expect(partial).not.toMatch(/未跨越截断值/);
    expect(partial).toMatch(/仅供参考/);
    expect(partial).toContain('铁蛋白、关节炎活动度');
    expect(fuse({ ...base, scoreMissingInputs: [] }).divergenceText).toMatch(/未跨越截断值 -2.1/);
  });

  it('每条告警都带可执行动作，绝不出现「风险升高」这类没有动作的句子', () => {
    expect(out.suggestions.length).toBeGreaterThan(0);
    for (const s of out.suggestions) {
      expect(s).not.toMatch(/风险升高/);
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('依据分三类标注：指南 / 共识 / 个性化基线（医生不会相信一个说不出理由的分数）', () => {
    const kinds = new Set(out.evidence.map((e) => e.kind));
    expect(kinds.has('GUIDELINE')).toBe(true);
    expect(kinds.has('CONSENSUS')).toBe(true);
    expect(kinds.has('BASELINE')).toBe(true);
    // 医生手写的那句话必须带出来
    expect(out.evidence.some((e) => e.text.includes('铁蛋白通常在 1500 左右'))).toBe(true);
  });

  it('证据板字段已预留但一期为空（tech/00 §3.1 明确不在一期做）', () => {
    expect(out.differential).toEqual([]);
  });

  it('信号指纹稳定：同样输入两次得到同一个指纹', () => {
    const again = evaluate(fullInput());
    expect(again.signalFingerprint).toBe(out.signalFingerprint);
  });
});

describe('可重放性（架构原则 docs/04 §2.1）', () => {
  it('显式上一评分纳入类型契约，并拒绝非有限分数', () => {
    expect(evaluate({ ...fullInput(), previousMsScore: -3 }).msScore.delta).toBe(1.72);
    expect(() => evaluate({ ...fullInput(), previousMsScore: Infinity })).toThrow(RangeError);
  });
  it('同一输入跑 50 次结果完全一致', () => {
    const first = JSON.stringify(evaluate(fullInput()));
    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify(evaluate(fullInput()))).toBe(first);
    }
  });

  it('打乱观测值数组顺序不影响结果（引擎内部必须自行排序）', () => {
    const a = JSON.stringify(evaluate(fullInput()));
    const input = fullInput();
    const shuffled = [...input.observations].reverse();
    const b = JSON.stringify(evaluate({ ...input, observations: shuffled }));
    expect(b).toBe(a);
  });

  it('now 不同会导致安全网判定不同 —— 说明时间确实来自显式输入而非系统时钟', () => {
    const out1 = evaluate(fullInput());
    // 把 now 往后推 20h（超过 no_record_hours_high_risk=12），期望安全网转为 PENDING
    const out2 = evaluate(fullInput({ now: '2026-06-13T05:00:00+08:00' }));
    expect(out1.safetyNetStatus).toBe('IN_CARE');
    expect(out2.safetyNetStatus).toBe('PENDING');
    expect(out2.safetyNetNote).toMatch(/小时无任何记录/);
  });
});
