# HOS v1.6.6 发布说明

> 2026-11-07 · 两处变更：① turn-anchor 的 sessionQuery inject 修复 ② huahua-design 新增「3D演示」产品线（第 11 条）

---

## 一、修复：turn-anchor 反复报 cannot get property "sessionQuery" without inject

### 现象

启动时重复 20+ 次（等于书签请求的轮次数）。功能最终走磁盘兜底，但刷日志、每次浪费一次查询。

### 根因

lib/bookmarks.js 原写法先访问受保护属性再兜底：

    const sessionQuery = ctx.sessionQuery ?? ctx.get?.("sessionQuery")

inject 列表里没有 sessionQuery，而 Cordis 对「未 inject 服务的属性访问」会直接抛错 ——
所以 ctx.sessionQuery 先抛，后面的 ctx.get(...) 兜底永远执行不到。

作者本意是「动态取、不写进 inject，避免旧宿主没有该服务时插件永久 pending」，但代码写成了先访问受保护属性。

### 修复

    // 必须只走 ctx.get：未 inject 时读 ctx.sessionQuery 会先抛，后面的 ?? 根本执行不到
    const sessionQuery = ctx.get?.("sessionQuery")

### 验证

    GET /memory-evolve/api/bookmarks/turn-anchor?sessionId=...&turn=1
    → HTTP 200 {"turn":1,"seq":18}
    启动日志不再出现 observeSession 失败；HOS 条目保持 state 2 (active)

---

## 二、新增：huahua-design 第 11 条产品线「3D演示」

### 2.1 设计部界面（vendor/huahua-design）

    app/dist/public/assets/index-8ICSlGZ2.js（240 KB → 246 KB）
    i18n categories 由 10 条二元组 → 11 条三元组
      [名称, 一句功能介绍（给人看）, 完整提示种子（给模型看）]
    新增第 11 条：3D演示 / A mechanism drawn as a machine you can read
    中英双语同步（zh-CN 与 en 各 11 条）

### 2.2 入口三处 UX 改动

    ① 点产品线不再覆盖输入框（原来会把整段种子灌进 textarea）
    ② 输入框上方常驻一行「一句功能介绍」，随选择切换
    ③ 提交时拼：用户需求 + 空行 + 该产品线的提示种子

### 2.3 「3D演示」的提示种子（139 字，只保留两条硬要求）

    【强制】第一步调用 skill 工具加载 anatomy，严格按它的 Workflow 执行，不许跳过流程直接画。
    【写入】用 design_node_complete 写入指定节点，不新建节点；产物 HTML 顶部注释写自证行 SIZE=… parts=NN gates=5/5

为什么只有两条：anatomy 的 SKILL.md 自带 33 KB 工艺规则（Workflow 四步 / craft 五条 / 档位与性能边界）。
在种子里复述只会与它打架；种子只负责「叫醒它」+「规定写回方式」。

### 2.4 十一条产品线的门禁（新增能力，不只 3D演示）

    想法    3 方向差异是思路不是配色 · 全低保真 · 用户已选定并记理由
    原型    Playwright 点通主流程 · 三视口截图 · 设备框用 assets/
    落地页  三视口首屏无横滚 · 390 宽 CTA 不换行 · 首屏主图 ≤300KB
    海报    25% 缩放仍可读 · 安全区零关键文字 · CMYK+RGB 双版本转曲
    logo    16px favicon 可辨 · 单色成立 · 反白不发虚
    文档    打印无孤行 · 页码与目录一致 · 行宽 ≤66 字
    封面    220px 缩略图可辨 · 关键元素在裁切区 · 方图重新构图
    简历    6 秒读出三条 · PDF 文本可选中 · 一页装下
    插画    遮文能说清 · 相邻手不重复 · 零错别字
    邀请函  一屏读完四要素 · 二维码真扫通过 · 时间地点零歧义
    3D演示  实心非线框 · 层级 lo-mid-hi 且恰一个 lit · 线条有归宿（禁引线箭头气泡）

### 2.5 一次真实交付（作为流程标准样例）

    项目  火箭引擎喷射演示图（project ab551c00cf5f）
    节点  3bb918035c22「试车台等距图」
    规格  Figure 档 · 76 件（40-80 内）· 后侧承力架开放布置 · 统一等距单位
    自证  SIZE=Figure parts=76 gates=5/5（写在产物 HTML 顶部注释）
    写回  PUT /api/nodes/<id>/artifact → 200 ok（未新建节点）

---

## 三、已知限制

    ① bundle 是编译产物，重装（tgz 解包）会覆盖 dist 内的改动 —— 源码侧尚未纳入
    ② 提示词只能强烈要求会话加载 anatomy，不能机制强制；
       若要严格保证，需给设计部配专用 Agent 预设（system prompt 内固定 anatomy 流程）
    ③ 试车台样例仍有三处画面不足（刻度条被尾焰遮挡 / 仪表与指示灯挤 / 右侧地台偏空）

---

## 四、相关文档

    docs/huahua-design/product-lines/                     11 张产品线档案卡（含 INDEX 与模板）
    docs/huahua-design/product-lines/_SKILL接入摘录.md     SKILL.md 三处接入摘录

