# Publishing to npm

English | [中文](PUBLISHING.zh.md)

[← Back to the README](../README.md)

The package reaches npm from this checkout, by hand. There is one path, and it
is a script:

```bash
pnpm run release
```

`scripts/release.mjs` does the whole thing in order: the checks, the pack, the
publish, the wait for the registry to show the version, the GitHub release, and
the tarball attached to it. See
[Development and releasing](DEVELOPMENT.md#releasing) for what each step asserts
and why.

What is left for you is the one thing a script cannot do for you: **be logged in
to npmjs.com**.

## Before you start

**The default registry here is a mirror, not npm.** npm is configured with
`registry=https://registry.npmmirror.com`, and that is a read-only mirror: it
serves packages, it does not accept them. Every publishing command below therefore
spells the official registry out, and the release script defaults to it as well
(`--registry` overrides it).

**You have to be logged in to npmjs.com.** The machine carries no npm credentials
at the moment — `~/.npmrc` has only a `registry` line in it. Log in once:

```bash
npm login --registry=https://registry.npmjs.org
```

That asks for a username, a password and, with 2FA on, a one-time code from your
authenticator. `npm whoami --registry=https://registry.npmjs.org` then prints the
account the commands will publish as — check that it is the one that owns the
`@zhz8888` scope.

**The npm CLI has to be new enough.** npm ships with Node, and the release script
publishes with the npm on the PATH. Node 22 ships npm 10, which is older than
this registry's tooling wants; `npm --version` says which one you have.

**pnpm has to be on your PATH.** The manifest's `prepublishOnly` runs
`pnpm run verify && pnpm test`, and npm runs that script when it publishes.

## The publish

**1. Be on the release commit, with a clean tree.**

```bash
git status --short          # must print nothing
git log --oneline -1        # release: 1.2.0
```

**2. Tag it.**

```bash
git tag v1.2.0 && git push origin v1.2.0
```

The tag must match the version in `package.json`. The script refuses to publish
when it does not, and it refuses when the tag does not point at `HEAD` — a
release is made from the tag, so the tag has to be the thing being released.

**3. Check that the version is not already on the registry.**

```bash
npm view @zhz8888/dsh-token-ledger versions --registry=https://registry.npmjs.org
```

A 404 here means the version has not been published — which is what you want
before a release, and what you do **not** want if you are re-running this. The
script checks this too and refuses to publish over a version that is already
there: a published version cannot be overwritten.

**4. Run the release script.**

```bash
pnpm run release
```

It runs the tests and the packaging checks, packs the tarball, publishes it,
waits for the registry to show the version, and creates the GitHub release with
the tarball attached. `--dry-run` does everything except the publish, and
`--otp=123456` passes the one-time code explicitly instead of waiting for the
prompt.

If you would rather drive npm yourself, the script's publish step is exactly:

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
few minutes does not mean the upload failed. The release script waits up to four
minutes for this and only then calls it a failure.

## Why there is no Trusted Publisher

Releases used to be published by a GitHub Actions workflow over OIDC **trusted
publishing**, with no long-lived token stored anywhere. Trusted publishing is an
OIDC exchange that only a GitHub Actions runner can perform, so it cannot
outlive the workflow: the workflows are gone, and with them the runner that
would have made the exchange.

Publishing is local now, with your own npm credentials — a token you hold, rather
than one the repository holds. The checks the workflow made are kept; they are
the scripts the release driver runs.

## If something goes wrong

| Symptom | What it is |
| --- | --- |
| `npm error code ENEEDAUTH` | Not logged in, or logged in to the mirror instead of npmjs.com. `npm whoami --registry=https://registry.npmjs.org` tells you which. |
| `npm error code E403` / *you do not have permission to publish* | Logged in as the wrong account, or the account has no publish rights on the `@zhz8888` scope. |
| `npm error EOTP`, or it asks for a code | 2FA is on. Enter the six digits from the authenticator, or pass `--otp=`. |
| `npm error 404 Not Found - PUT` | The registry could not find the package to publish to. On a first publish that is usually the mirror answering, or the scope not existing yet. |
| The publish reports success but `npm view` answers 404 for a minute or two | Registry propagation. Wait, then ask again — the release script already waits up to four minutes. |
| `npm error EPUBLISHCONFLICT` | That version is already published. A version cannot be overwritten — bump the number in `package.json` and release again. |
| The publish stops at `prepublishOnly` | `pnpm` is not on the PATH. The script is `pnpm run verify && pnpm test`; install pnpm or run the publish from a shell where it resolves. |
| The script refuses: *the tag does not point at HEAD* | You are not on the tagged commit. `git checkout v1.2.0` (or re-tag) and publish from there. |
| The script refuses: *already on the registry* | That version is published. Bump `package.json` and release again; `--force` is there for the rare case where you know better. |

---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the four views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
