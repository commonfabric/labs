import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { firstResolvedOutputRedirect } from "../src/runner.ts";
import {
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
} from "../src/link-utils.ts";

// Seen live on estuary home spaces (2026-07-29): a sub-pattern node whose
// stored outputs carry a DEFERRED partialCause alias unwraps to a bare
// `{"$alias":{"partialCause":…}}` record, and the resume walk's catch then
// skipped the WHOLE node's owned-cell pre-sync ("resume-owned-cells skipping
// a sub-pattern node whose outputs did not bind or resolve"), silently
// re-exposing the cold-cache commit-revert race the pre-sync exists to
// prevent. A partialCause alias is a derived internal cell, never the node's
// reserved result spot: the scan must step over the entry and keep looking,
// not abandon the node.

const signer = await Identity.fromPassphrase("resume-output-partialcause");
const space = signer.did();

describe("firstResolvedOutputRedirect vs partialCause aliases", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  const partialCauseAlias = {
    $alias: {
      partialCause: { "$generated": 0 },
      path: [],
      scope: "space",
    },
  };

  it("skips a partialCause alias and still finds the result spot after it", () => {
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-scan-base",
      undefined,
      tx,
    );
    const spot = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-scan-spot",
      undefined,
      tx,
    );
    const outputs = {
      // The exact shape from the estuary logs — listed FIRST so the scan
      // meets it before the real spot.
      generated: partialCauseAlias,
      result: spot.getAsWriteRedirectLink({ base }),
    };

    const found = firstResolvedOutputRedirect(rt, tx, outputs, base);
    tx.abort("test: read-only");
    expect(found?.id).toBe(spot.getAsNormalizedFullLink().id);
  });

  it("returns a cause-only spot link parsed, with no read of its doc", () => {
    // The identity bind (CT-1943) renders a partialCause alias as its
    // derived cell's kind-free id — a cause-only coordinate whose data,
    // for a computed-kind descriptor, lives at the KINDED entity, so
    // nothing is ever written under this id. Resolving it reads that
    // never-written doc, tying the scan to replication state and kicking
    // a pull no store can satisfy. Given the id in `causeOnlyIds`, the
    // scan returns the parsed coordinates and the transaction records no
    // read of the doc.
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-spot-base",
      undefined,
      tx,
    );
    const twin = getDerivedInternalCellLink(base, {
      partialCause: deepFreeze({ "$generated": 0 }),
      scope: "space",
    });
    const binding = createSigilLinkFromParsedLink(twin, {
      overwrite: "redirect",
    });

    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      { generated: binding },
      base,
      new Set([twin.id]),
    );
    expect(found?.id).toBe(twin.id);
    const reads = tx.getReactivityLog?.().reads ?? [];
    expect(reads.filter((read) => read.id === twin.id)).toEqual([]);
    tx.abort("test: read-only");
  });

  it("keeps a scoped cause-only link's scope while skipping its read", () => {
    // Cross-scope id matching is deliberate: the id hashes parent+cause
    // while scope rides the link, so a per-principal instance of the same
    // derived cell is recognized by the same set entry — and its scope
    // must survive untouched, because downstream consumers (the resultFor
    // cause, the owned-cell pre-sync) address the instance through it.
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-scoped-base",
      undefined,
      tx,
    );
    const twin = getDerivedInternalCellLink(base, {
      partialCause: deepFreeze({ "$generated": 1 }),
      scope: "user",
    });
    const binding = createSigilLinkFromParsedLink(twin, {
      overwrite: "redirect",
    });

    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      { generated: binding },
      base,
      new Set([twin.id]),
    );
    expect(found?.id).toBe(twin.id);
    expect(found?.scope).toBe("user");
    const reads = tx.getReactivityLog?.().reads ?? [];
    expect(reads.filter((read) => read.id === twin.id)).toEqual([]);
    tx.abort("test: read-only");
  });

  it("still resolves a spot whose id is not in the cause-only set", () => {
    // The set bounds the skip: an ordinary reserved spot resolves exactly
    // as before, even when a cause-only id is supplied for a different
    // cell of the same pattern.
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-other-base",
      undefined,
      tx,
    );
    const spot = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-other-spot",
      undefined,
      tx,
    );
    const twin = getDerivedInternalCellLink(base, {
      partialCause: deepFreeze({ "$generated": 2 }),
    });
    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      { result: spot.getAsWriteRedirectLink({ base }) },
      base,
      new Set([twin.id]),
    );
    tx.abort("test: read-only");
    expect(found?.id).toBe(spot.getAsNormalizedFullLink().id);
  });

  it("returns a cause-only first entry of an ARRAY binding as the spot", () => {
    // Output bindings are usually objects, so the array descent otherwise
    // goes unexercised: a list-shaped binding is scanned in order, and a
    // cause-only first entry IS the found spot — taken as parsed, never
    // read — with the ordinary spot after it left alone.
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-array-base",
      undefined,
      tx,
    );
    const spot = rt.getCell<Record<string, unknown>>(
      space,
      "cause-only-array-spot",
      undefined,
      tx,
    );
    const twin = getDerivedInternalCellLink(base, {
      partialCause: deepFreeze({ "$generated": 3 }),
    });
    const binding = [
      createSigilLinkFromParsedLink(twin, { overwrite: "redirect" }),
      spot.getAsWriteRedirectLink({ base }),
    ];

    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      binding,
      base,
      new Set([twin.id]),
    );
    tx.abort("test: read-only");
    expect(found?.id).toBe(twin.id);
  });

  it("returns undefined (not a throw) when outputs hold ONLY such aliases", () => {
    const tx = rt.edit();
    const base = rt.getCell<Record<string, unknown>>(
      space,
      "partialcause-only-base",
      undefined,
      tx,
    );
    const found = firstResolvedOutputRedirect(
      rt,
      tx,
      { generated: partialCauseAlias },
      base,
    );
    tx.abort("test: read-only");
    expect(found).toBeUndefined();
  });
});
