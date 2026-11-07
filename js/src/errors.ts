// Every failure the engine reports is a PdfError with a `code`, so a caller can branch
// without matching strings. A bad argument (a page out of range, a render size of 0) is a
// plain RangeError or TypeError instead: that is a bug to fix, not a condition to handle.

export type PdfErrorCode =
  /** Not a PDF the engine can open: garbage, truncated, a broken xref. */
  | "invalid-file"
  /** The file is encrypted and no password was given. */
  | "password-required"
  /** The file is encrypted and the password given does not open it. */
  | "wrong-password"
  /** A valid file the engine cannot read: a security handler other than Standard (e.g. DRM). */
  | "unsupported"
  /** The `signal` passed to the call was aborted. */
  | "aborted"
  /**
   * The WebAssembly instance trapped. The process is fine: documents open on that instance
   * fail with this code, and the next open gets a fresh instance.
   */
  | "crash"
  /** The document was closed. */
  | "closed"
  /** The wasm or a font or CMap asset is missing, unreadable, or not this build's. */
  | "missing-asset"
  /** Called somewhere it cannot run: a page's main thread, a service worker. */
  | "wrong-thread"
  /** A ranged read failed: the network, an HTTP error, or a server's bad Range answer. */
  | "fetch-failed"
  /** A ranged read waited longer than `timeoutMs`, or passed `totalTimeoutMs`. */
  | "timeout"
  /** A ranged read would pass `maxBytes`, or the file is past what a ranged read can hold. */
  | "too-large"
  /** Any other refusal: a page with no area, a render too large to allocate. */
  | "failed";

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  /** On `fetch-failed`, the HTTP status of the answer it objects to. Undefined if the server never answered. */
  readonly status: number | undefined;

  constructor(code: PdfErrorCode, message: string, cause?: unknown, status?: number) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PdfError";
    this.code = code;
    this.status = status;
  }
}
