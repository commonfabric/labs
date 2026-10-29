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

export const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

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

const clients = new Set<SealLivenessClient>();
let cursorX = -1e6;
let cursorY = -1e6;
let rafId = 0;
let listening = false;

const onPointerMove = (e: PointerEvent): void => {
  cursorX = e.clientX;
  cursorY = e.clientY;
};

const tick = (t: number): void => {
  rafId = 0;
  for (const c of clients) c.updateSeal(cursorX, cursorY, t);
  if (clients.size > 0) {
    rafId = globalThis.requestAnimationFrame(tick);
  } else {
    stopLoop();
  }
};

const startLoop = (): void => {
  // Needs a real animation loop; bail under reduced motion and in non-browser
  // envs (SSR, unit tests) rather than throwing on a missing requestAnimationFrame.
  if (prefersReducedMotion()) return;
  if (typeof globalThis.requestAnimationFrame !== "function") return;
  if (!listening) {
    globalThis.addEventListener("pointermove", onPointerMove, {
      passive: true,
    });
    listening = true;
  }
  if (!rafId) rafId = globalThis.requestAnimationFrame(tick);
};

const stopLoop = (): void => {
  if (listening) {
    globalThis.removeEventListener("pointermove", onPointerMove);
    listening = false;
  }
  if (rafId) {
    globalThis.cancelAnimationFrame(rafId);
    rafId = 0;
  }
};

// Honor a live prefers-reduced-motion toggle: stop the sheen loop (and clear any
// lingering highlight) when it turns on; resume when it turns off. Registrations
// persist across the toggle so seals don't have to re-register.
const reducedMotionQuery =
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
reducedMotionQuery?.addEventListener?.("change", () => {
  if (prefersReducedMotion()) {
    stopLoop();
    for (const c of clients) c.clearSeal();
  } else if (clients.size > 0) {
    startLoop();
  }
});

/** Register a verified seal for cursor sheen. The loop starts on the first seal. */
export const registerSeal = (client: SealLivenessClient): void => {
  // No animation loop available (SSR / unit tests) → don't retain a client we
  // can never drive; the cursor sheen is a browser-only enhancement anyway.
  if (typeof globalThis.requestAnimationFrame !== "function") return;
  clients.add(client);
  startLoop();
};

/** Unregister a seal; the loop (listener + rAF) tears down when the last leaves. */
export const unregisterSeal = (client: SealLivenessClient): void => {
  if (clients.delete(client) && clients.size === 0) stopLoop();
};
