/**
 * Whose own profile a profile is: the one rule every reader of which
 * profiles are a person's applies, on a host (`profileOwnerAt()`) and in
 * pattern code (`profileOwnerOf()`, in `builder/profile-owner-of.ts`).
 */

import type { DID } from "@commonfabric/api";

import { attestedPrincipalsAt } from "./builder/principal-of.ts";
import type { Cell } from "./cell.ts";
import { PROFILE_NAME_FIELD } from "./cfc/represents-principal.ts";
import { loadDocument } from "./document-readiness.ts";
import { unlessCyclic } from "./link-resolution.ts";
import type { NormalizedFullLink } from "./link-types.ts";
import { getMetaLink, isPrimitiveCellLink, parseLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { internalVerifierRead } from "./storage/reactivity-log.ts";

/**
 * Returns the person whose own profile `profile` is, or `undefined` when it
 * is no one's, read through `tx`. A profile is a person's own when:
 *
 * - its `name`, followed through every link it holds, stays within the
 *   profile's own documents: each document the chain passes through is the
 *   profile's or names it as its owner (its `result` back-link, which setup
 *   writes onto a pattern's derived internal cells and which no pattern can
 *   write), so a name borrowed from another profile, by a link into another
 *   document or another space, makes no one's profile of this one, and so
 *   does a name whose links run in a cycle; and
 * - its label names that person, and no one else, as the principal the
 *   profile represents, read as every reader of a profile's principal reads
 *   one (`attestedPrincipalsAt()`): with a name its owner wrote, the claims on
 *   the profile's root and its `name`. Those include the claim the name
 *   field's owner policy installs for its owner when the profile is set up,
 *   which no one but the owner's own runtime can install, so a profile whose
 *   name value was stored before names were labeled is its owner's through
 *   it, and a document with no label at all is no one's.
 *
 * Every read is one a reactive computation reruns on, so a profile whose
 * documents arrive later is answered for once they do. `profile` and the
 * documents its `name` resolves through are loaded by the caller; one that is
 * not reads as holding nothing. `visit` is called with each document the rule
 * reads, before it is read, so that a handler can wait for one still loading.
 *
 * @throws When a label is stored in a form this build cannot interpret, or a
 *   read through `tx` fails.
 */
export function profileOwnerAt(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  profile: Cell<unknown>,
  visit: (document: NormalizedFullLink) => void = () => {},
): DID | undefined {
  const link = unlessCyclic(() => profile.withTx(tx).resolveAsCell())
    ?.getAsNormalizedFullLink();
  if (link === undefined || link.path.length !== 0) return undefined;
  visit(link);
  const chain = nameChain(tx, link, visit);
  if (
    chain === undefined ||
    chain.some((document) => !ownedBy(runtime, tx, document, link))
  ) {
    return undefined;
  }
  const principals = attestedPrincipalsAt(
    runtime,
    tx,
    link,
    "represents-principal",
  );
  return principals?.length === 1 ? principals[0] : undefined;
}

/**
 * Helper for `profileOwnerAt()` and `loadProfileOwnerDocuments()`, which
 * follows the `name` of the profile at `profile` through each link it holds,
 * calling `visit` with each document before reading it, and returns the
 * documents other than the profile's that the chain passes through, in order,
 * or `undefined` when it leaves the profile's space or returns to a place it
 * passed through, which no document of the profile's own can make it do.
 */
function nameChain(
  tx: IExtendedStorageTransaction,
  profile: NormalizedFullLink,
  visit: (document: NormalizedFullLink) => void,
): NormalizedFullLink[] | undefined {
  const documents: NormalizedFullLink[] = [];
  const visited = new Set<string>();
  let at: NormalizedFullLink = { ...profile, path: [PROFILE_NAME_FIELD] };
  while (true) {
    const value = tx.readValueOrThrow(at, { meta: internalVerifierRead });
    if (!isPrimitiveCellLink(value)) return documents;
    const next = parseLink(value, at);
    const key = `${next.space}/${next.id}/${next.path.join("/")}`;
    if (next.space !== profile.space || visited.has(key)) return undefined;
    visited.add(key);
    if (next.id !== profile.id) {
      const document = { ...next, path: [] };
      visit(document);
      documents.push(document);
    }
    at = next;
  }
}

/**
 * Helper for `profileOwnerAt()`, which returns whether `document` names the
 * profile at `profile` as its owner: its `result` back-link, read as a
 * dependency a reactive computation reruns on, is the profile's.
 */
function ownedBy(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  document: NormalizedFullLink,
  profile: NormalizedFullLink,
): boolean {
  const owner = getMetaLink(
    runtime.getCellFromLink(document, undefined, tx),
    "result",
    { meta: internalVerifierRead },
  );
  return owner?.space === profile.space && owner.id === profile.id;
}

/**
 * Loads the documents `profileOwnerAt()` reads of `profile`, for a caller
 * outside a reactive run: the profile's own, and each one its `name` resolves
 * through, one at a time, until the chain ends, leaves the profile's space or
 * runs in a cycle, which `profileOwnerAt()` reads as no one's.
 *
 * @throws DocumentLoadError when one of them fails to load.
 */
export async function loadProfileOwnerDocuments(
  runtime: Runtime,
  profile: Cell<unknown>,
): Promise<void> {
  if (!await loadDocument(runtime, profile)) return;
  const link = unlessCyclic(() => profile.resolveAsCell())
    ?.getAsNormalizedFullLink();
  if (link === undefined) return;
  const loaded = new Set<string>();
  while (true) {
    // Reading stops at the first document not yet loaded, which is loaded and
    // the chain read again from the start.
    let pending: NormalizedFullLink | undefined;
    const tx = runtime.edit();
    try {
      nameChain(tx, link, (document) => {
        const key = `${document.space}/${document.id}`;
        if (pending === undefined && !loaded.has(key)) pending = document;
      });
    } finally {
      tx.abort();
    }
    if (pending === undefined) return;
    loaded.add(`${pending.space}/${pending.id}`);
    if (!await loadDocument(runtime, runtime.getCellFromLink(pending))) return;
  }
}
