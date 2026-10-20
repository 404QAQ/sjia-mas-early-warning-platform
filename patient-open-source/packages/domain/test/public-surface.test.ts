import { describe, expect, it } from 'vitest';
import * as publicDomain from '../dist/public-index.js';

describe('患者公开领域入口', () => {
  it('保留患者与引擎契约，隐藏工作台专用导出', () => {
    expect(publicDomain.CODE_TABLE).toBeDefined();
    expect(publicDomain.DIFFERENTIAL_RULE_DIRECTIONS).toBeDefined();
    expect('resolveCareContext' in publicDomain).toBe(false);
    expect('decideAlertRouting' in publicDomain).toBe(false);
    expect('createThresholdConfigSnapshot' in publicDomain).toBe(false);
    expect('ACTIONS' in publicDomain).toBe(false);
    expect('IGNORE_REASON_LABEL' in publicDomain).toBe(false);
  });
});
