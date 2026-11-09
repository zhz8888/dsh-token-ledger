# 发布到 npm

English | [中文](PUBLISHING.zh.md)

[← Back to the README](../README.zh.md)

这个包是从本仓库手工发到 npm 的。路只有一条，而且是一条脚本：

```bash
pnpm run release
```

`scripts/release.mjs` 会按顺序做完所有事：各项检查、打包、发布、等 registry 上出现这个
版本、建 GitHub Release、把 tarball 挂上去。每一步断言什么、为什么这么断言，见
[开发与发布](DEVELOPMENT.zh.md#发布)。

留给你的只有一件脚本替你做不了的事：**已经登录 npmjs.com**。

## 开始之前

**这台机器默认的 registry 是镜像，不是 npm。** npm 配的是
`registry=https://registry.npmmirror.com`，那是一个只读镜像：它能提供包，但不接收包。
所以下面每条发布命令都把官方 registry 明写出来，发布脚本的默认值也是它
（`--registry` 可以改）。

**你必须已经登录 npmjs.com。** 这台机器目前没有 npm 凭据——`~/.npmrc` 里只有一行
`registry`。先登录一次：

```bash
npm login --registry=https://registry.npmjs.org
```

它会问用户名、密码，以及开了两步验证时的认证器动态口令。
`npm whoami --registry=https://registry.npmjs.org` 随后会打印这些命令将以哪个账号发布
——确认它就是持有 `@zhz8888` 这个 scope 的账号。

**npm CLI 的版本要够新。** npm 随 Node 一起发布，发布脚本用的就是 PATH 上的那个 npm。
Node 22 自带 npm 10，比 registry 这边要求的工具链旧；`npm --version` 会告诉你现在
是哪一个。

**pnpm 必须在你的 PATH 上。** 清单里的 `prepublishOnly` 跑的是
`pnpm run verify && pnpm test`，npm 发布时会执行这个脚本。

## 发布

**1. 待在发布提交上，工作区要干净。**

```bash
git status --short          # 必须什么都不打印
git log --oneline -1        # release: 1.2.0
```

**2. 打 tag。**

```bash
git tag v1.2.0 && git push origin v1.2.0
```

tag 必须与 `package.json` 里的版本一致。不一致时脚本会拒绝发布；tag 不指向 `HEAD`
时也会拒绝——发布以 tag 为准，要发布的东西就得是那个 tag。

**3. 确认这个版本还不在 registry 上。**

```bash
npm view @zhz8888/dsh-token-ledger versions --registry=https://registry.npmjs.org
```

这里回 404 说明这个版本还没发布过——发布之前正该如此，重跑时就**不该**如此。脚本也会
查这一条，并且拒绝覆盖已经发布的版本：已发布的版本不能被覆盖。

**4. 跑发布脚本。**

```bash
pnpm run release
```

它会跑测试与打包检查、打出 tarball、发布、等 registry 上出现该版本，并建好带 tarball 的
GitHub Release。`--dry-run` 会做完除发布以外的一切，`--otp=123456` 可以显式传动态口令，
不必等它提示输入。

如果你更想自己驱动 npm，脚本里那一步发布就是：

```bash
npm publish --access public --registry=https://registry.npmjs.org
```

npm 会向你要认证器上的动态口令。用 token 而不是交互登录时，显式传码：

```bash
npm publish --access public --otp=123456 --registry=https://registry.npmjs.org
```

在新 scope 里做首次发布时 `--access public` 不是可选项：不加它，包会以私有方式创建。
清单里已经带了 `publishConfig.access: public`，两种方式都覆盖到了。

**5. 确认它落地了。**

```bash
npm view @zhz8888/dsh-token-ledger version --registry=https://registry.npmjs.org
```

在新 scope 里做首次发布后，packument 可能要一两分钟才可读——`dist-tags` 和 tarball 先上线，
读侧才追上。那是 registry 的传播延迟，不是发布失败：`npm view` 回 404 几分钟并不说明上传
没成功。发布脚本会为这件事最多等四分钟，之后才判定失败。

## 为什么没有 Trusted Publisher

发布过去由 GitHub Actions 的 workflow 用 OIDC **trusted publishing** 完成，任何地方都不用
存放长期有效的 token。trusted publishing 是一场只有 GitHub Actions runner 才能做的 OIDC 交换，
所以它活不过 workflow：workflow 没了，做交换的 runner 也就没了。

于是发布回到本地，用你自己的 npm 凭据——那是你自己持有的 token，而不是仓库持有的。
workflow 做过的检查都保留了下来，它们就是发布驱动脚本会跑的那些脚本。

## 出问题时

| 症状 | 是什么 |
| --- | --- |
| `npm error code ENEEDAUTH` | 没登录，或者登录到了镜像而不是 npmjs.com。`npm whoami --registry=https://registry.npmjs.org` 会告诉你是哪个。 |
| `npm error code E403` / *you do not have permission to publish* | 登录的账号不对，或者该账号在 `@zhz8888` scope 上没有发布权限。 |
| `npm error EOTP`，或者它向你要验证码 | 开了两步验证。输入认证器上的六位数字，或者用 `--otp=` 传。 |
| `npm error 404 Not Found - PUT` | registry 找不到要发布到这个包。首次发布时通常是镜像在应答，或者 scope 还不存在。 |
| 发布报告成功，但 `npm view` 有一两分钟回 404 | registry 传播延迟。等一下再问——发布脚本已经会为这件事最多等四分钟。 |
| `npm error EPUBLISHCONFLICT` | 这个版本已经发布过了。版本不能被覆盖——把 `package.json` 里的版本号往上加再发一次。 |
| 发布停在 `prepublishOnly` | PATH 上没有 pnpm。那个脚本是 `pnpm run verify && pnpm test`；装上 pnpm，或者换一个能解析到它的 shell 来发布。 |
| 脚本拒绝：*tag 不指向 HEAD* | 你不在被打 tag 的那个提交上。`git checkout v1.2.0`（或者重新打 tag）再从那里发布。 |
| 脚本拒绝：*已经在 registry 上* | 这个版本已发布。把 `package.json` 里的版本号往上加再发；`--force` 是留给少数你确定另有原因的情况的。 |

---

## 更多文档

- [这些数字是怎么数出来的](COUNTING.zh.md) —— 计数规则、fork 与 resume、以及审计
- [设置页](SETTINGS-PAGE.zh.md) —— 四个页签的完整说明
- [配置](CONFIGURATION.zh.md) —— 插件会读到的每一个配置项
- [兼容性](COMPATIBILITY.zh.md) —— 需要哪个 DSH，以及它会碰什么
- [开发与发布](DEVELOPMENT.zh.md) —— 怎么改这个插件，以及怎么发布它
- [验证记录](VERIFICATION.zh.md) —— 实际验证了什么，以及哪些没有验证
- [全部文档](README.zh.md) —— 索引
