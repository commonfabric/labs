import type { DID } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";

import { labelMetadataFieldIsProtected } from "../cfc/label-metadata-population.ts";
import { cfcLabelViewFromMetadata } from "../cfc/label-view-state.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";
import {
  exactPrincipalAttestations,
  PRINCIPAL_CLAIM_KINDS,
  type PrincipalClaimKind,
} from "../cfc/represents-principal.ts";
import { topFrame } from "./frame-context.ts";
import { cellOfTarget } from "./space-access.ts";

/**
 * Returns the one principal that the label on `target`'s value attests with a
 * claim of `kind`: for `represents-principal`, whom the value stands for, as a
 * profile's label says; for `authored-by`, who wrote it. The claim is read at
 * the value's root and on its top-level fields, in exactly the form a runtime
 * mints, as `exactPrincipalAttestations()` reads it, and never from what a
 * link the value holds carries.
 *
 * Returns `undefined` when the label names no verified single principal of
 * that kind: when it attests none, when it attests more than one, when a claim
 * there is in any form but the one a runtime mints, and for a `target` passed
 * as `undefined`. It never guesses. A label it cannot read is not one of
 * those: that read throws, so a labeled document never reads as unlabeled.
 *
 * The read is of `target`'s label: the value's cell is followed through any
 * links it holds, which reads the pointers along the way and no other value
 * contents, and then only its stored label is consulted, through the calling
 * code's own transaction, so a change to the label runs a reactive computation
 * that called this again. What a claim's `kind` and `subject` disclose is
 * public by the label-metadata classification
 * (`docs/specs/cfc-label-metadata-confidentiality.md` §2), so the observation
 * adds no confidentiality to the result. If that classification ever made the
 * subject protected, this throws, since no label could be carried for it.
 *
 * The DID returned is data. Written into a label as a claim's subject, it is a
 * literal like any other, which the runtime refuses from a pattern.
 *
 * @throws If called outside a handler or a reactive computation, with a
 *   `kind` that is not a principal claim kind, or with a `target` that is
 *   neither a cell nor `undefined`; if the target's label cannot be read,
 *   including one stored in a form this build cannot interpret
 *   (`StoredCfcMetadataError`); and if the label-metadata classification
 *   makes a claim's subject anything but public.
 */
export function principalOf(
  // Typed `unknown` here, though the declared API types both, so that the
  // runtime checks below have cases to catch from untyped callers.
  target: unknown,
  kind: unknown,
): DID | undefined {
  const frame = topFrame();
  if (frame?.frameKind !== "lift" && frame?.frameKind !== "handler") {
    throw new Error(
      "`principalOf(target, kind)` can only be called from a handler or a " +
        "reactive computation.",
    );
  }
  const { tx } = frame;
  if (tx === undefined) {
    throw new Error(
      "`principalOf(target, kind)` requires an executing runtime.",
    );
  }
  if (typeof kind !== "string" || !PRINCIPAL_CLAIM_KINDS.has(kind)) {
    throw new Error(
      debugStr`\`principalOf(target, kind)\` takes a \`kind\` of \`authored-by\` or \`represents-principal\`, not $quote${kind}`,
    );
  }
  const claimKind = kind as PrincipalClaimKind;
  if (labelMetadataFieldIsProtected({ kind: claimKind }, "subject")) {
    throw new Error(
      debugStr`\`principalOf(target, kind)\` cannot carry a label for the subject of a $quote${claimKind} claim, which is not classified public.`,
    );
  }
  if (target === undefined) return undefined;

  // Resolution follows the link chain, which reads pointers and not the
  // value they lead to.
  const link = cellOfTarget(target, "principalOf(target, kind)").withTx(tx)
    .resolveAsCell().getAsNormalizedFullLink();
  // The default read policy journals the read as a dependency, so a label
  // change runs the calling computation again.
  const metadata = readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  const principals = exactPrincipalAttestations(
    cfcLabelViewFromMetadata(metadata, link.path.map(String)),
    claimKind,
  );
  return principals?.length === 1 ? principals[0] as DID : undefined;
}
