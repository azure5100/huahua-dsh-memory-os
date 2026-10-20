# agents/ — 人事部角色库副本（只读融合区 · git 版本化）

> huahua-os · 人事部融合（docs/89 副本策略）：把人事部**静态资产**（角色定义 md + 派生索引）只读复制进本仓库，
> 作为「目录层」在 OS 内的物理落点；**活事件流不复制、指针读源**。融合期源文件零改动（红线）。

## 来源与同步

| 项 | 值 |
|:--|:--|
| 源真源（默认） | `~/.gbrain/agent-roles`（运行真源：sync-index/promote/stats/access 在此） |
| 可选源 | `~/.agents/skills/agent-roles`（技能源）——`--source` 可切 |
| 同步命令 | `node scripts/agents-sync.mjs --apply`（角色库低频更新，**手动为主**） |
| 检查命令 | `node scripts/agents-sync.mjs --check`（漂移报告，不落盘） |
| S1 基线 | `--baseline`（开工前快照）/ `--baseline-check`（阶段末复跑断言） |
| MANIFEST.json | 每次 --apply 刷新：`{syncedAt, source, sourceCount, copyCount, roleIndexCount, treeSha256, driftNote}` |
| 回滚 | agents/ 全量入 git：`git diff --stat agents/` 可视化、`git checkout -- agents/` 回滚 |

## 目录结构

```
agents/
├─ README.md            # 本文件
├─ MANIFEST.json        # 同步自述（来源/计数/treeSha256/driftNote）
├─ role-index.json      # **副本自举派生**（与 source/ md 1:1，格式对齐源字段 + OS 增强）
├─ .source-baseline.json # 三源基线快照（QA S1 断言用；gitignore，不入库）
└─ source/<dept>/<dept>-<name>.md …   # 角色定义镜像（只读复制，随源目录结构）
```

`role-index.json` 条目：`{ slug:'agents/<role_key>', role_key, name, dept, desc, emoji, color, file }`
——role_key = 文件名 stem（纯 kebab）；dept = source/ 一级目录；name/desc/emoji/color = frontmatter（缺失回退）；
**md 数 == 索引数 1:1**（副本内自举保证，消灭源侧 role-index 漂移——docs/87 N2 在副本内免疫）。

## 红线与读源约定

- **源三目录零改动**：`~/.claude/skills/agent-roles` · `~/.agents/skills/agent-roles` · `~/.gbrain/agent-roles`
  一律不动；同步器与 lib/agents 对源只 fs 读（QA S1/S2 断言）。`--apply` 只写本 agents/ 副本。
- **access.jsonl 读源不复制**：`lib/agents/trace.js` 读
  `~/.gbrain/agent-roles/data/access.jsonl`（runtime key `agentsAccessPath` 可配）——事件流单一真源、
  跨环境共用追加日志（Claude+DSH），**OS 侧永不 append**；专家激活记录仍走 AIMS role-activation.jsonl。
- 消费方（lib/agents/registry.js · observe expert 分支 · routes.js）**只读本副本**，绝不读/写源目录。

## 维护

- 角色库有更新（外部 git pull / 手动编辑）→ 重跑 `--apply`（sha256 幂等，只复制变更）→ `git commit agents/`
- 对外发布数字以副本为准（role-index 1:1），MANIFEST 注明源漂移现象（N2 记录，不阻塞）
