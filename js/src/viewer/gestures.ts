// The zoom gestures people already have in their fingers for a document: a two-finger pinch on a touch
// screen, a trackpad pinch (and ctrl + wheel), and ⌘/Ctrl + plus, minus and 0. Without them the browser
// zooms the whole page around the viewer.
//
// A pinch is a session: it starts, moves (a scale since its start, about the point where it started,
// and how far the fingers have slid since), and ends. The viewer previews the moves cheaply and lays
// out once at the end, so a pinch costs one relayout and one repaint, not one a frame.

/** Chromium reports a trackpad pinch as `deltaY = -100 * ln(scale)`, so this inverts it exactly. */
const WHEEL_PINCH_SENSITIVITY = 1 / 100;
/** The largest single wheel event, in pinch units: one ×1.25 step. A mouse notch is one ~100–120 px delta. */
const WHEEL_MAX_DELTA = 100 * Math.log(1.25);
/** A wheel pinch has no end event: it has ended once its events stop this long. */
export const WHEEL_PINCH_END_MS = 150;

export type PinchPoint = { clientX: number; clientY: number };

export type PinchMove = {
  /** The scale since the pinch started. */
  scale: number;
  /** Where it started, in client coordinates: the point that scales in place. */
  origin: PinchPoint;
  /** How far the fingers' midpoint has slid since, in CSS pixels. */
  panX: number;
  panY: number;
};

export type ZoomGestureHandlers = {
  /** A pinch moved: at most one call a frame. */
  onPinch(move: PinchMove): void;
  /** It ended where `move` says; the viewer commits it. */
  onPinchEnd(move: PinchMove): void;
  onStep(direction: -1 | 1): void;
  onReset(): void;
  /** Holds a pinch's scale within the zoom's range, so pinching past the end and back turns at once. */
  clampScale?(scale: number): number;
};

function wheelDelta(event: WheelEvent): number {
  // Lines and pages, from a mouse that reports them, as pixels.
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
  return Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, delta));
}

type TouchPoint = { clientX: number; clientY: number };
type TouchList2 = { length: number; [index: number]: TouchPoint | undefined };

/** Listens on `target` (which must be focusable for the keys); returns what removes the listeners. */
export function attachZoomGestures(target: HTMLElement, handlers: ZoomGestureHandlers): () => void {
  const view = target.ownerDocument.defaultView;
  const frame = (callback: () => void) => (view?.requestAnimationFrame ?? ((run: () => void) => setTimeout(run, 16)))(callback);

  // One pinch at a time, whatever drives it.
  let session: { source: "wheel" | "touch" | "gesture"; move: PinchMove } | null = null;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (session) {
      handlers.onPinch({ ...session.move });
    }
  };
  const begin = (source: "wheel" | "touch" | "gesture", origin: PinchPoint) => {
    session = { move: { origin, panX: 0, panY: 0, scale: 1 }, source };
  };
  const update = (scale: number, panX = 0, panY = 0) => {
    if (!session || !(Number.isFinite(scale) && scale > 0)) {
      return;
    }
    Object.assign(session.move, { panX, panY, scale: handlers.clampScale?.(scale) ?? scale });
    if (!scheduled) {
      scheduled = true;
      frame(flush);
    }
  };
  const end = () => {
    if (!session) {
      return;
    }
    const { move } = session;
    session = null;
    handlers.onPinchEnd({ ...move });
  };

  // Chromium and Firefox deliver a trackpad pinch as wheel events with ctrlKey set (plain ctrl +
  // scroll matches too). preventDefault stops the browser's page zoom, which needs a listener that
  // isn't passive.
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    if (session && session.source !== "wheel") {
      return;
    }
    if (!session) {
      begin("wheel", { clientX: event.clientX, clientY: event.clientY });
    }
    update(session!.move.scale * Math.exp(-wheelDelta(event) * WHEEL_PINCH_SENSITIVITY));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(end, WHEEL_PINCH_END_MS);
  };

  // Safari reports a pinch through its own gesture events, as a scale from the gesture's start. On a
  // touch screen it sends touches too, which drive the pinch there; these are only cancelled.
  type GestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
  const onGestureStart = (event: GestureEvent) => {
    event.preventDefault();
    if (!session) {
      begin("gesture", { clientX: event.clientX ?? 0, clientY: event.clientY ?? 0 });
    }
  };
  const onGestureChange = (event: GestureEvent) => {
    event.preventDefault();
    if (session?.source === "gesture") {
      update(event.scale ?? 1);
    }
  };
  const onGestureEnd = (event: GestureEvent) => {
    event.preventDefault();
    if (session?.source === "gesture") {
      update(event.scale ?? session.move.scale);
      end();
    }
  };

  // Two fingers on a touch screen. Touch events rather than pointer events: a browser may claim a
  // pointer for its own panning and cancel it mid-pinch, but a touchmove it was told is cancelable
  // stays ours.
  let touchStart: { distance: number; mid: PinchPoint } | null = null;
  const touchGeometry = (touches: TouchList2) => {
    const a = touches[0]!;
    const b = touches[1]!;
    return {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 },
    };
  };
  const onTouchStart = (event: TouchEvent) => {
    const touches = event.touches as unknown as TouchList2;
    if (touches.length === 2 && (!session || session.source === "touch")) {
      end();
      touchStart = touchGeometry(touches);
      if (touchStart.distance > 0) {
        begin("touch", touchStart.mid);
      }
    }
  };
  const onTouchMove = (event: TouchEvent) => {
    const touches = event.touches as unknown as TouchList2;
    if (session?.source !== "touch" || !touchStart || touches.length < 2) {
      return;
    }
    // Ours, not the browser's page zoom.
    if (event.cancelable) {
      event.preventDefault();
    }
    const now = touchGeometry(touches);
    update(now.distance / touchStart.distance, now.mid.clientX - touchStart.mid.clientX, now.mid.clientY - touchStart.mid.clientY);
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (session?.source === "touch" && (event.touches as unknown as TouchList2).length < 2) {
      touchStart = null;
      end();
    }
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

  const active = { passive: false } as const;
  target.addEventListener("wheel", onWheel, active);
  target.addEventListener("gesturestart", onGestureStart);
  target.addEventListener("gesturechange", onGestureChange);
  target.addEventListener("gestureend", onGestureEnd);
  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchmove", onTouchMove, active);
  target.addEventListener("touchend", onTouchEnd);
  target.addEventListener("touchcancel", onTouchEnd);
  target.addEventListener("keydown", onKeyDown);
  return () => {
    clearTimeout(wheelTimer);
    session = null;
    target.removeEventListener("wheel", onWheel);
    target.removeEventListener("gesturestart", onGestureStart);
    target.removeEventListener("gesturechange", onGestureChange);
    target.removeEventListener("gestureend", onGestureEnd);
    target.removeEventListener("touchstart", onTouchStart);
    target.removeEventListener("touchmove", onTouchMove);
    target.removeEventListener("touchend", onTouchEnd);
    target.removeEventListener("touchcancel", onTouchEnd);
    target.removeEventListener("keydown", onKeyDown);
  };
}
