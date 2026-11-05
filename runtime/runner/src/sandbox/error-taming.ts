/**
 * Restoration of `Error.isError` — a vetted mid-lockdown shim.
 *
 * SES's error taming rebuilds the `Error` constructor from scratch rather than
 * patching the original, and copies forward only `length`, `prototype`, and
 * the V8 stack surface (`stackTraceLimit`, `prepareStackTrace`,
 * `captureStackTrace`). `Error.isError` is not among them, so lockdown leaves
 * the realm — host code included, not just compartments — without it. Every
 * `ses` release through 2.2.0 behaves this way; `permits.js` does list
 * `isError` under both `%InitialError%` and `%SharedError%`, but a permit only
 * says a property MAY survive, never that it gets added, so no version bump
 * fixes this on its own.
 *
 * The gap is silent until something calls it: `Error.isError(value)` throws
 * `TypeError: Error.isError is not a function`, and only in the post-lockdown
 * process. Code that classifies unknown values — data-model's
 * `tagOfConvertibleJsValueElseNull`, for one — reaches for it precisely because
 * it is the only correct error test across realms, `instanceof` being the thing
 * it exists to replace.
 *
 * We restore the genuine intrinsic rather than polyfill it. Captured at module
 * evaluation (before any lockdown), it is a pure predicate over the
 * `[[ErrorData]]` internal slot: no powers to withhold, no realm affinity, and
 * it is correct for the tamed constructors' instances because those are
 * still constructed from the original `Error`.
 *
 * Two consequences to be aware of:
 *
 * - This must run BETWEEN `repairIntrinsics()` and `hardenIntrinsics()`. The
 *   constructors do not exist before the repair phase and freeze during the
 *   harden phase, so the two-phase form of lockdown is the only seam where
 *   they are both present and extensible. `ensureSESInitialized` sequences it.
 * - There are two constructors to patch, not one. Repair mints `%InitialError%`
 *   for the host realm and a powerless `%SharedError%` for compartments;
 *   patching only the global would leave pattern code without it.
 */

/**
 * The real `Error.isError`, captured before lockdown can replace the
 * constructor holding it. `undefined` on a runtime that predates the method,
 * in which case there is nothing to restore -- and error classification, which
 * calls `Error.isError` directly, throws there rather than answering a weaker
 * way. That is the intended shape: `instanceof` is not a substitute here, it
 * is the very test SES's two `Error` constructors defeat, so answering with it
 * would be answering wrongly. Every runtime this project supports has the
 * method.
 */
const FERAL_IS_ERROR: unknown = (Error as { isError?: unknown }).isError;

/**
 * Reinstall `Error.isError` on both post-repair error constructors. Must be
 * called after `repairIntrinsics()` and before `hardenIntrinsics()`.
 *
 * Installs nothing unless handed a function, which is how a runtime whose
 * `Error` never had the method declines: `FERAL_IS_ERROR` is `undefined` there
 * and the default carries it in. Defining the property as `undefined` instead
 * would fail SES's `isError: fn` permit, so the harden pass would strip it
 * right back out and report an unpermitted intrinsic on every lockdown.
 *
 * `isError` is a parameter only so that path is reachable from a test; callers
 * pass nothing.
 */
export function restoreErrorIsError(isError: unknown = FERAL_IS_ERROR): void {
  if (typeof isError !== "function") return;

  // Both constructors, and they are always distinct: repair mints
  // `%InitialError%` for the host realm and the powerless `%SharedError%` for
  // compartments. Only the first is a global; repair leaves the second as the
  // shared `Error.prototype.constructor`.
  for (
    const constructor of [Error, Error.prototype.constructor as object]
  ) {
    // Matches the descriptor a standard built-in method carries. Harden makes
    // it non-writable and non-configurable a moment later, as it does for the
    // stack-surface properties SES itself defines here.
    Object.defineProperty(constructor, "isError", {
      value: isError,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
