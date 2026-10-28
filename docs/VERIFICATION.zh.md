# 验证记录

[English](VERIFICATION.md) | 中文

[← 返回 README](../README.zh.md)

为 `dsh-token-ledger` 实际验证了什么、在什么环境上验证、怎么验证。本文件的目的
是可被核对，并且把自身的缺口也写出来。

## 环境

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-09-13（0.8.0；下面 0.7.x 与 0.6.0 的运行发生在 2026-09-12） |
| 操作系统 | Windows (win32) |
| Node.js | v24.18.0 |
| DSH | 0.1.2-rc.1（打包好的桌面版构建） |
| 受测宿主 profile | 隔离 `DSH_HOME` 下一个一次性的 `web` profile |

## 测试套件

`npm run test:single-process` —— **14 个文件里 288 个测试，全部通过**，无需安装任何
依赖，也不需要网络。（这与 `npm test` 是同一套测试；Node 默认的逐文件进程隔离在这台
机器上无法 `spawn`，所以这里用的是不带隔离的运行器。）在挂载期间，这套测试会替换掉
`globalThis.fetch`，于是价格刷新是针对一个完全没有外网路径的宿主来跑的，任何测试都
不可能连到真正的网络：

| 文件 | 测试数 | 覆盖内容 |
| --- | --- | --- |
| `test/ledger.test.mjs` | 28 | 计数规则、替换、fork 切分、幂等性、快照往返、CSV——包括其字节上的字节序标记（BOM）——高峰与空闲时段的拆分与用量交叉表、工作区捕获、DSH 给会话起的会话标题（最后一个生效，空白与非字符串标题被忽略，重启后依然保留），以及在 25 份生成的日志上与一份独立的朴素实现做的性质式交叉核对 |
| `test/cli.test.mjs` | 13 | 在合成的 home 上跑 rebuild/audit/rebuild-write/export、待定与陈旧的分类、篡改检测、退出码、写了一半的日志 |
| `test/plugin.test.mjs` | 21 | 宿主半边对着一份 Cordis 替身：回填、fork 与 resume、实时折叠、重启游标、从会话头而不是从带序事件里读出的工作目录、`/tokens` 的各种变体、降级服务、配置覆盖、三条路由及其销毁、启动时的刷新、`rates: false`，以及在没有网络的情况下把缓存的目录提供给后来的宿主 |
| `test/session-log.test.mjs` | 7 | Zstandard 帧遍历：精确往返、多帧文件、拒绝截断、写了一半的 JSONL 行 |
| `test/overview.test.mjs` | 10 | 纯粹的概览投影：区间、本地日边界、缓存命中率、模型行 |
| `test/bill.test.mjs` | 27 | 纯粹的账单：按名字与版本做模型关联，以及那些拒绝关联的情况（版本不同就是不同的模型；两家厂商同价时拒绝关联而不是猜一家）、针对单条价格行做分时段计价、按提供商／模型／工作区／会话分组，会话标为 `workspace/title`、模型按它记录下来的路由标注，每个区间都包含 `today` 与「全部」，换算以及没有汇率时的美元回落，没有价格的模型被列出而不是按 0 计费，套餐在覆盖到的那些天上摊分，套餐替换掉它所覆盖的用量，套餐被摊分到各行以便每个分组的各行之和等于它自己的合计，尚未开始的套餐让其厂商的用量仍然计费，手写的配置项若不是对象就跳过而不是致命错误，CSV 的形状**以及它的字节序标记**，以及一个中文会话名逐字节地留在文件里 |
| `test/route.test.mjs` | 41 | 三条路由全部：回环与来源防护、不支持的方法、账单的分分组与区间列表及其回落（单次请求一个分区，导出则是二十个）、CSV 下载及其文件名、概览的分时段费用以及没有价格时的降级；对写入半边还有 JSON 内容类型的要求、畸形与超大的请求体、被拒绝的补丁，以及 500 分支 |
| `test/rates.test.mjs` | 27 | 纯粹的价格模块：按 token 到每百万的换算、两个来源各自「每厂商取最新」的挑选、精选厂商上限及其顺序、别名排除、按厂商的提供商 id 映射、自有模型排在托管模型之前的排序、零价格标记、汇率解析、手填的值优先于抓取来的值、孤立覆盖项、采纳／保留的判定，以及输入校验器 |
| `test/rates-service.test.mjs` | 13 | 抓取、缓存、定时与来源选择：一次失败的刷新保留上一次的好值、覆盖项在重启后依然存在、一个非法补丁不改变任何东西、定时器会跑也会停、每一种传输故障都被报告而不是抛出、每个来源解析各自的载荷、未知来源回落，以及一个五兆的正文被视为真实响应而不是攻击 |
| `test/client.test.mjs` | 56 | 通过一份替身加载器跑浏览器半边：模块包装、注册约定、格式化、热力档位、序列切片、三个视图的渲染逻辑、概览按区间与按天的预计花费（包括没有价格时的短横线）、账单的四个堆叠分区各带一个时间段、它的导出链接与逐分区失败、币种换算与美元回落、逐厂商的来源标注、高峰与空闲时段行、打包的厂商标识、让模型名保持可见的列几何、零价格标记、每个编辑器在它的按钮被点击时发出的补丁，以及每个视图只在被打开时才去读它那条路由 |
| `test/vendor-prices.test.mjs` | 9 | 厂商定价页适配器：HTML 辅助函数、写成 `0.15元` 的价格与写成 `输入：0.5元` 的价格、DeepSeek 合并的标签单元格与两个时段列、有时写着「Limited-time Free」的 Z.ai 存储列、腾讯嵌在标签里的价格，以及每个时段一行 |
| `test/client-render.test.mjs` | 21 | 同一批视图在真 React 下运行，断言实际产出的标记、账单的四张卡片、二十个时段页签、导出 URL 与金额列，以及这个库没有提出任何异议 |
| `test/providers.test.mjs` | 7 | 提供商的显示名：从插件作用域的 settings 文件里读出的 `providers:` 块、引号与注释以及 `~` 转义的名字、多个块被合并、绝不从模型列表里猜一个名字、文件缺失或不可读时退化为提供商 id，以及让一次轮询不必重读该文件的缓存窗口 |
| `test/slot-registration.test.mjs` | 8 | 喂给 DSH 自带的真槽位注册表的注册 |

依赖 React 的那些文件在 `react` 与 `react-dom` 解析不到时会带着明确原因跳过，因此
`npm test` 在全新克隆、无网络的情况下也能跑。上面这些计数是在 React 可解析的情况下
取得的，所以没有任何一个跳过。

## 来自真实会话日志的证据

这些运行用的是真实的 DSH home，里面存着 139 个会话。它们是 README 里那些计数结论的
依据；这些数字可以用 CLI 在任何有内容的 home 上复现。

### 帧遍历覆盖每一个字节

全部 139 份日志解码出 **228,868 帧**与 **344,203 个事件**，帧边界覆盖了
**每个文件 100% 的字节**——没有靠魔数扫描，也没有悄悄丢掉尾巴。

### `totalTokens` 是四个桶之和

在 **15,778** 份提供方的用量报告（消息、usage chunk 与压缩摘要）里，提供方自己的
`totalTokens` 字段与 `input + output + cacheRead + cacheWrite` **一次也没有**不同。
这就是账本自己推导总量而不采信那个字段的原因，也是各桶与总量不可能彼此漂移的原因。

`cacheWriteTokens` 在 **零** 份报告里非零：DeepSeek 不填这个桶，所以那里是 0 属于预期，
不是缺陷。

### fork 与 resume

「切掉 fork 的前缀，绝不切掉 resume 的前缀」这条规则是从数据里推出来的，不是假设的：

| 结论 | 数量 |
| --- | --- |
| 首条记录是 `session` 头的日志 | 139 / 139 |
| 带有 `session/end-seed` 标记的日志 | 72 |
| ……其中带 `parentSession` 的（即 fork） | 29 |
| ……其中没有父会话的（即 resume） | 43 |
| 标记前的用量指纹是父会话历史子集的 fork | 24，另有 5 个其前缀完全不含用量（空真） |
| 前缀在同一文件里稍后再次出现的 resume | 43 个里有 1 个（与两次大小相同的调用之间指纹撞车相符） |

只切掉那 29 个 fork，会把这个 home 的总量从 **1,284,550,137** 变成 **1,204,627,868**
token——避免了 **79,922,269 token** 的重复计数。

### 一次真实的审计

```
$ dsh-token-ledger rebuild --write
scanned 139 session log(s), 344203 events, 29 fork(s), 0 unreadable
wrote <DSH_HOME>/token-ledger/ledger.json

$ dsh-token-ledger audit
scanned 139 session log(s), 344203 events, 29 fork(s), 0 unreadable

  stored      6901 calls  1205685663 tokens
  recomputed  6901 calls  1205685663 tokens

  audit: match — the stored ledger equals a fresh fold of the raw logs
```

在正在产出这份文档的那个会话还在不断生成内容时运行 `audit`，得到的是预期中那个不报警
的结果，而不是一次误报：

```
  audit: match — 1 session(s) advanced after the ledger was written
         (1 calls, 5100 tokens not yet flushed)
```

## Profile 安装（隔离）

用一次性的 `DSH_HOME` 验证，因此没有碰到任何真实的 profile：

```
$ DSH_HOME=<tmp>/home <dsh-desktop-cli> plugin --profile web add <repo path>
dsh: initialized profile web at <tmp>/home/profiles/web
+ @chenmiao8563/dsh-token-ledger link:C:/.../plugins/dsh-token-ledger
Done in 317ms using pnpm v11.8.0
```

profile 的清单是由 CLI 自己的 reconciler 更新的，它只会添加那些包声明了
`dsh.bundle.patch` 的依赖：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@chenmiao8563/dsh-token-ledger"
] } }
```

而组合里确实有这一行，带 scope 的标识符被解析成一个 Cordis 条目名：

```
$ DSH_HOME=<tmp>/home <dsh-desktop-cli> --profile web --dump-config
# == @chenmiao8563/dsh-token-ledger
- id: token-ledger
  name: '@chenmiao8563/dsh-token-ledger'
```

安装过程既没有构建步骤，也没有 `allowBuilds` 条目——这正是这个包的核心可安装性主张。

### 为什么这个包带 scope

无 scope 的名字 `dsh-token-ledger` 在发布时被拒绝：

```
403 Forbidden - PUT https://registry.npmjs.org/dsh-token-ledger - Package name
too similar to existing package dsh-tokenledger
```

npm 在比较之前会把分隔符归一化掉，因此 `dsh-token-ledger` 与已有的 `dsh-tokenledger`
撞上了。注意，对该名字做一次 registry 查询返回的是 `E404`，那只能证明这个名字尚未被
占用——它并不能预示这道相似度闸门，因为那道闸门是在发布时运行的。上面已经端到端地重新
验证了带 scope 的名字；CLI 命令名与 Cordis 条目 id 都没有变。

### 从 npm registry 安装（隔离）

已发布的产物是按一个陌生人会采用的方式安装的，装进一次性的 `DSH_HOME`：

```
$ DSH_HOME=<tmp>/home <dsh-desktop-cli> plugin --profile web add @chenmiao8563/dsh-token-ledger
dsh: initialized profile web at <tmp>/home/profiles/web
Progress: resolved 1, reused 0, downloaded 0, added 0
dependencies:
+ @chenmiao8563/dsh-token-ledger ^0.1.0
Packages: +1
Progress: resolved 1, reused 0, downloaded 1, added 1, done
Done in 2.7s using pnpm v11.8.0
```

锁文件记录了一次真实的 registry 解析，带完整性哈希与声明的引擎范围：

```
'@chenmiao8563/dsh-token-ledger@0.1.0':
  resolution: {integrity: sha512-yApGruS1Hcyq0oIOq8t6Y8gAJFefAoiHLzDsvPsecND6+DIj878x8YtQ5Ggz+PVYL9yTvaPAgIVcOhyBNvPGnw==}
  engines: {node: '>=22.15.0'}
  hasBin: true
```

reconciler 把它加进了 bundle 栈，而 `pnpm-workspace.yaml` 没有被动过——
**不需要任何 `allowBuilds` 条目**，这正是本文档要核查的可安装性主张：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@chenmiao8563/dsh-token-ledger"
] } }
```

在新 scope 下首次发布之后，packument 本身大约花了两分钟才变得可读——在那段时间里
`dist-tags` 与 tarball 已经上线，而 `GET /@chenmiao8563%2Fdsh-token-ledger` 仍然返回
404。那是 registry 的传播延迟，不是一次失败的发布。

### 价格从哪里来，以及为什么是这个来源

引出这一节的问题是问对了的：费率页的第一版把数字取自 OpenRouter 的模型列表，而那是
**网关**的价目表，不是任何厂商自己的。核查这个说法，才改变了默认值。

**没有任何厂商通过 API 暴露价格。** 直接探测的结果是：DeepSeek 的 `/models` 在没有 key
时回答 `401`，Anthropic 的 `/v1/models` 回答 `403`，而这些端点有文档记载的形状就是模型
id、里面没有任何钱。价格只存在于厂商的定价页上。找到的唯一一个真正公开的价格 API 是
微软的 Azure Retail Prices（`prices.azure.com`，HTTP 200，但对所试的过滤器返回
`Count: 0`），而它只覆盖 Azure。

**评估了两个按厂商组织的机器可读来源。** LiteLLM 的
`model_prices_and_context_window.json` 从这台机器连不上（`raw.githubusercontent.com`
超时）。[models.dev](https://models.dev) 用 4.6 MB 应答：**213 个提供商与 7,751 个模型，其中
7,314 个带 `cost` 块**，含 `input`/`output`，通常还有 `cache_read`（4,765）和／或
`cache_write`（1,542），全部是数值，没有负数，每个有价格的模型都带 `release_date`。它
覆盖该页面发布的那些厂商，用的是它自己的 id——Qwen 是 `alibaba`，Mistral 是 `mistral`，
xAI 是 `xai`，Z.ai 是 `zai`，Meta 是 `meta`，Amazon 是 `amazon-bedrock`，字节跳动是
`volcengine`。

**与厂商自己的页面核对过。** 只有当这些数字出现在厂商公布它们的地方，这份数据集才配得上
被称为「厂商自己的价目」：

| 厂商页面 | 结果 |
| --- | --- |
| `api-docs.deepseek.com/quick_start/pricing` | 它的 4 个模型里有 3 个完全对得上，包括 `deepseek-v4-flash` 的 `0.15 / 0.6 / cacheRead 0.003`；`deepseek-v4-pro` 的 `0.435 / 0.87` **不在**该页面上 |
| `docs.z.ai/guides/overview/pricing` | 16 个里有 11 个对得上，包括 `glm-5.2 = 1.4 / 4.4` 与 `glm-5.3 = 1.4 / 4.4` |
| `mistral.ai/pricing` | 从这台机器连不上 |

正是 Z.ai 这一行定下了默认值。对 `glm-5.2` 与 `glm-5.3-flash`，OpenRouter 报的是
`0.6 / 2` 与 `0.15 / 0.5`，而 models.dev 与 Z.ai 自己的页面都说 `1.4 / 4.4` 与
`0.075 / 0.25`。在两个来源都描述到的 27 个模型上，**21 个一致、6 个不同**——而在不同的
地方，厂商的页面站在按厂商数据集这一边。OpenRouter 上 `moonshotai/kimi-k3` 的价格
`2.302729 / 11.550195` 就是线索：这种数字是跨路由的混合价，不是价目。

**仍未验证的**是：每一行都是最新的。Mistral 在这里无法核对，Z.ai 有几行与它的页面对不上，
而且这份数据集由社区维护。这就是页面会写明来源、把抓取时间留在屏幕上、并允许任何数字被
手动改写覆盖的原因。

### 改为直接读厂商自己的页面

随后对这十二家厂商逐一探测，看有没有一个程序能读的页面（带上浏览器的请求头），因为
要求就是从厂商自己那里取数字：

| 厂商 | 结果 |
| --- | --- |
| **DeepSeek** | 可读：`api-docs.deepseek.com/zh-cn/quick_start/pricing/`——一张以人民币计价的表格，标签单元格是合并的，每行有高峰与空闲两列，计费时段以文字写明 |
| **Z.ai** | 可读：`docs.z.ai/guides/overview/pricing`——`Model / Input / Cached Input / Cached Input Storage / Output`，以美元计价 |
| **Tencent** | 可读：`cloud.tencent.com/document/product/1729/97731`——`产品名 / 刊例价（每 百万 tokens）`，价格写在标签里（`输入：0.5元`） |
| OpenAI | `platform.openai.com/docs/pricing` 对非浏览器客户端回答 **403**，而 `openai.com/api/pricing/` 是一个营销页面，里面唯一的价格是 ChatGPT 席位套餐（每月 $20/$100） |
| Anthropic | `docs.anthropic.com/.../pricing` 是客户端渲染的——434 KB，标记里没有价格，也没有表格。那张表格确实存在于 `docs.claude.com/llms-full.txt` 里，但它有 34 MB，这就是它至今没有实现的原因 |
| Google | `ai.google.dev/gemini-api/docs/pricing` 从这台机器访问超时 |
| xAI | `docs.x.ai/docs/models` 与 `x.ai/api` 从这台机器访问超时 |
| Qwen | `help.aliyun.com/zh/model-studio/models` 有 20 张表格但没有价格；定价一定在另一个路径上 |
| Kimi | `platform.moonshot.cn/docs/pricing/chat` 用脚本载荷渲染它的价格 |
| MiniMax | `platform.minimaxi.com/document/price` 只有语音合成的套餐价格 |
| 小米、字节跳动 | 都是 JS 外壳；火山引擎的文档页返回 11 KB 且没有内容 |

因此十二家里有三家是实时读的——**DeepSeek、Z.ai 与腾讯**——另外九家沿用数据集的数字，
页面上的每个厂商分组都会标明自己属于哪一种。只有当某个厂商的页面能被解析、且解析结果
能与页面本身核对时，才会为它加一个适配器；框架在 `lib/vendor-prices.js` 里，所以剩下
九家是逐厂商的活儿，而不是一次重新设计。

**直接读 DeepSeek 定下了什么。** 它的页面把 `deepseek-flash` 定价为空闲时段每百万
`0.02 / 1 / 4` 元、高峰时段 `0.04 / 2 / 8`（缓存命中输入／缓存未命中输入／输出），把
`deepseek-v4-pro` 定价为 `0.15 / 4.5 / 13.5` 与 `0.3 / 9 / 27`。数据集给这个 flash
模型记的是 `0.15 / 0.6` 美元，外加 `0.003` 的缓存读——那是**空闲时段**的数字换算而来。
一个在高峰时段查价的人被告知的是真实价格的一半。这就是「这些数字不准」这个疑问的具体
答案，也是两个时段现在分成两行的原因。

**对本文档早先一处说法的更正。** 第一轮得出的结论是「两个来源不一致时，厂商的页面站在
按厂商数据集这一边」。就它所依据的两个模型中的一个而言，那是错的：Z.ai 的页面说
`GLM-5.3-Flash` 是 `0.15 / 0.50`，那是**网关**的数字，而数据集记的是 `0.075 / 0.25`——
一半。`GLM-5.2` 确实支持这个说法（页面与数据集都是 `1.4 / 4.4`，而网关是 `0.6 / 2`）。
诚实的总结是：每个来源对一部分模型是对的，这正是应该读厂商自己页面的理由，而不是该
信任任何一个聚合站。

### 运行中的宿主里的厂商页面

三个适配器就位之后，一次真实运行的报告是：

```
outcome: ok (37 models, 12 of 12 vendors, modelsdev; 3 vendor page(s) read)
deepseek [vendor, CNY] — 北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）
   DeepSeek-V4.1-Flash   peak     in 2    out 8     cacheRead 0.04
   DeepSeek-V4.1-Flash   offPeak  in 1    out 4     cacheRead 0.02
   DeepSeek-V4-Pro-0813  peak     in 9    out 27    cacheRead 0.3
   DeepSeek-V4-Pro-0813  offPeak  in 4.5  out 13.5  cacheRead 0.15
z-ai [vendor, USD]     GLM-5.3-Flash 0.15 / 0.5 · GLM-5.3 1.4 / 4.4
tencent [vendor, CNY]  Hunyuan-a13b 输入 0.5 元 输出 2 元
```

腾讯还因为第二个原因而重要：它在按厂商数据集里**根本没有条目**，所以它能出现完全是因为
它自己的定价页。

## 给下一个来验证这个的人的话

在这台机器上，`dsh` 的 shell shim 把 `DSH_HOME` 写死了，所以在调用 `dsh` 之前导出
`DSH_HOME` **隔离不了任何东西**——它改的是真实的 home。要隔离，就直接调用打包的 CLI：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = '<tmp>\home'
& '<install>\DSH Desktop.exe' --expose-internals '<install>\resources\app.asar\lib\desktop-cli.js' plugin --profile web add <path>
```

## 真实宿主挂载

0.1.0 版本被装进一个真实的 desktop profile，重启宿主，宿主日志记下了这次挂载：

```
20:24:52 [I] [token-ledger] started a new ledger at <DSH_HOME>\token-ledger\ledger.json
20:24:52 [E] [token-ledger] TypeError: command "tokens" input hint must be a string
20:25:00 [I] [token-ledger] backfilled 139 stored session(s), 0 unreadable; total 790455336 tokens over 4518 calls
```

这一步之所以值得做，正是因为它失败了。它暴露的两个缺陷，从那套 49 个测试的套件里都
触达不到；两个都在 0.1.1 里修好了，并配了回归测试：

| 缺陷 | 证据 | 成因 |
| --- | --- | --- |
| `/tokens` 从未注册 | 上面的那个 `TypeError`，以及输入 `/tokens` 时没有任何 `command/*` 事件 | `input` 被当作裸字符串传了进去；而注册表要求 `{ hint: string }`。这次抛出还中止了 `apply()` 的其余部分，于是 dispose 时刷写的效果从未被安装 |
| 回填少算了 fork | 同一批日志上，4,518 次调用／790,455,336 token，对比 CLI 的 6,901／1,205,685,663 | 继承来的边界被当成原始下标来用，但行式日志每条记录里塞了好几个逻辑事件，于是声明的计数越过了数组，把那些会话整个跳过了 |

诊断来自账本自己的产物，而不是猜测：上面那行宿主日志，以及把账本记录到的 65 个会话与
那 72 份带 `session/end-seed` 标记的日志、那 29 份声明了父会话的日志做的一次交叉列表。
两个集合之外的 61 个会话，原来都是只有四条记录、完全没有用量的日志，这就是它们正确地
没有条目的原因。

## 修复之后的真实宿主挂载（0.2.0）

0.2.0 被发布、装进同一个 desktop profile 并重启宿主。于是三件此前只能靠论证的事情
被观察到了：

**账本会重建自己。** 版本 2 的这次提升做了它存在的意义所在的事——0.1.0 的文件被丢弃
而不是被采信，折叠重新开始：

```
20:25:00  backfilled 139 stored session(s), 0 unreadable; total  790455336 tokens over 4518 calls   (0.1.0)
20:35:29  started a new ledger at <DSH_HOME>\token-ledger\ledger.json
20:35:36  backfilled 139 stored session(s), 0 unreadable; total 1263174796 tokens over 7069 calls   (0.2.0)
```

**命令注册成功并作出应答。** 在一次真实对话里输入了 `/tokens`，会话日志把它记了下来：

```
command/run  {"name":"tokens","args":" ","source":{"kind":"user"}}
command/done {"kind":"success","text":"Token ledger\n\n  calls  7,069\n  input (uncached)  244,727,714\n  cache read  1,012,…"}
```

**设置页路由注册成功。** 0.2.0 专为此目的新增的那行日志确实在：

```
21:50:42 [I] [token-ledger] settings page route ready at /api/token-ledger/summary
```

### 跨实现的独立审计

这个项目里能拿到的最强检查：由**运行中的插件**写出的账本——由 Cordis 持久化服务加上
实时会话事件折叠而成——被 **CLI** 审计，而 CLI 与那条路径不共享任何代码，它自己解析原始
的 zstd 分帧日志。

```
$ dsh-token-ledger audit
scanned 139 session log(s), 357988 events, 29 fork(s), 0 unreadable

  stored      7328 calls  1417951113 tokens
  recomputed  7328 calls  1417951113 tokens

  audit: match — the stored ledger equals a fresh fold of the raw logs
```

在 139 个会话上，来自两份独立实现，逐 token 相同。这了结了本文档早期草稿列为未验证的
那个回填一致性问题，也让 0.1.1 的边界修复从「只是说得通」变成「可信」：同样的比较放在
0.1.0 上会显示出那个差距。

## 浏览器半边（0.2.0）

这里查了什么、没查什么，因为两者的差别很大。

**由测试检查的。** `lib/overview.js` 与 `lib/route.js` 是纯粹或接近纯粹的，直接被测试：
区间边界、缓存命中率的算术、补齐空缺后的序列、回环与来源防护、方法处理，以及出错即
500 的路径。浏览器半边通过一份替身模块加载器加上一份替身 React 载入，这会走遍模块包装、
注册约定与整棵渲染树——格式化、热力档位、周柱切片、视图切换，以及空数据、畸形数据与
陈旧数据的路径。`scripts/verify-package.mjs` 另外还会在以下情况下让构建失败：浏览器半边
需要加载器没有提供的东西、它的模块 id 不再与包名匹配、它不再能作为经典脚本编译，或者
声明的客户端依赖落在客户端半边命名空间之外。

**由阅读 DSH 自己的源码检查的，不是靠推断。** 浏览器半边所依赖的那些约定，是从随包
发布的 bundle 里读出来的，而不是从第三方插件那儿抄来的：

| 约定 | 从哪里读的 | 结果 |
| --- | --- | --- |
| `settings.section` 的注册形状 | DSH 自带的那些分区——`dsh-client-ui-settings-models`（order 10）、`-settings-plugins`（15）与 `-ui-agent-preset`（20）——以及 `-settings-general` 里通过 `renderSlot("settings.section", …, { only: active })` 渲染它们的外壳 | 字段集合完全相同；`locale` 是可选的，由 `-settings-models` 省略它得到证明；侧边栏的行来自 `id`、`order` 与 `label`，这三样这个插件都提供了 |
| 客户端模块格式 | 每一个 `@deepseek-ai/dsh-client-*/lib/client.js` | 逐字节相同的包装：`window.__ModuleLoader__.load({ id, factory })`，配 `var module = { exports: {} }` 以及 `exports.apply`/`exports.inject` |
| 工厂函数何时运行 | `dsh-client-modules` 的模块文档 | 只有注册发生在脚本执行时；函数体的副作用（含样式）要到实体化时才运行——这就是样式表要放在 `apply()` 内部安装的原因 |
| `dsh.client` 声明 | `dsh-client-modules/lib/index.js` 里的 `parseDshClient` | `platform` 必须是字符串，且只有 `web` 会被加载；`inject` 与 `external` 都是可选的字符串数组；决定模块图顺序的是 `external`——不是 `inject` |
| `dsh.client.inject` **装的是什么** | DSH 自带的五份 `dsh.client` 声明，其中两份非空：`dsh-client-locale` 与 `dsh-client-ui-settings-general` | **是包／条目 id，不是服务名。** 模块自己导出的 `inject` 是另一份服务清单。这个插件列出的是它所用服务所属的两个包，与该约定一致；空清单也是合法的（`dsh-client-connection` 用了一个） |
| `external` 装的是什么 | `dsh-client-modules/lib/client.js` 里遍历模块图的代码，它在解析每个条目前先让它过一遍 `stripClientSuffix` | 是给*其他行*用的模块说明符。这个插件只依赖 `react`，而它由加载器提供、不属于任何一行，所以它什么都没声明 |
| `exports["./client"]` 如何定位 | `dsh-client-modules/lib/index.js` 里的 `clientExportOf` | 一个普通字符串，或一个带字符串 `default` 的对象；其它情况都会抛错。这里用的是普通字符串，并由 `verify-package.mjs` 钉住 |
| **带 scope 的**包 id 能否存活 | `dsh-client-modules/lib/client.js` 里的 `stripClientSuffix` | 它只去掉结尾的 `/client`，所以 `@zhz8888/dsh-token-ledger` 原样通过。DSH 自己的客户端包也带 scope，因此传输层本来就承载含 `/` 的 id |

那次阅读纠正了浏览器半边第一稿里的两个真实错误，两个都会表现为静默失败而不是报错：

- `@deepseek-ai/dsh-client-ui-slots` 被列为客户端依赖。它是一个纯粹的核心库（它的清单只
  导出 `.`，并且没有声明 `dsh.client`），所以它永远不是客户端模块的一行。
- 设置外壳包被写成了 `-ui-settings`，而它持有的是命名空间作用域的服务；分区槽位是由
  `-ui-settings-general` 声明并渲染的。

**在真 React 下检查的。** `test/client-render.test.mjs` 用 React 18.3.1——与 DSH 打包的是
同一个大版本——通过 `react-dom/server` 渲染展示组件，并断言实际产出的标记：区间页签及其
激活状态、每个区间的总计／命中率／调用次数、选定年区间时今日那一块依然在、年度热力图及其
按星期补齐的留白与月份坐标轴、月与周的柱状图及其固定柱宽与抽稀的标签、从七级色阶中取值的
有界热力档位、组合出来的模型柱及其颜色图例，以及加载、错误、陈旧与空状态。它还会捕获
`console.error` 与 `console.warn`，并且**只要 React 抱怨过就判失败**——这正是抓得住非法
DOM 属性或 hook 顺序违规的地方，而这类缺陷手写的 `createElement` 会默默接受。

React 只是 devDependency，所以它会在 CI 与 `prepublishOnly` 下运行。没装它时，这个
文件会带着明确原因跳过而不是失败，这让 `npm test` 在全新克隆、无网络的情况下也能跑。

**对着真槽位注册表检查的。** `test/slot-registration.test.mjs` 把注册 `apply` 实际构造的
东西喂给 `@deepseek-ai/dsh-client-ui-slots`——就是 DSH 自己运行的那个注册表，以
devDependency 的形式钉在 `0.1.2-rc.1`，正是这个 DSH 所打包的版本（npm 上的 `latest` 是
更旧的 `0.0.1-rc.1`，所以这里钉版本而不是用区间）。它断言注册表接受这个条目、
`resolveSlotLabel` 把标签 thunk 解析成一个非空字符串——解析不出来的标签会渲染成一行空白
侧边栏——条目的 id 不与 DSH 自带的三个分区冲突、重复的 id 会被拒绝、dispose 会让条目退场、
以及注册到未声明的槽位会被拒绝，这也正是这个插件用 `slots.inject` 而不是盲目注册的原因。

**由人在真实浏览器里检查的。** 浏览器半边是这个环境唯一驱动不了的部分，也是最后剩下的
那件事。现在它被观察到了：设置分区在侧边栏里渲染、区间页签与日历切换都在，而促成 0.3.0
的那批版式反馈——年度热力图上想要月份标签、更深的色阶、更细的柱、以及组合出来的模型柱——
只可能来自盯着页面看。这里没有任何检查覆盖渲染的*观感*：间距、对齐与配色相对于设置界面
其余部分如何，是用眼睛核对的，不是用断言核对的。

**没有由机器检查的。** 客户端模块加载器接受该文件，以及组件挂载进 DOM。这里没有任何
代码执行 `window.__ModuleLoader__`，也没有把真正的 reconciler 跑进一个文档：模块的形状
被断言与 DSH 自带的每一个 bundle 一致，注册由真注册表校验，标记在真 React 下被断言——
但加载器与挂载是靠观察覆盖的，而不是靠一个能无人值守运行的测试。

## 费率（0.4.0）

有三件事必须为真，并且分别检查：来源能被解析、路由能把它们发出去、写入路径能存下交给
它的东西。

### 真实来源，由插件自己的代码解析

在 Windows 上对着真实端点运行，走的是 `createRatesService`——而不是它的重新实现：

```
refresh outcome: {"catalogue":"ok (45 models, 15 of 49 vendors)","fx":"ok (1 USD = 6.725314 CNY)"}
catalogue.totalAvailable: 445
catalogue.vendorCount: 15
catalogue.modelCount: 45
fx.available: true rate: 6.725314 USD->CNY
first vendors: openai (gpt-6-astra in=10 out=50), anthropic (claude-fable-5.1 in=10 out=50),
               google, deepseek, qwen, x-ai, meta-llama, mistralai, z-ai, moonshotai, …
```

响应里的 445 个条目被筛成**49 个厂商中的 15 个、共 45 行**，每个厂商最多三个，载荷
11 KB——比加厂商上限之前那个视图携带的 123 行、30 KB 少。顺序是精选顺序，不是按模型
数量。两个端点都无需 key 即可应答。

这次探测找出的是那个负价格哨兵。实时列表里有五个条目带着
`pricing: {prompt: "-1", completion: "-1"}`（`openrouter/auto*` 这些路由器没有单一
价格）。负数不是价格，绝不能渲染成 `¥0`；这些行被丢弃了，而在那次改动之后
**已发布的行里没有任何一行是缺价格的行**。有 46 行没有缓存读价格，这就是表格渲染
一个短横线而不是凭空编一个的原因。

另一次探测列出了实时目录实际用到的每一个厂商 id，因为精选列表必须按来源的写法来写：
`meta-llama` 与 `x-ai` 是真 id，而 `meta` 与 `xai` 不是；`~openai` 是别名，必须排除
而不是算作一个厂商。

### 两条路由走真实 socket

宿主半边挂在一个真实的 `node:http` 服务器后面（不是 DSH 的 web 服务器）并接上真实
网络，然后用 `fetch` 驱动：

```
registered paths: [ '/api/token-ledger/summary', '/api/token-ledger/rates' ]
GET summary -> 200 bytes 1350
GET rates   -> 200 bytes 30555
  catalogue: true 123 rows / 56 vendors of 445
  fx: 6.725314 USD -> CNY ageMs 6033 overridden false
  refreshIntervalMs: 1800000
cache-control: no-store content-type: application/json; charset=utf-8
POST rates -> 200 {"models":1,"fx":true}
  row now: openai/gpt-6-astra {"input":1.25,"output":9.5,...} source: manual
  fx now: 7.01 overridden: true source: manual
POST orphan -> 200   (a hand-entered model no fetch described, published as its own group)
fx after reset: 6.725314 overridden: false
POST form content-type -> 415
POST malformed json    -> 400
POST bad value         -> 400
POST oversized body    -> 413 {"error":"body exceeds 262144 bytes"}
PUT rates              -> 405
```

宿主记下了：

```
[token-ledger] settings page routes ready at %s and %s  /api/token-ledger/summary  /api/token-ledger/rates
[token-ledger] rates refresh (%s): catalogue %s, fx %s   startup  ok (123 models, 56 vendors)  ok (1 USD = 6.725314 CNY)
```

正是这项检查发现了超大请求体的行为：处理器过去在应答时会销毁请求，于是调用方看到的是
连接被重置，而不是它刚刚写下的那个 413。销毁请求才是 bug；现在流被留着不动，状态码
如期到达：`413 {"error":"body exceeds 262144 bytes"}`。

### 手工检查

同一次探测驱动了离线路径：在强制刷新失败的情况下，缓存的目录与汇率仍然被发出、并附带
一个 `ageMs`，`lastRefresh` 报告 `failed (…)`，而手动录入的分组是被发布而不是被丢弃。
`test/plugin.test.mjs` 里那个隔离的双挂载测试，在完全没有网络的第二个宿主上钉住了同一个
故事。

## 真实宿主挂载，0.4.0——真正的 DSH web 服务器

上一节留下的那个缺口（「一个真实的 `node:http` 服务器，而不是 DSH 的 web 服务器」）现在
补上了。0.4.0 被挂载在一个真实的 DSH 宿主里，它自带 web 服务器，跑在隔离的 home 上，
用自己独立的端口：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = '<tmp>\host-check\home'
& '<install>\DSH Desktop.exe' --expose-internals '<install>\resources\app.asar\lib\desktop-cli.js' `
    plugin --profile web add <repo path>
& '<install>\DSH Desktop.exe' --expose-internals '<install>\resources\app.asar\lib\desktop-cli.js' `
    --profile web --no-open --port 43977
```

安装时打印出 `+ @chenmiao8563/dsh-token-ledger link:<repo path>`，它组合出的 profile 是
`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与这个包。随后两条路由都
**通过 DSH 自己的 web 服务器**作出应答：

```
GET /api/token-ledger/summary -> 200, 1350 bytes, plugin "token-ledger"
GET /api/token-ledger/rates   -> 200, 30558 bytes
  catalogue: available, 123 rows / 56 vendors of 445
  fx: 6.725314 USD -> CNY
  refreshIntervalMs: 1800000
  first row: openai / openai/gpt-6-astra
POST /api/token-ledger/rates  -> 200, {"models":1,"fx":true}
  row source: manual, input: 1.25, output stayed: 50   (only the typed price moved)
  fx: 7.01 overridden=true
GET  /api/token-ledger/rates  (Origin: https://evil.example) -> 403
```

宿主把两个状态文件都写进了隔离的 home——`token-ledger/ledger.json`（295 字节）与
`token-ledger/rates.json`（53,777 字节）——这正是价格刷新确实在宿主里跑过、而不仅仅是在
测试下跑过的证据。

**浏览器半边也被提供了。** 从设置页读出启动清单，拿到该条目的 bundle 路径，宿主把它发了
出去：

```
GET /plugins/??@chenmiao8563/dsh-token-ledger/client.js&rev=…  -> 200, 72106 bytes
  contains tabRates, ratesTitle, api/token-ledger/rates, manualFormTitle, __ModuleLoader__
```

所以浏览器加载的产物就是 0.4.0 的客户端半边。没有被覆盖的仍然是从前那件事：没有人看过
渲染出来的页面。

随后按端口停掉那个隔离宿主，并确认这台机器上真实的 DSH 实例（另一个进程，跑在自己的
端口上）仍在监听。

## 账单，0.5.0——真账本、真价格、真宿主

分别检查了三件事：真实账本上的算术、真实 DSH web 服务器内部的路由，以及导出文件与响应
是否一致。

### 真实账本算出什么

账本从这台机器存的 140 个会话重建成了版本 4 的形状
（`dsh-token-ledger rebuild --ledger … --write`）：**1,781,106,633 token**，分布在
**8,283 次调用**上，其中 **796,057,786** 记录在 DeepSeek 的高峰时段内，**985,048,847**
在时段外。随后账单是对着一份刚抓取的实时目录（汇率 **6.725314**）算出来的：

```
by vendor          calls        input       output     hit          cost
deepseek           5,478  213,824,029    4,111,258   83.8%    CNY 444.31
qwen               1,924   19,451,225    2,199,720   94.0%     CNY 63.98
z-ai                 881   13,773,217    1,152,944   89.3%     CNY 53.55

by workspace
<workspace>/torchv-master      2,218  165,436,946  1,231,026  48.6%  CNY 331.55
…
```

账本里出现的每个模型都定到了价：**零行未定价**，一共七次关联，其中六次是完全对上的。
日志里的那条 DeepSeek 路由（`deepseek-official/deepseek-v4-flash`）不与任何价格 id
直接匹配，是按名字关联到 `deepseek/deepseek-flash` 的——这正是账单会列出来、而不是
藏起来的那类关联。

### 真实 DSH 宿主内部的路由

一个隔离的 `DSH_HOME`、一次性的 `web` profile、拷进去的真实账本，以及通过该 profile 的
补丁层配置的一个套餐（`- id: token-ledger` / `config.subscriptions`）：

```
GET  /api/token-ledger/summary                                -> 200, 1350 bytes
GET  /api/token-ledger/bill                                   -> 200, application/json
GET  /api/token-ledger/bill?by=workspace&range=all            -> 200
GET  /api/token-ledger/bill?by=session&range=all&format=csv   -> 200, text/csv
     content-disposition: attachment; filename="token-bill-session-2026-09-12.csv"
GET  /api/token-ledger/bill?by=nonsense&range=nonsense        -> 200, by=vendor, month
GET  /api/token-ledger/bill  (Origin: https://evil.example)   -> 403
POST /api/token-ledger/bill                                   -> 405
```

那个套餐被从宿主配置里取到，并按账单覆盖到的天数摊分计费——9 月 1 至 12 日的 ¥199 是
**79.60**，而 DeepSeek 那一行读作 79.60，单看用量它本来会是 444.31：

```
by subscription        label                calls        cost     usageCost
  (pay as you go)      [null]               2,805      117.54        117.54
  DeepSeek 包月         [plan]               5,478       79.60        444.31
  totals: usageCost 561.85 · subscriptionCost 79.60 · totalCost 197.14
```

197.14 就是 79.60 + 117.54：套餐不会被加到它所覆盖的用量上。CSV 以
`TOTAL,8283,…,197.1369,CNY` 结尾，与 JSON 的 `totals.totalCost` 是同一个数到小数点后
四位——这正是导出要具备的性质。

那个宿主提供的浏览器半边也被读回来看：启动页的 bundle 列表里点着
`@chenmiao8563/dsh-token-ledger/client.js`，而宿主提供的 3.86 MB bundle 里含有
`tabBill`、`billTitle`、`api/token-ledger/bill`、`billExportCsv`、`billCoveredUsage` 与
`tl-bill-total`。所以浏览器加载的正是带着账单页签的那个产物。

之后按端口停掉那个隔离宿主，并确认这台机器上真实的 DSH 实例在自己的端口上仍在监听。

## 堆叠账单与概览的费用，0.6.0

复用了同一个宿主——隔离的 `DSH_HOME`、一次性的 `web` profile、补丁层里一个 ¥199 的
DeepSeek 套餐——账本从这台机器存的 140 个会话重建到版本 5（1,915,709,366 token、
8,783 次调用、58 个带着 DSH 所给标题的会话）。

### 每个分组的各行之和等于该分组的合计

这正是套餐摊分要具备的性质，是对着实时账本而不是对着 fixture 检查的：

```
grouping   rows   sum(rows)   section total   plan allocated
workspace  8      169.784     169.7840        79.6
session    50     169.784     169.7840        79.6
model      4      169.784     169.7840        79.6
vendor     3      169.784     169.7840        79.6
```

套餐是 79.6（账单覆盖的 9 月那 12 天里的 ¥199），它按所覆盖用量的比例摊到各行上——
供应商分区把它的全部金额记在那一行 DeepSeek 上，工作区分区则把它摊到用过 DeepSeek 的
各个工作区上：

```
vendor / month            cost     usageCost   planCost
  deepseek                79.60    96.45       79.60
  qwen                    63.98    63.98       0
  z-ai                    26.20    26.20       0

workspace / month         cost     planCost    usageCost
  <workspace>/DB_ontology      71.47   42.29   80.43
  <workspace>/knowledge-base   40.85    5.84   42.09
  <workspace>/dsh-deploy       22.64    8.30   24.40
```

### 标签是 DSH 自己起的名字

会话行是带 DSH 会话标题的 `workspace/title`，模型行是 `vendor/model`：

```
<workspace>/dsh-deploy/<session title>       · session-61bd1519-… · <workspace>/dsh-deploy
<workspace>/DB_ontology/<session title>     · session-d818967e-… · <workspace>/DB_ontology
deepseek/DeepSeek-V4.1-Flash                  cost 79.60
qwen/Qwen3.8 Flash                            cost 59.31
```

### 导出

`?by=workspace,session,model,vendor&range=month,year,week,today,all&format=csv`
回答 200、`text/csv`、**36,007 字节**、`attachment; filename="token-bill-all-2026-09-12.csv"`，
共 325 行：一个表头，20 个分区各一行明细与一行合计，并且没有跨重叠时段的总计。单分区导出
（`?by=vendor&range=today`）按它装的内容命名——`token-bill-vendor-today-2026-09-12.csv`——
它的合计与同一分区的 JSON `totals.totalCost` 相符。

### 概览的估算

```
GET /api/token-ledger/summary
  cost.priced: true, currency: CNY, rate: 6.725314
  today  cost   6.63   (usage 13.99, plan 6.63)
  week   cost 107.52   (usage 101.96, plan 46.43)
  month  cost 169.78   (usage 186.64, plan 79.60)
  year   cost 197.14   (usage 566.30, plan 79.60)
```

本月的 169.78 与账单本月分区报出的是同一个数，这正是用账单自己的算术给概览定价、而不是
另起一套估算器的意义所在。概览的 `today` 与账单的 `today` 区间走的是同一条定价代码
路径。

那个宿主提供的浏览器半边也被读回来看：3.87 MB 的 bundle 里含有 `BillSection`、
`BILL_SECTION_ORDER`、`rangeToday`、`billExportAllCsv`、`billPlanShare` 与 `estCost`。

## 报告的缺陷，0.7.0——对着真实账本读

有人一边看着真实账单，一边针对 0.6.0 的页面报了四个问题。四个都先复现再修复；各自的
证据如下。

### 工作区分组塌成了 `(unknown)`

这台机器上的实时账本只记录到 **75 个会话中有 1 个**带工作目录，所以工作区分组里有一行
`(unknown)` 和一行真实值。原因不在账单里：DSH 的 `sessionPersistence` 把*带序的*事件
与会话头分开返回，而那行头——带 `cwd` 的那一行——不在事件数组里。只读事件就找不到
`cwd`，而 CLI 对同一批日志做 `rebuild` 却每一个都找到了，因为 CLI 解码的是原始文件，
而在那里头*就是*第一条记录。

为了确认这些形状，存储实现是从打包好的应用里读出来的（`dsh-session-persistence-jsonl`）：
`list()` 解析那行头并把它作为 `header` 返回，而 `toHeaderLine`/`fromHeaderLine` 显示
`cwd` 就在它上面。现在宿主把那行头的 `cwd` 传进折叠里，依次尝试 `stored.meta`、list 的
header、`stored.session` 以及对象本身，并把事件扫描保留为兜底。

通过**一个真实 DSH 宿主**折叠这台机器的真实日志来验证（一个隔离的 home，里面放着 140
份会话日志的副本，自有端口、自有 web 服务器）：

```
sessions 140, usage rows 148, tokens 2,011,822,094, calls 9,028
sessions with cwd     140 / 140      (was 1 / 75 on the live ledger)
sessions with title    58 / 140
<workspace>/knowledge-base 56 · <workspace>/wiki-templates 17 · <workspace>/torchv-master 14 · …
```

### 模型列把两个端点并成了一行

按价目表的名字分组时，`deepseek-official/deepseek-v4-flash` 与 `bos/deepseek-v4-flash`
都显示成 `deepseek/DeepSeek-V4.1-Flash`——五个端点只出了三行。模型维度现在以账本记录
的路由为键，同一次真实数据的运行显示出每个端点一行，每行仍按 DeepSeek 的价目计费：

```
model / month
  qwen-plan/qwen3.8-flash               provider qwen-plan          priceVendor qwen      ¥59.31
  deepseek-official/deepseek-v4-flash   provider deepseek-official  priceVendor deepseek  ¥49.69
  bos/deepseek-v4-flash                 provider bos                priceVendor deepseek  ¥49.20
  zai/glm-5.3-flash                     provider zai                priceVendor z-ai      ¥26.20
  qwen-plan/qwen3.8-max                 provider qwen-plan          priceVendor qwen       ¥4.68
```

### 供应商分区是按价目表分组，而不是按提供商

同一次运行，改成按请求里点名的提供商分组，显示名从 harness 的 settings 文件里读出
（`settings.yaml` → `llm-pi-ai.providers.bos.displayName`）：

```
vendor / month
  qwen-plan          provider qwen-plan          priceVendor qwen      ¥63.98
  deepseek-official  provider deepseek-official  priceVendor deepseek  ¥49.69
  BOS-API            provider bos                priceVendor deepseek  ¥49.20
  zai                provider zai                priceVendor z-ai      ¥26.20
  TOTAL                                                               ¥189.08
```

`BOS-API` 是模型设置页为 `bos` 端点显示的名字；它是从那个文件里**读**出来的（从不
写入），价格来源就写在它旁边。同一次运行里，每个分组的各行都精确加总到它自己的合计
（189.08），工作区也包括在内，而页面的四个分区全部由同一个宿主提供：

```
workspace 8 rows · session 50 rows · model 5 rows · vendor 4 rows, all TOTAL 189.08
GET /api/token-ledger/bill?by=…&range=month,year,week,today,all&format=csv
  -> 200, 36,701 bytes, 333 lines, 20 section totals, attachment "token-bill-all-2026-09-12.csv"
```

### 组合键点出了一个从未被画出的桶

「按模型」这个键原样打印出字符串 `cacheWriteTokens`，没有翻译，而柱状图里根本没有这个
桶——DeepSeek 不公布缓存写价格，所以从来没有什么写过缓存。现在这个桶被翻译了，而载荷里
任何地方都没有 token 的桶会被排除在柱状图与图例之外。渲染测试双向断言了这一点：没有写过
缓存时是三个键，载荷里有缓存写 token 时是四个（第四个有名有色）。

### 导出的 CSV 在 Excel 里是乱码，0.7.1

报告的症状是：名为 `.dsh/编写统计dsh token用量插件` 的会话被显示成
`.dsh/缂栧啓缁熻dsh token鐢ㄩ噺鎻掍欢`。诊断靠的是算术而不是意见：`编写` 在 UTF-8 里
是 `e7 bc 96 e5 86 99`，而这六个字节按 GBK 读出来就是 `缂栧啓`，所以文件一直是 UTF-8，
是读取方在猜。它之所以在猜，是因为文件没有字节序标记。

改动前后，看的是字节而不是文本（同一个账本、同一份账单，由同一条代码路径写出）：

```
before   first 12 bytes: 64 69 6d 65 6e 73 69 6f 6e 2c 72 61   -> "dimension,ra…"
after    first 12 bytes: ef bb bf 64 69 6d 65 6e 73 69 6f 6e   -> BOM, then the header
```

再经由一个真实宿主——从一个装着真实账本的 DSH web 服务器上通过 HTTP 取回导出，写到
磁盘上并按字节检查：

```
GET /api/token-ledger/bill?by=session,vendor&range=all&format=csv
  -> 9,183 bytes, first six bytes ef bb bf 64 69 6d, text/csv; charset=utf-8
  a row: session,all,torchv-master/在Docker中部署MySQL和Redis,975,37890752,…
    read as UTF-8: torchv-master/在Docker中部署MySQL和Redis
    read as GBK:   torchv-master/鍦―ocker涓儴缃睲ySQL鍜孯edis
```

第二行就是被报告的那个缺陷，用同样的字节复现出来：那个标记正是告诉读取方这两种读法里
哪一种才是本意的东西。CLI 的 `export` 表格出于同样的原因带着同样的标记，而两个写出方
都是按**字节**测试的，因为 `trim()` 会把字符串里的字节序标记去掉，而一个没人看得见的
标记什么也修不好。

### 本地无法验证的是什么，以及为什么

宿主这条路径是拿这台机器会话日志的**一份副本**在一次性的 home 里验证的，而不是对着
真实的 home：两个 DSH 进程折叠同一份账本会在同一个文件上互相踩，而正在运行的那个实例
属于它的用户。起初先试了手工搭的合成 home，很快放弃了——存储层断言日志路径是
`projectKey(cwd)/encodeSegment(id)/session.jsonl.zstd`，而这个编码虽然可以复现（确实
复现了，fixture 随后也通过 CLI 正确折叠），但拷贝真实日志被证明既更省事也更有力。那次
尝试的一个附带发现：启动时若绑定端口失败，什么都不会打印，这花掉了一些时间；一个仍被
先前宿主占着的端口，看起来和一个加载失败的插件一模一样。

## 汇总的会话列表，0.8.0——在真实账本上量出来

这条规则（低于 ¥1 **或** 调用少于 10 次）是把候选规则在这台机器的真实账单上跑一遍选
出来的，而不是凭口味，然后通过一个真实宿主在同一份账本上验证。问题的两半都重要：列表会
缩到多短，以及汇总行吸收了什么。

| 区间 | 会话数 | 显示的行数 | 被汇总 | 它们的金额 | 占账单的比例 |
| ----- | -------- | ---------- | ---------- | ----------- | ----------------- |
| month | 50 | 30 | 21 | ¥7.67 | 4.3% |
| week | 31 | 20 | 12 | ¥6.76 | 6.3% |
| all | 74 | 36 | 39 | ¥7.75 | 3.8% |
| today | 1 | 1 | — | — | —（只有一个会话：列表没有缩短） |

各候选规则会对全时段列表做什么，这就是选择 ¥1/10 的原因：

```
cost < 1 且 calls < 10   → 折叠 14 行（剩 60）  汇总 ¥1.90（0.3%）
cost < 1 或 calls < 10   → 折叠 37 行（剩 37）  汇总 ¥12.83（2.2%）   ← 采用
cost < 5 或 calls < 20   → 折叠 56 行（剩 18）  汇总 ¥60.75（10.6%）  ← 隐藏太多钱
```

被选中这条规则藏起来的最贵一行是 **¥0.95**（29 次调用），因此没有要紧的东西消失；
更宽松的规则会把一份全时段账单里的 ¥60 藏在单独一行后面。

同一次运行里，通过宿主核对了算术：

```
GET /api/token-ledger/bill?by=session&range=all&fold=small  -> 36 rows, fold {count: 39, costBelow: 1, callsBelow: 10, currency: CNY}
GET /api/token-ledger/bill?by=session&range=all             -> 74 rows, fold: null
  totals identical (¥203.87), and the folded rows still sum to it (203.87 == 203.87)
  the summary row: 39 sessions, 734 calls, ¥7.75
GET /api/token-ledger/bill?by=session&range=all&format=csv  -> 76 lines: a header, 74 sessions and a total; no `#small`
```

**未验证的**是：那一行汇总的外观（斜体标签、`汇总` 标记、表格下方的那条说明）。它在标记
层面与真 React 渲染测试里都被断言过，但没有浏览器可看，它所在的几何布局在这里也测不
出来。

## 依赖升级，2026-10-28——在 0.2.1-rc.3 宿主上检查

devDependency 换成了宿主所打包的那个构建；`lib/`、`bin/`、`test/` 下的东西都没动。它是
在什么环境上被检查的：

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-10-28 |
| 操作系统 | Windows (win32) |
| Node.js | v24.15.0 |
| DSH | **0.2.1-rc.3**（打包好的桌面版构建） |
| 受测宿主 profile | 作者自己的 `desktop` profile，不是一次性的那个 |

- **宿主版本是从安装里读出来的，不是假设的。** `app.asar` 里的 `desktop-runtime.json`
  报告 `dshVersion: 0.2.1-rc.3`；它 `sharedPackages` 列表里每一个 `@deepseek-ai/dsh*`
  条目都是 `0.2.1-rc.3`；而那天的 `run.start` 日志行记录着 `"dsh":"0.2.1-rc.3"`。同一
  列表里的 React 条目是 `18.3.1`，这就是 `react`/`react-dom` 被留在那里而不是升到 19 的
  原因。
- **插件确实挂载在那个宿主上，而不只是可安装。** `~/.dsh/logs` 里有
  `[token-ledger] settings page routes ready at /api/token-ledger/...`，而
  `~/.dsh/token-ledger/ledger.json` 正在被写入——5,400 多次调用，在这一节写下的前几分钟
  刚被修改过。
- **用已提交的锁文件跑 `npm ci`** 会装上 `@deepseek-ai/dsh-client-ui-slots` 0.2.1-rc.3、
  `@deepseek-ai/cordis` 4.0.5 与 `@deepseek-ai/cosmokit` 1.8.6，而那三个 `integrity` 值
  重新从 registry 读出来，与锁文件完全一致。
- **`npm run test:single-process`——14 个文件里 297 个测试，全部通过**；**`npm run verify`
  ——81 项检查全部通过。** 注册测试现在跑的是 0.2.1-rc.3 的槽位注册表，而不是
  0.2.0-rc.2 的那个。
- **对着真实 home 跑 CLI：** `summary --home ~/.dsh` 报出了实时账本（运行当时是 5,425
  次调用），所以依赖移动之后，打包出的入口点仍能解析自己的模块。

**本轮未验证的**是：各个界面。没有对设置分区、费率页签或账单做过任何一遍浏览器检查，
上面那些小节里的检查清单也没有在 0.2.1-rc.3 上重跑。为 0.2.1-rc.3 声称的是宿主能挂载
这个插件、并且它仍能产出账本——而不是每个视图都被重新看过一遍。

## 包管理器迁移，2026-10-28——从 npm 到 pnpm

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-10-28 |
| 操作系统 | Windows (win32) |
| Node.js | v24.15.0 |
| pnpm | 11.20.0 |
| DSH | 0.2.1-rc.3（与上一节同一个桌面版构建） |

- **`pnpm-lock.yaml` 取代了 `package-lock.json`**，并且 `package.json` 带着
  `packageManager: pnpm@11.20.0`，这样版本只声明一次。这就是这个生态已经在用的包管理
  器：DSH 用 pnpm 安装插件。
- **`pnpm test`——14 个文件里 297 个测试，全部通过**，以及
  **`pnpm run verify`——81 项检查全部通过。** 这是默认的测试运行器，带着 Node 的
  逐文件进程隔离，而这个环境里的 npm 运行用不了它；因此前面那些条目不得不退回到
  `test:single-process`。
- **装出来的依赖树比 npm 的更小，而这正是重点。** npm 装了九个包：react、react-dom、
  槽位注册表，以及——因为 npm 会自动安装一个*必需* peer——`@deepseek-ai/cordis` 及其
  自己的链条（`cosmokit`、`@standard-schema/spec`）。pnpm 装了六个：react、react-dom、
  槽位注册表，以及 react 自己的三个。cordis 那条链没了，因为槽位注册表把 cordis 声明
  为 peer，而这个仓库里没有任何东西需要它：cordis 由宿主在运行时提供。
- **可选的宿主 peer 不会留在依赖树里，但默认并不会如此。** 用 pnpm 的默认值时它们确实
  会留下来：`autoInstallPeers` 是 `true`，pnpm 把那五个可选的 `@deepseek-ai/dsh-*`
  peer 解析成了 `0.2.0-rc.2` 的真实依赖——第二份 DSH harness，二十来个包，正是这个
  插件要避免的东西。`pnpm-workspace.yaml` 里 `autoInstallPeers` 与
  `dedupePeerDependents` 都是 `false`，依赖树也回到了它该有的样子。
- **没有任何依赖带构建脚本。** pnpm 11 会拦截依赖的构建脚本，遇到一个没人批准过的就让
  安装失败；每一个依赖都在 `allowBuilds` 里被显式列出，而且全都是 `false`，所以这份清单
  是一组拒绝而不是一纸放行。
- **发布路径没有被动。** `npm publish`、`npm pack` 与 `npm view` 仍然是 npm：到达
  registry 的 tarball、以及把它放进去的 OIDC 交换，都是 npm 自己的东西，而这条流水线
  在这一个步骤上已经被咬过一次。

**本轮未验证的**是：GitHub Actions 的那几个 workflow。`pnpm/action-setup@v6`、冻结安装
以及那两个 workflow 文件都已写好，但这里没有任何东西在 runner 上执行过它们；push 之后
的第一次 CI 运行才会真正给出答案。

## 改名，2026-10-28——包迁到了 @zhz8888

这个包当初以 `@chenmiao8563/dsh-token-ledger` 发布，现在已是
`@zhz8888/dsh-token-ledger`；仓库也跟着搬了。上面那些捕获记录里仍然显示旧名字，因为
那就是当时命令打印的东西，改写它们会让这份记录声称一件从未发生过的事。

随名字一起搬走的有这些东西，因为客户端半边是以包名注册的，而组合行正是由它解析出来的：

| 什么 | 原来 | 现在 |
| --- | --- | --- |
| `package.json` 的 `name` | `@chenmiao8563/dsh-token-ledger` | `@zhz8888/dsh-token-ledger` |
| 客户端模块 id（`lib/client.js`） | `@chenmiao8563/dsh-token-ledger` | `@zhz8888/dsh-token-ledger` |
| 组合行（`cordis.patch.yml`） | `@chenmiao8563/dsh-token-ledger` | `@zhz8888/dsh-token-ledger` |

有两样东西是刻意没有搬的：插件的 Cordis 条目 id 仍然是 `token-ledger`——profile 级别的
覆盖就是冲着它去的——而 CLI 命令仍然是 `dsh-token-ledger`。

MIT 版权声明是保留并扩充，而不是被替换——上游的声明留着是因为 MIT 要求如此，fork 的
持有者则被加在旁边。见 [LICENSE](../LICENSE)。

**本轮未验证的**是：改过名的包还没有被发布，也没有从 registry 安装过。这台机器的
profile 里那个插件仍然是从前发布的 `@chenmiao8563/dsh-token-ledger@1.1.2`；安装改名
后的包是另外一步，而且它需要 npm 上存在 `@zhz8888` 这个 scope，并为这个仓库配置好
Trusted Publisher。

## 费率的展开，2026-10-28——一个厂商的全部模型

费率页现在能为每个厂商展开出它的全部模型。这一节记的是**怎么查的**，以及**查到了什么**。

宿主半边用桩传输驱动（不联网），路由是插件自己的那一个，请求打在一个真实的 `node:http`
服务器上——和真宿主做的三件事一样，只是少了网络：

```
GET /api/token-ledger/rates -> 200, 2413 bytes
  openai     models= 5 published=3 expandable=true expandedCount=5
  anthropic  models= 2 published=2 expandable=false expandedCount=2
  payload carries no full list: true

GET /api/token-ledger/rates?vendor=openai -> 200, 1111 bytes
  vendor=openai modelCount=5 publishedCount=3
  openai/gpt-6       in=1.25  out=10     source=fetched
  openai/gpt-5.1     in=1.25  out=10     source=fetched
  openai/gpt-5       in=1.25  out=10     source=fetched
  openai/gpt-4o      in=2.5   out=10     source=fetched
  openai/gpt-4o-mini in=0.15  out=0.6    source=fetched

GET /api/token-ledger/rates?vendor=nope -> 404 {"error":"unknown vendor"}
GET /api/token-ledger/rates?vendor=      -> 200, 2413 bytes (the whole payload, as without the parameter)
GET /api/token-ledger/rates (foreign origin) -> 403 {"error":"forbidden"}

rates.json 6394 bytes; the cache keeps openai's whole list: 5 rows
```

三件事在这里被钉住了：

- **常规载荷不携带完整清单。** 上面那行 `payload carries no full list: true` 是逐个厂商
  检查的：载荷里没有 `allModels`。这不是洁癖——这份载荷同时也是账单与概览计价所用的价目
  目录，每一分钟会被取一次。
- **展开后拿到的是全部模型。** OpenAI 有五个模型，载荷里只发布三个；带厂商的那次请求给出
  五个，而且正是同一批 id 与价格，不是另一份数据。
- **不认识的厂商就说不知道。** `?vendor=nope` 是 404 而不是空列表：一个空列表看上去像是
  「这个厂商没有标价」。空的 `?vendor=` 被当成「没有厂商」，也就是今天那份载荷。

缓存里留着完整清单，所以断网的宿主同样能展开一个厂商。

## 未验证

直说吧，因为一份只列成功项的验证文件没有用：

- **除 `0.1.2-rc.1` 与上面记录的那次 `0.2.1-rc.3` 挂载以外的 DSH 版本。** 所用到的
  API 面在这些版本线上通过检视是稳定的，不是通过测试；`0.2.1-rc.3` 只在上一节所描述
  的范围内被覆盖。
- **非 Windows 平台。** 这些逻辑与平台无关，CI 也会跑 Linux、macOS 与 Windows 的
  作业，但上面所有手工验证都是在 Windows 上做的。
- **提供方的计费约定。** 账本数的是会话日志记录下来的东西。它不声称提供方开的账单是
  多少，而对失败、重试或部分送达的请求，那两者可能并不相同。
- **在真实浏览器里看费率页与账单页。** 三个视图都在真 React 下被断言过，它们的标记也
  被检查过，浏览器拿到的 bundle 也是从一个运行中的宿主上取回来的——但还没有人在屏幕上
  看过 **费率** 或 **账单** 页签。0.3.0 那一轮的反馈来自盯着页面看；费率与账单的工作
  还没经过这一遍。尤其是账单的 CSV 下载，是从响应头与响应体断言出来的，不是靠在浏览器
  里点按钮；而那四个堆叠分区也没有在窄到需要横向滚动的面板里被看过。厂商的展开按钮也
  只过了标记这一关：它能展开出全部模型、也能再收起来，是断言出来的；它在厂商名与计数
  旁边看起来对不对，没有人用眼睛看过。
- **很长的会话标题看起来是什么样。** DSH 自己起的标题有时是首个提示词的截断，有时是
  生成的名字；页面用一个省略号截断，并把完整标题留在悬停提示里——这是一个关于 CSS 的
  说法，不是一个被观察到的事实。
- **套餐摊分的公平性。** 套餐按它所覆盖的用量成本比例摊到各行上，这正是让各行之和等于
  合计的原因——但账本并不知道提供方实际的套餐条款（额度、按模型排除），所以这套摊分
  是一条声明出来的约定，不是提供方自己的账。
- **另一台机器上的提供商显示名。** 这些名字由一个只认识一种形状的扫描器从
  `settings.yaml` 里读出（任意深度的 `providers:` 块、块下的条目、条目上的
  `displayName`）。一个把提供商列表写到别处的 harness 版本会回落到提供商 id，那是
  诚实的，但不是设置页显示的那个名字。
- **会话确实没有 `cwd` 时的工作区分组。** 头里不带工作目录的会话被归为 `(unknown)`；
  对它来说这是诚实的答案，而这也是唯一一个任何修复都无法归因的行。
- **作为像素的厂商标识。** 打进来的十二个标识是按结构检查的：每一个都与厂商的原始文件
  做差异比对——元素顺序相同、路径几何相同、transform、fill-rule、裁剪路径与 class
  相同——所以掉了的 `<g transform>`、丢掉的 CSS class 或缺失的裁剪路径都会让检查失败，
  而这三个标识当初正是这样出错的。这与「用眼睛看它们」不是一回事。这个环境里没有无头
  浏览器可用来光栅化（Electron 在，但打包的 DSH 构建不会运行外部应用，传给它的脚本
  路径会被忽略），因此存在 `tools/logo-preview.html` 供人打开来看——十二个都在页面真实的
  18px 与放大后的尺寸下、在浅色与深色底上各看一遍。它住在仓库里而不是 `docs/` 里，
  因为 `docs/` 是随包发布的，而这是一个开发用的产物：`tools/` 不在 `files` 里，并且 CI
  现在会在 `docs/` 下出现非 Markdown 文件时报错。
- **价格的准确性。** 表格被断言带着来源所公布的内容，并对某一家厂商公布的数字做过抽查。
  这里没有任何东西能验证某个来源是否正确、是否最新，或是某个账户实际被计费的价格。
- **作为发票的账单。** 账单把会话日志记录下来的 token 数乘以路由所指名的那个模型的
  价目。它没有与任何提供方的实际发票对过账，所以它是一个写明了依据的估算值——而不是
  关于实际扣了多少费的说法。套餐额度取自配置里写的数字，这里没有任何东西拿它们与
  提供方的条款核对。
- **跨越几个月的套餐。** 摊分在一个不完整的月份、以及有起始或结束日期的套餐上都被
  断言过；一个跨长时间区间计费的套餐只是同一套算术重复执行，不是另一条被观察过的路径。
- **长时间运行下的那个 30 分钟定时器。** 这个间隔被断言在测试下能配置、能触发也能停止；
  它能否在一次数小时的会话里持续工作、以及宿主会不会为它留着一个进程不断开，只靠
  `unref` 调用来断言，而不是靠观察。

本文档早期草稿列在这里的两个条目，后来是用证据结掉的，而不是悄悄删掉：`/tokens` 在
真实对话里作出应答，以及在真实宿主上回填与 CLI 一致。两者都记录在上面的
[修复之后的真实宿主挂载](#修复之后的真实宿主挂载020) 一节。
