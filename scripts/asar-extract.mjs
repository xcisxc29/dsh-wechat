/**
 * Read the CSS the DSH shell actually ships, straight out of its `asar` archive.
 *
 * The archive is a UInt32 pair followed by a JSON directory tree, then every file's bytes in the
 * order the tree lists them. Walking that tree and slicing the requested files needs no
 * dependency, and it is the only way to see the real design tokens and page chrome rather than
 * guessing at them from a plugin's stylesheet.
 *
 * Usage: `node scripts/asar-extract.mjs <archive.asar> <substring> [outDir]`
 */
import { mkdirSync, openSync, readSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [, , archive, filter, outDir] = process.argv
if (archive === undefined || filter === undefined) {
  console.error('usage: node scripts/asar-extract.mjs <archive.asar> <substring> [outDir]')
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
      if (path.includes(filter)) matches.push({ path, start, size: Number(entry.size ?? 0) })
    }
  }
  walk(header, '')

  console.log(`${matches.length} 个匹配，归档内容共 ${offset} 字节`)
  if (outDir === undefined) {
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
