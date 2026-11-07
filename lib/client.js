// dsh-go-quota — 浏览器半边。
//
// 手写的 DSH 模块加载器 bundle（window.__ModuleLoader__.load 工厂格式）。
// 只做一件事：在侧边栏底部注册一张卡，显示 OpenCode Go 的
// 月度额度（主档：百分比 + 括号里的总额度 + 进度条）+ 其余两档 + 重置时间；
// 数据来自 host 半边的同源路由 /dsh-go-quota/usage，API Key 永远不会进入浏览器。
//
// 外观与 dsh-cost-meter 的 Go 卡保持一致（同一套 --dsw-alias-* 主题 token）。
// 括号里的总额度只在 host 能按模型精确查到官方上限时才显示（limitSource === 'model'）；
// 否则只显示百分比，绝不拿兜底值冒充。
window.__ModuleLoader__.load({
  id: 'dsh-go-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    // ── 样式（注入一次；沿用内置 client 插件的 data-plugin-css 去重约定）──
    const CSS_ID = 'dsh-go-quota/card.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-go-quota'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.goq-num{font-variant-numeric:tabular-nums}',
        // 边框专职表达 DeepSeek 峰谷计费：低谷（默认）品牌蓝、高峰红。
        // 额度告警不再染指边框（原来的 .warn/.over 边框规则已删），只改百分比数字
        // 与进度条，两者因此不会互相覆盖。
        '.goq-bbox{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-state-business-primary);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px;color:var(--dsw-alias-label-primary)}',
        '.goq-bbox.peak{border-color:var(--dsw-alias-state-error-primary)}',
        '.goq-bbox.clickable{cursor:pointer}',
        // 悬停刻意不给任何描边/光环：边框色已经承载峰谷信息，再套一圈会和它抢戏。
        // 键盘焦点仍保留 outline（无障碍需要，与鼠标悬停无关）。
        '.goq-bbox.clickable:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
        '.goq-bbox.peak.clickable:focus-visible{outline-color:var(--dsw-alias-state-error-primary)}',
        '.goq-bbox.busy{animation:goq-pulse 1.1s ease-in-out infinite}',
        '@keyframes goq-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
        '.goq-bbox-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;overflow:hidden}',
        // 左侧固定显示 DeepSeek 官方 API 账户余额（原来这里放的是品牌名 Go，已去掉）。
        // 它和右侧的 Go 订阅额度是两套账号体系，所以单独占一个位置、用粗黑强调。
        // 拿不到余额（没配 DEEPSEEK_API_KEY / 请求失败）时留一个 0 宽空 span，
        // 只是为了维持 space-between 的右对齐，不显示占位数字。
        '.goq-bbox-balance{flex:0 0 auto;font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary);white-space:nowrap}',
        // 第一行：账户余额靠左，三档指标 + 金额整体靠右 —— 卡片拉宽时贴住右边，不留空档。
        // 三档数值统一「剩余」口径 + 品牌蓝（与下方进度条的蓝段同源）；标签留淡、
        // 金额再淡一档，形成「粗黑余额 + 蓝数字 + 灰金额」的层次。余额与金额都不收缩，
        // 只有三档指标让位 —— 窄侧栏先裁指标，不裁余额和金额。
        '.goq-bbox-right{display:inline-flex;align-items:baseline;gap:4px;min-width:0;overflow:hidden}',
        // 三档之间不再用「·」分隔，改由这里的 gap 拉开组距（否则会贴成「98%周 86%」）。
        // 组距 6px：够把「100%」和下一档的标签分开，又不至于在窄侧栏里显得散。
        '.goq-bbox-metrics{display:inline-flex;align-items:baseline;gap:6px;flex:0 1 auto;min-width:0;overflow:hidden}',
        '.goq-metric{display:inline-flex;align-items:baseline;gap:2px;white-space:nowrap}',
        '.goq-metric-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}',
        '.goq-metric-num{font-size:12px;font-weight:700;letter-spacing:-.01em;color:var(--dsw-alias-state-business-primary)}',
        '.goq-bbox-amount{flex:0 0 auto;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
        '.goq-bbox.warn .goq-metric-num{color:var(--dsw-alias-state-warn-primary)}',
        '.goq-bbox.over .goq-metric-num{color:var(--dsw-alias-state-error-primary)}',
        // 轨道底色不能用 bg-layer-*：浅色主题下 bg-layer-1/2/3 全都是 #fff，
        // 与卡片背景同色，「已用」段会完全隐形（实测踩过）。border-l3 是
        // 12% 黑 / 深色模式 16% 白，两种模式下都能看清灰槽。
        '.goq-bbox-bar{height:8px;border-radius:999px;background:var(--dsw-alias-border-l3);overflow:hidden}',
        '.goq-bbox-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .4s ease}',
        '.goq-bbox.warn .goq-bbox-fill{background:var(--dsw-alias-state-warn-primary)}',
        '.goq-bbox.over .goq-bbox-fill{background:var(--dsw-alias-state-error-primary)}',
        '.goq-bbox-line{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.goq-bbox-reset{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}',
        '.goq-bbox-reset-at{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
        '.goq-bbox-days{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-weight:600}',
        '.goq-bbox-rail{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.goq-bbox.rail{width:40px;min-width:0;padding:6px;align-items:center;justify-content:center;border-radius:10px}'
      ].join('')
      document.head.appendChild(tag)
    }

    /** 短标签：主档与其余两档共用。 */
    const WINDOW_LABELS = { rolling: '5H', weekly: '周', monthly: '月' }
    /** 固定展示顺序。 */
    const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']
    /** 主档：卡片大号数字与进度条展示哪一个窗口。 */
    const MAIN_WINDOW = 'monthly'
    /** 轮询间隔（毫秒）。 */
    const POLL_MS = 60_000

    /** 取窗口的百分比（0–100），非法返回 null。 */
    function pctOf(win) {
      if (win === null || typeof win !== 'object' || typeof win.percent !== 'number') return null
      if (!Number.isFinite(win.percent)) return null
      return Math.max(0, Math.min(100, win.percent))
    }

    /**
     * 百分比文本，**「剩余」口径**：100 − 已用，整数取整且与已用互补。
     * 卡片上三档指标、收起态方块与悬停提示统一用它（卡片只展示剩余，不展示已用）。
     */
    function leftPctText(win) {
      const pct = pctOf(win)
      return pct === null ? '—' : 100 - Math.round(pct) + '%'
    }

    /** 美元金额：两位小数以内，去掉无意义的尾零（20.40 → $20.4，60.00 → $60）。 */
    function usd(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return '$' + (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
    }

    /**
     * 账户余额金额：固定两位小数（钱要精确，不能像额度那样去尾零），带币种符号。
     * 官方只返回 CNY 或 USD 两种；未知币种原样前缀，避免把数字伪装成美元。
     */
    function money(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? currency + ' ' : ''
      return symbol + value.toFixed(2)
    }

    // ── DeepSeek 峰谷计费时段 ─────────────────────────────────────────────
    // 官方口径（https://api-docs.deepseek.com/quick_start/pricing/ 脚注 2）：
    //   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
    //    excluding Chinese public holidays. All other hours are off-peak,
    //    including weekends and Chinese public holidays in full."
    // 换成北京时间就是：工作日 09:00–12:00 与 14:00–18:00 为高峰（全价），
    // 其余一律低谷（半价）。判定全部换算到 UTC+8 再做，与本机时区无关。
    //
    // 2026 年放假日（国务院办公厅 国办发明电〔2025〕7 号），全天低谷。
    // 只列放假日，不含调休上班日：官方原文写的是 "including weekends ... in full"，
    // 所以 1/4、2/14、2/28、5/9、9/20、10/10 这些被调休成工作日的周末仍按低谷算。
    // 次年新通知发布后这张表要跟着更新（过期不会报错，只会把新假期误判成高峰）。
    // >>> peak-schedule
    const CN_HOLIDAY_RANGES_2026 = [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节
      ['2026-04-04', '2026-04-06'], // 清明
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午
      ['2026-09-25', '2026-09-27'], // 中秋
      ['2026-10-01', '2026-10-07'] // 国庆
    ]

    /** 平移 8 小时：之后一律用 getUTC* 读到的就是「北京时间」。 */
    function toBeijing(date) {
      return new Date(date.getTime() + 8 * 3_600_000)
    }

    /** 北京日期键 `YYYY-MM-DD`（字典序即时间序）。 */
    function beijingDayKey(date) {
      const d = toBeijing(date)
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
    }

    /** 是否落在 2026 年法定节假日（全天低谷）里。 */
    function isHoliday(date) {
      const key = beijingDayKey(date)
      return CN_HOLIDAY_RANGES_2026.some((range) => key >= range[0] && key <= range[1])
    }

    /**
     * 此刻是否 DeepSeek 高峰时段（全价）。周末与法定节假日全天低谷。
     * 纯函数：只依赖传入的 Date，浏览器半边与测试共用同一份实现。
     */
    function isPeakNow(date) {
      const d = toBeijing(date)
      const day = d.getUTCDay()
      if (day === 0 || day === 6) return false
      if (isHoliday(date)) return false
      const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
    }
    // <<< peak-schedule

    /** 分级：≥100 超限、≥80 警告。 */
    function levelOf(pct) {
      if (pct === null) return ''
      if (pct >= 100) return ' over'
      if (pct >= 80) return ' warn'
      return ''
    }

    /**
     * 距重置的剩余时长，用于在主档重置时间后面补一个相对读数。
     * 向下取整到小时，只给「天 + 小时」两档；不足 1 小时单独说；已到期或
     * 无法解析返回 null，调用方据此不渲染这一截。
     */
    function remainingText(resetsAt) {
      const at = new Date(resetsAt).getTime()
      if (!Number.isFinite(at)) return null
      const gap = at - Date.now()
      if (gap <= 0) return null
      const totalHours = Math.floor(gap / 3_600_000)
      if (totalHours === 0) return '（剩余不足 1 小时）'
      const days = Math.floor(totalHours / 24)
      const hours = totalHours % 24
      if (days === 0) return '（剩余 ' + hours + ' 小时）'
      return '（剩余 ' + days + ' 天 ' + hours + ' 小时）'
    }

    /** 额度表来源说明（同步 / 缓存 / 内置兜底），只出现在悬停提示里。 */
    function tableNote(data) {
      if (data === null) return ''
      const at =
        typeof data.tableSyncedAt === 'number' && data.tableSyncedAt > 0
          ? new Date(data.tableSyncedAt).toLocaleString()
          : ''
      if (data.tableSource === 'synced') return at === '' ? ' · 额度表已同步' : ' · 额度表同步于 ' + at
      if (data.tableSource === 'cache') {
        return at === '' ? ' · 额度表来自本地缓存' : ' · 额度表来自本地缓存（' + at + '）'
      }
      return ' · 额度表为内置兜底值'
    }

    /**
     * 卡片。props 由 sidebar.footer.action 槽位注入：
     *   wide 侧边栏是否展开（收起时显示紧凑百分比方块）
     */
    function Card(props) {
      const [data, setData] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      // 峰谷只看挂钟，不看数据：30 秒自增一次，跨过 09:00 / 12:00 / 14:00 / 18:00
      // 与午夜换日时换边框色（额度轮询是 60 秒，单靠它最坏会晚一分钟才换色）。
      const [now, setNow] = react.useState(() => Date.now())

      const load = react.useCallback((force) => {
        if (force) setBusy(true)
        fetch('/dsh-go-quota/usage' + (force ? '?refresh=1' : ''), { cache: 'no-store' })
          .then((res) => res.json().catch(() => null).then((json) => ({ res, json })))
          .then(({ res, json }) => {
            if (json !== null && json !== undefined && json.error === undefined && res.ok) {
              setData(json)
              setError(null)
            } else {
              setError(String((json && json.error) || 'HTTP ' + res.status))
              setData(null)
            }
          })
          .catch((err) => {
            setError(String((err && err.message) || err))
            setData(null)
          })
          .finally(() => {
            if (force) setBusy(false)
          })
      }, [])

      react.useEffect(() => {
        load(false)
        const timer = window.setInterval(() => load(false), POLL_MS)
        return () => window.clearInterval(timer)
      }, [load])

      react.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000)
        return () => window.clearInterval(timer)
      }, [])

      const usage = data !== null && typeof data.usage === 'object' && data.usage !== null ? data.usage : null
      const limits =
        data !== null && data.limits !== null && typeof data.limits === 'object' ? data.limits : null
      const unlimited = data !== null && data.unlimited === true
      const model = data !== null && typeof data.model === 'string' ? data.model : null
      const main = usage === null ? null : usage[MAIN_WINDOW]
      const pct = pctOf(main)
      const level = levelOf(pct)
      // 边框色只由峰谷决定（与额度告警解耦）。
      const peak = isPeakNow(new Date(now))
      // 只有 host 按模型精确命中额度表时才认这个金额。
      const limitKnown = data !== null && data.limitSource === 'model'
      const monthlyLimit =
        limitKnown && limits !== null && typeof limits.monthly === 'number' ? limits.monthly : null

      // 月度剩余额度（美元）= 月上限 × 剩余百分比；只用于悬停提示，不再占左侧位置。
      const monthlyRemaining =
        monthlyLimit === null || pct === null ? null : (monthlyLimit * (100 - pct)) / 100

      const detail =
        monthlyLimit === null || pct === null || monthlyRemaining === null
          ? ''
          : '（剩余 ' +
            usd(monthlyRemaining) +
            ' · 已用 ' +
            usd(monthlyLimit - monthlyRemaining) +
            ' / ' +
            usd(monthlyLimit) +
            '）'

      // DeepSeek 官方 API 账户余额：来自 host 的 /user/balance，与 Go 订阅额度无关。
      // 拿不到（没配 DEEPSEEK_API_KEY、网络失败）时保持 null，左侧留空不显示占位符。
      const deepseek =
        data !== null && data.deepseek !== null && typeof data.deepseek === 'object'
          ? data.deepseek
          : null
      const balanceText = deepseek === null ? null : money(deepseek.total, deepseek.currency)
      const balanceDetail =
        deepseek === null || balanceText === null || (deepseek.granted === 0 && deepseek.toppedUp === 0)
          ? ''
          : '（赠送 ' + money(deepseek.granted, deepseek.currency) + ' / 充值 ' + money(deepseek.toppedUp, deepseek.currency) + '）'
      const caveat =
        !limitKnown && !unlimited
          ? model === null
            ? '（读不到当前模型配置，未给出总额度）'
            : '（本插件只同步 DeepSeek 的额度，未给出总额度）'
          : ''

      const tip =
        'OpenCode Go' +
        (model === null ? '' : ' · ' + model) +
        ' · 月 剩余 ' +
        leftPctText(main) +
        detail +
        caveat +
        // 余额来自另一个账号体系，单独成句，避免和 Go 额度混读。
        (balanceText === null ? '' : ' · DeepSeek 余额 ' + balanceText + balanceDetail) +
        tableNote(data) +
        '（点击刷新）'

      // 侧边栏收起：只留一个百分比方块。
      if (props.wide !== true) {
        return h(
          'div',
          {
            className: 'goq-bbox rail' + level + (peak ? ' peak' : ''),
            title: error !== null ? 'OpenCode Go：' + error : tip
          },
          h('div', { className: 'goq-bbox-rail goq-num' }, leftPctText(main))
        )
      }

      // 三档剩余额度：`5H 11% 周 18% 月 60%`，统一「剩余」口径 + 品牌蓝，组间靠 CSS gap 分开。
      const metricNodes = []
      WINDOW_ORDER.forEach((key) => {
        metricNodes.push(
          h(
            'span',
            { className: 'goq-metric', key: 'metric-' + key },
            h('span', { className: 'goq-metric-label' }, WINDOW_LABELS[key] + ' '),
            h('span', { className: 'goq-metric-num' }, leftPctText(usage === null ? null : usage[key]))
          )
        )
      })

      const children = [
        h(
          'div',
          { className: 'goq-bbox-head', key: 'head' },
          // 左侧：DeepSeek 官方账户余额；右侧：三档指标 + 月上限。
          h(
            'span',
            { className: 'goq-bbox-balance goq-num' },
            balanceText === null ? '' : balanceText
          ),
          h(
            'span',
            { className: 'goq-bbox-right' },
            error === null ? h('span', { className: 'goq-bbox-metrics goq-num' }, metricNodes) : null,
            unlimited || monthlyLimit === null
              ? null
              : h('span', { className: 'goq-bbox-amount' }, '(' + usd(monthlyLimit) + ')')
          )
        ),
        h(
          'div',
          { className: 'goq-bbox-bar', key: 'bar' },
          // 左灰右蓝：轨道底色即「已用」，蓝色填充靠右表示「剩余」。
          h('div', {
            className: 'goq-bbox-fill',
            style: { width: (pct === null ? 0 : 100 - pct) + '%', marginLeft: 'auto' }
          })
        )
      ]

      if (error !== null) {
        // 失败时给一行低调的灰字说明，不占用进度条位置也不上红色。
        children.push(h('div', { className: 'goq-bbox-line', key: 'err', title: error }, error))
      } else {
        if (main !== null && typeof main.resetsAt === 'string' && main.resetsAt.length > 0) {
          // 日期后面紧跟相对读数；侧栏太窄时只截断日期那一截，剩余时长始终完整。
          // 只给到「日」：带时分秒时这一行放不下，会在窄侧栏里被省略号吃掉尾巴。
          const remaining = remainingText(main.resetsAt)
          children.push(
            h(
              'div',
              { className: 'goq-bbox-line goq-bbox-reset', key: 'reset' },
              h(
                'span',
                { className: 'goq-bbox-reset-at' },
                '重置: ' + new Date(main.resetsAt).toLocaleDateString()
              ),
              remaining === null ? null : h('span', { className: 'goq-bbox-days' }, remaining)
            )
          )
        }
      }

      return h(
        'div',
        {
          className: 'goq-bbox clickable' + level + (peak ? ' peak' : '') + (busy ? ' busy' : ''),
          role: 'button',
          tabIndex: 0,
          title: tip,
          onClick: () => load(true),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              load(true)
            }
          }
        },
        children
      )
    }

    /** 需要的宿主能力：槽位注册。 */
    const inject = ['slots']

    function apply(ctx) {
      const register = () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-go-quota',
            order: 0,
            label: 'OpenCode Go'
          },
          Card
        )
      if (typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('sidebar.footer.action', register)
      } else {
        ctx.effect(register, 'dsh-go-quota: widget registration')
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
