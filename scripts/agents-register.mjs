#!/usr/bin/env node
// agents-register.mjs —— 「入口门禁」的**唯一登记写路径**（卡 E9 · A3 §5.1.3 主路径）
//
// 用法：
//   node scripts/agents-register.mjs register --name <项目名> --root <根[,根2]> --agent <claude|codex|opencode|hermes|dsh> \
//          --session <会话 id> --by agents/<角色> [--registry <file>] [--dry-run] [--json]
//   node scripts/agents-register.mjs revoke  --name <项目名> --by agents/<角色> [--reason <文本>]
//   node scripts/agents-register.mjs status  [--name <项目名>] [--json]
//   node scripts/agents-register.mjs list    [--json]
//
// 纪律：
//   · append-only（撤销也是追加一行）；读侧取最后一行 ⇒ 重复登记不产生分歧状态。
//   · **生产面写入需显式声明**（E5 硬护栏）：登记表落在 <agentsHrDir>/data ⇒ 命中 prodFaces()，
//     未声明 AIMS_ALLOW_PROD=1 时**直接拒绝**（报错给修法）。--dry-run 不需要声明（零写入）。
//   · 本 CLI **不拦截任何现有流程**（门禁开关默认关；S4 强制需批准门行）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardProdWrite, ProdWriteBlockedError, ALLOW_ENV } from '../lib/prod-guard.js'
import {
  REGISTRY_DEFAULTS, REQUIRED_FIELDS, projectIdOf, registryPath, readRegistry,
  appendRegistry, appendGateCheck, gateChecksPath, detectRootConflict, resolveRegistration, rootDirsOf,
} from '../lib/agents/project-registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HR = process.env.AIMS_HR_DIR || path.join(os.homedir(), '.gbrain', 'agent-roles')
const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : d) }
const isJson = args.includes('--json')
const REG = String(flag('registry', registryPath(HR)))
const GATE = gateChecksPath(HR)
const say = (o) => console.log(isJson ? JSON.stringify(o, null, 2) : (o.text ?? JSON.stringify(o)))
const die = (o) => { say(o); process.exit(1) }

if (!cmd || cmd === 'help') {
  console.log('用法: node scripts/agents-register.mjs <register|revoke|status|list> [选项]  （详见文件头注释）')
  process.exit(0)
}

if (cmd === 'register') {
  const name = projectIdOf(flag('name', ''))
  const roots = String(flag('root', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const agent = flag('agent', null)
  const session = flag('session', null)
  const by = flag('by', null)
  const dryRun = args.includes('--dry-run')
  const missing = []
  if (!name) missing.push('--name')
  if (!roots.length) missing.push('--root')
  if (!agent) missing.push('--agent')
  if (!session) missing.push('--session')
  if (!by) missing.push('--by')
  if (missing.length) die({ ok: false, code: 'E_BAD_ARGS', text: '缺参数：' + missing.join(' / ') + '。修法：见文件头用法（' + REQUIRED_FIELDS.join(',') + '）' })
  const entries = readRegistry(REG)
  const conflicts = detectRootConflict(entries, name, roots)
  if (conflicts.length) {
    die({ ok: false, code: 'E_ROOT_CONFLICT', text: '登记冲突：根 ' + JSON.stringify(conflicts) + ' 已被别的项目登记。修法：先 revoke 占用方，或确认 root 是否填错。' })
  }
  const rec = {
    project_id: name, project_name: name, root_dirs: roots, origin_agent: String(agent), session_id: String(session),
    registered_at: new Date().toISOString(), registered_by: String(by), source: 'cli',
    generation: (entries.filter((r) => projectIdOf(r.project_id) === name).length) + 1,
  }
  if (dryRun) { say({ ok: true, dryRun: true, wouldWrite: rec, registry: REG, text: '(dry-run 零写入) ' + JSON.stringify(rec) }); process.exit(0) }
  // 生产面写入须显式声明（E5 硬护栏）
  try { guardProdWrite(REG, { action: '写入登记表' }) } catch (e) {
    if (e instanceof ProdWriteBlockedError) die({ ok: false, code: 'E_PROD_WRITE_BLOCKED', text: e.message })
    throw e
  }
  const w = appendRegistry(REG, rec)
  if (!w.ok) die({ ok: false, code: 'E_WRITE_FAILED', text: '写入失败：' + w.reason })
  appendGateCheck(GATE, { ts: new Date().toISOString(), project_id: name, action: 'register', decision: 'allow', gate_enabled: true, by: String(by) })
  say({ ok: true, registry: REG, row: rec, text: '已登记：「' + name + '」（generation=' + rec.generation + '，roots=' + JSON.stringify(roots) + '）' })
  process.exit(0)
}

if (cmd === 'revoke') {
  const name = projectIdOf(flag('name', ''))
  const by = flag('by', null)
  if (!name || !by) die({ ok: false, code: 'E_BAD_ARGS', text: '缺 --name / --by。修法：node scripts/agents-register.mjs revoke --name <项目名> --by agents/<角色>' })
  const rec = { project_id: name, revoked_at: new Date().toISOString(), revoked_by: String(by), reason: flag('reason', null), source: 'cli' }
  try { guardProdWrite(REG, { action: '写入登记表（撤销）' }) } catch (e) { if (e instanceof ProdWriteBlockedError) die({ ok: false, code: 'E_PROD_WRITE_BLOCKED', text: e.message }); throw e }
  const w = appendRegistry(REG, rec)
  if (!w.ok) die({ ok: false, code: 'E_WRITE_FAILED', text: w.reason })
  say({ ok: true, text: '已撤销登记：「' + name + '」（追加一行；历史保留）' })
  process.exit(0)
}

if (cmd === 'status' || cmd === 'list') {
  const entries = readRegistry(REG)
  const names = cmd === 'status' && flag('name') ? [projectIdOf(flag('name'))] : [...new Set(entries.map((r) => projectIdOf(r.project_id)).filter(Boolean))]
  const out = names.map((n) => { const r = resolveRegistration({ projectId: n, entries }); return { project_id: n, status: r.status, reason: r.reason } })
  say({ ok: true, registry: REG, rows: entries.length, items: out, text: out.map((o) => o.project_id + ' -> ' + o.status).join('\n') || '(空)' })
  process.exit(0)
}

die({ ok: false, code: 'E_UNKNOWN_CMD', text: '未知命令：' + cmd + '。可用：register / revoke / status / list' })
