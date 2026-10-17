# HOS v1.2.0 — 全面适配 DSH 0.2.0

## 一键安装（任何 DSH 终端）

```bash
dsh plugin add https://github.com/azure5100/huahua-dsh-memory-os
```

装完**重启桌面端**（host 半只在启动时加载），入口显示为 **HOS**。

## 本次重点

### 1. 全面适配 DSH 0.2.0（重大）
- DSH 0.2.0 移除了 `ctx.settings.get(ns)` ⇒ 改为 `ctx.get('settings')` + `settings.describe()` 取 `.value`
  （照 `dsh-connect-workbuddy` 的实测用法；0.1.0 的 `.get` 保留为回退）
- peer 依赖放宽为 `@deepseek-ai/dsh-client-runtime >= 0.2.0-rc.2`
- 效果：**模型设置**恢复正常（此前报 `ctx.settings.get is not a function`）

### 2. 输入框冲突修复
- 11 个 `conversation.view` 收敛为 **1 个 HOS 入口 + 内部 Tab**（多视图会挤坏输入框）
- 13 个 `Icon*` 依赖移除 ⇒ 自带 inline SVG（不再需要 `dsh-client-ui-primitives`）

### 3. 记忆 Tab 路径修正
- `AGENTS.md` 以前只找 `<dshHome>/AGENTS.md`（多数机器不存在）⇒ 现在**优先工作区**、回退 dshHome

### 4. 痕迹功能优雅降级
- 非 git 仓库环境下不再抛 `git log exit 128` 原始错误，改为提示"痕迹未启用"

## 跨终端迁移

记忆数据都在 `<dshHome>/memories/`（`MEMORY.md` / `USER.md` / `daily/` / `projects/`）——
**整个目录拷到新终端即完成迁移**，装好插件自动识别。

## 脱敏说明

本仓库已做发布前脱敏：本地绝对路径 → `<USER_HOME>` / `<DSH_HOME>`，
主机名 / MachineGuid / LAN IP / 房间 ID 均已移除或占位，**无任何凭据**。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | **0.2.0 及以上** |
| Node | >= 20 |
| peer | `@deepseek-ai/dsh-client-runtime >= 0.2.0-rc.2` |
