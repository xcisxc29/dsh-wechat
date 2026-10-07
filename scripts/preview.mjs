/**
 * Render the settings page to a standalone HTML file, for looking at.
 *
 * The page lives inside the DSH shell, so the only way to judge its spacing and hierarchy
 * without launching the app is to reproduce the same tree with the same stylesheet. This
 * extracts the CSS string from `client.js` verbatim, so the preview cannot drift from what
 * ships — if it looks wrong here, it looks wrong there.
 *
 * Usage: `node scripts/preview.mjs [dark]`, then open `preview-light.html` (or `-dark`).
 * The file is written to the repository root and is not part of the package.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync(new URL('../packages/bundle/client.js', import.meta.url), 'utf8')

// The stylesheet is a template literal; take it whole rather than restating it.
const match = /const styles = `([\s\S]*?)`\n/.exec(source)
if (match === null) throw new Error('could not find the stylesheet in client.js')
const styles = match[1]

/** Evaluate the locale object so the preview shows the real strings. */
function localeText(name) {
  const start = source.indexOf(`      ${name}: {`)
  if (start === -1) throw new Error(`could not find the ${name} locale`)
  // Brace matching, because the object does not contain other braces but the text does.
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`unterminated ${name} locale`)
  const body = source.slice(source.indexOf('{', start), end + 1)
  return new Function(`return ${body}`)()
}

const t = localeText('zh')

const esc = (value) => String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

const field = (label, hint, control) => `
  <div class="dsh-wechat-field">
    <label>${esc(label)}</label>
    ${control}
    ${hint ? `<span class="dsh-wechat-hint">${esc(hint)}</span>` : ''}
  </div>`

const toggle = (on) => `<button type="button" role="switch" aria-checked="${on}" class="dsh-wechat-switch${on ? ' is-on' : ''}"></button>`

const page = `
<div class="dsh-wechat">
  <div class="dsh-wechat-header">
    <h2>${esc(t.title)}</h2>
    <p class="dsh-wechat-lead">${esc(t.intro)}</p>
  </div>

  <section class="dsh-wechat-group">
    <header class="dsh-wechat-group-head">
      <h3 class="dsh-wechat-group-title">${esc(t.groupConnection)}</h3>
      <p class="dsh-wechat-group-hint">${esc(t.groupConnectionHint)}</p>
    </header>
    <div class="dsh-wechat-group-body">
      <section class="dsh-wechat-card">
        <div class="dsh-wechat-row">
          <div class="dsh-wechat-row-text">
            <h3>${esc(t.statusTitle)}</h3>
            <span class="dsh-wechat-hint">${esc(t.enabledHint)}</span>
          </div>
          ${toggle(true)}
        </div>
        <h3>${esc(t.accounts)}</h3>
        <ul class="dsh-wechat-list">
          <li>
            <span><span class="dsh-wechat-mono">a1b2c3d4@im.bot</span><span class="dsh-wechat-mono"> ← wxid_9f8e7d</span></span>
            <span class="dsh-wechat-badge is-on">${esc(t.polling)}</span>
            <button type="button" class="dsh-wechat-button dsh-wechat-danger">${esc(t.disconnect)}</button>
          </li>
        </ul>
        <p class="dsh-wechat-hint">${esc(t.disconnectHint)}</p>
      </section>

      <section class="dsh-wechat-card">
        <h3>${esc(t.loginTitle)}</h3>
        <p>${esc(t.qrHint)}</p>
        <div class="dsh-wechat-actions">
          <button type="button" class="dsh-wechat-button dsh-wechat-primary">${esc(t.loginAgain)}</button>
        </div>
      </section>
    </div>
  </section>

  <section class="dsh-wechat-group">
    <header class="dsh-wechat-group-head">
      <h3 class="dsh-wechat-group-title">${esc(t.groupBehaviour)}</h3>
      <p class="dsh-wechat-group-hint">${esc(t.groupBehaviourHint)}</p>
    </header>
    <div class="dsh-wechat-group-body">
      <section class="dsh-wechat-card">
        <h3>${esc(t.settingsTitle)}</h3>
        <span class="dsh-wechat-hint">${esc(t.settingsHint)}</span>
        <div class="dsh-wechat-row">
          <div class="dsh-wechat-row-text">
            <label>${esc(t.requireConfirmation)}</label>
            <span class="dsh-wechat-hint">${esc(t.requireConfirmationHint)}</span>
          </div>
          ${toggle(true)}
        </div>
        ${field(t.mergeWindow, t.mergeWindowHint, '<input type="number" class="dsh-wechat-input" value="10">')}
        <div class="dsh-wechat-row">
          <div class="dsh-wechat-row-text">
            <label>${esc(t.autoReplyAttachments)}</label>
            <span class="dsh-wechat-hint">${esc(t.autoReplyAttachmentsHint)}</span>
          </div>
          ${toggle(true)}
        </div>
        ${field(t.maxReplyChars, t.maxReplyCharsHint, '<input type="number" class="dsh-wechat-input" value="4000">')}
        ${field(t.settleMs, t.settleMsHint, '<input type="number" class="dsh-wechat-input" value="1200">')}
        ${field(t.quoteHistory, t.quoteHistoryHint, '<input type="number" class="dsh-wechat-input" value="40">')}
        ${field(t.presenceNote, t.presenceNoteHint, '<textarea class="dsh-wechat-input">[渠道：微信] 你在和微信上的用户对话…</textarea>')}
        <div class="dsh-wechat-actions">
          <button type="button" class="dsh-wechat-button dsh-wechat-primary">${esc(t.settingsSave)}</button>
          <button type="button" class="dsh-wechat-button dsh-wechat-outline">${esc(t.settingsReset)}</button>
          <span class="dsh-wechat-ok">${esc(t.settingsSaved)}</span>
        </div>
      </section>
    </div>
  </section>

  <section class="dsh-wechat-group">
    <header class="dsh-wechat-group-head">
      <h3 class="dsh-wechat-group-title">${esc(t.groupCommands)}</h3>
    </header>
    <div class="dsh-wechat-group-body">
      <section class="dsh-wechat-card">
        <h3>${esc(t.commandsSlash)}</h3>
        <span class="dsh-wechat-hint">${esc(t.commandsSlashHint)}</span>
        <dl class="dsh-wechat-commands">
          <div class="dsh-wechat-command"><dt>/help</dt><dd>${esc(t.commandHelp)}</dd></div>
          <div class="dsh-wechat-command"><dt>/new [标题]</dt><dd>${esc(t.commandNew)}</dd></div>
          <div class="dsh-wechat-command"><dt>/list</dt><dd>${esc(t.commandList)}</dd></div>
          <div class="dsh-wechat-command"><dt>/switch &lt;编号&gt;</dt><dd>${esc(t.commandSwitch)}</dd></div>
          <div class="dsh-wechat-command"><dt>/current</dt><dd>${esc(t.commandCurrent)}</dd></div>
          <div class="dsh-wechat-command"><dt>/cancel</dt><dd>${esc(t.commandCancel)}</dd></div>
        </dl>
        <span class="dsh-wechat-hint">${esc(t.commandsSeparator)}</span>
        <h3>${esc(t.commandsPlain)}</h3>
        <span class="dsh-wechat-hint">${esc(t.commandsPlainHint)}</span>
      </section>
    </div>
  </section>

  <section class="dsh-wechat-group">
    <header class="dsh-wechat-group-head">
      <h3 class="dsh-wechat-group-title">${esc(t.groupDiagnostics)}</h3>
    </header>
    <div class="dsh-wechat-group-body">
      <section class="dsh-wechat-card">
        <h3>${esc(t.diagnosticsTitle)}</h3>
        <span class="dsh-wechat-hint">${esc(t.diagnosticsHint)}</span>
        <dl class="dsh-wechat-facts">
          <div class="dsh-wechat-fact"><dt>${esc(t.logPath)}</dt><dd>C:\\Users\\me\\.dsh\\wechat\\boot.log</dd></div>
          <div class="dsh-wechat-fact"><dt>${esc(t.statePath)}</dt><dd>C:\\Users\\me\\.dsh\\wechat\\state.json</dd></div>
          <div class="dsh-wechat-fact"><dt>${esc(t.workspacePath)}</dt><dd>C:\\Users\\me\\.dsh\\dsh_wechat</dd></div>
        </dl>
        <h3>${esc(t.logTail)}</h3>
        <pre class="dsh-wechat-log">2026-10-06T00:03:11Z apply: entered
2026-10-06T00:03:11Z apply: mounted
2026-10-06T00:03:12Z apply: started
2026-10-06T00:03:14Z inbound media item: type=2
2026-10-06T00:03:14Z media: image 1200x800 -> 媒体\\20261006-000314.png
2026-10-06T00:03:19Z quote resolved: id=7788992022
2026-10-06T00:03:22Z outbound text id=7788992033 body=已收到，正在看
2026-10-06T00:03:31Z long reply 6120 chars -> 回复-20261006-000331.md
2026-10-06T00:03:31Z outbound: 回复-20261006-000331.md id=7788992040 (文件)</pre>
      </section>
      <section class="dsh-wechat-card">
        <h3>${esc(t.errorsTitle)}</h3>
        <ul class="dsh-wechat-errors">
          <li>2026-10-06T00:02:58Z 发送失败：HTTP 500</li>
        </ul>
      </section>
    </div>
  </section>
</div>`

const scheme = process.argv[2] === 'dark' ? 'dark' : 'light'

/**
 * The design tokens the plugin's stylesheet reads.
 *
 * Taken from `@deepseek-ai/dsh-client-ui-theme` as it ships, so the preview shows the real palette
 * instead of falling back to unstyled defaults — without these, backgrounds and hairlines vanish
 * and the page is judged against a blank sheet.
 */
const TOKENS = {
  light: `
--dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 16px; --dsw-radius-xl: 20px;
--dsw-static-neutral-bluish-00: #fff; --dsw-static-neutral-bluish-60: #f5f6f7; --dsw-static-neutral-bluish-100: #ebeef2;
--dsw-static-neutral-bluish-200: #e1e5ee; --dsw-static-neutral-bluish-600: #81858c; --dsw-static-neutral-bluish-700: #61666b;
--dsw-static-neutral-bluish-750: #43454a; --dsw-static-neutral-bluish-1000: #0f1115;
--dsw-static-green-500: #22c55e; --dsw-static-amber-500: #f59e0b; --dsw-static-red-600: #dc2626; --dsw-static-deepseek-500: #4d6bfe;
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-60);
--dsw-alias-border-l2: #0000001a; --dsw-alias-border-l3: #0000001f; --dsw-alias-border-l4: #00000029;
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-00);
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
--dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-200);
--dsw-alias-label-error: var(--dsw-static-red-600);
--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-switch-thumb: var(--dsw-static-neutral-bluish-00);
--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
--dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-750);
--dsw-alias-interactive-bg-hover: #2631480f; --dsw-alias-interactive-bg-active: #2631481a;
--dsw-alias-state-success-primary: var(--dsw-static-green-500);
--dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
--dsw-alias-state-error-primary: var(--dsw-static-red-600);
--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
--dsw-focus-ring-width: 2px;
`,
  dark: `
--dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 16px; --dsw-radius-xl: 20px;
--dsw-static-neutral-bluish-00: #fff; --dsw-static-neutral-bluish-60: #f5f6f7; --dsw-static-neutral-bluish-100: #ebeef2;
--dsw-static-neutral-bluish-200: #e1e5ee; --dsw-static-neutral-bluish-600: #81858c; --dsw-static-neutral-bluish-700: #61666b;
--dsw-static-neutral-bluish-750: #43454a; --dsw-static-neutral-bluish-850: #2c2c2e; --dsw-static-neutral-bluish-875: #232324;
--dsw-static-neutral-bluish-900: #1b1b1c; --dsw-static-neutral-bluish-1000: #0f1115;
--dsw-static-green-500: #22c55e; --dsw-static-amber-500: #f59e0b; --dsw-static-red-600: #dc2626; --dsw-static-deepseek-500: #4d6bfe;
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-850);
--dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-875);
--dsw-alias-border-l2: #ffffff1a; --dsw-alias-border-l3: #ffffff1f; --dsw-alias-border-l4: #ffffff29;
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-00);
--dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-200);
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
--dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-700);
--dsw-alias-label-error: var(--dsw-static-red-600);
--dsw-alias-brand-primary: var(--dsw-static-deepseek-500);
--dsw-alias-switch-thumb: var(--dsw-static-neutral-bluish-00);
--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
--dsw-alias-button-primary-hover: var(--dsw-static-deepseek-500);
--dsw-alias-interactive-bg-hover: #ffffff14; --dsw-alias-interactive-bg-active: #ffffff1f;
--dsw-alias-state-success-primary: var(--dsw-static-green-500);
--dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
--dsw-alias-state-error-primary: var(--dsw-static-red-600);
--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
--dsw-focus-ring-width: 2px;
`,
}

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-wechat 设置页预览</title>
<meta name="color-scheme" content="${scheme}">
<style>
/* The shell's page chrome, then its design tokens, then the plugin's own stylesheet verbatim. */
:root { color-scheme: ${scheme}; ${TOKENS[scheme]} }
body { margin: 0; padding: 32px 36px; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
body { background: ${scheme === 'dark' ? '#1b1b1c' : '#fff'}; color: var(--dsw-alias-label-primary); }
/* Pulled from client.js verbatim. */
${styles}
</style></head>
<body>
${page}
</body></html>`

const out = new URL(`../preview-${scheme}.html`, import.meta.url)
writeFileSync(out, html)
console.log(`已生成 preview-${scheme}.html（样式 ${styles.length} 字符，取自 client.js）`)
