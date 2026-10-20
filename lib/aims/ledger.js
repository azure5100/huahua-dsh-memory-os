// AIMS 收尾沉淀台账（t28 · docs/112 §三）—— 跨写入路径的幂等门。
// 职责：记录「某会话的收尾产物已产出」这一事实，供同插件内的多条路径互查：
//   即时沉淀（observe：disposed / 空闲 flush）完成后落账；daily pending 重放前查账——
//   已落账的 pending 行直接视为已完成并移出（不 spawn 子进程），保证 pending 单调不增（§三 P1/P2）。
// 说明：批处理（AIMS scripts/batch-link-register.mjs）在**库侧**自行判重（该 session 已有 links 行即跳过），
//       与本台账互为独立防线；幂等键口径统一为「归一后的 session_id + 产物类型」。
// 纪律：台账写在 AIMS repo 的 data/aims/ 下（与 register-pending.jsonl 同目录，属宿主插件数据面）；
//       写入 append-only、行级容错、失败静默降级（绝不阻断收尾）。
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSessionId } from '../agents/trace.js'

/** 台账文件路径（与 register-pending.jsonl 同目录）。 */
export function ledgerPath(aimsRepo) {
  return path.join(aimsRepo, 'data', 'aims', 'closeout-ledger.jsonl')
}

/**
 * 读台账 → 已沉淀会话集合（归一 id）。
 * @param {string} aimsRepo AIMS 仓库根
 * @returns {Set<string>} 已落账的规范会话 id 集合（文件缺失/读取失败 → 空集合）
 */
export function readCloseoutLedger(aimsRepo) {
  const out = new Set()
  try {
    const p = ledgerPath(aimsRepo)
    if (!fs.existsSync(p)) return out
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        const key = normalizeSessionId(o.session_id)
        if (key) out.add(key)
      } catch { /* 单行容错 */ }
    }
  } catch { /* 读失败 → 空集合（下游重放照常尝试，幂等由 AIMS register 兜底） */ }
  return out
}

/**
 * 落账（append-only；失败静默返回 false，不抛）。
 * @param {string} aimsRepo AIMS 仓库根
 * @param {string} sessionId 会话 id（任意形态，落账时归一）
 * @param {'link-card'} kind 产物类型（收尾链；扩展位）
 * @param {{trigger?:string, role?:string|null, title?:string|null}} [extra] 审计字段（不进幂等键）
 * @returns {boolean} 是否写入成功
 */
export function appendCloseoutMark(aimsRepo, sessionId, kind = 'link-card', extra = {}) {
  try {
    const key = normalizeSessionId(sessionId)
    if (!key) return false
    const p = ledgerPath(aimsRepo)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), session_id: key, kind, ...extra }) + '\n', 'utf8')
    return true
  } catch { return false }
}
