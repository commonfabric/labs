/**
 * seal-liveness — the shared host cursor channel that drives the verified seal's
 * always-on reflective sheen.
 *
 * The sheen is the load-bearing anti-forgery signal: one global `pointermove`
 * listener + one rAF loop place a reflective hotspot on every registered seal
 * that tracks the host cursor *even when the cursor is nowhere near the seal*. A
 * sandboxed pattern only receives pointer events inside its own iframe, so a
 * forgery cannot glint toward a cursor that is elsewhere on screen.
 *
 * The seal's other motion — the ambient ring rotation and shimmer sweep — is
 * pure CSS, gated to `:hover`, and lives in the component's stylesheet, not
 * here: a dense roster stays calm at rest, and a seal comes alive when engaged.
 *
 * Cost is bounded: the loop runs only while ≥1 seal is registered, touches only
 * registered seals, culls offscreen ones, and skips writes for seals the cursor
 * is far from. Reduced motion is honored *live* — enabling it tears the loop
 * down and clears every seal's highlight; disabling it resumes the loop.
 */

/**
 * Implemented by a seal that wants cursor-driven sheen. `updateSeal` is called
 * once per animation frame while registered; `clearSeal` is called when the loop
 * stops (e.g. the user turns on reduced motion) so the seal can reset its
 * highlight rather than freeze mid-glint.
 */
export interface SealLivenessClient {
  updateSeal(cursorX: number, cursorY: number, frameMs: number): void;
  clearSeal(): void;
}

/** The parts of a window the controller drives the sheen through. */
export interface SealLivenessWindow {
  requestAnimationFrame(callback: (frameMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  addEventListener(
    type: "pointermove",
    listener: (event: PointerEvent) => void,
    options: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "pointermove",
    listener: (event: PointerEvent) => void,
  ): void;
  matchMedia?(query: string): {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
  };
}

/** Registers and unregisters the seals one window's sheen loop drives. */
export interface SealLiveness {
  /** Registers a seal for cursor sheen. The loop starts on the first seal. */
  register(client: SealLivenessClient): void;
  /** Unregisters a seal; the listener and frame stop when the last leaves. */
  unregister(client: SealLivenessClient): void;
}

/** The sheen loop of `window`. */
export const createSealLiveness = (
  window: SealLivenessWindow,
): SealLiveness => {
  const clients = new Set<SealLivenessClient>();
  let cursorX = -1e6;
  let cursorY = -1e6;
  let frame = 0;
  let listening = false;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  const onPointerMove = (e: PointerEvent): void => {
    cursorX = e.clientX;
    cursorY = e.clientY;
  };

  const tick = (t: number): void => {
    frame = 0;
    for (const c of clients) c.updateSeal(cursorX, cursorY, t);
    if (clients.size > 0) frame = window.requestAnimationFrame(tick);
  };

  const startLoop = (): void => {
    if (reducedMotion?.matches) return;
    if (!listening) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      listening = true;
    }
    if (!frame) frame = window.requestAnimationFrame(tick);
  };

  const stopLoop = (): void => {
    if (listening) {
      window.removeEventListener("pointermove", onPointerMove);
      listening = false;
    }
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  // Honor a live prefers-reduced-motion toggle: stop the sheen loop (and clear
  // any lingering highlight) when it turns on; resume when it turns off.
  // Registrations persist across the toggle so seals don't have to re-register.
  reducedMotion?.addEventListener("change", () => {
    if (reducedMotion.matches) {
      stopLoop();
      for (const c of clients) c.clearSeal();
    } else if (clients.size > 0) {
      startLoop();
    }
  });

  return {
    register: (client) => {
      clients.add(client);
      startLoop();
    },
    unregister: (client) => {
      if (clients.delete(client) && clients.size === 0) stopLoop();
    },
  };
};

// Outside a browser (SSR, unit tests) there is no animation loop to drive, and
// the cursor sheen is a browser-only enhancement, so no seal is retained.
const liveness = typeof globalThis.requestAnimationFrame === "function"
  ? createSealLiveness(globalThis)
  : undefined;

/** Registers a verified seal for the page's cursor sheen. */
export const registerSeal = (client: SealLivenessClient): void =>
  liveness?.register(client);

/** Unregisters a seal from the page's cursor sheen. */
export const unregisterSeal = (client: SealLivenessClient): void =>
  liveness?.unregister(client);
