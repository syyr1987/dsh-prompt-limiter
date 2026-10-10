/**
 * 浏览器信任围栏（浏览器 → 本插件路由）。
 *
 * 行为与 dsh /api 网关的围栏一致（Host 头回环、或部署声明的 trustedHosts，
 * 并拒绝跨站浏览器标记）。这是 DNS-rebinding / 跨站防御，不是身份认证：
 * 本插件的路由只读写本机的一份限额配置，因此“只有本机页面能调”就是它需要的
 * 全部授权边界。
 *
 * 该实现是对 @deepseek-ai/dsh-client-connection 中同名逻辑的重写（该包不导出
 * 这些辅助函数，插件又不应依赖它的内部实现），dsh-better-sidebar 亦采用同一
 * 做法，本文件与它保持行为对齐，便于比对审计。
 *
 * @param {{ headers: import('node:http').IncomingHttpHeaders }} request
 * @param {readonly string[]} trustedHosts 本部署服务的非回环权威（可为空）
 * @returns {boolean} Host 属于本机（或受信）且浏览器标记为同源时为 true
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const trusted = Array.isArray(trustedHosts) ? trustedHosts : []
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trusted)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin 围栏：浏览器带上 Origin 时必须指向同一个 hostname。比较 hostname
  // 而不是 host：某些 Chromium 构建会把非默认端口回环页面的 Origin 去掉端口，
  // 按 host 比较会把整条路由打死。没有 Origin 是正常的（Host 围栏已经定界）。
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** 读取一个字符串请求头（数组/未定义一律视为缺失）。 */
function header(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** 把 Host 头的权威解析成 URL，无法解析时返回 undefined。 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** hostname 是否指回环权威。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 请求权威是否命中 trustedHosts 条目（精确，或省略端口时只比 hostname）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string' || entry === '') return false
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}
