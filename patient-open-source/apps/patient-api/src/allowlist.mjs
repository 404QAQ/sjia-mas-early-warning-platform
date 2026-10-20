/**
 * 患者 API 的唯一路由清单。
 *
 * 这里故意不复用组织服务的全量 router。未知路径在认证前返回 404，
 * 公开服务只处理下方登记的患者端资源。
 */
const entries = [
  ['GET', /^\/$/], ['GET', /^\/health$/], ['GET', /^\/ready$/],
  ['POST', /^\/api\/v1\/auth\/wechat\/(login|bind)$/],
  ['POST', /^\/api\/v1\/auth\/(refresh|logout)$/],
  ['GET', /^\/api\/v1\/auth\/actors$/],
  ['DELETE', /^\/api\/v1\/auth\/wechat\/binding$/],
  ['GET', /^\/api\/v1\/patient\/push-template$/],
  ['GET', /^\/api\/v1\/notifications$/],
  ['POST', /^\/api\/v1\/notifications\/[^/]+\/confirm$/],
  ['GET', /^\/api\/v1\/messages$/], ['POST', /^\/api\/v1\/messages$/],
  ['POST', /^\/api\/v1\/messages\/[^/]+\/read$/],
  ['GET', /^\/api\/v1\/education$/], ['POST', /^\/api\/v1\/education\/[^/]+\/read$/],
  ['GET', /^\/api\/v1\/resources$/],
  ['GET', /^\/api\/v1\/followups$/],
  ['GET', /^\/api\/v1\/consultations$/], ['POST', /^\/api\/v1\/consultations$/],
  ['POST', /^\/api\/v1\/consultations\/[^/]+\/acknowledge$/],
  ['GET', /^\/api\/v1\/observations$/], ['POST', /^\/api\/v1\/observations$/],
  ['GET', /^\/api\/v1\/patients\/[^/]+\/(summary|trend|visit-summary|observations|medications|medication-wave|medication-reminders|medication-screenings|medication-side-effects|psych-screening-form|psych-screenings|psych-support|messages|notifications|followups|consultations|education|resources|care-summary|care-invites|audit|auxiliary-vitals|clinical-archives|private-diary|vaccinations|family-history|school-disclosures|life-events|living-mode|monitoring-intensity|remission|work-support|transition-plan|transition-milestones|transition-readiness|pregnancy-status|pregnancy-questions|fertility-content|joint-assessments|menstrual-cycle|data-sharing|contacts|contact-authorizations|contact-safety\/runs\/current|emergency-plan|emergency-kit|emergency-card|emergency-shares|crisis-page|lifecycle)$/],
  ['GET', /^\/api\/v1\/patients\/[^/]+\/private-diary\/(share|share-targets)$/],
  ['GET', /^\/api\/v1\/patients\/[^/]+\/artifacts(?:\/[^/]+(?:\/(url|content|revoke))?)?$/],
  ['GET', /^\/api\/v1\/patients\/[^/]+\/emergency-card\.(pdf|svg)$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/(observations|medication-logs|medications|medication-screenings|medication-side-effects|psych-screenings|psych-screening-form|self-followups|clinical-archives|auxiliary-vitals|private-diary|vaccinations|vaccinations\/records|vaccinations\/household|family-history|school-disclosures|life-events|living-mode|transition-readiness|pregnancy-status|pregnancy-questions|joint-assessments|menstrual-cycle|data-sharing|contacts|contact-authorizations|emergency-plan|emergency-kit|emergency-card|emergency-shares|crisis-page|contact-safety\/runs)$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/care-invites$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/care-invites\/[^/]+\/(revoke|remove)$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/artifacts$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/contacts\/[^/]+\/remove$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/lifecycle$/],
  ['PUT', /^\/api\/v1\/patients\/[^/]+\/(self-followups|clinical-archives|contacts|contact-authorizations|private-diary|school-disclosures)$/],
  ['PUT', /^\/api\/v1\/patients\/[^/]+\/(self-followups|clinical-archives|contacts|contact-authorizations|private-diary|school-disclosures)\/[^/]+$/],
  ['DELETE', /^\/api\/v1\/patients\/[^/]+\/(clinical-archives|private-diary|contacts|contact-authorizations|emergency-shares)$/],
  ['DELETE', /^\/api\/v1\/patients\/[^/]+\/(clinical-archives|private-diary|contacts|contact-authorizations|emergency-shares)\/[^/]+$/],
  ['POST', /^\/api\/v1\/patients\/[^/]+\/(medication-plans\/[^/]+\/(reminder|self-reported|review)|psych-screenings\/[^/]+\/(response|referral)|private-diary\/[^/]+\/share|emergency-shares\/[^/]+\/revoke|contact-authorizations\/[^/]+\/(grant|withdraw|confirm)|contact-safety\/runs\/[^/]+\/(cancel|scan|self-contact|snooze|revoke)|crisis-page\/actions)$/],
  ['GET', /^\/api\/v1\/contact-links\/[^/]+$/], ['POST', /^\/api\/v1\/contact-links\/[^/]+\/actions$/],
  ['GET', /^\/api\/v1\/emergency-shares\/[^/]+$/], ['POST', /^\/api\/v1\/emergency-shares\/[^/]+$/], ['POST', /^\/api\/v1\/emergency-shares\/[^/]+\/revoke$/],
];

export const publicRoutes = entries.map(([method, pattern]) => ({ method, pattern }));

export function isAllowedPatientRoute(method, pathname) {
  return entries.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(pathname));
}

export function isPublicRoute(method, pathname) {
  return method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/ready')
    || method === 'POST' && /^\/api\/v1\/auth\/(wechat\/(login|bind)|refresh|logout)$/.test(pathname)
    || method === 'GET' && /^\/api\/v1\/(contact-links|emergency-shares)\/[^/]+$/.test(pathname);
}

export function routeManifest() {
  return publicRoutes.map(({ method, pattern }) => ({ method, pattern: pattern.source }));
}
