import type { JSONSchema, LinkScope } from "@commonfabric/api";
import {
  LINK_V1_TAG,
  type LinkRef,
  type WireLinkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { isLinkScope } from "./scope.ts";

export type { URI } from "@commonfabric/memory/interface";

// The link-ref envelope (`{ "/": { "link@1": … } }`) and its tag are owned by
// `data-model/cell-rep`, the chokepoint that will later flag-dispatch the form.
// Re-exported here (the historical home) for existing importers.
export { LINK_V1_TAG };

/**
 * The payload of a cell-link {@link LinkRef} — the object at the
 * {@link LINK_V1_TAG} key. (The `link@1` tag versions the wire envelope; this
 * payload shape is version-agnostic and expected to outlive it.)
 */
export type CellLinkRefPayload = {
  id?: URI;
  path?: readonly string[];
  space?: MemorySpace;
  scope?: LinkScope;
  schema?: JSONSchema;
  overwrite?: "redirect" | "this"; // default is "this"
};

/**
 * The subset of a {@link CellLinkRefPayload} that is safe to carry across a
 * string boundary (the webhook wire): only the addressing fields, every one of
 * which is a string or an array of strings. `schema` is dropped — it can carry
 * an arbitrary `FabricValue` default (not plain JSON), and the webhook consumer
 * imposes its own schema regardless. cfc's `cfcLabelView` is likewise absent (it
 * is not part of the base payload, and stream/set operations never read it).
 */
export type WebhookCellLinkRefPayload = Omit<CellLinkRefPayload, "schema">;

/**
 * The payload members that address a cell: which document, in which space and
 * scope, at which path, and whether a write there redirects. This is the whole
 * of what a link says about where it points; everything else a payload may
 * carry -- `schema`, cfc's `cfcLabelView` -- describes how the value there is
 * read or labeled.
 *
 * Two consumers turn on that distinction, and share this list so they cannot
 * drift apart on what "addressing" means. The webhook wire admits these and
 * refuses the rest ({@link assertWebhookCellLinkRefPayload}), and a node's
 * cause is reduced to them (`sigilLinkAddressOnly`).
 */
export const LINK_ADDRESS_KEYS = [
  "id",
  "space",
  "scope",
  "path",
  "overwrite",
] as const;

/**
 * Validates the field-level shape of a decoded {@link WireLinkRefPayload} as a
 * {@link WebhookCellLinkRefPayload}: only the known addressing keys, each of the
 * expected kind — `id`/`space` strings, `path` an array, and `scope`/`overwrite`
 * actual enum members. This layers on top of cell-rep's generic guard, which has
 * already ensured every value is a plain string or array of strings.
 */
export function assertWebhookCellLinkRefPayload(
  payload: WireLinkRefPayload,
): asserts payload is WebhookCellLinkRefPayload {
  for (const key of Object.keys(payload)) {
    if (!(LINK_ADDRESS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unexpected cell-link field: "${key}".`);
    }
  }
  if (payload.path !== undefined && !Array.isArray(payload.path)) {
    throw new Error('Cell-link "path" must be an array of strings.');
  }
  for (const key of ["id", "space"] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw new Error(`Cell-link "${key}" must be a string.`);
    }
  }
  // Validate the enum-valued fields against their actual members, not merely
  // "is a string" — otherwise this assertion would be unsound (e.g. a bogus
  // `scope` would pass and then be typed as a valid `LinkScope`).
  if (payload.scope !== undefined && !isLinkScope(payload.scope)) {
    throw new Error(
      'Cell-link "scope" must be one of "inherit", "space", "user", "session".',
    );
  }
  if (
    payload.overwrite !== undefined &&
    payload.overwrite !== "redirect" && payload.overwrite !== "this"
  ) {
    throw new Error('Cell-link "overwrite" must be "redirect" or "this".');
  }
}

/**
 * Sigil link type.
 *
 * Transitional alias for {@link LinkRef}: structurally the same envelope, but
 * named through the chokepoint that will later flag-dispatch the form. Once a
 * modern (non-envelope) representation exists, `SigilLink` (which _is_ the
 * envelope) and `LinkRef` (which spans both forms) diverge and this alias gets
 * cleaned up.
 *
 * Parameterized on the payload so a producer can advertise a richer payload
 * (e.g. cfc's `CfcCellLinkRefPayload`); defaults to the base
 * {@link CellLinkRefPayload}, so bare `SigilLink` is unchanged.
 */
export type SigilLink<P extends CellLinkRefPayload = CellLinkRefPayload> =
  LinkRef<P>;

/**
 * A {@link SigilLink} whose payload is a write redirect — its `overwrite` is
 * fixed to `"redirect"`, so a write through it lands at the target rather
 * than replacing the link.
 */
export type SigilWriteRedirectLink = LinkRef<
  CellLinkRefPayload & { overwrite: "redirect" }
>;
