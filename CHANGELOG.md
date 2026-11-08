# Changelog

本文件记录每个版本的变化。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-11-08

### 修复

- **重启 DSH 后按钮失效（显示红色感叹号）**
  - 现象：装好插件后功能正常，但重启一次 DSH，再点绿色按钮就变成红色感叹号。
  - 原因：插件在 DSH 启动阶段执行 `apply()` 时，`webServer` 服务还没就绪，`ctx.get('webServer')` 得到 `undefined`，注册路由的那段代码被静默跳过。于是按钮的 `POST /hot-restart/run` 落到 Web 前端兜底上，返回 `405 allow: GET, HEAD`，前端判定失败。
  - 修复：改为 `ctx.inject(['webServer'], …)`，等服务出现后再注册路由。它与模块级 `inject = [...]` 使用同一套 Cordis 激活门控，因此启动时序不再影响注册结果。
  - 验证：重启 DSH（端口变化）后，`GET` 返回 `405 allow: POST`（说明路由存在），`POST` 返回 `200` 与 JSON 结果。

### 变更

- 版本号 `1.0.0` → `1.0.1`（仅修复，无新增功能，无破坏性变更）。

## [1.0.0] - 2026-11-08

### 新增

- 发送键左侧的绿色圆形热重启按钮：进行中旋转、成功显示对勾、失败显示感叹号、需要重启进程时显示琥珀色，悬停可看本次结果。
- `/restart` 命令，结果显示为会话里的一行命令记录。
- `hot_restart` 工具，Agent 可调用。
- 同源 `POST /hot-restart/run` 路由，供按钮调用 Host 半。
- 中英文插件描述与图标。

### 说明

- 调用 `ctx.hmr.reconcileProfile()` 重新应用 Profile 并替换磁盘上已改动的插件模块。
- 进程级改动（改 `package.json`、牵进 DSH 框架包、插件包位移）无法热替换，会如实返回 `restart_required`。
