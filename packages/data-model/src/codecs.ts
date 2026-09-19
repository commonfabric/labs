/**
 * The package's ready-to-use codec defaults: entry points that encode and
 * decode with this package's own set of fabric classes, for callers that want
 * the standard answer rather than a configured one.
 *
 * This sits above `codec-json`, `codec-realm` and `codec-common`, which carry
 * the formats and the mechanism and know nothing about which classes
 * participate. Nothing in those directories may import from here; the
 * dependency runs one way, and a convenience import in the other direction
 * would make it a cycle.
 *
 * Both class rosters are imported at module scope and the registry is built at
 * first import, so this module pulls in every class that participates in the
 * wire format. That is the shape a cycle would be most costly in, which is the
 * other half of why the rule above is absolute rather than stylistic.
 */

// Loaded for its effect, and before anything else here: it installs the debug
// renderers, which the package's modules reach through
// `value-debug-internal.ts`.
import "@/value-debug/index.ts";

import { isInstance, isObjectOrArray } from "@commonfabric/utils/types";

import type { FabricValue } from "./index.ts";
import type { LiveEnvironment } from "./codec-interface/interface.ts";
import { NULL_LIVE_ENVIRONMENT } from "./codec-interface/NullLiveEnvironment.ts";
import type { CodecRegistry } from "./codec-common/CodecRegistry.ts";
import type { JsonCodecValue } from "./codec-json/interface.ts";
import { JsonCodecEngine } from "./codec-json/JsonCodecEngine.ts";
import { createBaseJsonRegistry } from "./codec-json/createBaseJsonRegistry.ts";
import type {
  RealmCodecValue,
  RealmEncodedValue,
} from "./codec-realm/interface.ts";
import { RealmCodecEngine } from "./codec-realm/RealmCodecEngine.ts";
import { createBaseRealmRegistry } from "./codec-realm/createBaseRealmRegistry.ts";
import { codecClasses as primitiveClasses } from "./fabric-primitives/impl.ts";
import { codecClasses as instanceClasses } from "./fabric-instances/impl.ts";

/**
 * Creates a registry pairing the JSON format with the fabric classes this
 * package defines. This is the registry to build on: a caller adding classes
 * of its own extends what this returns, so that it cannot omit these by
 * accident.
 *
 * The two curated `codecClasses()` lists are the source of truth for which
 * classes participate, so the wire-format surface is decided where those are
 * written rather than here. The registry reads each class's codec for itself,
 * under `[CODEC]` where a class has one and under this format's own symbol
 * otherwise, so the same two lists serve any format.
 *
 * `UnknownValue` and `ProblematicValue` are among them, but their codecs
 * recognize no single wire tag: the encode path resolves an instance's tag
 * with `tagForValue()`, and an unrecognized tag on decode is wrapped in an
 * `UnknownValue` by the engine rather than tag-routed.
 */
export function createDefaultJsonRegistry(): CodecRegistry<JsonCodecValue> {
  return createBaseJsonRegistry().extend(
    primitiveClasses(),
    instanceClasses(),
  );
}

/**
 * Constructs a `JsonCodecEngine` over {@link createDefaultJsonRegistry}, for a
 * caller that wants this package's classes rather than a set of its own.
 * `options.lenient` is passed through.
 */
export function newDefaultJsonCodecEngine(
  options?: { lenient?: boolean },
): JsonCodecEngine {
  return new JsonCodecEngine({
    registry: createDefaultJsonRegistry(),
    lenient: options?.lenient ?? false,
  });
}

/** Shared JSON codec. */
const jsonCodecEngine = newDefaultJsonCodecEngine();

/**
 * Encodes a `FabricValue` to a JSON string in the standard `FabricValue`
 * JSON-embedded encoding, prefixed with the format-identifying tag `fvj1:`.
 * If no live environment is given, {@link NULL_LIVE_ENVIRONMENT} is
 * substituted, which throws if anything asks it for a cell.
 *
 * `value` must be a valid `FabricValue`; handing this anything else is
 * best-effort, per the input contract on `BaseCodecEngine.encode()`.
 */
export function jsonFromFabricValue(
  value: FabricValue,
  env?: LiveEnvironment,
): string {
  return jsonCodecEngine.encode(value, env ?? NULL_LIVE_ENVIRONMENT);
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format, which is
 * expected to be a plain object. Throws if it turns out to be something else.
 * If no live environment is given, {@link NULL_LIVE_ENVIRONMENT} is
 * substituted (via `fabricFromJsonValue()`), which throws if anything asks
 * it for a cell.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  env?: LiveEnvironment,
): T {
  const result = fabricFromJsonValue(json, env);

  if (!isObjectOrArray(result)) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to a primitive, not a plain object",
    );
  } else if (Array.isArray(result)) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to an array, not a plain object",
    );
  } else if (isInstance(result)) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to an instance, not a plain object",
    );
  }

  return result as T;
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format. If no
 * live environment is given, {@link NULL_LIVE_ENVIRONMENT} is substituted,
 * which throws if anything asks it for a cell.
 */
export function fabricFromJsonValue(
  json: string,
  env?: LiveEnvironment | undefined,
): FabricValue {
  return jsonCodecEngine.decode(json, env ?? NULL_LIVE_ENVIRONMENT);
}

/**
 * Creates a registry pairing the realm-crossing format with the fabric classes
 * this package defines. The counterpart to {@link createDefaultJsonRegistry},
 * drawing on the same two curated lists: which classes participate is a
 * question about the classes rather than about the format, so both formats
 * read the same roster and each class supplies whichever codec it has for the
 * format asking.
 */
export function createDefaultRealmRegistry(): CodecRegistry<RealmCodecValue> {
  return createBaseRealmRegistry().extend(
    primitiveClasses(),
    instanceClasses(),
  );
}

/**
 * Constructs a `RealmCodecEngine` over {@link createDefaultRealmRegistry}, for
 * a caller that wants this package's classes rather than a set of its own.
 * `options.lenient` is passed through.
 */
export function newDefaultRealmCodecEngine(
  options?: { lenient?: boolean },
): RealmCodecEngine {
  return new RealmCodecEngine({
    registry: createDefaultRealmRegistry(),
    lenient: options?.lenient ?? false,
  });
}

/** Shared realm-crossing codec engine. */
const realmCodecEngine = newDefaultRealmCodecEngine();

/**
 * Encodes a `FabricValue` into the realm-crossing transport form: a value that
 * `structuredClone()` or `postMessage()` carries to another realm without
 * loss. The result is `[marker, tree]`, and the tree inside shares whatever
 * structure of `value` needed no encoding.
 *
 * If no live environment is given, {@link NULL_LIVE_ENVIRONMENT} is
 * substituted, which throws if anything asks it for a cell.
 *
 * `value` must be a valid `FabricValue`; handing this anything else is
 * best-effort, per the input contract on `BaseCodecEngine.encode()`. That
 * contract is what lets a subtree needing no encoding be shared with `value`
 * rather than copied: vetting one would cost the walk the sharing exists to
 * avoid, and would charge it to correct input.
 *
 * Named for the `<target>From<Source>Value` family that
 * `fabricFromConvertibleJsValue()` and `convertibleJsFromFabricValue()`
 * establish. Both sides being qualified is what keeps `realm` readable only as
 * a modifier on `value` -- a *realm value* is this transport form, as a *native
 * value* is a plain JavaScript one -- rather than as the boundary being
 * crossed.
 */
export function realmFromFabricValue(
  value: FabricValue,
  env?: LiveEnvironment,
): RealmEncodedValue {
  return realmCodecEngine.encode(value, env ?? NULL_LIVE_ENVIRONMENT);
}

/**
 * Decodes a value in the realm-crossing transport form. If no live
 * environment is given, {@link NULL_LIVE_ENVIRONMENT} is substituted, which
 * throws if anything asks it for a cell.
 *
 * `data` is ceded to this function, which retains what it likes of it and
 * freezes whatever it retains; a caller must not use it afterwards.
 * `4-realm-encoding.md` Section 5.2 states the whole of that contract.
 */
export function fabricFromRealmValue(
  data: RealmEncodedValue,
  env?: LiveEnvironment | undefined,
): FabricValue {
  return realmCodecEngine.decode(data, env ?? NULL_LIVE_ENVIRONMENT);
}
