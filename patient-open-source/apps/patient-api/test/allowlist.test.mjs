import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPatientRoute } from '../src/allowlist.mjs';

test('患者端白名单允许小程序能力', () => {
  assert.equal(isAllowedPatientRoute('GET', '/api/v1/patients/patient-demo/summary'), true);
  assert.equal(isAllowedPatientRoute('GET', '/api/v1/patients/patient-demo/private-diary/share'), true);
  assert.equal(isAllowedPatientRoute('POST', '/api/v1/patients/patient-demo/observations'), true);
  assert.equal(isAllowedPatientRoute('GET', '/api/v1/patients/patient-demo/psych-screening-form'), true);
  assert.equal(isAllowedPatientRoute('POST', '/api/v1/emergency-shares/demo-share/revoke'), true);
});

test('患者资源不接受未登记的额外路径段', () => {
  for (const [method, path] of [
    ['GET', '/api/v1/patients/patient-demo/summary/extra'],
    ['GET', '/api/v1/patients/patient-demo/medications/extra'],
    ['POST', '/api/v1/patients/patient-demo/observations/extra'],
    ['POST', '/api/v1/patients/patient-demo/medication-plans/reminder'],
  ]) assert.equal(isAllowedPatientRoute(method, path), false, `${method} ${path}`);
});

test('医生端与管理端路径不会注册', () => {
  for (const path of [
    '/api/v1/worklist',
    '/api/v1/patients/patient-demo/detail',
    '/api/v1/alerts/alert-1/routing',
    '/api/v1/care/shifts',
    '/api/v1/config/thresholds',
    '/api/v1/clinician/notification-profile',
    '/api/v1/metrics/ops',
    '/api/v1/delivery/callback',
  ]) assert.equal(isAllowedPatientRoute('GET', path), false, path);
});
