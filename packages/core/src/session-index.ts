/**
 * Reading the session list from DSH's own on-disk store.
 *
 * ## Why this exists
 *
 * The host exposes `sessionController.list()`, and on the machine this was built for it returns an
 * empty array — so `/list` answered with nothing, and the agent had to read the store itself to
 * tell the user anything at all. The store is always there: DSH writes every session to
 * `<home>/sessions/<encoded-cwd>/<session-id>/`, and every title to
 * `<home>/storages/session_projcache/sessions/<uuid>.json`.
 *
 * ## Why the filter is not optional
 *
 * The store holds every workspace on the machine — 73 sessions for the author's project directory
 * against 9 for the channel's own. A session belonging to another workspace **cannot be adopted**:
 * the host pins `cwd` for the life of a session and rejects an adopt whose working directory
 * differs. Offering one would produce a list of conversations that all fail on selection, so only
 * the channel's own workspace is read.
 *
 * @module @dsh-wechat/core/session-index
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One session as the store describes it. */
export interface StoredSession {
  sessionId: string
  title: string
  updatedAt: number
  /** Working directory the session belongs to, or empty when the record does not say. */
  cwd: string
}

/**
 * Encode a working directory the way the store names its folder.
 *
 * Runs of separators collapse into a single dash, so `C:\Users\me\.dsh\dsh_wechat` becomes
 * `--C-Users-me-.dsh-dsh_wechat--`. Dots and underscores survive; `C:` and the following `\` share
 * one dash. A leading or trailing separator is dropped first, so a Unix path does not gain an extra
 * dash: `--` plus `-home-me` would be three. Derived by matching the store on disk after two wrong
 * guesses, which is why the exact strings are asserted in the tests.
 *
 * The encoding is still lossy in principle (`a\b` and `a-b` collide), so it is only ever used to
 * *narrow* the search and the authoritative check is the `cwd` recorded inside each session.
 *
 * @param cwd - Absolute working directory.
 * @returns The folder name the store would use.
 */
export function encodeWorkspaceDir(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '').replace(/^[\\/]+/, '')
  return `--${trimmed.replace(/[\\/:]+/g, '-')}--`
}

/**
 * Whether a recorded `cwd` belongs to the given workspace.
 *
 * Compared case-insensitively and with separators normalised, because the same directory is written
 * as `C:\Users\me\x` and `C:/Users/me/x` depending on who recorded it.
 *
 * @param recorded - `cwd` from the session index.
 * @param workspace - The channel's workspace directory.
 * @returns Whether the two name the same place.
 */
export function isSameWorkspace(recorded: string, workspace: string): boolean {
  const normalise = (value: string): string =>
    value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalise(recorded) === normalise(workspace)
}

/**
 * Strip the `session-` prefix to get the key the index is filed under.
 *
 * @param sessionId - Session id as the channel uses it.
 * @returns The bare uuid the store names its index file with.
 */
export function indexKeyFor(sessionId: string): string {
  return sessionId.replace(/^session-/, '')
}

/**
 * The index file names to try for a session.
 *
 * Two forms exist in the store: sessions created through the workspace registry are filed under the
 * bare uuid, while the channel's own are filed under the full `session-<uuid>`. Both are tried
 * rather than one being assumed, because guessing wrong here silently produces a list with no
 * titles — which is exactly how this was found.
 *
 * @param sessionId - Session id as the channel uses it.
 * @returns Candidate file names, most likely first.
 */
export function indexNamesFor(sessionId: string): string[] {
  const bare = indexKeyFor(sessionId)
  return bare === sessionId ? [`${sessionId}.json`] : [`${sessionId}.json`, `${bare}.json`]
}

/**
 * Read one session's index entry.
 *
 * The index is versioned per row (`{ver, seq, val}`), and the value is what matters. A missing or
 * unreadable file yields empty fields rather than failing the listing: one damaged entry must not
 * hide every other conversation.
 *
 * @param storeDir - Root of the index store.
 * @param sessionId - Session to read.
 * @returns The recorded title and working directory, either possibly empty.
 */
async function readIndex(
  storeDir: string,
  sessionId: string,
): Promise<{ title: string; cwd: string }> {
  for (const name of indexNamesFor(sessionId)) {
    try {
      const raw = await readFile(join(storeDir, name), 'utf-8')
      const parsed = JSON.parse(raw) as {
        record?: { identity?: { cwd?: unknown }; rows?: { title?: { val?: unknown } } }
      }
      const title = parsed.record?.rows?.title?.val
      const cwd = parsed.record?.identity?.cwd
      return {
        title: typeof title === 'string' ? title : '',
        cwd: typeof cwd === 'string' ? cwd : '',
      }
    } catch {
      // Try the next spelling.
    }
  }
  return { title: '', cwd: '' }
}

/**
 * List the sessions belonging to one workspace, newest first.
 *
 * @param home - DSH home directory.
 * @param workspace - The channel's workspace directory.
 * @returns Sessions it can actually switch to.
 */
export async function listStoredSessions(
  home: string,
  workspace: string,
): Promise<StoredSession[]> {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  // The folder name is a lossy encoding, so the candidates are narrowed by it and confirmed by the
  // recorded `cwd` below.
  let candidates: string[]
  try {
    const dirs = await readdir(sessionsRoot, { withFileTypes: true })
    candidates = dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }

  const exact = encodeWorkspaceDir(workspace)
  const wanted = candidates.filter((name) => name === exact)

  const sessions: StoredSession[] = []
  for (const folder of wanted) {
    let ids: string[]
    try {
      const entries = await readdir(join(sessionsRoot, folder), { withFileTypes: true })
      ids = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => entry.name)
    } catch {
      continue
    }

    for (const sessionId of ids) {
      const [index, updatedAt] = await Promise.all([
        readIndex(indexDir, sessionId),
        newestMtime(join(sessionsRoot, folder, sessionId)),
      ])
      // The folder name is a lossy encoding, so a session is only offered when its own record says
      // it belongs here. Without this check a differently-spelled path could contribute sessions
      // that would fail the moment the user picked one.
      if (index.cwd !== '' && !isSameWorkspace(index.cwd, workspace)) continue
      sessions.push({ sessionId, title: index.title, updatedAt, cwd: index.cwd })
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * List every session on the machine, grouped by the workspace it belongs to.
 *
 * Used when the user asks to see conversations beyond the channel's own: the store holds all of
 * them, and each record names its working directory, so the grouping is read rather than inferred.
 *
 * @param home - DSH home directory.
 * @returns Sessions per workspace path, each list newest first.
 */
export async function listAllStoredSessions(
  home: string,
): Promise<Map<string, StoredSession[]>> {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  let folders: string[]
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true })
    folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return new Map()
  }

  const byWorkspace = new Map<string, StoredSession[]>()
  for (const folder of folders) {
    let ids: string[]
    try {
      const entries = await readdir(join(sessionsRoot, folder), { withFileTypes: true })
      ids = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => entry.name)
    } catch {
      continue
    }

    for (const sessionId of ids) {
      const [index, updatedAt] = await Promise.all([
        readIndex(indexDir, sessionId),
        newestMtime(join(sessionsRoot, folder, sessionId)),
      ])
      // Grouped by the record, not the folder: the folder name is a lossy encoding and would merge
      // unrelated directories under one heading.
      const key = index.cwd
      const list = byWorkspace.get(key)
      const entry: StoredSession = { sessionId, title: index.title, updatedAt, cwd: index.cwd }
      if (list === undefined) byWorkspace.set(key, [entry])
      else list.push(entry)
    }
  }

  for (const list of byWorkspace.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return byWorkspace
}

/**
 * The working directory one session belongs to.
 *
 * Needed to adopt a session from another workspace: the host pins a session's `cwd`, so resuming one
 * means naming *its* workspace rather than the channel's own.
 *
 * @param home - DSH home directory.
 * @param sessionId - Session to look up.
 * @returns The recorded directory, or undefined when the store does not know the session.
 */
export async function storedSessionWorkspace(
  home: string,
  sessionId: string,
): Promise<string | undefined> {
  const index = await readIndex(join(home, 'storages', 'session_projcache', 'sessions'), sessionId)
  return index.cwd === '' ? undefined : index.cwd
}

/**
 * When a session directory was last written.
 *
 * Used as the ordering key because a session's own transcript is compressed and reading it to find
 * a timestamp would cost far more than the ordering is worth.
 *
 * @param dir - Session directory.
 * @returns Milliseconds since epoch, or 0 when it cannot be read.
 */
async function newestMtime(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let newest = 0
    for (const entry of entries) {
      const info = await stat(join(dir, entry.name))
      const at = info.mtimeMs
      if (Number.isFinite(at) && at > newest) newest = at
    }
    return newest
  } catch {
    return 0
  }
}
