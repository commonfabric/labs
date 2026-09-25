import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Cross-space label-metadata representation classes (inv-12 / SC-14 / SC-25;
 * docs/specs/cfc-label-metadata-confidentiality.md §2). At the cross-space
 * persist seam every source-bearing atom field is persisted in one of three
 * forms, per this table:
 *
 * - `public` — verbatim. For fields whose disclosure is the feature and for
 *   non-identifying fields.
 * - `commitment` — the field value is replaced by its unsalted canonical
 *   digest (the shipped `valueDigest` / `evidenceDigest` idiom). Preserves
 *   equality matching; loses dereference and variable-binding pattern
 *   matches. Honestly probe-able (an adversary can hash candidate DIDs and
 *   test).
 * - `reference` — the strong form: an opaque back-reference into the source
 *   space, resolved at evaluation time under the source's read authority;
 *   resolution failure collapses to `notAvailable` (Stage 3).
 *
 * Stage 0 ships the table as data only — the persist transform that consumes
 * it is Stage 1 (`cfcLabelMetadataProtection: off | observe | enforce`).
 * Fields not listed here are unclassified (`undefined`): the Stage 1 dial
 * decides the default posture for them; this module deliberately does not.
 */
export type LabelFieldRepresentationClass =
  | "public"
  | "commitment"
  | "reference";

/**
 * Atom-family selector. CFC atoms come in two shapes: canonical `type`-URI
 * records ({@link CFC_ATOM_TYPE}) and the kind-shaped current-principal claim
 * family (`{ kind: "authored-by" | "represents-principal", subject }`, see
 * `PRINCIPAL_CLAIM_KINDS` in represents-principal.ts).
 */
export type LabelAtomFamily =
  | { readonly type: string }
  | { readonly kind: string };

export type LabelFieldClassificationEntry = {
  readonly family: LabelAtomFamily;

  /**
   * Path of the classified field inside the atom, e.g. `["source"]` or
   * `["identity", "sourceFile"]`. Family-scoped: a Caveat's `source` is
   * classified wherever the Caveat atom appears, including nested inside
   * other atoms — the Stage 1 transform consults the table per atom as it
   * walks, so nesting needs no extra rows.
   */
  readonly field: readonly string[];

  readonly class: LabelFieldRepresentationClass;
};

const entry = (
  family: LabelAtomFamily,
  field: readonly string[],
  cls: LabelFieldRepresentationClass,
): LabelFieldClassificationEntry =>
  Object.freeze({
    family: Object.freeze(family),
    field: Object.freeze([...field]),
    class: cls,
  });

/**
 * The design §2 initial-assignment table, one entry per classified field.
 * Rationales quoted from the design doc; revisable per family.
 */
export const LABEL_FIELD_CLASSIFICATION:
  readonly LabelFieldClassificationEntry[] = Object.freeze([
    // "Caveat.source, nested caveat sources → commitment — consumed by
    // equality-shaped evidence binding; the audit's named leak."
    entry({ type: CFC_ATOM_TYPE.Caveat }, ["source"], "commitment"),
    // "User.subject / PersonalSpace.owner in confidentiality clauses →
    // commitment — gating is pure equality against the acting reader."
    entry({ type: CFC_ATOM_TYPE.User }, ["subject"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.PersonalSpace }, ["owner"], "commitment"),
    // "Space.id in clauses → public (initially) — §4.9.3 must dereference it
    // for the ACL point query; a commitment breaks membership-based release.
    // Space DIDs identify a *container*, not a person; revisit under
    // `reference` when cross-space resolution ships." (The SC-25 recorded
    // initial-assignment exception.)
    entry({ type: CFC_ATOM_TYPE.Space }, ["id"], "public"),
    // Policy/Context refs (B2b label-carried selection): `name`/`hash` →
    // public — selection must DEREFERENCE them against the deployment
    // snapshot at the destination (the Space.id argument); both identify a
    // deployment policy profile, not a person, and `hash` is already a
    // content digest. `subject` → commitment — a DID, equality-consumed at
    // selection (same posture as User.subject); rules binding a variable
    // FROM a commitment-form subject fail closed at the destination, which
    // is the narrow direction.
    entry({ type: CFC_ATOM_TYPE.Policy }, ["name"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["hash"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["policyRefKind"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["moduleIdentity"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["symbol"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["policyDigest"], "public"),
    entry({ type: CFC_ATOM_TYPE.Policy }, ["subject"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.Context }, ["name"], "public"),
    entry({ type: CFC_ATOM_TYPE.Context }, ["hash"], "public"),
    entry({ type: CFC_ATOM_TYPE.Context }, ["subject"], "commitment"),
    // "LinkReference.source/target → commitment — display/provenance only;
    // nothing dereferences the persisted copy."
    entry({ type: CFC_ATOM_TYPE.LinkReference }, ["source"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.LinkReference }, ["target"], "commitment"),
    // "TransformedBy.identity.sourceFile/bindingPath → commitment —
    // human-readable code layout is the leak; trust statements should bind
    // the content-addressed moduleIdentity (public) instead."
    entry(
      { type: CFC_ATOM_TYPE.TransformedBy },
      ["identity", "sourceFile"],
      "commitment",
    ),
    entry(
      { type: CFC_ATOM_TYPE.TransformedBy },
      ["identity", "bindingPath"],
      "commitment",
    ),
    entry(
      { type: CFC_ATOM_TYPE.TransformedBy },
      ["identity", "moduleIdentity"],
      "public",
    ),
    // "authored-by / represents-principal .subject → public —
    // product-displayed attribution, minted under the acting principal's own
    // authority."
    entry({ kind: "authored-by" }, ["subject"], "public"),
    entry({ kind: "represents-principal" }, ["subject"], "public"),
    // "HasRole / UserSurfaceInput.user / ExternalIngest.audience →
    // commitment — evidence families; equality-consumed." HasRole's
    // DID-bearing fields are `principal` and `space` (CfcHasRoleAtom).
    entry({ type: CFC_ATOM_TYPE.HasRole }, ["principal"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.HasRole }, ["space"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.UserSurfaceInput }, ["user"], "commitment"),
    entry({ type: CFC_ATOM_TYPE.ExternalIngest }, ["audience"], "commitment"),
  ]);

const familyKey = (family: LabelAtomFamily): string | undefined =>
  "type" in family && typeof family.type === "string"
    ? `type:${family.type}`
    : "kind" in family && typeof family.kind === "string"
    ? `kind:${family.kind}`
    : undefined;

const lookupKey = (family: LabelAtomFamily, field: readonly string[]) => {
  const key = familyKey(family);
  return key === undefined ? undefined : `${key}\u0000${field.join("\u0000")}`;
};

const CLASSIFICATION_BY_KEY: ReadonlyMap<
  string,
  LabelFieldRepresentationClass
> = new Map(
  LABEL_FIELD_CLASSIFICATION.map(
    (row) => [lookupKey(row.family, row.field)!, row.class],
  ),
);

/**
 * Kind-shaped families the table actually classifies. Used by the Stage 1
 * transform's walk to decide whether a `kind`-bearing record (with no `type`)
 * is a claim-family ATOM (resets the classification context) or an ordinary
 * nested record that merely happens to carry a `kind` field — e.g. the
 * `ImplementationIdentity` record inside `TransformedBy.identity`, whose
 * `kind: "verified"` is a variant discriminator, not an atom family. Only a
 * table-classified kind resets context; everything else extends the current
 * atom's field path so multi-segment rows keep resolving.
 */
export const CLASSIFIED_KIND_FAMILIES: ReadonlySet<string> = new Set(
  LABEL_FIELD_CLASSIFICATION.flatMap((row) =>
    "kind" in row.family && typeof row.family.kind === "string"
      ? [row.family.kind]
      : []
  ),
);

/**
 * Representation class for one atom field, or `undefined` when the
 * (family, field) pair is not in the table.
 */
export const classifyLabelField = (
  family: LabelAtomFamily,
  field: readonly string[],
): LabelFieldRepresentationClass | undefined => {
  const key = lookupKey(family, field);
  return key === undefined ? undefined : CLASSIFICATION_BY_KEY.get(key);
};

/**
 * Convenience form of {@link classifyLabelField} that derives the family
 * from an atom value: a record with a string `type` selects the type-URI
 * family; otherwise a record with a string `kind` selects the kind-shaped
 * claim family (type-bearing atoms like Caveat also have a `kind` field, so
 * `type` wins). Non-record atoms (string atoms et al.) have no classified
 * fields.
 */
export const classifyAtomField = (
  atom: unknown,
  field: readonly string[],
): LabelFieldRepresentationClass | undefined => {
  if (!isObjectOrArray(atom)) {
    return undefined;
  }
  if (typeof atom.type === "string") {
    return classifyLabelField({ type: atom.type }, field);
  }
  if (typeof atom.kind === "string") {
    return classifyLabelField({ kind: atom.kind }, field);
  }
  return undefined;
};
