/**
 * Read files out of an `asar` archive, by name or by content.
 *
 * The archive is a UInt32 pair followed by a JSON directory tree, then every file's bytes in the
 * order the tree lists them. Walking that tree and slicing the requested files needs no dependency,
 * and it is the only way to see the real design tokens, the real page chrome, or whether a feature
 * exists at all — rather than guessing from a plugin's stylesheet.
 *
 * Usage:
 *   node scripts/asar-extract.mjs <archive.asar> <path-substring> [outDir]
 *   node scripts/asar-extract.mjs <archive.asar> --grep <text> [outDir]
 *
 * `--grep` searches file **contents**. That mode is why this option exists: an earlier version matched
 * only paths, and searching it for `添加插件` returned nothing — which was read as "the feature does not
 * exist" when in fact the search could never have matched. A filename filter cannot answer a question
 * about what the application says.
 */
import { mkdirSync, openSync, readSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [, , archive, filterOrFlag, outDir] = process.argv
if (archive === undefined || filterOrFlag === undefined) {
  console.error('usage: node scripts/asar-extract.mjs <archive.asar> <path-substring> [outDir]')
  console.error('       node scripts/asar-extract.mjs <archive.asar> --grep <text> [outDir]')
  process.exit(1)
}
const byContent = filterOrFlag === '--grep'
const filter = byContent ? (process.argv[4] ?? '') : filterOrFlag
if (byContent && filter === '') {
  console.error('--grep 需要一个搜索词')
  process.exit(1)
}

const fd = openSync(archive, 'r')
try {
  // Layout: a pickle of one UInt32 (4), then the JSON byte length, then the length again, then the
  // JSON, then padding to a 4-byte boundary. Only the first length counts for the read; parsing
  // stops at the JSON's closing brace so the trailing padding does not break it.
  const prefix = Buffer.alloc(16)
  readSync(fd, prefix, 0, 16, 0)
  const jsonSize = prefix.readUInt32LE(4)
  const headerBytes = Buffer.alloc(jsonSize)
  readSync(fd, headerBytes, 0, jsonSize, 16)
  const text = headerBytes.toString('utf8')
  const lastBrace = text.lastIndexOf('}')
  const header = JSON.parse(text.slice(0, lastBrace + 1))

  // File contents follow the header plus its padding to a 4-byte boundary.
  const headerFieldSize = 8 + jsonSize
  let offset = 8 + headerFieldSize
  const matches = []
  const walk = (node, prefixPath) => {
    for (const name of Object.keys(node.files ?? {})) {
      const entry = node.files[name]
      const path = prefixPath === '' ? name : `${prefixPath}/${name}`
      if (entry.files !== undefined) {
        walk(entry, path)
        continue
      }
      const start = offset
      offset += Number(entry.size ?? 0)
      // In content mode every text file is a candidate; the header is walked once and the bytes are
      // read afterwards. Offsets come from the tree's declared sizes either way, so they stay correct.
      if (byContent ? true : path.includes(filter)) {
        matches.push({ path, start, size: Number(entry.size ?? 0) })
      }
    }
  }
  walk(header, '')

  console.log(`${matches.length} 个匹配，归档内容共 ${offset} 字节`)

  if (byContent) {
    // Content search reads every file, so only files that can hold text are considered. A Chinese UI
    // string lives in `.js` or `.json`, and skipping binaries keeps this from reading an entire
    // archive to no purpose.
    const needle = Buffer.from(filter, 'utf8')
    let hits = 0
    for (const match of matches) {
      if (!/\.(js|mjs|cjs|json|css|html|yml|yaml|md)$/.test(match.path)) continue
      const data = Buffer.alloc(match.size)
      readSync(fd, data, 0, match.size, match.start)
      const at = data.indexOf(needle)
      if (at < 0) continue
      hits += 1
      // A short window around the hit, with newlines flattened: the point is to see what the text is
      // part of, not to read the file.
      const from = Math.max(0, at - 120)
      const snippet = data
        .subarray(from, Math.min(data.length, at + needle.length + 120))
        .toString('utf8')
        .replace(/\s+/g, ' ')
      console.log(`  ${match.path}`)
      console.log(`      …${snippet}…`)
      if (outDir !== undefined) {
        const target = join(outDir, match.path.replace(/^\/+/, ''))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, data)
      }
      if (hits >= 40) break
    }
    console.log(`\n${hits} 个文件含 ${JSON.stringify(filter)}。`)
  } else if (outDir === undefined) {
    for (const match of matches.slice(0, 40)) console.log(`  ${String(match.size).padStart(9)}  ${match.path}`)
    console.log('\n给出 outDir 可导出文件。')
  } else {
    for (const match of matches) {
      const data = Buffer.alloc(match.size)
      readSync(fd, data, 0, match.size, match.start)
      const target = join(outDir, match.path.replace(/^\/+/, ''))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
      console.log(`  ${String(match.size).padStart(9)}  ${match.path}`)
    }
  }
} finally {
  closeSync(fd)
}
