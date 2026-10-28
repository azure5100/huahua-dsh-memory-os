// huahua-os · 人事部融合 阶段 2：lib/agents/ledger.js —— 看板台账**只读读面**（卡 U2B）
//
// 语义（承前端契约 ops/records/U2-2026-09-13.md §5 + L1 蓝图 §11.4）：
//   · 读「**已提交**内容」（HEAD 树），**不读工作副本** ⇒ 落实 §11.4-4「不许把『未提交』当成『已发生』」
//   · **只做笨读取**（解析 frontmatter + 计数），聚合全在前端 ⇒ 不产生第二套真相源（§11.4-2）
// 边界（铁律）：**只读**——不写任何文件 · 不新建存储 · 不挂写路由 · **不读 ops/BOARD.md**（秘书单写者面）。
// 非阻塞：全程**异步 spawn**（禁 spawnSync）。宿主是单进程单事件循环（E41 首假设）；
//   百来张卡若逐文件同步 `git show` 会卡住全队 ⇒ 冷路径 4 次 spawn、热路径 0~1 次，且按 rev 缓存 + 单飞。
//
// 字段口径：**逐字沿用** ops/tools/board-gen.mjs:38 CARD_FIELDS / :42 VERIFY_FIELDS（不新造、不重命名）。
//   ⚠ 那两条常量住 `ops/**`（**团队工作区，不是插件产物面**）：**不得 import 过来** —— `lib/**` 依赖
//   `ops/**` 会把端点耦合到一份可能被搬走/删除/改写的团队工具文件上，且 board-gen 顶层会执行
//   （:49 RUN_ROOT 等）。故本文件自带**读面副本**，其与权威的一致性由装置
//   ops/records/U2B-ledger-verify.mjs **每次运行逐字比对**（比对对象 = 读 board-gen 源文件提取的数组，
//   不是硬编码常量）—— 把「两处定义会漂移」变成**机器可检的不变量**。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（`ops/**` 所在处）。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..')
const GIT_BIN = 'git'

// ── 字段口径（**读面副本**；权威 = board-gen.mjs:38/:42，由装置逐字比对）─────────────────
export const CARD_FIELDS = ['card', 'title', 'role', 'artifacts', 'criteria', 'status', 'status_at', 'record']
export const CARD_OPTIONAL = ['record_sha256', 'record_note']
// E72（125fc03）后权威源已把**必填集与合法集分开**（ops/tools/board-gen.mjs:47-48）：
//   VERIFY_REQUIRED(4) = 必填 · VERIFY_FIELDS = VERIFY_REQUIRED + ['verdict_target']（合法但不必填）
// ⇒ 读面副本必须**同样分离**：只写 4 字段会让端点把带 verdict_target 的验面判为「未声明字段」。
export const VERIFY_REQUIRED = ['card', 'verifier', 'verdict', 'verdict_at']
export const VERIFY_FIELDS = VERIFY_REQUIRED.concat(['verdict_target'])
/** 三面所在目录（响应 sources 用同一份，不写第二处）。 */
export const DIRS = { cardsDir: 'ops/cards', verdictsDir: 'ops/verdicts', recordsDir: 'ops/records', handoffsDir: 'ops/handoffs' }

// E106（队长 2026-09-26 批）：stageFrom 三态在**数据面**落地（**原因码**），使三类可**机器分辨**：
//   inherited:<卡号>            ⇒ 已继承（正常）
//   not-applicable:non-card     ⇒ 不适用（值**不是卡号形状**：handoff 文件名 / 文档名等）⇒ **不红**
//   unresolved-missing:<值>     ⇒ **判不了·缺号**（值**形如卡号**却查不到 ⇒ **实为缺陷**）⇒ **红**
//   unresolved-unknown:<值>     ⇒ **判不了**（**形状判不出** ⇒ 第三态：不默认归类、不默认不红）
//   （null / 空）               ⇒ 载荷无 verdict_target ⇒ **判不了**（同一缺陷态）
// ⚠ 「已归档」这类**写者状态**本载荷读不到 ⇒ 由**消费侧**按 verifier 名册另判；本面**不猜**（不默认归「不适用·历史」）。
//
// E106R（返工 · 依 Q82 验面 **B1**）：**字面量唯一 home = 下面三个常量对象** ——
//   函数体内**不得再出现裸字面量**（否则「改了一处、另一处没跟」会静默漂移；这正是 B2 的形态）。
//   ⚠ 消费侧是**浏览器 bundle**（`src/client/**`）⇒ **不能 import 本模块**（跨 bundle 边界，Q82 §3 已裁为「不可达的那一半」）
//   ⇒ 两侧一致性由装置 `ops/tools/crossface-reasoncode-check.mjs` **逐字比对**（数据面改码 ⇒ 门红）。
/** 原因码**前缀/全值**（唯一 home）**。前缀 = 到第一个 `:` 为止（跨面门按前缀比对）。 */
export const STAGE_FROM_CODES = {
  inherited: 'inherited:',
  notApplicable: 'not-applicable:non-card',
  missing: 'unresolved-missing:',
  unknown: 'unresolved-unknown:',
}
/** 三态 kind 的**机器可读 id**（与消费侧 `StageFromKind` 同名 —— 由跨面门比对）。 */
export const STAGE_FROM_KINDS = { inherited: 'inherited', notApplicable: 'not-applicable', missing: 'unresolved-missing', unknown: 'unresolved-unknown' }
/** 人读原因（`stageFromReason` 字段值）。 */
export const STAGE_FROM_REASONS = { inherited: 'inherited', missing: '缺号', nonCard: '非卡', unknown: '形状判不出' }
export function classifyStageFrom(tgt, hasCard) {
  const s = tgt == null ? '' : String(tgt).trim()
  if (!s) return { stageFrom: null, reason: null, defect: true }                      // 判不了（唯一缺陷态）
  if (hasCard) return { stageFrom: STAGE_FROM_CODES.inherited + s, reason: STAGE_FROM_REASONS.inherited, defect: false }
  const looksCard = /^[A-Za-z]+\d+[A-Za-z]*$/.test(s)                                 // 形如卡号（Q51 / E101R / QB7 …）
  const looksFile = /[.\/]/.test(s) || /-\d{4}-\d{2}-\d{2}/.test(s)                 // 形如文件名（handoff/记录）
  if (looksCard && !looksFile) return { stageFrom: STAGE_FROM_CODES.missing + s, reason: STAGE_FROM_REASONS.missing, defect: true }
  if (looksFile && !looksCard) return { stageFrom: STAGE_FROM_CODES.notApplicable, reason: STAGE_FROM_REASONS.nonCard, defect: false }
  return { stageFrom: STAGE_FROM_CODES.unknown + s, reason: STAGE_FROM_REASONS.unknown, defect: true }   // 第三态：不默认归类
}

const DEFAULT_TTL_MS = 1500
const GIT_TIMEOUT_MS = 20000
const MAX_OUT_BYTES = 32 * 1024 * 1024

// ════════════════════════════════════════════════════════════════════════════
// 1. git 只读执行器（**异步**；禁 spawnSync）
// ════════════════════════════════════════════════════════════════════════════
/**
 * 跑一条只读 git 命令。**全异步**（事件循环不被占用）；带超时/输出上限；失败返回 {ok:false,error}。
 * @param {string[]} args git 参数（会前置 --no-optional-locks ⇒ 连可选锁都不取）
 * @param {{cwd?:string, input?:string|null, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true,buf:Buffer}|{ok:false,error:string}>}
 */
export function runGit(args, opts = {}) {
  const cwd = opts.cwd || REPO_ROOT
  const input = opts.input === undefined ? null : opts.input
  const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : GIT_TIMEOUT_MS
  return new Promise((resolve) => {
    let child = null
    let timer = null
    let done = false
    const chunks = []
    let errText = ''
    let bytes = 0
    const fin = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r) }
    try {
      child = spawn(GIT_BIN, ['--no-optional-locks'].concat(args), {
        cwd,
        windowsHide: true,
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }),
      })
    } catch (e) {
      return fin({ ok: false, error: 'spawn git 失败：' + (e && e.message ? e.message : String(e)) })
    }
    timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* 已退出 */ }
      fin({ ok: false, error: 'git ' + args[0] + ' 超时（' + timeoutMs + 'ms）' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (e) => fin({ ok: false, error: 'git spawn error：' + ((e && (e.code || e.message)) || String(e)) }))
    child.stdout.on('data', (d) => {
      bytes += d.length
      if (bytes > MAX_OUT_BYTES) {
        try { child.kill() } catch (e) { /* noop */ }
        return fin({ ok: false, error: 'git ' + args[0] + ' 输出超限（>' + MAX_OUT_BYTES + ' bytes）' })
      }
      chunks.push(d)
    })
    child.stderr.on('data', (d) => { if (errText.length < 4000) errText += String(d) })
    child.on('close', (code) => {
      if (code === 0) fin({ ok: true, buf: Buffer.concat(chunks) })
      else fin({ ok: false, error: 'git ' + args.join(' ') + ' exit ' + code + '：' + errText.trim().slice(0, 300) })
    })
    if (input !== null) { try { child.stdin.end(input) } catch (e) { /* close 兜底 */ } }
  })
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 纯解析（导出自检用；不碰磁盘）
// ════════════════════════════════════════════════════════════════════════════
/** `git ls-tree -r -z --long` 输出 → [{mode,sha,size,path}]（NUL 分隔、meta 与 path 以 TAB 分隔）。 */
export function parseLsTree(buf) {
  const rows = []
  for (const ent of buf.toString('utf8').split('\u0000')) {
    if (!ent) continue
    const tab = ent.indexOf('\t')
    if (tab < 0) continue
    const meta = ent.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 4 || meta[1] !== 'blob') continue
    rows.push({ mode: meta[0], sha: meta[2], size: Number(meta[3]), path: ent.slice(tab + 1) })
  }
  return rows
}

/** `git cat-file --batch` 输出 → Map<sha, {text,bytes}|{error}>（帧：`<sha> blob <n>\n<n 字节>\n`）。 */
export function parseBatch(buf) {
  const out = new Map()
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i)
    if (nl < 0) break
    const header = buf.toString('utf8', i, nl).trim()
    i = nl + 1
    const parts = header.split(' ')
    if (parts.length < 3) { out.set(parts[0], { error: '对象不可读：' + header }); continue }
    const type = parts[1]
    const size = Number(parts[2])
    if (type !== 'blob' || !Number.isFinite(size) || size < 0) { out.set(parts[0], { error: 'cat-file 期望 blob，收到 ' + type }); continue }
    const text = buf.toString('utf8', i, i + size)
    i += size + 1 // 跳过帧尾换行
    out.set(parts[0], { text, bytes: size })
  }
  return out
}

/** `git log --format=%x01%cI --name-only` 输出 → Map<path, ISO>（**首次出现** = 该文件最后一次提交）。 */
export function parseNameOnlyLog(buf) {
  const map = new Map()
  for (const block of buf.toString('utf8').split('\u0001')) {
    if (!block) continue
    const lines = block.split('\n')
    const iso = (lines[0] || '').trim()
    if (!iso) continue
    for (const f of lines.slice(1)) {
      const p = f.trim()
      if (!p || map.has(p)) continue
      map.set(p, iso)
    }
  }
  return map
}

/** 严格 frontmatter（与 board-gen 同口径：首行 --- → 下一个 ---；只认 key: value；重复键报错）。 */
export function parseFrontmatter(text) {
  const lines = String(text).split('\n')
  if ((lines[0] || '').replace(/\r$/, '').trim() !== '---') return { err: '缺少 frontmatter（首行必须是 ---）' }
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '').trim() === '---') { end = i; break }
  if (end < 0) return { err: 'frontmatter 未闭合（缺少第二个 ---）' }
  const data = {}
  const errs = []
  for (let i = 1; i < end; i++) {
    const l = lines[i].replace(/\r$/, '').trim()
    if (!l || l.charAt(0) === '#') continue
    const ci = l.indexOf(':')
    if (ci < 0) { errs.push('frontmatter 行不是 key: value —— ' + JSON.stringify(l.slice(0, 60))); continue }
    const k = l.slice(0, ci).trim()
    const v = l.slice(ci + 1).trim()
    if (k in data) { errs.push('字段重复 —— ' + k); continue }
    data[k] = v
  }
  return { data, errs }
}

/** 结构校验（**只做结构**：缺必填 / 未声明字段。**不做**受控词表与 ISO 时区校验——那是 board-gen 的格式门，读面不当地二道门）。 */
export function validateStruct(data, required, optional) {
  const errs = []
  const missing = required.filter((k) => !data[k] || String(data[k]).trim() === '')
  if (missing.length) errs.push('缺字段 ' + missing.join(', '))
  const allowed = new Set(required.concat(optional || []))
  const unk = Object.keys(data).filter((k) => !allowed.has(k))
  if (unk.length) errs.push('未声明字段 ' + unk.map((x) => JSON.stringify(x)).join('、'))
  return errs
}

/** 文件名派生卡号（仅在文件自身没有 card 字段时用于兜底，行内同样带 error）。 */
function cardFromName(p, suffix) {
  const base = path.basename(p)
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base.replace(/\.[^.]+$/, '')
}
/** 记录文件名 → 卡号（首个 `-` 之前；`U2B-2026-09-13.md` → `U2B`）。 */
export function cardOfRecord(p) {
  return path.basename(p).replace(/\.[^.]+$/, '').split('-')[0]
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 组行 + 主流程（按 rev 缓存 + 单飞）
// ════════════════════════════════════════════════════════════════════════════
function rowOf(data, errs, blob16) {
  const row = {}
  for (const k of Object.keys(data)) row[k] = data[k] // 原样
  row.blob = blob16
  if (errs.length) row.error = errs.join('；')
  return row
}
const blob16Of = (sha) => String(sha).slice(0, 16)

async function build(repoRoot, opts) {
  const t0 = Date.now()
  // opts.gitRunner：**测试注入缝**（与本仓 routes 的 deps.sync/deps.registry 注入同族）。
  // 默认 = 本文件 runGit（异步 + 管道 stdio）；注入仅用于「受限档位下用文件 fd 捕获的真实 git 字节回放」，
  // 生产路径（路由）**不传** ⇒ 走真 runGit。装置会同时跑 native 档位，防止用注入缝掩盖真实现。
  const G = typeof opts.gitRunner === 'function' ? opts.gitRunner : runGit
  const head = await G(['log', '-1', '--format=%H%n%cI'], { cwd: repoRoot })
  if (!head.ok) return { ok: false, error: '读 HEAD 失败：' + head.error }
  const headLines = head.buf.toString('utf8').trim().split('\n')
  const rev = (headLines[0] || '').trim()
  const committedAt = (headLines[1] || '').trim()
  if (!rev) return { ok: false, error: 'git log 未返回 rev（空仓库？）' }

  const tree = await G(['ls-tree', '-r', '-z', '--long', 'HEAD', '--', DIRS.cardsDir, DIRS.verdictsDir, DIRS.recordsDir, DIRS.handoffsDir], { cwd: repoRoot })
  if (!tree.ok) return { ok: false, error: '读 HEAD 树失败：' + tree.error }
  const entries = parseLsTree(tree.buf)

  const cardEnts = []
  const verdEnts = []
  const recEnts = []
  const handEnts = []
  for (const e of entries) {
    if (e.path.startsWith(DIRS.cardsDir + '/')) {
      if (e.path.endsWith('.md') && !e.path.endsWith('.verify.md')) cardEnts.push(e) // 与 board-gen loadCards 同口径
      continue
    }
    if (e.path.startsWith(DIRS.verdictsDir + '/')) {
      if (e.path.endsWith('.verify.md')) verdEnts.push(e)
      continue
    }
    if (e.path.startsWith(DIRS.recordsDir + '/')) recEnts.push(e)
    if (e.path.startsWith(DIRS.handoffsDir + '/')) handEnts.push(e)
  }

  const want = Array.from(new Set(cardEnts.concat(verdEnts).map((e) => e.sha)))
  const [batch, logRes] = await Promise.all([
    want.length ? G(['cat-file', '--batch'], { cwd: repoRoot, input: want.join('\n') + '\n' }) : Promise.resolve({ ok: true, buf: Buffer.alloc(0) }),
    G(['log', '--format=%x01%cI', '--name-only', '--', DIRS.recordsDir, DIRS.handoffsDir], { cwd: repoRoot }),
  ])
  if (!batch.ok) return { ok: false, error: '读已提交内容失败：' + batch.error }
  const blobs = parseBatch(batch.buf)
  const recTimes = logRes.ok ? parseNameOnlyLog(logRes.buf) : new Map()
  const logWarn = logRes.ok ? null : 'git log 取记录时点失败：' + logRes.error

  const cards = cardEnts.map((e) => {
    const b = blobs.get(e.sha)
    if (!b || b.error) {
      const row = { card: cardFromName(e.path, '.md'), blob: blob16Of(e.sha), error: (b && b.error) || '对象不可读' }
      return row
    }
    const pf = parseFrontmatter(b.text)
    if (pf.err) return { card: cardFromName(e.path, '.md'), blob: blob16Of(e.sha), error: pf.err }
    const errs = (pf.errs || []).concat(validateStruct(pf.data, CARD_FIELDS, CARD_OPTIONAL))
    const row = rowOf(pf.data, errs, blob16Of(e.sha))
    if (!row.card) row.card = cardFromName(e.path, '.md')
    row.stage = (pf.data && pf.data.stage != null && String(pf.data.stage) !== '') ? String(pf.data.stage) : null
    return row
  })
  const verdicts = verdEnts.map((e) => {
    const b = blobs.get(e.sha)
    if (!b || b.error) return { card: cardFromName(e.path, '.verify.md'), blob: blob16Of(e.sha), error: (b && b.error) || '对象不可读' }
    const pf = parseFrontmatter(b.text)
    if (pf.err) return { card: cardFromName(e.path, '.verify.md'), blob: blob16Of(e.sha), error: pf.err }
    // E72：必填 = VERIFY_REQUIRED；verdict_target = **合法可选**（不是必填）
    const errs = (pf.errs || []).concat(validateStruct(pf.data, VERIFY_REQUIRED, ['verdict_target']))
    const row = rowOf(pf.data, errs, blob16Of(e.sha))
    if (!row.card) row.card = cardFromName(e.path, '.verify.md')
    // E95 §17 数据面补：验面 frontmatter 的 stage（**有 ⇒ 原样值；无 ⇒ 显式 null**，不省略、不猜）
    row.stage = (pf.data && pf.data.stage != null && String(pf.data.stage) !== '') ? String(pf.data.stage) : null
    return row
  })
  const byCard = (a, b) => String(a.card).localeCompare(String(b.card), 'en', { numeric: true })
  cards.sort(byCard)
  // E95 §17 派生（队长 2026-09-26 批准）：验面的 stage **从被验卡继承**（`verdict_target` → cards[].stage）
  //   关联取不到 ⇒ 显式 null（**不编**）；`stageFrom` 让消费侧能区分「继承而来」与「关联取不到」
  const cardStage = new Map(cards.map((c) => [c.card, c.stage == null ? null : c.stage]))
  for (const v of verdicts) {
    const tgt = v && v.verdict_target != null ? String(v.verdict_target).trim() : ''
    const cls = classifyStageFrom(tgt, cardStage.has(tgt))
    v.stage = tgt && cardStage.has(tgt) ? cardStage.get(tgt) : null
    v.stageFrom = cls.stageFrom
    v.stageFromReason = cls.reason       // E106：原因码（机器可分辨「不适用 / 不适用·历史 / 判不了·缺号」）
    v.stageFromDefect = cls.defect       // **唯一缺陷态** = 判不了（含缺号）⇒ 界面据此上色
  }
  verdicts.sort(byCard)
  const records = recEnts
    .map((e) => {
      const item = { card: cardOfRecord(e.path), path: e.path, bytes: e.size, committedAt: recTimes.get(e.path) || committedAt, stage: null }
      // E95 §17 数据面补：记录 frontmatter 的 stage（**无 ⇒ 显式 null**）。
      // 现读实测：ops/records/*.md 265 份里带 stage 的 = **1** ⇒ 本字段**基本不存在**（流程缺口，已如实上报，不编）
      try {
        const text = fs.readFileSync(path.join(repoRoot, e.path), 'utf8')
        if (text.startsWith('---')) {
          const lines = text.split(/\r?\n/)
          let end = -1
          for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
          const seg = end > 0 ? lines.slice(1, end).join('\n') : ''
          const sm = /^stage:[ \t]*(\S.*?)[ \t]*$/m.exec(seg)
          if (sm && sm[1] && sm[1] !== '未标注') item.stage = sm[1]
        }
      } catch (_) { /* 工作树读不到 ⇒ stage 留 null（不猜） */ }
      return item
    })
    .sort((a, b) => a.path.localeCompare(b.path))

  // E94 极简片：handoffs[] = 骨架层之一的**只读**切片（每项 { name, bytes, mtimeISO, role }）
  //   role 从文件名 `<角色>-<日期>.md` 解析；解析不出 ⇒ **null**（不猜）
  // E94 极简片 + **E99 数据面收口**（队长 2026-09-26）：handoffs[] 必须把 handoff **frontmatter** 读出来（**至少 stage**）。
  //   ⚠ 字段名与值不符已修：原 `mtimeISO` 的值来源是 **git 提交时间**（`git log --format=%cI`）⇒ **改名 `commitISO`**；
  //     **真文件时间**另给 `fileMtimeISO`（fs.statSync）。两者都在 ⇒ 消费侧按语义取，不再「名与值不符」。
  //   ⚠ 读不到 frontmatter / 无 stage ⇒ **显式 null（不省略、不猜）**（与 Q25「不追改历史证据」同口径）。
  const handoffs = handEnts
    .map((e) => {
      const base = path.basename(e.path)
      const m = /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/.exec(base)
      const item = {
        name: base,
        bytes: e.size,
        commitISO: recTimes.get(e.path) || committedAt,
        fileMtimeISO: null,
        role: m ? m[1] : null,
        date: m ? m[2] : null,
        stage: null,
        firstLine: null,   // E95 §17（前端在等）：正文**首个非空行**（跳过 frontmatter）· 解析不出 ⇒ **显式 null**（不用文件名/日期兜底）
      }
      const abs = path.join(repoRoot, e.path)
      // E103：firstLine = **正文首个非空行（跳过 frontmatter）原样**；解析不出 ⇒ 显式 null（**不用文件名/日期兜底**）
      try {
        const t2 = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
        let s = 0
        if (t2[0] && t2[0].trim() === '---') { for (let i = 1; i < t2.length; i++) if (t2[i].trim() === '---') { s = i + 1; break } }
        const f = t2.slice(s).find((l) => l.trim() !== '')
        item.firstLine = f ? f.trim() : null
      } catch (_) { item.firstLine = null }
      try { item.fileMtimeISO = fs.statSync(abs).mtime.toISOString() } catch (_) { item.fileMtimeISO = null }
      try {
        const text = fs.readFileSync(abs, 'utf8')
        if (text.startsWith('---')) {
          const lines = text.split(/\r?\n/)
          let end = -1
          for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
          const seg = end > 0 ? lines.slice(1, end).join('\n') : ''
          const sm = /^stage:[ \t]*(\S.*?)[ \t]*$/m.exec(seg)
          if (sm && sm[1] && sm[1] !== '未标注') item.stage = sm[1]
        }
      } catch (_) { /* HEAD 有、工作树读不到 ⇒ stage 留 null（不猜） */ }
      return item
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    ok: true,
    rev,
    committedAt,
    cards,
    verdicts,
    records,
    handoffs,
    sources: { cardsDir: DIRS.cardsDir, verdictsDir: DIRS.verdictsDir, recordsDir: DIRS.recordsDir, handoffsDir: DIRS.handoffsDir },
    _debug: { elapsedMs: Date.now() - t0, spawns: 4, logWarn, entries: entries.length },
  }
}

const cache = { rev: null, at: 0, payload: null }
let inflight = null

/**
 * 读台账（**已提交面**）。热路径（TTL 内）零 spawn；TTL 外 1 次 spawn 比 rev；rev 变才走冷路径（4 次 spawn）。
 * @param {{force?:boolean, ttlMs?:number, repoRoot?:string}} [opts]
 * @returns {Promise<object>} 契约响应（ok/rev/committedAt/cards/verdicts/records/sources）；失败 {ok:false,error}
 */
/**
 * 契约响应 = **恰好**这 8 个键（前端契约 §5）；`_debug` **只在 opts.debug=true 时附上**，
 * 即**装置专用**——上线路径（路由）不传 ⇒ 线上响应不含任何自报读数（耗时/缓存态一律由装置独立测量）。
 */
function wire(payload, debug) {
  const base = {
    ok: payload.ok,
    generatedAt: new Date().toISOString(),
    rev: payload.rev,
    committedAt: payload.committedAt,
    cards: payload.cards,
    verdicts: payload.verdicts,
    records: payload.records,
    handoffs: payload.handoffs,
    sources: payload.sources,
  }
  if (debug) base._debug = payload._debug
  return base
}

export async function readLedger(opts = {}) {
  const debug = opts.debug === true
  const ttlMs = Number.isInteger(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS
  const now = Date.now()
  if (!opts.force && cache.payload && now - cache.at < ttlMs) {
    return wire(Object.assign({}, cache.payload, { _debug: Object.assign({}, cache.payload._debug, { cache: 'ttl-hit' }) }), debug)
  }
  const G = typeof opts.gitRunner === 'function' ? opts.gitRunner : runGit
  const head = await G(['rev-parse', 'HEAD'], { cwd: opts.repoRoot || REPO_ROOT })
  if (!opts.force && head.ok && cache.payload && cache.payload.ok && head.buf.toString('utf8').trim() === cache.payload.rev) {
    cache.at = Date.now()
    return wire(Object.assign({}, cache.payload, { _debug: Object.assign({}, cache.payload._debug, { cache: 'rev-hit' }) }), debug)
  }
  if (!inflight) {
    inflight = (async () => {
      try {
        const r = await build(opts.repoRoot || REPO_ROOT, opts)
        if (r.ok) { cache.rev = r.rev; cache.at = Date.now(); cache.payload = r }
        return r
      } catch (e) {
        return { ok: false, error: 'ledger 读面异常：' + (e && e.message ? e.message : String(e)) }
      } finally { inflight = null }
    })()
  }
  const r = await inflight
  return r.ok ? wire(r, debug) : r
}

/** 装置用：清缓存 / 看内部。 */
export function _resetCache() { cache.rev = null; cache.at = 0; cache.payload = null; inflight = null }
export const _test = { parseLsTree, parseBatch, parseNameOnlyLog, parseFrontmatter, validateStruct, cardOfRecord, cardFromName, REPO_ROOT, GIT_BIN }
