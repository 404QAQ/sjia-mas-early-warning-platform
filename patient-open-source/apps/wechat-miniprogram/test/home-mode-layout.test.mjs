import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const markup = await readFile(new URL('../src/pages/home/index.wxml', import.meta.url), 'utf8');

test('首页按生命阶段呈现设计稿要求的关键决策卡', () => {
  assert.match(markup, /patientStageLabel === '儿童期'/);
  assert.match(markup, /今天先记录/);
  assert.match(markup, /记录症状/);
  assert.match(markup, /patientStageLabel === '成长过渡期'/);
  assert.match(markup, /你的数据由你决定/);
  assert.match(markup, /查看隐私设置/);
  assert.match(markup, /patientStageLabel === '成人'/);
  assert.match(markup, /需要告诉家里吗/);
  assert.match(markup, /谁可以看我的数据/);
  assert.match(markup, /deferContact/);
  assert.match(markup, /已选择暂不通知/);
  assert.match(markup, /G1/);
  assert.match(markup, /G2/);
  assert.match(markup, /G3/);
});

test('首页阶段卡不制造自动通知承诺，也不恢复病友入口', () => {
  assert.match(markup, /默认不会自动通知紧急联系人/);
  assert.doesNotMatch(markup, /自动通知家属/);
  assert.doesNotMatch(markup, /病友与经验/);
});
