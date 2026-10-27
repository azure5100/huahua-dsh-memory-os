// prod-guard.js —— 「测试/冒烟脚本禁止写生产面」硬护栏（卡 E5 · B）
//
// 事故成因（2026-09-11）：为了验证 `cli/src/cmd/linkcards.js` 的激活台账写入护栏（提交 `30fe532`），
// 有人拿测试假 id 对**生产面**直调 CLI ⇒ 往生产 DB 写 2 行 sessions、往生产 link-cards 写 3 张卡，
// 并因此把 t35 待清理的 `22222222-…` 激活行「洗白」（不变量判据失效）。
// ⇒ 目标：把「验证时顺手污染生产」从"事后发现"变成**一次响亮的失败**。
//
// 设计（显式声明制）：
//   · 生产面写入**必须显式声明** `AIMS_ALLOW_PROD=1`；未声明 ⇒ 抛 `ProdWriteBlockedError`（调用方须 exit≠0）。
//   · 报错文案**写明修法**（两条路：重定向到隔离面 / 显式声明 + 记门行）—— 「响亮」且「可修」。
//   · 隔离面（mkdtemp 等）**不拦**：否则会把"正确的做法"也一并拦死（假红）。
//
// 为什么是"显式声明"而不是"一律禁止"：生产写入本身是**合法需求**（收尾沉淀、每日同步、清理脚本），
// 全禁会逼出旁路（改路径绕过 / 关掉护栏）。显式声明把"我确实要写生产"变成一个**必须打出来的字**。
//
// 零依赖；ESM。

/** 声明环境变量：值为 '1' 时放行生产面写入。 */
export const ALLOW_ENV = 'AIMS_ALLOW_PROD'

/**
 * 生产面清单（**逐条给理由**；新增须写清"这是什么面、为什么是生产"）。
 * 判定 = 路径归一后**前缀命中**（Windows 大小写不敏感、分隔符归一）。
 */
export function prodFaces(home = process.env.USERPROFILE || process.env.HOME || '') {
  return [
    { root: home + '/.dsh/memories', why: '长期记忆面（MEMORY.md/USER.md/SUGGESTIONS.jsonl/待办/别名/状态）' },
    { root: home + '/.dsh/aims', why: 'AIMS 生产数据面（激活台账 / sessions 库 / link-cards）' },
    { root: home + '/.dsh/sessions', why: 'DSH 会话日志面（append-only 证据）' },
    { root: home + '/.agents/skills', why: '技能库（skill_manage 安装落点）' },
    // E9（Q8 硬输入 C）：人事部**数据面**。落点 `~/.gbrain/agent-roles/data` 原本不在清单内 ⇒
    // 测试/冒烟脚本往它写**不被拦**（与 E5 事故同族）。现补面：登记表 registry.jsonl / 门禁审计
    // gate-checks.jsonl / projects.jsonl / tasks/ 都在此。**为什么是生产**：它是人事部登记与台账的
    // 权威数据面，被写坏即「不留痕」——正是本卡门禁要防的形态。
    { root: home + '/.gbrain/agent-roles/data', why: '人事部数据面（registry.jsonl 登记表 / gate-checks.jsonl 门禁审计 / projects.jsonl 台账）' },
    { root: 'D:/agent-identity-memory-system/data', why: 'AIMS 仓数据面（logs / aims / provenance）' },
    { root: 'D:/agent-identity-memory-system/cli', why: 'AIMS CLI 源码面（护栏开发期曾在此误写生产）' },
  ]
}

/**
 * 路径归一：统一分隔符 + **Windows 路径整串小写**（NTFS 大小写不敏感）。
 * ⚠️ 只小写盘符是不够的：实测 `C:\\USERS\\COSMO\\.DSH\\...` 会漏判（本模块自带用例 ④ 抓到过）。
 * POSIX 路径大小写**敏感** ⇒ 不折叠大小写。
 */
export function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/')
  const isWin = /^[A-Za-z]:/.test(s) || s.startsWith('//')
  if (isWin) s = s.toLowerCase()
  return s.replace(/\/+/g, '/').replace(/\/+$/, '')
}

/** 是否命中生产面；返回命中的面对象或 null。 */
export function prodFaceOf(target, faces = prodFaces()) {
  const t = normPath(target)
  for (const f of faces) {
    const r = normPath(f.root)
    if (t === r || t.startsWith(r + '/')) return f
  }
  return null
}

/** 生产面写入被拒（调用方须据此 exit≠0，并把 message 原样打给用户）。 */
export class ProdWriteBlockedError extends Error {
  constructor(target, face, action) {
    const fix = [
      '修法二选一：',
      '  ① (推荐) 把写入重定向到隔离面，例如 mkdtemp 目录 —— 测试/冒烟脚本一律走这条；',
      '  ② 确实要写生产：在同一条命令上显式声明 ' + ALLOW_ENV + '=1，并在施工记录里写清门行与影响面。',
    ].join('\n')
    super('拒绝' + action + '生产面：' + target + '\n  命中生产面：' + face.root + '（' + face.why + '）\n' + fix)
    this.name = 'ProdWriteBlockedError'
    this.code = 'PROD_WRITE_BLOCKED'
    this.target = target
    this.face = face
  }
}

/**
 * 写入前守卫。命中生产面且未显式声明 ⇒ 抛 `ProdWriteBlockedError`。
 * @param {string} target 目标路径
 * @param {{action?: string, env?: object, faces?: object[]}} [opts]
 * @returns {{allowed: true, face: object|null}} 未命中生产面时 face=null
 */
export function guardProdWrite(target, opts = {}) {
  const { action = '写入', env = process.env, faces = prodFaces() } = opts
  const face = prodFaceOf(target, faces)
  if (!face) return { allowed: true, face: null }
  if (env[ALLOW_ENV] === '1') return { allowed: true, face }
  throw new ProdWriteBlockedError(target, face, action)
}

/** 断言路径位于给定隔离根内（测试应把写目标钉在隔离面内）。 */
export function assertIsolated(target, isolatedRoot) {
  const t = normPath(target), r = normPath(isolatedRoot)
  if (!r) throw new Error('assertIsolated: isolatedRoot 为空')
  if (t !== r && !t.startsWith(r + '/')) throw new Error('断言失败：目标不在隔离面内：' + target + '（隔离根 ' + isolatedRoot + '）')
  return true
}
