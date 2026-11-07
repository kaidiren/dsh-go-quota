/**
 * dsh-go-quota — host 半边。
 *
 * 只做一件事：查询 OpenCode Go 订阅额度（GET https://opencode.ai/zen/go/v1/usage），
 * 把结果通过同源路由交给浏览器半边。API Key 只留在宿主进程，浏览器永远看不到。
 *
 *   GET /dsh-go-quota/usage            额度 JSON（命中 60s 进程内缓存）
 *   GET /dsh-go-quota/usage?refresh=1  强制绕过缓存重新查询
 *
 * 官方接口的能力边界（实测 + 官方文档双重确认）：
 *   - /v1/usage  只给 rolling/weekly/monthly 三档的 percent + resetsAt，**没有任何金额字段**；
 *   - /v1/models 只给模型 id，**不带价格或额度元数据**。
 * 所以「总额度」只能来自官方文档页的「Monthly limit」表格：本插件每小时抓一次
 * https://opencode.ai/v2/docs/console/go/ ，只解析 DeepSeek 系列与限时免费模型，
 * 缓存到 $DSH_HOME/storages/dsh-go-quota/limits.json；抓取失败时依次降级到
 * 本地缓存 → 内置兜底表（BUILTIN_LIMITS），永不中断。
 *
 * Key 解析顺序（与 dsh-cost-meter 的 resolveGoKey 保持一致，保证换插件后照常可用）：
 *   1. DSH 凭据库 / 环境变量 OPENCODE_GO_API_KEY
 *   2. llm-pi-ai.providers.<route>.apiKeyEnv，其中该路由 baseURL 指向官方 Go 端点
 *   3. OPENCODE_API_KEY（旧名兼容）
 *   4. opencode CLI 的登录态文件 auth.json 里的 opencode-go.key
 */

import { readFileSync } from 'node:fs'
import { SYNC_INTERVAL_MS, fetchLimits, readCache, writeCache } from './limits-sync.js'

export const name = 'dsh-go-quota'

/** 需要宿主提供的能力：HTTP 路由 + 凭据解析。 */
export const inject = ['webServer', 'credentials']

/** OpenCode Go 额度端点（官方固定域名）。 */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * DeepSeek 官方 API 账户余额端点。
 * 与 OpenCode Go 订阅额度是两套完全独立的账号体系：这里查的是 api.deepseek.com
 * 上那个账户的可用余额（预付 + 赠送），用 DEEPSEEK_API_KEY 认证。
 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 余额查询超时：它只是卡片的附加信息，宁可放弃也不拖慢主额度请求。 */
const BALANCE_TIMEOUT_MS = 10_000

/** 额度查询的进程内缓存时长。 */
const CACHE_MS = 60_000

/** 单次请求超时。 */
const TIMEOUT_MS = 15_000

/**
 * opencode.ai 前面挂着 Cloudflare：不带浏览器 User-Agent 的请求会被
 * 以 error 1010 直接拦掉，所以这里必须伪装成浏览器。
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * 内置兜底额度表（美元/月），抄自 https://opencode.ai/v2/docs/console/go/ 的「Monthly limit」列。
 * 只保留 DeepSeek 系列：本插件只盯这两条额度，别的模型不参与换算。
 * 正常情况下会被每小时的自动同步覆盖；只有在没网、没缓存、页面改版解析失败时才用到它。
 */
const BUILTIN_LIMITS = {
  'deepseek-v4.1-flash': 100,
  'deepseek-v4-pro': 15
}

/**
 * 不再跟踪限时免费模型：unlimited 恒为空集合。
 * 保留这个集合（而不是删掉整条链路）是为了让缓存格式、adopt 与界面的「无限」分支保持稳定。
 */
const BUILTIN_UNLIMITED = []

/** 各窗口占月度上限的比例（官方规则）。 */
const WINDOW_SHARE = { rolling: 0.2, weekly: 0.5, monthly: 1 }

/** 模型未收录时的兜底月度上限。 */
const DEFAULT_MONTHLY_LIMIT = 60

/**
 * 把 Loader Config 的稳定引用转成普通值。
 * DSH ≥0.1.7 会用引用对象包装易变字段（例如 llm-pi-ai 的 provider 字典），
 * 必须调 `.get()` 才能拿到真正的 JSON 值。
 */
function plainConfigValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return plainConfigValue(value.get())
  }
  if (Array.isArray(value)) return value.map(plainConfigValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfigValue(child)]))
  }
  return value
}

/**
 * 读取另一个插件/服务的生效配置，兼容两代 DSH：
 *   - 旧版（≤0.1.6）：`ctx.settings.get(ns)`
 *   - 新版（≥0.1.7）：Loader 条目挂在 configEditor 上，值在 `entry.fiber.config`
 * 读不到一律返回 undefined —— 这些都是可选信息，绝不能因为读配置失败而影响额度查询。
 */
function settingsValue(ctx, ns) {
  try {
    const settings = ctx?.get?.('settings')
    if (settings !== undefined && typeof settings.get === 'function') {
      const value = settings.get(ns)
      if (value !== undefined && value !== null) return plainConfigValue(value)
    }
    const editor = ctx?.get?.('configEditor')
    const entry =
      typeof editor?.entries === 'function'
        ? editor.entries().find((candidate) => candidate.options?.id === ns)
        : undefined
    return entry?.fiber?.config === undefined ? undefined : plainConfigValue(entry.fiber.config)
  } catch {
    return undefined
  }
}

/**
 * 凭据引用候选。只从官方 Go 端点读取 apiKeyEnv，避免把其它 provider 的
 * 密钥拿去查 Go 额度；每次都读当前设置快照，改名或轮换密钥后无需重启。
 */
function keyRefs(ctx) {
  const refs = new Set(['OPENCODE_GO_API_KEY'])
  const providers = settingsValue(ctx, 'llm-pi-ai')?.providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const profile of Object.values(providers)) {
      if (typeof profile?.baseURL !== 'string' || typeof profile?.apiKeyEnv !== 'string') continue
      try {
        const url = new URL(profile.baseURL)
        // 官方 Go 端点的两种常见写法：/zen/go 与 /zen/go/v1
        if (url.origin !== 'https://opencode.ai' || !/^\/zen\/go(\/v1)?\/?$/.test(url.pathname)) continue
        const ref = profile.apiKeyEnv.trim()
        if (ref.length > 0) refs.add(ref)
      } catch {
        // 无效端点不参与发现
      }
    }
  }
  refs.add('OPENCODE_API_KEY')
  return [...refs]
}

/** 从 opencode CLI 的登录态文件兜底找 Key（与 opencode login 共用）。 */
function findKeyInAuthJson() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = [
    home ? `${home}/.local/share/opencode/auth.json` : '',
    process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/opencode/auth.json` : '',
    home ? `${home}/.config/opencode/auth.json` : ''
  ].filter(Boolean)
  for (const path of candidates) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      const key = data?.['opencode-go']?.key
      if (typeof key === 'string' && key.trim().length > 0) return key.trim()
    } catch {
      // 文件不存在或不可读：换下一个位置
    }
  }
  return null
}

/** 解析 Go API Key；每个引用先查 DSH 凭据库，再查同名环境变量。 */
async function resolveKey(ctx) {
  const credentials = ctx.get('credentials')
  for (const ref of keyRefs(ctx)) {
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string' && hit.value.trim().length > 0) return hit.value.trim()
      } catch {
        // 该引用不可用：继续尝试下一个
      }
    }
    const value = String(process.env[ref] ?? '').trim()
    if (value.length > 0) return value
  }
  return findKeyInAuthJson()
}

/**
 * DeepSeek 官方余额的凭据候选。默认就是 DEEPSEEK_API_KEY
 * （与 dsh-llm-deepseek-api-key 插件的默认 apiKeyEnv 一致）；
 * 再从 llm-pi-ai 里找出 baseURL 指向 api.deepseek.com 的 provider，把它的
 * apiKeyEnv 补进来 —— 换 provider 或改引用名后不用改这里。
 */
function deepseekKeyRefs(ctx) {
  const refs = new Set(['DEEPSEEK_API_KEY'])
  const providers = settingsValue(ctx, 'llm-pi-ai')?.providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const profile of Object.values(providers)) {
      if (typeof profile?.baseURL !== 'string' || typeof profile?.apiKeyEnv !== 'string') continue
      try {
        const url = new URL(profile.baseURL)
        if (!url.hostname.endsWith('deepseek.com')) continue
        const ref = profile.apiKeyEnv.trim()
        if (ref.length > 0) refs.add(ref)
      } catch {
        // 无效端点不参与发现
      }
    }
  }
  return [...refs]
}

/** 解析 DeepSeek 官方 API Key；取不到返回 null（余额只是附加信息）。 */
async function resolveDeepSeekKey(ctx) {
  const credentials = ctx.get('credentials')
  for (const ref of deepseekKeyRefs(ctx)) {
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string' && hit.value.trim().length > 0) return hit.value.trim()
      } catch {
        // 该引用不可用：继续尝试下一个
      }
    }
    const value = String(process.env[ref] ?? '').trim()
    if (value.length > 0) return value
  }
  return null
}

/**
 * 查询 DeepSeek 官方账户余额（GET /user/balance）。
 *
 * 任何失败 —— 没配 Key、网络不通、返回结构变了 —— 都返回 null，让卡片只少了
 * 一个数字，而不是整张卡报错：余额与 Go 额度是两个独立的账号体系，不能互相拖累。
 */
async function fetchDeepSeekBalance(ctx) {
  const key = await resolveDeepSeekKey(ctx)
  if (key === null) return null
  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const data = await response.json()
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
    // 官方一般只返回账户所在区域的那一种币种；有多条时取第一条并保留币种。
    const info = infos[0]
    if (info === null || typeof info !== 'object') return null
    const total = Number(info.total_balance)
    if (!Number.isFinite(total)) return null
    const granted = Number(info.granted_balance)
    const toppedUp = Number(info.topped_up_balance)
    return {
      currency: typeof info.currency === 'string' ? info.currency : '',
      total,
      granted: Number.isFinite(granted) ? granted : 0,
      toppedUp: Number.isFinite(toppedUp) ? toppedUp : 0,
      available: data.is_available === true
    }
  } catch {
    return null
  }
}

/** 归一化单个额度窗口，只保留界面需要的字段。 */
function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const percent = Number(raw.percent)
  if (!Number.isFinite(percent)) return null
  return {
    percent,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : '',
    status: typeof raw.status === 'string' ? raw.status : ''
  }
}

/**
 * 配置服务读不到时的兜底：直接解析 profile 的 cordis.patch.yml 文本。
 * agent-default-model 通常就写在 patch 层里，静态文件比跨版本 API 稳。
 */
function selectionFromProfilePatch() {
  const home = process.env.DSH_HOME || (process.env.HOME ? `${process.env.HOME}/.dsh` : '')
  if (home === '') return null
  const paths = [`${home}/profiles/web/cordis.patch.yml`, `${home}/profiles/desktop/cordis.patch.yml`]
  for (const path of paths) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    let inBlock = false
    let provider = ''
    let model = null
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*-\s*id:\s*agent-default-model\s*$/.test(line)) {
        inBlock = true
        continue
      }
      if (!inBlock) continue
      if (/^\s*-\s*id:/.test(line)) break // 进入下一个条目
      const hitProvider = /^\s*provider:\s*(\S+)\s*$/.exec(line)
      if (hitProvider !== null) provider = hitProvider[1]
      const hitModel = /^\s*model:\s*(\S+)\s*$/.exec(line)
      if (hitModel !== null) model = hitModel[1]
    }
    if (model !== null) return { provider, model }
  }
  return null
}

/** 读取 DSH 当前的默认模型选型（provider + model），用于推断额度上限。 */
function currentSelection(ctx) {
  const selection = settingsValue(ctx, 'agent-default-model')
  if (
    selection !== null &&
    selection !== undefined &&
    typeof selection === 'object' &&
    typeof selection.model === 'string'
  ) {
    return {
      provider: typeof selection.provider === 'string' ? selection.provider : '',
      model: selection.model
    }
  }
  return selectionFromProfilePatch()
}

/**
 * 官方 API 的现用模型名 → Go 额度表里的名字。
 *
 * api-docs.deepseek.com 已把模型改名为 `deepseek-flash`（由 DeepSeek-V4.1-Flash-1017
 * 提供服务，旧的 `deepseek-v4-flash` 等名字虽仍被接受、但对应模型已退役），而 Go 文档表的
 * 「Monthly limit」仍按模型全名（DeepSeek V4.1 Flash）列出 $100 —— 两者是同一档。
 * 缺了这层映射，模型改名的当天卡片就会掉到兜底 $60，并且不再显示括号里的总额度。
 *
 * 只做精确名字映射，不做前缀/版本号模糊匹配（`deepseek-v4-flash` 这类退役变体不在此列）。
 */
const MODEL_ALIASES = { 'deepseek-flash': 'deepseek-v4.1-flash' }

/**
 * 在额度表里找模型对应的键：先按原名精确查，查不到再看别名。
 * 这样官方哪天把额度表也改成新名字，命中会自然回落到原名分支。
 */
function limitKeyOf(model, table) {
  if (model === null) return null
  if (Number.isFinite(table.limits[model]) || table.unlimited.has(model)) return model
  return MODEL_ALIASES[model] ?? model
}

/**
 * 按模型算出三个窗口的美元额度。
 * limitSource 说明这个数字的可信度：
 *   'model'   —— 在额度表里按模型 id 精确命中
 *   'default' —— 模型未知（配置读不到或不在表里），用了兜底上限
 * 界面只在 'model' 时才显示括号里的总额度，避免拿兜底值误导。
 */
function limitsFor(model, table) {
  const key = limitKeyOf(model, table)
  if (key !== null && table.unlimited.has(key)) {
    return { unlimited: true, limits: null, limitSource: 'model' }
  }
  const known = key !== null && Number.isFinite(table.limits[key])
  const monthly = known ? table.limits[key] : DEFAULT_MONTHLY_LIMIT
  return {
    unlimited: false,
    limitSource: known ? 'model' : 'default',
    limits: {
      rolling: monthly * WINDOW_SHARE.rolling,
      weekly: monthly * WINDOW_SHARE.weekly,
      monthly: monthly * WINDOW_SHARE.monthly
    }
  }
}

/**
 * 请求额度端点。Cloudflare 前置会间歇性重置连接（ECONNRESET → fetch failed），
 * 所以瞬时错误自动重试一次；401/403 属业务状态，不重试。
 */
async function fetchUsage(key) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${key}`,
          'user-agent': BROWSER_UA
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!response.ok) {
        const permanent = response.status === 401 || response.status === 403
        const error = new Error(
          permanent
            ? `OpenCode Go 没有有效订阅或 Key 无效（HTTP ${response.status}）`
            : `OpenCode Go 网关返回 HTTP ${response.status}`
        )
        error.permanent = permanent
        throw error
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (error?.permanent === true) break
    }
  }
  throw lastError
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /**
   * 当前生效的额度表。层次：内置兜底 → 本地缓存 → 每小时同步结果。
   * source: 'builtin' | 'cache' | 'synced'
   */
  let table = {
    limits: { ...BUILTIN_LIMITS },
    unlimited: new Set(BUILTIN_UNLIMITED),
    source: 'builtin',
    syncedAt: 0
  }

  /** 用一份同步结果覆盖额度表（内置值始终保留，作为官方页面缺项的补充）。 */
  const adopt = (payload, source) => {
    if (payload === null || payload.limits === null || typeof payload.limits !== 'object') return false
    const limits = { ...BUILTIN_LIMITS, ...payload.limits }
    if (Object.keys(limits).length === 0) return false
    table = {
      limits,
      unlimited: new Set([
        ...BUILTIN_UNLIMITED,
        ...(Array.isArray(payload.unlimited) ? payload.unlimited : [])
      ]),
      source,
      syncedAt: Number.isFinite(payload.syncedAt) ? payload.syncedAt : 0
    }
    return true
  }

  /** 抓一次官方页面；成功则落盘缓存。任何失败都保持现有额度表不动。 */
  const syncLimits = async () => {
    const payload = await fetchLimits()
    if (payload === null) return false
    adopt(payload, 'synced')
    writeCache({
      syncedAt: payload.syncedAt,
      source: payload.source,
      limits: payload.limits,
      unlimited: payload.unlimited
    })
    return true
  }

  // 启动：先用本地缓存（立刻可用，不依赖网络），再判断要不要立刻抓一次。
  adopt(readCache(), 'cache')
  ctx.effect(() => {
    if (table.source !== 'synced' || Date.now() - table.syncedAt > SYNC_INTERVAL_MS) {
      void syncLimits().catch(() => {})
    }
    const timer = setInterval(() => {
      void syncLimits().catch(() => {})
    }, SYNC_INTERVAL_MS)
    // 别因为一个定时器把进程钉住。
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-go-quota: 额度表每小时同步')

  /** 额度查询的进程内缓存：一个在途 promise + TTL。 */
  let cache = { at: 0, promise: null }

  const quotaOnce = (force) => {
    const now = Date.now()
    if (!force && cache.promise !== null && now - cache.at < CACHE_MS) return cache.promise

    const promise = (async () => {
      const key = await resolveKey(ctx)
      if (key === null) {
        throw new Error(
          '未找到 OpenCode Go API Key：请在 DSH 凭据里配置 OPENCODE_GO_API_KEY，或先 opencode login'
        )
      }
      // 余额与 Go 额度并行查：余额内部已自吞所有异常，最坏只是 deepseek 为 null，
      // 绝不会让整张卡片因为「另一个账号体系」的问题而失败。
      const [data, deepseek] = await Promise.all([fetchUsage(key), fetchDeepSeekBalance(ctx)])
      const usage = data?.usage
      if (usage === null || typeof usage !== 'object') {
        throw new Error('OpenCode Go 返回了意外的响应结构')
      }

      const selection = currentSelection(ctx)
      const model = selection === null ? null : selection.model
      const { unlimited, limits, limitSource } = limitsFor(model, table)

      return {
        fetchedAt: Date.now(),
        // 百分比来自官方；金额是按额度表换算的（官方接口不给金额）。
        model,
        limitSource,
        // DeepSeek 官方 API 账户余额（api.deepseek.com），与上面的 Go 订阅额度无关。
        deepseek,
        // 额度表的来源与同步时间，便于判断这个美元数字有多新。
        tableSource: table.source,
        tableSyncedAt: table.syncedAt,
        unlimited,
        limits,
        usage: {
          rolling: normalizeWindow(usage.rolling),
          weekly: normalizeWindow(usage.weekly),
          monthly: normalizeWindow(usage.monthly)
        }
      }
    })()

    cache = { at: now, promise }
    // 失败就清掉缓存，下一次请求立刻重试，而不是等 TTL 过期。
    promise.catch(() => {
      if (cache.promise === promise) cache = { at: 0, promise: null }
    })
    return promise
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-go-quota/usage',
        handler: async (req, res) => {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const force = typeof req.url === 'string' && req.url.includes('refresh=1')
          try {
            const data = await quotaOnce(force)
            res.end(JSON.stringify(data))
          } catch (error) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        }
      }),
    'dsh-go-quota: usage route'
  )
}
