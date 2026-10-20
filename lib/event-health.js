// 事件健康度：**零触发监听告警**（t34 / L3 第二批）
//
// 为什么需要：那次虚构事件名事故（根因留痕 docs/rules.md:80）的本质是"**注册了、平台不存在、永远不触发**"，而当时**没有任何观测面**
// 能让它暴露——注册表里它明明在（cordis 接受任意名），只有"注册后是否真的 fire 过"这条信号能抓到它。
// 本模块给每个注册点装一个计数器：注册时登记、处理器首行 `fire()`；进程跑过阈值时间后仍**零触发** ⇒ 告警一次。
//
// 边界（如实声明）：
//   · 零触发 ≠ 一定是死监听——也可能是"该事件确实尚未发生"（如 agent/inbox/inserted 在本进程内没发生）。
//     故告警文案写"疑似"，并要求人工按平台声明集 + 投喂形状复核；它抓的是"注册了却从未响过"这类**信号缺口**。
//   · 只覆盖显式接入本模块的注册点（当前 = lib/aims/observe.js 的 4 条）；未接入的注册点不受此保护。
export function createEventHealth({ logger = console, clock = () => Date.now() } = {}) {
  /** name → { registeredAtMs, fired, warned } */
  const entries = new Map()

  return {
    /** 登记一个注册点（幂等：重复登记不重置计数与时刻）。 */
    register(name) {
      const e = entries.get(name)
      if (!e) entries.set(name, { registeredAtMs: clock(), fired: 0, warned: false })
    },
    /** 该注册点的处理器被调用时调用（处理器首行）。 */
    fire(name) {
      const e = entries.get(name)
      if (!e) { entries.set(name, { registeredAtMs: clock(), fired: 1, warned: false }); return }
      e.fired += 1
    },
    /** 快照（供 status()/测试/探针读取）。 */
    stats() {
      const now = clock()
      return [...entries.entries()].map(([name, e]) => ({
        name, fired: e.fired, registeredAgeMs: now - e.registeredAtMs, warned: e.warned,
      })).sort((a, b) => a.name.localeCompare(b.name))
    },
    /**
     * 检查"超时仍零触发"并告警（每个名字只告一次）。
     * @param {{afterMs?: number}} [opts] 阈值（缺省 10 分钟——短于此的进程不足以判定）
     * @returns {string[]} 本次新告警的事件名
     */
    checkNeverFired({ afterMs = 10 * 60_000 } = {}) {
      const now = clock()
      const fired = []
      for (const [name, e] of entries) {
        if (e.warned || e.fired > 0) continue
        if (now - e.registeredAtMs < afterMs) continue
        e.warned = true
        fired.push(name)
        try {
          logger.warn(`[event-health] ${name} 注册 ${Math.round((now - e.registeredAtMs) / 1000)}s 仍**零触发**——疑似死监听；`
            + '请按平台声明集与投喂形状（positional/object）复核注册点')
        } catch { /* 日志失败不影响主流程 */ }
      }
      return fired
    },
  }
}
