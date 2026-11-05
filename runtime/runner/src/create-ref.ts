import { hashOf, isFabricSpecialObject } from "@commonfabric/data-model";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { isObjectOrArray } from "@commonfabric/js-values/types";

import {
  createFactoryTraversalContext,
  mapFactoryForTraversal,
} from "./builder/factory-traversal.ts";
import { isModule, isPattern, isReactive } from "./builder/types.ts";
import { exportCell, isCell } from "./cell.ts";
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
 * stored id — `entityIdExists`, which `runtime/cli` asks on a `cd` and
 * `runtime/fuse` asks per path lookup — has to be asked in that spelling,
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
  const factoryContext = createFactoryTraversalContext();
  const factoryStateAncestors = new WeakSet<object>();

  type LegacyPatternGraphSource = {
    argumentSchema?: unknown;
    resultSchema?: unknown;
    derivedInternalCells?: unknown;
    result?: unknown;
    nodes?: unknown;
    defaultScope?: unknown;
  };
  const legacyPatternGraph = (pattern: LegacyPatternGraphSource) => ({
    argumentSchema: pattern.argumentSchema,
    resultSchema: pattern.resultSchema,
    ...(pattern.derivedInternalCells === undefined
      ? {}
      : { derivedInternalCells: pattern.derivedInternalCells }),
    result: pattern.result,
    nodes: pattern.nodes,
    ...(pattern.defaultScope === undefined
      ? {}
      : { defaultScope: pattern.defaultScope }),
  });

  // Unwrap query result proxies and replace docs with their links. Admitted
  // factories map only their hidden semantic state; every other JavaScript
  // function fails closed.
  function traverse(
    obj: any,
    insideFactoryState = false,
    allowLegacyImplementationFunction = false,
    insideLegacyPatternGraph = false,
  ): any {
    if (isAdmittedFabricFactory(obj)) {
      const state = factoryStateOf(obj);
      const legacyPattern = obj as unknown as { toJSON?: () => unknown };

      // A hand-built pattern has no Factory@1 ref to hash. Its session-only
      // identity keeps the established structural graph fallback; every
      // ref-backed factory takes the canonical hidden-state path below.
      if (
        state.ref === undefined && state.kind === "pattern" &&
        typeof legacyPattern.toJSON === "function"
      ) {
        return traverse(
          legacyPatternGraph(obj as unknown as LegacyPatternGraphSource),
          insideFactoryState,
          false,
          true,
        );
      }

      // Keyless module and handler descriptors are permitted only inside the
      // already-recognized legacy pattern graph. They remain invalid as
      // standalone Fabric values and have no cold reconstruction path.
      if (state.ref === undefined && insideLegacyPatternGraph) {
        const legacyFactory = obj as unknown as { toJSON?: () => unknown };
        return traverse(
          typeof legacyFactory.toJSON === "function"
            ? legacyFactory.toJSON() ?? obj
            : Object.fromEntries(Object.entries(obj)),
          insideFactoryState,
          false,
          true,
        );
      }

      return mapFactoryForTraversal(
        obj,
        (nested) => traverse(nested, true),
        factoryContext,
      );
    }

    if (typeof obj === "function" && isReactive(obj)) {
      throw new Error(
        "[createRef] Cell method is not a value; cannot derive a stable id",
      );
    }

    if (typeof obj === "function") {
      if (allowLegacyImplementationFunction) return obj.toString();
      throw new TypeError(
        insideFactoryState
          ? "Arbitrary functions are not valid factory state values"
          : "Arbitrary functions are not valid createRef values",
      );
    }

    // A primitive is its own preimage. Nothing below applies to one -- it
    // carries no members to serialize, is no kind of reference, and holds
    // nothing to descend into -- and `obj` is `any`, so `null`, `undefined` and
    // every scalar arrive here.
    if (
      obj === null || (typeof obj !== "object" && typeof obj !== "function")
    ) {
      return obj;
    }

    // A non-callable builder artifact is represented by its encodable form.
    // Factories and reactive function projections were classified above: an
    // otherwise arbitrary function remains invalid even if it carries an
    // authored method with this name.
    if (typeof obj !== "function") {
      const form = encodableFormOf(obj);
      if (form !== null && form !== undefined && form !== obj) {
        return traverse(
          form,
          insideFactoryState,
          false,
          insideLegacyPatternGraph,
        );
      }
    }

    // Don't traverse into atomic values or already-serialized references. A
    // Fabric-special object is hashed through its codec rather than decomposed
    // into enumerable implementation details. A serialized entity-ref or
    // sigil link is likewise an atomic reference to another cell.
    //
    // A link is hashed as it stands, schema and all. This walk takes what it
    // is given: a caller deriving an id has to hand over a preimage that is
    // causal, and reducing one here would only hide the difference between a
    // caller that did and one that did not. `causalFormOfBinding()` does the
    // reducing for a node's cause, at the seam that knows which links a bound
    // tree holds and why they carry a schema at all.
    //
    if (isFabricSpecialObject(obj)) return obj;
    if (isSigilLink(obj) || isEntityRef(obj)) return obj;

    // A hand-built pattern graph carries live module descriptors, including
    // runtime-only serializer methods. Hash the same encodable module form the
    // graph writer uses rather than descending into those methods as authored
    // values. This exception is confined to the already-admitted legacy graph;
    // an arbitrary object with a serializer remains ordinary input.
    if (
      insideLegacyPatternGraph && isModule(obj) &&
      typeof (obj as { toEncodableForm?: unknown }).toEncodableForm ===
        "function"
    ) {
      return traverse(
        encodableFormOf(obj),
        insideFactoryState,
        false,
        true,
      );
    }

    const factoryStateContainer = insideFactoryState && obj !== null &&
        typeof obj === "object"
      ? obj as object
      : undefined;
    if (factoryStateContainer !== undefined) {
      if (factoryStateAncestors.has(factoryStateContainer)) {
        throw new TypeError("Circular reference detected in factory state");
      }
      factoryStateAncestors.add(factoryStateContainer);
    }

    try {
      // Avoid cycles. Primitives and codec-owned atoms are gone by here; those
      // use value equality and must remain occurrence-sensitive.
      if (seen.has(obj)) return null;
      seen.add(obj);

      if (isReactive(obj)) {
        // A stream is the one reactive an id derives from: it holds no value,
        // and its sentinel stands in as the value the id hashes. Any other
        // reactive has no value to hash, and an id minted from one would
        // silently become non-deterministic (audit S14). Fail closed.
        if (exportCell(obj).kind !== "stream") {
          throw new Error(
            "[createRef] Reactive has no value; cannot derive a stable id",
          );
        }
        return { $stream: true };
      }

      if (isCellResultForDereferencing(obj)) {
        // A query result stands for the cell it dereferences to, and derives
        // what that cell derives.
        obj = getCellOrThrow(obj);
      }

      if (isCell(obj)) {
        // Reading the entity id materializes a link from an explicit cause.
        const id = obj.entityId;
        if (id == null) {
          // A referenced Cell must already name an entity; otherwise the id
          // would silently become non-deterministic (audit S14).
          throw new Error(
            "[createRef] Cell has no entityId; cannot derive a stable id",
          );
        }

        // The path participates in cell identity, so derive from the complete
        // link rather than from the document id alone.
        return traverse(
          encodableFormOf(obj),
          insideFactoryState,
          false,
          insideLegacyPatternGraph,
        );
      } else if (Array.isArray(obj)) {
        return obj.map((value) =>
          traverse(value, insideFactoryState, false, insideLegacyPatternGraph)
        );
      } else if (isObjectOrArray(obj)) {
        return Object.fromEntries(
          Object.entries(obj).map(([key, value]) => [
            key,
            traverse(
              value,
              insideFactoryState,
              insideLegacyPatternGraph && key === "implementation" &&
                isModule(obj),
              insideLegacyPatternGraph,
            ),
          ]),
        );
      } else {
        // A primitive reaches here only as an encodable form. A form is its
        // own preimage; stringifying it would collapse values such as 7 and
        // "7" onto one identity.
        return obj;
      }
    } finally {
      if (factoryStateContainer !== undefined) {
        factoryStateAncestors.delete(factoryStateContainer);
      }
    }
  }

  // The entity kind deliberately does NOT enter the preimage: a computed
  // cell and a state cell minted from the same cause share hash bytes and
  // differ only in their URI scheme (`computed:` vs `of:`, applied by
  // `toURI`). The full URI string is the identity; nothing may rebuild a
  // computed cell's URI from its bare hash.
  const directFactoryState = isAdmittedFabricFactory(source)
    ? factoryStateOf(source)
    : undefined;
  const directLegacyPattern = directFactoryState?.kind === "pattern" &&
      directFactoryState.ref === undefined
    ? legacyPatternGraph(source as LegacyPatternGraphSource)
    : source;
  return entityIdFrom(hashOf(
    traverse(
      { ...directLegacyPattern, causal: cause },
      false,
      false,
      isPattern(source),
    ),
  ));
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
