# Development and releasing

English | [中文](DEVELOPMENT.zh.md)

[← Back to the README](../README.md)

## This is a fork

This repository is a fork of
[chenmiao8563/dsh-token-ledger](https://github.com/chenmiao8563/dsh-token-ledger),
the original project. It published the plugin as
`@chenmiao8563/dsh-token-ledger` up to v1.1.2; this fork continues the work under
`@zhz8888/dsh-token-ledger`.

**The upstream's MIT notice stays.** MIT requires that the original notice travel
with the code, so [LICENSE](../LICENSE) carries both holders rather than replacing
the first one — and the same rule applies to anything taken from upstream verbatim.

**The original is kept as the `upstream` remote**, so the two histories can be
compared and upstream work can be pulled in:

```bash
git remote -v                              # origin: this fork, upstream: the original
git fetch upstream
git log --oneline upstream/main..main      # what this fork adds
```

**A change here is not upstreamed automatically.** A fix worth having upstream is
worth opening as an issue on
[chenmiao8563/dsh-token-ledger](https://github.com/chenmiao8563/dsh-token-ledger/issues),
and the two repositories may diverge from here on: the plugin's identity — its
package name, its client module id and its composition row — is this fork's own,
because the harness resolves the bundle by it.

## Development

This project is developed with pnpm, pinned by the `packageManager` field in
`package.json`. The published package itself carries no dependencies.

```bash
pnpm install         # devDependencies only: react, react-dom, and the slot registry DSH runs
pnpm test            # 297 tests in 14 files
pnpm run verify      # packaging invariants (dependency-free, no install scripts, no bare imports)
```

`pnpm test` uses Node's built-in test runner. In a restricted environment where
spawning a child process per test file is blocked, use
`pnpm run test:single-process`.

**What a change needs to take effect.** Both halves are read when the plugin mounts,
so editing `lib/index.js` *or* `lib/client.js` needs a DSH restart (or a plugin
reload) — refreshing the page is not enough, because the bundle's `rev` is computed
at mount and an unchanged URL keeps the browser's cached copy. Measured, not assumed:
with an isolated host running, a change to `lib/client.js` left both the served
bundle and its `rev` (`d683dd523466`) untouched, while a restart changed the rev
(`f55ee321db50`) and served the change. Exports are files, so if the one you are
looking at came from before a fix, its timestamp will say so.

The devDependencies are **test-only**. They are never installed for a consumer:
the package ships with no runtime dependencies and no install scripts, its peers are
optional declarations that nothing fetches, and `pnpm` does not install a dependency's
devDependencies. They exist
so the browser half can be checked against the real thing — React renders it, so
a hook-order or DOM-prop mistake fails instead of passing silently, and
`@deepseek-ai/dsh-client-ui-slots` validates the registration against the very
registry that DSH runs. Without them installed the affected tests skip with a
stated reason, so `pnpm test` still works from a fresh clone with no network.

See [docs/VERIFICATION.md](VERIFICATION.md) for what was actually verified
and how, including the evidence behind the fork rule.

**Changing a wording needs no restart.** The Chinese and English entries live in
`locale/zh.json` and `locale/en.json` as plain data: edit one and reload the
page. The host reads the files when they are asked for rather than once at
startup. The two languages must carry the same key set — a key missing from one
of them means a reader gets a word in one language and the key itself in the
other — and a test says so. When the browser half cannot read the dictionaries
the section still appears and its labels fall back to the keys.


## Releasing

**A tag push publishes. No token is stored anywhere.**

```bash
git tag v1.1.3 && git push origin v1.1.3
```

The tag must match the version in `package.json` — the workflow refuses to publish
otherwise — so use the version that is in the manifest, not this example.

This is the path for every release **after** the first one. A first release cannot
use it: OIDC cannot be configured for a package that does not exist yet, so the
first publish is done by hand — see [Publishing to npm](PUBLISHING.md).

`release.yml` then runs the tests and the packaging checks, confirms the tag matches
`package.json`, publishes over OIDC **trusted publishing**, attaches the tarball to a
GitHub release, and asserts that the version is on the registry before it reports
success — so a green run means published, not merely attempted.

That last assertion is not decoration. This pipeline failed on every tag from v0.5.0
to v0.8.0 while printing `404 Not Found - PUT`, which names a missing package when the
real problem is a missing credential, and the failure left the registry looking empty
for a couple of minutes after a publish that had in fact worked. Two causes, both now
guarded inside the workflow:

- **The npm CLI must be ≥ 11.5.1.** Node 22 ships npm 10, which cannot perform the
  OIDC exchange at all. The workflow runs Node 24, and asserts the version in its log.
- **`actions/setup-node`'s `registry-url` input must not be used.** It writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`, and npm reads
  that line, concludes a credential is already configured, and skips trusted
  publishing entirely — failing with `ENEEDAUTH`, which in a job that holds no
  credential reads like "you forgot to log in". A step before the publish now fails
  loudly if any `_authToken` line is present.

For the npm side to accept it, the package needs a **Trusted Publisher** configured at
npmjs.com (package → Settings → Trusted Publisher → GitHub Actions) with repository
`zhz8888/dsh-token-ledger`, workflow `release.yml`, and **no environment** —
an environment name that the workflow does not declare does not match, and the
registry answers only `OIDC token exchange error - package not found`.

Before trusted publishing existed, a version's first release was published by hand
with `npm publish --access public --otp=<six digits>`, because OIDC cannot be
configured for a package that does not exist yet. That path still works and still
requires a granular token with 2FA bypass, but it produces no provenance attestation,
and it is the path whose expired token started the v0.8.0 investigation. Prefer the tag.

Re-running a release is safe: the publish step is skipped when the version is already
on the registry, and the GitHub release is only created when it does not already exist.


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the three views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
