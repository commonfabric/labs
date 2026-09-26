/**
 * Copies explicitly reviewed JSON snapshots for the trusted host share surface.
 * This module is absent from authored pattern imports. Host consent authorizes
 * only a new copy; source documents and their labels remain unchanged. The
 * copy carries no source endorsements; the actor-private receipt records its
 * source and content digest without granting authority over other values.
 */

import type { JSONValue } from "@commonfabric/api";
import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { Cell } from "../cell.ts";
import { parseLink } from "../link-utils.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { type CfcConfClause, clauseAlternatives } from "./clause.ts";
import { cfcLabelViewFromMetadata } from "./label-view-state.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { cfcObservationFitsCeiling } from "./observation.ts";
import { collectConsumedLabel } from "./prepare.ts";
import { representsPrincipalSubject } from "./represents-principal.ts";
import { snapshotJsonValue } from "./share-snapshot-value.ts";
import { isRendererTrustedEvent } from "./ui-contract.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

/** Destination whose stored identity or resolved space determines the audience. */
export type SnapshotShareAudience =
  | { readonly user: Cell<unknown> }
  | { readonly space: Cell<unknown> };

/** Type-only brand for host-held consent objects. */
declare const consentBrand: unique symbol;

/** One-use review authority held only by the trusted host. */
export interface SnapshotShareConsent {
  /** Nominal token whose identity is verified against a private host registry. */
  readonly [consentBrand]: true;
}

/** Frozen preview for the trusted host's confirmation view. */
export interface PreparedSnapshotShare {
  /** Exact JSON payload whose disclosure the host presents for confirmation. */
  readonly value: JSONValue;

  /** Verified reader or space whose access the host presents for confirmation. */
  readonly audience: CfcAtom;

  /** One-use authority bound to this preview and authenticated actor. */
  readonly consent: SnapshotShareConsent;
}

/** Runtime-owned state behind an opaque review token. */
interface ConsentState {
  /** Source handle with no retained transaction. */
  readonly source: Cell<unknown>;

  /** Resolved source address whose later retargeting invalidates consent. */
  readonly sourceLink: NormalizedFullLink;

  /** Destination handle whose attested audience must remain unchanged. */
  readonly requestedAudience: SnapshotShareAudience;

  /** Verified actor at preparation. */
  readonly actor: string;

  /** Reviewed JSON snapshot. */
  readonly value: JSONValue;

  /** Reviewed audience atom. */
  readonly audience: CfcAtom;

  /** Resolved destination address. */
  readonly destination: NormalizedFullLink;

  /** Unique host event identity used for the copy and receipt. */
  readonly eventId: string;

  /** Host-bound recommendation lists updated with the reviewed copy. */
  readonly appendBooksTo?: {
    readonly recommended: Cell<unknown>;
    readonly received: Cell<unknown>;
    readonly recommendedLink: NormalizedFullLink;
    readonly receivedLink: NormalizedFullLink;
  };
}

const consents = new WeakMap<SnapshotShareConsent, ConsentState>();
const SHARE_WRITER = "cfc-share-snapshot";

/** Follows a host binding's one pointer without observing its private target. */
function appendTarget(
  cell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  const binding = cell.getAsNormalizedFullLink();
  const pointer = tx.readValueOrThrow(binding, {
    meta: internalVerifierRead,
    nonRecursive: true,
  });
  const link = parseLink(pointer, binding);
  if (!link?.id || !link.space) {
    throw new Error("Snapshot recommendation binding is not a cell link");
  }
  return cell.runtime.getCellFromLink(link);
}

/** Resolves an audience from persisted identity evidence, never authored schema. */
function resolveAudience(
  requested: SnapshotShareAudience,
  tx: IExtendedStorageTransaction,
): {
  audience: CfcAtom;
  destination: NormalizedFullLink;
} {
  const target = "user" in requested ? requested.user : requested.space;
  const destination = target.withTx(tx).resolveAsCell()
    .getAsNormalizedFullLink();
  if ("space" in requested) {
    if (!isDID(destination.space)) {
      throw new Error("Snapshot audience must name a space DID");
    }
    return { audience: cfcAtom.space(destination.space), destination };
  }
  const metadata = readStoredCfcMetadata(tx, destination);
  const view = cfcLabelViewFromMetadata(metadata, destination.path);
  const subjects = new Set(
    view?.entries.filter((entry) =>
      entry.path.length === 0 && entry.observes !== "followRef"
    )
      .flatMap((entry) => entry.label.integrity ?? [])
      .flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      }),
  );
  if (subjects.size !== 1) {
    throw new Error(
      "Snapshot recipient requires one persisted principal attestation",
    );
  }
  return { audience: cfcAtom.user([...subjects][0]), destination };
}

/** Reads the exact snapshot and verifies ownership of every released clause. */
function inspect(source: Cell<unknown>, requested: SnapshotShareAudience) {
  const runtime = source.runtime;
  const tx = runtime.edit();
  try {
    const actor = tx.getCfcState().trustSnapshot?.actingPrincipal;
    if (!isDID(actor)) {
      throw new Error("Snapshot sharing requires an authenticated actor");
    }
    const target = "user" in requested ? requested.user : requested.space;
    if (target.runtime !== runtime) {
      throw new Error("Snapshot handles must belong to the same runtime");
    }
    const sourceLink = source.withTx(tx).resolveAsCell()
      .getAsNormalizedFullLink();
    const sourceValue = source.withTx(tx).get();
    const consumed = collectConsumedLabel(tx);
    const actorAtom = cfcAtom.user(actor);
    if (
      runtime.cfcReadMaxConfidentiality === undefined &&
      !cfcObservationFitsCeiling(consumed.confidentiality, [actorAtom])
    ) {
      throw new Error(
        "Snapshot source exceeds the authenticated actor's read ceiling",
      );
    }
    const value = snapshotJsonValue(sourceValue);
    const resolved = resolveAudience(requested, tx);
    const audience = snapshotJsonValue(resolved.audience) as CfcAtom;
    const retained: CfcConfClause[] = [];
    for (const clause of consumed.confidentiality) {
      if (deepEqual(clause, actorAtom)) continue;
      if (
        !clauseAlternatives(clause).some((atom) => deepEqual(atom, audience))
      ) {
        throw new Error(
          "Snapshot sharing may release only the authenticated actor's own User clauses; other clauses must already admit the recipient",
        );
      }
      retained.push(clause);
    }
    const readActivities = tx.getReadActivities?.();
    if (readActivities === undefined) {
      throw new Error("Snapshot sharing requires a verifiable read journal");
    }
    const evidence = [...readActivities].map((read) => {
      const address: IMemorySpaceAddress = {
        space: read.space,
        id: read.id,
        type: read.type,
        scope: read.scope,
        path: [...read.path],
      };
      return {
        address,
        digest: hashStringOf(
          tx.readOrThrow(address, { meta: internalVerifierRead }),
        ),
      };
    });
    return {
      actor,
      sourceLink,
      value,
      retained,
      evidence,
      ...resolved,
      audience,
    };
  } finally {
    tx.abort();
  }
}

/** Prepares an immutable snapshot and verified audience for host confirmation. */
export function prepareSnapshotShare(
  source: Cell<unknown>,
  audience: SnapshotShareAudience,
  appendBooksTo?: {
    recommended: Cell<unknown>;
    received: Cell<unknown>;
  },
): PreparedSnapshotShare {
  const inspected = inspect(source, audience);
  let boundAppendTargets: ConsentState["appendBooksTo"];
  if (appendBooksTo) {
    if (
      appendBooksTo.recommended.runtime !== source.runtime ||
      appendBooksTo.received.runtime !== source.runtime
    ) throw new Error("Snapshot append targets must use the source runtime");
    const tx = source.runtime.edit();
    let recommendedLink: NormalizedFullLink;
    let receivedLink: NormalizedFullLink;
    try {
      recommendedLink = appendTarget(appendBooksTo.recommended, tx)
        .getAsNormalizedFullLink();
      receivedLink = appendTarget(appendBooksTo.received, tx)
        .getAsNormalizedFullLink();
    } finally {
      tx.abort();
    }
    if (
      recommendedLink.scope !== "user" ||
      recommendedLink.space !== inspected.destination.space ||
      receivedLink.scope !== "space" ||
      receivedLink.space !== inspected.destination.space ||
      !isObjectNotArray(inspected.value) ||
      !Array.isArray(inspected.value.books)
    ) throw new Error("Snapshot recommendation targets are invalid");
    boundAppendTargets = {
      recommended: appendBooksTo.recommended.withTx(undefined),
      received: appendBooksTo.received.withTx(undefined),
      recommendedLink,
      receivedLink,
    };
  }
  const consent = Object.freeze({}) as SnapshotShareConsent;
  consents.set(consent, {
    ...inspected,
    source: source.withTx(undefined),
    requestedAudience: audience,
    eventId: crypto.randomUUID(),
    ...(boundAppendTargets && { appendBooksTo: boundAppendTargets }),
  });
  return Object.freeze({
    value: inspected.value,
    audience: inspected.audience,
    consent,
  });
}

/**
 * Creates the reviewed copy after a host-trusted share gesture. The host
 * transport is trusted; this checks the renderer mark, stale state, actor, and
 * one-use authority, without claiming a hostile-host intent proof.
 */
export async function commitSnapshotShare(
  consent: SnapshotShareConsent,
  event: unknown,
): Promise<Cell<JSONValue>> {
  const state = consents.get(consent);
  if (!state) {
    throw new Error("Snapshot consent is unknown or already consumed");
  }
  consents.delete(consent);
  if (
    !isRendererTrustedEvent(event) || !isObjectNotArray(event) ||
    !isObjectNotArray(event.provenance) || event.provenance.origin !== "dom" ||
    event.provenance.trusted !== true ||
    !isObjectNotArray(event.provenance.ui) ||
    event.provenance.ui.pattern !== "ShareSnapshot"
  ) {
    throw new Error("Snapshot sharing requires a trusted host share gesture");
  }
  const current = inspect(state.source, state.requestedAudience);
  if (
    current.actor !== state.actor || !deepEqual(current.value, state.value) ||
    !deepEqual(current.audience, state.audience) ||
    !deepEqual(current.sourceLink, state.sourceLink) ||
    !deepEqual(current.destination, state.destination)
  ) {
    throw new Error(
      "Snapshot review is stale; review the value and audience again",
    );
  }
  const runtime = state.source.runtime;
  const tx = runtime.edit();
  try {
    if (tx.getCfcState().trustSnapshot?.actingPrincipal !== state.actor) {
      throw new Error("Snapshot actor changed after review");
    }
    // These comparisons bind the reviewed read closure to the committing
    // transaction. They authorize only this immutable, separately reviewed
    // copy; verifier reads retain conflict checks without adding the private
    // source's label back to the explicitly released output.
    for (const read of current.evidence) {
      const stored = tx.readOrThrow(read.address, {
        meta: internalVerifierRead,
      });
      if (hashStringOf(stored) !== read.digest) {
        throw new Error("Snapshot review changed before commit");
      }
    }
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: SHARE_WRITER,
    });
    const confidentiality = [...current.retained, {
      anyOf: [cfcAtom.user(state.actor), state.audience],
    }];
    const shared = runtime.getCell<JSONValue>(state.destination.space, {
      sharedSnapshot: state.eventId,
    }, {
      ifc: { confidentiality, writeAuthorizedBy: [SHARE_WRITER] },
    }, tx);
    shared.set(state.value);
    if (state.appendBooksTo) {
      const targets = state.appendBooksTo;
      if (
        !deepEqual(
          appendTarget(targets.recommended, tx).getAsNormalizedFullLink(),
          targets.recommendedLink,
        ) ||
        !deepEqual(
          appendTarget(targets.received, tx).getAsNormalizedFullLink(),
          targets.receivedLink,
        )
      ) throw new Error("Snapshot recommendation targets changed");
      const books = (state.value as { books: JSONValue[] }).books;
      for (let index = 0; index < books.length; index++) {
        const book = shared.key("books", index);
        (runtime.getCellFromLink(
          targets.recommendedLink,
          undefined,
          tx,
        ) as Cell<unknown[]>).push(book);
        (runtime.getCellFromLink(targets.receivedLink, undefined, tx) as Cell<
          unknown[]
        >).push(book);
      }
    }
    const link = shared.getAsNormalizedFullLink();
    tx.markCreateOnly?.(link);
    const receipt = runtime.getCell(state.destination.space, {
      snapshotShareReceipt: state.eventId,
    }, {
      type: "object",
      additionalProperties: true,
      ifc: {
        confidentiality: [...current.retained, cfcAtom.user(state.actor)],
        writeAuthorizedBy: [SHARE_WRITER],
      },
    }, tx);
    receipt.set({
      eventId: state.eventId,
      actor: state.actor,
      audience: state.audience,
      valueDigest: hashStringOf(state.value),
      destination: link.id,
      destinationSpace: link.space,
      sourceId: state.sourceLink.id,
    });
    tx.markCreateOnly?.(receipt.getAsNormalizedFullLink());
    const result = await tx.commit();
    if (result.error) {
      throw new Error(`Snapshot share failed: ${result.error.message}`);
    }
    return shared.withTx(undefined);
  } catch (error) {
    tx.abort();
    throw error;
  }
}
