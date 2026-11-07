/**
 * dsh-go-quota — 官方额度表同步。
 *
 * 官方 API 不提供额度金额（`/v1/usage` 只给百分比，`/v1/models` 只给 model id），
 * 唯一来源是文档页 https://opencode.ai/v2/docs/console/go/ 里那张「Monthly limit」表格。
 * 本模块负责：抓取 → 解析 → 本地缓存，让数值能随官方调整自动更新，
 * 同时保证抓取失败时永远有可用的旧值（缓存 → 内置兜底表）。
 *
 * 只解析 DeepSeek 系列，其余模型一律丢弃：这张卡的用途就是盯 DeepSeek 额度，
 * 别家模型和限时免费模型的上限既不展示也不参与换算。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 额度表来源页面。旧地址 /docs/go 会 302 到这里，直接用新地址少一跳。 */
export const SOURCE_URL = 'https://opencode.ai/v2/docs/console/go/'

/** 同步间隔：1 小时。 */
export const SYNC_INTERVAL_MS = 3_600_000

/** 单次抓取超时。 */
const FETCH_TIMEOUT_MS = 20_000

/** 与额度查询保持一致的浏览器 UA（Cloudflare 前置会拦非浏览器 UA）。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** 去 HTML 标签、解常见实体、压缩空白。 */
function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 表格里的模型名 → 官方 model id（去掉括号后缀再转小写连字符）。
 *   'DeepSeek V4.1 Flash (Off-Peak)'→ 'deepseek-v4.1-flash'
 *   'DeepSeek V4 Pro (Peak)'        → 'deepseek-v4-pro'
 */
export function normalizeModelId(name) {
  const base = String(name)
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .toLowerCase()
  if (base.length === 0) return null
  const id = base.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
  return id.length > 0 ? id : null
}

/** '$60' / '$0.15' → 数字；解析不出返回 null。 */
function parseUsd(text) {
  const hit = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(text))
  return hit === null ? null : Number(hit[1])
}

/** 只保留 DeepSeek 系列的 model id（deepseek-v4.1-flash、deepseek-v4-pro …）。 */
const DEEPSEEK_ID = /^deepseek-/

/**
 * 从文档页 HTML 里解析月度额度上限（只取 DeepSeek 系列）。
 * 只认含「Monthly limit」表头的那张表（页面按订阅档位并排多张同名表，取第一个）。
 * unlimited 固定为空：不再跟踪限时免费模型，保留字段是为了让缓存格式与调用方保持稳定。
 * @param {string} html
 * @returns {{ limits: Record<string, number>, unlimited: string[] } | null}
 */
export function parseLimits(html) {
  const tables = String(html).match(/<table>[\s\S]*?<\/table>/g) ?? []
  for (const table of tables) {
    if (!/Monthly limit/i.test(table)) continue
    /** @type {Record<string, number>} */
    const limits = {}
    for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]))
      // 表头行用的是 <th>，这里自然只剩数据行。
      if (cells.length < 3) continue
      const id = normalizeModelId(cells[0])
      if (id === null) continue
      // 只认 DeepSeek 系列，其余整行丢弃（含标为 Unlimited 的免费模型）。
      if (!DEEPSEEK_ID.test(id)) continue
      const amount = parseUsd(cells[cells.length - 1])
      if (amount === null) continue
      // 同一个模型可能出现多行（如 DeepSeek 的 Peak / Off-Peak），取其中较大者作为上限。
      const previous = limits[id]
      limits[id] = previous === undefined ? amount : Math.max(previous, amount)
    }
    if (Object.keys(limits).length > 0) return { limits, unlimited: [] }
  }
  return null
}

/** 抓取并解析官方文档页；任何失败都返回 null（调用方保持旧值）。 */
export async function fetchLimits() {
  try {
    const response = await fetch(SOURCE_URL, {
      headers: { 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const html = await response.text()
    const parsed = parseLimits(html)
    if (parsed === null) return null
    return { ...parsed, syncedAt: Date.now(), source: SOURCE_URL }
  } catch {
    return null
  }
}

/** 缓存文件路径：$DSH_HOME/storages/dsh-go-quota/limits.json。 */
export function cachePath() {
  const home = process.env.DSH_HOME || (process.env.HOME ? join(process.env.HOME, '.dsh') : null)
  return home === null ? null : join(home, 'storages', 'dsh-go-quota', 'limits.json')
}

/** 读缓存；文件不存在或损坏都返回 null。 */
export function readCache() {
  const path = cachePath()
  if (path === null) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data === null || typeof data !== 'object') return null
    if (data.limits === null || typeof data.limits !== 'object') return null
    return {
      syncedAt: Number.isFinite(data.syncedAt) ? data.syncedAt : 0,
      source: typeof data.source === 'string' ? data.source : SOURCE_URL,
      limits: data.limits,
      unlimited: Array.isArray(data.unlimited) ? data.unlimited.filter((x) => typeof x === 'string') : []
    }
  } catch {
    return null
  }
}

/** 原子写缓存（临时文件 + rename）；失败静默。 */
export function writeCache(payload) {
  const path = cachePath()
  if (path === null) return false
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // 清理失败无所谓
    }
    return false
  }
}
