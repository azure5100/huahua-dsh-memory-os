# v1.6.3 — 2026-10-28

## 修复：设置保存整体 400（design 运行时键校验缺失）

**现象**：HOS → Memory Evolve 设置 → 改任意项 → 保存看起来点了，但**一个都没生效**。
`plugin-state.json` mtime 不动。

**根因**（`lib/index.js` 的 `validateRuntimePatch`）：

客户端保存时会带上设计部字段（只要 `GET /api/config` 返回了它们）：
```js
...(typeof draft.designEnabled === "boolean" ? { designEnabled: draft.designEnabled } : {}),
```
而宿主校验器的 `switch` **没有 `designEnabled` / `designAutoStart` / `designHost` / `designPort` / `designVersion` 分支**，
落到 `default: throw` ⇒ `updateRuntime()` 在第一个 `designEnabled` 就抛错 ⇒
**后面的键一个都没写入，`saveState` 也不执行** ⇒ 整次保存 400。

**修复**：补 5 个 case（boolean / 非空 string / 1..65535 整数）

```js
case 'designEnabled':
case 'designAutoStart':
  if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
  return
case 'designHost': ...
case 'designPort': ...
case 'designVersion': ...
```

### 为什么以前没发现

设计部运行时键是客户端 **v1.4.0** 才加进主配置 patch 的；宿主 `lib/index.js` 是更早版本。
从那一刻起，**主配置的每次保存都会整体 400** —— 用户以为「某个开关不生效」，其实全部没落盘。

## 本版同时包含

| 检查项 | 结果 |
|---|---|
| `case 'designEnabled'`（设置保存） | ✅ |
| `HOS_SPAWN_SEED_HEADER`（spawn 不 corrupt） | ✅ |
| `lib/coi/*` 无 `kind:'plugin'`（COI v4） | ✅ |
| `installDesign` + `lib/design/` + `vendor/huahua-design/` | ✅ |
| `cordis.patch.yml` + `dsh.bundle` + `icon.svg` + `icon` 字段 | ✅ |

## 新增：安装完整性自检脚本

```bash
node D:\DSH\dsh-home\tools\hos-selfcheck.mjs                    # 检查已安装副本
node D:\DSH\dsh-home\tools\hos-selfcheck.mjs --tgz <包.tgz>    # 检查安装包
# 退出码 0 = 全绿，1 = 有失败项
```

13 项检查，覆盖今天踩过的全部三类复发：设计部丢失、spawn corrupt、设置 400，
外加 COI runtime-context、挂载三件套、图标。

**实测**：已安装副本 13/13 ✅ · 1.6.3 包 13/13 ✅ · 1.6.2 旧包 12/13（正确报出 design 校验缺失）✅

## 发布纪律

**打包前必须先跑自检，绿了再发** —— 今天 v1.6.1 和 v1.6.2 都因为「源码修了、包没重打」被退回过一次。
