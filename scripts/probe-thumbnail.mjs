#!/usr/bin/env node
/**
 * Generate a WeChat-sized thumbnail with `sharp` and report what it produced.
 *
 * A chat image bubble is rendered from a thumbnail, which is why an item that carries
 * only the full-size object shows as an empty placeholder. `sharp` ships with the
 * application and resolves from the profile, so a real thumbnail can be produced
 * without adding an image dependency to this package.
 *
 * Usage:
 *   node scripts/probe-thumbnail.mjs [--image <path>]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// `sharp` ships with the application and is visible from the profile's node_modules,
// not from this repository, so resolve it from the profile.
const profileRequire = createRequire('C:/Users/XCISXC/.dsh/profiles/desktop/package.json')
const sharp = profileRequire('sharp')

/** Longest thumbnail edge. Chat bubbles never need more. */
const THUMB_MAX = 240

// Default to the newest inbound attachment, so this needs no argument.
const mediaDir = 'C:/Users/XCISXC/.dsh/dsh_wechat/媒体'
let source = process.argv.includes('--image')
  ? process.argv[process.argv.indexOf('--image') + 1]
  : undefined
if (source === undefined) {
  if (!existsSync(mediaDir)) {
    console.error(`❌ 没有可用的源图。请传 --image <path>，或先让微信发一张图。`)
    process.exit(1)
  }
  const files = readdirSync(mediaDir).filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
  if (files.length === 0) {
    console.error('❌ 媒体目录里没有图片')
    process.exit(1)
  }
  source = join(mediaDir, files.sort().reverse()[0])
}

const input = readFileSync(source)
console.log(`源图: ${source}`)
console.log(`  ${String(input.length)} 字节`)
console.log(`  sharp 识别: ${JSON.stringify(await sharp(input).metadata())}`.slice(0, 200))

const thumb = await sharp(input)
  .rotate() // honour EXIF, so a portrait photo is not sideways
  .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 72 })
  .toBuffer()

const meta = await sharp(thumb).metadata()
console.log('\n=== 生成的缩略图 ===')
console.log(`  ${String(thumb.length)} 字节`)
console.log(`  尺寸: ${String(meta.width)}x${String(meta.height)}  format=${String(meta.format)}`)
console.log(`  压缩比: ${(input.length / thumb.length).toFixed(1)}x`)

const out = join(repoRoot, '.probe-thumb.jpg')
writeFileSync(out, thumb)
console.log(`\n已写出: ${out}`)
console.log('如果这张缩略图看起来正常，就可以接进上传流程。')
