/**
 * QR-code rendering for the login handshake, and the only module that imports the
 * `qrcode` package.
 *
 * Keeping the dependency behind explicit signatures matters for consumers: the
 * published `qrcode` typings are an ambient `declare module` in a sibling package
 * (DefinitelyTyped), and an ambient declaration in one workspace package does not
 * apply while another package type-checks. Declaring the two calls we use here
 * means every consumer sees a typed function instead of implicitly `any`.
 *
 * @module @dsh-wechat/core/render
 */

// `qrcode` ships no types of its own; the surface we use is asserted below and every
// call goes through a typed wrapper.
//
// The package is loaded on first use rather than at module scope. Rendering is a
// presentation concern, and a plugin that cannot resolve this one dependency should
// still start and report the problem — not fail to load at all.

/** The subset of the `qrcode` surface this package relies on. */
interface QRCodeRenderer {
  toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>
  toString(text: string, options?: { type?: 'terminal'; small?: boolean }): Promise<string>
}

/** Cached module handle, so the import cost is paid once. */
let rendererPromise: Promise<QRCodeRenderer> | undefined

/**
 * Pick the object that can actually render, out of whatever `import()` handed back.
 *
 * `qrcode` is CommonJS, so the host's module interop decides where its exports land:
 * on the namespace `default`, or on the namespace itself. Both shapes are legitimate,
 * and at least one host produces a third: DSH 0.2.2-rc.5 returns a namespace whose
 * `default` is an empty object while the real exports sit on the namespace. Trusting
 * `default ?? namespace` therefore picked the empty object, `loadRenderer` threw, and
 * because `toDataUrl` swallows that failure by design the only symptom was a login
 * page with no QR image and an empty log — silent, and invisible to every test here.
 *
 * Probing for the function we are about to call costs nothing and covers all three
 * shapes. Exported so the regression test can replay the shape without a real host.
 *
 * @param loaded - The value returned by `import('qrcode')`, untyped.
 * @returns The usable renderer, or `undefined` when neither shape carries one.
 */
export function pickRenderer(loaded: unknown): QRCodeRenderer | undefined {
  const shapes: unknown[] = [(loaded as { default?: unknown } | undefined)?.default, loaded]
  for (const shape of shapes) {
    if (typeof (shape as Partial<QRCodeRenderer> | undefined)?.toDataURL === 'function') {
      return shape as QRCodeRenderer
    }
  }
  return undefined
}

/** Resolve the renderer, or throw with a message that names the missing package. */
async function loadRenderer(): Promise<QRCodeRenderer> {
  rendererPromise ??= (async () => {
    try {
      const candidate = pickRenderer(await import('qrcode'))
      if (!candidate) {
        throw new Error('qrcode 模块没有 toDataURL 导出')
      }
      return candidate
    } catch (error) {
      // Reset so a later attempt can retry after the dependency is installed.
      rendererPromise = undefined
      throw new Error(
        `无法加载 qrcode 依赖：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()
  return await rendererPromise
}

/**
 * Render a QR payload as a PNG data URL, ready for an `<img src>`.
 *
 * @param payload - The `qrcode_img_content` string from the login response.
 * @param size - Rendered width in pixels.
 * @returns A `data:image/png;base64,...` URL, or `undefined` if rendering failed.
 */
export async function toDataUrl(payload: string, size = 512): Promise<string | undefined> {
  try {
    const renderer = await loadRenderer()
    return await renderer.toDataURL(payload, { width: size, margin: 2 })
  } catch {
    // Rendering is presentation: the caller can still show the raw link.
    return undefined
  }
}

/**
 * Render a QR payload as block characters.
 *
 * The result carries no colour escapes: it is meant for logs and terminal
 * transcripts, where ANSI codes only get in the way.
 *
 * @param payload - The `qrcode_img_content` string.
 * @returns Multi-line ASCII art, or `undefined` if rendering failed.
 */
export async function toAscii(payload: string): Promise<string | undefined> {
  try {
    const renderer = await loadRenderer()
    return await renderer.toString(payload, { type: 'terminal', small: true })
  } catch {
    return undefined
  }
}
