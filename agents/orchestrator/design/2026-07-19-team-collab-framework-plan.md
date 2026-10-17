# 团队协作框架 + 人事部系统优化 实施计划

> **For agentic workers:** 本计划按任务逐步实施，每步产出具体文件。

**目标:** 将设计方案落地到人事部系统，包括三级文件体系、入职流程、团队固化机制

**架构:** 在现有 agent-roles 系统基础上扩展，不破坏现有功能。备份已就绪（~/.gbrain/agent-roles-backup-2026-07-19）

**涉及范围:**
- 人事部 SKILL.md → 新增流程章节
- Orchestrator 模板目录 → 新增三级文件模板 + 团队模板 + 协作流程模板

---

### Task 1: 创建 L1 项目蓝图模板

**Files:**
- Create: `~/.gbrain/agent-roles/orchestrator/templates/templates/L1_项目蓝图.md`

- [ ] **Step 1: 创建蓝图模板文件**

```markdown
# 项目蓝图

## 文件信息
- 创建日期: {{创建日期}}
- 最后更新: {{最后更新}}
- 项目主管: 项目牧羊人（@{{项目牧羊人名}}）
- 版本: v1.0

## 1. 项目概述与目标
- 项目名称：{{项目名称}}
- 项目背景：{{项目背景}}
- 核心目标：{{核心目标}}
- 成功标准：{{成功标准}}

## 2. 时间线与里程碑
| 阶段 | 起止日期 | 里程碑 | 交付物 | 负责人 |
|------|---------|-------|--------|-------|
| Stage 0 预检 | ~ | 需求确认 | 预检报告 | 项目牧羊人 |
| Stage ① 方案 | ~ | 蓝图定稿 | 方案文档 | 全员 |
| Stage ② 分工 | ~ | 分工完成 | 分工矩阵 | 项目牧羊人 |
| Stage ③ 交付 | ~ | 交付完成 | 交付物 | 各成员 |
| Stage ④ 验收 | ~ | 验收通过 | 验收报告 | 项目牧羊人 |
| Stage ⑤ 联调 | ~ | 联调通过 | 联调报告 | 全员 |
| Stage ⑥ 交付 | ~ | 项目交付 | 交付包 | 项目牧羊人 |
| Stage ⑦ 归档 | ~ | 归档完成 | 项目纪要 | 项目牧羊人 |

## 3. 团队分工矩阵
| 角色 | 职责 | 产出物 | 依赖 | 时间窗口 |
|------|------|--------|------|---------|
| {{角色1}} | {{职责1}} | {{产出1}} | {{依赖1}} | {{时间1}} |
| {{角色2}} | {{职责2}} | {{产出2}} | {{依赖2}} | {{时间2}} |

## 4. 边界声明总表
| 角色 | 负责 | 不负责 |
|------|------|--------|
| {{角色1}} | {{负责1}} | {{不负责1}} |
| {{角色2}} | {{负责2}} | {{不负责2}} |

## 5. 应变策略
- 范围变更流程：{{范围变更流程}}
- 时间线调整规则：{{时间线调整规则}}
- 成员替换流程：{{成员替换流程}}

## 6. 团队信息传递规则
- 文件格式：Markdown
- 更新节奏：每日结束时更新施工记录
- 汇报线路：成员 → 项目牧羊人 → 用户
- 紧急通道：阻塞问题 2 小时内响应

## 7. 验收标准清单
| 交付物 | 验收标准 | 验收方式 | 计划验收日期 |
|--------|---------|---------|-------------|
| {{交付物1}} | {{标准1}} | {{方式1}} | {{日期1}} |

## 8. 项目健康度检查点
| 检查点 | 日期 | 检查内容 |
|--------|------|---------|
| CP1 | ~ | 蓝图确认 |
| CP2 | ~ | 阶段完成 |
| CP3 | ~ | 交付物评审 |
```

- [ ] **Step 2: 验证文件创建成功**

```bash
ls -la ~/.gbrain/agent-roles/orchestrator/templates/templates/L1_项目蓝图.md
```

---

### Task 2: 创建 L2 施工记录模板

**Files:**
- Create: `~/.gbrain/agent-roles/orchestrator/templates/templates/L2_施工记录.md`

- [ ] **Step 1: 创建施工记录模板文件**

```markdown
# 施工记录 - {{角色名}}
## 项目：{{项目名称}}

## 文件信息
- 创建日期: {{创建日期}}
- 最后更新: {{最后更新}}
- 角色: {{角色名}}
- 所属阶段: Stage {{N}}

## 边界声明
- 我负责: {{我负责的内容}}
- 我不负责: {{我不负责的内容}}

## 时间线
| 日期时间 | 阶段 | 工作内容 | 关键决策 | 备注 |
|----------|------|---------|---------|------|
| ~ | | | | |

## 交付物清单
| 交付物 | 状态 | 完成日期 | 验收结果 |
|--------|------|---------|---------|
| ~ | ⏳ 进行中 | — | — |

## 遇到问题与解决
- 问题：~ → 发现时间：~ → 解决：~ → 解决时间：~

## 偏差记录（如有）
- 偏离了什么：~ → 发现方式：~ → 纠偏措施：~ → 时间：~

---

*本文件是施工期间的正式记录，不依赖模型记忆。*
*每项操作必须标注日期时间，时间线不可断层。*
```

- [ ] **Step 2: 验证文件创建成功**

```bash
ls -la ~/.gbrain/agent-roles/orchestrator/templates/templates/L2_施工记录.md
```

---

### Task 3: 创建 L3 项目纪要模板 + 角色任命书 + 阶段任务卡

**Files:**
- Create: `~/.gbrain/agent-roles/orchestrator/templates/templates/L3_项目纪要.md`
- Create: `~/.gbrain/agent-roles/orchestrator/templates/templates/角色任命书.md`
- Create: `~/.gbrain/agent-roles/orchestrator/templates/templates/阶段任务卡.md`

- [ ] **Step 1: 创建项目纪要模板**

```markdown
# 项目纪要 - {{项目名称}}

## 文件信息
- 创建日期: {{创建日期}}
- 项目起止: {{开始日期}} → {{结束日期}}
- 项目主管: 项目牧羊人（@{{项目牧羊人名}}）
- 版本: v1.0

## 项目概要
- 项目类型：{{项目类型}}
- 角色阵容：{{角色列表}}
- 总耗时（日历天数）：{{天数}}
- 实际工时（轮次/对话数）：{{工时}}
- 交付物清单：{{交付物列表}}

## 项目时间线总览
| 阶段 | 计划时间 | 实际时间 | 偏差 | 说明 |
|------|---------|---------|------|------|
| Stage 0 预检 | ~ | ~ | ~ | ~ |
| Stage ① 方案 | ~ | ~ | ~ | ~ |
| Stage ② 分工 | ~ | ~ | ~ | ~ |
| Stage ③ 交付 | ~ | ~ | ~ | ~ |
| Stage ④ 验收 | ~ | ~ | ~ | ~ |
| Stage ⑤ 联调 | ~ | ~ | ~ | ~ |
| Stage ⑥ 交付 | ~ | ~ | ~ | ~ |
| Stage ⑦ 归档 | ~ | ~ | ~ | ~ |

## 关键决策记录
| 决策 | 背景 | 谁决定的 | 决策时间 |
|------|------|---------|---------|
| ~ | ~ | ~ | ~ |

## 偏差与纠偏记录
| 偏差 | 发现方式 | 纠偏措施 | 发生时间 | 解决时间 |
|------|---------|---------|---------|---------|
| ~ | ~ | ~ | ~ | ~ |

## 经验教训
- {{经验1}}
- {{经验2}}

## 模板固化建议
- 建议新增模板：~
- 建议更新角色：~
- 建议调整边界：~
```

- [ ] **Step 2: 创建角色任命书模板**

```markdown
# 角色任命书

## 文件信息
- 任命日期: {{任命日期}}
- 项目: {{项目名称}}
- 项目主管: 项目牧羊人（@{{名称}}）

---

## 📋 角色任命

**角色:** {{角色名}}
**能力描述:** {{来自角色定义的一行摘要}}
**核心使命:** {{来自角色定义的核心使命摘要}}

### 关键规则
{{来自角色定义的关键规则}}

---

## 【本项目边界声明】

**我负责:**
{{我负责的工作内容}}

**我不负责:**
{{不负责的工作内容}}

---

## 角色定义参考

完整角色定义请查阅: `source/{{部门}}/{{角色slug}}.md`
项目蓝图请查阅: `L1_项目蓝图.md`

---

**任命确认:**
- 成员签名: {{角色名}}
- 项目主管: 项目牧羊人（@{{名称}}）
- 任命日期: {{日期}}
```

- [ ] **Step 3: 创建阶段任务卡模板**

```markdown
# 阶段任务卡

## 文件信息
- 项目: {{项目名称}}
- 阶段: Stage {{N}} - {{阶段名称}}
- 发布日期: {{日期}}

---

## 🎯 阶段目标

{{阶段目标描述}}

---

## 任务分配

### {{角色1}}
**你的任务:** {{任务描述}}
**角色边界重申:** {{边界重申}}
**产出物:** {{产出物}}
**验收标准:** {{验收标准}}
**预计时长:** {{预计轮次}}

### {{角色2}}
...

---

## 依赖关系
- 前置依赖: Stage {{N-1}} 完成
- 等待: {{等待谁和什么}}
- 预计开始: {{日期时间}}

## 协作规则
- 文件更新：每日结束时更新施工记录
- 阻塞上报：问题发生后 2 小时内记录到施工记录
- 同步会议：{{同步频率}}
```

- [ ] **Step 4: 验证所有文件创建成功**

```bash
ls -la ~/.gbrain/agent-roles/orchestrator/templates/templates/
```

---

### Task 4: 创建团队项目协作模板 (Orchestrator YAML)

**Files:**
- Create: `~/.gbrain/agent-roles/orchestrator/templates/collab/team-project.yaml`

- [ ] **Step 1: 创建团队项目协作模板**

```yaml
name: "团队项目协作"
description: "项目牧羊人主导的团队协作项目——三级文件体系 + 阶段注入 + 边界保障"

agents_dir: "agency-agents-zh"

llm:
  provider: deepseek
  model: deepseek-chat
  max_tokens: 4096

concurrency: 3

inputs:
  - name: project_name
    description: "项目名称"
    required: true
  - name: project_goal
    description: "项目目标和背景"
    required: true
  - name: team_roles
    description: "团队角色阵容（角色slug列表）"
    required: true
  - name: shepherd_slug
    description: "项目牧羊人角色slug"
    required: true
    default: "agents/project-management-project-shepherd"

steps:
  - id: onboard
    role: "{{shepherd_slug}}"
    task: |
      # 入职流程

      项目：{{project_name}}
      目标：{{project_goal}}

      请执行以下入职流程：

      ## Step 1: 角色注入
      1. 逐个读取团队角色定义（source/<dept>/<role>.md）
      2. 为每个成员生成【角色任命书】，包含：
         - 角色定义摘要
         - 本项目边界声明（负责/不负责）
      3. 将角色任命书注入每个成员

      ## Step 2: 蓝图对表
      1. 分发蓝图草案
      2. 组织团队讨论分工合理性
      3. 调整边界声明
      4. 全员确认

      ## Step 3: 入职确认
      确认全员到位后，输出：
      - 已注入的角色列表
      - 边界声明总表
      - 确认状态
    output: onboard_result

  - id: blueprint
    role: "{{shepherd_slug}}"
    task: |
      基于以下信息，组织团队成员共同编写项目蓝图：

      项目：{{project_name}}
      目标：{{project_goal}}
      团队阵容：{{team_roles}}

      蓝图必须包含：
      1. 项目概述与目标
      2. 时间线与里程碑（每阶段标起止日期）
      3. 团队分工矩阵
      4. 边界声明总表
      5. 应变策略
      6. 团队信息传递规则
      7. 验收标准清单（含计划验收日期）
      8. 项目健康度检查点

      格式参考 templates/templates/L1_项目蓝图.md

      注意：请组织成员共同制定，而非独自编写。
    depends_on: [onboard]
    output: blueprint_doc

  - id: stage_inject
    role: "{{shepherd_slug}}"
    task: |
      项目蓝图已确认，请逐个向成员下发【阶段任务卡】：

      蓝图：{{blueprint_doc}}

      为每个成员生成当前阶段的任务卡，包含：
      - 当前阶段目标
      - 该成员的明确任务
      - 角色边界重申
      - 产出物和验收标准
      - 依赖项说明

      格式参考 templates/templates/阶段任务卡.md
    depends_on: [blueprint]
    output: inject_result

  - id: execution
    role: "{{team_roles}}"
    task: |
      请根据阶段任务卡执行你的工作：

      阶段任务：{{inject_result}}

      要求：
      1. 施工记录：每项操作标注日期时间
      2. 交付物 + 施工记录双轨交付
      3. 遇到阻塞及时写入施工记录
      4. 严守边界声明

      格式参考 templates/templates/L2_施工记录.md
    depends_on: [stage_inject]
    output: delivery_result

  - id: review
    role: "{{shepherd_slug}}"
    task: |
      请组织项目验收：

      交付物：{{delivery_result}}
      蓝图标准：{{blueprint_doc}}

      1. 逐项比对交付物与验收标准
      2. 记录偏差和纠偏
      3. 输出验收报告
      4. 如偏差超过3次则上报用户介入
    depends_on: [execution]
    output: review_result

  - id: summary
    role: "{{shepherd_slug}}"
    task: |
      请汇总项目纪要：

      项目名称：{{project_name}}
      蓝图：{{blueprint_doc}}
      验收结果：{{review_result}}

      输出 L3_项目纪要.md，包含：
      - 项目时间线总览（计划 vs 实际）
      - 关键决策记录
      - 偏差与纠偏记录
      - 经验教训
      - 模板固化建议

      同时建议：
      - 如果某个角色频繁越界 → 更新其角色定义的边界声明
      - 如果某个角色展现了新能力 → 拓展角色定义
      - 更新模板注意事项

      格式参考 templates/templates/L3_项目纪要.md
    depends_on: [review]
    output: summary_doc
```

- [ ] **Step 2: 验证 YAML 语法**

```bash
cd ~/.gbrain/agent-roles && python3 -c "import yaml; yaml.safe_load(open('orchestrator/templates/collab/team-project.yaml'))" && echo "YAML语法正确"
```

---

### Task 5: 更新人事部 SKILL.md

**Files:**
- Modify: `~/.gbrain/agent-roles/SKILL.md`

- [ ] **Step 1: 备份当前SKILL.md**

```bash
cp ~/.gbrain/agent-roles/SKILL.md ~/.gbrain/agent-roles/SKILL.md.bak
```

- [ ] **Step 2: 在SKILL.md中新增以下章节**

在现有内容后新增「项目牧羊人流程」章节，包括：
- 项目牧羊人角色说明
- 入职流程（角色注入→蓝图对表→阶段注入）
- 三级文件体系说明
- 边界保障机制
- 团队固化复用
- 角色迭代机制

参考设计文档的内容进行编写。

- [ ] **Step 3: 验证SKILL.md语法**

```bash
head -5 ~/.gbrain/agent-roles/SKILL.md && echo "..." && tail -20 ~/.gbrain/agent-roles/SKILL.md
```

---

### Task 6: 真实项目验证 — 用本项目走一遍完整流程

**Files:**
- Create: 本项目施工文件和纪要

- [ ] **Step 1: 项目牧羊人注入本项目成员的角色定义**
- [ ] **Step 2: 确认本项目边界声明**
- [ ] **Step 3: 验证三级文件体系是否能正常运作**

---

### 回滚方案

如需回滚到备份状态：

```bash
rm -rf ~/.gbrain/agent-roles
cp -r ~/.gbrain/agent-roles-backup-2026-07-19 ~/.gbrain/agent-roles
```

SKILL.md 单独回滚：`cp ~/.gbrain/agent-roles/SKILL.md.bak ~/.gbrain/agent-roles/SKILL.md`
