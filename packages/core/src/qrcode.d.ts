/**
 * Ambient declarations for the `qrcode` package.
 *
 * The published typings live in a separate DefinitelyTyped package. This workspace
 * uses exactly two calls, and `render.ts` loads the module dynamically (so a failure
 * to resolve it degrades to "no QR image" instead of a plugin that cannot load),
 * which means the types have to be declared here rather than imported.
 */
declare module 'qrcode' {
  interface QRCodeRenderOptions {
    /** Rendered width in pixels for image output. */
    width?: number
    /** Quiet-zone width in modules. */
    margin?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  interface QRCodeTerminalOptions {
    type?: 'terminal'
    /** One character per module instead of two. */
    small?: boolean
  }

  const QRCode: {
    toDataURL(text: string, options?: QRCodeRenderOptions): Promise<string>
    toString(text: string, options?: QRCodeTerminalOptions): Promise<string>
  }

  export default QRCode
}
