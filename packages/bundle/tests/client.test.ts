/**
 * Tests for the settings page bundle.
 *
 * The browser half is a classic script that registers itself through
 * `window.__ModuleLoader__`, so it cannot be imported. These tests install the same
 * facade the shell installs, run the bundle, and then actually render the page with
 * a small React stand-in: `useState` and `useEffect` are implemented well enough to
 * mount the component, run its loader effect, and re-render with the host data. That
 * catches what a browser would otherwise be the first to see — a broken export shape,
 * a slot registered under the wrong name, a render that throws on real host data, or
 * a route the page calls that does not exist.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/**
 * The route prefix the page talks to the host on.
 *
 * Defined once because the same string appears in a stub route table for nearly every test: written
 * out each time, a rename had to be applied in thirty-one places, and one missed occurrence reads as
 * a page that fails to load rather than as a missing edit.
 *
 * It has to agree with the host's own registration, which the last test in this file checks against
 * the client bundle's source rather than against this constant.
 */
const PREFIX = '/.dsh-wechat-plugin'

/**
 * A React stand-in with working `useState` and a runnable `useEffect`.
 *
 * Effects are collected during render and executed by {@link Mounted.flushEffects},
 * which lets a test await the component's data loading and then re-render.
 */
function createReactStub() {
  const state = []
  const effects = []
  let cursor = 0

  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const index = cursor++
      if (state[index] === undefined) {
        state[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        state[index],
        (next) => {
          state[index] = typeof next === 'function' ? next(state[index]) : next
        },
      ]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      effects.push(fn)
    },
    /** Reset the hook cursor for the next render pass. */
    __beginRender() {
      cursor = 0
      effects.length = 0
    },
    /** Run the effects collected by the last render, returning their cleanups. */
    __runEffects() {
      const cleanups = []
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return cleanups
    },
  }
  return react
}

/** Render a component once, returning the tree. */
function render(react, component) {
  react.__beginRender()
  return component({})
}

/** Collect every string in a rendered tree, for content assertions. */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

/** Collect every element of a given tag, depth-first. */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const child of node.children ?? []) collectByType(child, type, out)
  return out
}

/**
 * Collect every element carrying a class, depth-first.
 *
 * Selecting by class rather than by tag is what keeps an assertion about one list from counting a
 * second list that happens to share its element type.
 *
 * @param node - Tree to search.
 * @param name - Class name to match.
 */
function collectByClass(node, name, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, name, out)
    return out
  }
  const className = node.props?.className
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) out.push(node)
  for (const child of node.children ?? []) collectByClass(child, name, out)
  return out
}

/**
 * Load the client bundle with the shell's facade in place.
 *
 * The globals stay installed for the lifetime of the returned handle so the
 * component can keep calling `fetch` and `setInterval` during the test.
 */
async function loadClientBundle(options = {}) {
  const source = await readFile(clientPath, 'utf8')
  const registrations = []
  const react = options.react ?? createReactStub()
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  // `navigator` is deliberately not saved: it is a read-only global in Node and the
  // bundle only reads `navigator.language`, which Node already provides.

  const head = {
    children: [],
    append(node) {
      node.parentNode = this
      this.children.push(node)
    },
  }
  const documentStub = {
    documentElement: { lang: 'zh-CN' },
    head,
    getElementById: (id) => head.children.find((node) => node.id === id) ?? null,
    createElement: (tag) => ({
      tag,
      id: '',
      textContent: '',
      parentNode: undefined,
      /** Mirrors `Element.remove`, so disposal can be verified. */
      remove() {
        const parent = this.parentNode
        if (parent === undefined) return
        const index = parent.children.indexOf(this)
        if (index >= 0) parent.children.splice(index, 1)
      },
    }),
  }

  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = documentStub
  // Timers are neutralised: the poll loop is not what these tests exercise.
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  if (options.fetchImpl) globalThis.fetch = options.fetchImpl

  try {
    const run = new Function('window', 'document', 'navigator', `${source}\n`)
    run(globalThis.window, documentStub, { language: 'zh-CN' })
  } catch (error) {
    Object.assign(globalThis, saved)
    throw error
  }

  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  const registration = registrations[0]
  assert.equal(registration.id, 'dsh-wechat-plugin')
  assert.equal(typeof registration.factory, 'function')

  const exported = registration.factory((request) => {
    if (request === 'react') return react
    throw new Error(`unexpected client require: ${request}`)
  })

  return {
    exports: exported,
    react,
    documentStub,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

/** Mount the page against stubbed routes and return the final tree. */
async function mountPage(routes) {
  const requested = []
  const react = createReactStub()
  const bundle = await loadClientBundle({
    react,
    fetchImpl: async (url) => {
      const path = String(url)
      requested.push(path.replace(/^https?:\/\/[^/]+/, ''))
      const body = routes[path.replace(/^https?:\/\/[^/]+/, '')]
      if (body === undefined) {
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  })

  const sections = []
  const disposers = []
  const ctx = {
    // The client-plugin rules require resources to be registered through `effect`,
    // so the stub runs the body and collects the returned cleaner.
    effect(execute) {
      const cleanup = execute()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    slots: {
      inject: (_slot, factory) => factory(),
      register(definition, component) {
        sections.push({ definition, component })
        return () => {
          sections.pop()
        }
      },
    },
  }
  bundle.exports.apply(ctx)
  assert.equal(sections.length, 1, 'apply must register one settings section')

  const component = sections[0].component
  let tree = render(react, component)
  bundle.react.__runEffects()
  // Effects kick off async loads; let them settle, then re-render with the data.
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render(react, component)

  return {
    tree,
    requested,
    sections,
    bundle,
    disposers,
    /**
     * Render again from the live hook state.
     *
     * The stub does not re-render on `setState`, so a test that clicks something and asserts on
     * what appears must ask for a new pass — otherwise it sees the tree from before the click.
     */
    rerender: () => render(react, component),
  }
}

const STATUS = {
  enabled: true,
  accounts: [{ accountId: 'fd17bd2d40c3@im.bot', userId: 'peer@im.wechat', polling: true }],
  needsLogin: false,
  errors: ['2026-10-06T00:00:00.000Z 示例错误'],
  diagnostics: {
    logPath: 'C:\\Users\\me\\.dsh\\wechat\\boot.log',
    statePath: 'C:\\Users\\me\\.dsh\\wechat\\state.json',
    workspace: 'C:\\Users\\me\\.dsh\\dsh_wechat',
    logTail: ['2026-10-06T00:00:00.000Z apply: mounted'],
  },
}

/** Effective settings and the defaults behind them. */
const SETTINGS = {
  mergeWindowMs: 10_000,
  maxReplyChars: 4_000,
  settleMs: 1_200,
  quoteHistory: 40,
  autoReplyAttachments: true,
  presenceNote: '[渠道：微信] 对方在手机上。',
}

const LOGIN_RUNNING = {
  phase: 'running',
  step: '请用手机微信扫码',
  qrUrl: 'https://liteapp.weixin.qq.com/q/abc',
  qrDataUrl: 'data:image/png;base64,AAAA',
}

test('the client bundle exports the plugin shape under the expected name', async () => {
  const bundle = await loadClientBundle()
  try {
    assert.equal(bundle.exports.name, 'dsh-wechat-plugin')
    assert.equal(typeof bundle.exports.apply, 'function')
  } finally {
    bundle.restore()
  }
})

test('the client half injects slots, so it cannot activate before the registry exists', async () => {
  // A boot-critical declaration, and the bug that made the desktop shell refuse to
  // start. Cordis holds a plugin back until every injected service is available; with
  // an empty list this plugin activates early, `ctx.slots` is undefined, `apply`
  // throws, the entry is recorded as `failed`, and the shell's boot audit aborts the
  // whole application. The audit reports only `<id>: failed` — never the cause.
  const bundle = await loadClientBundle()
  try {
    assert.deepEqual(bundle.exports.inject, ['slots'])
  } finally {
    bundle.restore()
  }
})

test('apply registers its resources through effect and cleans them up', async () => {
  const bundle = await loadClientBundle()
  try {
    const sections = []
    const disposers = []
    const ctx = {
      effect(execute) {
        const cleanup = execute()
        if (typeof cleanup === 'function') disposers.push(cleanup)
      },
      slots: {
        // Mirror the real shape: `inject` runs the contributor and returns a
        // disposer for whatever it registered.
        inject: (slot, factory) => {
          assert.equal(slot, 'settings.section')
          return factory()
        },
        register: (definition, component) => (
          sections.push({ definition, component }),
          () => {
            const index = sections.findIndex((entry) => entry.definition === definition)
            if (index >= 0) sections.splice(index, 1)
          }
        ),
      },
    }

    bundle.exports.apply(ctx)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].definition.name, 'settings.section')
    assert.equal(sections[0].definition.id, 'wechat')
    assert.equal(sections[0].definition.order, 40)
    assert.equal(typeof sections[0].definition.label(), 'string')

    const styles = () => bundle.documentStub.head.children.filter((node) => node.id === 'dsh-wechat-style')
    assert.equal(styles().length, 1, 'the stylesheet is installed')

    // Disposal must remove both the section and the stylesheet: a disabled plugin
    // has to leave nothing behind.
    assert.equal(disposers.length, 1, 'apply registered exactly one effect')
    disposers[0]()
    assert.equal(sections.length, 0, 'the section is unregistered')
    assert.equal(styles().length, 0, 'the stylesheet is removed')
  } finally {
    bundle.restore()
  }
})

test('the page loads every route it renders from', async () => {
  const { tree, requested, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    assert.deepEqual(
      [...requested].sort(),
      [PREFIX + '/login', PREFIX + '/settings', PREFIX + '/status'],
      'the page must call exactly these routes',
    )

    const text = collectText(tree).join(' | ')
    // The bound account and its polling badge.
    assert.match(text, /fd17bd2d40c3@im\.bot/)
    assert.match(text, /peer@im\.wechat/)
    // The QR code is rendered as an image with the data URL the host produced.
    const images = collectByType(tree, 'img')
    assert.equal(images.length, 1)
    assert.equal(images[0].props.src, LOGIN_RUNNING.qrDataUrl)
    assert.equal(images[0].props.alt.length > 0, true)
    // Each account offers the action that ends the link itself.
    assert.ok(
      collectByType(tree, 'button').some((node) =>
        collectText(node).join('').includes('断开连接'),
      ),
      'the disconnect button is rendered next to the account',
    )
    // Conversation-to-session bindings are not shown at all: the list was removed as noise.
    assert.doesNotMatch(text, /会话绑定/)
    // Errors from the host are surfaced.
    assert.match(text, /示例错误/)
  } finally {
    bundle.restore()
  }
})

test('disconnecting runs straight away, with no verification step', async () => {
  const { tree, bundle, requested } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const button = collectByType(tree, 'button').find((node) =>
      collectText(node).join('').includes('断开连接'),
    )
    assert.ok(button, 'the disconnect button is rendered')
    button.props.onClick()
    // Security was removed deliberately, so the action is unguarded. Asserted rather than left
    // implicit: re-adding a prompt would otherwise go unnoticed.
    assert.ok(
      requested.includes(PREFIX + '/disconnect'),
      'the request goes out without a password',
    )
  } finally {
    bundle.restore()
  }
})

test('the page has no password or security-question UI at all', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const text = collectText(tree).join(' | ')
    // The whole feature was removed on request; these are the words it used to contribute.
    assert.doesNotMatch(text, /密码/)
    assert.doesNotMatch(text, /密保/)
    assert.equal(
      collectByType(tree, 'input').filter((node) => node.props.type === 'password').length,
      0,
      'no password field',
    )
  } finally {
    bundle.restore()
  }
})

test('the page groups its settings, so unlike decisions are told apart', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Unrelated settings sitting side by side with nothing to say they were different kinds of
    // decision was the readability problem this grouping exists to fix. The stub does not
    // materialise function components, so the groups are matched by the component that declares
    // them rather than by the section it returns.
    const groups = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child)
        return
      }
      if (typeof node.type === 'function' && node.type.name === 'Group') groups.push(node)
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
    const titles = groups.map((group) => String(group.props.title))
    assert.deepEqual(
      titles,
      ['连接', '行为', '指令', '诊断', '帮助'],
      'in the order they should be read',
    )
    // The diagnostics group carries no hint: the card below it already says what the log is, so a
    // group-level line would repeat it. Asserted so the duplication cannot creep back in.
    const diagnostics = groups.find((group) => String(group.props.title) === '诊断')
    assert.equal(diagnostics.props.hint, undefined, 'no group hint for diagnostics')
    // Help is last on purpose: it is a docs link, not a setting, and it answers questions the
    // switches above it raise rather than the other way round.
    assert.equal(titles.at(-1), '帮助', 'the guide is the last group')
  } finally {
    bundle.restore()
  }
})

test('the page carries no inline layout styles, so the stylesheet stays the one source', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Layout written inline wins over the stylesheet and cannot be restyled or themed, which is
    // how the page drifted into inconsistent spacing before. Only `style` props are inspected:
    // the markup is otherwise free to carry class names.
    const offenders = []
    const visit = (node, path) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child, path)
        return
      }
      if (node.props?.style !== undefined) offenders.push(`${path}/${String(node.type)}`)
      for (const child of node.children ?? []) visit(child, `${path}/${String(node.type)}`)
    }
    visit(tree, '')
    assert.deepEqual(offenders, [], 'all layout belongs in the stylesheet')
  } finally {
    bundle.restore()
  }
})

test('the diagnostics paths are a definition list, so their labels line up', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Selector by class rather than by count: the page holds more than one definition list now
    // that the command reference uses the same pattern.
    const facts = collectByClass(tree, 'dsh-wechat-facts')
    assert.equal(facts.length, 1, 'one list of paths')
    const terms = collectByType(facts[0], 'dt').map((node) => collectText(node).join(''))
    assert.deepEqual(terms, ['日志文件', '状态文件', '会话工作目录'])
  } finally {
    bundle.restore()
  }
})

test('the command reference lists every command with what it does', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const commands = collectByClass(tree, 'dsh-wechat-command')
    // The page is where someone finds out these exist, so every one the channel answers has to be
    // here — a command missing from the list is one nobody will use.
    assert.deepEqual(
      commands.map((node) => collectText(collectByType(node, 'dt')[0]).join('')),
      ['/help', '/new [标题]', '/list', '/switch <编号>', '/current', '/cancel'],
    )
    const meanings = commands.map((node) => collectText(collectByType(node, 'dd')[0]).join(''))
    assert.ok(meanings.every((text) => text.length > 0), 'every command explains itself')
  } finally {
    bundle.restore()
  }
})

test('the page asks for a verification code only when the host says so', async () => {
  const waiting = { phase: 'running', step: '服务端要求输入配对验证码', awaitingVerifyCode: true }
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: waiting,
    [PREFIX + '/bindings']: { bindings: [] },
  })
  try {
    const inputs = collectByType(tree, 'input')
    assert.equal(inputs.length, 1, 'exactly one verification-code field')
    // The heading carries the wording; the button is just the verb, so match the section text
    // rather than a button label that no longer repeats it.
    const text = collectText(tree).join(' | ')
    assert.match(text, /配对验证码/, 'the section says what is being asked for')
    const buttons = collectByType(tree, 'button').map((node) => collectText(node).join(''))
    assert.ok(
      buttons.includes('提交'),
      `expected a submit button, got: ${buttons.join(' / ')}`,
    )
  } finally {
    bundle.restore()
  }
})

test('a failing status route renders an error instead of throwing', async () => {
  const { tree, bundle } = await mountPage({
    // Status is the one the page cannot render without, so its absence is fatal.
    [PREFIX + '/login']: LOGIN_RUNNING,
  })
  try {
    const text = collectText(tree).join(' | ')
    assert.match(text, /not found|读取设置失败|Could not read/)
    const buttons = collectByType(tree, 'button')
    assert.ok(buttons.length >= 1, 'an error state offers a retry')
  } finally {
    bundle.restore()
  }
})

test('a failing optional route degrades instead of blanking the page', async () => {
  // The settings route is the most optional. A page that refused to render because it 404s would
  // take the channel switch down with it, so the core sections must still appear.
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    // settings is absent, so it 404s.
  })
  try {
    const text = collectText(tree).join(' | ')
    assert.match(text, /已绑定账号|Bound accounts/, 'the accounts section still renders')
    assert.match(text, /fd17bd2d40c3@im\.bot/, 'from the status the host did return')
    // And the settings and password forms are simply absent rather than broken.
    assert.doesNotMatch(text, /行为设置 \|/)
    assert.doesNotMatch(text, /密码保护 \|/)
  } finally {
    bundle.restore()
  }
})

test('the manifest declares a web client half with no extra externals', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  // Only the platform baseline (React) is needed, so nothing extra is declared.
  assert.equal(manifest.dsh.client.external, undefined)
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('dist'), 'the vendored core must ship')
})

test('the client half is declared immediately, because nothing consumes it', async () => {
  // A boot-critical declaration, not a preference. The shell's boot audit requires
  // every client entry to activate, and module bodies are lazy — they run only on
  // first materialization. An entry with no consumer and no `immediately` therefore
  // never runs, the audit reports `dsh-wechat: failed`, and the desktop shell refuses
  // to start the whole application.
  //
  // There are two ways to satisfy the audit: be consumed (declare `dsh.client.inject`,
  // as `dsh-orb` does with the settings page) or activate at boot. This plugin is
  // self-contained with no consumer, so it must activate at boot.
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    manifest.dsh.client.immediately,
    true,
    'without this the desktop shell fails to start: the entry never activates',
  )
  assert.equal(manifest.dsh.client.inject, undefined, 'nothing else consumes this plugin')
})

test('the package name, the host row id and the client module id agree', async () => {
  /*
   * Three places carry this plugin's identity, and the shipped bundles keep them identical: the
   * package name, the `id` of the row `cordis.patch.yml` inserts, and the `id` the client registers
   * itself under. The client-plugin convention depends on it — a Host row whose id differs from its
   * package name cannot be loaded by name.
   *
   * One of the three was missed when the package was renamed (`dsh-wechat` was already taken on npm by
   * an unrelated plugin of the same purpose), and nothing failed: the host half still loaded, so only
   * the settings page went blank. Hence this test.
   */
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
  const client = await readFile(clientPath, 'utf8')

  const name = manifest.name
  const rowId = /- id:\s*(\S+)/.exec(patch)?.[1]
  const rowName = /name:\s*'([^']+)'/.exec(patch)?.[1]
  const moduleId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1]

  assert.equal(rowId, name, 'the cordis row id must equal the package name')
  assert.equal(rowName, name, 'the cordis row name must equal the package name')
  assert.equal(moduleId, name, 'the client module id must equal the package name')
})

test('the page and the host agree on the route prefix', async () => {
  // The page calls routes; the host registers them. If the two strings drift, every request 404s and
  // the settings page renders empty — with no error anywhere, because a 404 is a valid response.
  const hostSource = await readFile(join(here, '..', 'src', 'host.ts'), 'utf8')
  const registered = /path:\s*'([^']+)'/.exec(hostSource)?.[1]
  assert.equal(
    registered,
    PREFIX,
    'the host route prefix and the page\'s PREFIX constant must be the same string',
  )

  /*
   * `routes.ts` is the third copy of this string, and it is the one that decides the paths the host
   * actually answers on: `host.ts` registers a prefix, but `routes.ts` composes the concrete paths
   * from its own `ROUTE_PREFIX`.
   *
   * Missing it shipped a broken release. The package was renamed, `host.ts` and `client.js` were
   * updated, and `routes.ts` was not — so the host registered `/.dsh-wechat-plugin` while every
   * handler compared against `/.dsh-wechat/…`. The settings page showed "status unavailable" and
   * nothing worked. The assertion above passed throughout, because it only checked the two copies that
   * had been edited. Hence this one: all three, always.
   */
  const routesSource = await readFile(join(here, '..', 'src', 'routes.ts'), 'utf8')
  const routePrefix = /ROUTE_PREFIX\s*=\s*'([^']+)'/.exec(routesSource)?.[1]
  assert.equal(
    routePrefix,
    PREFIX,
    'ROUTE_PREFIX in routes.ts must equal the page\'s PREFIX: it is what the host answers on',
  )
})
