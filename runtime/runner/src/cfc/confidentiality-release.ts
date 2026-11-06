/**
 * Lowers the confidentiality stored at one path of a document, for a trusted
 * host acting as the document's owner, by either of the two owner releases of
 * spec §8.12.7. This module is absent from authored pattern imports.
 *
 * An owner release (route 2c) is the CLI's `cf cell set-label
 * --dangerously-allow-lowering-confidentiality`: what may be released, and by
 * whom, is decided by `planConfidentialityRelease()`; this module resolves the
 * cell, writes the release under the release writer's builtin identity, and
 * records it in a receipt only the owner may read.
 *
 * An owner release by intent (route 2d) is the CLI's `cf cell
 * release-by-intent`: it carries out a request the space's owner signed,
 * which names its document and path itself, and commits the release with the
 * record the store judges it by. Nothing here signs: the request arrives
 * signed by the host that holds the owner's key.
 */

import { cfcAtom } from "@commonfabric/api/cfc";
import { debugStr } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  ownerReleaseByIntentEnvelopeDigest,
  ownerReleaseByIntentRecord,
  type SignedOwnerReleaseByIntentRequest,
} from "@commonfabric/memory/v2/cfc-owner-release-by-intent";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import { type Cell, cellRuntime } from "../cell.ts";
import { type LastNode, resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import { DEFAULT_CELL_SCOPE, normalizeCellScope } from "../scope.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";
import {
  type CfcConfidentialityRelease,
  type CfcConfidentialityReleaseByIntent,
  clausesStoredForRelease,
  CONFIDENTIALITY_RELEASE_WRITER,
  OWNER_RELEASE_BY_INTENT_WRITER,
  sameClause,
  type StoredClause,
} from "./confidentiality-release-plan.ts";
import { cfcLabelViewForResolvedCellWithStatus } from "./label-view.ts";
import { mergeCfcLabelViews } from "./label-view-state.ts";
import { loadStoredCfcEnvelope } from "./prepare.ts";
import { cfcLabelViewFromSchema } from "./schema-label-view.ts";

/** What {@link releaseCellConfidentiality} released, and where it says so. */
export interface CellConfidentialityRelease extends CfcConfidentialityRelease {
  /** The receipt recording the release; absent when nothing was released. */
  readonly receipt?: NormalizedFullLink;
}

/** Options for {@link releaseCellConfidentiality}. */
export interface CellConfidentialityReleaseOptions {
  /**
   * Whether the release lowers the labels of a link stored at the path itself,
   * a write redirect included, rather than following a write redirect there to
   * the document it leads to.
   */
  readonly linkSlot?: boolean;
}

/**
 * Helper for {@link releaseCellConfidentiality}, which returns the
 * confidentiality clauses `cell`'s effective label view holds at its own path,
 * the path resolved as `lastNode` says: what `cf cell get-label` shows there,
 * the cell's own schema included, less the labels of the target of a link the
 * resolution stops at, which are that target's own and stored at its path
 * (spec §8.12.8). Read through `cell`'s transaction, so a release in that
 * transaction is seen, and so the commit conflicts with a change to any label
 * the view read.
 *
 * @throws If the labels cannot be read.
 */
const shownConfidentiality = (
  cell: Cell<unknown>,
  lastNode: LastNode,
): CfcConfClause[] => {
  const { view, readFailed } = cfcLabelViewForResolvedCellWithStatus(cell, {
    lastNode,
  });
  if (readFailed) {
    throw new Error(
      "Cannot lower confidentiality: the labels at the path could not be read.",
    );
  }
  return mergeCfcLabelViews([view, cfcLabelViewFromSchema(cell.schema)])
    ?.entries.filter((entry) => entry.path.length === 0)
    .flatMap((entry) => entry.label.confidentiality ?? []) ?? [];
};

/**
 * Removes every confidentiality clause stored at `cell`'s path that `keep`
 * does not name, from every component of the label there — declared, derived
 * `shape` and `value` entries, link-carried — and from the stored schema, in
 * the document the path lands in once its links are followed. A `*` segment
 * of the path stands for any segment, so a path holding one reaches the
 * wildcard entry there and every position it matches at its depth. Commits
 * the release together with a create-only receipt in the same space, readable
 * by the acting principal alone, holding the clauses released, the positions
 * they were removed at, and digests of the envelope before and after.
 * Releases and records nothing when every stored clause is kept.
 *
 * A link stored at the path is a link slot, whose own labels are stored at
 * the path, and its target's labels are not (spec §8.12.8). The release
 * follows a write redirect there, as a write does, and lowers the document it
 * leads to; with `options.linkSlot` it follows none, and lowers the slot's
 * own labels. A link that is not a write redirect is never followed. Whether
 * following a write redirect by default conforms to route 2c, which takes the
 * document from the request, is open pending a ruling, and
 * `docs/specs/cfc-conformance-statement.md` records it as such.
 *
 * The acting principal is the runtime's authenticated user. The document must
 * sit in that principal's own space, and every released clause must stand for
 * that principal alone (`clauseReleasableBy()`). A link the path crosses that
 * is retargeted before the release commits refuses it.
 *
 * Once released, the path's effective label view is read again in the
 * releasing transaction, resolved as the release resolves it, so it leaves
 * out the labels of the target of a link slot the release lowers. A clause it
 * still shows that `keep` does not name — held at a position the release does
 * not rewrite, such as an ancestor's entry, a wildcard entry covering a
 * segment the path names concretely, the slot of a write redirect the release
 * follows, a branch of the stored schema, or the cell's own schema — refuses
 * the release rather than leave the clause in place unreported, and a change
 * to any label the view read before the commit lands fails the commit.
 * `keep` may name only clauses stored at the path (§8.12.7), so a path such a
 * position also labels is released only once that position is.
 *
 * @throws When the release is refused (see
 *   `IExtendedStorageTransaction.releaseCfcConfidentiality()`), when the path
 *   still shows an unkept clause, when a link it crosses was retargeted, or
 *   when its commit fails.
 */
export async function releaseCellConfidentiality(
  cell: Cell<unknown>,
  keep: readonly CfcConfClause[],
  options: CellConfidentialityReleaseOptions = {},
): Promise<CellConfidentialityRelease> {
  const runtime = cellRuntime(cell);
  const lastNode: LastNode = options.linkSlot === true
    ? "top"
    : "writeRedirect";
  // The path is resolved in a transaction of its own, so that the links it
  // crosses do not join the label of the receipt the release writes.
  const resolving = runtime.edit();
  let target: NormalizedFullLink;
  try {
    target = resolveLink(
      runtime,
      resolving,
      cell.getAsNormalizedFullLink(),
      lastNode,
    );
  } finally {
    resolving.abort();
  }
  const tx = runtime.edit();
  try {
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: CONFIDENTIALITY_RELEASE_WRITER,
    });
    const release = tx.releaseCfcConfidentiality({
      space: target.space,
      id: target.id,
      scope: target.scope,
      path: target.path,
      keep,
    });
    const location = target.path.length === 0
      ? "<root>"
      : target.path.join("/");
    if (
      !deepEqual(
        resolveLink(
          runtime,
          tx,
          cell.getAsNormalizedFullLink(),
          lastNode,
        ),
        target,
      )
    ) {
      throw new Error(
        `Cannot lower confidentiality at ${location}: a link the path ` +
          "crosses changed while the release was prepared.",
      );
    }
    const unreachable = shownConfidentiality(cell.withTx(tx), lastNode).find((
      clause,
    ) => !keep.some((kept) => sameClause(kept, clause)));
    if (unreachable !== undefined) {
      throw new Error(
        debugStr`Cannot lower confidentiality at ${location}: ` +
          debugStr`$quote,long${unreachable} labels the path from a position ` +
          "a release does not rewrite: an ancestor's label, a wildcard label " +
          "(lowered by a path with `*` in its place), the label of a write " +
          "redirect the path follows (lowered by a release of the link slot " +
          "itself, `--link-slot`), a branch of the stored schema, or the " +
          "piece's own schema.",
      );
    }
    if (release.released.length === 0) {
      tx.abort();
      return release;
    }
    const eventId = crypto.randomUUID();
    const receipt = runtime.getCell(target.space, {
      cfcConfidentialityRelease: eventId,
    }, {
      type: "object",
      additionalProperties: true,
      ifc: {
        confidentiality: [cfcAtom.user(release.actor)],
        writeAuthorizedBy: [CONFIDENTIALITY_RELEASE_WRITER],
      },
    }, tx);
    receipt.set({
      eventId,
      actor: release.actor,
      space: target.space,
      id: target.id,
      scope: normalizeCellScope(target.scope),
      path: [...target.path],
      paths: release.paths.map((position) => [...position]),
      released: [...release.released],
      releasedDigests: [...release.releasedDigests],
      priorEnvelopeDigest: release.priorEnvelopeDigest,
      envelopeDigest: release.envelopeDigest,
      at: Date.now(),
    });
    const receiptLink = receipt.getAsNormalizedFullLink();
    tx.markCreateOnly?.(receiptLink);
    const result = await tx.commit().settled;
    if (result.error) {
      throw new Error(
        `Lowering confidentiality failed: ${result.error.message}`,
      );
    }
    return { ...release, receipt: receiptLink };
  } catch (error) {
    tx.abort();
    throw error;
  }
}

/** A document path, named directly, as a release by intent names it. */
export interface ReleaseByIntentTarget {
  /** The space holding the document. */
  readonly space: MemorySpace;

  /** The document, at space scope. */
  readonly id: URI;

  /** The stored path, with no `*` segment. */
  readonly path: readonly string[];
}

/**
 * The document and path `cell` addresses, as a release by intent names them:
 * the links its path crosses followed, and a link stored at the path itself
 * not, so that a link slot's own labels are what the target holds (§8.12.8).
 * A caller shows the result to the owner, who signs a request naming it.
 *
 * @throws If the resolved document is not at space scope.
 */
export function releaseByIntentTargetOf(
  cell: Cell<unknown>,
): ReleaseByIntentTarget {
  const runtime = cellRuntime(cell);
  const tx = runtime.edit();
  try {
    const target = resolveLink(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      "top",
    );
    if (normalizeCellScope(target.scope) !== DEFAULT_CELL_SCOPE) {
      throw new Error(
        `Cannot release by intent in ${target.id}: a release by intent ` +
          `names a document at space scope, and this one is at ` +
          `${target.scope} scope.`,
      );
    }
    return { space: target.space, id: target.id, path: [...target.path] };
  } finally {
    tx.abort();
  }
}

/** What a release by intent at a target can name, and the envelope it names. */
export interface StoredClausesForRelease {
  /** The clauses stored at the path, with their digests and positions. */
  readonly clauses: readonly StoredClause[];

  /** The digest of the stored envelope, which a request names. */
  readonly envelopeDigest: string;
}

/**
 * The confidentiality clauses stored at `target`, each with its canonical
 * clause digest and the entries holding it, and the digest of the document's
 * stored envelope: what an owner reads before signing a release by intent
 * there. Read as the runtime's replica holds the document, so a caller syncs
 * it first.
 *
 * @throws If the document's labels cannot be read, or the path holds a `*`
 *   segment.
 */
export function storedClausesForRelease(
  runtime: Runtime,
  target: ReleaseByIntentTarget,
): StoredClausesForRelease {
  const tx = runtime.edit();
  try {
    const stored = loadStoredCfcEnvelope(tx, {
      space: target.space,
      id: target.id,
      scope: DEFAULT_CELL_SCOPE,
    });
    if (stored.status === "unreadable") {
      throw new Error(
        `Cannot read the labels of ${target.id}: ${stored.reason}`,
      );
    }
    const cfc = tx.read({
      space: target.space,
      id: target.id,
      scope: DEFAULT_CELL_SCOPE,
      type: "application/json",
      path: ["cfc"],
    }).ok?.value;
    return {
      clauses: stored.status === "loaded"
        ? clausesStoredForRelease({
          path: target.path,
          entries: stored.metadata.labelMap.entries,
          schema: stored.schema,
        })
        : [],
      envelopeDigest: ownerReleaseByIntentEnvelopeDigest(cfc),
    };
  } finally {
    tx.abort();
  }
}

/** What {@link releaseConfidentialityByIntent} released, and its record. */
export interface ConfidentialityReleaseByIntent
  extends CfcConfidentialityReleaseByIntent {
  /** The record of the release. */
  readonly record: NormalizedFullLink;
}

/**
 * Carries out an owner release by intent (§8.12.7 route 2d): removes the
 * clauses `signed`'s request names from every component of the label stored
 * at its path of its document, and nothing at any other path, no value, and
 * no integrity label, and commits that together with the release's
 * create-only record. The record holds the signed request and what the
 * release did, and is labeled for the owner alone. The request names its
 * document directly, so no link is followed to find it.
 *
 * The transaction runs under the release-by-intent writer's builtin identity;
 * `IExtendedStorageTransaction.releaseCfcConfidentialityByIntent()` verifies
 * the request before writing, and the store verifies it again at the commit,
 * against the space's access list as it stands then.
 *
 * @throws When the request is refused (see
 *   `IExtendedStorageTransaction.releaseCfcConfidentialityByIntent()`), or
 *   when the commit fails, a store refusal among them.
 */
export async function releaseConfidentialityByIntent(
  runtime: Runtime,
  signed: SignedOwnerReleaseByIntentRequest,
): Promise<ConfidentialityReleaseByIntent> {
  const tx = runtime.edit();
  try {
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: OWNER_RELEASE_BY_INTENT_WRITER,
    });
    const release = tx.releaseCfcConfidentialityByIntent({ signed });
    const record = runtime.getCellFromLink({
      space: signed.request.space as MemorySpace,
      id: release.recordId as URI,
      path: [],
      scope: DEFAULT_CELL_SCOPE,
    }, {
      type: "object",
      additionalProperties: true,
      ifc: {
        confidentiality: [cfcAtom.user(release.owner)],
        writeAuthorizedBy: [OWNER_RELEASE_BY_INTENT_WRITER],
      },
    }, tx);
    record.set(ownerReleaseByIntentRecord(signed, release.envelopeDigest));
    const recordLink = record.getAsNormalizedFullLink();
    tx.markCreateOnly?.(recordLink);
    const result = await tx.commit().settled;
    if (result.error) {
      throw new Error(`Releasing by intent failed: ${result.error.message}`);
    }
    return { ...release, record: recordLink };
  } catch (error) {
    tx.abort();
    throw error;
  }
}
