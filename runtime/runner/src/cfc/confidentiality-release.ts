/**
 * Lowers the confidentiality stored at one path of a document, for a trusted
 * host acting as the document's owner: the CLI's `cf cell set-label
 * --dangerously-allow-lowering-confidentiality`. This module is absent from
 * authored pattern imports. What may be released, and by whom, is decided by
 * `planConfidentialityRelease()`; this module resolves the cell, writes the
 * release under the release writer's builtin identity, and records it in a
 * receipt only the owner may read.
 */

import { cfcAtom } from "@commonfabric/api/cfc";
import { debugStr } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { type Cell, cellRuntime } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { normalizeCellScope } from "../scope.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";
import type { CfcConfClause } from "./clause.ts";
import {
  type CfcConfidentialityRelease,
  CONFIDENTIALITY_RELEASE_WRITER,
  sameClause,
} from "./confidentiality-release-plan.ts";
import { cfcLabelViewForResolvedCellWithStatus } from "./label-view.ts";
import { mergeCfcLabelViews } from "./label-view-state.ts";
import { cfcLabelViewFromSchema } from "./schema-label-view.ts";

/** What {@link releaseCellConfidentiality} released, and where it says so. */
export interface CellConfidentialityRelease extends CfcConfidentialityRelease {
  /** The receipt recording the release; absent when nothing was released. */
  readonly receipt?: NormalizedFullLink;
}

/**
 * Helper for {@link releaseCellConfidentiality}, which returns the
 * confidentiality clauses `cell`'s effective label view holds at its own path:
 * what `cf cell get-label` shows there, the cell's own schema included. Read
 * through `cell`'s transaction, so a release in that transaction is seen, and
 * so the commit conflicts with a change to any label the view read.
 *
 * @throws If the labels cannot be read.
 */
const shownConfidentiality = (cell: Cell<unknown>): CfcConfClause[] => {
  const { view, readFailed } = cfcLabelViewForResolvedCellWithStatus(cell);
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
 * the document the path lands in once its links are followed. Commits the
 * release together with a create-only receipt in the same space, readable by
 * the acting principal alone, holding the clauses released and digests of the
 * envelope before and after. Releases and records nothing when every stored
 * clause is kept.
 *
 * The acting principal is the runtime's authenticated user. The document must
 * sit in that principal's own space, and every released clause must stand for
 * that principal alone (`clauseReleasableBy()`). A link the path crosses that
 * is retargeted before the release commits refuses it.
 *
 * Once released, the path's effective label view is read again in the
 * releasing transaction. A clause it still shows that `keep` does not name —
 * held at a position the release does not rewrite, such as an ancestor's or a
 * wildcard entry, a branch of the stored schema, or the cell's own schema —
 * refuses the release rather than leave the clause in place unreported, and a
 * change to any label the view read before the commit lands fails the commit.
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
): Promise<CellConfidentialityRelease> {
  const runtime = cellRuntime(cell);
  // The path is resolved in a transaction of its own, so that the links it
  // crosses do not join the label of the receipt the release writes.
  const resolving = runtime.edit();
  let target: NormalizedFullLink;
  try {
    target = resolveLink(
      runtime,
      resolving,
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
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
          "writeRedirect",
        ),
        target,
      )
    ) {
      throw new Error(
        `Cannot lower confidentiality at ${location}: a link the path ` +
          "crosses changed while the release was prepared.",
      );
    }
    const unreachable = shownConfidentiality(cell.withTx(tx)).find((clause) =>
      !keep.some((kept) => sameClause(kept, clause))
    );
    if (unreachable !== undefined) {
      throw new Error(
        debugStr`Cannot lower confidentiality at ${location}: ` +
          debugStr`$quote,long${unreachable} labels the path from a position ` +
          "a release does not rewrite: an ancestor's or a wildcard label, a " +
          "branch of the stored schema, or the piece's own schema.",
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
