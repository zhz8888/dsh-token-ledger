# 发布到 npm

[English](PUBLISHING.md) | 中文

[← 返回 README](../README.zh.md)

从本仓库到达 npm 有两条路，而它们在起点上并不通用：

| | 是什么 | 什么时候用 |
| --- | --- | --- |
| **推 tag** | `git push origin v1.1.5` 触发 `release.yml`，用 OIDC **trusted publishing** 发布——任何地方都不存放 token。 | 包**已经**存在于 npm、且已为本仓库配好 Trusted Publisher 之后的每一次发布。 |
| **手动发布** | 在本仓库里执行 `npm publish`，用你自己的 npm 登录与一次性验证码。 | 一个包的**第一次**发布。OIDC 无法为一个还不存在的包配置。 |

`@zhz8888/dsh-token-ledger` 正是它的第一次发布，所以要手动发一次。这一页就是手动那条路；
等它上了 npm，把 Trusted Publisher 配好，之后每次发布又回到推 tag。

## 开始之前

**这台机器默认的 registry 是镜像，不是 npm。** npm 被配置成
`registry=https://registry.npmmirror.com`，那是一个只读镜像：它提供包，但不接受发布。
所以下面每一条发布命令都把官方 registry 写出来。

**你需要登录 npmjs.com。** 这台机器目前没有任何 npm 凭据——`~/.npmrc` 里只有一行
`registry`。先登录一次：

```bash
npm login --registry=https://registry.npmjs.org
```

它会问用户名、密码，以及（开了 2FA 的话）认证器上的一次性验证码。之后
`npm whoami --registry=https://registry.npmjs.org` 会打印这些命令将以哪个账号发布
——请确认那是拥有 `@zhz8888` scope 的账号。

**npm CLI 版本要够新。** trusted publishing 需要 npm ≥ 11.5.1；这台机器是 11.12.1。
Node 22 自带 npm 10，根本做不了 OIDC 交换。

**pnpm 必须在你的 PATH 上。** 清单里的 `prepublishOnly` 跑的是
`pnpm run verify && pnpm test`，而 npm 发布时就会执行这个脚本。

## 发布

**1. 停在发布提交上，工作区是干净的。**

```bash
git status --short          # 必须什么都不输出
git log --oneline -1        # release: 1.1.5
```

**2. 确认这个版本还没在 registry 上。**

```bash
npm view @zhz8888/dsh-token-ledger versions --registry=https://registry.npmjs.org
```

这里回 404，说明版本还没发出去——第一次发布时你希望看到它；**重跑**时你希望看到的是
相反的结果。

**3. 先打个包，看看将要发布的东西。**

```bash
npm publish --dry-run --access public --registry=https://registry.npmjs.org
```

dry run 只打印文件清单和包体积，不会上传任何东西。应该是 38 个文件：两份 README、
`CHANGELOG.md`、`LICENSE`、`cordis.patch.yml`、`package.json`、那个可执行文件、
`lib/` 下的 15 个模块，以及 `docs/` 下的 16 篇文档。

那份输出里有两行值得停下来看一眼，而不是划过去——它用的 registry，以及它要用的
tag 与访问级别：

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)
+ @zhz8888/dsh-token-ledger@1.1.5
```

如果第一行写的是那个镜像，就停下：registry 的覆盖没生效。

**4. 发布。**

```bash
npm publish --access public --registry=https://registry.npmjs.org
```

npm 会问你要认证器上的一次性验证码。如果你用的是 token 而不是交互式登录，就把码显式传进去：

```bash
npm publish --access public --otp=123456 --registry=https://registry.npmjs.org
```

在新 scope 下第一次发布时 `--access public` 不是可选项：不加它，包会被建成私有的。
清单里已经带了 `publishConfig.access: public`，两种情况下都覆盖得住。

**5. 确认它落地了。**

```bash
npm view @zhz8888/dsh-token-ledger version --registry=https://registry.npmjs.org
```

新 scope 下的第一次发布之后，packument 可能要一两分钟才变得可读——`dist-tags` 和
tarball 已经上线，而读的那一侧还没跟上。那是 registry 的传播延迟，不是发布失败：
`npm view` 连续几分钟回 404，并不代表上传没成功。

## 然后：把后续的发布交给推 tag

现在包已经存在，npmjs.com 就可以被告知信任这个仓库了：

1. npmjs.com → **@zhz8888 / dsh-token-ledger** → Settings → **Trusted Publisher**
   → GitHub Actions。
2. 仓库填 `zhz8888/dsh-token-ledger`、workflow 填 `release.yml`、**environment 留空**
   ——填了一个 workflow 没有声明的 environment 就匹配不上，registry 只会回一句
   `OIDC token exchange error - package not found`。
3. 保存。之后每次发布就是推一个 tag：

```bash
git tag v1.1.5 && git push origin v1.1.5
```

`release.yml` 会跑测试与打包检查、确认 tag 与 `package.json` 一致、发布、把 tarball
挂到 GitHub Release 上，并在报告成功之前**断言该版本确实已在 registry 上**——所以绿色
意味着已发布，而不只是尝试过。

## 出了岔子怎么办

| 现象 | 是什么 |
| --- | --- |
| `npm error code ENEEDAUTH` | 没登录，或者登录的是镜像而不是 npmjs.com。`npm whoami --registry=https://registry.npmjs.org` 能看出是哪个。 |
| `npm error code E403` / *你没有发布权限* | 登录的账号不对，或者该账号在 `@zhz8888` scope 上没有发布权限。 |
| `npm error code EOTP`，或者它问你要验证码 | 2FA 开着。输入认证器上的六位数，或者用 `--otp=` 传进去。 |
| `npm error 404 Not Found - PUT` | registry 找不到要发布到的那个包。第一次发布时通常是因为镜像在应答，或者 scope 还不存在。 |
| 发布报告成功，但 `npm view` 一两分钟里回 404 | registry 传播延迟。等一会儿再问。 |
| `npm error EPUBLISHCONFLICT` | 那个版本已经发过了。同一个版本不能覆盖——把 `package.json` 里的版本号往上提，重新发布。 |
| 发布停在 `prepublishOnly` | `pnpm` 不在 PATH 上。那个脚本是 `pnpm run verify && pnpm test`；装上 pnpm，或者在能解析到它的 shell 里发布。 |

---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 四个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
