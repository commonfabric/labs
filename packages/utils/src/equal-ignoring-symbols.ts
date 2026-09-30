import { expect } from "@std/expect";
import type { Async, Expected } from "@std/expect";

import { isObjectOrArray } from "./types.ts";

/**
 * Strips all symbol properties from an object, recursively.
 *
 * TODO(danfuzz): `isObjectOrArray` admits a `FabricSpecialObject`, and the
 * `Object.keys` rebuild renders one as `{}` — on BOTH sides of the matchers
 * below, so a test asserting on cell-read values judges any two same-shaped
 * values with differing fabric contents equal, and its failure diff prints
 * `{}`. The matchers fail open on exactly the fabric-content differences.
 * Wants a `FabricSpecialObject` test returning the value whole (fabric
 * classes hold no own symbol properties to strip).
 */
export function stripSymbols(obj: unknown): unknown {
  if (!isObjectOrArray(obj)) return obj;

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(stripSymbols);
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = stripSymbols(obj[key]);
  }
  return result;
}

/** Custom matchers that compare objects while ignoring symbol properties */
expect.extend({
  toEqualIgnoringSymbols(
    context,
    expected,
  ): { message: () => string; pass: boolean } {
    const cleanReceived = stripSymbols(context.value);
    const cleanExpected = stripSymbols(expected);

    const pass = context.equal(cleanReceived, cleanExpected);
    const formatMessage = (message: string): string => {
      if (!context.customMessage) return message;
      return `${context.customMessage}: ${message}`;
    };

    if (pass) {
      return {
        message: () =>
          formatMessage(
            `expected ${JSON.stringify(context.value)} not to equal ${
              JSON.stringify(expected)
            } when ignoring symbols`,
          ),
        pass: true,
      };
    } else {
      return {
        message: () => {
          const receivedStr = JSON.stringify(cleanReceived, null, 2);
          const expectedStr = JSON.stringify(cleanExpected, null, 2);
          const baseMessage =
            `expected objects to be equal when ignoring symbols` +
            `\n\nExpected:\n${expectedStr}\n\nReceived:\n${receivedStr}`;
          return formatMessage(baseMessage);
        },
        pass: false,
      };
    }
  },

  toMatchObjectIgnoringSymbols(context, expected) {
    const cleanReceived = stripSymbols(context.value);
    const cleanExpected = stripSymbols(expected);

    // Implement partial matching logic similar to toMatchObject
    const matches = (obj: unknown, subset: unknown): boolean => {
      if (Object.is(subset, obj)) return true;
      if (
        !isObjectOrArray(subset) ||
        !isObjectOrArray(obj)
      ) {
        return false;
      }

      for (const key in subset) {
        if (!(key in obj)) return false;
        const objValue = (obj as Record<string, unknown>)[key] as unknown;
        const subsetValue = (subset as Record<string, unknown>)[key] as unknown;
        if (!context.equal(objValue, subsetValue)) {
          // For nested objects, apply partial matching
          if (
            isObjectOrArray(objValue) &&
            isObjectOrArray(subsetValue)
          ) {
            if (!matches(objValue, subsetValue)) return false;
          } else {
            return false;
          }
        }
      }
      return true;
    };

    const pass = matches(cleanReceived, cleanExpected);
    const formatMessage = (message: string): string => {
      if (!context.customMessage) return message;
      return `${context.customMessage}: ${message}`;
    };

    if (pass) {
      return {
        message: () =>
          formatMessage(
            `expected ${JSON.stringify(context.value)} not to match object ${
              JSON.stringify(expected)
            } when ignoring symbols`,
          ),
        pass: true,
      };
    } else {
      return {
        message: () => {
          const receivedStr = JSON.stringify(cleanReceived, null, 2);
          const expectedStr = JSON.stringify(cleanExpected, null, 2);
          const baseMessage = `expected object to match when ignoring symbols` +
            `\n\nExpected subset:\n${expectedStr}\n\nReceived:\n${receivedStr}`;
          return formatMessage(baseMessage);
        },
        pass: false,
      };
    }
  },
});

declare module "@std/expect" {
  interface Expected<IsAsync = false> {
    /**
     * Like `toEqual()`, except that symbol-keyed properties are stripped from
     * both sides first.
     */
    toEqualIgnoringSymbols(expected: unknown): void;

    /**
     * Like `toMatchObject()`, except that symbol-keyed properties are
     * stripped from both sides first.
     */
    toMatchObjectIgnoringSymbols(expected: unknown): void;
  }
}

/** The `expect()` surface, extended with the matchers defined here. */
export interface ExtendedExpected<IsAsync = false> extends Expected<IsAsync> {
  /** @inheritDoc */
  toEqualIgnoringSymbols(expected: unknown): void;

  /** @inheritDoc */
  toMatchObjectIgnoringSymbols(expected: unknown): void;

  // The modifiers are restated so that they carry the extended type through.
  not: IsAsync extends true ? Async<ExtendedExpected<true>>
    : ExtendedExpected<false>;

  /** @inheritDoc */
  resolves: Async<ExtendedExpected<true>>;

  /** @inheritDoc */
  rejects: Async<ExtendedExpected<true>>;
}
