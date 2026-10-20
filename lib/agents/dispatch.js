// huahua-os · 人事部融合 阶段 1A：lib/agents/dispatch.js —— 调度薄封装（docs/89 §3.1）
// 职责：registry.resolve/roleDefinition（读副本）→ 组装「任命书」（角色定义摘要 + 任务，
//      对齐 agent-roles orchestrator 模板语义 + docs/72 判据 a 双条件文本锚点）→ 返回
//      { ok, appointment, definitionPath }；宿主/UI 决定如何执行（prompt 注入/会话编排）。
// 纪律：只读副本、不读/写源；不 spawn、无副作用（纯组装函数——调度执行权在宿主）。
// 零依赖；ESM。
import path from 'node:path'

/**
 * 调度工厂。
 * @param {{ registry: object }} opts createRegistry 实例（读副本 agents/）
 * @returns {{ dispatch: (req: {roleKey:string, task:string, sessionId?:string}) => object }}
 */
export function createDispatcher(opts) {
  const registry = opts?.registry ?? null

  /**
   * 组装任命书。
   * @param {{ roleKey: string, task: string, sessionId?: string }} req
   * @returns {{ ok:boolean, appointment?:string, definitionPath?:string, role?:object, error?:string }}
   */
  function dispatch(req = {}) {
    const roleKey = String(req.roleKey ?? '').trim()
    if (!roleKey) return { ok: false, error: '缺 roleKey' }
    if (!registry) return { ok: false, error: '缺 registry（agents 域未装配）' }
    const def = registry.roleDefinition ? registry.roleDefinition(roleKey) : null
    const entry = def?.entry ?? registry.resolve(roleKey)
    if (!entry) {
      return { ok: false, error: `副本无此角色定义: ${roleKey}（先 agents-sync --apply / 校对 slug）` }
    }
    const file = String(entry.file ?? '').replace(/\\/g, '/')
    const definitionPath = file
      ? path.join(registry.agentsDir ?? '', 'source', ...file.split('/'))
      : null
    const desc = def?.frontmatter?.description ?? entry.desc ?? ''
    const task = String(req.task ?? '').trim()
    const lines = [
      '人事部已激活 · 角色任命书', // docs/72 判据 a 文本锚点①（收尾 expert 识别用）
      `角色：${entry.name ?? roleKey}（${entry.role_key ?? roleKey} · ${entry.dept ?? ''}）—— agents/${entry.role_key ?? roleKey}`, // 锚点② agents/<slug> 引用
    ]
    if (desc) lines.push(`能力：${desc}`)
    if (task) lines.push(`任务：${task}`)
    if (req.sessionId) lines.push(`会话：${req.sessionId}`)
    if (file) lines.push(`定义：agents/source/${file}`)
    return { ok: true, appointment: lines.join('\n'), definitionPath, role: entry }
  }

  return { dispatch }
}
