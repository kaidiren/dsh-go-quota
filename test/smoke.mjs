// dsh-go-quota 冒烟测试：不需要真实网关，mock 掉 fetch 与宿主上下文，
// 端到端跑一遍 host 半边的路由处理器、额度表解析与缓存。
//
//   node test/smoke.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 全程把 DSH_HOME 指到临时目录，绝不读写用户真实的缓存文件。
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'goq-home-'))
const PREVIOUS_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = SANDBOX_HOME

const MODULE = new URL('../lib/index.js', import.meta.url)
const SYNC = await import(new URL('../lib/limits-sync.js', import.meta.url))

/** 上游返回一份固定的额度响应。 */
function mockUsageFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { status: 'ok', percent: 8, resetsAt: '2026-09-29T20:00:00Z' },
        weekly: { status: 'ok', percent: 4, resetsAt: '2026-10-05T00:00:00Z' },
        monthly: { status: 'ok', percent: 34, resetsAt: '2026-10-11T01:05:18Z' }
      }
    })
  })
}

/**
 * 造一个宿主上下文。
 * 默认走**新版** DSH 的 configEditor 路径（真实环境就是这条）；
 * legacy=true 时改用旧版 settings.get()；neither=true 时两条都读不到，
 * 用于验证 profile patch 文件兜底。
 */
function fakeContext(model = 'deepseek-v4.1-flash', { legacy = false, neither = false } = {}) {
  const routes = new Map()
  const selection = { provider: 'opencode-go', model, reasoningEffort: 'max' }
  return {
    routes,
    ctx: {
      effect: (fn) => fn(),
      get(name) {
        if (name === 'credentials') return { resolve: async () => ({ value: 'sk-fake' }) }
        if (neither) return undefined
        if (name === 'settings') {
          if (!legacy) return undefined
          return { get: (ns) => (ns === 'agent-default-model' ? selection : undefined) }
        }
        if (name === 'configEditor') {
          if (legacy) return undefined
          return {
            entries: () => [{ options: { id: 'agent-default-model' }, fiber: { config: selection } }]
          }
        }
        return undefined
      },
      webServer: {
        register: (options) => {
          routes.set(options.path, options.handler)
        }
      }
    }
  }
}

/** 调一次路由，收集状态码与响应体。 */
async function call(handler, url = '/dsh-go-quota/usage', method = 'GET') {
  let body = ''
  let status = 200
  const res = {
    setHeader() {},
    set statusCode(value) {
      status = value
    },
    get statusCode() {
      return status
    },
    end(value) {
      body = value
    }
  }
  await handler({ method, url }, res)
  return { status, json: body.length > 0 ? JSON.parse(body) : null }
}

const mod = await import(MODULE)
assert.equal(mod.name, 'dsh-go-quota')
assert.deepEqual(mod.inject, ['webServer', 'credentials'])

// ── 1. 新版 DSH：从 configEditor 读到模型并按额度表精确命中 ──
mockUsageFetch()
{
  const { routes, ctx } = fakeContext('deepseek-v4.1-flash')
  mod.apply(ctx)
  const handler = routes.get('/dsh-go-quota/usage')
  assert.equal(typeof handler, 'function', '路由应已注册')

  const out = await call(handler)
  assert.equal(out.status, 200)
  assert.equal(out.json.model, 'deepseek-v4.1-flash', '必须能从新版 configEditor 读到模型')
  assert.equal(out.json.limitSource, 'model', '命中额度表')
  assert.equal(out.json.unlimited, false)
  // deepseek-v4.1-flash 官方月上限 $100 → 5h $20 / 周 $50 / 月 $100
  assert.deepEqual(out.json.limits, { rolling: 20, weekly: 50, monthly: 100 })
  assert.equal(out.json.usage.monthly.percent, 34)
  // 34% × $100 = $34
  assert.equal((out.json.limits.monthly * out.json.usage.monthly.percent) / 100, 34)
  // 沙箱里既没有缓存、同步也不会成功（mock 的 fetch 返回 JSON 不是 HTML），所以用内置兜底表
  assert.equal(out.json.tableSource, 'builtin')
}

// ── 2. 旧版 DSH（settings.get 路径）也必须读到模型 ──
{
  const { routes, ctx } = fakeContext('deepseek-v4-pro', { legacy: true })
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.model, 'deepseek-v4-pro')
  assert.equal(out.json.limitSource, 'model')
  assert.deepEqual(out.json.limits, { rolling: 3, weekly: 7.5, monthly: 15 })
}

// ── 3. 不在表里的 DeepSeek 变体不能被前缀蒙中 ──
mockUsageFetch()
{
  const { routes, ctx } = fakeContext('deepseek-v4-flash')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.limitSource, 'default', '表里没有 deepseek-v4-flash，必须标成 default')
  assert.deepEqual(out.json.limits, { rolling: 12, weekly: 30, monthly: 60 }, '兜底仍给 $60')
}

// ── 3b. 官方把模型改名为 deepseek-flash：别名仍须命中额度表里的 V4.1 Flash 档 ──
mockUsageFetch()
{
  const { routes, ctx } = fakeContext('deepseek-flash')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.model, 'deepseek-flash', '回报的仍是官方现用名')
  assert.equal(out.json.limitSource, 'model', 'deepseek-flash 就是 V4.1 Flash，必须命中而不是兜底')
  assert.deepEqual(out.json.limits, { rolling: 20, weekly: 50, monthly: 100 }, '同一档 $100')
}

// ── 4. 未收录模型：标成 default，界面据此不显示括号 ──
{
  const { routes, ctx } = fakeContext('some-unknown-model')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.limitSource, 'default')
  assert.deepEqual(out.json.limits, { rolling: 12, weekly: 30, monthly: 60 }, '兜底仍给 $60')
}

// ── 5. 两条配置接口都读不到时，回退解析 profile 的 cordis.patch.yml ──
{
  const home = mkdtempSync(join(tmpdir(), 'goq-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    [
      '# 测试用 patch',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: opencode-go',
      '    model: deepseek-v4-pro',
      '    reasoningEffort: max',
      '- id: web-search-deepseek',
      '  config:',
      '    model: deepseek-v4.1-flash',
      ''
    ].join('\n')
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { routes, ctx } = fakeContext('ignored', { neither: true })
    mod.apply(ctx)
    const out = await call(routes.get('/dsh-go-quota/usage'))
    assert.equal(out.json.model, 'deepseek-v4-pro', '应从 profile patch 文本解析出模型')
    assert.equal(out.json.limitSource, 'model')
    assert.deepEqual(out.json.limits, { rolling: 3, weekly: 7.5, monthly: 15 }, 'deepseek-v4-pro 是 $15 档')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 6. 免费模型不再被跟踪：退回兜底，不再显示为无限 ──
mockUsageFetch()
{
  const { routes, ctx } = fakeContext('beam-free')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.unlimited, false, '免费模型已不在跟踪范围内')
  assert.equal(out.json.limitSource, 'default')
  assert.deepEqual(out.json.limits, { rolling: 12, weekly: 30, monthly: 60 }, '兜底仍给 $60')
}

// ── 7. 上游 403：路由返回 502 与可读原因 ──
{
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) })
  const { routes, ctx } = fakeContext()
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.status, 502)
  assert.match(out.json.error, /HTTP 403/)
}

// ── 8. 方法限制 ──
{
  mockUsageFetch()
  const { routes, ctx } = fakeContext()
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'), '/dsh-go-quota/usage', 'POST')
  assert.equal(out.status, 405)
}

// ── 9. 官方文档页解析：模型名归一化 + 只留 DeepSeek ──
{
  const html = [
    '<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Write</th><th>Monthly limit</th></tr></thead><tbody>',
    '<tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>-</td><td><strong>$60</strong></td></tr>',
    '<tr><td>Kimi K3</td><td>$3.00</td><td>$15.00</td><td>-</td><td><strong>$15</strong></td></tr>',
    '<tr><td>DeepSeek V4.1 Flash (Off-Peak)</td><td>$0.15</td><td>$0.60</td><td>-</td><td><strong>$100</strong></td></tr>',
    '<tr><td>DeepSeek V4.1 Flash (Peak)</td><td>$0.30</td><td>$1.20</td><td>-</td><td><strong>$100</strong></td></tr>',
    '<tr><td>DeepSeek V4 Pro (Off-Peak)</td><td>$0.66</td><td>$1.98</td><td>-</td><td><strong>$15</strong></td></tr>',
    '<tr><td>Qwen3.7 Plus (&le; 256K tokens)</td><td>$0.40</td><td>$1.60</td><td>$0.50</td><td><strong>$60</strong></td></tr>',
    '<tr><td>Beam Free</td><td>Free</td><td>Free</td><td>-</td><td><strong>Unlimited</strong>limited time</td></tr>',
    '</tbody></table>'
  ].join('')
  const parsed = SYNC.parseLimits(html)
  assert.notEqual(parsed, null)
  assert.equal(parsed.limits['deepseek-v4.1-flash'], 100, '带 (Off-Peak)/(Peak) 后缀要归一到同一个 id')
  assert.equal(parsed.limits['deepseek-v4-pro'], 15)
  assert.equal('glm-5.3-flash' in parsed.limits, false, '非 DeepSeek 模型必须被丢弃')
  assert.equal('kimi-k3' in parsed.limits, false, '非 DeepSeek 模型必须被丢弃')
  assert.equal('qwen3.7-plus' in parsed.limits, false, '非 DeepSeek 模型必须被丢弃')
  assert.equal('beam-free' in parsed.limits, false, '免费模型必须被丢弃')
  assert.deepEqual(parsed.unlimited, [], '不再跟踪免费模型，unlimited 恒为空')
  // 没有 Monthly limit 表头的表应被忽略
  assert.equal(SYNC.parseLimits('<table><tr><td>a</td></tr></table>'), null)
  // 只有免费模型、没有 DeepSeek 时，等于没解析出任何东西
  assert.equal(
    SYNC.parseLimits(
      '<table><tr><td>Model</td><td>Monthly limit</td></tr></table>' +
        '<table><tr><td>Beam Free</td><td>Free</td><td>Free</td><td>-</td><td>Unlimited</td></tr></table>'
    ),
    null
  )
}

// ── 10. 归一化函数抽查 ──
{
  assert.equal(SYNC.normalizeModelId('DeepSeek V4.1 Flash (Off-Peak)'), 'deepseek-v4.1-flash')
  assert.equal(SYNC.normalizeModelId('Kimi K2.7 Code'), 'kimi-k2.7-code')
  assert.equal(SYNC.normalizeModelId('Grok 4.7 (> 200K tokens)'), 'grok-4.7')
  assert.equal(SYNC.normalizeModelId(''), null)
}

// ── 11. 缓存读写 + 启动时用缓存覆盖内置表 ──
{
  const path = SYNC.cachePath()
  assert.equal(path, join(SANDBOX_HOME, 'storages', 'dsh-go-quota', 'limits.json'))
  assert.equal(
    SYNC.writeCache({
      syncedAt: 1_790_670_000_000,
      source: SYNC.SOURCE_URL,
      limits: { 'deepseek-v4-pro': 99 },
      unlimited: []
    }),
    true
  )
  const cached = SYNC.readCache()
  assert.equal(cached.limits['deepseek-v4-pro'], 99)
  assert.equal(cached.syncedAt, 1_790_670_000_000)

  mockUsageFetch()
  const { routes, ctx } = fakeContext('deepseek-v4-pro')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.json.tableSource, 'cache', '启动时应先采用本地缓存')
  assert.equal(out.json.tableSyncedAt, 1_790_670_000_000)
  assert.deepEqual(out.json.limits, { rolling: 19.8, weekly: 49.5, monthly: 99 }, '缓存值 99 生效')
  rmSync(path, { force: true })
}

// ── 12. 界面用的美元格式化（与 lib/client.js 中的 usd() 同一实现）──
{
  const usd = (value) => '$' + (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
  assert.equal(usd(20.4), '$20.4')
  assert.equal(usd(60), '$60')
  assert.equal(usd(12), '$12')
  assert.equal(usd(0.96), '$0.96')
  assert.equal(usd(1.2), '$1.2')
  assert.equal(usd(7.5), '$7.5')
  assert.equal(usd(0), '$0')
  assert.equal(usd(100), '$100')
}

// ── 13. DeepSeek 官方余额：与 Go 额度并行查，币种与金额按官方结构透出 ──
{
  const usageBody = {
    usage: {
      rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-31T20:00:00Z' },
      weekly: { status: 'ok', percent: 4, resetsAt: '2026-11-02T00:00:00Z' },
      monthly: { status: 'ok', percent: 34, resetsAt: '2026-11-11T01:05:18Z' }
    }
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: '110.00',
              granted_balance: '10.00',
              topped_up_balance: '100.00'
            }
          ]
        })
      }
    }
    return { ok: true, status: 200, json: async () => usageBody }
  }
  const { routes, ctx } = fakeContext('deepseek-v4.1-flash')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.status, 200)
  assert.deepEqual(
    out.json.deepseek,
    { currency: 'CNY', total: 110, granted: 10, toppedUp: 100, available: true },
    '余额要按官方 balance_infos 结构透出'
  )
  assert.equal(out.json.limitSource, 'model', '余额不应干扰 Go 额度命中')
}

// ── 14. 余额查询失败：只丢余额，路由本身照常成功 ──
{
  const usageBody = {
    usage: {
      rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-31T20:00:00Z' },
      weekly: { status: 'ok', percent: 4, resetsAt: '2026-11-02T00:00:00Z' },
      monthly: { status: 'ok', percent: 34, resetsAt: '2026-11-11T01:05:18Z' }
    }
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) throw new Error('boom')
    return { ok: true, status: 200, json: async () => usageBody }
  }
  const { routes, ctx } = fakeContext('deepseek-v4.1-flash')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.status, 200, '余额失败不能让整个路由失败')
  assert.equal(out.json.deepseek, null, '拿不到余额时为 null')
  assert.equal(out.json.limitSource, 'model')
}

// ── 15. 余额接口返回非 2xx 或结构异常：同样降级为 null ──
{
  const usageBody = {
    usage: {
      rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-31T20:00:00Z' },
      weekly: { status: 'ok', percent: 4, resetsAt: '2026-11-02T00:00:00Z' },
      monthly: { status: 'ok', percent: 34, resetsAt: '2026-11-11T01:05:18Z' }
    }
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) {
      return { ok: false, status: 401, json: async () => ({ error: 'Invalid token' }) }
    }
    return { ok: true, status: 200, json: async () => usageBody }
  }
  const { routes, ctx } = fakeContext('deepseek-v4.1-flash')
  mod.apply(ctx)
  const out = await call(routes.get('/dsh-go-quota/usage'))
  assert.equal(out.status, 200)
  assert.equal(out.json.deepseek, null, '401 时不给余额')
}

// 收尾：还原环境并清掉沙箱
if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = PREVIOUS_DSH_HOME
rmSync(SANDBOX_HOME, { recursive: true, force: true })

console.log('✅ 全部通过：两代配置读取、profile patch 兜底、DeepSeek 分档、官方页面只解析 DeepSeek、DeepSeek 余额透出与降级、缓存降级、错误分支')
