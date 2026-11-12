// The zoom gestures people already have in their fingers for a document: trackpad pinch (and ctrl +
// wheel), and ⌘/Ctrl + plus, minus and 0. Without them, ⌘ + zooms the whole page around the viewer.
//
// A pinch scales continuously, by the factor the fingers moved, rather than stepping the ladder: one
// pinch is dozens of wheel events, and a step per event ran to the maximum before the fingers stopped.

/** Chromium reports a trackpad pinch as `deltaY = -100 * ln(scale)`, so this inverts it exactly. */
const WHEEL_PINCH_SENSITIVITY = 1 / 100;
/** The largest single wheel event, in pinch units: one ×1.25 step. A mouse notch is one ~100–120 px delta. */
const WHEEL_MAX_DELTA = 100 * Math.log(1.25);

export type ZoomGestureHandlers = {
  /** A multiplicative factor, at most one call a frame, and the point the fingers (or cursor) are over. */
  onZoomBy(factor: number, anchor: { clientX: number; clientY: number }): void;
  onStep(direction: -1 | 1): void;
  onReset(): void;
};

function wheelDelta(event: WheelEvent): number {
  // Lines and pages, from a mouse that reports them, as pixels.
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
  return Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, delta));
}

/** Listens on `target` (which must be focusable for the keys); returns what removes the listeners. */
export function attachZoomGestures(target: HTMLElement, handlers: ZoomGestureHandlers): () => void {
  const view = target.ownerDocument.defaultView;
  const frame = (callback: () => void) => (view?.requestAnimationFrame ?? ((run: () => void) => setTimeout(run, 16)))(callback);
  let pendingFactor = 1;
  let pendingAnchor = { clientX: 0, clientY: 0 };
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const factor = pendingFactor;
    pendingFactor = 1;
    if (factor !== 1) {
      handlers.onZoomBy(factor, pendingAnchor);
    }
  };
  const queue = (factor: number, anchor: { clientX: number; clientY: number }) => {
    if (!(Number.isFinite(factor) && factor > 0)) {
      return;
    }
    pendingFactor *= factor;
    pendingAnchor = anchor;
    if (!scheduled) {
      scheduled = true;
      frame(flush);
    }
  };

  // Chromium and Firefox deliver a macOS trackpad pinch as wheel events with ctrlKey set (plain
  // ctrl + scroll matches too). preventDefault stops the browser's page zoom, which needs a
  // listener that isn't passive.
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    queue(Math.exp(-wheelDelta(event) * WHEEL_PINCH_SENSITIVITY), { clientX: event.clientX, clientY: event.clientY });
  };

  // Safari reports a pinch through its own gesture events, as a scale from the gesture's start.
  let gestureScale = 1;
  type GestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
  const pointOf = (event: GestureEvent) => ({ clientX: event.clientX ?? 0, clientY: event.clientY ?? 0 });
  const onGestureStart = (event: GestureEvent) => {
    event.preventDefault();
    gestureScale = event.scale ?? 1;
  };
  const onGestureChange = (event: GestureEvent) => {
    event.preventDefault();
    const scale = event.scale ?? 1;
    queue(scale / gestureScale, pointOf(event));
    gestureScale = scale;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    // "=" is the unshifted key most keyboards put "+" on.
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      handlers.onStep(1);
    } else if (event.key === "-") {
      event.preventDefault();
      handlers.onStep(-1);
    } else if (event.key === "0") {
      event.preventDefault();
      handlers.onReset();
    }
  };

  target.addEventListener("wheel", onWheel, { passive: false });
  target.addEventListener("gesturestart", onGestureStart);
  target.addEventListener("gesturechange", onGestureChange);
  target.addEventListener("gestureend", onGestureChange);
  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("wheel", onWheel);
    target.removeEventListener("gesturestart", onGestureStart);
    target.removeEventListener("gesturechange", onGestureChange);
    target.removeEventListener("gestureend", onGestureChange);
    target.removeEventListener("keydown", onKeyDown);
  };
}
