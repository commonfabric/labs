import type { DID } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { labelMetadataFieldIsProtected } from "../cfc/label-metadata-population.ts";
import { cfcLabelViewFromMetadata } from "../cfc/label-view-state.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import {
  exactPrincipalAttestations,
  PRINCIPAL_CLAIM_KINDS,
  type PrincipalClaimKind,
} from "../cfc/represents-principal.ts";
import type { Runtime } from "../runtime.ts";
import { entityKey } from "../scheduler/keys.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
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
 * as `undefined`. It never guesses. A label the caller cannot observe, one
 * whose read is refused by construction or by the storage manager, also
 * returns `undefined`, as missing metadata does, which is the normalization
 * of hidden cases that CFC spec §4.6.4.1 requires. A label still loading is
 * not one of them, in a handler: the handler is withdrawn and runs again once
 * its document arrives.
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
 * `options.label` says which label is read. `"resolved"`, the default, is the
 * label on the document `target`'s value resolves to. `"written"` is the label
 * where a write to `target` lands instead: links on the way to `target` are
 * followed, and so is a redirect stored there, but a link `target` holds as
 * its value is not. That reads what the runtime stamped on a field holding a
 * link, such as who wrote the link, where `"resolved"` reads the document the
 * link leads to. The claims a link carries from that document are not counted
 * either way.
 *
 * The DID returned is data. Written into a label as a claim's subject, it is a
 * literal like any other, which the runtime refuses from a pattern unless the
 * schema declares it as the `ownerPrincipal` and it is the principal the write
 * acts for.
 *
 * @throws If called outside a handler or a reactive computation, with a
 *   `kind` that is not a principal claim kind, with a `target` that is
 *   neither a cell nor `undefined`, or with `options` that is not an object
 *   whose `label`, if present, is `"written"` or `"resolved"`; if the target's
 *   label is stored in a form this build cannot interpret
 *   (`StoredCfcMetadataError`), or the transaction's read of it fails; and if
 *   the label-metadata classification makes a claim's subject anything but
 *   public.
 */
export function principalOf(
  // Typed `unknown` here, though the declared API types both, so that the
  // runtime checks below have cases to catch from untyped callers.
  target: unknown,
  kind: unknown,
  options?: unknown,
): DID | undefined {
  const principals = attestedPrincipals(
    "principalOf(target, kind)",
    target,
    kind,
    options,
  );
  return principals?.length === 1 ? principals[0] : undefined;
}

/**
 * Like `principalOf()`, except that it returns every principal the claims of
 * `kind` name rather than only a single one, so that a caller can tell a
 * label that attests no principal from one that attests several.
 *
 * Returns `[]` when the label attests none, and for a label the caller cannot
 * observe, as `principalOf()` normalizes one with missing metadata; and the
 * DIDs it attests, in the order they first appear, when it attests one or
 * more. Returns `undefined`
 * when a claim there is in any form but the one a runtime mints, since no
 * principal can then be read from it, and for a `target` passed as
 * `undefined`. The claims are read where, and as, `principalOf()` reads them,
 * `options.label` included.
 *
 * @throws In every case `principalOf()` throws.
 */
export function principalsOf(
  // Typed `unknown` here, though the declared API types both, so that the
  // runtime checks below have cases to catch from untyped callers.
  target: unknown,
  kind: unknown,
  options?: unknown,
): DID[] | undefined {
  return attestedPrincipals(
    "principalsOf(target, kind)",
    target,
    kind,
    options,
  );
}

/**
 * Helper for `principalOf()` and `principalsOf()`, which checks the calling
 * frame and `kind`, then reads the claims of `kind` on `target`'s label as
 * `exactPrincipalAttestations()` reads them. `name` is the caller, as its
 * errors name it. `options` is the caller's third argument, unchecked.
 */
function attestedPrincipals(
  name: string,
  target: unknown,
  kind: unknown,
  options: unknown,
): DID[] | undefined {
  const frame = topFrame();
  if (frame?.frameKind !== "lift" && frame?.frameKind !== "handler") {
    throw new Error(
      `\`${name}\` can only be called from a handler or a reactive computation.`,
    );
  }
  const { runtime, tx } = frame;
  if (runtime === undefined || tx === undefined) {
    throw new Error(`\`${name}\` requires an executing runtime.`);
  }
  if (typeof kind !== "string" || !PRINCIPAL_CLAIM_KINDS.has(kind)) {
    throw new Error(
      debugStr`\`${name}\` takes a \`kind\` of \`authored-by\` or \`represents-principal\`, not $quote${kind}`,
    );
  }
  const claimKind = kind as PrincipalClaimKind;
  if (labelMetadataFieldIsProtected({ kind: claimKind }, "subject")) {
    throw new Error(
      debugStr`\`${name}\` cannot carry a label for the subject of a $quote${claimKind} claim, which is not classified public.`,
    );
  }
  let label: "written" | "resolved" = "resolved";
  if (options !== undefined) {
    const given = isObjectNotArray(options) ? options.label : undefined;
    if (
      !isObjectNotArray(options) ||
      (given !== undefined && given !== "written" && given !== "resolved")
    ) {
      throw new Error(
        debugStr`\`${name}\` takes \`options\` of \`{ label?: "written" | "resolved" }\`, not $quote${options}`,
      );
    }
    label = given ?? "resolved";
  }
  if (target === undefined) return undefined;

  // Resolution follows the link chain, which reads pointers and not the
  // value they lead to. For the written label it stops where a write to the
  // cell lands: a link stored there as its value is left unfollowed, so the
  // label read is the one on the field itself.
  const cell = cellOfTarget(target, name).withTx(tx);
  const link = label === "written"
    ? resolveLink(
      runtime,
      runtime.readTx(tx),
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
      { markIfcCrossings: true },
    )
    : cell.resolveAsCell().getAsNormalizedFullLink();
  // The default read policy journals the read as a dependency, so a label
  // change runs the calling computation again.
  const metadata = readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  if (frame.frameKind === "handler") {
    withdrawWhileLabelLoads(runtime, tx, link);
  }
  return exactPrincipalAttestations(
    cfcLabelViewFromMetadata(metadata, link.path.map(String)),
    claimKind,
  );
}

/**
 * Helper for `attestedPrincipals()`, which withdraws the running handler when
 * the replica has no local basis for the document whose label it read, not
 * even a confirmed absence, and that document's load is in flight. The read
 * then found no label because the label has not arrived, which is not the
 * document's state, and a handler runs once per event: the scheduler runs a
 * withdrawn one again once the load lands (`dispatchedHandlerNotRun`). A
 * withdrawal therefore always has a load to wait on, and a document that does
 * not exist withdraws the handler at most until its absence is confirmed. A
 * reactive computation needs none of this, since the load's arrival runs it
 * again.
 */
function withdrawWhileLabelLoads(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): void {
  const { storageManager } = runtime;
  // The instance a scoped read reaches is the one the transaction demands,
  // as a served run's is its actor's, so the load and the local basis are
  // looked up for that instance.
  const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
  const key = entityKey(link, identity);
  if (storageManager.pendingLoadGeneration?.(key) === undefined) return;
  const { replica } = storageManager.open(link.space);
  if (
    replica.hasLocalDocumentCoverage?.(link.id, link.scope, identity) === true
  ) {
    return;
  }
  tx.dispatchedHandlerNotRun ??= {
    reason:
      `the label of \`${link.id}\` was read while its document was still loading`,
  };
}
