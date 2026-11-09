/**
 * Mirroring a release to the Gitea mirror.
 *
 * The GitHub release is the source of truth. This puts the same release on the
 * Gitea mirror: the same tag, the same notes and the same tarball, with the
 * links in the notes rewritten so they point at the mirror rather than at
 * GitHub.
 *
 * Only links *into this project's own repository* are rewritten. A link to
 * another repository — the upstream project, npm, a vendor — stays as it is,
 * because the mirror does not host those.
 *
 * @module dsh-token-ledger/scripts/lib/gitea
 */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/**
 * Rewrite the notes' links so they point at the mirror.
 *
 * @param {string} body - the release notes.
 * @param {string} base - the Gitea base URL.
 * @param {string} githubRepo - the GitHub repository path, owner/name.
 * @param {string} giteaRepo - the Gitea repository path, owner/name.
 * @returns {string} the rewritten notes.
 */
export function rewriteLinks(body, base, githubRepo, giteaRepo) {
  if (!body) return body
  const from = 'https://github.com/' + githubRepo
  const to = base + '/' + giteaRepo
  let out = body.split(from).join(to)
  // Gitea serves a file or a tree under /src/, not under /blob/ and /tree/.
  out = out
    .split(to + '/blob/')
    .join(to + '/src/commit/')
    .split(to + '/tree/')
    .join(to + '/src/commit/')
    .split(to + '/pull/')
    .join(to + '/pulls/')
  return out
}

/**
 * Ask git for the stored credentials of a host.
 *
 * @param {string} host - the host, with its port.
 * @returns {{username: string, password: string}} the credentials.
 */
function gitCredentials(host) {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=http\nhost=' + host + '\n\n',
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    throw new Error('git credential fill failed for ' + host)
  }
  const fields = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
  if (!fields.username || !fields.password) {
    throw new Error('no stored credentials for ' + host + '; log in to the mirror first')
  }
  return { username: fields.username, password: fields.password }
}

/**
 * Create or update a release on the Gitea mirror.
 *
 * @param {object} spec - what to publish.
 * @param {string} spec.base - the Gitea base URL.
 * @param {string} spec.repo - the Gitea repository, owner/name.
 * @param {string} spec.tag - the tag.
 * @param {string} spec.name - the release title.
 * @param {string} spec.body - the release notes.
 * @param {string} spec.tarball - the path of the tarball to attach.
 * @param {string} spec.tarballName - the file name to attach it under.
 * @param {string} [spec.githubRepo] - the GitHub repository, owner/name.
 * @returns {Promise<string>} a one-line summary.
 */
export async function mirrorRelease(spec) {
  const { base, repo, tag, name, body, tarball, tarballName } = spec
  const githubRepo = spec.githubRepo ?? repo
  const url = new URL(base)
  const credentials = gitCredentials(url.host)
  const auth =
    'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64')
  const api = base + '/api/v1/repos/' + repo
  const headers = { Authorization: auth, Accept: 'application/json' }

  const notes = rewriteLinks(body, base, githubRepo, repo)

  const list = await fetch(api + '/releases?limit=50', { headers })
  if (!list.ok) throw new Error('cannot list the releases on the mirror: ' + list.status)
  const existing = (await list.json()).find((release) => release.tag_name === tag)

  let release
  if (existing) {
    const response = await fetch(api + '/releases/' + existing.id, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: existing.target_commitish,
        name,
        body: notes,
        draft: false,
        prerelease: false,
      }),
    })
    if (!response.ok) throw new Error('cannot update the release ' + tag + ': ' + response.status)
    release = await response.json()
  } else {
    const response = await fetch(api + '/releases', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name,
        body: notes,
        draft: false,
        prerelease: false,
      }),
    })
    if (!response.ok) {
      throw new Error(
        'cannot create the release ' + tag + ': ' + response.status + ' ' + (await response.text()),
      )
    }
    release = await response.json()
  }

  const attached = new Set((release.assets ?? []).map((asset) => asset.name))
  if (!attached.has(tarballName)) {
    const form = new FormData()
    const bytes = await readFile(tarball)
    form.append('attachment', new Blob([bytes], { type: 'application/x-gtar' }), tarballName)
    const response = await fetch(
      api + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(tarballName),
      { method: 'POST', headers: { Authorization: auth }, body: form },
    )
    if (!response.ok) {
      throw new Error(
        'cannot attach ' + tarballName + ': ' + response.status + ' ' + (await response.text()),
      )
    }
  }

  return tag + ' is on the mirror, with ' + tarballName + ' attached'
}
