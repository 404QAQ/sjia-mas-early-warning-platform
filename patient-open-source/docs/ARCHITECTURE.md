# 架构说明

```text
微信小程序
    │ HTTPS / 患者 API 白名单
    ▼
apps/patient-api
    ├─ fixture 模式：匿名化本地数据，供开发者工具演示
    └─ proxy 模式：只转发白名单路径到组织内部患者服务
             │
             ▼
       组织内部认证、患者数据、风险计算和存储
```

公开层只注册患者端路由，未知路径不会被转发；fixture 会话在本地校验患者 ID、actor ID 和 Bearer 会话，proxy 层只校验 Bearer 格式和患者路径是否带有 `x-actor-id`，不能解读组织的 opaque token。生产上游必须重新校验令牌、actor 与 URL 中患者 ID 的一致性，并只返回患者端 JSON 契约。

`packages/engine` 保持纯函数：输入患者观测、基线和当前时间，输出趋势、风险等级、行动级别、数据缺口和证据项。它不读数据库、不发送通知，也不包含医生工作台接口。

`packages/domain` 的发布入口是 `src/public-index.ts` 对应的 `dist/public-index.js`，只暴露患者端数据契约和风险引擎需要的常量；源码入口也只转出这一组公开契约。

生产部署建议把公开层放在 HTTPS 网关后，使用短时访问令牌、刷新令牌轮换、最小化日志、数据库加密、对象存储私有桶和可追溯审计。公开仓库只提供边界和本地 fixture，不包含组织的密钥或真实数据。
