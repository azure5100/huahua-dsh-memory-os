// AIMS 动态闭环 · 观察域（t68 · docs/67 §二/§四）
// 职责：**实际接线 = session/event + agent/inbox/inserted + agent/status + agent/disposed**（见文末
//       §事件接线：每条 ctx.on 上一行注明平台声明来源 file:line）→ ① T0 declare（首条消息/cwd/channel
//       送 role-signals）appendActivation signal:'declare'；② T1 skill 路径 A（回合结束扫 events 工具痕迹，
//       能拿到即写 signal:'skill'，拿不到自动落 daily 回扫路径 B——路径 B 由 AIMS pipeline 侧实现）；
//       ③ 收尾 spawn AIMS register（agent/disposed，≤1/会话，2s 超时，失败 append register-pending.jsonl 不阻断）。
// 纪律：callback 整体 try/catch + console.error（prompts.js）；subagent 一律跳过；
//       ctx.effect(() => ctx.on(...)) 注册；aimsDailySyncEnabled 总门控（关闭全不动作）。
// 信号真源：直读 AIMS role-signals.json（唯一真源，跨盘文件读可失败降级——不 import 避免跨盘 ESM 依赖）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { roleForMember } from './team-discover.js'
import { appendCloseoutMark, readCloseoutLedger } from './ledger.js'
import { createEventHealth } from '../event-health.js' // L3：零触发监听告警 // t28：收尾台账（跨路径幂等门；daily 重放前查）
import { normalizeSessionId } from '../agents/trace.js' // t27：会话 id 唯一归一（规范=去前缀，docs/112 §一.2；跨域同在插件内，非跨仓）

const DEFAULT_ACTIVATION = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'aims', 'role-activation.jsonl')

function aimsLogDir(aimsRepo) { return path.join(aimsRepo, 'data', 'logs') }
function pendingFile(aimsRepo) { return path.join(aimsRepo, 'data', 'aims', 'register-pending.jsonl') }

/**
 * 追加 activation 行（幂等：(session_id_norm, role_key, signal) 已存在跳过）——行格式对齐 AIMS lib/role-activation.mjs。
 * t28（docs/112 §三）：幂等键中的 session_id 一律**归一比较**——历史行可能是带前缀形态，
 * 严格字符串比较会把同一会话判成两条（即时 + 重放双写各一行）。`origin` 只作行内审计字段，**不进键**
 * （进键则"即时 + 批处理"写同一事实必得两行，与目标相反）。
 * @param {{role_key:string, session_id:string, signal:string, agent_id?:string, nature?:string, confidence?:number, origin?:string}} rec
 * @param {string} [activationFile] 留痕文件（缺省 ~/.dsh/aims/role-activation.jsonl）
 * @returns {{appended:boolean, reason:string}} 写入结果（失败不抛）
 */
function appendActivation(rec, activationFile = DEFAULT_ACTIVATION) {
  try {
    if (typeof rec?.role_key !== 'string' || typeof rec?.session_id !== 'string') return { appended: false, reason: '参数缺字段' }
    const key = normalizeSessionId(rec.session_id)
    const existing = fs.existsSync(activationFile) ? fs.readFileSync(activationFile, 'utf8').split('\n').filter(Boolean) : []
    const dup = existing.some((l) => {
      try {
        const o = JSON.parse(l)
        return normalizeSessionId(o.session_id) === key && o.role_key === rec.role_key && o.signal === rec.signal
      } catch { return false }
    })
    if (dup) return { appended: false, reason: `幂等跳过（${key}/${rec.role_key}/${rec.signal}）` }
    fs.appendFileSync(activationFile, JSON.stringify({ ts: new Date().toISOString(), origin: 'observe', ...rec }) + '\n', 'utf8')
    return { appended: true, reason: 'ok' }
  } catch (e) {
    return { appended: false, reason: `写文件失败: ${e.message}` }
  }
}

/** 读 AIMS role-signals.json（唯一真源；失败返回 null 静默降级） */
let signalsCache = null
function loadSignals(aimsRepo) {
  if (signalsCache) return signalsCache
  try {
    const p = path.join(aimsRepo, 'lib', 'role-signals.json')
    if (!fs.existsSync(p)) return null
    signalsCache = JSON.parse(fs.readFileSync(p, 'utf8'))
    return signalsCache
  } catch { return null }
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 轻量 declare/cwd/channel 检测（与 AIMS role-signals.mjs detectRole 同口径；scope title 用 header.title） */
function detectTextRole(aimsRepo, { agentId, title, cwd, text }) {
  const reg = loadSignals(aimsRepo)
  if (!reg) return { role_key: null, level: null, reason: 'role-signals 不可读' }
  const hay = [title || '', text || ''].join('\n')
  const best = []
  for (const role of reg.roles) {
    if (role.agent_id && role.agent_id !== agentId) continue
    const classes = new Set()
    let locked = false
    const sig = role.signals || {}
    for (const d of Array.isArray(sig.declare) ? sig.declare : []) {
      let re; try { re = new RegExp(d.pattern) } catch { continue }
      const scope = d.scope || 'first_message'
      const hit = scope === 'title' ? re.test(title || '') : scope === 'any_message' ? re.test(hay) : re.test(text || '')
      if (hit) { classes.add('declare'); break }
    }
    for (const ch of Array.isArray(sig.channel) ? sig.channel : []) {
      if ((ch.name && new RegExp(`Channel:\\s*${esc(ch.name)}`).test(hay)) || (ch.uuid && hay.includes(ch.uuid))) {
        classes.add('channel'); if (ch.declaration === 'locked') locked = true; break
      }
    }
    if (Array.isArray(sig.cwd)) {
      for (const c of sig.cwd) { let re; try { re = new RegExp(c.pattern) } catch { continue } if (re.test(String(cwd || '').replace(/\\/g, '/'))) { classes.add('cwd'); break } }
    }
    if (locked) return { role_key: role.role_key, level: 'locked', classes: [...classes], reason: 'channel locked 声明' }
    if (classes.size >= (role.min_signal_classes ?? 2)) best.push({ role_key: role.role_key, classes: classes.size, note: [...classes].join('+') })
  }
  if (!best.length) return { role_key: null, level: null, classes: [], reason: '无信号' }
  best.sort((a, b) => b.classes - a.classes)
  const top = best.filter((b) => b.classes === best[0].classes)
  if (top.length > 1) return { role_key: null, level: null, reason: '多角色平局不猜' }
  return { role_key: top[0].role_key, level: 'candidate', classes: [top[0].note], reason: top[0].note }
}

/**
 * events 里取首条 user 文本（≤600 字）。
 * ⚠️ t27 修复（2026-09-10 实测，两类真实载体）：
 *   ① GUI/输入框消息 = `user/message`（data.content 为 block 数组；权威 role 口径见 lib/notify.js）；
 *   ② **de_session spawn 的初始提示词 = `agent/inbox/spliced`**（data.inserted[].content；实测
 *      spawn 会话 9 条事件里没有 user/message，只有 spliced）——漏掉它会再次取空。
 * 旧实现只找 `type==='message'` + role==='user' → 在真实会话（12213 事件 / 38 条 user/message /
 * **0 条 message**）恒取空 → register 缺 `--input` → AIMS registerCmd 硬失败（--title 与 --input 成对）
 * → 收尾即时沉淀全部落 register-pending（实测 13 行）。
 */
function firstUserText(events) {
  if (!Array.isArray(events)) return ''
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
    }
    return ''
  }
  const textOfInserted = (inserted) => {
    if (!Array.isArray(inserted)) return ''
    return inserted
      .filter((m) => !m?.role || m.role === 'user')
      .map((m) => textOf(m?.content) || textOf(m?.message?.content))
      .join('\n')
  }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const d = ev.data ?? {}
    let s = ''
    if (ev.type === 'user/message') {
      s = textOf(d.content) || textOf(d.message?.content) || textOfInserted(d.inserted)
    } else if (ev.type === 'agent/inbox/spliced') {
      s = textOfInserted(d.inserted)
    } else if (ev.type === 'message') {
      const m = d.message ?? d
      if (m?.role === 'user') s = textOf(m.content)
    }
    if (String(s).trim()) return String(s).slice(0, 600)
  }
  return ''
}

/** events 尾段扫工具名（T1 路径 A 探针；工具记录格式因宿主版本而异——容错多形态） */
function scanToolNames(events) {
  const names = new Set()
  if (!Array.isArray(events)) return names
  for (const ev of events.slice(-120)) {
    try {
      const d = ev?.data ?? ev ?? {}
      const msg = d.message ?? d
      const content = Array.isArray(msg?.content) ? msg.content : null
      if (content) for (const b of content) { if (b?.type === 'tool_use' && b?.name) names.add(b.name) }
      if (d?.toolName) names.add(d.toolName)
      if (typeof d?.name === 'string' && /^(fupan|project-deep-dive|astock|review-dashboard|wechat-account|deepseek-chain)/i.test(d.name)) names.add(d.name)
    } catch { /* 单事件容错 */ }
  }
  return names
}

/** skill 名 → 角色（读 role-signals skill_map；evidence locked/candidate） */
function skillRole(aimsRepo, skillName, agentId) {
  const reg = loadSignals(aimsRepo)
  if (!reg || !skillName) return null
  for (const role of reg.roles) {
    if (role.agent_id && role.agent_id !== agentId) continue
    const skills = Array.isArray(role.signals?.skill) ? role.signals.skill : []
    for (const s of skills) if (s.name === skillName) return { role_key: role.role_key, evidence: s.evidence || 'locked', has_anchors: Array.isArray(role.signals?.output_anchors) && role.signals.output_anchors.length > 0 }
  }
  return null
}

/**
 * 收尾 spawn AIMS register（2s 超时 kill；失败 append pending 不阻断）。
 * ⚠️ t27：AIMS registerCmd 要求 `--title` 与 `--input` **成对**（cli/src/cmd/linkcards.js:287-292），
 * 旧实现 inputSnippet 为空时省略 `--input` → 收尾 register 必然 exit 1（本次实测的失败形态）。
 * 现固定兜底链：user 文本 → title → sessionId，保证契约恒满足（不改变 AIMS 侧零改动纪律）。
 * ⚠️ t27（收严 A）：**会话 id 写侧归一**——入库/产物（link-card 文件名、sessions 行、activation 行）
 * 一律用规范形态 `session-<uuid>`（成员子会话的 agent.id 是裸 uuid，直传会产出裸形态产物、
 * 使 M1 1:1 对拍与 QA 产物断言（文件名归一）无法成立）。归一函数唯一 home = lib/agents/trace.js。
 */
function spawnRegister(aimsRepo, sessionId, title, inputSnippet, extra = {}) {
  return new Promise((resolve) => {
    const node = process.execPath
    const cli = path.join(aimsRepo, 'cli', 'src', 'main.js')
    if (!fs.existsSync(cli)) return resolve({ ok: false, reason: `AIMS cli 不存在: ${cli}` })
    const sessionIdNorm = normalizeSessionId(sessionId) || String(sessionId)
    const args = [node, ['--disable-warning=ExperimentalWarning', cli, 'link-card', 'register', sessionIdNorm]]
    if (title) args[1].push('--title', String(title).slice(0, 200))
    const input = String(inputSnippet ?? '').trim() || String(title ?? '').trim() || sessionIdNorm
    args[1].push('--input', input.slice(0, 200)) // 契约必填：永不省略
    if (extra.agent) args[1].push('--agent', extra.agent)
    if (extra.role) args[1].push('--role', extra.role) // 显式 role 短路 detectRole（docs/70 §2.2）
    if (extra.display) args[1].push('--display', String(extra.display).slice(0, 120)) // t9：副本 frontmatter name 回填（docs/89 §3.2，AIMS 不读副本）
    // t28（docs/112 §三 · 收尾链一会话一条）：AIMS registerCmd 侧同会话已有链 → 复用更新、不新建——
    // 消除「即时收尾标题」与「批处理标题（会话产出登记…）」口径漂移造成的同一会话第二条链。
    args[1].push('--once')
    const child = spawn(node, args[1], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += String(d) })
    let settled = false
    const done = (ok, reason) => { if (!settled) { settled = true; resolve({ ok, reason }) } }
    child.on('error', (e) => done(false, `spawn error: ${e.message}`))
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } done(false, '2s 超时 kill') }, 2000)
    child.on('close', (code) => { clearTimeout(timer); done(code === 0, code === 0 ? 'ok' : `exit ${code}: ${err.slice(0, 200)}`) })
    // 日志落盘（append）
    try {
      fs.mkdirSync(aimsLogDir(aimsRepo), { recursive: true })
      fs.appendFileSync(path.join(aimsLogDir(aimsRepo), 'aims-register.log'), `[${new Date().toISOString()}] register ${sessionIdNorm}（${extra.role ? 'team:' + extra.role : 'auto'}）…\n`, 'utf8')
    } catch { /* noop */ }
  })
}

function appendPending(aimsRepo, rec) {
  try {
    fs.mkdirSync(path.dirname(pendingFile(aimsRepo)), { recursive: true })
    fs.appendFileSync(pendingFile(aimsRepo), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8')
    return true
  } catch { return false }
}

/**
 * 安装观察域。@returns disposer（ctx.effect 卸载一并移除监听）
 * @param {object} ctx cordis ctx（on 事件总线）
 * @param {{ getRuntime: () => object, aimsRepo: string, activationFile?: string, teams?: object }} opts
 *   teams：createTeamDiscover 实例（团队沉淀 t72；缺省无团队能力）
 * @param {{ onFirstSettled?: () => void }} hooks 首回合回调（daily 兜底用）
 */
export function installObserve(ctx, opts, hooks = {}) {
  const { getRuntime, aimsRepo, registry, trace } = opts
  const activationFile = opts.activationFile || DEFAULT_ACTIVATION
  const teams = opts.teams || null
  const registered = new Set() // sessionId → 已 T0/已 register 标记（避免重复）
  const expertSessions = new Map() // sessionId → expertOf 结果（收尾复用，防二次读源）
  const disposers = []

  /** L3 零触发监听告警（给"注册了却从未响应"装观测面）：注册时登记、处理器首行 fire()，
   *  由 lib/index.js 的 15min tick 调 checkNeverFired()；零触发只报"疑似"，需按平台声明集与投喂形状复核。 */
  const eventHealth = createEventHealth({ logger: console })

  const gate = () => getRuntime().aimsDailySyncEnabled === true      // 业务观察（T0/T1/主 register）
  const teamGate = () => getRuntime().aimsTeamAutoRegister === true   // 团队沉淀（docs/70 §五，默认关）
  const expertGate = () => getRuntime().agentsEnabled === true        // 人事部融合域（t9：副本/access 就绪才走 expert 分支）

  /** 会话是否团队成员（subagent origin 例外判定；captain 主会话含于 memberIds 但走主分支） */
  const teamMatchOf = (sid) => (teamGate() && teams ? teams.isTeamMemberSession(sid) : [])

  /**
   * 幂等门：**持久层（台账）优先**，内存 `registered` 降级为同一 install 内的快路径。
   * 幂等键沿用 architect 裁定（docs/112 §三）：**归一 session_id + 产物类型（link-card）**，不新造键。
   * 为什么必须查台账：`registered` 是内存 Set，域重装（配置变更 → aims 域 sync 重装 observe）会清空它
   * ⇒ 同一代宿主内同一会话可被重复 register。实测证据（register.log，同代窗口 2026-09-10T00:43Z–01:55Z）：
   * `a41409fa` 00:43:51 / 01:22:29 / 01:55:26，`929ce5d9` 00:44:14 / 01:25:25 / 01:51:26 ⇒ 同会话 3 次。
   * 台账不可读/不存在 ⇒ 返回 false（**不跳过**；幂等由 AIMS register `--once` 与库侧判重兜底）。
   * @param {string} sid 会话 id（任意形态，内部归一）
   * @returns {boolean} true = 已有收尾产物，应跳过
   */
  const closeoutAlreadyDone = (sid) => {
    const key = normalizeSessionId(sid)
    if (!key) return true // 无规范键不注册（防脏行）
    try { return readCloseoutLedger(aimsRepo).has(key) } catch { return false }
  }

  /** 团队收尾：spawn register --agent lili --role <协作角色>（docs/74 口径修订：
   *  成员职能角色面，非 general）--title 丽丽·<display>·AIMS <短名>；
   *  未映射成员 → general 兜底并 warn（不猜新角色，docs/74 §六）。 */
  function teamRegister(agent, tm, trigger = 'disposed') {
    const sid = agent?.id
    // 内存 Set 只是同 install 快路径；台账才是跨代幂等门（域重装清空 Set ⇒ 此前会重复 register）
    if (!sid || registered.has(`team-reg:${sid}`)) return
    if (closeoutAlreadyDone(sid)) { registered.add(`team-reg:${sid}`); console.log(`[aims-observe] team register ${sid} 已在台账（skip-done：跨代/重装幂等）`); return }
    registered.add(`team-reg:${sid}`)
    const role = roleForMember(tm.name)
    const title = `丽丽·${role.display}·AIMS ${tm.shortName || 'member'}`
    if (!role.matched) {
      console.warn(`[aims-observe] 团队成员 ${tm.name}(${sid}) 无协作角色映射 → 落 general 兜底（docs/74，不猜新角色）`)
    }
    const text = firstUserText(agent.session?.events)
    spawnRegister(aimsRepo, sid, title, text, { agent: 'lili', role: role.role_key }).then((res) => {
      if (!res.ok) {
        // t28（docs/112 §三.3）：pending 记录带**真实素材**（title + input），重放时无需占位文本
        appendPending(aimsRepo, { session_id: normalizeSessionId(sid) || sid, title, input: text, role: role.role_key, ts: new Date().toISOString(), err: res.reason, team: tm.teamId })
        console.error(`[aims-observe] team register ${sid} 失败 → pending: ${res.reason}`)
      } else {
        appendCloseoutMark(aimsRepo, sid, 'link-card', { trigger, role: role.role_key })
        console.log(`[aims-observe] team register ${sid}（${tm.shortName} → ${role.role_key}）ok`)
      }
    })
  }

  /** 专家收尾（docs/72 §三 + docs/89 §3.1 修订：role_key=slug 去 agents/ 前缀、display 取副本
   *  frontmatter name——AIMS 不读副本，由调用侧解析回填，docs/89 §3.2）：
   *  spawn register --agent lili --role <role_key> --display <副本 name>；失败 append pending 不阻断。
   *  ⚠️ 副本 resolve 未命中（access slug 与目录 1:1 漂移，docs/82 N1/N2 类）→ **跳过不建脏行**
   *  （docs/89 §7.3 R3：素材来自副本；未知 slug 宁缺毋滥 → pending 留痕 + warn）。 */
  function expertRegister(agent, exp, trigger = 'disposed') {
    const sid = agent?.id
    if (!sid) return
    // 同 teamRegister：跨代幂等门走台账（域重装清空内存 Set ⇒ 此前会重复 register）
    if (closeoutAlreadyDone(sid)) { console.log(`[aims-observe] expert register ${sid} 已在台账（skip-done：跨代/重装幂等）`); return }
    const roleKey = typeof exp?.role_key === 'string' && exp.role_key ? exp.role_key : null
    if (!roleKey) return
    let display = null
    try {
      const entry = registry?.resolve ? registry.resolve(roleKey) : null
      if (entry?.name) display = entry.name
    } catch { display = null }
    if (!display) {
      appendPending(aimsRepo, { session_id: normalizeSessionId(sid) || sid, role: roleKey, ts: new Date().toISOString(), err: '副本无该角色定义（access slug 与副本 1:1 漂移？）——跳过防脏行', expert: true, skipped: true })
      console.warn(`[aims-observe] expert register ${sid} 跳过：副本无 ${roleKey} 定义（display 无法回填，docs/89 §3.2）`)
      return
    }
    const title = `丽丽·${display}·专家会话`
    const text = firstUserText(agent.session?.events)
    spawnRegister(aimsRepo, sid, title, text, { agent: 'lili', role: roleKey, display }).then((res) => {
      if (!res.ok) {
        appendPending(aimsRepo, { session_id: normalizeSessionId(sid) || sid, title, input: text, role: roleKey, display, ts: new Date().toISOString(), err: res.reason, expert: true })
        console.error(`[aims-observe] expert register ${sid}（${roleKey}）失败 → pending: ${res.reason}`)
      } else {
        appendCloseoutMark(aimsRepo, sid, 'link-card', { trigger, role: roleKey })
        console.log(`[aims-observe] expert register ${sid}（${roleKey} → ${display}）ok`)
      }
    })
  }

  /** 载体适配：onSettled 需要「agent 形状」({id, session})；session/event 给的是 Session ⇒ 包一层。 */
  const asAgentLike = (session) => (session ? { id: session.id, session } : null)

  /**
   * 回合捕获（P0-a：替代一个平台不存在的虚构事件名——根因留痕 docs/rules.md:80 / 负向守卫 tests/aims-event-name-contract.test.js:100）。
   * 事件来源：`session/event` + `event.type === 'turn/end'`
   *   · 声明 `packages/core/session/src/index.ts:76`：`'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`
   *     ⇒ **两个位置参数**（`(session, event)`，不是单对象 payload；平台发射点例：`packages/core/session/src/index.ts:641`）
   *   · 落盘 packages/core/agent-loop/src/agent.ts:319（session.append('turn/end', …)）
   *   · 先例 lib/advisor/index.js:393（同上按 `(session, event)` 取值）
   */
  const onSessionEvent = (session, event) => {
    eventHealth.fire('session/event')
    if (!event || event.type !== 'turn/end') return
    const agent = asAgentLike(session)
    if (!agent) return
    // 空闲 flush 主机制（docs/112 §2.2 v1.2）：每个 turn/end 重置该会话的 unref 计时器，
    // 静默 N 分钟 → 幂等收尾 register。此处用的 turn/end 是**已实证派发**的事件源
    // （本机 70 会话日志 1771 次），故不需要等探针；`agent/status(idle)` 只作可选加速器。
    scheduleIdleFlush(agent)
    onSettled(agent, event.data?.turn ?? null, event.data?.reason ?? null)
  }

  /**
   * 首轮捕获兜底（P0-a 必做）：agentic 会话**从不发 turn/end**（docs/112 §2.2 v1.1 ㈡）
   * ⇒ 以 `agent/inbox/inserted` 兜底，保证纯 agentic 会话也能拿到 T0。
   * 事件来源：`agent/inbox/inserted`，声明 packages/core/agent/src/runtime-types.ts:186
   * （payload `{ agent, message }`）。
   */
  const onInboxInserted = (payload) => {
    eventHealth.fire('agent/inbox/inserted')
    const agent = payload?.agent
    if (!agent) return
    if (!agent.id) return
    // 纯 agentic 会话从不发 turn/end（docs/112 §2.2 v1.2）⇒ 用同一条"静默计时"语义：
    // 每次收件重置计时器，静默 N 分钟 → 幂等 register。
    scheduleIdleFlush(agent)
    if (registered.has(`first:${agent.id}`)) return // 已首轮处理过则不重复（同 install 快路径）
    onSettled(agent, null, { kind: 'inbox' })
  }

  /**
   * 空闲兜底**加速器**（P0-a；docs/112 §2.2 v1.2 降级）：`agent/status` + `status === 'idle'`
   * 只在**探针实证其确实派发**后才是加速器——flush 的主机制是 `turn/end` 计时（见 onSessionEvent），
   * 本监听缺席也不影响 flush 生效（scoped 事件不进会话日志 ⇒ "idle 是否真发"无法由日志证实）。
   * 事件来源：声明 packages/core/agent/src/runtime-types.ts:178；发射 packages/core/agent-loop/src/agent.ts:109
   * ⚠️ 硬约束（docs/112 §2.2 v1.1 ㈠）：idle 每轮会发 **≥2 次** ⇒ 本处只做"续期"；
   *    收到 `running` **立即取消**计时器（先例 ws-coord.js:716 / coi/index.js:558）；
   *    计时值 ≤0（默认 0=关）时 scheduleIdleFlush 内部直接 return，**不投任何 timer**。
   * ⚠️ payload 是**单对象** `{agent, status}`（coi/presence.js:52 曾按两个位置参数误用）。
   */
  const onAgentStatus = (payload) => {
    eventHealth.fire('agent/status')
    const agent = payload?.agent
    if (!agent?.id) return
    if (payload?.status === 'running') { clearIdleFlush(agent.id); return }
    if (payload?.status !== 'idle') return
    scheduleIdleFlush(agent)
  }

  const onSettled = (agent, turn, reason) => {
    try {
      const header = agent?.session?.header ?? {}
      const sid = agent?.id
      if (!sid) return
      // P0-a v1.2：空闲 flush 由 `turn/end` 计时主驱动（onSessionEvent 内 scheduleIdleFlush），
      // `agent/status(idle)` 仅作加速器；本函数保持职责单一（沉淀与计数）。
      if (header.origin === 'subagent') {
        // t72：团队成员 subagent 例外——团队会话 T0/T1 短路（不 append 业务 activation，docs/70 §四）；
        // 收尾由 onDisposed teamRegister 处理；一次性 subagent 保持 docs/67 跳过（不回归）
        if (teamGate() && teams?.isTeamMemberSession(sid).length) {
          if (!registered.has(`first:${sid}`)) {
            registered.add(`first:${sid}`)
            // P0-a（captain 2026-09-10 裁定）：`onFirstSettled` 这条"首回合提前补跑"入口**按退休处理**——
            // 它一直挂在虚构事件上（从未执行），且 **daily 的权威驱动是 15min tick**（lib/index.js:62-64
            // setInterval → daily.tick()），不需要靠"首回合"触发。此处仅保留 first:<sid> 标记（供幂等观察）。
          }
        }
        return
      }
      if (!gate()) return
      // captain/主会话团队判定：captain 属主 origin——业务 T0/T1 短路（docs/70 §四 防架构师/审计词污染）
      const tmArr = teams?.isTeamMemberSession(sid) || []
      const isCaptain = tmArr.some((t) => t.captain)
      if (isCaptain) return // captain 主会话由既有收尾 register（title=header）处理，T0/T1 不跑业务检测
      // t9 专家分支（docs/82 §3.2 判定序 team > access(expert) > main）：非团队主会话在
      // access.jsonl 有 session_id 命中（判据 b 硬证据）→ 短路业务 T0/T1（M2 零污染），
      // 记录 expertOf 供收尾 expertRegister（display 取副本 frontmatter——docs/89 §3.2）。
      let expMain = null
      if (expertGate()) {
        try { expMain = trace?.expertOf ? trace.expertOf(sid) : null } catch { expMain = null }
      }
      if (expMain && !registered.has(`ex:${sid}`)) { registered.add(`ex:${sid}`); expertSessions.set(sid, expMain) }
      if (expMain) {
        if (!registered.has(`first:${agent.id}`)) {
          registered.add(`first:${agent.id}`)
          if (typeof hooks.onFirstSettled === 'function') { try { hooks.onFirstSettled() } catch { /* noop */ } }
        }
        return // 专家身份由 access 表达：业务 T0/T1 短路（docs/82 §3.2/M2）
      }
      if (!registered.has(`t0:${sid}`)) {
        // T0 declare：首回合（reason completed + message turn）扫首 user 文本 + cwd + header title
        let messageTurn = false
        const events = agent.session?.events
        if (Array.isArray(events)) {
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i]
            if (ev?.type === 'turn/start' && ev.data?.turn === turn) { messageTurn = ev.data?.trigger?.kind === 'message'; break }
          }
        }
        if (messageTurn || reason?.kind === 'completed') {
          registered.add(`t0:${agent.id}`)
          const text = firstUserText(events) || ''
          const det = detectTextRole(aimsRepo, {
            agentId: header.agent_id ?? header.agent ?? 'lili', title: header.title ?? '', cwd: header.cwd ?? agent.session?.cwd ?? '', text,
          })
          if (det.role_key) {
            const r = appendActivation({ role_key: det.role_key, agent_id: header.agent_id ?? 'lili', session_id: normalizeSessionId(agent.id) || agent.id, signal: 'declare', nature: 'resident', confidence: det.level === 'locked' ? 1 : 0.6 }, activationFile)
            if (r.appended) console.log(`[aims-observe] T0 declare ${det.role_key} ← ${agent.id}`)
          }
        }
      }
      // T1 skill 路径 A（探针：能拿到工具痕迹即写 skill 行）
      const tools = scanToolNames(agent.session?.events)
      if (tools.size) {
        for (const name of tools) {
          const hit = skillRole(aimsRepo, name, header.agent_id ?? 'lili')
          if (hit && !registered.has(`t1:${agent.id}:${hit.role_key}`)) {
            registered.add(`t1:${agent.id}:${hit.role_key}`)
            // 双证据角色（output_anchors）：锚点未证 → 仍 append（candidate 语义），收尾/回扫可升级
            const r = appendActivation({ role_key: hit.role_key, agent_id: header.agent_id ?? 'lili', session_id: normalizeSessionId(agent.id) || agent.id, signal: 'skill', nature: 'resident', confidence: hit.evidence === 'locked' && !hit.has_anchors ? 1 : 0.8 }, activationFile)
            if (r.appended) console.log(`[aims-observe] T1 skill ${name} → ${hit.role_key} ← ${agent.id}`)
          }
        }
      }
      if (!registered.has(`first:${agent.id}`)) {
        registered.add(`first:${agent.id}`)
        if (typeof hooks.onFirstSettled === 'function') { try { hooks.onFirstSettled() } catch { /* noop */ } }
      }
    } catch (e) { console.error('[aims-observe] settled 处理失败:', e?.message ?? e) }
  }

  // ---- t28：空闲超时 flush（docs/112 §2.2「三段职责」）----------------------------------------
  // disposed = 权威 register（唯一能保证"完整会话已结束"的时点）；但**开一整天不关的会话**在关闭前
  // 零沉淀 —— 这是主人拍板「收尾自动 register」语义的实际缺口，故补「N 分钟无新回合 → 幂等 register」。
  // 门控：aimsIdleFlushMinutes（number；0=关 → 默认关，用户可见行为变更需显式开启，docs/87 §五 红线）。
  const flushTimers = new Map() // sid → { timer, agent }
  const idleFlushMinutes = () => {
    const v = getRuntime().aimsIdleFlushMinutes
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0
  }
  function clearIdleFlush(sid) {
    const e = flushTimers.get(sid)
    if (!e) return
    try { clearTimeout(e.timer) } catch { /* noop */ }
    flushTimers.delete(sid)
  }
  /** 每次 settled 重置该会话的 flush 计时（最后一次回合后 N 分钟触发一次幂等 register）。 */
  function scheduleIdleFlush(agent) {
    const mins = idleFlushMinutes()
    const sid = agent?.id
    if (!mins || !sid) return
    clearIdleFlush(sid)
    const timer = setTimeout(() => {
      flushTimers.delete(sid)
      try { closeoutRegister(agent, 'idle-flush') } catch (e) { console.error('[aims-observe] idle flush 失败:', e?.message ?? e) }
    }, mins * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    flushTimers.set(sid, { timer, agent })
  }
  function disposeIdleFlush() { for (const sid of [...flushTimers.keys()]) clearIdleFlush(sid) }

  /**
   * t28：收尾沉淀（**disposed 与空闲 flush 共用**；trigger ∈ {'disposed','idle-flush'}）。
   * 分支序 team > access(expert) > main（docs/82 §3.2）；幂等由三层保证：
   * ① registered 标记（同进程）② AIMS register `--once`（一会话一收尾链）③ activation 归一键集。
   * 失败只落 pending（带真实 title/input）不抛——不阻断会话结束与宿主生命周期。
   * @param {object} agent DSH agent（含 session.header/events）
   * @param {'disposed'|'idle-flush'} trigger 触发来源（仅日志标记，不进幂等键）
   */
  const closeoutRegister = (agent, trigger = 'disposed') => {
    const header = agent?.session?.header ?? {}
    const sid = agent?.id
    if (!sid) return
    const tag = trigger === 'idle-flush' ? 'idle-flush ' : ''
    if (header.origin === 'subagent') {
      // t72 团队分支：成员会话收尾 → teamRegister（agent lili / 协作角色显式短路 / 成员职能标题，docs/74）
      if (teamGate() && teams) {
        const tm = teams.isTeamMemberSession(sid)[0]
        if (tm && !tm.captain) { teamRegister(agent, tm, trigger); return }
      }
      // t9 专家分支（docs/72 §二 判据 b + docs/89 判定序 team > access(expert) > main）：
      // 单拉人事部专家（非团队成员）subagent 会话 access 命中 → expertRegister；未命中
      // 维持 docs/67 跳过（不回归）
      if (expertGate()) {
        let exp = null
        try { exp = trace?.expertOf ? trace.expertOf(sid) : null } catch { exp = null }
        if (exp && !registered.has(`exreg:${sid}`)) {
          registered.add(`exreg:${sid}`)
          expertRegister(agent, exp, trigger)
          return
        }
      }
      return // 一次性 subagent / 开关关：docs/67 跳过（不回归）
    }
    if (!gate()) return
    // t9 专家优先于普通 register（docs/82 §3.2 判定序：team > access(expert) > main）。
    // 团队会话（captain/成员主路径）维持 docs/70 语义不 expert 化——captain 落既有 register。
    const tmMain = ((teams?.isTeamMemberSession ? teams.isTeamMemberSession(sid) : []) ?? [])
    if (expertGate() && tmMain.length === 0) {
      let exp = expertSessions.get(sid) ?? null
      if (!exp) { try { exp = trace?.expertOf ? trace.expertOf(sid) : null } catch { exp = null } }
      if (exp && !registered.has(`exreg:${sid}`)) {
        registered.add(`exreg:${sid}`)
        expertRegister(agent, exp, trigger)
        return
      }
    }
    // t28（captain 裁定 ④）：**spawn 前查一次持久台账** —— 域重装/宿主重启会清空内存 Set，
    // 只有台账（appendCloseoutMark 写的 mark）能保证「重启批次不重复建链」。台账不可读时退回内存 Set 语义。
    if (closeoutAlreadyDone(sid)) {
      console.log(`[aims-observe] ${tag}register ${sid} 已在台账（skip-done：跨代/重装幂等）`)
      return
    }
    if (registered.has(`reg:${sid}`)) return
    registered.add(`reg:${sid}`)
    // t33(b)：title 兜底链**不再回退成会话 id**（id 当标题会污染卡面与 sessions.title）；改为
    // 真实标题 → 首条用户文本（截断）→ 明确占位符（可读、且一眼看出是缺参而非"标题就叫这个 id"）。
    const title = header.title ?? ((firstUserText(agent.session?.events) || '').slice(0, 60) || '（未命名会话）')
    const text = firstUserText(agent.session?.events)
    spawnRegister(aimsRepo, sid, title, text).then((res) => {
      if (!res.ok) {
        // t28（docs/112 §三.3）：pending 带真实素材 → 重放不再依赖占位文本；session_id 归一
        appendPending(aimsRepo, { session_id: normalizeSessionId(sid) || sid, title, input: text, ts: new Date().toISOString(), err: res.reason, trigger })
        console.error(`[aims-observe] ${tag}register ${sid} 失败 → pending: ${res.reason}`)
      } else {
        appendCloseoutMark(aimsRepo, sid, 'link-card', { trigger, role: null })
        console.log(`[aims-observe] ${tag}register ${sid} ok`)
      }
    })
  }

  const onDisposed = ({ agent }) => {
    eventHealth.fire('agent/disposed')
    try {
      clearIdleFlush(agent?.id) // 真收尾：撤销待触发 flush（register 幂等，双触发无害但少一次子进程）
      closeoutRegister(agent, 'disposed')
    } catch (e) { console.error('[aims-observe] disposed 处理失败:', e?.message ?? e) }
  }

  // ⚠️ P0 修复（2026-09-10）：原监听的是一个平台**不存在**的虚构事件名（声明集无 · packages/** 0 命中 ·
  // 70 会话/159.5MB 日志 0 次派发）⇒ cordis 静默接受 ⇒ 该监听**从未触发**（连带 scheduleIdleFlush / T0 declare 全哑）；字面留痕见 docs/rules.md:80。
  // 真实来源：**`agent/status`**（payload `{agent, status:'idle'|'running'}`）——发射点
  // packages/core/agent-loop/src/agent.ts:109 `this.dispatch.emit('agent/status', { status })`；
  // 声明 packages/core/agent/src/runtime-types.ts（Events 接口）；注释明说 idle = "no driver remains scheduled or active"
  // ⇒ 语义上就是原先想要的 "settled"。
  // ── 事件接线（P0-a；每个名字都在上一行注明平台声明来源 file:line，指不出来源即视为未完成实现）──
  // 声明 packages/core/session/src/types.ts「'turn/end'」；落盘 agent-loop/src/agent.ts:319
  eventHealth.register('session/event')
  disposers.push(ctx.effect(() => ctx.on('session/event', onSessionEvent)))
  // 声明 packages/core/agent/src/runtime-types.ts:186（payload {agent,message}）
  eventHealth.register('agent/inbox/inserted')
  disposers.push(ctx.effect(() => ctx.on('agent/inbox/inserted', onInboxInserted)))
  // 声明 packages/core/agent/src/runtime-types.ts:178；发射 packages/core/agent-loop/src/agent.ts:109
  eventHealth.register('agent/status')
  disposers.push(ctx.effect(() => ctx.on('agent/status', onAgentStatus)))
  // 声明 packages/core/agent/src/runtime-types.ts（payload {agent}）；生成目录 packages/extensions/tool-cordis/src/api-catalog.ts:2185
  eventHealth.register('agent/disposed')
  disposers.push(ctx.effect(() => ctx.on('agent/disposed', onDisposed)))

  // t28（captain ⑦：emit 侧打点，"一行文件就够"）：**每次挂载写一行**，用于判定
  // ①挂载是否发生 ②域是否被重装（每行一 install）③注册了哪些事件名。始终开启、单行、自限大小。
  try {
    const bootDir = aimsLogDir(aimsRepo)
    fs.mkdirSync(bootDir, { recursive: true })
    fs.appendFileSync(path.join(bootDir, 'aims-observe-boot.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event: 'observe/mounted', listeners: ['session/event', 'agent/inbox/inserted', 'agent/status', 'agent/disposed'], probe: getRuntime().aimsEventProbe === true })}\n`,
      'utf8')
  } catch { /* 打点失败不影响主流程 */ }

  // t28 生命周期事件探针（aimsEventProbe，默认关）：平台声明的 agent/session 事件**不落会话日志**
  //（实测 70 个会话日志 / 159.5MB 内 agent/created · agent/disposed · session/disposed · subagent/* 全为 0），
  // 而"什么动作会 emit agent/disposed"决定收尾 register 的驱动点 ⇒ 必须实测。只写日志、不改行为；
  // 事件名取平台声明集（packages/core/scope/src/scoped-events.generated.ts），每行一条 JSON。
  let probeBytes = 0
  let probeStopped = false
  const writeProbe = (type, args) => {
    if (probeStopped) return
    try {
      const first = args?.[0] ?? {}
      // 载体：agent 系事件 = 单对象 payload（`{agent,…}`，声明 packages/core/agent/src/runtime-types.ts）；
      // session 系事件 = **位置参数**（`(session, event)` / `(session)`，声明 packages/core/session/src/index.ts:76）。
      const carrier = first?.agent ?? first?.session ?? first
      const inner = args?.[1] ?? null
      const rec = {
        ts: new Date().toISOString(),
        type,
        agent_id: carrier?.id ?? null,
        session_id: carrier?.id ?? carrier?.session?.id ?? first?.sessionId ?? null,
        // 判定用明细：agent/status → 'idle'|'running' 计数；session/event → 内层事件类型（turn/end 等）
        detail: type === 'agent/status' ? (first?.status ?? null) : (inner?.type ?? null),
        turn: inner?.data?.turn ?? null,
        arg_keys: Object.keys(first && typeof first === 'object' ? first : {}).slice(0, 8),
      }
      const line = `${JSON.stringify(rec)}\n`
      const dir = aimsLogDir(aimsRepo)
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, `aims-events-${new Date().toISOString().slice(0, 10)}.log`), line, 'utf8')
      probeBytes += Buffer.byteLength(line)
      if (probeBytes > 5 * 1024 * 1024) probeStopped = true // 上限自停，防日志失控
    } catch { /* 探针失败不影响主流程 */ }
  }
  if (getRuntime().aimsEventProbe === true) {
    // 观察名单 = agent 生命周期 12 名中的可观测者 + 会话生命周期 + 三个**判定用**事件源：
    // `agent/status`（idle/running 实发计数 ⇒ 决定加速器是否可信）、`session/event`（turn/end 对照计数）、
    // `agent/turn-stopping`（只观测 payload/频率；⚠️ 该事件 @mode serial + "Awaited before the boundary commits"，
    //   探针在此**只写日志、不做任何 I/O 阻塞**，且探针本身也只写一行 JSON）。
    for (const type of ['agent/created', 'agent/disposed', 'agent/turn-stopping', 'agent/status', 'agent/inbox/inserted', 'session/created', 'session/disposed', 'session/event', 'subagent/start', 'subagent/end']) {
      disposers.push(ctx.effect(() => ctx.on(type, (...args) => writeProbe(type, args))))
    }
    writeProbe('probe/start', [{ note: 'aimsEventProbe=on（只写日志，不改行为）' }])
  }

  return {
    dispose() {
      disposeIdleFlush() // t28：卸载清理（unref timer + 显式撤销）
      for (const fn of disposers.splice(0)) { try { fn() } catch { /* noop */ } }
    },
    status: () => ({
      activation_file: activationFile,
      registered: registered.size,
      idle_flush: { minutes: idleFlushMinutes(), pending_timers: flushTimers.size },
      teams: teams ? teams.teams().map((t) => ({ teamId: t.teamId, members: t.memberIds.size })) : [],
    }),
    eventHealth, // L3：零触发监听告警（lib/index.js 的 15min tick 调 checkNeverFired）
    _test: { appendActivation, detectTextRole, spawnRegister, firstUserText, scanToolNames, skillRole, teamRegister, expertRegister, closeoutRegister, scheduleIdleFlush, clearIdleFlush, idleFlushMinutes, flushTimerCount: () => flushTimers.size }, // 冒烟/探针出口
  }
}
