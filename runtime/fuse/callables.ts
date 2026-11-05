import type { JSONSchema } from "@commonfabric/api";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import type { FabricValue } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  isPatternFactorySchema,
  isPatternFactoryValue,
  patternFactoryFromCallableEntry,
  patternFactorySchemas,
  patternFactorySchemasFromSchema,
} from "@commonfabric/piece/verb-listing";

import { ContextualFlowControl } from "../runner/src/cfc.ts";

const encoder = new TextEncoder();

export type CallableKind = "handler" | "tool";

export function encodeFactoryProjection(value: unknown): string | undefined {
  return isAdmittedFabricFactory(value)
    ? jsonFromFabricValue(value as FabricValue)
    : undefined;
}

/**
 * Decode an explicit `fvj1:` factory projection to a context-free shell.
 *
 * The prefix is reserved by the FUSE file projection. A literal authored
 * string with that prefix must be stored through another interface;
 * silently treating a malformed tagged value as text would make a read/write
 * echo corrupt factory-bearing JSON.
 */
export function decodeFactoryProjection(value: unknown): unknown | undefined {
  if (
    typeof value !== "string" || !JsonCodecEngine.seemsLikeEncoded(value)
  ) {
    return undefined;
  }
  const decoded = fabricFromJsonValue(value);
  if (!isAdmittedFabricFactory(decoded)) {
    throw new TypeError("Tagged FUSE callable value is not a Factory@1");
  }
  return decoded;
}

/** Parse a handler file payload while keeping tagged-value failures explicit. */
export function decodeHandlerWritePayload(text: string): unknown {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Bare strings remain convenient for shell callers such as
    // `echo book > addItem.handler`.
    return decodeFactoryProjections(trimmed);
  }
  return decodeFactoryProjections(parsed);
}

/** Decode tagged factory leaves without reinterpreting ordinary JSON values. */
export function decodeFactoryProjections(value: unknown): unknown {
  const direct = decodeFactoryProjection(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const child = value[index];
      const decoded = decodeFactoryProjections(child);
      if (!Object.is(decoded, child)) {
        result ??= [...value];
        result[index] = decoded;
      }
    }
    return result ?? value;
  }
  if (isObjectNotArray(value)) {
    let result: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value)) {
      const decoded = decodeFactoryProjections(child);
      if (!Object.is(decoded, child)) {
        result ??= { ...value };
        result[key] = decoded;
      }
    }
    return result ?? value;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The stored sentinel a stream position held before its schema declared it.
 * A stream document written since holds no value; this recognizes the ones
 * written before.
 */
export function isStreamValue(v: unknown): boolean {
  if (!isObjectNotArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "$stream" in obj && obj.$stream === true;
}

export function isHandlerCell(v: unknown): boolean {
  if (!isObjectNotArray(v)) return false;
  const cell = v as { isStream?: () => boolean };
  if (typeof cell.isStream === "function") {
    try {
      return cell.isStream();
    } catch {
      return false;
    }
  }
  return false;
}

export function classifyCallableEntry(
  value: unknown,
  schema?: JSONSchema,
): CallableKind | null {
  if (patternFactoryFromCallableEntry(value) !== undefined) {
    return "tool";
  }
  if (isPatternFactorySchema(schema)) {
    return "tool";
  }

  // A stream position holds no value: the schema its links carry is what
  // says it is one, so a declared stream is a handler whatever stands at it.
  if (ContextualFlowControl.declaresStream(schema)) {
    return "handler";
  }

  if (isStreamValue(value) || isHandlerCell(value)) {
    return "handler";
  }

  return null;
}

export function buildCallableScript(
  execCli: string,
  schema?: JSONSchema,
  typeStr?: string,
): Uint8Array {
  const shim = execCli || "/usr/bin/false";
  // Comments are readable via `cat` and `head`; cf exec handles --help and
  // flag-based invocation (--value <x> for scalars, --flag <v> for objects).
  const schemaComment = schema !== undefined
    ? `# schema: ${JSON.stringify(schema)}\n`
    : "";
  const typeComment = typeStr !== undefined
    ? `# input: ${typeStr.replaceAll("\n", "\n# ")}\n`
    : "";
  return encoder.encode(
    `#!${shim} exec\n${schemaComment}${typeComment}exec ${
      shellQuote(shim)
    } exec "$0" "$@"\n`,
  );
}

export function transformCallableValues(
  value: unknown,
  classify: (key: string, value: unknown) => CallableKind | null = (
    _key,
    candidate,
  ) => classifyCallableEntry(candidate),
): unknown {
  if (!isObjectNotArray(value)) {
    return value;
  }

  const obj = value as Record<string, unknown>;
  let hasCallables = false;
  for (const [key, candidate] of Object.entries(obj)) {
    if (classify(key, candidate)) {
      hasCallables = true;
      break;
    }
  }
  if (!hasCallables) return value;

  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(obj)) {
    const callableKind = classify(key, candidate);
    if (callableKind) {
      result[key] = callableKind === "handler"
        ? { "/handler": key }
        : { "/tool": key };
    } else {
      result[key] = candidate;
    }
  }

  return result;
}

export {
  isPatternFactorySchema,
  isPatternFactoryValue,
  patternFactoryFromCallableEntry,
  patternFactorySchemas,
  patternFactorySchemasFromSchema,
};
