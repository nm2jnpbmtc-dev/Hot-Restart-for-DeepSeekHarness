# Hot Restart for DeepSeek Harness

**改完插件代码或配置，不用关闭 DeepSeek Harness 就能生效。**

一个 [DeepSeek Harness](https://harness.deepseek.com) 插件：在聊天输入框的发送键左侧加一个绿色圆形按钮，点一下即触发一次 Profile 重组与插件热重载。

> A Harness plugin that adds a green hot-restart button next to the composer send action and re-applies the profile on demand — no app restart.

![发送键左侧的热重启按钮](screenshot.png)

> 绿色圆形按钮（截图红框处）就在发送键左侧，点一下即热重启。

---

## 为什么需要它

开发 Harness 插件时，插件通常以 `link:` 方式装进 Profile。而 Harness 自带的 HMR 只监听 **Profile 目录内的文件**（`cordis.patch.yml`、Profile 清单）。

结果是：**你改了自己工作区里的插件源码，什么都不会发生**，只能关掉整个应用重开——这就是"改插件必须重启 DSH"的来源。

这个插件把这步变成一个按钮：强制跑一次 `hmr.reconcileProfile()`，重新读配置，并把 Profile 目录与所有 `link:` 目标目录里的文件跟已加载模块逐一对账，有变化的当场替换、重启。

## 安装

前置条件：DSH 0.2.x；Profile 已启用 HMR（Web 与 Desktop 的默认 Profile 都启用，`dsh-hmr` 处于激活状态）。

```bash
git clone https://github.com/nm2jnpbmtc-dev/Hot-Restart-for-DeepSeekHarness.git
```

然后在 Harness 里二选一：

- **图形界面**：设置 → 插件 → 安装本地插件，选择上面克隆下来的目录。
- **让 Agent 装**：对它说"用 plugin_manager 安装这个目录"，即 `install_bundle`，`target` 填该目录的绝对路径。

> 不要只用 `pnpm add` 手动装：那样只会把包装进 Profile 的 `node_modules`，还需要把它加进 Profile 的 bundle 列表才会被激活。`install_bundle` 会一起做完。

装好后无需重启进程，插件行会立即激活。验证：聊天框输入 `/` 能看到「重启」这一项，且发送键左侧出现绿色按钮。

## 用法

三种入口，同一个操作：

| 入口 | 说明 |
| --- | --- |
| **绿色圆形按钮** | 输入框发送键左侧。图标旋转＝进行中，对勾＝完成，感叹号＝失败，琥珀色＝需要重启进程。悬停可看本次结果。 |
| `/restart` 命令 | 在聊天框输入，结果作为命令行出现在会话里。 |
| `hot_restart` 工具 | Agent 可调用。例如装完插件后让 Agent 立即让它生效。 |

## 它做了什么

```js
const hmr = ctx.get('hmr')
await hmr.runExclusive(() => hmr.reconcileProfile())
```

`reconcileProfile()` 是 Harness 自带的重载路径，会在同一次操作里：

1. 从 Profile 清单与 patch 文件重新组合配置；
2. 替换加载文件已改动（含 `link:` 目标）的插件模块；
3. 用当前文件与配置重新启动被停掉的条目；
4. 返回仍待重启的模块、警告与重启原因。

## 覆盖范围

| 场景 | 是否生效 |
| --- | --- |
| 改 `link:` 插件的源码（host 半） | ✅ |
| Profile / home 的 `cordis.patch.yml` | ✅ |
| 插件启停、bundle 增删 | ✅ |
| Profile 内 `node_modules` 就地更新的包 | ✅ |
| 改了插件的 `package.json` | ❌ 需重启（HMR 不检测 manifest 变更） |
| 插件牵进了 DSH 框架包（app-boot / Cordis / Loader） | ❌ 进程级依赖 |
| 插件包被移动位置 | ❌ 返回 `package-moved` |
| 只改客户端半（`client.js`） | 部分：host 已换，浏览器刷新页面即可 |

需要重启的情况会如实返回 `restart_required`，不会假装成功。

## 已知边界

- **不会重启进程**。桌面壳没有向页面暴露"重启 Host"的接口，进程级改动只能手动重启应用。
- 客户端插件新增的 `dsh.client` 条目需要刷新页面才会进入 boot graph。
- 按钮注册在 `conversation.input.right`（发送键前的紧凑控件位），与发送键同一行；进程内悬浮定位会在窗口尺寸变化时错位，因此未采用。

## 卸载

在 Harness 的插件管理里移除该 bundle（或 `plugin_manager` 的 `remove_bundle`），随后删除克隆下来的目录即可。

## 目录结构

```
Hot-Restart-for-DeepSeekHarness/
├── cordis.patch.yml    # bundle 的 Loader 补丁（插入 hot-restart 行）
├── index.js            # Host 半：/restart 命令、hot_restart 工具、POST 路由
├── client.js           # Client 半：发送键旁的绿色按钮
├── package.json        # dsh.bundle.patch + dsh.client 清单
├── locale/{en,zh}.json # 插件管理页的显示名与描述
├── icon.svg            # 插件图标
├── LICENSE
└── README.md
```

## 开发

改完 `index.js` 或 `client.js` 想立即生效，点那个绿色按钮就行——它本来就是为了解决这个循环做的。

客户端改动仍需刷新浏览器页面（`F5`），因为浏览器有自己的模块图。

## 日志

只在**重启失败**或**按钮崩溃**时记录；正常使用不写日志。

- 位置：`~/.dsh/logs/hot-restart.log`（设置了 `DSH_HOME` 时跟随它）
- 内容：时间戳、来源（`host` / `client`）、结果标签、错误消息
- 轮转：超过 256 KB 改名为 `hot-restart.log.1`，最多保留两份
- 隐私：不写模块 URL、绝对路径、配置内容、会话 ID；错误里的路径会被替换成 `<path>`，日志可以直接发给别人排障

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

- `1.1.0` — 新增失败日志与按钮崩溃兜底
- `1.0.1` — 修复重启 DSH 后按钮失效（红感叹号）的问题
- `1.0.0` — 首个版本：按钮、`/restart` 命令、`hot_restart` 工具

## License

MIT
