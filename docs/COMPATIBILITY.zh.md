# 兼容性

[English](COMPATIBILITY.md) | 中文

[← 返回 README](../README.zh.md)

## 需要的 DSH 版本

**DSH `^0.2.0-rc.1`** —— 当前实测针对的是 0.2.1-rc.3；区间下界写成 `0.2.0-rc.1`，
是因为这个生态用 rc 段来拼预发布版本区间。`^` 把上界放在 `0.3.0`。

这个区间是有实际约束力的，不是装饰：DSH 在启动时会拿它与正在运行的宿主比对，
**区间不覆盖当前版本就直接跳过该插件**。1.0.0 带的 `^0.1.2-rc.1` 不满足 `0.2.0-rc.2`，
于是 1.0.0 在所有 0.2 宿主上被静默跳过——1.0.1 修的就是这件事。`0.1.x` 宿主现在落在
声明区间之外。

同一个区间也写成 `engines.dsh`——这是插件市场的兼容性预检会读取并展示的字段：`dshmarket`
用它与宿主 peers 一起推导结论，并展示所有声明的**交集**。两处写的是同一个字符串，所以市场
上显示的是一个区间、而不是同一件事的两种写法的交集；也不会在没人同时改两处的情况下各自漂移。

这个要求按生态里真正会被读取的方式声明——写成对两半各自绑定到的五个宿主包的
`peerDependencies`：

| Peer | 为什么要写它 |
| --- | --- |
| `@deepseek-ai/dsh-session-persistence` | 它提供 `sessionPersistence`，账本的用量数据来自这里。 |
| `@deepseek-ai/dsh-commands` | 它提供 `commands`，`/tokens` 靠它注册。 |
| `@deepseek-ai/dsh-host-webserver` | 它提供 `webServer`，设置页那三个路由靠它提供。 |
| `@deepseek-ai/dsh-client-locale` | 浏览器半边注入它来拿翻译后的文案。 |
| `@deepseek-ai/dsh-client-ui-settings-general` | 浏览器半边注入它，把分区加进设置侧边栏。 |

五个都是**可选**（optional），这是刻意的而不是含糊其辞：DSH 不会把宿主包提升进 profile 的
`node_modules`，所以写成必需 peer 只会在每次安装时报告一个"未满足"、却什么也不说明。可选也正是
插件自身行为的如实描述——没有 web 服务器的 profile 少掉设置页，`/tokens` 与 CLI 照常可用；
headless 或 TUI profile 则根本没有那两个客户端包。

这个声明之所以有用，是因为 DSH 会拿**实际在跑的那套安装**去解析它：profile 检查器先看插件自己的
`node_modules`，再看 profile 目录树，最后**回落到 DSH 安装目录本身**
（`node_modules/dshmarket/lib/check.js`），把解析到的版本与上面的区间比对——于是不受支持的
harness 会被报出来，而不是悄悄挂载。早先的版本声明的是 `dsh.compatibility.dsh`，而 DSH 里
没有任何代码读它；1.0 把它删掉，而不是留一个看起来像承诺、实际不是的字段。取而代之的
`dsh.compatibility.dshReleases` 是一份给插件市场读的声明——它列出真正核对过的版本——
而 DSH 在挂载时看的并不是它，真正的闸门是上面那个 peer 区间。

这些声明对消费者零成本：可选 peer 不会被安装，包本身依旧没有运行时依赖、没有安装脚本。


## 兼容性

- **Node：** ≥ 22.15.0（CLI 需要解码 Zstandard 帧）。宿主端本身没有版本相关要求。
- **DSH：** `^0.2.0-rc.1`，以对五个宿主包的可选 peer 形式声明——见
  [需要的 DSH 版本](#需要的-dsh-版本)。已对照 `0.2.1-rc.3` 核过：DSH 自带的兼容性判定
  接受本清单，且两半用到的每个接口——`ctx.on`、`ctx.inject`、`ctx.get`、`ctx.effect`、
  `commands.register`、`sessionPersistence.list()/inspect()`，以及 `settings.section`
  槽位配合 `ctx.slots.inject`/`ctx.slots.register`——在 `0.2` 线上形状未变。
  [`docs/VERIFICATION.md`](VERIFICATION.zh.md) 记录的是上一次完整的应用内实测，
  那一次跑在 `0.1.2-rc.1` 上；对照 `0.2.1-rc.3` 挂载的那一次单列在同一文件里。
- **Profile：** 任意。没有 profile 相关代码。
- **网络：** 费率页会通过 HTTPS 取价格与美元汇率，但这完全是可选的：没有外网时仍然
  提供本机缓存的上次结果，手动填写的值照常可用，`rates: false` 则连请求都省掉。


---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 三个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
