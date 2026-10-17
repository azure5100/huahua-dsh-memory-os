---
name: claude-cli-calling
x-provider: dsh-memory-evolve
x-version: 1
description: "Use when the user wants to invoke Claude Code CLI from the command line without entering the interactive TUI — one-shot questions, scripting/piping, non-interactive task execution, resume by session id, permission-mode control for file edits. Covers claude -p/--print, -c/--continue, --resume/--session-id, --permission-mode, --allowedTools, --model, --output-format. 触发场景：让 Claude Code 在命令行/调度里非交互干活、单次提问拿结果、跨会话续跑、复杂重构与代码审查。"
version: 1.0.0
author: Claude Code (Anthropic)
license: MIT
platforms: [linux, macos, windows]
metadata:
  claude:
    tags: [claude, cli, oneshot, scripting, non-interactive, agent, review]
---

<!-- 本技能由 dsh-memory-evolve 插件（COI 调度模块）内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->


# 在 CLI 里直接调用 Claude Code 干活（不进 TUI）

## 何时用

- 需要让 Claude Code 在命令行/脚本/CI/调度里非交互执行任务（COI 调度派活走的就是这个入口）
- 单次提问快速拿结果，不想要交互会话界面
- 代码审查、跨文件重构、复杂工程修改、PR 评审等深度 agent 任务

## 核心命令

```bash
claude -p "你的任务"          # print 非交互模式：执行后打印最终回答并退出（适合脚本/调度）
claude -p "任务" -c           # 继续当前目录最近一次会话
claude -p "任务" --resume <sessionId>   # 恢复指定会话继续干（sessionId 为 UUID）
claude -p "任务" --session-id <uuid>    # 用指定 session id 开新会话（可自管 id）
```

注意：不带 `-p` 会进入交互式 TUI（挂起等待输入）——COI 调度场景务必带 `-p`。

## 权限控制（非交互不弹窗，这是最容易踩的坑）

`-p` 模式下默认**不会**交互式审批权限，未放行的工具会被拒绝。按任务性质选择：

| 场景 | 参数 |
|---|---|
| 只读分析/问答 | 不加权限参数即可 |
| 需要改文件/跑命令 | `--permission-mode acceptEdits`（自动接受安全编辑，危险命令仍逐个询问） |
| 精细白名单 | `--allowedTools "Bash(git *) Edit Write"`（逗号或空格分隔） |
| 完全自动化、可信沙箱 | `--dangerously-skip-permissions`（跳过一切审批，慎用） |

## 会话恢复

- `-c` / `--continue`：继续**当前工作目录**最近一次会话（换目录后语义不同）
- `--resume <sessionId>`：按会话 id 恢复（与 `-c` 互斥）
- `--session-id <uuid>`：给新会话指定一个可控 id，方便后续按 id 恢复
- `claude --resume`（不带值）：交互式选择器，脚本里不要用

## 常用参数（可组合）

| 参数 | 作用 |
|---|---|
| `--model <模型>` | 本次会话换模型（如 sonnet/opus 或自定义） |
| `--output-format text|json|stream-json` | 输出格式（仅 `-p` 生效）；json 便于机器解析 |
| `--add-dir <目录>` | 额外放行工具访问目录（默认限当前工作区） |
| `--append-system-prompt <文本>` | 追加系统提示（约束行为/风格） |
| `--effort low|medium|high` | 推理投入级别 |
| `--debug-file <路径>` | 排障用调试日志 |

## 脚本 / 调度用法

```bash
RESULT=$(claude -p "生成一个 UUID" --output-format text)
claude -p "review 这段代码：$(cat code.py)" --permission-mode acceptEdits
# 长任务放后台：COI 调度会自动后台执行并留档日志，别用 & 裸跑
```

## 注意事项

- 需要先登录：`claude`（OAuth 登录）或设置 `ANTHROPIC_API_KEY` 环境变量
- agent 任务可能耗时数十秒到数分钟，复杂任务更久——不要设过短超时
- 大文件/长上下文：给文件路径与背景说明，让 Claude 自己读，别整段塞命令行
- 同一目录的 `-c` 才有意义（会话按目录记忆）；跨目录恢复用 `--resume <id>`
- 完整参数以 `claude --help` 为准
