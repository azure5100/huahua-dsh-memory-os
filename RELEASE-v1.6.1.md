# v1.6.1 — 2026-10-28

## 修复

**飞书 / COI 通知在 session format v4 下投递失败** —— `format v4 message requires a producer-owned source kind`

### 根因

DSH 0.2.x 的 session format v4 退役了「bare `kind: 'plugin'` + `plugin` 字段」的旧插件来源：

```js
// @deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs
if (… || value["kind"] === "plugin")
  throw new SessionFormatError("format v4 message requires a producer-owned source kind");
```

memory-os 的 COI 仍有 4 处投递点用旧格式，消息进不了 v4 会话。

### 改动

4 处统一改为 `kind: 'runtime-context'`（`MessageSourceMap` 中合法的 producer-owned kind），
保留 `form: 'notice'`、`summary`、`plugin: 'dsh-memory-evolve'`：

| 文件 | 用途 |
|---|---|
| `lib/coi/index.js` | 广播消息投递 |
| `lib/coi/scheduler.js` | COI 任务「已发起 / 已完成」通知 |
| `lib/coi/ws-coord.js`（2 处）| 文件冲突提醒 / 工作区活动通知 |

### 为什么以前没暴露

历史调用每次都同步 `de_coi_wait`，结果拉回本轮，通知路径不触发；
2026-10-28 首次「派单后不等待」，任务完成后走 `#notifyDone() → #deliver()` 才第一次真正追加进 v4 会话。
**v4 不兼容是潜伏 bug，模型行为变化是触发条件。**

## 验证

- 全库 `grep "kind: 'plugin'"` ⇒ **0 处** ✓
- 三文件 `kind: 'runtime-context'` ⇒ index 1 / scheduler 1 / ws-coord 2 ✓

## 本版同时包含

- v1.6.0 的全部内容（书签槽位修复 + 设计部 UI + workbuddy 直读 + cordis.patch.yml）
