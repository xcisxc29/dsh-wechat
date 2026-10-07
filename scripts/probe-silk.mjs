#!/usr/bin/env node
/**
 * Round-trip the voice transcoder: PCM → SILK → our decoder → WAV.
 *
 * A wrong sample rate or channel count produces a WAV that still looks structurally valid
 * and plays at the wrong speed or pitch, which is not something a duration check alone would
 * catch. So this builds a known tone, encodes it with the same library the service's voice
 * notes come from, and asserts the decoded WAV is complete and plausibly the same length.
 *
 * Usage:
 *   node scripts/probe-silk.mjs
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const core = pathToFileURL(join(repoRoot, 'packages/core/lib/index.js')).href
const { silkToWav, pcmToWav, silkAvailable, SILK_SAMPLE_RATE } = await import(core)

const silk = createRequire('C:/Users/XCISXC/.dsh/profiles/desktop/package.json')('silk-wasm')

console.log(`silk-wasm 可用: ${String(silkAvailable())}   采样率: ${String(SILK_SAMPLE_RATE)}`)

// One second of a 440 Hz tone, mono, 16-bit little-endian.
const seconds = 1
const samples = SILK_SAMPLE_RATE * seconds
const pcm = Buffer.alloc(samples * 2)
for (let i = 0; i < samples; i += 1) {
  pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / SILK_SAMPLE_RATE)), i * 2)
}
console.log(`\n源 PCM: ${String(pcm.length)} 字节 = ${String(seconds)} 秒 @ ${String(SILK_SAMPLE_RATE)} Hz`)

const encoded = await silk.encode(new Uint8Array(pcm), SILK_SAMPLE_RATE)
console.log(`编码为 SILK: ${String(encoded.data.length)} 字节, 时长 ${String(encoded.duration)}ms`)

// This is the exact path an inbound voice note takes.
const decoded = await silkToWav(Buffer.from(encoded.data))
if (decoded === undefined) {
  console.log('\n❌ silkToWav 返回 undefined —— 转码链路失败')
  process.exit(1)
}

const wav = decoded.data
console.log(`\n=== 转码结果 ===`)
console.log(`  WAV: ${String(wav.length)} 字节, 时长 ${String(decoded.durationMs)}ms`)

// Header checks.
const checks = {
  'RIFF 标识': wav.toString('ascii', 0, 4) === 'RIFF',
  'WAVE 标识': wav.toString('ascii', 8, 12) === 'WAVE',
  'fmt  块': wav.toString('ascii', 12, 16) === 'fmt ',
  'data 块': wav.toString('ascii', 36, 40) === 'data',
  'PCM 格式 (1)': wav.readUInt16LE(20) === 1,
  '单声道 (1)': wav.readUInt16LE(22) === 1,
  [`采样率 ${String(SILK_SAMPLE_RATE)}`]: wav.readUInt32LE(24) === SILK_SAMPLE_RATE,
  '字节率 = 采样率x2': wav.readUInt32LE(28) === SILK_SAMPLE_RATE * 2,
  '位深 16': wav.readUInt16LE(34) === 16,
}
for (const [label, ok] of Object.entries(checks)) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
}

// Structural consistency: the declared sizes must agree with the actual buffer.
const dataBytes = wav.readUInt32LE(40)
const riffBytes = wav.readUInt32LE(4)
console.log(`\n  data 声明: ${String(dataBytes)} 字节, 实际: ${String(wav.length - 44)} 字节`)
console.log(`  RIFF 声明: ${String(riffBytes)} 字节, 应为: ${String(wav.length - 8)} 字节`)
const sizesAgree = dataBytes === wav.length - 44 && riffBytes === wav.length - 8
console.log(`  ${sizesAgree ? '✅' : '❌'} 头部长度字段与实际一致`)

const decodedSeconds = dataBytes / 2 / SILK_SAMPLE_RATE
console.log(`\n  解码后时长: ${decodedSeconds.toFixed(3)} 秒（源 ${String(seconds)} 秒）`)
const lengthPlausible = Math.abs(decodedSeconds - seconds) < 0.12
console.log(`  ${lengthPlausible ? '✅' : '❌'} 时长与源一致（±0.12 秒，SILK 有帧对齐损耗）`)

// pcmToWav must be self-consistent too.
const headerOnly = pcmToWav(new Uint8Array(0), SILK_SAMPLE_RATE)
console.log(`\n  空 PCM 的 WAV 头: ${String(headerOnly.length)} 字节（应为 44）`)

const allOk = Object.values(checks).every(Boolean) && sizesAgree && lengthPlausible
console.log(`\n${allOk ? '✅ 语音转码链路可用' : '❌ 有问题，见上'}`)
process.exit(allOk ? 0 : 1)
