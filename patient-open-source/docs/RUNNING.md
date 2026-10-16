# 运行与导入

## Windows

安装 Node.js 20 和 pnpm 9 后，在项目根目录打开 PowerShell：

```powershell
pnpm install
pnpm build
pnpm start:patient-api
```

命令可以在 PowerShell 或 Windows Terminal 中执行；也可以将下面内容保存为 `start-patient-api.cmd` 后双击：

```bat
@echo off
set PATIENT_DEMO_CODE=demo-auto-login
pnpm start:patient-api
pause
```

## 微信开发者工具

1. macOS/Linux 执行 `MAS_WECHAT_AUTO_DEMO=1 MAS_WECHAT_ALLOW_INSECURE_HTTP=1 pnpm build:miniprogram`；Windows PowerShell 执行：

   ```powershell
   $env:MAS_WECHAT_AUTO_DEMO='1'
   $env:MAS_WECHAT_ALLOW_INSECURE_HTTP='1'
   pnpm build:miniprogram
   ```

   Windows CMD 可使用：`set MAS_WECHAT_AUTO_DEMO=1 && set MAS_WECHAT_ALLOW_INSECURE_HTTP=1 && pnpm build:miniprogram`。
2. 在开发者工具中导入 `apps/wechat-miniprogram`，项目配置中的小程序根目录为 `dist/`。fixture 只使用匿名合成数据和本机免登录 code，不能用于公网或真机发布。
3. 开发者工具“详情 → 本地设置”勾选“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。
4. 启动 `pnpm start:patient-api`，编译并进入患者入口。

真机或生产发布必须使用备案 HTTPS 域名，不能使用本地 HTTP 和免登录演示模式。
