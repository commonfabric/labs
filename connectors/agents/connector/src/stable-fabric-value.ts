import {
  deepFreeze,
  fabricFromConvertibleJsValue,
  FabricInstance,
  type FabricPlainObject,
  type FabricValue,
  JS_TYPE_VALUE_TAGS,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@commonfabric/data-model";
import {
  ProblematicValue,
  UnknownValue,
} from "@commonfabric/data-model/codec-common";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import {
  getCellOrThrow,
  isCell,
  isCellResultForDereferencing,
} from "@commonfabric/runner";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasToJson(
  value: unknown,
): value is { toJSON: () => unknown } {
  return (
    isObjectOrArray(value) ||
    typeof value === "function"
  ) &&
    "toJSON" in value &&
    typeof value.toJSON === "function";
}

function replaceCellsWithLinks(
  value: unknown,
  seen: WeakMap<object, unknown>,
  active = new WeakSet<object>(),
): unknown {
  if (isCellResultForDereferencing(value)) {
    return replaceCellsWithLinks(
      getCellOrThrow(value).getAsLink(),
      seen,
      active,
    );
  }
  if (isCell(value)) {
    return replaceCellsWithLinks(value.getAsLink(), seen, active);
  }
  if (Array.isArray(value)) {
    if (!isArrayWithOnlyIndexProperties(value)) {
      throw new Error("Cannot store array with enumerable named properties");
    }
    const existing = seen.get(value);
    if (existing) return existing;
    const converted: unknown[] = [];
    seen.set(value, converted);
    for (let index = 0; index < value.length; index++) {
      if (index in value) {
        converted[index] = replaceCellsWithLinks(
          value[index],
          seen,
          active,
        );
      } else {
        converted.length = index + 1;
      }
    }
    return converted;
  }
  const tag = tagOfConvertibleJsValueElseNull(value);
  if (tag === VALUE_TAGS.JsError) {
    const error = value as Error;
    const existing = seen.get(error);
    if (existing) return existing;
    if (active.has(error)) {
      throw new Error("Cannot store circular reference through an error");
    }
    // `cause` and the extras are converted by this walk, and the instance is
    // built from the results, so a reference back to `error` from inside them
    // has nothing to resolve to and is refused.
    active.add(error);
    try {
      const converted = FabricError.fromNativeError(error, {
        convert: (nested) =>
          replaceCellsWithLinks(nested, seen, active) as FabricValue,
      });
      seen.set(error, converted);
      return converted;
    } finally {
      active.delete(error);
    }
  }
  if (
    tag !== null &&
    tag !== VALUE_TAGS.Object &&
    !Object.hasOwn(JS_TYPE_VALUE_TAGS, tag)
  ) {
    return value;
  }
  if (hasToJson(value)) {
    if (seen.has(value)) return seen.get(value);
    if (active.has(value)) {
      throw new Error("Cannot store circular toJSON conversion");
    }
    active.add(value);
    try {
      const converted = replaceCellsWithLinks(
        value.toJSON(),
        seen,
        active,
      );
      seen.set(value, converted);
      return converted;
    } finally {
      active.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    const existing = seen.get(value);
    if (existing) return existing;
    const converted = Object.create(
      Object.getPrototypeOf(value),
    ) as Record<string, unknown>;
    seen.set(value, converted);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(converted, key, {
        value: replaceCellsWithLinks(child, seen, active),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return converted;
  }
  return value;
}

function captureFabricValue(
  value: FabricValue,
  seen: WeakMap<object, FabricValue>,
  active: WeakSet<object>,
): FabricValue {
  if (!isObjectOrArray(value)) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (active.has(value)) {
    throw new Error("Cannot store circular reference");
  }
  active.add(value);
  try {
    let captured: FabricValue;
    if (value instanceof FabricLink) {
      captured = deepFreeze(
        new FabricLink(
          captureFabricValue(
            value.payload,
            seen,
            active,
          ) as FabricPlainObject,
        ),
      );
    } else if (value instanceof FabricError) {
      captured = deepFreeze(
        new FabricError({
          type: value.type,
          name: value.name,
          message: value.message,
          stack: value.stack,
          cause: value.cause === undefined
            ? undefined
            : captureFabricValue(value.cause, seen, active),
          extras: Array.from(
            value.extraEntries(),
            ([key, child]) =>
              [key, captureFabricValue(child, seen, active)] as const,
          ),
        }),
      );
    } else if (value instanceof UnknownValue) {
      captured = deepFreeze(
        new UnknownValue(
          value.wireTypeTag,
          captureFabricValue(value.state, seen, active),
        ),
      );
    } else if (value instanceof ProblematicValue) {
      captured = deepFreeze(
        new ProblematicValue(
          value.wireTypeTag,
          captureFabricValue(value.state, seen, active),
          value.error,
        ),
      );
    } else if (value instanceof FabricInstance) {
      captured = value.deepClone(true) as FabricValue;
    } else if (Array.isArray(value)) {
      const copy: FabricValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (index in value) {
          copy[index] = captureFabricValue(value[index], seen, active);
        } else {
          copy.length = index + 1;
        }
      }
      captured = Object.freeze(copy);
    } else if (isPlainRecord(value)) {
      const copy = Object.create(
        Object.getPrototypeOf(value),
      ) as Record<string, FabricValue>;
      for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(copy, key, {
          value: captureFabricValue(
            child as FabricValue,
            seen,
            active,
          ),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      captured = Object.freeze(copy) as FabricValue;
    } else {
      captured = value;
    }
    seen.set(value, captured);
    return captured;
  } finally {
    active.delete(value);
  }
}

/**
 * Capture a graph value as an immutable `FabricValue`. Stable child cells
 * become links, while JS values and shared references retain their
 * `FabricValue` semantics.
 */
export function stableFabricValue(value: unknown): FabricValue {
  return captureFabricValue(
    fabricFromConvertibleJsValue(
      replaceCellsWithLinks(value, new WeakMap()),
    ),
    new WeakMap(),
    new WeakSet(),
  );
}
