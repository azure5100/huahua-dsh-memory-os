# v1.6.4 — 2026-10-29

## 修复：Advisor（会话评审）配了也用不了

**现象**：设置里打开「会话评审（Advisor）」全局开关后，会话内面板能显示但**任何操作都报错**：

```
缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）
```

### 两层根因

**第一层：全局开关 ≠ 会话启用（设计如此）**

```js
const effectiveEnabled = (sessionId) => (
  config.advisorEnabled === true && overrides.get(sessionId) === true
)
```
`advisorEnabled` 是总闸，`overrides` 是**会话级 opt-in（默认每个会话都关）**。
这是 2026-08-13 定的设计：评审会消耗模型调用，不能因为全局打开就让所有会话都开始评审。

**第二层：写接口的 Origin 校验与桌面端不兼容**

```js
// lib/advisor/api.js — sameOriginGuard
if (origin === '') {
  return [403, 'FORBIDDEN', '缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）']
}
```
DSH 桌面端由 Electron 宿主发起同源写请求，**渲染进程不带 Origin 头** ⇒
`toggle` / `instructions` / `conversation/reset` / `config` / `scopes` 全部 403。
而主配置的 `POST /api/config` 不走这条 Advisor guard，所以「全局开关能保存」掩盖了这个问题。

### 修复

无 Origin 时**只放行回环来源**；跨机 / LAN 请求仍必须携带 Origin：

```js
if (origin === '') {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return [403, 'FORBIDDEN', '缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）']
} else {
  let originHost = ''
  try { originHost = new URL(origin).host } catch { return [403, 'FORBIDDEN', '跨站请求已拒绝'] }
  if (originHost !== host) return [403, 'FORBIDDEN', '跨站请求已拒绝']
}
```

### 安全边界（没有关掉 CSRF 防护）

- 无 Origin：**只允许回环**（127.0.0.1 / ::1 / ::ffff:127.0.0.1）
- 有 Origin：仍严格比对 `Origin.host === Host`
- 带 body 的写请求仍强制 `Content-Type: application/json`
- 跨机 / LAN 缺少 Origin 仍然 403

本地进程本来就能读写 HOS 数据目录，放行回环不扩大实际攻击面。

## 本版同时包含（累计）

| 检查项 | 结果 |
|---|---|
| ① 设计部（installDesign / lib/design 4 文件 / vendor） | ✅ |
| ② spawn seed 开关（`HOS_SPAWN_SEED_HEADER`） | ✅ |
| ③ 设置保存（`validateRuntimePatch` 含 design 校验） | ✅ |
| ④ COI 用 `runtime-context`（v4） | ✅ |
| ⑤ 挂载三件套 + 图标 | ✅ |
| ⑥ Advisor Origin 放行回环 | ✅ **新增** |

## 自检脚本升级到 14 项

```bash
node D:\DSH\dsh-home\tools\hos-selfcheck.mjs
node D:\DSH\dsh-home\tools\hos-selfcheck.mjs --tgz <包.tgz>
```
**1.6.4 包实测：14/14 通过** ✅
