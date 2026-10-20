# sJIA 患者端预警平台

这是面向患者、家属和照护者的微信小程序公开版，提供健康指标记录、趋势查看、用药记录、心理评估、复诊准备、消息与家庭应急资料等能力。公开服务只包含患者端 API 和风险评估所需的共享契约。

## 项目背景

sJIA 等系统性炎症性疾病的风险判断依赖连续的体温、实验室指标、症状和用药记录。患者端需要把这些信息整理成易读的趋势和行动卡，帮助患者在复诊前准备信息，也帮助家属了解需要关注的变化。

## 主要功能

- 性别意图入口与患者/家属身份选择
- 首页健康概览、体温与实验室指标趋势
- 异常提示、数据缺口和复诊前行动卡
- 用药计划、实际用药记录和提醒入口
- 心理评估、随访、复诊安排和消息查看
- 临床资料、私人日记、家庭史、疫苗和生活事件记录
- 家庭应急预案、应急卡片、联系人安全演练
- 过渡期、校园与工作支持等患者自主管理页面

## 技术方案

- `apps/wechat-miniprogram`：微信小程序源码，页面、请求封装、数据校验和本地待提交队列均在此目录。
- `apps/patient-api`：患者专用 API 边界。默认提供匿名化本地 fixture，亦可配置为只代理到组织内部的患者 API。
- `packages/domain`：患者端领域模型和数据契约；公开入口只导出患者端契约。
- `packages/engine`：无 IO 的多层风险评估纯函数，可在服务端或离线任务中复用。

公开 API 使用显式白名单：未知路径在认证前直接返回 404，代理模式也只转发登记的患者端资源。

## 运行要求

- macOS、Windows 或 Linux
- Node.js 20.10～20.x
- pnpm 9.x
- 微信开发者工具（导入小程序时选择 `apps/wechat-miniprogram`，开发者工具项目目录指向构建后的 `dist/`）

```bash
pnpm install
pnpm build
pnpm test
```

启动本地患者 API：

```bash
PATIENT_DEMO_CODE=demo-auto-login pnpm start:patient-api
```

本地 fixture 服务监听 `http://127.0.0.1:4302`，只绑定回环地址。它只接受 `demo-auto-login` 作为本地演示登录凭证，并且每个会话只绑定一个匿名合成患者身份；免登录包选择男性入口时会绑定 `patient-male`，女性或未选择时使用默认档案，也可以通过 `PATIENT_DEMO_PATIENT_ID=patient-male` 设置默认档案。这些数据和登录方式禁止暴露到公网，也不代表生产认证方案。需要使用免登录演示包时，在构建小程序前设置：

```bash
MAS_WECHAT_AUTO_DEMO=1 MAS_WECHAT_ALLOW_INSECURE_HTTP=1 pnpm build:miniprogram
```

生产或真机包必须设置组织自己的 HTTPS API 地址：

```bash
MAS_WECHAT_API_BASE=https://patient-api.example.org pnpm build:miniprogram
```

### 代理内部患者 API

当组织已有经过认证的患者服务时，可将 API 设为代理模式：

```bash
PATIENT_API_MODE=proxy PATIENT_UPSTREAM_URL=https://internal-patient-api.example.org pnpm start:patient-api
```

代理层仍会先执行公开白名单，医生路径不会被转发；上游地址必须是可信的 HTTPS 患者服务，代理请求有 10 秒超时且不跟随上游重定向。代理层只检查 Bearer 格式和患者路径的 `x-actor-id` 是否存在，无法解读组织的 opaque token；上游必须重新校验令牌、actor 与 URL 中患者 ID 的一致性，并只返回患者端 JSON 契约。`PATIENT_CORS_ORIGIN` 必须是单个明确的 HTTP/HTTPS origin，不能设为 `*`。生产部署还应在网关、数据库、对象存储和日志系统中按组织安全策略配置访问控制、审计、加密和备份。

fixture 只实现本地演示所需的摘要、趋势、用药读取、心理评估表单、观测和消息写入；其它已登记但未实现的写操作返回 `501 FIXTURE_NOT_IMPLEMENTED`，不会伪报保存成功。

## 团队与 Demo

- 团队成员：请在发布前由项目维护者补充姓名、职责和 GitHub 用户名；当前目录不编造成员信息。
- 魔搭 Demo：暂无公开魔搭链接。

## 许可证

本项目采用 Apache License 2.0，详见 [LICENSE](./LICENSE)。

更多内容见：

- [公开内容清单](./PUBLIC_CONTENTS.md)
- [API 白名单与响应约定](./docs/API.md)
- [架构说明](./docs/ARCHITECTURE.md)
- [运行与小程序导入说明](./docs/RUNNING.md)
- [安全报告流程](./SECURITY.md)
- [贡献指南](./CONTRIBUTING.md)
