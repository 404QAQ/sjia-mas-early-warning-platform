import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.Page = () => {};
const { formatMessages, messageBody, parseMessages } = await import('../dist/pages/patient/support.js');

const patientId = 'patient-1';
const body = '第一行\r\n第二行\n第三行\r第四行';

test('照护消息正文允许 CR/LF，保留多行内容', () => {
  assert.equal(messageBody(body), true);
  const response = { patientId, records: [{ message: { id: 'message-1', title: '复诊提醒', body }, read: null }] };
  assert.deepEqual(parseMessages(response, patientId), [{ id: 'message-1', title: '复诊提醒', body, read: false }]);
  assert.deepEqual(formatMessages(response, patientId), [`复诊提醒：${body} · 未读`]);
});

test('照护消息正文仍拒绝 NUL、空白正文和超长正文', () => {
  assert.equal(messageBody(`第一行\n第二行\0`), false);
  assert.equal(messageBody('\r\n\t'), false);
  assert.equal(messageBody('x'.repeat(20001)), false);
  const invalid = { patientId, records: [{ message: { id: 'message-1', title: '复诊提醒', body: `第一行\n第二行\0` }, read: null }] };
  assert.deepEqual(parseMessages(invalid, patientId), []);
  assert.deepEqual(formatMessages(invalid, patientId), []);
});
