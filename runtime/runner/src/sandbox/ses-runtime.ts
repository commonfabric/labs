import type { SourceMap } from "@commonfabric/js-compiler";
import {
  type MappedPosition,
  SourceMapParser,
} from "@commonfabric/js-compiler/source-map";
import "ses";
import { createCallbackCompartmentGlobals } from "./compartment-globals.ts";
import { restoreErrorIsError } from "./error-taming.ts";
import { hardenVerifiedFunction } from "./function-hardening.ts";
import { sanitizeLocaleMethods } from "./locale-taming.ts";

export interface SESRuntimeOptions {
  globals?: Record<string, unknown>;
  lockdown?: boolean;
  hideInternalStackFrames?: boolean;
}

interface SESCompartmentLike {
  evaluate(source: string): unknown;
  globalThis?: object;
}

class SESInternals {
  #sourceMaps = new SourceMapParser();

  #options: SESRuntimeOptions;

  constructor(options: SESRuntimeOptions = {}) {
    this.#options = options;
  }

  exec<T>(callback: () => T): T {
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        return result.catch((error: unknown) => {
          throw this.mapThrownError(error);
        }) as T;
      }
      return result;
    } catch (e: unknown) {
      throw this.mapThrownError(e);
    }
  }

  loadSourceMapLazy(filename: string, provider: () => SourceMap | undefined) {
    this.#sourceMaps.loadLazy(filename, provider);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.#sourceMaps.mapPosition(filename, line, column);
  }

  parseStack(stack: string): string {
    const mappedStack = this.#sourceMaps.parse(stack);
    return this.#options.hideInternalStackFrames
      ? sanitizeInternalFrames(mappedStack)
      : mappedStack;
  }

  clear(): void {
    this.#sourceMaps.clear();
  }

  mapThrownError(error: unknown): unknown {
    if (!(error instanceof Error)) {
      return error;
    }
    // Source-map an error's stack at most once. `parseStack` is not idempotent:
    // ESM per-module source maps are registered under the same module path that
    // mapped frames carry as their source, so re-parsing an already-mapped
    // stack would look the (now original-source) coordinates up in the map
    // again and corrupt them (e.g. collapse the throw frame to <CF_INTERNAL>).
    // Errors cross several mapping seams (nested SES invokes, the scheduler's
    // handleSchedulerError), hence the explicit once-marker.
    if (isErrorStackMapped(error)) {
      return error;
    }
    materializeHostVisibleStack(error);
    if (error.stack) {
      error.stack = this.parseStack(error.stack);
      markErrorStackMapped(error);
    }
    return error;
  }
}

export class SESRuntime extends EventTarget {
  #internals: SESInternals;

  readonly #callbackEvaluator: SESCallbackEvaluator;

  constructor(options: SESRuntimeOptions = {}) {
    super();
    this.#internals = new SESInternals(options);
    this.#callbackEvaluator = new SESCallbackEvaluator(options);
  }

  /** The callback evaluator, which a test reads directly. */
  get accessForTestingOnly(): {
    readonly callbackEvaluator: SESCallbackEvaluator;
  } {
    return { callbackEvaluator: this.#callbackEvaluator };
  }

  /**
   * Call `callback` and source-map the stack of whatever it throws — or of the
   * rejection, when it returns a promise. Mapping happens once per error (see
   * `SESInternals.mapThrownError`). The scheduler runs each action through
   * `Engine.invoke`, which lands here, so an error raised in pattern code
   * reaches the scheduler carrying authored coordinates.
   */
  exec<T>(callback: () => T): T {
    return this.#internals.exec(callback);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.#internals.mapPosition(filename, line, column);
  }

  /**
   * Register a source map under `filename` so {@link mapPosition} (and stack
   * parsing) can translate bundle coordinates back to original sources.
   * `provider` runs (once) on the first lookup that needs `filename`. The ESM
   * boot path registers its composed bundle/per-module maps this way —
   * composition is a per-segment VLQ transcode over every module, and error
   * mapping is on-demand, so boots that never look up a frame never pay it
   * (CT-1819).
   */
  loadSourceMapLazy(
    filename: string,
    provider: () => SourceMap | undefined,
  ): void {
    this.#internals.loadSourceMapLazy(filename, provider);
  }

  parseStack(stack: string): string {
    return this.#internals.parseStack(stack);
  }

  /**
   * Materialize + source-map a thrown error's stack (once — see
   * `SESInternals.mapThrownError`). Used by the engine for errors that escape
   * module evaluation outside an {@link exec} call (e.g. `loadModuleGraph`).
   */
  mapThrownError(error: unknown): unknown {
    return this.#internals.mapThrownError(error);
  }

  evaluateCallback(source: string): unknown {
    return this.#callbackEvaluator.evaluate(source);
  }

  clear(): void {
    this.#internals.clear();
    this.#callbackEvaluator.clear();
  }
}

export function evaluateFunctionSourceInSES(
  source: string,
  options: SESRuntimeOptions = {},
): unknown {
  ensureSESInitialized(!!options.lockdown);
  const compartment = createCompartment(options.globals ?? {});
  try {
    return compartment.evaluate(`(${source})`);
  } catch (e: unknown) {
    if (e instanceof Error) {
      materializeHostVisibleStack(e);
    }
    throw e;
  }
}

export function ensureSESLockdown(): void {
  ensureSESInitialized(true);
}

export function evaluateCallbackSourceInSES(
  source: string,
  options: SESRuntimeOptions = {},
): unknown {
  return new SESCallbackEvaluator(options).evaluate(source);
}

let sesInitialized = false;
const SES_RUNTIME_STATE = Symbol.for("@commonfabric/runner/ses-runtime-state");

function ensureSESInitialized(lockdownEnabled: boolean): void {
  if (!lockdownEnabled) {
    return;
  }
  const globalState = getGlobalSESRuntimeState();
  if (sesInitialized || globalState.lockdownInitialized) {
    sesInitialized = true;
    return;
  }
  // `lockdown()` is `repairIntrinsics()` then `hardenIntrinsics()`; we run the
  // two phases ourselves because restoreErrorIsError() needs the seam between
  // them — the error constructors exist only after the first and freeze during
  // the second. `hardenIntrinsics` is revealed by the repair call, so it can
  // only be read afterwards.
  const repairFn = (globalThis as {
    repairIntrinsics?: (options?: SESLockdownOptions) => void;
  }).repairIntrinsics;
  if (typeof repairFn !== "function") {
    throw new Error("SES repairIntrinsics() is unavailable");
  }
  // Vetted shim — must precede the repair, which is where SES's locale taming
  // would otherwise clobber these methods (and after which they freeze).
  // Pairs with `localeTaming: "unsafe"` below; see locale-taming.ts.
  sanitizeLocaleMethods();
  repairFn(DEFAULT_LOCKDOWN_OPTIONS);
  // Vetted shim — must sit between the two phases; see error-taming.ts.
  restoreErrorIsError();
  // Asserted, not guarded: the repair call above is what reveals
  // `hardenIntrinsics`, so its absence is not an environment question the way
  // `repairIntrinsics` itself is — it would mean ses broke its own contract.
  // Were that ever to happen this throws, which is the outcome that matters;
  // the one thing lockdown must never do is quietly skip the harden.
  const globalWithPhases = globalThis as { hardenIntrinsics?: () => void };
  globalWithPhases.hardenIntrinsics!();
  // `lockdown()` never reveals `hardenIntrinsics`, so drop it again: the host
  // realm's global surface should differ from the one-call form only by the
  // restored `Error.isError`. It is spent either way — the phases have run —
  // but leaving it would let host code re-enter the harden pass.
  delete globalWithPhases.hardenIntrinsics;
  globalState.lockdownInitialized = true;
  sesInitialized = true;
}

interface SESLockdownOptions {
  errorTaming: "safe" | "unsafe" | "unsafe-debug";
  errorTrapping: "platform" | "none" | "report" | "abort" | "exit";
  reporting: "platform" | "console" | "none";
  unhandledRejectionTrapping: "none" | "report";
  regExpTaming: "safe" | "unsafe";
  localeTaming: "safe" | "unsafe";
  consoleTaming: "unsafe" | "safe";
  overrideTaming: "moderate" | "min" | "severe";
  stackFiltering: "concise" | "omit-frames" | "shorten-paths" | "verbose";
  domainTaming: "safe" | "unsafe";
  evalTaming: "safe-eval" | "unsafe-eval" | "no-eval";
  overrideDebug: string[];
  legacyRegeneratorRuntimeTaming: "safe" | "unsafe-ignore";
  __hardenTaming__: "safe" | "unsafe";
}

const DEFAULT_LOCKDOWN_OPTIONS: SESLockdownOptions = {
  errorTaming: "safe",
  errorTrapping: "platform",
  reporting: "none",
  unhandledRejectionTrapping: "report",
  regExpTaming: "safe",
  // "unsafe" here does NOT mean ambient locale access: sanitizeLocaleMethods()
  // (called just before lockdown) replaces every method "safe" would amputate
  // with a pinned-default wrapper (locale "en-US", Date timeZone "UTC",
  // explicit arguments honored). "safe" would clobber those wrappers with
  // argument-ignoring non-locale aliases. See locale-taming.ts.
  localeTaming: "unsafe",
  consoleTaming: "unsafe",
  overrideTaming: "severe",
  stackFiltering: "concise",
  domainTaming: "safe",
  evalTaming: "safe-eval",
  overrideDebug: [],
  legacyRegeneratorRuntimeTaming: "safe",
  __hardenTaming__: "safe",
};

function createCompartment(globals: Record<string, unknown>) {
  const CompartmentCtor = (globalThis as {
    Compartment?: new (
      globals?: Record<string, unknown>,
    ) => SESCompartmentLike;
  }).Compartment;
  if (!CompartmentCtor) {
    throw new Error("SES Compartment is unavailable");
  }
  const compartment = new CompartmentCtor(globals);
  // SES freezes intrinsics, but compartment global bindings remain writable
  // unless we explicitly lock them down.
  Object.freeze(compartment.globalThis);
  return compartment;
}

class SESCallbackEvaluator {
  #callbackCompartment: SESCompartmentLike | undefined;

  readonly #callbackCreatorCache = new Map<string, () => unknown>();

  #options: SESRuntimeOptions;

  constructor(options: SESRuntimeOptions = {}) {
    this.#options = options;
  }

  /** The callback-creator cache, which a test reads directly. */
  get accessForTestingOnly(): {
    readonly callbackCreatorCache: Map<string, () => unknown>;
  } {
    return { callbackCreatorCache: this.#callbackCreatorCache };
  }

  evaluate(source: string): unknown {
    const normalizedSource = normalizeDirectFunctionSource(source);
    const createCallback = this.#getCachedCallbackCreator(normalizedSource);

    return hardenVerifiedFunction((...args: unknown[]) => {
      const fn = createCallback();
      if (typeof fn !== "function") {
        throw new Error("Callback source did not produce a function");
      }
      return Reflect.apply(
        hardenVerifiedFunction(fn as (...args: unknown[]) => unknown),
        undefined,
        args,
      );
    });
  }

  clear(): void {
    this.#callbackCreatorCache.clear();
    this.#callbackCompartment = undefined;
  }

  #getCachedCallbackCreator(source: string): () => unknown {
    const cached = this.#callbackCreatorCache.get(source);
    if (cached) {
      return cached;
    }

    const compartment = this.#getSharedCallbackCompartment();
    const creator = compartment.evaluate(createCallbackCreatorSource(source));
    if (typeof creator !== "function") {
      throw new Error("Callback source must evaluate to a function creator");
    }

    this.#callbackCreatorCache.set(source, creator as () => unknown);
    return creator as () => unknown;
  }

  #getSharedCallbackCompartment(): SESCompartmentLike {
    ensureSESInitialized(true);
    if (!this.#callbackCompartment) {
      this.#callbackCompartment = createCompartment(
        createCallbackCompartmentGlobals(this.#options.globals ?? {}),
      );
    }
    return this.#callbackCompartment;
  }
}

function normalizeDirectFunctionSource(source: string): string {
  const trimmedSource = source.trim();
  if (trimmedSource.length === 0) {
    throw new Error("Callback source must not be empty");
  }
  return trimmedSource;
}

function createCallbackCreatorSource(source: string): string {
  const callbackExpression = JSON.stringify(`(${source})`);
  return `(() => {
    const source = ${callbackExpression};
    return () => {
      const fn = (0, eval)(source);
      if (typeof fn !== "function") {
        throw new Error("Callback source did not produce a function");
      }
      return fn;
    };
  })()`;
}

// Errors whose `stack` has already been source-mapped (see
// `SESInternals.mapThrownError`). Keyed by the error object so the marker
// survives rethrows across seams without mutating (possibly frozen) errors.
const mappedErrorStacks = new WeakSet<Error>();

export function markErrorStackMapped(error: Error): void {
  mappedErrorStacks.add(error);
}

export function isErrorStackMapped(error: Error): boolean {
  return mappedErrorStacks.has(error);
}

function materializeHostVisibleStack(error: Error): void {
  if (typeof error.stack === "string" && error.stack.length > 0) {
    return;
  }
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString !== "function") {
    return;
  }
  const frames = getStackString(error);
  if (!frames) {
    return;
  }
  error.stack = `${error}${frames.startsWith("\n") ? frames : `\n${frames}`}`;
}

function isPromiseLike(
  value: unknown,
): value is Promise<unknown> {
  return !!value && typeof (value as { catch?: unknown }).catch === "function";
}

function sanitizeInternalFrames(stack: string): string {
  return stack.split("\n").map((line) =>
    RUNNER_INTERNAL_FRAME_PATTERN.test(line) ? CF_INTERNAL : line
  ).join("\n");
}

const CF_INTERNAL = "    at <CF_INTERNAL>";
const RUNNER_INTERNAL_FRAME_PATTERN =
  /^\s*at(?: .*?)? \(?(?:file:\/\/)?(?:[^)\n]*\/)?runtime\/runner\/src\/[^)\n]+:\d+:\d+\)?$/;

function getGlobalSESRuntimeState(): { lockdownInitialized: boolean } {
  const globalObject = globalThis as typeof globalThis & {
    [SES_RUNTIME_STATE]?: { lockdownInitialized: boolean };
  };
  if (!globalObject[SES_RUNTIME_STATE]) {
    globalObject[SES_RUNTIME_STATE] = { lockdownInitialized: false };
  }
  return globalObject[SES_RUNTIME_STATE];
}
