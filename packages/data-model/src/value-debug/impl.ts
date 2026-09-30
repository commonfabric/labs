/** Top-level `export`ed debugging functions. */

import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import type {
  CompactDebugStringOptions,
  DebugValueOptions,
  FabricValue,
} from "@/interface.ts";

import type { ConversionLimits } from "./ConversionLimits.ts";
import { DebugConverter } from "./DebugConverter.ts";
import { DebugStringifier } from "./DebugStringifier.ts";

/**
 * The limits a conversion stops at whatever its options say, so that a result
 * is bounded in size whatever the input.
 */
const ABSOLUTE_LIMITS: ConversionLimits = Object.freeze({
  /** Nesting depth, bounded so that converting cannot blow out the stack. */
  maxDepth: 100,

  /** Number of array elements. */
  maxArrayLength: 10000,

  /** Number of bytes of a buffer. */
  maxBufferLength: 100000,

  /** Number of properties of an object. */
  maxProperties: 10000,

  /** Length of a string carried whole. */
  maxStringLength: 100000,

  /** Number of lines of a string carried whole. */
  maxStringLines: 1000,
});

/** The limits a conversion stops at, when its options do not say. */
const DEFAULT_LIMITS: ConversionLimits = Object.freeze({
  /** Nesting depth. */
  maxDepth: 10,

  /** Number of array elements. */
  maxArrayLength: 100,

  /** Number of bytes of a buffer. */
  maxBufferLength: 200,

  /** Number of properties of an object. */
  maxProperties: 100,

  /**
   * Length of a string carried whole. `checkedLimits()` uses `Infinity`
   * instead when the options state a line count.
   */
  maxStringLength: 200,

  /** Number of lines of a string carried whole. */
  maxStringLines: 5,
});

/** Length `toShortQuotedDebugString()` cuts a rendering to. */
const SHORT_MAX_LENGTH = 50;

/** Length `toLongQuotedDebugString()` cuts a rendering to. */
const LONG_MAX_LENGTH = 500;

/**
 * Renders a value an option check refuses, for the error which refuses it:
 * quoted for the message, and cut short, since what the value is matters
 * more than what it holds.
 */
function renderRefused(value: unknown): string {
  return toCompactDebugString(value, { maxLength: 20, backtickQuote: true });
}

/**
 * Helper for `checkedLimits()`, which validates `options` as a whole. What
 * each option holds is validated as it is read, by `checkedLimit()`.
 *
 * @throws {Error} if `options` is not a plain object.
 */
function checkOptions(options: DebugValueOptions | undefined): void {
  if ((options !== undefined) && !isPlainObject(options)) {
    const badOptions = renderRefused(options);
    throw new Error(
      `\`options\` must be a plain object or \`undefined\`; got ${badOptions}`,
    );
  }
}

/**
 * Helper for `checkedLimits()`, which validates one of the limit options and
 * returns the limit it calls for: `value` when present, and `defaultValue`
 * when not, either one capped at `cap`. `name` is the option's name, for the
 * error.
 *
 * @throws {Error} if `value` is none of a positive integer, `Infinity`, or
 * `undefined`.
 */
function checkedLimit(
  name: string,
  value: number | undefined,
  defaultValue: number,
  cap: number,
): number {
  switch (typeof value) {
    case "number": {
      if (
        (Number.isSafeInteger(value) && (value > 0)) || (value === Infinity)
      ) {
        return Math.min(value, cap);
      }
      break;
    }
    case "undefined": {
      return Math.min(defaultValue, cap);
    }
  }

  const badValue = renderRefused(value);
  throw new Error(
    `\`${name}\` must be a positive integer, \`Infinity\`, or \`undefined\`; got ${badValue}`,
  );
}

/**
 * Helper for `checkedLimits()`, which makes a `ConversionLimits` by calling
 * `limitFor` with the name of each limit in turn.
 */
function mapLimits(
  limitFor: (name: keyof ConversionLimits) => number,
): ConversionLimits {
  return {
    maxDepth: limitFor("maxDepth"),
    maxArrayLength: limitFor("maxArrayLength"),
    maxBufferLength: limitFor("maxBufferLength"),
    maxProperties: limitFor("maxProperties"),
    maxStringLength: limitFor("maxStringLength"),
    maxStringLines: limitFor("maxStringLines"),
  };
}

/**
 * Helper for the entry points, which validates `options` and returns the limits
 * they call for: each limit stated, or when not, its default, all capped at
 * their absolute maximums. The string length defaults to `Infinity` rather than
 * to its usual default when the options state a line count.
 *
 * @throws {Error} if `options` is not a plain object, or if one of its limits
 * is none of a positive integer, `Infinity`, or `undefined`.
 */
function checkedLimits(
  options: DebugValueOptions | undefined,
): ConversionLimits {
  checkOptions(options);

  // A caller who states a line count and no length gets a line bound alone,
  // not the default length on top of it.
  const defaults: ConversionLimits = (options?.maxStringLines === undefined)
    ? DEFAULT_LIMITS
    : { ...DEFAULT_LIMITS, maxStringLength: Infinity };

  return mapLimits((name) =>
    checkedLimit(name, options?.[name], defaults[name], ABSOLUTE_LIMITS[name])
  );
}

/**
 * Renders the debug-string form of the given value with optional indentation,
 * by converting it with `toStructuredDebugValue()` per `options` and rendering
 * the result.
 *
 * @throws {Error} if given invalid `options`.
 */
function renderDebugString(
  value: unknown,
  options: DebugValueOptions | undefined,
  indent?: number,
): string {
  // The limits are resolved here, ahead of the `try`, so that an invalid one
  // is refused rather than rendered as unrenderable.
  const limits = checkedLimits(options);
  const converterOptions: DebugValueOptions = { ...options, ...limits };

  try {
    const converted = toStructuredDebugValue(value, converterOptions);
    return new DebugStringifier(limits, options?.replacer, indent)
      .render(converted);
    // deno-coverage-ignore-start
  } catch {
    // Neither the conversion nor the rendering is meant to throw. This `catch`
    // is a prophylactic "just in case" to nail down the intention of really
    // really trying not to `throw` out of this function.
    return "<unrenderable debug string>";
  }
  // deno-coverage-ignore-stop
}

/**
 * Produces a compact string representation of a value, optionally truncating to
 * the maximum length given in `options`. When truncating is requested and turns
 * out to be necessary, the returned result will be the indicated length, which
 * includes an "ASCII ellipsis" of `...`. When `options` asks for it, the result
 * is then quoted as a Markdown code span, ready to splice into message text.
 *
 * The value is first converted with `toStructuredDebugValue()`, passing along
 * the depth limit and replacer given in `options`, and it is that result which
 * gets rendered. This function handles:
 * * all normal JSON-compatible values.
 * * other JavaScript primitive values:
 *   * bigints.
 *   * symbols, both interned and uninterned.
 *   * non-finite numbers.
 *   * `-0`.
 * * functions.
 * * `FabricInstance`s and `FabricPrimitive`s.
 * * instances of other classes.
 * * objects and arrays with circular references.
 * * arrays with holes.
 *
 * The rendering stops at the nesting depth given in `options`, ten levels
 * when not given, below which a value is elided. It likewise stops at the
 * array length given in `options`, one hundred elements when not given, and
 * says the array's actual length in place of the elements past it; likewise
 * at the property count given in `options`, one hundred when not given, and
 * says the object's actual count in place of the properties past it; and a
 * string longer than the string length given in `options`, two hundred
 * characters when not given, renders as an excerpt of that length followed by
 * the string's actual length. A buffer within a `FabricPrimitive` with more
 * bytes than the buffer length given in `options`, two hundred when not given,
 * renders that many bytes followed by the buffer's actual length.
 *
 * How any of these renders is _not_ a contract. The rendering is meant for a
 * human reading a diagnostic, and it changes as that reading is improved;
 * nothing but a test should depend on its details.
 *
 * If the rendering could not be completed, this function returns the literal
 * string `"<unrenderable debug string>"`.
 *
 * **Note:** In _many_ cases, the output of this function is valid JSON text,
 * but not _all_ cases. This function must _not_ be relied on to produce a
 * parseable string.
 *
 * @throws {Error} if given invalid `options`.
 */
export function toCompactDebugString(
  value: unknown,
  options?: CompactDebugStringOptions,
): string {
  let result = renderDebugString(value, options);
  const maxLength = options?.maxLength;

  if (typeof maxLength === "number") {
    const actualMax = Math.max(Math.floor(maxLength), 3);
    if (result.length > actualMax) {
      result = result.slice(0, actualMax - 3) + "...";
    }
  }

  return (options?.backtickQuote === true) ? backtickQuote(result) : result;
}

/**
 * Renders `value` for an error message: its compact debug string, cut to a
 * length which keeps a large value from swamping the message it lands in, as
 * a backtick-quoted code span. `toCompactDebugString()` returns a fixed string
 * for what it cannot render, so this holds up on the failure path it serves.
 *
 * The cut is at fifty characters, which is enough to say what kind of value
 * arrived and not enough to say much about it; `toLongQuotedDebugString()`
 * is the rendering for a message whose reader needs to recognize the value.
 */
export function toShortQuotedDebugString(value: unknown): string {
  return toCompactDebugString(value, {
    maxLength: SHORT_MAX_LENGTH,
    backtickQuote: true,
  });
}

/**
 * Like `toShortQuotedDebugString()`, except cut at five hundred characters.
 * This is the rendering for a message whose reader needs to recognize the
 * value -- which message arrived, which binding was wrong -- and it is still
 * bounded, so that a value a caller does not control cannot flood the channel
 * the message is reported on.
 */
export function toLongQuotedDebugString(value: unknown): string {
  return toCompactDebugString(value, {
    maxLength: LONG_MAX_LENGTH,
    backtickQuote: true,
  });
}

/**
 * Like `toCompactDebugString()`, except that the result is indented by two
 * spaces per nesting level, and is never truncated for length, there being no
 * length to give. The depth limit and replacer apply to both. A string holding
 * a line break renders one line of the string per line of the result, each
 * quoted, every line but the last followed by ` +`, and every line but the
 * first indented one level further than the value; and the length of a string
 * carried in part follows its excerpt on a line of its own, indented the same
 * way.
 *
 * @throws {Error} if given invalid `options`.
 */
export function toIndentedDebugString(
  value: unknown,
  options?: DebugValueOptions,
): string {
  return renderDebugString(value, options, 2);
}

/**
 * Produces a valid `FabricValue` meant to represent the given value as
 * accurately as possible, suitable for use in debugging, including rendering as
 * a debug string or including in a structured debug log. All valid
 * `FabricValue`s are self-represented in the result. Beyond that, no specific
 * guarantees are made as to the exact nature of the conversion. The general aim
 * is to represent non-`FabricValue` results in a way reminiscent of the
 * `codec-json` encoding form, and with as little chance for ambiguity as can
 * be reasonably achieved.
 *
 * The limits of the result -- its nesting, the number of elements of an array
 * it represents, the number of properties of an object it represents, and the
 * length and number of lines of a string it carries whole -- and a replacer to
 * consult are the `maxDepth`, `maxArrayLength`, `maxProperties`,
 * `maxStringLength`, `maxStringLines`, and `replacer` of `options`. When there
 * is no nesting limit given, the result nests to ten levels; when there is no
 * array length given, an array is represented to one hundred elements; when
 * there is no property count given, an object is represented to one hundred
 * properties; when there is no string line count given, a string is carried
 * whole to five lines; and when there is no string length given, a string is
 * carried whole to two hundred characters, or as long as the conversion allows
 * when a line count is given. The `maxBufferLength` of `options` is validated
 * like the other limits and has no effect on the result: a `FabricPrimitive`
 * is carried whole, and that limit applies only when one is rendered.
 *
 * If the conversion could not be completed (stack overflow, object
 * `toJSON()` conversion error, etc.), this function returns the literal value
 * `{ "/unconvertible": "<errorMessage>" }`.
 *
 * @throws {Error} if given invalid `options`.
 */
export function toStructuredDebugValue(
  /** Value to convert. */
  value: any,
  /** Conversion options, if desired. */
  options?: DebugValueOptions,
): FabricValue {
  const limits = checkedLimits(options);

  return new DebugConverter(value, limits, options?.replacer).convert();
}
