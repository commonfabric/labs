import {
  fabricFromConvertibleJsValue,
  type FabricValue,
} from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { isReactive } from "../builder/types.ts";
import { hasEncodableForm } from "../encodable-form.ts";
import { isCellLink } from "../link-utils.ts";

export interface NormalizedSandboxResult {
  /** The host/Fabric graph that may safely leave the sandbox boundary. */
  value: unknown;

  /** Whether the result graph contains a Reactive leaf. */
  hasReactive: boolean;
}

interface PreparedValidation {
  value: unknown;
  hasReactive: boolean;
  hasOpaque: boolean;
}

const regexpSourceGetter = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "source",
)!.get!;
const regexpFlagsGetter = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "flags",
)!.get!;

/**
 * SES compartments share the host's hardened `Object.prototype` identity.
 * Deliberately do not infer a foreign `Object.prototype` from a null-rooted
 * parent: custom instance prototypes can be null-rooted too.
 */
function isPlainResultObject(value: object): boolean {
  if (hasEncodableForm(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isSandboxResultContainer(
  value: unknown,
): value is unknown[] | Record<string, unknown> {
  return isObjectOrArray(value) &&
    (Array.isArray(value) || isPlainResultObject(value));
}

function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Not representable as a \`FabricValue\`: ${typeName} with extra ` +
        "enumerable properties",
    );
  }
}

/**
 * Canonicalizes native leaf values while their foreign-realm identity is still
 * known. The data model only receives `FabricValue`s or ordinary host values;
 * it does not need realm-specific dispatch.
 */
function normalizeSandboxNativeLeaf(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;

  let brand: string;
  try {
    brand = Object.prototype.toString.call(value);
  } catch {
    return value;
  }

  if (brand === "[object Date]") {
    let millis: number;
    try {
      millis = Date.prototype.getTime.call(value);
    } catch {
      return value;
    }
    rejectExtraProperties(value, "Date");
    return new FabricEpochNsec(BigInt(millis) * 1_000_000n);
  }

  if (brand === "[object RegExp]") {
    let source: string;
    try {
      source = regexpSourceGetter.call(value);
    } catch {
      return value;
    }
    rejectExtraProperties(value, "RegExp");
    const flags = regexpFlagsGetter.call(value);
    return new FabricRegExp("es2025", source, flags);
  }

  if (
    brand === "[object Uint8Array]" && ArrayBuffer.isView(value) &&
    (value as Uint8Array).BYTES_PER_ELEMENT === 1
  ) {
    // No second argument, so the constructor makes its own copy: `value`
    // belongs to the sandbox and cannot be ceded. Copying first and then
    // ceding would cost the same copy and an extra buffer besides.
    return new FabricBytes(value as Uint8Array);
  }

  if (Error.isError(value)) {
    return FabricError.fromNativeError(value as Error);
  }

  return value;
}

function typeNameForActionResult(value: unknown): string {
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "Symbol";
  if (isObjectOrArray(value)) {
    return value.constructor?.name ?? "unknown type";
  }
  return typeof value;
}

function hintForActionResult(value: unknown): string | undefined {
  const typeName = typeNameForActionResult(value);
  if (typeName === "Map") return "Consider using a plain object instead.";
  if (typeName === "Set") return "Consider using an array instead.";
  if (typeof value === "symbol") return "Consider removing this property.";
  return undefined;
}

function formatActionResultError(
  value: unknown,
  cause: unknown,
  actionName: string | undefined,
  path: string[],
): Error {
  const pathStr = path.length > 0 ? ` at path "${path.join(".")}"` : "";
  const actionStr = actionName ? `\n  in action: ${actionName}` : "";
  const hint = hintForActionResult(value);
  const hintStr = hint ? ` ${hint}` : "";
  const causeIsError = Error.isError(cause);
  const causeStr = causeIsError ? `\n${(cause as Error).message}` : "";
  return new Error(
    `Action returned a ${typeNameForActionResult(value)}${pathStr}.` +
      `${actionStr}\nActions must return FabricValues, Reactives, or Cells.` +
      `${hintStr}${causeStr}`,
    { cause },
  );
}

/**
 * Copies the sandbox graph into host containers and canonicalizes realm-bound
 * native leaves. Reactive and Cell leaves retain identity so pattern capture
 * continues to observe the exact objects created during action execution.
 */
function adaptSandboxResult(
  value: unknown,
  actionName: string | undefined,
  path: string[],
  adapted: Map<object, unknown>,
): unknown {
  if (isReactive(value) || isCellLink(value)) return value;

  if (!isSandboxResultContainer(value)) {
    try {
      const realmNormalized = normalizeSandboxNativeLeaf(value);
      const converted = fabricFromConvertibleJsValue(realmNormalized, false);
      return fabricFromConvertibleJsValue(converted);
    } catch (cause) {
      throw formatActionResultError(value, cause, actionName, path);
    }
  }

  const existing = adapted.get(value);
  if (existing !== undefined) return existing;

  // This boundary returns canonical shapes: a fresh `Array` for anything
  // array-shaped, and an `Object.prototype`-rooted record for anything else.
  // A prototype is not part of what a value says as data, and a
  // `FabricPlainObject` has exactly one shape, so a pattern that builds a
  // result with `Object.create(null)` or `Object.groupBy()` has it re-rooted
  // here rather than carried across only to be rejected downstream.
  const valueIsArray = Array.isArray(value);
  const copy: unknown[] | Record<string, unknown> = valueIsArray
    ? new Array((value as unknown[]).length)
    : {};
  adapted.set(value, copy);

  for (const [key, child] of Object.entries(value)) {
    const normalizedChild = adaptSandboxResult(
      child,
      actionName,
      [...path, valueIsArray ? `[${key}]` : key],
      adapted,
    );
    Object.defineProperty(copy, key, {
      value: normalizedChild,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/**
 * Produces a validation-only graph. Reactive and Cell leaves are legal result
 * placeholders but are not `FabricValue`s, so they become `undefined` while
 * graph structure, shared references, cycles, and invalid array properties are
 * retained for the authoritative data-model conversion check.
 */
function prepareActionResultValidation(
  value: unknown,
  prepared: Map<object, PreparedValidation> = new Map(),
): PreparedValidation {
  if (isReactive(value)) {
    return { value: undefined, hasReactive: true, hasOpaque: true };
  }
  if (isCellLink(value)) {
    return { value: undefined, hasReactive: false, hasOpaque: true };
  }
  if (!isSandboxResultContainer(value)) {
    return { value, hasReactive: false, hasOpaque: false };
  }

  const existing = prepared.get(value);
  if (existing !== undefined) return existing;

  // Copying the prototype is safe because this runs on the output of
  // `adaptSandboxResult()`, which has already re-rooted every record -- so the
  // prototype in hand is `Object.prototype`. Anything that ran this pass
  // first, on a value straight from the sandbox, would propagate a prototype
  // no `FabricPlainObject` has.
  const valueIsArray = Array.isArray(value);
  const copy: unknown[] | Record<string, unknown> = valueIsArray
    ? new Array((value as unknown[]).length)
    : Object.create(Object.getPrototypeOf(value));
  const result: PreparedValidation = {
    value: copy,
    hasReactive: false,
    hasOpaque: false,
  };
  prepared.set(value, result);

  for (const [key, child] of Object.entries(value)) {
    const childResult = prepareActionResultValidation(child, prepared);
    result.hasReactive ||= childResult.hasReactive;
    result.hasOpaque ||= childResult.hasOpaque;
    Object.defineProperty(copy, key, {
      value: childResult.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * Applies the data model's conversion as the sole legality authority. On
 * failure, descends only to identify the offending action-result path.
 */
function validateFabricActionResult(
  value: unknown,
  actionName: string | undefined,
  path: string[],
  seen: Set<object> = new Set(),
): FabricValue {
  try {
    // `freeze=false` deliberately bypasses the data model's already-frozen
    // identity shortcut so validation still rejects frozen-but-illegal
    // primitives such as unique symbols. The second conversion retains the
    // normalized graph and applies the normal deep-freeze contract.
    const converted = fabricFromConvertibleJsValue(value, false);
    return fabricFromConvertibleJsValue(converted);
  } catch (cause) {
    if (isSandboxResultContainer(value) && !seen.has(value)) {
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        try {
          fabricFromConvertibleJsValue(child, false);
        } catch {
          validateFabricActionResult(
            child,
            actionName,
            [...path, Array.isArray(value) ? `[${key}]` : key],
            seen,
          );
        }
      }
    }
    throw formatActionResultError(value, cause, actionName, path);
  }
}

/**
 * Normalizes the result of sandboxed JavaScript before releasing it to runner
 * and data-model code. This is the single cross-realm adaptation boundary for
 * both action and handler results.
 */
export function normalizeSandboxResult(
  value: unknown,
  actionName?: string,
): NormalizedSandboxResult {
  const adapted = adaptSandboxResult(value, actionName, [], new Map());
  const prepared = prepareActionResultValidation(adapted);
  const normalized = validateFabricActionResult(
    prepared.value,
    actionName,
    [],
  );
  return {
    value: prepared.hasOpaque ? adapted : normalized,
    hasReactive: prepared.hasReactive,
  };
}

/**
 * Compatibility predicate for callers that only need validation and Reactive
 * detection. Runtime egress should use `normalizeSandboxResult()` and retain
 * its returned value.
 */
export function validateAndCheckReactives(
  value: unknown,
  actionName?: string,
): boolean {
  return normalizeSandboxResult(value, actionName).hasReactive;
}
