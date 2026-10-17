// AIMS 动态闭环 · 每日调度域（t68 · docs/67 §三；t29 修订兜底常量与注释）
// 职责：15min tick + DEFAULT_SYNC_WINDOW（= aimsDailySyncTime，运行时默认 22:00）时间窗 +
//       日期滚动状态 + 首回合 guard（runOnceIfDue 供 observe 首回合触发）→ 任务链 spawn：
//       run-dsh-import --apply → run-memory-import --apply →（可选 aimsDailyLink：batch-link-register）
//       → pending 重放（t27：归一 id + 保留 role/agent）。
// 状态文件：<aimsRepo>/data/aims/daily-sync-last.json {date, ok, attempts, lastError?}
// 纪律：每步独立 spawn（一步失败不阻断后续，幂等下轮补齐）；try/catch + 状态记录；unref 定时。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSessionId } from '../agents/trace.js' // t27：pending 重放同样走写侧归一（规范=去前缀，docs/112 §一.2）
import { readCloseoutLedger, appendCloseoutMark } from './ledger.js' // t28：收尾台账（重放前查重 → 已沉淀直接移出，P1/P2 单调不增）

const TICK_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 3

/**
 * 时间窗兜底常量（t29）：必须与 `lib/index.js` DEFAULTS.aimsDailySyncTime 一致（= **22:00**）。
 * 旧值为 `'02:10'`（t68 初稿遗留），与运行时默认相反 → 运行时若缺 `aimsDailySyncTime`
 * 会按 02:10 判定「未到点」，当天 22:00 的兜底窗口不触发（静默漏跑）。
 * 不变量由 `tests/aims-daily-t29.test.js` 守护（含阴性对照：改回 02:10 必失败）。
 */
export const DEFAULT_SYNC_WINDOW = '22:00'

/**
 * 「是否到点且当日未成功跑」纯函数（t29 抽出：可对边界时刻/状态做单测与阴性对照）。
 * @param {{enabled:boolean, window:string, now:string, today:string, state:object|null, maxAttempts?:number}} a
 *   window/now/today 均为 HH:MM 或 YYYY-MM-DD 字符串（nowHHMM/today 的口径）
 * @returns {boolean} 到点（now ≥ window）且当日未成功跑且未超重试上限
 */
export function dueDecision({ enabled, window, now, today: todayStr, state, maxAttempts = MAX_ATTEMPTS }) {
  if (enabled !== true) return false
  const passWindow = String(now) >= String(window) // 已过时间窗
  if (state?.date === todayStr && state?.ok === true) return false // 今日已成功
  if (state?.date === todayStr && (state?.attempts ?? 0) >= maxAttempts) return false // 今日重试超限
  return passWindow
}

/**
 * pending 行 → `link-card register` 参数（纯函数，可单测；t27 修正两处缺陷）。
 * ⚠️ 旧实现只传 `--title/--input`：① **丢失 role/agent** → 重放后一律落 general（实测 09-09 批次 10 条
 * 全为「role 自动检测无信号 → general」），成员/专家角色面与 activation 留痕随之丢失；
 * ② **session_id 用行内裸 uuid** → 产物文件名/库行非规范形态，QA 产物断言（归一）不成立。
 * @param {{session_id:string, title?:string, role?:string|null, agent?:string|null, input?:string|null}} rec pending 行
 * @returns {string[]} CLI 参数（不含 node 与脚本路径）
 */
export function replayRegisterArgs(rec = {}) {
  const sid = normalizeSessionId(rec.session_id) || String(rec.session_id ?? '')
  const args = ['link-card', 'register', sid, '--title', String(rec.title ?? sid).slice(0, 200)]
  args.push('--input', String(rec.input ?? '（daily pending 重放）').slice(0, 200))
  if (rec.agent) args.push('--agent', String(rec.agent))
  else args.push('--agent', 'lili') // 归一身份轴（docs/74：agent_id 恒 lili）
  if (rec.role) args.push('--role', String(rec.role))
  if (rec.display) args.push('--display', String(rec.display))
  return args
}

/**
 * pending 行重放判定（t28 纯函数，可单测；docs/112 §三.3 并轨）。
 * 幂等键 = **归一后 session_id + 产物类型（link-card）**：即时沉淀已落台账（doneKeys）→ 视为完成、不 spawn。
 * @param {object|null} rec pending 行（JSON 解析结果）
 * @param {Set<string>} doneKeys 收尾台账中的已沉淀会话（归一 id 集合）
 * @returns {'replay'|'skip-marked'|'skip-done'|'malformed'} 处置（malformed → 保留原行待人工）
 */
export function pendingReplayDecision(rec, doneKeys) {
  if (!rec || typeof rec !== 'object') return 'malformed'
  if (rec.skipped === true) return 'skip-marked' // t9 防脏行标记：无需重放，直接消费
  const key = normalizeSessionId(rec.session_id)
  if (!key) return 'malformed'
  if (doneKeys && typeof doneKeys.has === 'function' && doneKeys.has(key)) return 'skip-done'
  return 'replay'
}

function stateFile(aimsRepo) { return path.join(aimsRepo, 'data', 'aims', 'daily-sync-last.json') }
/** t28 可审计性（captain 修订裁定 (b)）：重放台账——逐行记录 pending 的消费（谁/何时/处置/结果）。 */
function replayLedgerFile(aimsRepo) { return path.join(aimsRepo, 'data', 'aims', 'replay-ledger.jsonl') }
/**
 * 追加一条重放消费记录。
 * 审计口径：回答「这 N 行 pending 是被谁、何时消费的」——by=runOnce 表示经批次编排，
 * 外部脚本绕过 runOnce 直接调 CLI 时**不会**产生本记录（那属"未申报消费"，需人工在日志/台账交叉核对）。
 * @param {string} aimsRepo AIMS 仓库根
 * @param {{session_id:string, decision:string, ok?:boolean, reason?:string|null, trigger?:string}} rec 消费记录
 */
function appendReplayRecord(aimsRepo, rec) {
  try {
    const p = replayLedgerFile(aimsRepo)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), by: 'runOnce', ...rec })}\n`, 'utf8')
  } catch { /* 台账写入失败不影响主流程 */ }
}
function logFile(aimsRepo, date) { return path.join(aimsRepo, 'data', 'logs', `daily-sync-${date}.log`) }
function pendingFile(aimsRepo) { return path.join(aimsRepo, 'data', 'aims', 'register-pending.jsonl') }

function readState(aimsRepo) {
  try { return JSON.parse(fs.readFileSync(stateFile(aimsRepo), 'utf8')) } catch { return null }
}
function writeState(aimsRepo, s) {
  try { fs.mkdirSync(path.dirname(stateFile(aimsRepo)), { recursive: true }); fs.writeFileSync(stateFile(aimsRepo), JSON.stringify(s, null, 2), 'utf8') } catch { /* 状态写失败不致命 */ }
}
const today = () => new Date().toISOString().slice(0, 10)
const nowHHMM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

function runSpawn(nodeBin, scriptPath, args, logPath) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.stderr?.on('data', (d) => { err += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 120000) // 每步 2min 兜底
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${scriptPath} ${args.join(' ')} → exit ${code}\n${out.slice(-2000)}\n${err.slice(-2000)}\n`, 'utf8')
      } catch { /* noop */ }
      resolve({ ok: code === 0, code })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, err: e.message }) })
  })
}

/**
 * 安装每日调度域。@returns { runOnceIfDue, tick, status, dispose }
 * @param {object} ctx 未用（独立模块；定时器自管理）
 * @param {{ getRuntime: () => object, aimsRepo: string, nodeBin?: string }} opts
 */
export function installDaily(ctx, opts) {
  const { getRuntime, aimsRepo } = opts
  const nodeBin = opts.nodeBin || process.execPath
  let running = false
  let timer = null

  const enabled = () => getRuntime().aimsDailySyncEnabled === true
  const windowTime = () => String(getRuntime().aimsDailySyncTime ?? DEFAULT_SYNC_WINDOW)

  const log = (msg) => { try { fs.appendFileSync(logFile(aimsRepo, today()), `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* noop */ } }

  /** 是否到点且当日未成功跑（含首次/重试 ≤3）——判定体在纯函数 dueDecision（t29 可测） */
  function due() {
    return dueDecision({ enabled: enabled(), window: windowTime(), now: nowHHMM(), today: today(), state: readState(aimsRepo) })
  }

  /** 执行一次任务链（幂等；每步独立 spawn） */
  async function runOnce() {
    if (running) return { ran: false, reason: '已在运行' }
    if (!enabled()) return { ran: false, reason: '开关关' }
    running = true
    const date = today()
    const st = readState(aimsRepo) || {}
    const attempts = (st.date === date ? st.attempts ?? 0 : 0) + 1
    const lf = logFile(aimsRepo, date)
    try {
      log(`=== daily sync 开始（attempt ${attempts}）===`)
      const chain = []
      // 1. DSH 会话增量导入
      chain.push({ name: 'dsh-import', script: path.join(aimsRepo, 'pipeline', 'src', 'run-dsh-import.mjs'), args: ['--apply'] })
      // 2. memory 六轨增量导入
      chain.push({ name: 'memory-import', script: path.join(aimsRepo, 'pipeline', 'src', 'run-memory-import.mjs'), args: ['--apply'] })
      // 3.（可选）batch-link-register（现成脚本若存在；dry 先行语义由脚本自带）
      if (getRuntime().aimsDailyLink === true) {
        const blr = path.join(aimsRepo, 'scripts', 'batch-link-register.mjs')
        if (fs.existsSync(blr)) chain.push({ name: 'batch-link', script: blr, args: [] })
      }
      const results = []
      for (const step of chain) {
        if (!fs.existsSync(step.script)) { results.push({ name: step.name, ok: false, reason: '脚本不存在' }); log(`step ${step.name} 脚本不存在，跳过`); continue }
        const r = await runSpawn(nodeBin, step.script, step.args, lf)
        results.push({ name: step.name, ok: r.ok, code: r.code })
        log(`step ${step.name} → ${r.ok ? 'ok' : `fail(${r.code})`}`)
      }
      // 4. pending 重放（register-pending.jsonl 逐条 → 成功/已沉淀即移除；t27：归一 id + 带 role/agent）
      //    t28 并轨（docs/112 §三.3）：收尾台账查重（已即时沉淀 → 直接移出、不 spawn）+ `--once`（一会话一收尾链）
      let replayed = 0
      let skipped = 0
      let alreadyDone = 0
      const pf = pendingFile(aimsRepo)
      if (fs.existsSync(pf)) {
        const lines = fs.readFileSync(pf, 'utf8').split('\n').filter(Boolean)
        const remain = []
        const done = readCloseoutLedger(aimsRepo) // 即时沉淀（observe）已落账的会话集合
        for (const l of lines) {
          let rec; try { rec = JSON.parse(l) } catch { remain.push(l); continue }
          const decision = pendingReplayDecision(rec, done)
          if (decision === 'skip-marked') {
            replayed += 1; skipped += 1
            appendReplayRecord(aimsRepo, { session_id: normalizeSessionId(rec.session_id) || null, decision, trigger: 'skip-marked' })
            continue
          } // t9 防脏行标记：无需重放，直接消费
          if (decision === 'skip-done') {
            alreadyDone += 1
            appendReplayRecord(aimsRepo, { session_id: normalizeSessionId(rec.session_id) || null, decision, trigger: 'closeout-ledger' })
            continue
          } // 已沉淀 → 视为完成（幂等键=归一 session_id + link-card）
          if (decision === 'malformed') {
            appendReplayRecord(aimsRepo, { session_id: null, decision, reason: 'JSON 解析失败（保留原行待人工）' })
            remain.push(l); continue
          }
          const key = normalizeSessionId(rec.session_id)
          const cli = path.join(aimsRepo, 'cli', 'src', 'main.js')
          const r = await runSpawn(nodeBin, cli, [...replayRegisterArgs({ ...rec, session_id: key }), '--once'], lf)
          if (r.ok) {
            replayed += 1
            appendCloseoutMark(aimsRepo, key, 'link-card', { trigger: 'daily-replay', role: rec.role ?? null })
            appendReplayRecord(aimsRepo, { session_id: key, decision: 'replayed', ok: true, trigger: 'daily-replay', role: rec.role ?? null })
          } else {
            appendReplayRecord(aimsRepo, { session_id: key, decision: 'replay-failed', ok: false, reason: r.reason ?? null, trigger: 'daily-replay' })
            remain.push(l)
          }
        }
        try { fs.writeFileSync(pf, remain.join('\n') + (remain.length ? '\n' : ''), 'utf8') } catch { /* noop */ }
      }
      const allOk = results.every((r) => r.ok)
      const replayTouched = replayed + alreadyDone + skipped > 0
      const prevState = readState(aimsRepo) || {}
      // t28（captain 裁定「统一收口单写者」）：状态文件**只由 runOnce 写**。重放发生在本函数内部（步骤 4），
      // 因此重放事实也由这里落账：replayed/alreadyDone/skipped + lastReplayAt（本轮无重放则沿用上次值，不误刷）。
      // ⚠️ 语义边界：**状态文件 ≠ 重放记录** —— 外部脚本绕过 runOnce 直接驱动 CLI 的重放不会更新本文件；
      //    重放真相以「pending 行数变化 + closeout-ledger 台账」为准（docs/116 §七）。
      writeState(aimsRepo, {
        date,
        ok: allOk,
        attempts,
        ranAt: new Date().toISOString(),
        steps: results,
        replayed,
        alreadyDone,
        skipped,
        lastReplayAt: replayTouched ? new Date().toISOString() : (prevState.lastReplayAt ?? null),
        lastError: allOk ? null : JSON.stringify(results.filter((r) => !r.ok)),
      })
      log(`=== daily sync ${allOk ? '完成' : '部分失败'}（steps ${results.length}，pending 重放 ${replayed}，已沉淀跳过 ${alreadyDone}）===`)
      return { ran: true, ok: allOk, steps: results, replayed }
    } catch (e) {
      writeState(aimsRepo, { date, ok: false, attempts, ranAt: new Date().toISOString(), lastError: String(e?.message ?? e) })
      log(`=== daily sync 异常: ${e?.message ?? e} ===`)
      return { ran: true, ok: false, error: e?.message ?? String(e) }
    } finally {
      running = false
    }
  }

  /** 到点即跑（tick 与首回合 guard 共用；幂等内部再判） */
  async function runOnceIfDue() {
    if (!due()) return { ran: false, reason: '未到点/今日已完成/超限' }
    return runOnce()
  }

  /** 15min tick（unref） */
  function startTick() {
    if (timer) return
    timer = setInterval(() => { runOnceIfDue().catch(() => {}) }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    runOnceIfDue,
    tick: runOnceIfDue,
    status: () => ({ enabled: enabled(), window: windowTime(), state: readState(aimsRepo) }),
    dispose() { if (timer) { clearInterval(timer); timer = null } },
    _test: { due, runOnce },
  }
}
