/**
 * Decides an owner release (spec §8.12.7 route 2c) of the confidentiality
 * stored at one path of a document: which stored clauses go, whether the
 * acting principal may release each of them, and what the document's label
 * map and stored schema hold once they are gone. Pure: the transaction method
 * that persists a release reads the stored envelope, calls
 * {@link planConfidentialityRelease}, and writes the result.
 *
 * The route reaches every component at the path — declared, derived (`shape`
 * and `value` entries alike, the existence entry §8.12.8 otherwise freezes),
 * and link-carried — and nothing at any other path.
 */

import { debugStr } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity/did";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { CellScope, JSONSchema } from "../builder/types.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import {
  type CfcConfClause,
  clauseAlternatives,
  normalizeClause,
} from "./clause.ts";
import { isActorOwnedAlternative } from "./host-review.ts";
import { classifyAtomField } from "./label-field-classification.ts";
import {
  commitmentAwareEquals,
  isCfcFieldCommitment,
} from "./label-representation.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";
import type { IFCLabel, LabelMapEntry } from "./types.ts";

/** Builtin implementation identity that alone writes confidentiality releases. */
export const CONFIDENTIALITY_RELEASE_WRITER = "cfc-confidentiality-release";

/** What a document holds once a release removes clauses at one path. */
export interface ConfidentialityReleasePlan {
  /** The stored clauses the release removes, each once, as stored. */
  readonly released: readonly CfcConfClause[];

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
 * `atom` with each commitment-classified field that holds a digest
 * commitment to `actor`'s DID written as that DID, and every other field as
 * stored. A label crossing a space boundary stores such a field — a `User`'s
 * subject, a `PersonalSpace`'s owner — as its commitment (§4.6.4.1); a field
 * the representation table keeps public, such as a `Space`'s id, never holds
 * one, so a commitment there is left as it is and matches no one.
 */
const openActorCommitments = (atom: CfcConfClause, actor: string) =>
  isObjectNotArray(atom)
    ? Object.fromEntries(
      Object.entries(atom).map(([key, value]) => [
        key,
        classifyAtomField(atom, [key]) === "commitment" &&
          isCfcFieldCommitment(value) && commitmentAwareEquals(value, actor)
          ? actor
          : value,
      ]),
    )
    : atom;

/**
 * Whether `actor` may release `clause` on their own authority, the
 * specification's `canReleaseStoredClause` (§8.12.7): every alternative
 * stands for `actor` alone in the sense the trusted host's reviewed
 * operations share (`isActorOwnedAlternative()`, the specification's
 * `standsForActor`) — `actor` as
 * `User`, `Context` or `Resource` subject or as the bare DID, or the space
 * whose DID is `actor`'s as `Space` or `PersonalSpace`, whose access list
 * `actor` writes — with a digest commitment to `actor`'s DID read as the DID.
 * Releasing such a clause is choosing the audience of their own content
 * (§3.1.8). A clause with any other alternative — another principal, another
 * space, a policy principal, an `Expires` or a `Caveat` — is not theirs alone
 * to release.
 */
export const clauseReleasableBy = (
  clause: CfcConfClause,
  actor: string,
): boolean => {
  const alternatives = clauseAlternatives(clause);
  return alternatives.length > 0 &&
    alternatives.every((alternative) =>
      isActorOwnedAlternative(openActorCommitments(alternative, actor), actor)
    );
};

/**
 * Helper for {@link planConfidentialityRelease}, which returns `schema` with
 * the clauses `released` selects taken out of the `ifc` at `path`, reached
 * through `properties` alone. An `ifc` left declaring nothing goes, and an
 * `observes` class with no label beside it goes with it. Returns `undefined`
 * where `path` leads through anything else, such as a reference or a
 * branch.
 */
const lowerSchemaAt = (
  schema: JSONSchema,
  path: readonly string[],
  released: (clause: CfcConfClause) => boolean,
): JSONSchema | undefined => {
  if (!isObjectNotArray(schema) || schema.$ref !== undefined) return undefined;
  if (path.length > 0) {
    const [head, ...rest] = path;
    const properties = schema.properties;
    if (!isObjectNotArray(properties) || !Object.hasOwn(properties, head)) {
      return undefined;
    }
    const child = lowerSchemaAt(properties[head], rest, released);
    return child === undefined
      ? undefined
      : { ...schema, properties: { ...properties, [head]: child } };
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
 * Plans the release of every confidentiality clause stored at `path` that
 * `keep` does not name: the decision of the specification's `ownerReleaseAt`
 * (§8.12.7), less the home-space check its caller makes. The clauses stored at a path are those of every
 * payload label-map entry at exactly that path, whatever its origin or
 * observation class, together with those the stored schema declares there.
 * Clauses at other paths, an ancestor's that covers this one among them, are
 * not touched, and neither are the label-metadata templates that guard the
 * labels themselves.
 *
 * An entry left with no label is dropped; one that keeps integrity stays,
 * with that integrity alone.
 *
 * @throws If `keep` names a clause the path does not store; if `actor` may not
 *   release a clause the plan would remove ({@link clauseReleasableBy}); or if
 *   the stored schema declares a released clause other than through
 *   `properties`, where the position may describe other paths too.
 */
export const planConfidentialityRelease = (input: {
  readonly actor: string;
  readonly path: readonly string[];
  readonly entries: readonly LabelMapEntry[];
  readonly schema: JSONSchema | undefined;
  readonly keep: readonly CfcConfClause[];
}): ConfidentialityReleasePlan => {
  const path = canonicalizeLogicalPath(input.path);
  const location = path.length === 0 ? "<root>" : path.join("/");
  const atPath = (entryPath: readonly string[]) =>
    deepEqual(canonicalizeLogicalPath(entryPath), path);
  const schemaEntries = input.schema === undefined
    ? []
    : cfcSchemaEntries(input.schema);
  const stored: CfcConfClause[] = [];
  for (
    const clause of [...input.entries, ...schemaEntries]
      .filter((entry) => atPath(entry.path))
      .flatMap((entry) => entry.label.confidentiality ?? [])
  ) {
    if (!stored.some((known) => sameClause(known, clause))) {
      stored.push(clause);
    }
  }
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
  if (released.length === 0) {
    return { released, entries: input.entries, schema: input.schema };
  }
  const isReleased = (clause: CfcConfClause) =>
    released.some((gone) => sameClause(gone, clause));
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
    return { released, entries, schema: input.schema };
  }
  // The walk reaches the declaration through `properties` alone, and what it
  // changed is then held to what it was meant to change: every declaration
  // the schema makes, with the released clauses gone from this path and
  // nothing else different.
  const schema = lowerSchemaAt(input.schema, path, isReleased);
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
  return { released, entries, schema };
};

/** The document path an owner's release lowers, and the clauses it keeps. */
export interface CfcConfidentialityReleaseInput {
  /** Space of the document, which must be the acting principal's own. */
  readonly space: MemorySpace;

  /** The document. */
  readonly id: URI;

  /** The document's instance; absent means the space instance. */
  readonly scope?: CellScope;

  /** Payload path whose stored confidentiality is lowered. */
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
