# 患者 API

`apps/patient-api/src/allowlist.mjs` 是公开 API 的单一白名单。服务在认证前判断方法和路径，未登记路径统一返回 `404 NOT_FOUND`。

## 认证

- `POST /api/v1/auth/wechat/login`
- `POST /api/v1/auth/wechat/bind`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/actors`
- `DELETE /api/v1/auth/wechat/binding`

本地 fixture 仅用于开发者工具演示。每次登录只签发一个 synthetic actor；免登录客户端可在登录请求中附带 `preferredSex: MALE|FEMALE` 选择对应的合成档案。访问令牌 1 小时过期，刷新令牌 7 天过期且刷新时撤销旧 access/refresh token。生产应接入组织自己的微信 code2Session、账户绑定、会话轮换和撤销服务。

## 患者数据

患者端页面使用的主要资源包括：

- `/patients/:id/summary`、`trend`、`visit-summary`、`observations`
- `medications`、`medication-wave`、`medication-screenings`、`medication-side-effects`
- `psych-screening-form`、`psych-screenings`、`psych-support`
- `messages`、`notifications`、`followups`、`consultations`、`education`、`resources`
- `clinical-archives`、`auxiliary-vitals`、`private-diary`、`family-history`、`vaccinations`
- `life-events`、`living-mode`、`school-disclosures`、`work-support`
- `transition-plan`、`transition-milestones`、`transition-readiness`、`remission`、`monitoring-intensity`
- `emergency-plan`、`emergency-kit`、`emergency-card`、`emergency-shares`
- `contacts`、`contact-authorizations`、`contact-safety/runs`、`crisis-page`

请求成功统一返回 `{ "data": ... }`；失败返回 `{ "error": { "code", "message" } }`。患者 ID 必须与当前会话的 actor 绑定，不一致时返回 403。

fixture 对摘要、趋势、用药读取、心理评估表单、观测和消息提供本地数据；其它已登记但未实现的写操作返回 `501 FIXTURE_NOT_IMPLEMENTED`，不会返回 `accepted: true`。生产 proxy 会拒绝非 JSON 或不符合 `{ data }`/`{ error }` 契约的上游响应，并拦截明显的令牌、密钥、内部调试和运维字段。

fixture 的观测和消息写入会拒绝未知字段、跨患者 `patientId`、非法时间、超范围文本和非有限数值；proxy 模式仍必须由上游患者服务执行完整的按路由 schema 校验。

## 医生接口边界

公开服务不注册以下类型的路由：风险队列、照护团队患者详情、告警 routing/handoff/SBAR、排班/请假/换班/交班、阈值配置与回测、照护团队通知配置、供应商回调、运维指标和管理审计。患者资源路径必须精确匹配，未登记的额外路径段返回 404。不要把组织内部的全量服务直接复制到公开仓库。
