---
type: report
title: DSH 桌面端启动异常与插件服务依赖修复（2026-11-07）
date: 2026-11-07
app: @deepseek-ai/dsh-desktop 0.2.1-rc.2
plugins: [dsh-better-sidebar 0.24.1, huahua-dsh-memory-os 1.6.3, @michengai/dsh-agency-agents 1.2.9]
tags: [dsh, startup, better-sidebar, hos, cordis, inject, service-dependency]
---

# DSH 启动异常与插件服务依赖修复

> 一句话：本轮启动问题由四件事叠加——**认证 Cookie 溢出、agency-agents 反复重载 profile、
> workspaceController 启动时序、两个插件的服务依赖声明不匹配**。
> 前三个已定位并处理；后两个（better-sidebar、HOS turn-anchor）已打补丁并验证。

---

## 一、现象清单

| # | 现象 | 性质 |
|---|---|---|
| 1 | 启动直接失败，无 Host 进程，`desktop welcome: Web authentication failed` | Cookie 溢出 |
| 2 | 启动后窗口隐藏 4 分钟以上 | agency-agents 性能缺陷 |
| 3 | 打开文件夹报 `workspaceController is unavailable` | 启动时序 / 请求过早 |
| 4 | `better-sidebar ... pending (waiting for service: webRuntime)` | 服务名不匹配 |
| 5 | HOS `turn-anchor observeSession 失败: cannot get property "sessionQuery" without inject` ×20+ | inject 声明缺失 |

本报告重点记录 #4、#5 的根因与修复；#1–#3 作为关联启动修复一并归档。

---

## 二、better-sidebar 一直 pending

### 2.1 现象

启动 stderr：

```text
dsh: warning: 1 entry did not activate
better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)
```

Loader 中该条目长期 `state 0 (pending)`，节点侧路由（文件树、open tools 等）没有挂载。

### 2.2 根因

`dsh-better-sidebar@0.24.1` 声明：

```js
const inject = ["webServer", "sessions", "webRuntime", "tools"]
```

但 DSH 0.2.1-rc.2 没有 `webRuntime` 服务。提供 `trustedHosts` 的服务实际注册名是 **`connection`**：

```js
// @deepseek-ai/dsh-client-connection/lib/index.js
super(ctx, "connection")
this.trustedHosts = trustedHosts

// @deepseek-ai/dsh-web/lib/index.js
super(ctx, "web")   // web 是搜索/抓取运行时，不是 trustedHosts 提供者
```

Cordis 的激活条件是 `inject` 中所有服务就绪；`webRuntime` 永远不出现，于是条目永久 pending。
本质是**插件按另一个宿主版本的服务名写死，与当前内核的 `connection` 对不上**。

实测上下文：

```text
better-sidebar entry state: 0
entry.ctx.get('connection')  → true
entry.ctx.get('webRuntime')  → false
root.get('connection')       → true
root.get('webRuntime')       → false
```

### 2.3 修复

安装副本：`...\profiles\desktop\node_modules\dsh-better-sidebar\lib\index.js`

```diff
- const inject = ["webServer", "sessions", "webRuntime", "tools"]
+ const inject = ["webServer", "sessions", "connection", "tools"]

- const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
+ const fence = (req) => isTrustedApiRequest(req, ctx.connection.trustedHosts)
```

备份：`lib/index.js.bak-20261107-connection-service`，`node --check` 通过。

验证：条目变为 `state 2 (active)`，启动警告消失。

### 2.4 注意

这是**兼容性补丁**，不是插件官方修复。better-sidebar 更新后若又改回 `webRuntime`，
会再次 pending；届时按同样方式改回 `connection`，或换用与当前 DSH 匹配的插件版本。

---

## 三、HOS turn-anchor 的 sessionQuery inject 错误

### 3.1 现象

启动 stderr 重复 20+ 次：

```text
[dsh-memory-evolve] turn-anchor observeSession 失败:
Error: cannot get property "sessionQuery" without inject
```

功能性影响不大（最终会走磁盘兜底），但会刷日志、浪费一次查询。

### 3.2 根因

`huahua-dsh-memory-os/lib/bookmarks.js:623`：

```js
const sessionQuery = ctx.sessionQuery ?? ctx.get?.('sessionQuery')
```

而 HOS 的 `inject` 列表（`lib/index.js:76`）只有：

```js
['tools', 'systemPrompt', 'agents', 'workspaceRegistry',
 'sessionTitle', 'sessionPersistence', 'settings', 'llm']
```

没有 `sessionQuery`。Cordis 对未 inject 的服务**属性访问**会直接抛：

```text
cannot get property "sessionQuery" without inject
```

所以 `ctx.sessionQuery` 先抛，后面的 `ctx.get(...)` 兜底永远执行不到——作者本意是
“动态取、不写进 inject，避免旧宿主没有该服务时插件永久 pending”，但代码写成了
先访问受保护的属性。

`/turn-anchor` 由书签 UI 按轮次/会话逐个请求。对非活跃会话：

1. 路径 1（live agent）拿不到事件；
2. 路径 2 抛 inject 错误并打日志；
3. 路径 3 读磁盘兜底，仍能返回结果。

20+ 次就是启动时书签请求的轮次数。

### 3.3 修复

```diff
- // 动态取（不在 inject 声明里声明，避免旧快照无该服务时插件永久 pending）
- const sessionQuery = ctx.sessionQuery ?? ctx.get?.('sessionQuery')
+ // 动态取（不在 inject 声明里声明，避免旧快照无该服务时插件永久 pending）。
+ // 必须只走 ctx.get：未 inject 时读 ctx.sessionQuery 会先抛
+ // "cannot get property ... without inject"，后面的 ?? 根本执行不到。
+ const sessionQuery = ctx.get?.('sessionQuery')
```

修改位置：

- 已安装：`...\node_modules\huahua-dsh-memory-os\lib\bookmarks.js`
- 仓库：`...\_publish\huahua-dsh-memory-os\lib\bookmarks.js`
- 备份：两边均 `bookmarks.js.bak-20261107-sessionquery-get`

验证：

```text
GET /memory-evolve/api/bookmarks/turn-anchor?sessionId=...&turn=1
→ HTTP 200 {"turn":1,"seq":18}
```

启动日志不再出现 `observeSession 失败`；HOS 条目保持 `state 2 (active)`。

---

## 四、关联的启动修复（同一轮）

### 4.1 认证 Cookie 溢出

- 71 个 `dsh-auth-*` Cookie，总头 16,117 B，叠加其他请求头后超过 Node 16 KB 限制；
- 宿主返回认证失败，桌面端无 Host 进程；
- 崩溃日志：`desktop welcome: Web authentication failed`。

处理：

- 备份 Cookie 库：`...\Network\Cookies.bak-20261107-before-cookie-prune`
- 清空 71 个 `dsh-auth-*` Cookie
- `D:\DSH\resources\app\lib\main.js` 增加 `pruneStaleHostAuthCookies()`，每次启动在 Host 启动前自动清理
- 备份：`main.js.bak-20261107-auth-cookie-prune`

### 4.2 agency-agents 反复重载 profile

CPU profile 栈：

```text
agency-agents/src-BAu01ObW.js:1954
  → dsh-settings.get('locale')
  → dsh-config-editor configuration()
  → dsh-app-boot loadProfileDirectory()
  → existsSync / readFileUtf8 / structuredClone
```

每次工具 schema/描述读取语言都会重载完整 profile，启动被拖到 4 分钟以上，窗口不显示。

处理：

- locale reader 改为缓存 `return () => current;`
- 语言变化继续由 `settings/document-updated` / `internal/status` 的 scheduleRefresh 处理
- 备份：`src-BAu01ObW.js.bak-20261107-locale-cache`
- 修复后启动：13.6s / 17.4s / 17.7s / 20.2s（窗口可见）

### 4.3 workspaceController 启动时序

- 报错：`gateway/service-unavailable: workspace/create: active Service "workspaceController" is unavailable`
- 实测服务在启动后 **8.2s** 已可用，窗口 **17.7s** 才显示，服务比 UI 早约 9.5s
- 判断为请求落在宿主启动/重启窗口期（当时 agency-agents 还在拖慢启动）
- 未改代码；修复 agency 启动性能后，服务在 UI 出现前已就绪

### 4.4 诊断设施

为捕获宿主启动告警，`main.js` 增加了 Host stderr 落盘：

```js
appendFileSync("D:\\DSH\\design-probe\\host-stderr.log", chunk)
```

备份：`main.js.bak-20261107-host-stderr-tee`。日志路径：`D:\DSH\design-probe\host-stderr.log`。

---

## 五、验证结果

| 检查项 | 结果 |
|---|---|
| better-sidebar 条目状态 | `state 2 (active)` |
| HOS 条目状态 | `state 2 (active)` |
| workspaceController | 存在且可解析 |
| 启动 stderr | 不再出现 pending / `without inject` |
| turn-anchor 接口 | HTTP 200，返回 `seq:18` |
| 窗口显示 | 启动后 20.2s 可见（含大会话恢复） |

---

## 六、文件与备份

```text
better-sidebar
  已安装  D:\DSH\dsh-home\profiles\desktop\node_modules\dsh-better-sidebar\lib\index.js
  备份    ...\lib\index.js.bak-20261107-connection-service

HOS bookmarks
  已安装  ...\node_modules\huahua-dsh-memory-os\lib\bookmarks.js
  备份    ...\lib\bookmarks.js.bak-20261107-sessionquery-get
  仓库    C:\Users\cosmo\Documents\deepseek-harness\default-workspace\_publish\huahua-dsh-memory-os\lib\bookmarks.js
  仓库备份 ...\lib\bookmarks.js.bak-20261107-sessionquery-get

agency-agents
  已安装  ...\node_modules\@michengai\dsh-agency-agents\lib\src-BAu01ObW.js
  备份    ...\lib\src-BAu01ObW.js.bak-20261107-locale-cache

Electron main
  D:\DSH\resources\app\lib\main.js
  备份    main.js.bak-20261107-auth-cookie-prune
          main.js.bak-20261107-host-stderr-tee

stderr 诊断日志
  D:\DSH\design-probe\host-stderr.log
```

---

## 七、遗留与防复发

1. **第三方插件更新会覆盖补丁**
   - better-sidebar 可能恢复 `webRuntime`；
   - agency-agents 已在 10 月 29 日更新中覆盖过一次 locale 缓存补丁。
   - 更新后固定检查：启动 stderr 是否出现 pending / `without inject` / 窗口是否长时间不显示。

2. **DSH 升级会覆盖 main.js 补丁**
   - Cookie 自动清理、stderr 落盘两处都可能丢失；
   - 升级后启动失败先检查 `Cookies` 里 `dsh-auth-*` 是否再次累积到 70+。

3. **HOS 安装包未重建**
   - 当前修复只在已安装副本和 `_publish` 仓库；
   - 重装 HOS 1.6.3 会退回旧 `bookmarks.js`，同时也会丢掉之前 advisor / design 的修复。
   - 建议后续统一重建一个新版本包。

4. **大会话仍会影响首屏**
   - 当前恢复的「花花--队长」会话为 33.3 MB / 35,257 条事件；
   - 启动性能修复后窗口可见约 13–20s，但首次进入大会话仍可能稍慢；可切换轻会话后再退出。

---

## 八、相关记录

- `09-HOS-Advisor会话评审启用与Origin校验修复-20261029.md`
- `08-HOS设置保存失效-design键校验缺失-20261028.md`
- `07-HOS-spawn-seed修复可持续性评估-20261028.md`
- gbrain：`nango-dsh-startup-plugin-service-fixes-20261107`（本文）
