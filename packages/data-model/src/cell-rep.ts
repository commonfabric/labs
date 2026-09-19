/**
 * The nascent "modern cell representation". This module owns the experiment
 * flag and the flag-dispatched production and recognition of the serialized
 * entity-id reference form.
 */

// Loaded for its effect, and before anything else here: it installs the debug
// renderers, which the package's modules reach through
// `value-debug-internal.ts`.
import "@/value-debug/index.ts";

import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  isObjectNotArray,
  isObjectOrArray,
  isPlainObject,
  isUnsafeObjectKey,
} from "@commonfabric/utils/types";
import { FabricHash } from "@/fabric-primitives";
import { FabricLink } from "@/fabric-instances";
import type { FabricPlainObject } from "@/interface.ts";

//
// Configuration flags
//

/** Module-level flag for the modern cell representation. */
let modernCellRepEnabled = false;

/** Activates or deactivates the modern cell representation flag. */
export function setModernCellRepConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    modernCellRepEnabled = enabled ?? false;
  }
}

/** Returns whether the modern cell representation flag is currently enabled. */
export function getModernCellRepConfig(): boolean {
  return modernCellRepEnabled;
}

/** Restores the modern cell representation flag to its default. */
export function resetModernCellRepConfig(): void {
  modernCellRepEnabled = false;
}

//
// Entity-id reference form
//

/**
 * The serialized/extracted form of an entity-id reference, as produced by
 * `Cell.entityId` and `getEntityId` and consumed wherever such a reference is
 * read back. Its concrete shape is flag-dispatched: with the modern cell
 * representation _off_ it is a plain `{ "/": "<tag>:<hash>" }` object; with it
 * _on_ it is a straight {@link FabricHash}.
 *
 * This is distinct from the branded `EntityId` (an addressing `FabricHash`):
 * in modern mode the two coincide, but in legacy mode the serialized reference
 * is the plain object.
 *
 * Recognition ({@link isEntityRef}, {@link entityRefToString}) is strict — it
 * accepts only the form for the _currently active_ regime, never both. This is
 * deliberate: a stored hash carries no record of which input form produced it,
 * so legacy-hash and modern-hash data are a clean break, never intermixed
 * within one regime.
 */
export type EntityRef = FabricHash | { "/": string };

/**
 * Produces an {@link EntityRef} from a tagged hash string (e.g. `"fid1:…"`).
 */
export function entityRefFromString(taggedHash: string): EntityRef {
  return modernCellRepEnabled
    ? FabricHash.fromString(taggedHash)
    : { "/": taggedHash };
}

/** Produces an {@link EntityRef} from a {@link FabricHash}. */
export function entityRefFrom(hash: FabricHash): EntityRef {
  return modernCellRepEnabled ? hash : { "/": hash.taggedHashString };
}

/**
 * Recognizes an {@link EntityRef} for the currently active regime: a
 * {@link FabricHash} in modern mode, a `{ "/": string }` object in legacy mode.
 */
export function isEntityRef(value: unknown): value is EntityRef {
  return modernCellRepEnabled
    ? value instanceof FabricHash
    : isObjectNotArray(value) && typeof value["/"] === "string";
}

/**
 * Extracts the tagged hash string from an {@link EntityRef}. Throws if the
 * value is not a reference for the currently active regime.
 */
export function entityRefToString(value: EntityRef): string {
  if (modernCellRepEnabled) {
    if (value instanceof FabricHash) return value.taggedHashString;
  } else if (isObjectOrArray(value) && typeof value["/"] === "string") {
    return value["/"];
  }
  throw new Error(
    "Not an entity-id reference for the active cell-rep regime.",
  );
}

//
// Link reference form (the link sigil envelope)
//

/**
 * The link-sigil tag. This module is the sole place that names the literal;
 * everything else routes through {@link linkRefFrom} / {@link isLinkRef} /
 * {@link linkRefPayload}.
 */
export const LINK_V1_TAG = "link@1" as const;

/**
 * A link reference, wrapping a link payload. Its concrete shape is
 * flag-dispatched: with the modern cell representation _off_ it is the plain `{
 * "/": { "link@1": … } }` envelope; with it _on_ it is a {@link FabricLink}
 * instance. This is the link analog of {@link EntityRef}'s `{ "/": string }` →
 * {@link FabricHash}.
 *
 * Construction ({@link linkRefFrom}), recognition ({@link isLinkRef}) and
 * extraction ({@link linkRefPayload}) are gathered here so this chokepoint is
 * the sole seam that dispatches the representation; everything else stays
 * shape-agnostic. As with {@link EntityRef}, recognition is strict — it accepts
 * only the form for the _currently active_ regime, never both.
 *
 * `Payload` is bounded by {@link FabricPlainObject} (the payload is always a
 * stored/serialized one) but otherwise open, so this layer needn't know the
 * exact field types (URI / MemorySpace / JSONSchema — those stay in `runner`).
 * In modern mode the payload type is erased: a {@link FabricLink} holds an
 * unparameterized {@link FabricPlainObject}, just as {@link FabricHash} is
 * unparameterized on the modern arm of {@link EntityRef}.
 */
export type LinkRef<Payload extends FabricPlainObject> =
  | FabricLink
  | { "/": { [LINK_V1_TAG]: Payload } };

/** Produces a {@link LinkRef} wrapping `payload` for the active regime. */
export function linkRefFrom<Payload extends FabricPlainObject>(
  payload: Payload,
): LinkRef<Payload> {
  return modernCellRepEnabled
    ? new FabricLink(payload)
    : { "/": { [LINK_V1_TAG]: payload } };
}

/**
 * Recognizes the legacy `{ "/": { "link@1": … } }` envelope (no other props).
 * Regime-independent: names only the structural form, not the active flag.
 */
function isLegacyLinkEnvelope(
  value: unknown,
): value is { "/": { [LINK_V1_TAG]: FabricPlainObject } } {
  return isObjectOrArray(value) &&
    Object.keys(value).length === 1 &&
    isObjectOrArray(value["/"]) &&
    LINK_V1_TAG in value["/"];
}

/**
 * Recognizes a {@link LinkRef} for the currently active regime: a {@link
 * FabricLink} in modern mode, or the `{ "/": { "link@1": … } }` envelope (no
 * other props) in legacy mode.
 */
export function isLinkRef(value: unknown): value is LinkRef<FabricPlainObject> {
  return modernCellRepEnabled
    ? value instanceof FabricLink
    : isLegacyLinkEnvelope(value);
}

/**
 * Extracts the link payload from a {@link LinkRef}. Throws if the value is not
 * a link reference for the currently active regime.
 */
export function linkRefPayload<Payload extends FabricPlainObject>(
  value: LinkRef<Payload>,
): Payload {
  if (modernCellRepEnabled) {
    if (value instanceof FabricLink) return value.payload as Payload;
  } else if (isLegacyLinkEnvelope(value)) {
    return value["/"][LINK_V1_TAG] as Payload;
  }
  throw new Error("Not a link reference.");
}

/**
 * The storage sub-path, relative to a value's position in the document tree, at
 * which a link rooted there exposes its recognizable form. This encodes the
 * link layout for consumers that navigate _into_ the document tree (notably
 * link resolution), so they need not hardcode the layout — or the link tag —
 * themselves.
 *
 * The sub-path is flag-dispatched to match the regime's storage layout. In
 * legacy mode a link is a decomposed plain-object envelope (`{ "/": { "link@1":
 * … } }`), so the recognizable payload sits two segments down at `["/",
 * "link@1"]`. In modern mode a link is an atomic {@link FabricLink} value at
 * the position itself, so the sub-path is empty. Pair with {@link
 * linkPayloadAtProbe} to interpret whatever is read at `position +
 * linkProbeSubPath()`.
 */
export function linkProbeSubPath(): readonly string[] {
  return modernCellRepEnabled ? [] : ["/", LINK_V1_TAG];
}

/**
 * Interprets the value read at `position + ` {@link linkProbeSubPath}: returns
 * the link payload if that value denotes a link rooted at `position`, or
 * `undefined` otherwise.
 *
 * In legacy mode the probed value already _is_ the inner payload (the tree walk
 * descended into the envelope), so any record there is the payload. In modern
 * mode the probed value is the whole {@link FabricLink}, whose payload is
 * unwrapped via {@link linkRefPayload}.
 */
export function linkPayloadAtProbe(
  probeValue: unknown,
): FabricPlainObject | undefined {
  if (modernCellRepEnabled) {
    return isLinkRef(probeValue) ? linkRefPayload(probeValue) : undefined;
  }
  return isObjectOrArray(probeValue)
    ? probeValue as FabricPlainObject
    : undefined;
}

//
// Wire serialization of a (plain) link payload
//

/**
 * The wire-format prefix tagging a serialized cell-link payload — `fcl1:` for
 * "Fabric Cell Link v1". Like codec-json's `fvj1:`, it makes the format
 * self-identifying (so a decoder can reject anything else) and reserves room
 * for a future versioned migration. Owned here alongside the chokepoint.
 */
const CELL_LINK_WIRE_PREFIX = "fcl1:";

/**
 * A cell-link payload in its wire-transmissible form: a plain object whose
 * every property value is a string or an array of strings. This is the subset
 * of a link payload that is provably plain JSON — the addressing fields (id,
 * space, scope, path, overwrite). Richer payload fields (a `schema`, which can
 * carry an arbitrary {@link FabricValue} default, or cfc side-channels) are
 * deliberately NOT in this form: they are not plain JSON and have no role at a
 * string boundary. The exact field set is a consumer concern (e.g. runner's
 * `WebhookCellLinkRefPayload`); this layer enforces only the generic shape.
 */
export type WireLinkRefPayload = {
  readonly [key: string]: string | readonly string[];
};

/**
 * Validates that `value` is a well-formed {@link WireLinkRefPayload}: a plain
 * object with no prototype-pollution keys whose every value is a string or an
 * array of strings. Throws otherwise. This is the generic guard that makes the
 * wire round-trip safe — it rejects, loudly and at the boundary, any payload
 * carrying a non-plain-JSON value (an object, a `bigint`, a Fabric special).
 */
function assertWireLinkRefPayloadShape(
  value: unknown,
): asserts value is WireLinkRefPayload {
  if (!isPlainObject(value)) {
    throw new Error("Cell-link wire payload must be a plain object.");
  }
  for (const [key, val] of Object.entries(value)) {
    if (isUnsafeObjectKey(key)) {
      throw new Error(
        `Cell-link wire payload has a forbidden key: ${backtickQuote(key)}.`,
      );
    }
    const ok = typeof val === "string" ||
      (Array.isArray(val) && val.every((e) => typeof e === "string"));
    if (!ok) {
      throw new Error(
        `Cell-link wire payload field ${backtickQuote(key)} must be a ` +
          `\`string\` or \`string[]\`.`,
      );
    }
  }
}

/**
 * Serializes a link payload to a wire string for transport across a string
 * boundary (e.g. an HTTP body), tagged with the `fcl1:` prefix. The payload
 * must satisfy {@link WireLinkRefPayload}; throws otherwise (so a
 * non-transmissible payload fails here, at the producer, rather than corrupting
 * silently).
 */
export function linkRefPayloadToString(payload: WireLinkRefPayload): string {
  assertWireLinkRefPayloadShape(payload);
  return CELL_LINK_WIRE_PREFIX + JSON.stringify(payload);
}

/**
 * Decodes a wire string produced by {@link linkRefPayloadToString} back to a
 * {@link WireLinkRefPayload}. Requires the `fcl1:` prefix, valid JSON, and the
 * generic wire-payload shape; throws on any violation. Field-level validation
 * (which keys, which kinds) is the consumer's concern, applied on top.
 */
export function linkRefPayloadFromString(wire: string): WireLinkRefPayload {
  if (!wire.startsWith(CELL_LINK_WIRE_PREFIX)) {
    throw new Error(
      `Not a cell-link wire string (missing \`${CELL_LINK_WIRE_PREFIX}\` prefix).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire.slice(CELL_LINK_WIRE_PREFIX.length));
  } catch {
    throw new Error("Cell-link wire string is not valid JSON.");
  }
  assertWireLinkRefPayloadShape(parsed);
  return parsed;
}
