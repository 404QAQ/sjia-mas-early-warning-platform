# 公开内容清单

## 纳入

- 患者微信小程序源码、页面资源、测试和构建配置
- 患者 API 白名单边界、fixture 服务和内部患者 API 代理适配
- 患者端使用的领域模型与风险评估纯函数
- `packages/domain` 的公开包入口仅导出患者与引擎契约
- 脱敏后的运行说明、API 说明、架构说明、贡献指南和安全报告流程
- Apache-2.0 许可证

## 排除

- `apps/doctor-web`、医生端静态页面、医生端截图、PPT、交付包和部署材料
- 组织内部全量服务、未登记的管理路由和部署材料
- 线上 IP、端口、域名、账号、密码、AppSecret、数据库连接和真实患者数据
- `dist/`、`node_modules/`、临时目录、Playwright 产物、ZIP、PDF、DOCX、PPTX 和视频

## 公开前检查

```bash
find . -type d \( -name node_modules -o -name dist -o -name tmp \) -prune -o -type f -print
rg -n "YOUR_PROD_IP|PORT_A|PORT_B|password|secret|AppSecret|AKIA|doctor-web|/worklist|notification-profile" .
```

命中业务词不一定是泄露；发布前应逐项确认是否为患者端界面文案、测试断言或内部实现残留。任何真实凭证、线上地址和患者识别信息都必须删除或替换。
