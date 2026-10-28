# dsh-token-ledger

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供透明、可审计的 token 记账。

[![CI](https://github.com/zhz8888/dsh-token-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/zhz8888/dsh-token-ledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zhz8888/dsh-token-ledger.svg)](https://www.npmjs.com/package/@zhz8888/dsh-token-ledger)
[![license](https://img.shields.io/npm/l/@zhz8888/dsh-token-ledger.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.1-4c1a97)](https://github.com/deepseek-ai/deepseek-harness)
[![last commit](https://img.shields.io/github/last-commit/zhz8888/dsh-token-ledger)](https://github.com/zhz8888/dsh-token-ledger/commits/main)

[English](README.md) | 中文

---

这是一本**账本**，不是一块仪表盘。它把 DSH 的持久会话日志折叠成 token 用量，保证重启不丢，
而且——这是关键——允许你**从原始日志重算同一批数字并与之对账**。

```
$ dsh-token-ledger audit
scanned 139 session log(s), 344203 events, 29 forked session(s), 0 unreadable

  stored      6901 calls  1205685663 tokens
  recomputed  6901 calls  1205685663 tokens

  audit: match — the stored ledger equals a fresh fold of the raw logs
```

只想看漂亮的图表，市面上有十几个同类插件。这个插件是给你**需要为这个数字辩护**的时候用的。

设置页有三个页签：**概览**（账本本身，含每档区间的预计花费）、**费率**（各厂商模型的价格表
——默认列出最新几个，每个厂商都能展开看全部——与实时美元汇率）、**账单**（把同一批用量折算成钱
——按工作区 / 会话 / 模型 / 供应商四个分组自上而下展开，每个分组各配五个时间段，可整页导出
CSV 或 JSON）；另有一个完全不依赖宿主的 CLI。

## 目录

- [快速上手](#快速上手)
- [需要什么](#需要什么)
- [界面截图](#界面截图)
- [为什么别的插件装不上时它能装上](#为什么别的插件装不上时它能装上)
- [安装](#安装)
- [命令行](#命令行)
- [设置页](#设置页)
- [计数规则](#计数规则)
- [配置](#配置)
- [它刻意不做的事](#它刻意不做的事)
- [权限](#权限)
- [排查](#排查)
- [卸载](#卸载)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [安全](#安全)
- [支持](#支持)
- [致谢](#致谢)
- [许可证](#许可证)

## 快速上手

```bash
# 1. 把插件装进某个 profile
dsh plugin --profile web add @zhz8888/dsh-token-ledger

# 2. 重启 DSH，然后确认那一行进去了
dsh --profile web --dump-config | grep token-ledger

# 3. 在对话里问账本
/tokens
```

或者完全不启动宿主——CLI 自己直接读原始日志：

```bash
dsh-token-ledger summary   # 已存的账本
dsh-token-ledger audit     # 从原始日志重算并对比
```

账本写在 `<DSH_HOME>/token-ledger/ledger.json`，全新安装会先把磁盘上已有的历史折叠进来，
而不是从今天开始记。它需要 DSH `^0.2.0-rc.1`（实测针对 `0.2.1-rc.3`）与 Node ≥ 22.15.0，
其余条件都是可选的。

## 需要什么

| | 要求 | 说明 |
| --- | --- | --- |
| **DSH** | `^0.2.0-rc.1` | 实测针对 `0.2.1-rc.3`。这一条是有约束力的：DSH 会跳过区间不覆盖当前宿主的插件。详见[兼容性](docs/COMPATIBILITY.zh.md)。 |
| **Node** | ≥ 22.15.0 | CLI 需要解码 Zstandard 帧。宿主端本身没有版本相关要求。 |
| **Profile** | 任意 | 设置页需要带 web 服务器的 profile（`web` 或 `desktop`）；`/tokens` 与 CLI 在任何 profile 下都可用。 |
| **网络** | 可选 | 只有价目表与美元汇率需要联网。`rates: false` 会去掉全部请求。 |
| **磁盘** | 一个可写的 `<DSH_HOME>/token-ledger/` | 除了你主动要求的导出，它只写这一个目录。 |

## 界面截图

设置页各页签的实机截图：

**概览**：本月总计、今日实时，以及一年的活跃度：

![概览页：本月总计、今日实时与年度活跃度热力图](assets/screenshots/01-overview.jpg)

**日历视图**：一个月的形状在这里——最忙的一天、最轻松的一天、工作到最晚的一天，
下面是同一批用量按模型拆分：

![日历视图：本月热力图与最忙、最轻松、最晚的一天，以及按模型的用量](assets/screenshots/02-calendar.jpg)

**近 7 天**的柱状图，以及同样的按模型拆分：

![近 7 天 Token 柱状图与按模型的用量](assets/screenshots/03-weekly.jpg)

**费率**：实时美元汇率与各厂商公布的价目表：

![费率页：美元汇率与各厂商模型价格](assets/screenshots/04-rates.jpg)

## 为什么别的插件装不上时它能装上

| 特性 | 为什么重要 |
| --- | --- |
| **没有任何东西会被装给你** | 无运行时依赖；声明的 peer 全都是可选宿主包——DSH 内部包的版本漂移不可能把第二份 harness 拖进你的 profile。 |
| **零安装脚本** | 直接用 git URL `dsh plugin add` 即可——pnpm 没有构建要拦，你也不必去 `allowBuilds` 里加白名单。 |
| **只 import `node:`** | 宿主端可以从任意 profile（web / desktop / headless / TUI）加载，不需要解析任何包。 |
| **不碰模型可见面** | 它不注册任何提示词段、消息或工具，因此不会改变请求前缀，也不会损害 KV cache 复用。 |
| **故障降级** | 每个钩子都有保护。账本出问题只记一条警告，绝不让会话失败。 |

## 安装

```bash
# 从 npm
dsh plugin --profile web add @zhz8888/dsh-token-ledger

# 从 git URL（不涉及任何构建步骤）
dsh plugin --profile web add github:zhz8888/dsh-token-ledger

# 从本地仓库
dsh plugin --profile web add /absolute/path/to/dsh-token-ledger
```

npm 包名带 scope，是因为 npm 会把分隔符归一化后比较，无 scope 的
`dsh-token-ledger` 被判为与已有包过于相似而拒绝发布。CLI 命令名仍然是
`dsh-token-ledger`。

重启 DSH，然后确认那一行进去了：

```bash
dsh --profile web --dump-config | grep token-ledger
```

在对话里用 `/tokens`：

```
/tokens
/tokens export     # 把 CSV 与 JSON 写到 <DSH_HOME>/token-ledger/exports/
/tokens json       # 原始快照
/tokens path       # 账本文件位置
```

账本写在 `<DSH_HOME>/token-ledger/ledger.json`。

## 命令行

不需要 DSH 在运行——它直接读原始日志。

```
dsh-token-ledger [summary] [选项]     打印已存账本（默认）
dsh-token-ledger audit   [选项]       从原始日志重算并对比
dsh-token-ledger rebuild [选项]       从原始日志重算
dsh-token-ledger export  [选项]       导出 CSV 与 JSON
dsh-token-ledger help    [选项]       打印用法说明

--home <path>    DSH home（默认读 DSH_HOME 环境变量，其次 ~/.dsh）
--ledger <path>  要读写的账本文件
--out <path>     导出目录
--days <n>       摘要显示天数（默认 7）
--models <n>     摘要显示模型数（默认 5）
--write          配合 rebuild：覆盖已存账本
--json           机器可读输出
--quiet          抑制人类可读摘要，只保留退出码
-h, --help       打印用法说明
-v, --version    打印版本号
```

退出码：`0` 成功或审计通过，`1` 审计发现真实差异，`2` 用法错误或输入不可读。
因此它可以挂进定时任务。

## 设置页

浏览器端会在设置侧边栏注册一个 **用量账本** 分区，顶部有 **概览 / 费率 / 账单** 三个按钮。
它自己的文案会注册到宿主的语言服务上，因此跟随宿主的语言。

- **概览** —— 本月总计、今日实时、用量热力图与按模型拆分，每档区间都给出预计花费。
- **费率** —— 实时美元汇率与各厂商公布的价目表，每个厂商都能展开看它的全部模型，每一项都能手改，
  以应对联网不可用的时候。
- **账单** —— 同一批用量折算成钱：工作区、会话、模型、供应商自上而下堆叠，每个分组各有自己的
  时间段，一份 CSV 或 JSON 导出全部。

[设置页完整说明](docs/SETTINGS-PAGE.zh.md)——每个页签展示什么，以及页面上的每个价格分别来自哪里。

## 计数规则

| 规则 | 行为 |
| --- | --- |
| **只认成功锚点** | 用量取自已完成的步与一次压缩调用。失败或被取消的尝试不会追加这两种事件，因此永远不计入。 |
| **流式样本是替换，不是相加** | 同一步先出 `usage` chunk、后出最终消息时，最终值**替换**早期样本——无论哪种情况都算一次调用。 |
| **`totalTokens` 是推导出来的** | 它是四个桶之和，绝不采信提供方自己的总量字段。 |
| **推理 token 是子集** | 单独报告，绝不相加进总量，因为它本来就在 `outputTokens` 里面。 |
| **按本地日历日** | 是你所在时区的日，不是 UTC 日。 |
| **fork 切、resume 不切** | fork 的前缀属于父会话；resume 的前缀是这个会话自己的。 |

[这些数字是怎么数出来的](docs/COUNTING.zh.md)——计数规则、fork 与 resume 的区分，
以及审计那两类差异分别意味着什么。

## 配置

按 `id` 覆盖组合条目：

```yaml
- id: token-ledger
  config:
    ledgerPath: 'D:/dsh/ledger.json'   # 默认 <DSH_HOME>/token-ledger/ledger.json
    backfill: false                     # 默认 true——启动时折叠已存历史
    backfillLogs: false                 # 默认 true——同时读取磁盘上的会话日志
    rates: false                        # 默认 true——false 时完全不发网络请求
```

[完整配置](docs/CONFIGURATION.zh.md)——每一个配置项、它改变什么，以及历史从哪里来。

## 它刻意不做的事

- **概览页给出写明口径的预计花费，账单页给出逐行明细。** 两者都会写明价格来源、换算用的汇率、
  每一个靠名字匹配上的价格，以及每一个没能定价的模型，因此这些数字是用来核对的，不是用来信的。
  它们都不是厂商开给你的账单，也不声称是。
- **不内置价目表。** 价格要么从一个可选的源联网取（默认是各家官方价目），要么你自己填。
  内置一份价目表几周内就会过期，而且每次更新都得发一个版本。
- **不注册面向模型的工具。** 工具 schema 会在每次请求上花提示词 token 并改变缓存前缀——
  对一个 token 记账插件来说这很荒唐。人类场景由 `/tokens` 与 CLI 覆盖。

## 权限

它对运行它的机器做了什么——写清楚，好让它可以被**核对**，而不是被**猜测**：

| 能力 | 实际行为 |
| --- | --- |
| **文件** | 以只读方式读取 `<DSH_HOME>/sessions/` 下的会话日志；读取 `<DSH_HOME>/settings.yaml` 只为拿到账单上显示的供应商名称。写入只发生在它自己的目录里——`<DSH_HOME>/token-ledger/ledger.json` 与 `rates.json`——以及你主动要求的导出。该目录之外既不写也不删。 |
| **网络** | 只在费率功能开启时发起普通 HTTPS `GET`：价格目录、美元汇率，以及最多 3 个厂商定价页。`rates: false` 会去掉全部请求。浏览器半边不发起任何外部请求。 |
| **命令** | 没有 shell、没有子进程、没有 spawn——安装时与运行时都没有。它对外提供的是通过宿主自身 `commands` 服务注册的 `/tokens` 斜杠命令，以及你自己运行的 `dsh-token-ledger` 可执行文件。 |
| **凭据** | 不读取任何凭据。`process.env` 只在未显式传入 home 时用来解析 `DSH_HOME`；不读任何提供方 API key、不碰 keychain、不做 OAuth。 |

以上每一条都可以对着源码核对——import、URL 与状态目录都在 `lib/` 里，
而保证"安装侧"成立的那些打包不变式由 `pnpm run verify` 断言。完整版本见
[兼容性](docs/COMPATIBILITY.zh.md)。

## 排查

**插件根本没挂载。**
DSH 会跳过区间不覆盖当前宿主的插件，而且只在宿主自己的日志里说明。这里的区间是
`^0.2.0-rc.1`，`0.1.x` 宿主装不上——见[兼容性](docs/COMPATIBILITY.zh.md)。

**账本是空的。**
全新安装本该显示磁盘上已有的历史，所以空账本通常是两种原因：磁盘折叠被关了，
或者日志不在插件要找的位置。CLI 读的是和宿主同一批文件，可以从它这一侧核对：

```bash
dsh-token-ledger rebuild --home ~/.dsh --write
dsh-token-ledger audit --home ~/.dsh
```

`backfillLogs: false` 关掉磁盘折叠，`backfill: false` 两个都关，账本就从头开始。

**审计报 "mismatch"。**
它会区分"会话还在跑、只是还没落盘"与真正的分歧，只有后者算失败——见
[这些数字是怎么数出来的](docs/COUNTING.zh.md)。

**费用显示短横线，或者页面写着"还没有价格"。**
本包不内置价目表——内置一份几周内就会过期。价格要么从一个你选定的源联网取，
要么在费率页上手填；宿主还没拿到价格时会明说，而不是给出一个理直气壮的 `¥0.00`。
完全离线的宿主仍会提供上次已取回的结果，并显示它有多旧。

**`/tokens` 没有注册。**
这个命令通过宿主自身的 `commands` 服务注册，而本包把它声明为可选 peer。
没有该服务的 profile 根本没有斜杠命令；CLI 不受影响，照样能读账本。

**数字和厂商后台对不上。**
账单是估算值：会话日志记下的 Token × 路由真正指向的那个模型的公开价目。
它不是发票，也不掌握厂商的折扣、额度、套餐与失败重试的情况。

**想从头来过。**
删掉 `<DSH_HOME>/token-ledger/` 再重启；下次启动会重新折叠磁盘上的历史。

## 卸载

```bash
dsh plugin --profile web remove @zhz8888/dsh-token-ledger
```

账本文件是**故意**不删的——要清空历史请自行删除 `<DSH_HOME>/token-ledger/`。

## 文档

README 讲的是怎么**用**这个插件；其余细节都在 [`docs/`](docs/README.zh.md) 里：

| 文档 | 内容 |
| --- | --- |
| [这些数字是怎么数出来的](docs/COUNTING.zh.md) | 计数规则、fork 与 resume、以及审计。 |
| [设置页](docs/SETTINGS-PAGE.zh.md) | 三个页签的完整说明。 |
| [配置](docs/CONFIGURATION.zh.md) | 插件会读到的每一个配置项。 |
| [兼容性](docs/COMPATIBILITY.zh.md) | 需要哪个 DSH，以及它会碰什么。 |
| [开发与发布](docs/DEVELOPMENT.zh.md) | 怎么改这个插件，以及怎么发布它。 |
| [发布到 npm](docs/PUBLISHING.zh.md) | 手动发布那条路，用于一个 scope 下的第一次发布。 |
| [验证记录](docs/VERIFICATION.zh.md) | 实际验证了什么，以及哪些没有验证。 |

每一篇都有中英两个版本，语言切换在每篇的开头。英文索引在
[README.md](README.md#documentation)。

## 参与贡献

欢迎提 issue 与 pull request。

```bash
git clone https://github.com/zhz8888/dsh-token-ledger
cd dsh-token-ledger
pnpm install
pnpm test          # 297 个测试，14 个文件
pnpm run verify    # 打包不变式
```

两道门禁都通过、且 diff 里没有夹带无关改动，就算可以了。本仓库有两条约定：README 是这个包
契约的一部分；新的说法要么带着证据进
[`docs/VERIFICATION.md`](docs/VERIFICATION.zh.md)，要么就不要进来。其余见
[开发与发布](docs/DEVELOPMENT.zh.md)。

## 安全

这个插件会读会话日志、读 `settings.yaml` 里账单要显示的供应商名，并且只写
`<DSH_HOME>/token-ledger/` 目录。它不读取任何凭据。它到底碰了哪些东西，逐条列在
[权限](#权限)里，可以对着源码核对，不必只听它说。

**报告安全问题请不要开公开 issue。** 用本仓库 **Security** 标签页里的私有报告
（*Report a vulnerability*）通道，它能在不公开细节的情况下联系到维护者；
如果你的账号看不到这个选项，直接用 `package.json` 里的邮箱联系维护者。

## 支持

- **缺陷与需求** — [GitHub issues](https://github.com/zhz8888/dsh-token-ledger/issues)。
- **每个版本改了什么** — [CHANGELOG.md](CHANGELOG.md)。
- **实际验证了什么、哪些没验证** — [docs/VERIFICATION.md](docs/VERIFICATION.md)。

带上 DSH 版本、profile 类型，以及 `dsh-token-ledger audit` 的输出（它会打印自己扫了什么），
通常一个来回就能定位。

## 致谢

- 它绑定的槽位注册表、语言服务与设置外壳都来自
  [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
- 厂商标识是各家官方的那一套，取自它们自己的官网与
  [Simple Icons](https://simpleicons.org)，商标权仍属各自权利人。
- 不公布机器可读价格的那些厂商，其价目来自 [models.dev](https://models.dev)；
  DeepSeek、Z.ai 与腾讯的价格则当场读自它们自己的定价页。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

代码采用 MIT 许可证。包内附带的厂商标识（OpenAI、Anthropic、Google、DeepSeek、Qwen、
xAI、Z.ai、Kimi、MiniMax、腾讯、小米、字节跳动）属于各自权利人的商标，仅用于标识
这一行价格属于谁，不在本许可证覆盖范围内。
