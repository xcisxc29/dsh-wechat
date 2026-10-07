#!/usr/bin/env node
/**
 * Report whether the harness's tool events reach a plugin sitting at the root scope.
 *
 * The tool-call cards depend on this. `tools/result` is dispatched with
 * `scopeTarget(this, exec.agent)`, which filters delivery by the calling agent, while a
 * channel plugin lives at the host scope and owns no agent of its own. If the event does not
 * arrive there, no card can ever be produced and the whole feature has to be built on the
 * assistant stream instead.
 *
 * That is cheaper to settle with one instrumented run than by writing the feature and
 * discovering it silently does nothing.
 *
 * Usage: start the app with this probe's plugin directory registered, then read the output.
 *   node scripts/probe-tool-events.mjs
 */

import { readFileSync } from 'node:fs'

const log = 'C:/Users/XCISXC/.dsh/wechat/boot.log'
const text = readFileSync(log, 'utf8')
const lines = text.split(/\r?\n/)

const hits = lines.filter((line) => line.includes('probe:'))
console.log(`boot.log 里 probe 记录: ${String(hits.length)} 条`)
for (const line of hits.slice(-20)) console.log(`  ${line.slice(0, 200)}`)

if (hits.length === 0) {
  console.log('\n（还没有探针记录。需要先让 DSH 用带探针的插件启动，并触发一次工具调用。）')
}
