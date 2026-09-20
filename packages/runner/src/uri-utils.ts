import { debugStr, hashOf } from "@commonfabric/data-model";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";

import {
  type EntityKind,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  uriSchemeForEntityKind,
} from "./entity-kind.ts";
import type { URI } from "./sigil-types.ts";

/**
 * Convert an entity ID to URI format. The scheme carries the entity kind:
 * no kind ⇒ `of:`, `kind: "computed"` ⇒ `computed:` (see `entity-kind.ts`).
 *
 * The resulting URI STRING is the identity — never rebuild a computed
 * cell's URI from its bare hash (`fromURI` strips the scheme, so a
 * round-trip through the bare form would silently rename the entity to its
 * `of:` sibling). `kind` is a minting-time argument: passing it alongside
 * an already-schemed string throws rather than re-scheming an existing
 * identity.
 */
export function toURI(value: unknown, kind?: EntityKind): URI {
  if (value instanceof FabricHash) {
    // The live id form (an `EntityId`/`createRef` result) is a `FabricHash` in
    // either cell-rep regime.
    return `${uriSchemeForEntityKind(kind)}:${value}`;
  } else if (isEntityRef(value)) {
    // A serialized entity-ref for the active regime. With the modern cell
    // representation on, that form is the `FabricHash` handled above; the
    // `{ "/": … }` object only arises in legacy mode.
    return `${uriSchemeForEntityKind(kind)}:${entityRefToString(value)}`;
  } else if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) {
      if (kind !== undefined) {
        throw new Error(
          `Cannot mint kind "${kind}" onto an already-schemed URI: ${value}`,
        );
      }
      // TODO(seefeld): Remove this once we want to support any URI, ideally
      // once there are no bare ids anymore
      if (!hasEntityUriScheme(value) && !hasDataUriScheme(value)) {
        throw new Error(`Invalid URI: ${value}`);
      }
      return value as URI;
    } else {
      // Add the scheme prefix
      return `${uriSchemeForEntityKind(kind)}:${value}`;
    }
  }

  throw new Error(
    debugStr`Cannot convert value to URI: $quote${value}`,
  );
}

/**
 * Extract the hash from a URI by removing the entity scheme (`of:` or
 * `computed:`). NOTE: the scheme is part of the identity — the bare hash of
 * a `computed:` id is NOT an alias for it, so never feed the result back
 * into `toURI` expecting the same entity.
 */
export function fromURI(uri: URI | string): string {
  const entityScheme = entityUriSchemePrefix(uri);
  if (!uri.includes(":")) {
    return uri;
  } else if (entityScheme !== undefined) {
    return uri.slice(entityScheme.length);
  } else if (hasDataUriScheme(uri)) {
    return hashOf(uri).toString();
  } else {
    // TODO(seefeld): Remove this once we want to support any URI
    throw new Error(`Invalid URI: ${uri}`);
  }
}
