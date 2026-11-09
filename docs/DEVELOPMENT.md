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
pnpm test            # 445 tests in 17 files
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

**Nothing is published by a pipeline. You publish.**

```bash
pnpm run release                 # the whole thing, on this machine
pnpm run release -- --dry-run    # everything except the publish
```

`pnpm run release` runs `scripts/release.mjs`, and it runs its steps in order,
each one refusing to start until the one before it passed:

1. **Preflight.** The working tree must be clean, `pnpm` must be on the PATH
   (the manifest's `prepublishOnly` needs it), the tag must exist and must
   point at `HEAD`, and the version must not be on the registry already.
2. **The gate.** `pnpm run verify` and `pnpm test` — the checks the CI used
   to run on every push, now run here, against this checkout.
3. **Pack.** `npm pack`, into a temporary directory that is removed afterwards.
4. **Publish.** `npm publish --access public` against the npm registry, with
   your own npm login.
5. **Assert it landed.** The registry's read side is not instantly consistent,
   so the script keeps asking for up to four minutes before it calls it a
   failure. A publish that worked is not a publish that failed because
   `npm view` answered 404 for ninety seconds.
6. **The GitHub release.** The tag gets a release with the tarball attached. A
   tag that already has one is reused rather than fought with, so a re-run
   works.
7. **The Gitea mirror**, with `--mirror-gitea`. The same tag, the same notes
   and the same tarball, on the mirror, with the links in the notes rewritten
   to point at the mirror instead of at GitHub.

A release is made from a tag, and the tag is the version:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

The script refuses to publish when the tag does not match the version in
`package.json`, when the tag does not point at `HEAD`, or when that version is
already on the registry. A published version cannot be overwritten, so the
refusal is the only safe answer to each of those.

**You have to be logged in to npmjs.com, and the npm CLI has to be new enough.**
The publish is an ordinary authenticated publish:
`npm login --registry=https://registry.npmjs.org` once, and npm asks for the
one-time code from your authenticator at publish time (`--otp=123456` passes it
explicitly). See [Publishing to npm](PUBLISHING.md) for the registry this machine
is pointed at and for what to do when a publish fails.

### What the workflow used to do, and why it is gone

The release used to run on GitHub Actions and publish over OIDC **trusted
publishing**, so no long-lived token was stored anywhere. Trusted publishing
is an OIDC exchange that only a GitHub Actions runner can perform, so it
cannot outlive the workflow: with the workflow removed there is no runner left
to make the exchange. Publishing is local now, with your own npm credentials
— a token that you hold, rather than one the repository holds.

What the workflow checked is kept, because the checks were worth having:

| The workflow did this | It does this now |
| --- | --- |
| `pnpm test` on every push | `pnpm test`, as the release gate |
| `pnpm run verify` on every push | `pnpm run verify`, as the release gate |
| A job that packed the tarball and checked what was in it | `pnpm run check:tarball` — the same assertions, run against the tarball this machine packed |
| A job that installed the tarball into a throwaway project and audited a ledger with it | the same, inside `pnpm run check:tarball` |
| A publish that checked the tag against `package.json` | the preflight |
| A publish that asserted the version reached the registry | the step that waits for it |
| A step that created the GitHub release and attached the tarball | the last two steps of `scripts/release.mjs` |
| A Trusted Publisher configured at npmjs.com | your own npm login, with a one-time code at publish time |

### What one machine cannot check

The CI ran the tests on a matrix: Linux on Node 22 and 24, Windows on Node 22
and macOS on Node 24. A local run covers one machine and one Node. The
version range is not decoration — the CLI decodes zstd session frames, which
Node can only do from 22.15.0 — so the matrix was there to catch a runtime
that the development machine does not have.

That coverage is now a manual responsibility: run `pnpm run check` on each
platform and Node version you claim to support, and say in the release notes
which ones you ran it on.


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the four views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
