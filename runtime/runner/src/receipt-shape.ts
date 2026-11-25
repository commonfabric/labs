import { isPlainObject } from "@commonfabric/js-values/types";

import type { JSONSchema } from "./builder/types.ts";
import { findAndInlineDataUriLinks } from "./data-uri.ts";
import { isCellLink } from "./link-utils.ts";

/**
 * Structural description of `value` for the durable `schema` metadata of the
 * receipt cell it is about to be written into: the root container kind, plus
 * the property names when that kind is a record. Returns `undefined` for a
 * value with no container kind of its own — a scalar, a `FabricSpecialObject`,
 * or a link, whose kind belongs to whatever it resolves to rather than to the
 * receipt.
 *
 * An immutable `snapshot:` or Fabric `data:` link is expanded on write, so the receipt holds that
 * value rather than a link to it. The description comes from the same
 * inlining, so it describes what is stored.
 *
 * This is DESCRIPTIVE — what this one receipt holds — and never a contract
 * bearing on anything written later. Description and authority cannot diverge
 * here, because the receipt's create-only mark means the value it describes is
 * the only value the document ever holds.
 *
 * The root kind is what lets a reader's selection become a fetch selector
 * instead of a filter applied after loading, since the same selection means
 * different things over a record and over an array. The property schemas are
 * left as `true` — everything is admissible at every position — which is what
 * keeps a link position honest: spelling one out means `asCell`, and `["cell"]`
 * asserts a writable handle on a document nothing can be written through.
 */
export function receiptShapeSchema(value: unknown): JSONSchema | undefined {
  const stored = isCellLink(value) ? findAndInlineDataUriLinks(value) : value;
  if (isCellLink(stored)) return undefined;
  if (Array.isArray(stored)) return { type: "array" };
  if (!isPlainObject(stored)) return undefined;
  const properties: Record<string, JSONSchema> = {};
  for (const key of Object.keys(stored)) properties[key] = true;
  return { type: "object", properties };
}
