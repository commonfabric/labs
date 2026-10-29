/**
 * Deterministic locale-method sanitization — a vetted pre-lockdown shim.
 *
 * SES `localeTaming: "safe"` amputates the `toLocale*` family: each method is
 * aliased to its non-locale equivalent and its arguments are silently ignored
 * (`toLocaleDateString("en-US", { month: "short" })` returns `toDateString()`
 * output). SES does this because the methods' DEFAULT arguments reach ambient
 * host state — an omitted `locales` resolves to the host locale and an omitted
 * `options.timeZone` to the host timezone — which is nondeterministic across
 * runtimes and a fingerprinting channel. But called with explicit arguments
 * these methods are pure functions of their inputs (modulo the engine's
 * ICU/CLDR tables), so amputation throws away a legitimately useful surface.
 *
 * We sanitize instead: each method that `localeTaming: "safe"` would alias is
 * replaced with a wrapper that pins every ambient default — an omitted locale
 * → "en-US", an omitted Date timeZone → "UTC", and the unsupported-tag
 * FALLBACK locale → "en-US" (see pinLocales) — and delegates to the original,
 * passing explicit arguments through otherwise untouched. Lockdown then runs
 * with `localeTaming: "unsafe"` so SES leaves the sanitized methods in place
 * and hardens them like any other intrinsic.
 *
 * Two consequences to be aware of:
 *
 * - This must run BEFORE `lockdown()` — the prototypes freeze at lockdown.
 *   `ensureSESInitialized` sequences it.
 * - It patches the realm's shared intrinsics, so host (non-pattern) code sees
 *   the sanitized methods too. That is strictly closer to native behavior
 *   than the status quo, where post-lockdown host code got the amputated
 *   aliases.
 *
 * Residual nondeterminism, accepted: ICU/CLDR version skew — identical
 * explicit inputs can format differently across engine versions (e.g. ICU
 * 72's switch to U+202F time separators). This is the same hazard class as
 * the untamed local-timezone Date getters (`getFullYear()` etc.), which
 * remain host-local.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";

const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIME_ZONE = "UTC";

type Locales = string | string[] | undefined;

// Pin every path that ECMA-402 would resolve to the host's default locale:
// an omitted `locales` (undefined or an empty array) becomes the pinned
// default, and — the subtle one — the pinned default is APPENDED to every
// explicit request, because a well-formed-but-unsupported tag ("xx") would
// otherwise fall back to the host default locale, letting sandboxed code
// read the user's language/region off the formatted output. With the
// fallback appended, resolution picks the caller's tag when the host
// supports it and "en-US" when it doesn't — never the host default.
// Malformed tags still throw RangeError, unchanged.
// Exported for tests: the leak closure itself can't be asserted in-process
// (the realm's default locale is fixed at startup), so the tests pin this
// mechanism and ECMA-402 resolution does the rest.
export const pinLocales = (locales: Locales): unknown[] | string => {
  if (locales === undefined) return DEFAULT_LOCALE;
  // A bare string is a single tag. Everything else — a real array OR an
  // array-like (`{ 0: "de-DE", length: 1 }`), both of which ECMA-402's
  // CanonicalizeLocaleList accepts — is materialized to the elements native
  // would iterate, then the pinned fallback is appended so resolution can
  // never fall through to the host default locale. `Array.from` also turns a
  // no-length object into `[]` (→ just the fallback), matching native's
  // empty-list-uses-default behavior while keeping our default, not the host's.
  if (typeof locales === "string") return [locales, DEFAULT_LOCALE];
  return [...Array.from(locales as ArrayLike<unknown>), DEFAULT_LOCALE];
};

// Pin the Date `timeZone` so formatting can never fall through to the host
// zone. Fail closed: only two shapes are accepted — `undefined` (omitted), and
// a plain object whose `timeZone` is either absent or a plain OWN data
// property. Everything else throws, because every other shape is a host-zone
// leak or a read-inconsistency hazard, and no legitimate caller needs it:
//
//   - primitives / functions: V8 coerces them to an object with no `timeZone`
//     (functions are objects; `ToObject` boxes primitives), so native formats
//     in the host zone. We reject rather than box.
//   - null: native throws `TypeError`; we reject consistently.
//   - a `timeZone` accessor (`{ get timeZone() {…} }`): a stateful getter can
//     return a real zone when we validate and `undefined` (→ host zone) on
//     native's read.
//   - an inherited `timeZone`: not a plain own property; treated the same as
//     an accessor for simplicity.
//
// Unlike locale resolution (which silently falls back — see pinLocales),
// ECMA-402 throws on an invalid *explicit* timeZone string, so a plain own
// value is safe to forward: `"Not/AZone"` / `null` still throw `RangeError`
// from native, and `undefined` (== omitted) is pinned to UTC.
const pinDateOptions = (
  options: Intl.DateTimeFormatOptions | undefined,
): unknown => {
  if (options === undefined) return { timeZone: DEFAULT_TIME_ZONE };
  if (!isObjectOrArray(options)) {
    throw new TypeError(
      "sanitized Intl: Date options must be a plain object or undefined",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "timeZone");
  if (descriptor !== undefined && !("value" in descriptor)) {
    throw new TypeError(
      "sanitized Intl: options.timeZone must be a plain value, not a getter",
    );
  }
  if (descriptor === undefined && "timeZone" in options) {
    throw new TypeError(
      "sanitized Intl: options.timeZone must be an own property",
    );
  }
  // `descriptor.value` is the reflected data value — reading it invokes no
  // getter (accessors were rejected above). Absent or explicit-undefined → UTC;
  // any other value is forwarded for native to honor or reject. Built on
  // Object.create so the caller's object is untouched and its other options
  // resolve through the prototype chain.
  const timeZone = descriptor?.value;
  return Object.create(options, {
    timeZone: {
      value: timeZone === undefined ? DEFAULT_TIME_ZONE : timeZone,
      enumerable: true,
      writable: true,
      configurable: true,
    },
  });
};

type AnyLocaleMethod = (
  this: unknown,
  ...args: unknown[]
) => unknown;

function replaceMethod(
  proto: object,
  name: string,
  wrap: (original: AnyLocaleMethod) => AnyLocaleMethod,
): void {
  const original = (proto as Record<string, unknown>)[name];
  if (typeof original !== "function") return; // absent on this host — nothing to sanitize
  Object.defineProperty(proto, name, {
    value: wrap(original as AnyLocaleMethod),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

let applied = false;

/**
 * Replace every locale-sensitive intrinsic method that
 * `localeTaming: "safe"` would alias with its pinned-default sanitized
 * wrapper. Idempotent; must be called before `lockdown()`.
 */
export function sanitizeLocaleMethods(): void {
  if (applied) return;
  applied = true;

  // Date: pin both the locale and the timezone defaults.
  for (
    const name of [
      "toLocaleDateString",
      "toLocaleTimeString",
      "toLocaleString",
    ] as const
  ) {
    replaceMethod(
      Date.prototype,
      name,
      (original) =>
        function (this: unknown, locales?: unknown, options?: unknown) {
          return original.call(
            this,
            pinLocales(locales as Locales),
            pinDateOptions(options as Intl.DateTimeFormatOptions | undefined),
          );
        },
    );
  }

  // Number / BigInt: pin the locale default; options pass through.
  for (const proto of [Number.prototype, BigInt.prototype]) {
    replaceMethod(
      proto,
      "toLocaleString",
      (original) =>
        function (this: unknown, locales?: unknown, options?: unknown) {
          return original.call(this, pinLocales(locales as Locales), options);
        },
    );
  }

  // String: `localeCompare(that, locales, options)` and the locale-sensitive
  // case mappings. Left untouched, `localeTaming: "unsafe"` would reintroduce
  // the ambient host locale for bare calls of all three.
  replaceMethod(
    String.prototype,
    "localeCompare",
    (original) =>
      function (
        this: unknown,
        that?: unknown,
        locales?: unknown,
        options?: unknown,
      ) {
        return original.call(
          this,
          that,
          pinLocales(locales as Locales),
          options,
        );
      },
  );
  for (const name of ["toLocaleLowerCase", "toLocaleUpperCase"] as const) {
    replaceMethod(
      String.prototype,
      name,
      (original) =>
        function (this: unknown, locales?: unknown) {
          return original.call(this, pinLocales(locales as Locales));
        },
    );
  }

  // Deliberately untouched: Object.prototype.toLocaleString is
  // locale-independent (`this.toString()` per ES, not amended by ECMA-402),
  // and Array/%TypedArray%.prototype.toLocaleString delegate to their
  // elements' toLocaleString — which are sanitized above.
}
