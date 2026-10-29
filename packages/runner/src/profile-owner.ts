/**
 * Whose own profile a profile is: the one rule every reader of which
 * profiles are a person's applies, on a host (`profileOwnerAt()`) and in
 * pattern code (`profileOwnerOf()`, in `builder/profile-owner-of.ts`).
 */

import type { DID } from "@commonfabric/api";

import { attestedPrincipalsAt } from "./builder/principal-of.ts";
import type { Cell } from "./cell.ts";
import { readStoredCfcMetadata } from "./cfc/metadata.ts";
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
 *   does a name whose links run in a cycle. The one exception is the shape
 *   `isLegacyName()` accepts, a name the profile's own `name` cell holds a
 *   link to; and
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
  const hops = nameChain(tx, link, visit);
  if (hops === undefined || !nameIsOwn(runtime, tx, hops, link)) {
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
 * calling `visit` with each document before reading it, and returns the links
 * it follows into documents other than the profile's, in order, or
 * `undefined` when it leaves the profile's space or returns to a place it
 * passed through, which no document of the profile's own can make it do.
 */
function nameChain(
  tx: IExtendedStorageTransaction,
  profile: NormalizedFullLink,
  visit: (document: NormalizedFullLink) => void,
): NormalizedFullLink[] | undefined {
  const hops: NormalizedFullLink[] = [];
  const visited = new Set<string>();
  let at: NormalizedFullLink = { ...profile, path: [PROFILE_NAME_FIELD] };
  while (true) {
    const value = tx.readValueOrThrow(at, { meta: internalVerifierRead });
    if (!isPrimitiveCellLink(value)) return hops;
    const next = parseLink(value, at);
    const key = `${next.space}/${next.id}/${next.path.join("/")}`;
    if (next.space !== profile.space || visited.has(key)) return undefined;
    visited.add(key);
    if (next.id !== profile.id) {
      visit({ ...next, path: [] });
      hops.push(next);
    }
    at = next;
  }
}

/**
 * Helper for `profileOwnerAt()`, which returns whether the `name` of the
 * profile at `profile`, reached through `hops` as `nameChain()` returns them,
 * stays within the profile's own documents: each document a hop lands in
 * names the profile as its owner (`ownedBy()`), or the hops have the shape
 * `isLegacyName()` accepts.
 */
function nameIsOwn(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  hops: readonly NormalizedFullLink[],
  profile: NormalizedFullLink,
): boolean {
  return hops.every((hop) => ownedBy(runtime, tx, hop, profile)) ||
    isLegacyName(runtime, tx, hops, profile);
}

/**
 * Helper for `nameIsOwn()`, which returns whether `hops` has the shape the
 * `name` of a profile created by `profile-home.tsx` before #7701
 * (`d5c274f052`) holds: two hops, the first into the profile's own `name` cell
 * (`ownedBy()`), which holds a link to the root of a second document in the
 * profile's space that names no owner, carries no label, and holds the name as
 * a string. That setup defaulted the `name` cell to a computed value, and
 * stored the default as a link to a document holding it. The cell keeps that
 * link: setup again under a later release leaves an existing value as it is,
 * and `setName` writes through the link.
 *
 * Accepting the shape grants a writer of the `name` cell nothing more: one
 * who can store this link there can store any name there directly, which the
 * rule accepts anyway. The name it reaches stays in the profile's own space,
 * so it is not borrowed from another, and whose profile it is still rests on
 * the label of the profile's own document (`attestedPrincipalsAt()`). The
 * document holding the name carries no label and names no owner, so whoever
 * can write the profile's space can change the name it holds, though not
 * whose profile it is.
 */
function isLegacyName(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  hops: readonly NormalizedFullLink[],
  profile: NormalizedFullLink,
): boolean {
  // TODO(@hixie): re-fix this so profiles created before #7701 (d5c274f052)
  // keep working without this exception, e.g. by repairing their stored name,
  // then remove it. `profile-ownership.test.ts` pins the shape, under "a
  // profile whose own `name` cell links to a bare document beside it".
  if (hops.length !== 2) return false;
  const [cell, held] = hops;
  return ownedBy(runtime, tx, cell, profile) &&
    held.path.length === 0 &&
    ownerOf(runtime, tx, held) === undefined &&
    readStoredCfcMetadata(tx, held) === undefined &&
    typeof tx.readValueOrThrow(held, { meta: internalVerifierRead }) ===
      "string";
}

/**
 * Helper for `nameIsOwn()` and `isLegacyName()`, which returns whether the
 * document `hop` lands in names the profile at `profile` as its owner
 * (`ownerOf()`).
 */
function ownedBy(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  hop: NormalizedFullLink,
  profile: NormalizedFullLink,
): boolean {
  const owner = ownerOf(runtime, tx, hop);
  return owner?.space === profile.space && owner.id === profile.id;
}

/**
 * Helper for `ownedBy()` and `isLegacyName()`, which returns the owner the
 * document `hop` lands in names, its `result` back-link, read as a dependency
 * a reactive computation reruns on, or `undefined` when it names none.
 */
function ownerOf(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  hop: NormalizedFullLink,
): NormalizedFullLink | undefined {
  return getMetaLink(
    runtime.getCellFromLink({ ...hop, path: [] }, undefined, tx),
    "result",
    { meta: internalVerifierRead },
  );
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
