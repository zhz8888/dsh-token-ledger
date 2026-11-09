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
pnpm test            # 445 个测试，17 个文件
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

**没有流水线替你发布。你自己发。**

```bash
pnpm run release                 # 全部流程，就在这台机器上
pnpm run release -- --dry-run    # 除了发布，其余全做
```

`pnpm run release` 跑的是 `scripts/release.mjs`，它按顺序逐步执行，每一步都要等上一步
通过才会继续：

1. **预检。** 工作区必须干净，`pnpm` 必须在 PATH 上（清单里的 `prepublishOnly` 需要它），
   tag 必须存在且必须指向 `HEAD`，该版本必须还不在 registry 上。
2. **闸门。** `pnpm run verify` 与 `pnpm test`——过去每次 push 都会跑的检查，现在在这里
   跑，跑的就是这份检出。
3. **打包。** `npm pack`，打到一个用完即删的临时目录里。
4. **发布。** 用你自己的 npm 登录，对着 npm registry 执行
   `npm publish --access public`。
5. **确认真的落地。** registry 的读侧不是立刻一致的，所以脚本最多等四分钟才判定失败。
   一次成功的发布，不会因为 `npm view` 在九十秒内回了 404 而被当成失败。
6. **GitHub Release。** 这个 tag 会得到一个 release，并挂上 tarball。已经存在的 release
   会被复用而不是硬碰硬，所以重跑是可行的。
7. **Gitea 镜像**，加 `--mirror-gitea` 才会做。同一个 tag、同一份说明、同一个 tarball，
   说明里的链接改写成指向镜像而不是 GitHub。

发布以 tag 为准，tag 就是版本号：

```bash
git tag v1.2.0 && git push origin v1.2.0
```

tag 与 `package.json` 里的版本不一致、tag 不指向 `HEAD`、或者该版本已经在 registry 上时，
脚本都会拒绝发布——已发布的版本不能被覆盖，所以这三种情况唯一的正确回答都是拒绝。

**你必须已经登录 npmjs.com，而且 npm CLI 版本要够新。** 发布就是一次普通的带认证发布：
先 `npm login --registry=https://registry.npmjs.org` 登录一次，之后 npm 会在发布时向你要
认证器上的动态口令（`--otp=123456` 可以显式传进去）。这台机器的 registry 指向哪里、
发布失败时怎么办，见[发布到 npm](PUBLISHING.zh.md)。

### workflow 过去做什么，以及为什么没了

发布过去跑在 GitHub Actions 上，用 OIDC **trusted publishing** 发布，所以不需要在任何地方
存放长期有效的 token。trusted publishing 是一场只有 GitHub Actions runner 才能做的 OIDC
交换，workflow 一删就没有 runner 来做这场交换了。于是发布回到本地，用你自己的 npm 凭据
——那是你自己持有的 token，而不是仓库持有的。

workflow 做的检查都留下来了，因为那些检查本来就值得做：

| workflow 做的事 | 现在由谁做 |
| --- | --- |
| 每次 push 跑 `pnpm test` | `pnpm test`，作为发布闸门 |
| 每次 push 跑 `pnpm run verify` | `pnpm run verify`，作为发布闸门 |
| 一个把 tarball 打出来并检查内容的任务 | `pnpm run check:tarball`——同样的断言，跑在这台机器打出来的 tarball 上 |
| 一个把 tarball 装进临时工程再审计一遍的任务 | 同上，就在 `pnpm run check:tarball` 里 |
| 发布时核对 tag 与 `package.json` | 预检 |
| 发布后断言该版本已在 registry 上 | 等它出现的那一步 |
| 创建 GitHub Release 并挂上 tarball | `scripts/release.mjs` 的最后两步 |
| 在 npmjs.com 上配 Trusted Publisher | 你自己的 npm 登录，发布时输入动态口令 |

### 一台机器验不了的东西

CI 当时是在一个矩阵上跑测试的：Linux 上的 Node 22 与 24、Windows 上的 Node 22，以及
macOS 上的 Node 24。本地跑只覆盖一台机器、一个 Node。版本范围不是摆设——CLI 要解 zstd
的会话帧，Node 从 22.15.0 起才有这个能力——所以那个矩阵是为了兜住开发机上没有的运行时。

这部分覆盖现在是手工责任：在你声称支持的每个平台和 Node 版本上跑一遍 `pnpm run check`，
并在发布说明里写清你跑过哪些。

---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 四个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
