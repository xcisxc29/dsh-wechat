/**
 * Reading the session list off disk.
 *
 * The encoding and file-naming rules here were both derived by inspecting a real store after getting
 * them wrong twice — the first attempt produced a folder name that matched nothing, and the second
 * produced a list with no titles. Each is asserted against the exact string observed on disk, so a
 * future change to either fails loudly here instead of quietly emptying the user's conversation list.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  encodeWorkspaceDir,
  indexKeyFor,
  indexNamesFor,
  isSameWorkspace,
  listStoredSessions,
} from '../src/session-index.ts'

/**
 * Remove a temporary store, retried.
 *
 * Windows can refuse the rmdir with ENOTEMPTY while a write is still settling, which surfaces as a
 * test failure rather than a cleanup problem.
 *
 * @param home - Directory to remove.
 */
async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

test('the workspace folder name matches what the store actually writes', () => {
  // The shape observed on disk, with the account name replaced by a placeholder:
  // ~/.dsh/sessions/--C-Users-me-.dsh-dsh_wechat--. The rule is what matters, not whose account it was.
  assert.equal(
    encodeWorkspaceDir('C:\\Users\\me\\.dsh\\dsh_wechat'),
    '--C-Users-me-.dsh-dsh_wechat--',
  )
  // Runs of separators collapse: `C:` and the `\` after it share one dash, not two.
  assert.equal(encodeWorkspaceDir('C:\\a\\b'), '--C-a-b--')
  // Dots and underscores survive.
  assert.equal(encodeWorkspaceDir('/home/me/my_app'), '--home-me-my_app--')
})

test('the index key drops the session prefix, and both spellings are tried', () => {
  assert.equal(
    indexKeyFor('session-60301096-60301096-39c4-476d-aa41-946e29c149ef'),
    '60301096-60301096-39c4-476d-aa41-946e29c149ef',
  )
  // The store files the channel's own sessions under the full id and registry sessions under the
  // bare uuid, so both are attempted.
  assert.deepEqual(indexNamesFor('session-abc-123'), ['session-abc-123.json', 'abc-123.json'])
  // An id without the prefix has only one spelling.
  assert.deepEqual(indexNamesFor('abc-123'), ['abc-123.json'])
})

test('workspace comparison tolerates separators and case', () => {
  assert.equal(isSameWorkspace('C:\\Users\\me\\x', 'C:/Users/me/x', true), true)
  assert.equal(isSameWorkspace('C:\\Users\\me\\x\\', 'c:\\users\\ME\\x', true), true)
  // A different directory is not the same directory, however similar.
  assert.equal(isSameWorkspace('C:\\Users\\me\\x2', 'C:/Users/me/x', true), false)
})

test('on a case-sensitive filesystem, case distinguishes two directories', () => {
  /*
   * The bug this exists for: the comparison lower-cased every path on every platform. Correct on
   * Windows, wrong on Linux, where `/home/me/Projects` and `/home/me/projects` are two directories —
   * so a stranger's sessions would be counted as the channel's own and adopted under a workspace
   * they do not belong to.
   */
  assert.equal(
    isSameWorkspace('/home/me/Projects', '/home/me/projects', false),
    false,
    'case matters where the filesystem says it does',
  )
  assert.equal(isSameWorkspace('/home/me/x/', '/home/me/x', false), true, 'separators still normalise')
  assert.equal(isSameWorkspace('/home/me/x', '/home/me/x', false), true)
})

/**
 * Build a store shaped like the real one.
 *
 * @param root - Temporary directory to build under.
 * @param workspace - Workspace the sessions belong to.
 * @param sessions - Sessions to write, as `[id, title]`.
 * @param otherWorkspace - Optional second workspace with one session of its own.
 */
async function seedStore(
  root: string,
  workspace: string,
  sessions: [string, string][],
  otherWorkspace?: { cwd: string; id: string; title: string },
): Promise<void> {
  const indexDir = join(root, 'storages', 'session_projcache', 'sessions')
  // The store creates both trees itself; a test writing into them has to as well.
  await mkdir(indexDir, { recursive: true })
  const write = async (cwd: string, id: string, title: string): Promise<void> => {
    const dir = join(root, 'sessions', encodeWorkspaceDir(cwd), id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
    // The index is filed under the full id for the channel's own sessions, which is what the real
    // store does.
    await writeFile(
      join(indexDir, `${id}.json`),
      JSON.stringify({ version: 7, record: { identity: { cwd }, rows: { title: { val: title } } } }),
    )
  }
  for (const [id, title] of sessions) await write(workspace, id, title)
  if (otherWorkspace !== undefined) {
    await write(otherWorkspace.cwd, otherWorkspace.id, otherWorkspace.title)
  }
}

test('sessions of the channel workspace are listed with their titles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    await seedStore(home, workspace, [
      ['session-aaaa1111-aaaa1111-x', '修复登录'],
      ['session-bbbb2222-bbbb2222-x', '写周报'],
    ])

    const listed = await listStoredSessions(home, workspace)
    assert.deepEqual(
      listed.map((session) => session.title).sort(),
      ['修复登录', '写周报'].sort(),
    )
    assert.ok(listed.every((session) => session.sessionId.startsWith('session-')))
  } finally {
    await removeHome(home)
  }
})

test('sessions from another workspace are never offered', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const foreign = join(home, 'some_other_project')
    await seedStore(
      home,
      workspace,
      [['session-aaaa1111-aaaa1111-x', '我的对话']],
      { cwd: foreign, id: 'session-cccc3333-cccc3333-x', title: '别人的对话' },
    )

    const listed = await listStoredSessions(home, workspace)
    // A session from another workspace cannot be adopted — the host pins `cwd` — so offering it
    // would be offering a conversation that fails the moment it is picked.
    assert.deepEqual(
      listed.map((session) => session.title),
      ['我的对话'],
    )
  } finally {
    await removeHome(home)
  }
})

test('a session whose record contradicts its folder is dropped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const folder = join(home, 'sessions', encodeWorkspaceDir(workspace))
    const id = 'session-dddd4444-dddd4444-x'
    await mkdir(join(folder, id), { recursive: true })
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(folder, id, 'session.v4.jsonl.zstd'), 'x')
    // Filed under the workspace folder but recording a different `cwd`: the folder name is a lossy
    // encoding, so the record is what decides.
    await writeFile(
      join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      JSON.stringify({
        record: { identity: { cwd: 'C:\\elsewhere' }, rows: { title: { val: 'x' } } },
      }),
    )

    assert.deepEqual(await listStoredSessions(home, workspace), [])
  } finally {
    await removeHome(home)
  }
})

test('a missing store is an empty list, not a failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    // A fresh install has no store at all, and that must not throw — the channel still has to
    // answer /list with whatever it does know.
    assert.deepEqual(await listStoredSessions(join(home, 'nope'), 'C:\\x'), [])
  } finally {
    await removeHome(home)
  }
})

test('one unreadable index entry does not hide the others', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    await seedStore(home, workspace, [['session-aaaa1111-aaaa1111-x', '好的']])
    const broken = 'session-eeee5555-eeee5555-x'
    const folder = join(home, 'sessions', encodeWorkspaceDir(workspace), broken)
    await mkdir(folder, { recursive: true })
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(folder, 'session.v4.jsonl.zstd'), 'x')
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${broken}.json`), '{')

    const listed = await listStoredSessions(home, workspace)
    assert.equal(listed.length, 2, 'the damaged entry is still listed, just untitled')
    assert.equal(listed.find((session) => session.sessionId === broken)?.title, '')
    assert.equal(listed.find((session) => session.sessionId.startsWith('session-aaaa'))?.title, '好的')
  } finally {
    await removeHome(home)
  }
})
