// OW51 memo aliasing (PR #6179 review, Finding 1 — MAJOR): the OW51
// discriminator `viaLinkHop` changes a resolution's ANSWER (a data-derived
// input link makes a missing-doc dead-end resolve to a `pendingHopDoc`
// result; a clean input link at the same address resolves to plain
// undefined-data), but it was NOT part of `resolutionMemoVariant`. So within
// ONE lazy tx, a clean read and a data-derived read of the SAME missing doc
// shared a memo entry and the second inherited the first's verdict — in BOTH
// directions:
//
//   P2a derived-first → the clean `get() ?? fallback` read spuriously REFUSES
//     (a crash where honest-undefined is owed — the OFF `topics`/parking
//      pattern breakage the first CI run surfaced).
//   P2b clean-first  → the derived read SILENTLY LOSES the refusal (the OW51
//     crash class survives the alias).
//
// The fix adds `viaLinkHop` to `resolutionMemoVariant` so the two resolutions
// key to distinct memo entries. These pins reproduce both directions: each is
// RED without the variant term, GREEN with it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { isUnresolvedInputError } from "../src/schema-view.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ow51 memo alias space");
const space = signer.did();

// string|null: the reader's schema PROMISES a value (no `default`), so a
// data-derived dead-end must refuse rather than hand `undefined` to the body.
const SCHEMA: JSONSchema = { type: ["string", "null"] };

describe("OW51 memo-variant: viaLinkHop must not alias in the resolution memo (review Finding 1)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  // A CLEAN handle and a DATA-DERIVED link to the SAME never-written doc,
  // both at address X (path []) sharing ONE schema object — the alias
  // condition: identical memo address, and identical variant EXCEPT for the
  // viaLinkHop term the fix adds.
  const cleanAndDerived = (
    tx: IExtendedStorageTransaction,
  ): { clean: Cell<unknown>; derived: Cell<unknown> } => {
    const clean = runtime.getCell(space, "ow51-memo-missing", SCHEMA, tx);
    // `viaLinkHop: true` marks the link DATA-DERIVED exactly as parseLink
    // stamps a sigil-parsed link — the enumerable read-side hint the
    // resolution consults.
    const derivedLink = {
      ...clean.getAsNormalizedFullLink(),
      schema: SCHEMA,
      viaLinkHop: true as const,
    };
    const derived = runtime.getCellFromLink(derivedLink, SCHEMA, tx);
    return { clean, derived };
  };

  it("P2b (clean-first): the derived read still REFUSES — the alias must not swallow the refusal (OW51 crash class)", () => {
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const { clean, derived } = cleanAndDerived(tx);

    // Own-root clean read: honest undefined (the carve-out), no refusal —
    // this seeds the shared memo entry with NO pendingHopDoc.
    expect(clean.get()).toBeUndefined();

    // The derived read of the same missing doc MUST refuse. Without the
    // variant term it hits the clean read's memo entry and reads undefined
    // (the OW51 crash class surviving); with it, it refuses.
    let threw: unknown;
    try {
      derived.get();
    } catch (error) {
      threw = error;
    }
    expect(isUnresolvedInputError(threw)).toBe(true);
    tx.abort();
  });

  it("the own-root carve-out (over-fire side, review Finding 6): a lazy-tx read of an absent OWN-ROOT doc stays undefined — the refusal must fire ONLY for data-derived dead-ends", () => {
    // Pairs with the dead-end-refuses pin: mutation C (dropping the
    // `followedHop || inputViaLinkHop` guard so EVERY missing-doc dead-end
    // becomes pending) survived the whole suite before this. A CLEAN own-root
    // handle to a never-written doc must read undefined, not refuse.
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const clean = runtime.getCell(space, "ow51-ownroot-missing", SCHEMA, tx);
    expect(clean.get()).toBeUndefined();
    tx.abort();
  });

  it("P2a (derived-first): the clean read stays UNDEFINED — no spurious refusal inherited from the derived read", () => {
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const { clean, derived } = cleanAndDerived(tx);

    // Derived read refuses (correct) — this seeds the shared memo entry WITH
    // pendingHopDoc.
    expect(() => derived.get()).toThrow();

    // The own-root clean read must stay honest-undefined. Without the variant
    // term it inherits the derived read's pendingHopDoc and REFUSES — a
    // spurious crash of the `get() ?? fallback` idiom; with it, undefined.
    expect(clean.get()).toBeUndefined();
    tx.abort();
  });
});
