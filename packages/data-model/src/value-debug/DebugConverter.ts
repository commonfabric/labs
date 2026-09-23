import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

// Imported from its own module rather than the `codec-common` barrel,
// deliberately. The barrel loads every codec, the codecs load the
// `fabric-bases` barrel, and that barrel loads `value-debug` so as to install
// the debug renderers. Going through the barrel would therefore cause a
// circular load-time dependency. `codecOf.ts` itself is a leaf.
import { codecOf } from "@/codec-common/codecOf.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";

import { classNameOf } from "./classNameOf.ts";
import type { ConversionLimits } from "./ConversionLimits.ts";
import { toDebugKindString } from "./toDebugKindString.ts";

/** Matches one line break, of any of the three forms a string can hold. */
const LINE_BREAK_REGEX = /\r\n|[\r\n]/g;

/**
 * Helper class for converting values to their valid `FabricValue` debug
 * representations.
 */
export class DebugConverter {
  readonly #value: any;
  readonly #limits: ConversionLimits;
  readonly #replacer: undefined | ((value: any) => any);
  readonly #nestingStack = new Map<object, number>();

  /**
   * Constructs an instance.
   */
  constructor(
    /** Value to convert. */
    value: unknown,
    /** Limits the result is to stay within. */
    limits: ConversionLimits,
    /** Replacer function. */
    replacer?: (value: any) => any,
  ) {
    this.#value = value;
    // We subtract one from `maxDepth` because the "suggestive forms" for elided
    // data use a layer of depth. The array-length and string-length forms use
    // two, and so can run one level past the limit.
    this.#limits = { ...limits, maxDepth: limits.maxDepth - 1 };
    this.#replacer = replacer;
  }

  //
  // Instance members
  //

  /**
   * Converts the configured value. This method is meant to be called no more
   * than once per instance of this class. In particular, it doesn't cache the
   * result, so a second call repeats the conversion.
   */
  convert(): FabricValue {
    try {
      return this.#convertSubvalue(this.#value, 0);
      // deno-coverage-ignore-start
    } catch (e) {
      // There is an inner `try-catch` which should catch most conversion errors
      // close to where they're thrown. This `catch` is a prophylactic "just
      // in case" to help nail down the intention of really really trying not to
      // `throw` out of this method.
      return DebugConverter.#makeUnconvertibleResult(e);
    }
    // deno-coverage-ignore-stop
  }

  /**
   * Converts an array, which is known to be at the indicated nesting depth.
   * An array with more elements than the maximum array length has the
   * elements at indices below that limit converted, and at the limit's index
   * a `/...` form carrying the array's length in place of the rest. That form
   * nests two levels, so a result holding one can run one level past the
   * maximum nesting depth.
   */
  #convertArray(value: any, depth: number): FabricValue {
    const length: number = value.length;
    const maxLength = this.#limits.maxArrayLength;
    const result: FabricValue[] = [];

    result.length = Math.min(length, maxLength);
    for (const key of Object.keys(value)) {
      if (!isArrayIndexPropertyName(key)) {
        // It's a named property. Intentionally skipped as part of conforming to
        // `FabricValue`.
        continue;
      }

      const index = Number(key);
      if (index >= maxLength) {
        // It's an element past the limit, which the length form stands for.
        continue;
      }

      try {
        result[index] = this.#convertSubvalue(value[index], depth + 1);
      } catch (e) {
        result[index] = DebugConverter.#makeUnconvertibleResult(e);
      }
    }

    if (length > maxLength) {
      result.push({ "/...": { length } });
    }

    return result;
  }

  /**
   * Converts a general instance (non-plain, non-`FabricValue` object), which is
   * known to be at the indicated nesting depth.
   */
  #convertInstance(value: any, depth: number): FabricValue {
    const className = classNameOf(value);
    const tag = `/${className}`;

    const stringForm = value.toString();
    if (typeof stringForm === "string") {
      const matchedGenericName: string | undefined = stringForm.match(
        /^\[object (?<name>[a-zA-Z0-9_$]+)\]$/,
      )?.groups?.name;
      if (
        (matchedGenericName !== "Object") && (matchedGenericName !== className)
      ) {
        return { [tag]: this.#convertString(stringForm) };
      }
    }

    if (typeof value.toJSON === "function") {
      return { [tag]: this.#convertSubvalue(value.toJSON(), depth + 1) };
    }

    const props = { ...value };
    const converted = (Object.keys(props).length !== 0)
      ? this.#convertSubvalue(props, depth + 1)
      : "/...";
    return { [tag]: converted };
  }

  /**
   * Converts a plain object, which is known to be at the indicated nesting
   * depth. An object with more properties than the maximum property count
   * has the first that many converted, in key order, and after them a `/...`
   * property carrying the count of the whole. That form nests two levels, so
   * a result holding one can run one level past the maximum nesting depth.
   */
  #convertPlainObject(value: any, depth: number): FabricValue {
    const maxProperties = this.#limits.maxProperties;
    const keys: string[] = Object.keys(value);
    const result: Record<string, FabricValue> = {};

    for (const key of keys.slice(0, maxProperties)) {
      const resultKey = (isUnsafeObjectKey(key) || (key[0] === "/"))
        ? `/${key}`
        : key;
      try {
        result[resultKey] = this.#convertSubvalue(value[key], depth + 1);
      } catch (e) {
        result[resultKey] = DebugConverter.#makeUnconvertibleResult(e);
      }
    }

    if (keys.length > maxProperties) {
      result["/..."] = { count: keys.length };
    }

    return result;
  }

  /**
   * Converts a string. A string longer than the maximum string length, or
   * holding more lines than the maximum string lines, is converted to a
   * `/partialString` form carrying its length and an excerpt: its first
   * characters up to the length limit, or its first lines up to the line
   * limit, whichever is shorter. A character cut can land inside a surrogate
   * pair, so an excerpt so cut loses a final high surrogate; a line cut lands
   * just past a line break, which the excerpt keeps. That form nests two
   * levels, so a result holding one can run one level past the maximum
   * nesting depth.
   */
  #convertString(value: string): FabricValue {
    const { maxStringLength, maxStringLines } = this.#limits;
    const length = value.length;
    const lengthCut = Math.min(length, maxStringLength);
    const lineCut = DebugConverter.#lineCutOf(value, maxStringLines);
    const cut = Math.min(lengthCut, lineCut);

    if (cut === length) {
      return value;
    }

    let excerpt = value.slice(0, cut);
    if ((cut < lineCut) && /[\uD800-\uDBFF]$/.test(excerpt)) {
      excerpt = excerpt.slice(0, -1);
    }

    return { "/partialString": { length, excerpt } };
  }

  /**
   * Converts the given value, which is known to be at the indicated nesting
   * depth.
   */
  #convertSubvalue(value: any, depth: number): FabricValue {
    try {
      // Give the `replacer` (if supplied) an opportunity to perform replacement.
      value = this.#replacer ? this.#replacer(value) : value;
    } catch {
      // Fall through: Treat `replacer` failure as refusal to replace and not an
      // actual error.
    }

    // Handle all the straightforward cases.
    switch (typeof value) {
      case "bigint":
      case "boolean":
      case "number":
      case "undefined": {
        return value;
      }

      case "string": {
        return this.#convertString(value);
      }

      case "symbol": {
        const key = Symbol.keyFor(value);
        if (key === undefined) {
          // Unique (uninterned) symbol.
          return { "/uniqueSymbol": value.description };
        } else {
          // Interned symbol.
          return value;
        }
      }

      case "function": {
        try {
          const name = value.name;
          const content = (name != "") ? `${name}(...)` : "<anonymous>(...)";
          return { "/function": content };
        } catch (e) {
          return { "/function": DebugConverter.#makeUnconvertibleResult(e) };
        }
      }

      case "object": {
        if (value === null) {
          return null;
        }
        break;
      }

      // deno-coverage-ignore-start
      // This will only happen if JS introduces a new type.
      default: {
        throw new Error(`Shouldn't happen: unknown type \`${typeof value}\``);
      }
        // deno-coverage-ignore-stop
    }

    // We have a non-null object of some sort.

    try {
      if (value instanceof FabricPrimitive) {
        // These can in effect require an additional layer of nesting to
        // convert, by the time they actually hit _some_ real transports. We
        // hereby accept the fact that there can be an arguable inconsistency
        // between intended and actual maximum nesting when these are converted
        // "at the edge."
        return value;
      }

      const nestedAt = this.#nestingStack.get(value);
      if (nestedAt !== undefined) {
        return { "/circle": nestedAt };
      }

      if (depth >= this.#limits.maxDepth) {
        return { "/...": toDebugKindString(value) };
      }

      this.#nestingStack.set(value, depth);

      try {
        if (value instanceof FabricInstance) {
          const codec = codecOf(value);
          const tag = codec.tagForValue(value);
          const contents = codec.encode(value, NULL_LIVE_ENVIRONMENT);
          return { [`/${tag}`]: this.#convertSubvalue(contents, depth + 1) };
        } else if (Array.isArray(value)) {
          return this.#convertArray(value, depth);
        } else if (isPlainObject(value)) {
          return this.#convertPlainObject(value, depth);
        } else {
          return this.#convertInstance(value, depth);
        }
      } finally {
        this.#nestingStack.delete(value);
      }
    } catch (e) {
      return DebugConverter.#makeUnconvertibleResult(e);
    }
  }

  //
  // Static members
  //

  /**
   * Returns the index at which `value` ends were it cut to its first
   * `maxLines` lines: the index just past the line break which ends that many
   * lines, or the length of `value` when it holds no more lines than that. A
   * line break at the very end of `value` ends its last line rather than
   * starting an empty one, which is a consequence of the cut landing past it.
   */
  static #lineCutOf(value: string, maxLines: number): number {
    let lines = 1;

    for (const lineBreak of value.matchAll(LINE_BREAK_REGEX)) {
      if (lines === maxLines) {
        return lineBreak.index + lineBreak[0].length;
      }
      lines++;
    }

    return value.length;
  }

  /**
   * Produces the `/unconvertible` result form which stands in for a value whose
   * conversion threw, carrying the message of the error thrown.
   */
  static #makeUnconvertibleResult(error: any): FabricValue {
    const message = (() => {
      try {
        if (error instanceof Error) {
          const msg = error.message;
          if (typeof msg === "string") {
            return msg;
          }
        }
        return String(error);
      } catch {
        return "/unconvertibleError";
      }
    })();

    return { "/unconvertible": message };
  }
}
