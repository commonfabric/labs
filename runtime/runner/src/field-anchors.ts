/**
 * Where a collaborative field's anchors are stored: the anchors document
 * Memory writes whenever they change
 * (`docs/specs/memory-v2/07-op-views-and-annotations.md`, "The anchors
 * document").
 */

import { operationAnchorsDocId } from "@commonfabric/memory/v2";

import type { NormalizedFullLink } from "./link-types.ts";
import { toURI } from "./uri-utils.ts";

/**
 * The link to the anchors document of the string field `field` names, which
 * is `{ epoch, version, anchors }`: an id derived from the field's address,
 * in the field's own space and scope.
 */
export const anchorsDocumentLink = (
  field: NormalizedFullLink,
): NormalizedFullLink => ({
  space: field.space,
  id: toURI(
    operationAnchorsDocId({
      id: field.id,
      scope: field.scope,
      path: field.path,
    }),
  ),
  scope: field.scope,
  path: [],
});
