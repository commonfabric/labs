/**
 * Decides the two owner releases of confidentiality stored at one path of a
 * document (spec §8.12.7): which stored clauses go, and what the document's
 * label map and stored schema hold once they are gone. Pure: the transaction
 * methods that persist a release read the stored envelope, call a plan here,
 * and write the result.
 *
 * An owner release (route 2c, {@link planConfidentialityRelease}) removes
 * every stored clause the request does not keep, each of which must be the
 * acting principal's alone to release. It reaches every component at the path
 * — declared, derived (`shape` and `value` entries alike, the existence entry
 * §8.12.8 otherwise freezes), and link-carried — and nothing at any other
 * path. A `*` segment in the path stands for any segment, so a path holding
 * one reaches every position it matches at its depth: the wildcard entry that
 * labels each of them, and the entries of each one.
 *
 * An owner release by intent (route 2d,
 * {@link planConfidentialityReleaseByIntent}) removes the stored clauses its
 * request names by canonical clause digest, whoever they stand for, from the
 * same components at one stored position, its path matched literally, so a
 * `*` segment names the wildcard position and nothing it covers. Its gate is
 * the space owner's signed request, which the caller verifies.
 */

import { debugStr } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity/did";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { cfcCanonicalClauseDigest } from "@commonfabric/memory/v2/cfc-clause-identity";
import type { SignedOwnerReleaseByIntentRequest } from "@commonfabric/memory/v2/cfc-owner-release-by-intent";
import {
  type CfcConfClause,
  clauseReleasableBy,
  commitmentAwareEquals,
} from "@commonfabric/memory/v2/cfc-release-authority";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { CellScope, JSONSchema } from "../builder/types.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { normalizeClause } from "./clause.ts";
import {
  cfcSchemaEntries,
  declaredObservationClass,
} from "./schema-label-view.ts";
import type { IFCLabel, LabelMapEntry } from "./types.ts";

/** Builtin implementation identity that alone writes confidentiality releases. */
export const CONFIDENTIALITY_RELEASE_WRITER = "cfc-confidentiality-release";

/**
 * Builtin implementation identity that alone writes releases by intent and
 * their records.
 */
export const OWNER_RELEASE_BY_INTENT_WRITER = "cfc-owner-release-by-intent";

/** What a document holds once a release removes clauses at one path. */
export interface ConfidentialityReleasePlan {
  /** The stored clauses the release removes, each once, as stored. */
  readonly released: readonly CfcConfClause[];

  /** The positions the release removes a clause at, each once. */
  readonly paths: readonly (readonly string[])[];

  /** The document's payload label-map entries without the released clauses. */
  readonly entries: readonly LabelMapEntry[];

  /**
   * The stored schema without the released clauses, or the stored schema
   * itself when it declares none of them at the path.
   */
  readonly schema: JSONSchema | undefined;
}

/**
 * Whether two clauses are the same clause, alternative order aside, with a
 * committed field (`{ digestOf }`) equal to the plaintext it commits to.
 */
export const sameClause = (
  left: CfcConfClause,
  right: CfcConfClause,
): boolean =>
  commitmentAwareEquals(normalizeClause(left), normalizeClause(right));

/**
 * The label of `confidentiality` and `integrity` with an empty member left
 * out, or `undefined` when both are empty: the form two labels are compared
 * in.
 */
const nonEmptyLabel = (
  confidentiality: readonly CfcConfClause[] | undefined,
  integrity: IFCLabel["integrity"],
): IFCLabel | undefined => {
  const label: IFCLabel = {
    ...(confidentiality !== undefined && confidentiality.length > 0
      ? { confidentiality: [...confidentiality] }
      : {}),
    ...(integrity !== undefined && integrity.length > 0
      ? { integrity: [...integrity] }
      : {}),
  };
  return Object.keys(label).length === 0 ? undefined : label;
};

/**
 * How a release's path names the stored positions it reaches: `wildcard`,
 * where a `*` segment stands for any segment (route 2c, {@link pathNames}),
 * or `literal`, where a path names the one stored position spelled the same,
 * a `*` segment naming the wildcard position itself (route 2d).
 */
type PathMatching = "wildcard" | "literal";

/**
 * Whether `path`, the path a release names, names the stored position
 * `position`: the two are of one depth, and each segment of `path` is `*` or
 * the segment of `position` beside it.
 */
const pathNames = (
  path: readonly string[],
  position: readonly string[],
): boolean =>
  position.length === path.length &&
  path.every((segment, index) =>
    segment === "*" || segment === position[index]
  );

/** The test of whether a release's path names a stored position, by `matching`. */
const namesPosition = (matching: PathMatching) =>
  matching === "wildcard"
    ? pathNames
    : (path: readonly string[], position: readonly string[]) =>
      deepEqual(path, position);

/**
 * Helper for {@link planConfidentialityRelease}, which returns `schema` with
 * the clauses `released` selects taken out of the `ifc` at each position
 * `path` names, reached through the positions `cfcSchemaEntries()` reports: a
 * named property, a tuple position of `prefixItems`, and, for a `*` segment,
 * every one of those besides `items` and the `additionalProperties` of a
 * schema naming no property. An `ifc` left declaring nothing goes, and an
 * `observes` class with no label beside it goes with it. Returns `undefined`
 * where a concrete segment leads through anything else, such as a reference or
 * a branch; a `*` segment leaves such a child as it is, for the caller's check
 * of the result to find. Under `literal` matching a `*` segment names the
 * wildcard position alone, so it reaches `items` and the
 * `additionalProperties` of a schema naming no property, and no named
 * property or tuple position.
 */
const lowerSchemaAt = (
  schema: JSONSchema,
  path: readonly string[],
  released: (clause: CfcConfClause) => boolean,
  matching: PathMatching,
): JSONSchema | undefined => {
  if (!isObjectNotArray(schema) || schema.$ref !== undefined) return undefined;
  if (path.length > 0) {
    const [head, ...rest] = path;
    const lowerChild = (child: JSONSchema) =>
      lowerSchemaAt(child, rest, released, matching);
    const properties = isObjectNotArray(schema.properties)
      ? schema.properties
      : undefined;
    const prefixItems = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : undefined;
    if (head === "*") {
      const lowerOrKeep = (child: JSONSchema) => lowerChild(child) ?? child;
      const recordOnly = properties === undefined ||
        Object.keys(properties).length === 0;
      const literal = matching === "literal";
      return {
        ...schema,
        ...(literal || properties === undefined ? {} : {
          properties: Object.fromEntries(
            Object.entries(properties).map((
              [key, child],
            ) => [key, lowerOrKeep(child)]),
          ),
        }),
        ...(literal || prefixItems === undefined
          ? {}
          : { prefixItems: prefixItems.map(lowerOrKeep) }),
        ...(schema.items === undefined
          ? {}
          : { items: lowerOrKeep(schema.items) }),
        ...(!recordOnly || schema.additionalProperties === undefined ? {} : {
          additionalProperties: lowerOrKeep(schema.additionalProperties),
        }),
      };
    }
    if (properties !== undefined && Object.hasOwn(properties, head)) {
      const child = lowerChild(properties[head]);
      return child === undefined
        ? undefined
        : { ...schema, properties: { ...properties, [head]: child } };
    }
    const index = prefixItems === undefined
      ? -1
      : prefixItems.findIndex((_, at) => String(at) === head);
    if (prefixItems === undefined || index < 0) return undefined;
    const child = lowerChild(prefixItems[index]);
    return child === undefined
      ? undefined
      : { ...schema, prefixItems: prefixItems.with(index, child) };
  }
  const { ifc, ...withoutIfc } = schema;
  if (ifc?.confidentiality === undefined) return schema;
  const { confidentiality, observes, ...others } = ifc;
  const kept = confidentiality.filter((clause) => !released(clause));
  const declared = kept.length > 0
    ? { ...others, confidentiality: kept }
    : others;
  return Object.keys(declared).length === 0 ? withoutIfc : {
    ...withoutIfc,
    ifc: observes === undefined ? declared : { ...declared, observes },
  };
};

/**
 * The confidentiality clauses stored at `path`, each once, as stored: those of
 * every payload label-map entry at a position `path` names by `matching`,
 * whatever its origin or observation class, together with those the stored
 * schema declares there (`schemaEntries`, `cfcSchemaEntries()` of it).
 */
const clausesStoredAt = (
  path: readonly string[],
  entries: readonly LabelMapEntry[],
  schemaEntries: ReturnType<typeof cfcSchemaEntries>,
  matching: PathMatching,
): CfcConfClause[] => {
  const names = namesPosition(matching);
  const stored: CfcConfClause[] = [];
  for (
    const clause of [...entries, ...schemaEntries]
      .filter((entry) => names(path, canonicalizeLogicalPath(entry.path)))
      .flatMap((entry) => entry.label.confidentiality ?? [])
  ) {
    if (!stored.some((known) => sameClause(known, clause))) {
      stored.push(clause);
    }
  }
  return stored;
};

/**
 * Helper for {@link planConfidentialityRelease} and
 * {@link planConfidentialityReleaseByIntent}, which returns what the document
 * holds once the clauses `released` are removed from every payload label-map
 * entry and stored-schema declaration at a position `path` names by
 * `matching`, and from nothing else. `path` is canonical, and `location` is
 * how a refusal names it.
 *
 * @throws If the stored schema declares a released clause at a position the
 *   path names through a reference or an `allOf`, `anyOf` or `oneOf` branch,
 *   where the declaration may describe other paths too.
 */
const planClauseRemoval = (input: {
  readonly path: readonly string[];
  readonly location: string;
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
  readonly schemaEntries: ReturnType<typeof cfcSchemaEntries>;
  readonly released: readonly CfcConfClause[];
  readonly matching: PathMatching;
}): ConfidentialityReleasePlan => {
  const { path, location, released, schemaEntries, matching } = input;
  const names = namesPosition(matching);
  const atPath = (entryPath: readonly string[]) =>
    names(path, canonicalizeLogicalPath(entryPath));
  if (released.length === 0) {
    return {
      released,
      paths: [],
      entries: input.entries,
      schema: input.schema,
    };
  }
  const isReleased = (clause: CfcConfClause) =>
    released.some((gone) => sameClause(gone, clause));
  const paths: (readonly string[])[] = [];
  for (const entry of [...input.entries, ...schemaEntries]) {
    const position = canonicalizeLogicalPath(entry.path);
    if (
      atPath(position) &&
      (entry.label.confidentiality ?? []).some(isReleased) &&
      !paths.some((known) => deepEqual(known, position))
    ) {
      paths.push(position);
    }
  }
  const lowered = (label: IFCLabel) =>
    nonEmptyLabel(
      label.confidentiality?.filter((clause) => !isReleased(clause)),
      label.integrity,
    );
  const entries = input.entries.flatMap((entry) => {
    if (!atPath(entry.path)) return [entry];
    const label = lowered(entry.label);
    return label === undefined ? [] : [{ ...entry, label }];
  });
  if (
    input.schema === undefined ||
    !schemaEntries.some((entry) =>
      atPath(entry.path) &&
      (entry.label.confidentiality ?? []).some(isReleased)
    )
  ) {
    return { released, paths, entries, schema: input.schema };
  }
  // The walk reaches declarations through `properties`, `prefixItems`,
  // `items` and `additionalProperties` alone, and what it changed is then
  // held to what it was meant to change: every declaration the schema makes, with the
  // released clauses gone from the positions the path names and nothing else
  // different.
  const schema = lowerSchemaAt(input.schema, path, isReleased, matching);
  const declarations = (
    entries: ReturnType<typeof cfcSchemaEntries>,
    change: (label: IFCLabel) => IFCLabel | undefined,
  ) =>
    entries.flatMap((entry) => {
      const label = atPath(entry.path)
        ? change(entry.label)
        : nonEmptyLabel(entry.label.confidentiality, entry.label.integrity);
      return label === undefined ? [] : [{ path: entry.path, label }];
    });
  if (
    schema === undefined ||
    !deepEqual(
      declarations(
        cfcSchemaEntries(schema),
        (label) => nonEmptyLabel(label.confidentiality, label.integrity),
      ),
      declarations(schemaEntries, lowered),
    )
  ) {
    throw new Error(
      `Cannot lower confidentiality at ${location}: the stored schema ` +
        "declares it through `$ref`, `allOf`, `anyOf` or `oneOf`, which a " +
        "release does not rewrite.",
    );
  }
  return { released, paths, entries, schema };
};

/** How a refusal names `path`, a canonical path. */
const locationOf = (path: readonly string[]): string =>
  path.length === 0 ? "<root>" : path.join("/");

/**
 * Plans the release of every confidentiality clause stored at `path` that
 * `keep` does not name: the decision of the specification's `ownerReleaseAt`
 * (§8.12.7), less the home-space check its caller makes. The clauses stored at a path are those of every
 * payload label-map entry at exactly that path, whatever its origin or
 * observation class, together with those the stored schema declares there.
 * A `*` segment of `path` names every position of its depth, so a path
 * holding one stores the clauses of each position it matches, a wildcard
 * entry's among them (`pathNames()`). Clauses at other paths, an ancestor's
 * that covers this one among them and a wildcard entry's that covers a path
 * naming a concrete segment in its place, are not touched, and neither are
 * the label-metadata templates that guard the labels themselves.
 *
 * An entry left with no label is dropped; one that keeps integrity stays,
 * with that integrity alone.
 *
 * @throws If `keep` names a clause the path does not store; if `actor` may not
 *   release a clause the plan would remove ({@link clauseReleasableBy}); or if
 *   the stored schema declares a released clause at a position the path names
 *   through a reference or an `allOf`, `anyOf` or `oneOf` branch, where the
 *   declaration may describe other paths too.
 */
export const planConfidentialityRelease = (input: {
  readonly actor: string;
  readonly path: readonly string[];
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
  readonly keep: readonly CfcConfClause[];
}): ConfidentialityReleasePlan => {
  const path = canonicalizeLogicalPath(input.path);
  const location = locationOf(path);
  const schemaEntries = input.schema === undefined
    ? []
    : cfcSchemaEntries(input.schema);
  const stored = clausesStoredAt(
    path,
    input.entries,
    schemaEntries,
    "wildcard",
  );
  for (const clause of input.keep) {
    if (!stored.some((known) => sameClause(known, clause))) {
      throw new Error(
        debugStr`Cannot keep $quote,long${clause} at ${location}: the path ` +
          "stores no such clause. Lowering confidentiality only removes " +
          "clauses; adding one is an update without " +
          "`--dangerously-allow-lowering-confidentiality`.",
      );
    }
  }
  const released = stored.filter((clause) =>
    !input.keep.some((kept) => sameClause(kept, clause))
  );
  for (const clause of released) {
    if (!clauseReleasableBy(clause, input.actor)) {
      throw new Error(
        debugStr`Cannot lower confidentiality at ${location}: ` +
          debugStr`$quote,long${clause} is not ${input.actor}'s alone to ` +
          "release. Only a clause whose every alternative stands for the " +
          "acting principal alone can be removed: the principal as `User`, " +
          "`Context` or `Resource` subject or as its DID, or its own space " +
          "as `Space` or `PersonalSpace`.",
      );
    }
  }
  return planClauseRemoval({
    path,
    location,
    entries: input.entries,
    schema: input.schema,
    schemaEntries,
    released,
    matching: "wildcard",
  });
};

/** One clause stored at a path, as an owner sees it before releasing it. */
export interface StoredClause {
  /** The clause, as stored. */
  readonly clause: CfcConfClause;

  /** Its canonical clause digest, which a release by intent names it by. */
  readonly digest: string;

  /**
   * Where it is stored at the path: each label-map entry holding it, by
   * component (`origin`, `declared` for the stored schema's declaration) and
   * observation class.
   */
  readonly positions: readonly {
    readonly origin: string;
    readonly observes?: string;
  }[];
}

/** A stored payload or schema position, with its label and component. */
interface StoredPosition {
  readonly path: readonly string[];
  readonly label: IFCLabel;
  readonly origin: string;
  readonly observes?: string;
}

/**
 * Every position the payload label map of `entries` and the stored schema's
 * declarations hold a label at, its path canonical, a schema declaration's
 * component being `declared`, with the observation class its `ifc` declares,
 * and an entry with no origin `legacy`.
 */
const storedPositions = (
  entries: readonly LabelMapEntry[],
  schema: JSONSchema | undefined,
): StoredPosition[] => [
  ...entries.map((entry) => ({
    path: canonicalizeLogicalPath(entry.path),
    label: entry.label,
    origin: entry.origin ?? "legacy",
    ...(entry.observes === undefined ? {} : { observes: entry.observes }),
  })),
  ...(schema === undefined ? [] : cfcSchemaEntries(schema)).map((entry) => {
    const observes = declaredObservationClass(entry.schema);
    return {
      path: canonicalizeLogicalPath(entry.path),
      label: entry.label,
      origin: "declared",
      ...(observes === undefined ? {} : { observes }),
    };
  }),
];

/**
 * The confidentiality clauses stored at exactly the stored position `path`,
 * each once with its canonical clause digest and the entries holding it, in
 * the order they are first found: what a release by intent at `path` can
 * name. `path` is matched literally, so `["*"]` names the wildcard position
 * and none of the positions it covers.
 */
export const clausesStoredForRelease = (input: {
  readonly path: readonly string[];
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
}): StoredClause[] => {
  const path = canonicalizeLogicalPath(input.path);
  const found: {
    clause: CfcConfClause;
    digest: string;
    positions: { origin: string; observes?: string }[];
  }[] = [];
  for (const position of storedPositions(input.entries, input.schema)) {
    if (!deepEqual(position.path, path)) continue;
    for (const clause of position.label.confidentiality ?? []) {
      let known = found.find((item) => sameClause(item.clause, clause));
      if (known === undefined) {
        known = {
          clause,
          digest: cfcCanonicalClauseDigest(clause),
          positions: [],
        };
        found.push(known);
      }
      known.positions.push({
        origin: position.origin,
        ...(position.observes === undefined
          ? {}
          : { observes: position.observes }),
      });
    }
  }
  return found;
};

/** A stored position other than the one a release names, and what it holds. */
export interface OtherStoredPosition {
  /** The stored path. */
  readonly path: readonly string[];

  /** The digests, among those asked about, of the clauses stored there. */
  readonly digests: readonly string[];
}

/**
 * Every stored position of the document other than `path` whose label holds
 * a clause one of `digests` names, with the digests it holds, in path order:
 * the further releases by intent it takes for those clauses to be gone from
 * the document, one request per position. The label-metadata templates are
 * not positions here, being derived again from the payload by each release.
 */
export const otherPositionsHolding = (input: {
  readonly path: readonly string[];
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
  readonly digests: readonly string[];
}): OtherStoredPosition[] => {
  const path = canonicalizeLogicalPath(input.path);
  const byPath = new Map<
    string,
    { path: readonly string[]; digests: Set<string> }
  >();
  for (const position of storedPositions(input.entries, input.schema)) {
    if (deepEqual(position.path, path)) continue;
    for (const clause of position.label.confidentiality ?? []) {
      const digest = cfcCanonicalClauseDigest(clause);
      if (!input.digests.includes(digest)) continue;
      const key = JSON.stringify(position.path);
      const known = byPath.get(key) ??
        { path: position.path, digests: new Set<string>() };
      known.digests.add(digest);
      byPath.set(key, known);
    }
  }
  return [...byPath.values()]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map(({ path, digests }) => ({
      path,
      digests: input.digests.filter((digest) => digests.has(digest)),
    }));
};

/**
 * Orders two paths segment by segment, a path before every path it is a
 * proper prefix of.
 */
const comparePaths = (
  left: readonly string[],
  right: readonly string[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return left.length - right.length;
};

/**
 * Plans an owner release by intent (§8.12.7 route 2d): the removal of the
 * clauses stored at `path` whose canonical clause digests
 * `releasedClauseDigests` names, from every payload label-map entry there and
 * from the stored schema's declaration there, and from nothing at any other
 * path. Unlike {@link planConfidentialityRelease}, it asks nothing of who may
 * release a clause: the gate is the owner's signed request, which the caller
 * verifies. `path` names one stored position, matched literally: a `*`
 * segment names the wildcard position there, the class templates and the
 * schema's `items` among it, and reaches none of the concrete positions the
 * wildcard covers, each of which is a release of its own.
 *
 * @throws If a digest names no clause stored at the path, or if the stored
 *   schema declares a released clause through a reference or a branch, as
 *   {@link planConfidentialityRelease} throws.
 */
export const planConfidentialityReleaseByIntent = (input: {
  readonly path: readonly string[];
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
  readonly releasedClauseDigests: readonly string[];
}): ConfidentialityReleasePlan => {
  const path = canonicalizeLogicalPath(input.path);
  const location = locationOf(path);
  const schemaEntries = input.schema === undefined
    ? []
    : cfcSchemaEntries(input.schema);
  const stored = clausesStoredAt(
    path,
    input.entries,
    schemaEntries,
    "literal",
  );
  const released = input.releasedClauseDigests.map((digest) => {
    const clause = stored.find((known) =>
      cfcCanonicalClauseDigest(known) === digest
    );
    if (clause === undefined) {
      throw new Error(
        `Cannot release by intent at ${location}: no clause stored there ` +
          `has the digest \`${digest}\`.`,
      );
    }
    return clause;
  });
  return planClauseRemoval({
    path,
    location,
    entries: input.entries,
    schema: input.schema,
    schemaEntries,
    released,
    matching: "literal",
  });
};

/** The document path an owner's release lowers, and the clauses it keeps. */
export interface CfcConfidentialityReleaseInput {
  /** Space of the document, which must be the acting principal's own. */
  readonly space: MemorySpace;

  /** The document. */
  readonly id: URI;

  /** The document's instance; absent means the space instance. */
  readonly scope?: CellScope;

  /**
   * Payload path whose stored confidentiality is lowered. A `*` segment
   * stands for any segment, so the path names every position it matches at
   * its depth.
   */
  readonly path: readonly string[];

  /**
   * The clauses the path keeps. Every other clause stored at the path is
   * removed.
   */
  readonly keep: readonly CfcConfClause[];
}

/** What one release removed, and digests of the envelope around it. */
export interface CfcConfidentialityRelease {
  /** The acting principal on whose authority the clauses were released. */
  readonly actor: DID;

  /** The stored clauses removed, each once, as stored. */
  readonly released: readonly CfcConfClause[];

  /** The positions a clause was removed at, each once. */
  readonly paths: readonly (readonly string[])[];

  /** The canonical clause digest of each of `.released`, in its order. */
  readonly releasedDigests: readonly string[];

  /** Digest of the canonical envelope before the release. */
  readonly priorEnvelopeDigest: string;

  /**
   * Digest of the canonical envelope after the release; equal to
   * `.priorEnvelopeDigest` when nothing was released.
   */
  readonly envelopeDigest: string;
}

/** The signed request an owner's release by intent carries out. */
export interface CfcConfidentialityReleaseByIntentInput {
  /** The request and its signature, as the owner signed them. */
  readonly signed: SignedOwnerReleaseByIntentRequest;
}

/** What one release by intent removed, and where its record goes. */
export interface CfcConfidentialityReleaseByIntent {
  /** The space's owner, who signed the request. */
  readonly owner: DID;

  /** The stored clauses removed, each once, as stored. */
  readonly released: readonly CfcConfClause[];

  /** The positions a clause was removed at, each once. */
  readonly paths: readonly (readonly string[])[];

  /** The canonical clause digest of each of `.released`, in its order. */
  readonly releasedDigests: readonly string[];

  /** The envelope digest before the release, which the request names. */
  readonly priorEnvelopeDigest: string;

  /** The envelope digest after the release. */
  readonly envelopeDigest: string;

  /** The id the release's record is written at. */
  readonly recordId: string;
}
