# v1.6.0 — 2026-10-27

## 本版基线

以**桌面端当前实际加载的 HOS** 为准（0.1.7 运行基线 + 两项已实测补丁），
并合入远端历史（设计部 P2/P3、开源链接修复），冲突一律以本地合并版为准。

## 包含

| 能力 | 说明 |
|---|---|
| 会话书签 | 槽位注册 + `data-turn-tail` 取轮次 + `/turn-anchor` 反查真 seq + 内联输入框 |
| 书签后端 | `GET /memory-evolve/api/bookmarks/turn-anchor?sessionId=&turn=`，三路径降级（agent → sessionQuery → 直读 session.v4.jsonl.zstd），15s 缓存 |
| 设计部 | 设计部 Tab 与设置项（`designEnabled` / `designAutoStart` / `designPort`）|
| workbuddy 直读 | `de_models` 直接读 workbuddy 模型列表 + `lib/wb-models-cache.js`（10 分钟缓存）|
| 挂载修复 | 补上仓库长期缺失的 `cordis.patch.yml`（没有它 `dsh.profile.bundles` 里的条目挂不起来）|

## 安装

```powershell
dsh plugin --profile desktop add "huahua-dsh-memory-os@file:<绝对路径>\huahua-dsh-memory-os-0.1.7-merged.tgz"
dsh plugin --profile desktop install
# 装完确认 bundles 里有 huahua-dsh-memory-os，且 node_modules\huahua-dsh-memory-os\cordis.patch.yml 存在
# 然后重启 DSH（bundle 插件 Ctrl+R 不够）
```

## 已知问题

- 书签「改名」仍走 `window.prompt`，在 Electron 桌面端不弹框（新建/跳转/删除正常）
