import { hashOf } from "@commonfabric/data-model";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { BaseFabricPrimitive } from "@commonfabric/data-model/fabric-bases";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { isReactive } from "./builder/types.ts";
import { isCell } from "./cell.ts";
import { encodableFormOf } from "./encodable-form.ts";
import {
  hasEntityUriScheme,
  hashStringForEntityAddress,
} from "./entity-kind.ts";
import { isSigilLink, parseLink } from "./link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { fromURI, toURI } from "./uri-utils.ts";

declare const ENTITY_ID_BRAND: unique symbol;

/**
 * An entity id: a {@link FabricHash} that specifically names a cell/document
 * within a space (as produced by {@link createRef}), as opposed to an arbitrary
 * content/value/schema hash. The brand is type-only — at runtime an `EntityId`
 * is just a `FabricHash` — and exists to keep "this hash is an entity id" a
 * distinct, intentional thing in the type system. Construct via
 * {@link entityIdFrom} (or {@link createRef}).
 */
export type EntityId = FabricHash & { readonly [ENTITY_ID_BRAND]: true };

/**
 * Brands a content-hash string (or `FabricHash`) as an {@link EntityId}.
 *
 * A string may arrive in either spelling of an unkinded entity: the bare
 * tagged hash (`fid1:<hash>`) or the `of:`-schemed URI over it. This is the
 * entity-specific intake seam, so it is where the URI scheme is understood —
 * `FabricHash.fromString` below parses a tagged hash, in which `of:` is not a
 * tag but a second colon, and would reject the schemed form.
 *
 * A kinded id (`computed:fid1:<hash>`) throws by name rather than being
 * stripped to the different entity its bare hash names; see
 * {@link hashStringForEntityAddress}.
 */
export function entityIdFrom(hash: string | FabricHash): EntityId {
  return (typeof hash === "string"
    ? FabricHash.fromString(hashStringForEntityAddress(hash))
    : hash) as EntityId;
}

/**
 * The id string naming the entity `address` addresses: the id a read through
 * {@link entityIdFrom} would reach, where the address is one this runtime can
 * address, and `address` itself where it is not.
 *
 * It is what puts a lookup and a read on one document. An index keyed on the
 * stored id — `entityIdExists`, which `packages/cli` asks on a `cd` and
 * `packages/fuse` asks per path lookup — has to be asked in that spelling,
 * while an address reaches those callers in whichever spelling a person or a
 * directory name carried. So the answer is composed from the seam a read uses
 * rather than recognized again here: {@link entityIdFrom} decides what the
 * string addresses and `toURI` spells the result, which is the pair
 * `Runtime.getCellFromEntityId` puts in front of every read.
 *
 * An address the pair refuses comes back untouched, and that is the case worth
 * stating, because the refusal is not an error here. An id under a scheme
 * belonging to some other subject — a `cid:` schema document, a `data:` URI —
 * is already an id and needs no second one; a kinded `computed:` id names an
 * entity of its own; and a string that addresses nothing has nothing to
 * normalize. Scheming any of those would build a *different* id that nothing
 * holds, and a lookup would then answer a confident `false` about a document
 * that is there.
 *
 * A spelling `FabricHash` would respell — a padded `fid1:AA==` — comes back as
 * the id its canonical form names, for the same reason: that is the document a
 * read of it would reach.
 */
export function idStringForEntityAddress(address: string): string {
  try {
    return toURI(entityIdFrom(address));
  } catch {
    // Not an address this runtime can turn into an id, so it is either an id
    // already or nothing — either way the caller's own string is what a lookup
    // should be asked about. `entityIdFrom` throws for both, and neither is a
    // failure to report.
    return address;
  }
}

/**
 * Generates an entity ID.
 *
 * Derivation inputs must resolve: a Cell with no entityId, a Reactive with no
 * value, and a cell's method -- which names no value of its own -- each throw
 * rather than minting a substitute, so a derived id never silently becomes
 * non-deterministic or unresolvable (audit S14). A missing `cause`, by
 * contrast, deliberately mints a fresh random id.
 *
 * @param source - The source object.
 * @param cause - Optional causal source. If omitted, a random id is minted.
 */
export function createRef(
  source: Record<string | number | symbol, any> = {},
  cause: any = (() => {
    console.error(
      "[createRef] NO CAUSE — falling back to randomUUID",
      new Error().stack,
    );
    return crypto.randomUUID();
  })(),
): EntityId {
  const seen = new Set<any>();

  // Unwrap query result proxies and replace docs with their ids; functions are
  // stringified, since our data model doesn't support them as values.
  function traverse(obj: any): any {
    // A primitive is its own preimage. Nothing below applies to one -- it
    // carries no members to serialize, is no kind of reference, and holds
    // nothing to descend into -- and `obj` is `any`, so `null`, `undefined` and
    // every scalar arrive here.
    if (
      obj === null || (typeof obj !== "object" && typeof obj !== "function")
    ) {
      return obj;
    }

    // Avoid cycles. Primitives are not tracked, and are gone by here: they use
    // value equality in a Set, so repeated strings like "primary" would be
    // deduplicated and collide the hashes of patterns differing only in the
    // position of a repeated value.
    if (seen.has(obj)) return null;
    seen.add(obj);

    // Don't traverse into atomic values or already-serialized references. A
    // `FabricPrimitive` (a `FabricHash` id, `FabricBytes`, a date, …) is an
    // atomic value and must be hashed via its own codec — descending into one
    // would decompose it to its (empty) enumerable props and collide distinct
    // values. A serialized entity-ref or sigil link is a reference to another
    // cell, recognized through the cell-rep / sigil chokepoint predicates rather
    // than the raw `{ "/": ... }` shape.
    //
    // A link is hashed as it stands, schema and all. This walk takes what it
    // is given: a caller deriving an id has to hand over a preimage that is
    // causal, and reducing one here would only hide the difference between a
    // caller that did and one that did not. `causalFormOfBinding()` does the
    // reducing for a node's cause, at the seam that knows which links a bound
    // tree holds and why they carry a schema at all.
    //
    // TODO(danfuzz): the other data-model special-object type, `FabricInstance`
    // (a container that holds other values), is not handled here. Unlike a
    // primitive it *does* need descending into — but by its actual contents,
    // which the generic enumerable-prop traversal below won't do correctly. This
    // site will need attention once FabricInstances see real use.
    if (obj instanceof BaseFabricPrimitive) return obj;
    if (isSigilLink(obj) || isEntityRef(obj)) return obj;

    // A cell's _method_ is not a value. For a name in `cellMethods`, a
    // `Reactive` returns a proxy that is callable and is also a projection of
    // the cell at that name, so one object serves both the method and a data
    // key of the same name, and its encodable form is the same link either
    // way. A derived id therefore cannot express which of the two was meant.
    // Failing closed says so, rather than minting an id off the ambiguity
    // (audit S14) -- and where no data lives at the name, that id would rest on
    // a link to a path holding nothing.
    //
    // A builder artifact is a function carrying the member too, and is not
    // reactive, which is what separates the two here.
    if (typeof obj === "function" && isReactive(obj)) {
      throw new Error(
        "[createRef] Cell method is not a value; cannot derive a stable id",
      );
    }

    // A builder artifact is replaced by its encodable form, then descended
    // into: what the ref is derived from is the form that gets written.
    // Functions qualify because a pattern factory is one.
    //
    // A _nullish_ form leaves the value in place, which is what the `??` is
    // for -- a value carrying no form at all needs no fallback, since that
    // answer is the value already. `CellImpl` is the one implementation that
    // returns nullish, doing so for a cell whose link is not built yet, and the
    // branches below need that cell rather than the `null`: one of them builds
    // the link.
    obj = encodableFormOf(obj) ?? obj;

    if (isReactive(obj)) {
      // A stream is the one reactive an id derives from: it holds no value,
      // and its sentinel stands in as the value the id hashes. Any other
      // reactive has no value to hash, and an id minted from one would
      // silently become non-deterministic (audit S14). Fail closed.
      if (obj.export().kind !== "stream") {
        throw new Error(
          "[createRef] Reactive has no value; cannot derive a stable id",
        );
      }
      return { $stream: true };
    }

    if (isCellResultForDereferencing(obj)) {
      // A query result stands for the cell it dereferences to, and derives what
      // that cell derives.
      obj = getCellOrThrow(obj);
    }

    if (isCell(obj)) {
      // Reading the entity id is what materializes a link from an explicit
      // cause, so it comes first: the link read below is available only once
      // this has happened.
      const id = obj.entityId;
      if (id == null) {
        // A Cell referenced from a derived id must have an entityId; otherwise
        // the id would silently become non-deterministic (audit S14). Fail
        // closed rather than mint a random substitute.
        throw new Error(
          "[createRef] Cell has no entityId; cannot derive a stable id",
        );
      }

      // The path is part of what names a cell, so a cell derives from the link
      // naming it -- the same form the encodable-form branch above gives a cell
      // that arrives directly, which is what keeps the two routes at one
      // answer. Two cells of one document derive two ids.
      return traverse(encodableFormOf(obj));
    } else if (Array.isArray(obj)) return obj.map(traverse);
    else if (isObjectOrArray(obj)) {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [key, traverse(value)]),
      );
    } else if (typeof obj === "function") return obj.toString();
    // A primitive reaches here only as an encodable FORM, the reassignment above
    // having replaced the value it came from -- a primitive INPUT is handled at
    // the top of the walk. A form is its own preimage, and stringifying one
    // would make the form `7` and the form `"7"` name a single document.
    else return obj;
  }

  // The entity kind deliberately does NOT enter the preimage: a computed
  // cell and a state cell minted from the same cause share hash bytes and
  // differ only in their URI scheme (`computed:` vs `of:`, applied by
  // `toURI`). The full URI string is the identity; nothing may rebuild a
  // computed cell's URI from its bare hash.
  return entityIdFrom(hashOf(traverse({ ...source, causal: cause })));
}

/**
 * Helper to consistently get an entity ID from various object types
 */
export function getEntityId(value: any): EntityRef | undefined {
  if (typeof value === "string") {
    // Handle URI format with an entity scheme ("of:", "computed:", ...)
    if (hasEntityUriScheme(value)) {
      value = fromURI(value);
    }
    return entityRefFromString(value);
  }

  const link = parseLink(value);

  if (!link || !link.id) return undefined;

  const baseRef = entityRefFromString(fromURI(link.id));

  if (link.path && link.path.length > 0) {
    return entityRefFrom(createRef({ path: link.path }, baseRef));
  } else return baseRef;
}
