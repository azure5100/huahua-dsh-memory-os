# v1.6.2 — 2026-10-28

## 修复：把 spawn seed 断根真正打进安装包

v1.6.1 的 **源码/已安装副本**里给 seed 注入加了环境开关（`HOS_SPAWN_SEED_HEADER`，默认关），
但**安装包没有包含这个改动** —— tgz 内 `lib/session-orch.js` 仍是 76,950 B 的无条件注入版本。
而 profile 的 dependency 正指向该 tgz ⇒ 任何人 `dsh plugin add` / 重装 HOS，都会把未修复版本装回来，
`de_session spawn` 出来的会话重新变成

```
SessionFormatError: request/header is outside an open turn
```

### 本版改动

- 从**已修复的已安装副本**重新构建安装包（567 文件）
- 解包验证四项：

| 检查 | 结果 |
|---|---|
| `package/lib/session-orch.js` 含 `HOS_SPAWN_SEED_HEADER` | ✅ |
| `package/lib/coi/index.js` 无 `kind: 'plugin'`（runtime-context）| ✅ |
| `package/lib/index.js` 含 `installDesign`（139,128 B）| ✅ |
| `package/lib/design/index.js` / `vendor/huahua-design/` / `icon.svg` | ✅ |

- profile dependency 改指 `huahua-dsh-memory-os-1.6.2.tgz`

## 仍待完成（见评估报告第 5.3 节）

- 思考等级（reasoningEffort）继承目前是**关掉的**（换来不损坏）。
  正确做法是在首轮 `turn/start` 之后写 `request/header`，或改用 `model/selection` 事件，
  而不是塞进 seed —— 这需要改 HOS 的 spawn 实现，未在本次完成。

## 附录：防复发检查（每次 dsh plugin add 之后）

```
lib/index.js 大小 139,128
lib/design/ 4 文件
vendor/huahua-design/ 29 文件
dsh.profile.bundles 含 huahua-dsh-memory-os
session-orch.js 含 HOS_SPAWN_SEED_HEADER
lib/coi/* 无 kind: 'plugin'
icon.svg + package.json 的 icon 字段
```
