# dsh-go-quota

DeepSeek Harness 插件：**只在侧边栏底部显示 OpenCode Go 订阅额度 + DeepSeek 官方账户余额**。

```
¥110.00 5H 98% 周 86% 月 60% ($100)
░░░░░░░░░░░█████████████████
重置: 2026/11/11（剩余 11 天 6 小时）
```

- 第一行从左到右：**DeepSeek 官方账户余额**（`api.deepseek.com` 预付 + 赠送，带币种符号）、三档**剩余**百分比（滚动 5 小时 / 周 / 月）、月度**总额度**（Go 订阅）
- 左边是**另一个账号体系**的余额，右边是 Go 订阅额度，两者互不影响：余额查不到时左侧留空，额度照常显示
- 三档百分比统一**剩余**口径（100 − 已用）并统一用品牌蓝；标签留淡、金额再淡一档；三档之间不再用 `·` 分隔，靠间距分组
- 进度条只表示**月**档：左灰右蓝，灰色段 = 已用，蓝色段（靠右）= 剩余
- 最后一行是主档的重置**日期**（不带时分秒，否则窄侧栏里会被省略号吃掉尾巴），后面紧跟相对读数（`剩余 X 天 Y 小时`；不足 1 小时显示「剩余不足 1 小时」，已到期则不显示），随 60 秒轮询一起更新
- 侧边栏收起时缩成一个百分比方块（月的剩余百分比）；点击卡片手动刷新（60 秒自动轮询一次）
- 用量 ≥80% 变警告色、≥100% 变错误色（**百分比与进度条**一起变；边框已专用于下面的峰谷指示，不再参与额度告警）
- 卡片**边框颜色指示 DeepSeek 峰谷计费时段**：低谷品牌蓝、高峰红。官方口径是 UTC 周一至周五 01:00–04:00 与 06:00–10:00 为高峰、其余全部低谷（含整个周末与中国法定节假日），换算成北京时间即**工作日 09:00–12:00 与 14:00–18:00 为高峰**。判定按 UTC+8 做，与本机时区无关；30 秒自增一次，跨边界即换色
  - 2026 年法定节假日表（国办发明电〔2025〕7 号）内置在 `lib/client.js` 的 `CN_HOLIDAY_RANGES_2026`，**次年新通知发布后要跟着更新**；过期不报错，只是把新假期误判成高峰
  - 被调休成工作日的周末（2026 年：1/4、2/14、2/28、5/9、9/20、10/10）按官方原文的 *including weekends … in full* 仍算低谷
- 鼠标悬停可看到模型名、月度剩余额度与已用金额、DeepSeek 余额明细（赠送 / 充值），以及**额度表是刚同步的、来自缓存、还是内置兜底**（悬停提示文案不含峰谷状态，峰谷只由边框颜色表达）

没有别的：没有成本统计、没有价格表、没有设置页、没有聊天命令。

## 安装

```sh
dsh plugin --profile web add link:/Users/rkd/dsh/dsh-go-quota
```

装完**重启 `dsh web`**并刷新页面。

卸载：

```sh
dsh plugin --profile web remove dsh-go-quota
```

## 额度表是怎么来的（每小时自动同步）

**官方接口给不出金额**：`/zen/go/v1/usage` 只返回三档 `percent` + `resetsAt`；`/zen/go/v1/models`
只返回模型 id。所以「总额度」只有一个来源 —— 官方文档页
<https://opencode.ai/v2/docs/console/go/> 里那张 **Monthly limit** 表格。旧地址
`/docs/go` 会 302 到它，插件直接用新地址，少一跳。

插件会**每小时抓一次那个页面**，但**只解析 DeepSeek 系列**（其余模型、含标为 Unlimited 的
限时免费模型，一律丢弃），得到 `model id → 月上限（美元）` 的表并缓存到本地：

```
$DSH_HOME/storages/dsh-go-quota/limits.json
```

生效层次（任何一层拿不到就往下退，永不中断）：

| 优先级 | 来源 | 何时使用 |
|---|---|---|
| 1 | **刚同步的官方页面** | 每小时的定时抓取成功时；`tableSource: "synced"` |
| 2 | **本地缓存** | 启动时先用缓存（不依赖网络）；抓取失败也继续用；`tableSource: "cache"` |
| 3 | **内置兜底表** | 从没同步过、也没有缓存时；`tableSource: "builtin"` |

官方窗口规则（文档原文）：*5-hour — 20% of the monthly limit; weekly — 50%; monthly — 100%*。
所以本机（`deepseek-v4.1-flash`，$100 档）显示的上限是 **$100**，对应 5H $20 / 周 $50。

模型名归一化：文档里写 `DeepSeek V4.1 Flash (Off-Peak)`，解析时会去掉括号后缀并转成小写连字符
形式，得到 `deepseek-v4.1-flash`，与 DSH 配置里的 model id 对齐。表里同时有
`deepseek-v4.1-flash`（$100）与 `deepseek-v4-pro`（$15），按 id 精确区分。
非 DeepSeek 模型即使出现在页面上也**不会**进入额度表，切到那些模型时卡片只显示百分比。

> 页面改版导致解析失败时，插件会**静默保留上一份可用数据**（缓存或内置表），不会报错也不会崩。
> 想手动确认同步状态，看卡片悬停提示里的「额度表同步于 …」。
> 权威金额始终以 [OpenCode 控制台](https://opencode.ai/auth) 为准。

### 精确匹配与兜底

- 只有**按模型 id 命中额度表**时，右上角才显示 `60% ($100)` 这样的括号（剩余百分比 + 总额度，`limitSource: "model"`）
- 模型读不到、或不是 DeepSeek 系列时，**只显示百分比**，悬停才说明原因 —— 不拿兜底值冒充
- 当前模型从 DSH 读取，三重路径：新版 `configEditor` → 旧版 `settings.get()` → 直接解析
  `cordis.patch.yml` 文本

## 它从哪里拿数据

浏览器半边只访问同源路由 `/dsh-go-quota/usage`，由 host 半边向官方端点取数：

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <API Key>
User-Agent: Mozilla/5.0 …        # 不带浏览器 UA 会被 Cloudflare 以 error 1010 拦掉
```

响应形如：

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 8,  "resetsAt": "…" },
  "weekly":  { "status": "ok", "percent": 4,  "resetsAt": "…" },
  "monthly": { "status": "ok", "percent": 34, "resetsAt": "2026-10-11T01:05:18Z" }
} }
```

host 半边把它归一化成 `{ fetchedAt, model, limitSource, tableSource, tableSyncedAt, unlimited, limits, usage, deepseek }`，
查询结果做 60 秒进程内缓存（多个标签页共用一次上游请求）。
**API Key 始终留在宿主进程，浏览器永远看不到。**

### DeepSeek 官方账户余额

左侧那个金额来自**另一个账号体系**（`api.deepseek.com`），与上面的 Go 订阅额度无关：

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```

响应形如（`total_balance` / `granted_balance` / `topped_up_balance` 都是**字符串**，这里转成数字再给前端）：

```json
{ "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00",
      "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
```

- Key 的解析顺序：DSH 凭据库里的 `DEEPSEEK_API_KEY`（与 `dsh-llm-deepseek-api-key` 的默认
  `apiKeyEnv` 一致）→ 同名环境变量 → `llm-pi-ai` 里 baseURL 指向 `*.deepseek.com` 的
  provider 自身的 `apiKeyEnv`
- **没有配这个 Key、或请求失败（非 2xx / 超时 / 结构异常）时，`deepseek` 为 `null`**，左侧留空，
  Go 额度与进度条照常显示 —— 两个账号体系不能互相拖累
- 余额与额度并行查询（`Promise.all`），不会因为多一次请求而变慢

## API Key 从哪来（零配置）

按以下顺序解析，第一个命中的生效 —— 与 `dsh-cost-meter` 的 `resolveGoKey` 完全一致，
所以换用本插件后无需重新配置：

1. DSH 凭据库里的 **`OPENCODE_GO_API_KEY`**（同名环境变量亦可）
2. `llm-pi-ai.providers.<route>.apiKeyEnv` —— 前提是该路由的 `baseURL` 指向官方
   `https://opencode.ai/zen/go` 或 `…/zen/go/v1`
3. **`OPENCODE_API_KEY`**（旧名兼容）
4. opencode CLI 的登录态文件 `~/.local/share/opencode/auth.json`（或 `$XDG_CONFIG_HOME/opencode/auth.json`、
   `~/.config/opencode/auth.json`）里的 `opencode-go.key` —— 也就是 `opencode login` 留下的凭据

401/403 会被当作「没有有效订阅或 Key 无效」，界面显示一行灰色说明。

## 结构

```
dsh-go-quota/
├── package.json        # 声明 dsh.bundle.patch 与 dsh.client.platform = "web"
├── cordis.patch.yml    # bundle 层：插入 go-quota 这一行
├── lib/
│   ├── index.js        # host 半边：凭据解析 + 额度查询 + 金额换算 + 同源路由 + 定时同步
│   ├── limits-sync.js  # 官方文档页抓取 / 解析 / 本地缓存
│   └── client.js       # 浏览器半边：sidebar.footer.action 槽位里的那张卡
└── test/
    └── smoke.mjs       # 冒烟：mock 上游与宿主，端到端跑路由、解析、缓存
```

浏览器半边是手写的 `window.__ModuleLoader__.load({ id, factory })` 工厂 bundle，
只 `require()` shell 模块表里的 `react`；改动 `lib/client.js` 后刷新页面即可（走 client HMR），
改动 `lib/index.js` / `lib/limits-sync.js` 需要重启 `dsh web`。

跑测试：

```sh
node test/smoke.mjs    # 不需要真实网关，DSH_HOME 会被指到临时目录
```

## 与 dsh-cost-meter 的关系

本插件是从「只保留 Go 额度卡片」这个需求出发重写的精简替代品，卡片外观与原来的 Go 卡一致，
额外在右上角括号里标出该窗口的总额度，并让额度表随时间自动跟上官方。
两者同时启用会在侧边栏出现两张 Go 卡 —— 二选一。
