/**
 * Reading the CFC envelope a document stores at its reserved `["cfc"]`
 * member. `docs/specs/cfc-stored-envelope.md` states the rule every reader
 * here keeps and what each consumer owes it: a document whose stored
 * envelope this build cannot interpret is never read as an unlabeled
 * document.
 *
 * {@link interpretStoredEnvelope} is the one place that decides which of the
 * three outcomes a stored value gets — an envelope, nothing stored, or a
 * {@link StoredCfcMetadataError} — and every entry point below goes through
 * it, including the prepare pass's `storedMetadataFor`, so two readers
 * cannot differ over the same stored value.
 */

import { isDeepFrozen } from "@commonfabric/data-model";
import type { URI } from "@commonfabric/memory/interface";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { CellScope } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
  MemorySpace,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { normalizeCellScope } from "../scope.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import {
  cfcLabelDocumentHash,
  isCfcLabelDocumentContent,
  isCfcLabelReference,
  isStoredLabelMapEntry,
  lookupCfcLabelDocument,
  parseCfcLabelReference,
  registerCfcLabelDocument,
} from "./label-documents.ts";
import { isLabelMetadataTemplateEntry } from "./label-metadata-population.ts";
import { confidentialityOnly, type IFCLabel } from "./label-view-core.ts";
import { readConsumesEntry } from "./observation-classes.ts";
import type {
  CfcMetadata,
  LabelMapEntry,
  StoredCfcMetadata,
  StoredLabelMapEntry,
} from "./types.ts";

/**
 * How a reader marks its read of the reserved position and of the label
 * documents a version-2 envelope names. Both are the runtime resolving a
 * label rather than the caller consuming content, so both carry
 * `internalVerifierRead`; a reader that additionally hides its reads from
 * reactivity passes its own policy (the prepare pass does, see
 * `prepare.ts`).
 */
export type StoredCfcReadPolicy = Parameters<
  IExtendedStorageTransaction["readOrThrow"]
>[1];

/**
 * The policy of a reader whose caller depends on the envelope it reads:
 * marked as a verifier read, and visible to reactivity, so a writer
 * re-runs when the envelope it read changes.
 */
const DEPENDENT_READ: StoredCfcReadPolicy = { meta: internalVerifierRead };

/** A document whose reserved `["cfc"]` position a reader below reaches. */
export type StoredCfcTarget = {
  space: MemorySpace;
  id: string;
  scope?: NormalizedFullLink["scope"];
  type?: MediaType;
};

const isPrefix = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length <= right.length &&
  left.every((segment, index) => segment === right[index]);

/**
 * An error a reader of a stored envelope throws to fail CLOSED: the envelope
 * is present and its labels cannot be produced, so the document is not an
 * unlabeled one. Every consumer that swallows other read failures rethrows
 * this class — treating the envelope as absent would read a labeled document
 * as unlabeled, which is exactly the failure each subclass exists to
 * prevent.
 */
export abstract class StoredCfcMetadataError extends Error {}

/**
 * A stored envelope whose `version` this build does not understand. The
 * labels cannot be interpreted, so every consumer fails CLOSED on this
 * error — treating the envelope as absent would read a labeled document
 * as unlabeled, which is exactly the failure a format version exists to
 * prevent.
 */
export class UnknownCfcMetadataVersionError extends StoredCfcMetadataError {
  constructor(version: unknown) {
    super(
      `stored CFC metadata version ${
        JSON.stringify(version)
      } is not one this build interprets`,
    );
    this.name = "UnknownCfcMetadataVersionError";
  }
}

// Typed against the metadata's own version union, so growing the list
// without growing `CfcMetadataVersion` (or the reverse) is a compile error —
// the predicate below narrows to `StoredCfcMetadata` on the strength of this
// list.
const KNOWN_CFC_METADATA_VERSIONS: readonly StoredCfcMetadata["version"][] = [
  1,
  2,
];

/** Whether `value` is an envelope `version` this build interprets. */
export const isKnownCfcMetadataVersion = (
  value: unknown,
): value is StoredCfcMetadata["version"] =>
  KNOWN_CFC_METADATA_VERSIONS.some((version) => version === value);

/**
 * A stored envelope at the reserved position that carries no label map this
 * build can walk. The labels cannot be read, so a consumer that resolves
 * labels fails CLOSED on this error: a document whose envelope is present but
 * unreadable is not an unlabeled document.
 */
export class UnreadableCfcMetadataError extends StoredCfcMetadataError {
  constructor(id: string) {
    super(
      `stored CFC metadata for ${id} carries no label map this build can read`,
    );
    this.name = "UnreadableCfcMetadataError";
  }
}

/**
 * A version-2 envelope naming a label document that neither the space nor
 * the realm's label registry can back with label-shaped content verifying
 * against its id, or naming one outside the `cid:` namespace. The label
 * cannot be produced, so every consumer fails CLOSED on this error, as on
 * an unknown version. Recoverable in principle — the document may arrive
 * by sync — so the failure is never memoized.
 */
export class UnresolvableCfcLabelDocumentError extends StoredCfcMetadataError {
  constructor(readonly reference: string, readonly reason: string) {
    super(
      `stored CFC label reference \`${reference}\` cannot be resolved: ${reason}`,
    );
    this.name = "UnresolvableCfcLabelDocumentError";
  }
}

/**
 * Whether a value at a document's reserved metadata position leaves the
 * document carrying a label map. The reserved position is what qualifies a
 * value, never its field names: a future format may rename every field
 * except the version, and requiring today's members would read exactly
 * those envelopes as unlabeled. So anything a document stores there
 * presents a label map, and only `null` and the scalars — the values
 * {@link interpretStoredEnvelope} reports as nothing stored — leave the
 * document carrying none.
 */
export const cfcMetadataPresent = (value: unknown): boolean =>
  isObjectOrArray(value);

/**
 * What reading a label needs of a stored entry beyond the envelope's being
 * one: a path a resolution matches against, and a label a consumer reads
 * clauses out of. The envelope's version decides whether a reference is a
 * label — version 1 does not define that spelling, and one read as a label
 * would drop the policy it names.
 *
 * A label carrying a member this build does not know is not readable
 * either. Every label this build writes carries `confidentiality` and
 * `integrity` alone, so a third member is a format this build postdates,
 * and reading the two it knows would silently drop whatever the third
 * carries.
 */
const isReadableStoredEntry = (
  version: StoredCfcMetadata["version"],
  entry: unknown,
): boolean =>
  isStoredLabelMapEntry(entry) &&
  (version === 2 || !isCfcLabelReference(entry.label));

/**
 * Whether `value` is a stored envelope this build can produce labels from:
 * a version it interprets, a `schemaHash` naming the schema its labels were
 * derived against (spec §4.6.4), a label map of the one map version there
 * is, and every entry one {@link isReadableStoredEntry} admits at the
 * envelope's version. The narrowing is to `StoredCfcMetadata`, which
 * declares every one of those, so checking every one is what keeps the
 * narrowing honest.
 *
 * A member beyond those does not make an envelope unreadable. The version
 * is how the format announces that it carries something this build does not
 * read, and the spec leaves a migrating writer free to keep a legacy field
 * beside the ones it defines (spec §4.6.4, operational guidance).
 */
const isCfcMetadata = (value: unknown): value is StoredCfcMetadata => {
  if (!isObjectNotArray(value)) return false;
  const version = value.version;
  if (!isKnownCfcMetadataVersion(version)) return false;
  if (typeof value.schemaHash !== "string") return false;
  const labelMap = value.labelMap;
  if (!isObjectNotArray(labelMap) || labelMap.version !== 1) return false;
  const entries = labelMap.entries;
  return Array.isArray(entries) &&
    entries.every((entry) => isReadableStoredEntry(version, entry));
};

/**
 * The envelopes `interpretStoredEnvelope()` has found interpretable, by
 * identity, so that reading the labels at one address does not check every
 * entry of the document's label map again. Only a deep-frozen envelope is
 * held, since one that cannot change interprets the same every time.
 */
const interpretedEnvelopes = new WeakMap<object, StoredCfcMetadata>();

/**
 * The stored envelope `value` holds, or `undefined` when the reserved
 * position of document `id` holds nothing. Throws a
 * {@link StoredCfcMetadataError} for everything else.
 *
 * This is the whole of the rule: a value at the reserved position is an
 * envelope this build interprets, or it is nothing stored, or it fails
 * closed. Callers resolve the labels afterwards; nothing else classifies.
 */
const interpretStoredEnvelope = (
  id: string,
  value: unknown,
): StoredCfcMetadata | undefined => {
  if (!cfcMetadataPresent(value)) return undefined;
  if (isObjectNotArray(value)) {
    const interpreted = interpretedEnvelopes.get(value);
    if (interpreted !== undefined) return interpreted;
  }
  if (
    isObjectNotArray(value) && "version" in value &&
    !isKnownCfcMetadataVersion(value.version)
  ) {
    throw new UnknownCfcMetadataVersionError(value.version);
  }
  if (!isCfcMetadata(value)) throw new UnreadableCfcMetadataError(id);
  if (isDeepFrozen(value)) interpretedEnvelopes.set(value, value);
  return value;
};

/**
 * The envelope stored for `target`, labels unresolved, or `undefined` when
 * the document stores none. Throws a {@link StoredCfcMetadataError} for a
 * value {@link interpretStoredEnvelope} cannot interpret.
 *
 * The read is AT `["cfc"]`, never the whole document: it is scoped to what
 * the reader CONSUMES, and it is what reactivity re-runs on. A path-`[]`
 * recursive read made the whole document a value dependency, so a
 * concurrent, metadata-irrelevant value write between the reader's
 * confirmed basis and the server head conflicted the commit — for a blind
 * UI-input fill during its own echo's arrival window (the client's
 * confirmed basis lags exactly then), that killed the user's typed input
 * as a stale-confirmed-read conflict the moment the §6 layer-naming half
 * was fixed (verification-coverage.md OW47's re-close; the name-draft
 * triage's arm (c), the path half of the ruled arm (b)).
 */
const readStoredEnvelope = (
  tx: IExtendedStorageTransaction,
  target: StoredCfcTarget,
  policy: StoredCfcReadPolicy,
): StoredCfcMetadata | undefined =>
  interpretStoredEnvelope(
    target.id,
    tx.readOrThrow({
      space: target.space,
      id: target.id as URI,
      scope: normalizeCellScope(target.scope),
      type: target.type ?? "application/json",
      path: ["cfc"],
    }, policy),
  );

// Resolved entries by the identity of the stored `labelMap` they came
// from. Content addressing makes a resolution permanent for the bytes it
// was computed from — every referenced label verified against its id — so
// the memo can only ever hold the one answer, and a failure never enters
// it. Only the label map is memoized: the envelope around it is rebuilt
// per call from the stored envelope at hand, so a rewrite that shares the
// `labelMap` subtree by reference cannot serve a stale `schemaHash`. A
// version-1 map is memoized only once frozen, since nothing else fixes it.
const decodedLabelMaps = new WeakMap<object, CfcMetadata["labelMap"]>();

/**
 * Decodes a stored label map's one list into the payload entries and the
 * document-rooted label-metadata templates (spec §4.6.4), so that no lookup
 * over `entries` can match a template. A list holding no template is kept
 * as it stands.
 */
const decodeLabelMap = (
  entries: LabelMapEntry[],
): CfcMetadata["labelMap"] =>
  entries.some(isLabelMetadataTemplateEntry)
    ? {
      version: 1,
      entries: entries.filter((entry) => !isLabelMetadataTemplateEntry(entry)),
      documentEntries: entries.filter(isLabelMetadataTemplateEntry),
    }
    : { version: 1, entries };

/**
 * Helper for {@link resolveStoredCfcMetadata}, which produces the label a
 * stored entry holds: the entry's own label when inline, else the content
 * of the label document it references. The document is read at space
 * scope through `tx` (a `cid:` document lives at space scope only), its
 * content verified against its id, and the verified label registered so
 * the realm resolves it without the read; a document the replica does not
 * hold resolves through the registry, whose entries were verified at
 * registration. Anything else throws
 * {@link UnresolvableCfcLabelDocumentError}.
 */
const resolveStoredLabel = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: StoredLabelMapEntry,
  policy: StoredCfcReadPolicy,
): IFCLabel => {
  if (!isCfcLabelReference(entry.label)) return entry.label;
  const hash = parseCfcLabelReference(entry.label);
  if (hash === undefined) {
    throw new UnresolvableCfcLabelDocumentError(
      entry.label.$ref,
      "the reference is outside the cid: namespace",
    );
  }
  let stored: unknown;
  try {
    stored = tx.readOrThrow({
      space,
      id: `cid:${hash}` as URI,
      type: "application/json",
      path: [],
    }, policy);
  } catch (error) {
    // A read that fails outright — a closed transaction, a refusal — is
    // still a label that could not be produced, and a consumer that
    // swallows other read failures must fail closed on this one, so it
    // arrives as the fail-closed error rather than as its own class.
    throw new UnresolvableCfcLabelDocumentError(
      entry.label.$ref,
      `the label document could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const content = isObjectOrArray(stored) ? stored.value : undefined;
  if (content === undefined) {
    const registered = lookupCfcLabelDocument(hash);
    if (registered !== undefined) return registered;
    throw new UnresolvableCfcLabelDocumentError(
      entry.label.$ref,
      "the label document is neither stored in the space nor registered",
    );
  }
  // Shape before hash: a record that hashes to the id but is not
  // label-shaped would register as a label whose members a consumer reads
  // as empty, which is the one reading a stored envelope must never get.
  if (!isCfcLabelDocumentContent(content)) {
    throw new UnresolvableCfcLabelDocumentError(
      entry.label.$ref,
      "the stored document does not hold a label",
    );
  }
  const actual = cfcLabelDocumentHash(content);
  if (actual !== hash) {
    throw new UnresolvableCfcLabelDocumentError(
      entry.label.$ref,
      `the stored content hashes to \`${actual}\``,
    );
  }
  return registerCfcLabelDocument(hash, content);
};

/**
 * The resolved form of `stored`: every label inline, whichever version it
 * was stored as. A version-1 envelope already is that form. A version-2
 * envelope resolves each referenced label through `tx` in `space`, under
 * `policy`, throwing {@link UnresolvableCfcLabelDocumentError} for a
 * reference nothing can back — fail closed, never a partially resolved
 * envelope. The result is memoized by the stored `labelMap`'s identity, so
 * a document read many times in a session resolves once.
 *
 * Takes an envelope {@link interpretStoredEnvelope} has classified, so
 * every entry is one a label can be produced from.
 */
const resolveStoredCfcMetadata = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  stored: StoredCfcMetadata,
  policy: StoredCfcReadPolicy,
): CfcMetadata => {
  if (stored.version === 1) {
    let labelMap = decodedLabelMaps.get(stored.labelMap);
    if (labelMap === undefined) {
      labelMap = decodeLabelMap(stored.labelMap.entries);
      if (isDeepFrozen(stored.labelMap)) {
        decodedLabelMaps.set(stored.labelMap, labelMap);
      }
    }
    return labelMap.documentEntries === undefined
      ? stored
      : { version: 1, schemaHash: stored.schemaHash, labelMap };
  }
  let labelMap = decodedLabelMaps.get(stored.labelMap);
  if (labelMap === undefined) {
    labelMap = decodeLabelMap(
      stored.labelMap.entries.map((entry) => ({
        ...entry,
        label: resolveStoredLabel(tx, space, entry, policy),
      })),
    );
    decodedLabelMaps.set(stored.labelMap, labelMap);
  }
  return {
    version: stored.version,
    schemaHash: stored.schemaHash,
    labelMap,
  };
};

/**
 * The path and origin of each payload entry a stored envelope holds, read
 * without resolving any label: both are inline in every version, so a
 * consumer that asks only where policy applies pays no label-document read.
 * The document-rooted label-metadata templates are left out, as decoding
 * leaves them out of a resolved envelope's entries. Fails closed exactly as
 * the resolving reader does, and returns `undefined` for a document storing
 * no envelope.
 */
const readStoredCfcLabelPaths = (
  tx: IExtendedStorageTransaction,
  target: StoredCfcTarget,
): readonly Pick<StoredLabelMapEntry, "path" | "origin">[] | undefined =>
  readStoredEnvelope(tx, target, DEPENDENT_READ)?.labelMap.entries.filter(
    (entry) => !isLabelMetadataTemplateEntry(entry),
  );

/**
 * The resolved envelope stored for `target`, or `undefined` when the
 * document stores none. Throws a {@link StoredCfcMetadataError} for an
 * envelope this build cannot produce labels from — an unknown version, a
 * label map it cannot walk, or a label document nothing backs — so a
 * consumer never reads a labeled document as unlabeled.
 *
 * `policy` marks the reads this makes. It defaults to the policy of a
 * caller that depends on the envelope; the prepare pass passes its own.
 */
export const readStoredCfcMetadata = (
  tx: IExtendedStorageTransaction,
  target: StoredCfcTarget,
  policy: StoredCfcReadPolicy = DEPENDENT_READ,
): CfcMetadata | undefined => {
  const stored = readStoredEnvelope(tx, target, policy);
  return stored === undefined
    ? undefined
    : resolveStoredCfcMetadata(tx, target.space, stored, policy);
};

/** The labels {@link readStoredCfcLabelsForReader} answers with. */
export type StoredCfcLabels = Pick<CfcMetadata, "labelMap">;

/**
 * The instances of a document broader than an instance of each scope: a user
 * instance's space instance, and a session instance's user and space ones.
 */
const BROADER_SCOPES: Readonly<Record<CellScope, readonly CellScope[]>> = {
  space: [],
  user: ["space"],
  session: ["user", "space"],
};

/**
 * What a broader instance's `entry` restricts for a reader of the narrower
 * instance's content: nothing where a value read does not consume the entry,
 * else the entry with its confidentiality alone.
 */
const readerRestrictionOfEntry = (entry: LabelMapEntry): LabelMapEntry[] => {
  if (!readConsumesEntry("value", entry)) return [];
  const label = confidentialityOnly(entry.label);
  return label === undefined ? [] : [{ ...entry, label }];
};

/**
 * The labels a reader of `target`'s instance answers to: the envelope that
 * instance stores, joined with the confidentiality a value read of each
 * broader instance of the same document consumes. `undefined` where none of
 * them stores a label.
 *
 * The space, user and session instances of one id are instances of one cell
 * (`docs/specs/scoped-cell-instances.md`), each holding a value and an
 * envelope of its own, and a narrower instance's content is reached through
 * the broader instance's slot. Reading it needs both authorizations: the
 * reader must meet the broader instance's confidentiality as well as the
 * narrower one's, the conjunction CFC asks of per-user content reached
 * through a shared slot (§4.9.4). A reader that holds the narrower instance
 * directly therefore answers to the broader instance's confidentiality too.
 * That also covers an instance a narrowed write left before such writes
 * stamped the instance's own envelope, which stores none of the labels its
 * slot's schema declares.
 *
 * From each broader instance, the entries a value read consumes are joined:
 * covering entries and the content classes, declared and derived alike, since
 * the broader instance can hold a stamp the narrower one lacks, such as the
 * flow stamp of the whole value a writer set. An entry for the pointer the
 * broader slot holds (a `followRef` entry, a link-origin one included) is left
 * out. It copies the labels of the instance the redirect's writer narrowed
 * into, and every user's redirect is that one stored link, so it speaks for
 * whichever user's write stored it, not for this instance's content, whose
 * labels its own envelope and the joined declared entries carry. A read that
 * resolves the redirect does measure that pointer, so it can refuse what a
 * read of this instance admits; that over-taint predates this rule.
 *
 * Integrity is the instance's own. It speaks for whoever wrote the value, and
 * whoever wrote the broader instance did not write this one: a claim stored
 * there would otherwise vouch for a later, less trusted write here.
 *
 * Paths line up across the instances, since narrowed content sits at the path
 * of the slot that redirects to it. Each envelope is read as
 * {@link readStoredCfcMetadata} reads it, so one this build cannot interpret,
 * on any of the instances, fails the read. A space-scoped target answers with
 * its own envelope, unchanged. This is a reader's answer, not an envelope:
 * what merges into or rewrites an instance's envelope reads that envelope
 * alone, through {@link readStoredCfcMetadata}. The readers that answer to it
 * are the cell label views and the runtime read ceiling; the flow join reads
 * an instance's own envelope.
 */
export const readStoredCfcLabelsForReader = (
  tx: IExtendedStorageTransaction,
  target: StoredCfcTarget,
): StoredCfcLabels | undefined => {
  const own = readStoredCfcMetadata(tx, target);
  const broader = BROADER_SCOPES[normalizeCellScope(target.scope)].flatMap(
    (scope) =>
      readStoredCfcMetadata(tx, { ...target, scope })?.labelMap.entries
        .flatMap(readerRestrictionOfEntry) ?? [],
  );
  if (broader.length === 0) return own;
  return {
    labelMap: {
      ...own?.labelMap,
      version: 1,
      entries: [...(own?.labelMap.entries ?? []), ...broader],
    },
  };
};

/**
 * Whether the envelope stored for `target`'s document holds an entry at,
 * above, or below `target.path`, which marks the path as one policy applies
 * to. An envelope this build cannot read answers that it does.
 *
 * A link write passes `replacingLink`: the link-origin entries at and below
 * the slot it writes then do not count. Each labels the pointer the slot
 * holds now, which the write replaces, and the commit drops it with that
 * pointer, so it describes the element leaving the slot rather than a policy
 * of the position, and a list rewrite may move an unlabeled element into a
 * position a labeled one left. Every other entry still counts: a declared
 * label, a flow-derived one, and a link-origin entry above the slot.
 */
export const storedCfcMetadataAppliesToPath = (
  tx: IExtendedStorageTransaction,
  target: Pick<NormalizedFullLink, "space" | "id" | "scope" | "path">,
  { replacingLink = false }: { replacingLink?: boolean } = {},
): boolean => {
  let entries:
    | readonly Pick<StoredLabelMapEntry, "path" | "origin">[]
    | undefined;
  try {
    entries = readStoredCfcLabelPaths(tx, target);
  } catch (error) {
    // An envelope this build cannot produce labels from still marks the
    // document as policy-carrying: "applies" is the fail-closed answer, and
    // the write it gates then reaches the same unreadable envelope at
    // prepare time.
    if (error instanceof StoredCfcMetadataError) return true;
    throw error;
  }
  if (entries === undefined) {
    return false;
  }
  const logicalPath = canonicalizeLogicalPath(target.path);
  const paths = entries
    .filter((entry) =>
      !(replacingLink && entry.origin === "link" &&
        isPrefix(logicalPath, entry.path))
    )
    .map((entry) => entry.path);
  // labelMap entries are persisted both for paths with confidentiality /
  // integrity values AND for paths whose schema carried a policy claim
  // (writeAuthorizedBy / writePolicyAnyOf / uiContract / exactCopyOf — see
  // `derivePersistedLabel` and the persistence guard in `prepare.ts`). The
  // mere presence of an entry signals "policy applies on this path"; do NOT
  // filter on `hasLabelValues` here, or claim-only entries get silently
  // bypassed.
  return paths.some((path) =>
    isPrefix(path, logicalPath) || isPrefix(logicalPath, path)
  );
};
