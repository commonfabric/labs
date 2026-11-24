import { ENTITY_URI_SCHEMES } from "@commonfabric/runner/entity-kind";

const ENTITY_SCHEME_ALT = ENTITY_URI_SCHEMES.join("|");
const ENTITY_SCHEME_SEGMENT_RE = new RegExp(
  `/((?:${ENTITY_SCHEME_ALT}):[^/]+)`,
);

/** Return the full schemed entity URI embedded in a scheduler action id. */
export function entityUriFromActionId(actionId: string): string | undefined {
  return actionId.match(ENTITY_SCHEME_SEGMENT_RE)?.[1];
}
