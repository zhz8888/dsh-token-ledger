# 开发与发布

[English](DEVELOPMENT.md) | 中文

[← 返回 README](../README.zh.md)

## 这是一个 fork

本仓库是 [chenmiao8563/dsh-token-ledger](https://github.com/chenmiao8563/dsh-token-ledger)
的 fork，那才是原项目。它在 v1.1.2 之前以 `@chenmiao8563/dsh-token-ledger` 这个包名发布；
本 fork 以 `@zhz8888/dsh-token-ledger` 延续这份工作。

**上游的 MIT 声明保留。** MIT 要求原始声明随代码同行，所以 [LICENSE](../LICENSE)
里是并列两个权利人，而不是替换掉第一个——逐字取自上游的代码同理。

**原仓库作为 `upstream` 这个 remote 保留**，两条历史因此可以对照，上游的改动也能拉进来：

```bash
git remote -v                              # origin: 本 fork，upstream: 原仓库
git fetch upstream
git log --oneline upstream/main..main      # 本 fork 多出来的东西
```

**这里的改动不会自动回流上游。** 值得上游采纳的修复，值得去
[chenmiao8563/dsh-token-ledger](https://github.com/chenmiao8563/dsh-token-ledger/issues)
开一个 issue；两个仓库也可能从此分叉：插件的身份——包名、客户端模块 id 与组合行——
属于本 fork，因为 harness 靠它解析这个 bundle。

## 开发

本项目用 pnpm 开发，版本由 `package.json` 的 `packageManager` 字段钉住；
发布出去的包本身不带任何依赖。

```bash
pnpm install         # devDependency 只有三个：react、react-dom，以及 DSH 跑的那个槽位注册表
pnpm test            # 297 个测试，14 个文件
pnpm run verify      # 打包不变式（零依赖、无安装脚本、无裸模块说明符）
```

`pnpm test` 使用 Node 内置测试运行器。在禁止逐文件 spawn 子进程的受限环境里，
改用 `pnpm run test:single-process`。

React **只是 devDependency**，消费者永远不会安装它：本包不带任何运行时依赖、不带任何
安装脚本，声明的 peer 全是可选声明、没有任何东西会去抓取，而 pnpm 不会为依赖安装其
devDependencies。它在这里的作用是让
浏览器端能用**真库**渲染并断言——这能抓到替身抓不到的东西：hook 顺序违规与非法
DOM 属性，React 会报出来，而手写的 `createElement` 会默默接受。没装它时这些渲染
测试会带明确原因**跳过而不是失败**，所以全新克隆、无网络也能跑 `pnpm test`。

**改动的生效方式。** 两半都是在插件**挂载时**读取的，所以改 `lib/index.js` **或**
`lib/client.js` 都需要重启 DSH（或重载插件）——刷新页面不够，因为 bundle 的 `rev`
在挂载时算定，URL 没变浏览器就继续用缓存那份。这是量出来的不是猜的：在隔离 host
运行时，改 `lib/client.js` 之后被服务的 bundle 与它的 `rev`（`d683dd523466`）都纹丝不动；
重启后 `rev` 变成 `f55ee321db50` 并提供了新内容。导出的是文件，所以如果你手上的那份
来自某次修复之前，看时间戳就知道。

实际验证了什么、怎么验证的（包括 fork 规则背后的证据）见
[docs/VERIFICATION.md](VERIFICATION.zh.md)。

**改文案不用重启。** 页面上的中英文词条在 `locale/zh.json` 与 `locale/en.json`，
是纯数据：改完刷新页面即可——宿主是每次被问到时才去读那两个文件，而不是在启动时
读一次。两种语言必须共用同一套键（少一个键，读到的就是一种语言有词、另一种语言
只有键名），`pnpm test` 里有一条测试专门核对这件事。浏览器半边拿不到词条时分区
照样出现，只是标签退回键名。


## 发布

**打一个 tag 就是发布。不需要在任何地方存放 token。**

```bash
git tag v1.2.0 && git push origin v1.2.0
```

tag 必须与 `package.json` 里的版本一致——workflow 不一致就拒绝发布——所以请用清单里
那个版本，而不是照抄这个例子。

这是**第一次之后**每次发布走的路。第一次发布不能用它：OIDC 无法为一个还不存在的包
配置，所以第一次得手动发——见[发布到 npm](PUBLISHING.zh.md)。

`release.yml` 会跑测试与打包检查、确认 tag 与 `package.json` 一致、用 OIDC
**trusted publishing** 发布、把 tarball 挂到 GitHub Release 上，并在报告成功之前
**断言该版本确实已在 registry 上**——所以绿色意味着已发布，而不只是尝试过。

最后这条断言不是装饰。这条流水线从 v0.5.0 到 v0.8.0 每个 tag 都失败，报的是
`404 Not Found - PUT`——它说的是"包不存在"，而真正的问题是缺凭据；而且失败之后
registry 会有几分钟看起来是空的，尽管发布其实已经成功。两个原因都已在 workflow 里
加了防线：

- **npm CLI 必须 ≥ 11.5.1。** Node 22 自带 npm 10，根本做不了 OIDC 交换。workflow
  跑在 Node 24 上，并把版本打进日志。
- **不能用 `actions/setup-node` 的 `registry-url` 输入。** 它会往 `.npmrc` 写
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`，npm 看到这一行就认定
  "已有凭据"，直接跳过 trusted publishing，报 `ENEEDAUTH`——在一个本就不持有凭据的
  任务里，这读起来像"你忘了登录"。发布前现在有一道步骤：只要 `.npmrc` 里出现
  `_authToken` 就大声失败。

npm 那边要接受它，需要在 npmjs.com 上给包配 **Trusted Publisher**（包 → Settings →
Trusted Publisher → GitHub Actions），仓库填 `zhz8888/dsh-token-ledger`、
workflow 填 `release.yml`、**Environment 留空**——填了一个 workflow 没有声明的
environment 就匹配不上，registry 只会回一句
`OIDC token exchange error - package not found`。

在 trusted publishing 出现之前，一个版本的首发是用
`npm publish --access public --otp=<认证器里的 6 位数字>` 手动发的，因为 OIDC 没法在包
存在之前配置。那条路现在依然可用，也依然需要带 2FA bypass 的 granular token，
但它**不产生 provenance 证明**，而且 v0.8.0 那次排查正是从这条路走起——从一个过期的
token 开始。优先用打 tag。

重复运行是安全的：版本已在 registry 上时跳过发布步骤，GitHub Release 只在不存在时创建。


---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 四个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
