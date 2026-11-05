# HOS v1.6.5 — 技能归属修正：DSH 的技能回到 DSH 自己的目录

发布日期：2026-11-05

## 一句话

`skillDir` 默认值从 `~/.agents/skills`（跨工具通用层）改为 `<DSH_HOME>/skills`（DSH 自己的技能目录）。**概念修正为主，顺带消掉一个跨盘符崩溃。**

## 为什么改

**概念错位**：`~/.agents/skills` 是给 Claude / Codex / Cursor / Gemini 等外部 agent 共用的通用层，
而 HOS 的 `skill_manage` 创建的是 **DSH 自己的技能**。把 DSH 的技能塞进通用层，等于把自己的东西放进公共库，
与「DSH 的归 DSH、其他 agent 的归其他 agent」的分层原则冲突。

**顺带修一个崩溃**：待确认队列在 `<DSH_HOME>/memories/pending-skills`（随 `DSH_HOME`），
技能库默认在 `~/.agents/skills`（随用户主目录）。当 DSH 装在非系统盘（如 `D:\DSH`）时，两者跨设备，
`approvePendingSkill()` 里的 `renameSync()` 会抛：

```
EXDEV: cross-device link not permitted, rename
'D:\DSH\dsh-home\memories\pending-skills\<name>' ->
'C:\Users\<user>\.agents\skills\<name>'
```

这个 bug 在「DSH 装在系统盘」的开发机上永远测不出来，只在非系统盘安装时出现。

## 改了什么

```js
// lib/index.js  resolveConfig()
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
config.memoryDir = resolve(config.memoryDir ?? join(home, 'memories'))
- config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))
+ config.skillDir = resolve(config.skillDir ?? join(home, 'skills'))
```

**两处收益**：

| 收益 | 说明 |
|---|---|
| 归属正确 | DSH 采纳的技能落在 `<DSH_HOME>/skills`，与 `dsh-skills-manager` 的口径一致 |
| 跨盘消失 | `pending-skills` 与技能库同在 `DSH_HOME` 下 ⇒ 同一设备 ⇒ `rename` 原生可用 |

## 兼容性

- **显式配置 `skillDir` 的用户不受影响**：显式值优先，行为不变
- **默认值用户**：升级后技能库指向 `<DSH_HOME>/skills`；若原先已把技能放在 `~/.agents/skills`，需要手动搬一次（或显式配置指回旧路径）
- `~/.agents/skills` 里的技能仍由宿主 `skill` 加载机制扫描，只是不再是 HOS 的**写入目标**

## 升级方式

```
dsh plugin --profile desktop add <path>/huahua-dsh-memory-os-1.6.5.tgz
# 或更新 profile dependencies 指针后 dsh plugin install
```

升级后**需重启桌面端**（host 半改动）。

## 验证要点

1. `GET /memory-evolve/api/skills` 或 `skill_manage list` → 应列出 `<DSH_HOME>/skills` 下的技能
2. 在设置面板采纳一个待确认技能 → 不再报 EXDEV，技能出现在 `<DSH_HOME>/skills`
3. 旧路径 `~/.agents/skills` 不再新增 DSH 技能
