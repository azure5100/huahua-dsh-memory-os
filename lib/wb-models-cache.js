// wb-models-cache.js —— workbuddy 模型表的进程内共享缓存
//
// 背景：dsh-connect-workbuddy 的模型是【运行时注册】的，不在 settings 里，
// 所以 ctx.llm / settings.describe() 都拿不到。唯一可靠来源是它自己的只读路由：
//   POST /plugins/dsh-connect-workbuddy/models/refresh[?region=global]
// 但那条路由只能从【HTTP 请求上下文】里拿到端口（req.socket.localPort）。
//
// ⇒ 于是：api.js 在每次 /api/models 时把结果写进这里；models.js 的 de_models 从这里读。
//   · 没有端口猜测 ✗  · 两条入口天然同源 ✓  · 缓存过期就退回旧行为（不报错）✓
const TTL_MS = 10 * 60 * 1000
let _data = null

/** @param {{ cn?: any[], global?: any[] }} payload */
export function setWorkbuddyModels(payload) {
  _data = {
    at: Date.now(),
    cn: Array.isArray(payload && payload.cn) ? payload.cn : [],
    global: Array.isArray(payload && payload.global) ? payload.global : [],
  }
}

/**
 * 取某个 region 的模型表；过期或从未写入返回 null（调用方自行降级）。
 * @param {'cn'|'global'} region
 */
export function getWorkbuddyModels(region) {
  if (_data === null) return null
  if (Date.now() - _data.at > TTL_MS) return null
  const key = region === 'global' ? 'global' : 'cn'
  const list = _data[key]
  return Array.isArray(list) && list.length > 0 ? list : null
}

export function workbuddyCacheAgeMs() {
  return _data === null ? null : Date.now() - _data.at
}
