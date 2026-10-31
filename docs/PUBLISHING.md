# Publishing to npm

English | [中文](PUBLISHING.zh.md)

[← Back to the README](../README.md)

Two ways out of this repository reach npm, and they are not interchangeable at the
start:

| | What it is | When it applies |
| --- | --- | --- |
| **A tag push** | `git push origin v1.2.0` runs `release.yml`, which publishes over OIDC **trusted publishing** — no token stored anywhere. | Every release **after** the package exists on npm and a Trusted Publisher is configured for this repository. |
| **A manual publish** | `npm publish` from this checkout, with your own npm login and a one-time code. | The **first** release of a package. OIDC cannot be configured for a package that does not exist yet. |

`@zhz8888/dsh-token-ledger` is at its first release, so it goes out by hand. This
page is the manual path. After it is on npm, configure the Trusted Publisher and
every later release is a tag push again.

## Before you start

**The default registry here is a mirror, not npm.** npm is configured with
`registry=https://registry.npmmirror.com`, and that is a read-only mirror: it
serves packages, it does not accept them. Every publishing command below therefore
spells the official registry out.

**You have to be logged in to npmjs.com.** The machine carries no npm credentials
at the moment — `~/.npmrc` has only a `registry` line in it. Log in once:

```bash
npm login --registry=https://registry.npmjs.org
```

That asks for a username, a password and, with 2FA on, a one-time code from your
authenticator. `npm whoami --registry=https://registry.npmjs.org` then prints the
account the commands will publish as — check that it is the one that owns the
`@zhz8888` scope.

**The npm CLI has to be new enough.** Trusted publishing needs npm ≥ 11.5.1; this
machine has 11.12.1. Node 22 ships npm 10, which cannot do the OIDC exchange at
all.

**pnpm has to be on your PATH.** The manifest's `prepublishOnly` runs
`pnpm run verify && pnpm test`, and npm runs that script when it publishes.

## The publish

**1. Be on the release commit, with a clean tree.**

```bash
git status --short          # must print nothing
git log --oneline -1        # release: 1.2.0
```

**2. Check that the version is not already on the registry.**

```bash
npm view @zhz8888/dsh-token-ledger versions --registry=https://registry.npmjs.org
```

A 404 here means the version has not been published — which is what you want
before a first release, and what you do **not** want if you are re-running this.

**3. Pack it and look at what you are about to publish.**

```bash
npm publish --dry-run --access public --registry=https://registry.npmjs.org
```

The dry run prints the file list and the package size without uploading anything.
It should be 38 files: the two READMEs, `CHANGELOG.md`, `LICENSE`,
`cordis.patch.yml`, `package.json`, the binary, the fifteen `lib/` modules, and the
sixteen documents under `docs/`.

Two lines in that output are worth reading rather than scrolling past — the registry
it names, and the tag and access it will use:

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)
+ @zhz8888/dsh-token-ledger@1.2.0
```

If the first line names the mirror instead, stop: the registry override did not take.

**4. Publish it.**

```bash
npm publish --access public --registry=https://registry.npmjs.org
```

npm asks for the one-time code from your authenticator. With a token instead of an
interactive login, pass the code explicitly:

```bash
npm publish --access public --otp=123456 --registry=https://registry.npmjs.org
```

`--access public` is not optional on a first publish in a new scope: without it the
package is created private. The manifest already carries
`publishConfig.access: public`, which covers it either way.

**5. Confirm it landed.**

```bash
npm view @zhz8888/dsh-token-ledger version --registry=https://registry.npmjs.org
```

The packument can take a minute or two to become readable after a first publish in
a new scope — `dist-tags` and the tarball go live before the read side catches up.
That is registry propagation, not a failed publish: `npm view` answering 404 for a
few minutes does not mean the upload failed.

## Then: hand the later releases to the tag push

Now that the package exists, npmjs.com can be told to trust this repository:

1. npmjs.com → **@zhz8888 / dsh-token-ledger** → Settings → **Trusted Publisher**
   → GitHub Actions.
2. Repository `zhz8888/dsh-token-ledger`, workflow `release.yml`, and **no
   environment** — an environment the workflow does not declare does not match, and
   the registry answers only `OIDC token exchange error - package not found`.
3. Save it. The next release is a tag push:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`release.yml` then runs the tests and the packaging checks, confirms the tag matches
`package.json`, publishes, attaches the tarball to a GitHub release, and asserts the
version is on the registry before it reports success — so a green run means
published, not merely attempted.

## If something goes wrong

| Symptom | What it is |
| --- | --- |
| `npm error code ENEEDAUTH` | Not logged in, or logged in to the mirror instead of npmjs.com. `npm whoami --registry=https://registry.npmjs.org` tells you which. |
| `npm error code E403` / *you do not have permission to publish* | Logged in as the wrong account, or the account has no publish rights on the `@zhz8888` scope. |
| `npm error code EOTP`, or it asks for a code | 2FA is on. Enter the six digits from the authenticator, or pass `--otp=`. |
| `npm error 404 Not Found - PUT` | The registry could not find the package to publish to. On a first publish that is usually the mirror answering, or the scope not existing yet. |
| The publish reports success but `npm view` answers 404 for a minute or two | Registry propagation. Wait, then ask again. |
| `npm error EPUBLISHCONFLICT` | That version is already published. A version cannot be overwritten — bump the number in `package.json` and release again. |
| The publish stops at `prepublishOnly` | `pnpm` is not on the PATH. The script is `pnpm run verify && pnpm test`; install pnpm or run the publish from a shell where it resolves. |

---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the four views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
