// E58 · 「发信前必经」取时点门 —— **纯函数**（无 IO / 无子进程 / 无文件读写）
//
// 来源：E57 独立 CLI `ops/tools/send-timestamp-check.mjs`（判据同源）；本模块是它的**必经路径形态**。
// 设计约束（队长 2026-09-22 三条硬约束）：
//   ① 纯：只读入参 + 取宿主钟（**由调用方传入 nowMs**）+ 比大小 ⇒ 无 IO/无子进程/无文件读写
//   ② 区分两种失败：**判定不合格 ⇒ 拒（fail-closed）**；**门自身异常 ⇒ 放行 + 强制附「[门异常] 未校验」**
//   ③ 门自身须有**冒烟**（smoke）：门死后必须能被发现 —— 否则「门死了没人知道」比没有门更坏
//
// 【T24 修门 · 队长 2026-09-23 裁死】**门只认「显式标记的声明时点」**：
//   报文里必须形如 `声明时点: <带时区的 ISO>` **才参与判定**；**其余任何位置的时点一律视为「引用」⇒ 不参与判定**。
//   依据：口径下发（引用旧时点/复述报文不写时区后缀）⇒ 引用面必须与声明面分离，否则历史引文会把正当消息拦成红。
//
// 阈值写死（卡面 ⑥ · 物理依据）：`MAX_SKEW_MS = 2 分钟`。
//   依据 = E57 记录 §1：秘书 2026-09-21 的 6 次真实偏差为 +5/+11/+17/+18/+36/+43 分
//   ⇒ 阈值必须 **< 5 分钟**（否则 +5 那条落在阈值内、夹具当场红）⇒ 取 2 分钟。
export const MAX_SKEW_MS = 2 * 60 * 1000
export const GATE_ERR_NOTE = '[门异常] 未校验'
export const RULE_OVER = 'E58-偏差超阈值'
export const RULE_OK = 'E58-偏差在阈值内'
export const RULE_NA = 'T24-无显式声明时点(引用不参与判定)'

// **T24 口径**：只有 `声明时点:` 标记之后的、**带时区的** ISO 才是「声明时点」（可比面）；
// 其余任何位置的时点 = 「引用」 ⇒ **不参与判定**（不假装判过）。
const DECL_RE = /声明时点\s*[:：]\s*((\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2}))/g

/** 抽取**声明**时点（纯 · T24 标记制）：只取 `声明时点:` 之后的带时区 ISO；引用不参与判定。 */
export function extractStamps(text) {
  const out = []
  const s = String(text ?? '')
  DECL_RE.lastIndex = 0
  let m
  while ((m = DECL_RE.exec(s)) !== null) {
    const ms = Date.parse(m[1])
    if (!Number.isNaN(ms)) out.push({ text: m[1], ms })
  }
  return out
}

/** 判定（纯）：返回 {verdict:'ok'|'refuse'|'not-applicable', rule, skewMs, worst, count} */
export function evaluate(text, nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('evaluate: nowMs 必须是有限数（宿主钟）')
  const stamps = extractStamps(text)
  if (stamps.length === 0) return { verdict: 'not-applicable', rule: RULE_NA, skewMs: 0, worst: null, count: 0 }
  let worst = stamps[0], maxAbs = -1
  for (const st of stamps) {
    const skew = st.ms - nowMs
    if (Math.abs(skew) > maxAbs) { maxAbs = Math.abs(skew); worst = st }
  }
  const skewMs = worst.ms - nowMs
  const verdict = Math.abs(skewMs) > MAX_SKEW_MS ? 'refuse' : 'ok'
  return { verdict, rule: verdict === 'refuse' ? RULE_OVER : RULE_OK, skewMs, worst, count: stamps.length }
}

/** 冒烟（纯 · 活体检测）：三条固定用例，任一不符即门不健康。 */
export function smoke() {
  const NOW = Date.parse('2026-09-22T09:30:00+08:00')
  const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, '+00:00')
  const cases = [
    { name: 'T24-1 引用旧时点(无标记)⇒放行', text: '旧读数：' + iso(NOW - 879 * 60000), want: 'not-applicable' },
    { name: 'T24-2 声明标记+超阈值(+5 分)⇒拒', text: '声明时点: ' + iso(NOW - 5 * 60000), want: 'refuse' },
    { name: 'T24-3 声明标记+阈值内(+1 分)⇒放行', text: '声明时点: ' + iso(NOW - 1 * 60000), want: 'ok' },
  ]
  const detail = []
  let ok = true
  for (const c of cases) {
    let got = '(抛错)'
    try { got = evaluate(c.text, NOW).verdict } catch (err) { got = '(抛错)' }
    const pass = got === c.want
    if (!pass) ok = false
    detail.push((pass ? 'PASS ' : 'FAIL ') + c.name + ' 期望=' + c.want + ' 实际=' + got)
  }
  return { ok, detail }
}

/** 发信前必经调用的唯一入口（纯）：allow / refuse / gateError 三态。 */
export function gateOutbound(text, nowMs) {
  const probe = smoke()
  if (!probe.ok) {
    return { allow: true, gateError: true, reason: 'smoke-failed', note: GATE_ERR_NOTE, detail: probe.detail, text: String(text ?? '') + '\n' + GATE_ERR_NOTE }
  }
  try {
    const v = evaluate(text, nowMs)
    if (v.verdict === 'refuse') {
      const min = (v.skewMs / 60000).toFixed(1)
      return {
        allow: false, gateError: false, rule: v.rule, skewMs: v.skewMs, worst: v.worst,
        message: '【E58 门 · 拒】' + RULE_OVER + ' —— 声明时点 ' + (v.worst && v.worst.text) + ' 与宿主钟偏差 ' + min + ' 分（阈值 ' + (MAX_SKEW_MS / 60000) + ' 分） ⇒ 修法：发送前**重取宿主钟**（Get-Date / Date.now）再署时点。',
      }
    }
    return { allow: true, gateError: false, rule: v.rule, skewMs: v.skewMs, worst: v.worst, text: String(text ?? '') }
  } catch (err) {
    return { allow: true, gateError: true, reason: 'exception:' + (err && err.message ? err.message : String(err)), note: GATE_ERR_NOTE, text: String(text ?? '') + '\n' + GATE_ERR_NOTE }
  }
}