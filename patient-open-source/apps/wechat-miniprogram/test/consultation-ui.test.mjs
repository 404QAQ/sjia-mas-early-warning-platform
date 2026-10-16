import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('患者支持页提供远程求助/会诊申请、状态时间线与执行确认入口', async () => {
  const [script, markup, style] = await Promise.all([
    readFile(new URL('../src/pages/patient/support.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/support.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/support.wxss', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /\/consultations/);
  assert.match(script, /createConsultation/);
  assert.match(script, /acknowledgeConsultation/);
  assert.match(markup, /远程求助 \/ 会诊/);
  assert.match(markup, /发起会诊申请/);
  assert.match(markup, /确认我会按回复执行/);
  assert.match(style, /consultation-card/);
});
