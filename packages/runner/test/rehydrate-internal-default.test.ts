import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { JSONValue } from "@commonfabric/runner/shared";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { Cell, type Pattern } from "../src/builder/types.ts";
import { isPrimitiveCellLink } from "../src/link-types.ts";
import { getMetaLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("rehydrate internal default", () => {
  // A pattern's derived internal cell carries a build-time default (in
  // home.tsx, `const activeTab = new Writable("spaces").for("activeTab")` →
  // `derivedInternalCells = [{ partialCause: "activeTab", schema: { default:
  // "spaces" } }]`). After the user picks a value ("profile") and it is
  // persisted, re-running the pattern must NOT revert the cell to the
  // build-time default.
  //
  // `Runner.#applySetupState` reads the persisted internal value and merges the
  // build-time default UNDER it (persisted wins). The internal cell lives in a
  // separate content-addressed doc reached only via the result cell's meta
  // link — not through the schema/value graph — so the run's awaited sync gate
  // (`Runner.#syncCellsForRunningPattern()`) syncs the `internal`/`argument`
  // meta docs explicitly, and the persisted value is loaded before the
  // pattern (re)starts and renders.
  //
  // `activeTab` is intentionally internal-only here (never exported in
  // `result`), matching home.tsx where it is bound only to `<cf-tabs
  // $value={activeTab}>`.
  //
  // A fresh runtime sharing the same emulated store rehydrates from a cold
  // client cache, exercising the load path the gate is responsible for.

  let server: MemoryV2Server.Server;
  let sm1: EmulatedStorageManager;
  let sm2: EmulatedStorageManager;

  const pattern: Pattern = {
    argumentSchema: {},
    resultSchema: {},
    derivedInternalCells: [{
      partialCause: "activeTab",
      schema: { default: "spaces" },
    }],
    result: {},
    nodes: [],
  };

  const internalCellOf = (
    runtime: Runtime,
    resultCell: Cell<unknown>,
    partialCause: JSONValue,
  ) => {
    const manifest = resultCell.getMetaRaw("internal");
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest)).toBe(true);
    if (Array.isArray(manifest)) {
      for (const entry of manifest) {
        if (deepEqual(entry?.partialCause, partialCause)) {
          if ("link" in entry && isPrimitiveCellLink(entry?.link)) {
            const matchingCellLink = parseLink(entry.link, resultCell)!;
            return runtime.getCellFromLink(matchingCellLink);
          }
        }
      }
    }
    return undefined;
  };

  const internalLinkOf = (
    resultCell: Cell<unknown>,
    partialCause: JSONValue,
  ) => {
    const manifest = resultCell.getMetaRaw("internal");
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest)).toBe(true);
    if (Array.isArray(manifest)) {
      for (const entry of manifest) {
        if (deepEqual(entry?.partialCause, partialCause)) {
          expect(isPrimitiveCellLink(entry?.link)).toBe(true);
          return parseLink(entry.link, resultCell)!;
        }
      }
    }
    throw new Error(`Missing internal manifest entry for ${partialCause}`);
  };

  // Two storage managers that share ONE in-memory server (the persistence
  // boundary) but keep SEPARATE client caches. This models a reload: the second
  // runtime starts cold and must fetch persisted docs from the server, rather
  // than reading the first runtime's warm cache.
  beforeEach(() => {
    server = newSharedServer();
    sm1 = EmulatedStorageManager.connectTo(server, { as: signer });
    sm2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("preserves a user-set internal value across a cold-cache reload", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      // Session 1: first run seeds the build-time default, then the user picks
      // "profile". Persist it to the shared server.
      const rc1 = rt1.getCell<Record<string, never>>(space, "home-result");
      await rt1.runSynced(rc1, trustExecutable(rt1, pattern), {});
      await rc1.pull();

      const internal1 = internalCellOf(rt1, rc1, "activeTab")!;
      expect(internal1.get()).toEqual("spaces");

      const tx = rt1.edit();
      internal1.withTx(tx).set("profile");
      await tx.commit();
      await sm1.synced();
      expect(internal1.get()).toEqual("profile");

      // Session 2: a fresh runtime with a COLD cache rehydrates the SAME result
      // cell and re-runs the pattern through the awaited sync gate. The persisted
      // "profile" must survive — it must not be reverted to the build-time
      // default "spaces".
      const rc2 = rt2.getCell<Record<string, never>>(space, "home-result");
      await rt2.runSynced(rc2, trustExecutable(rt2, pattern), {});
      await rc2.pull();

      const internal2 = internalCellOf(rt2, rc2, "activeTab")!;
      expect(internal2.get()).toEqual("profile");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("names the argument document and the manifest cells when a cold cache starts the piece", async () => {
    // The result document carries its `argument` link and its `internal`
    // manifest as data, and a query naming the result delivers that data and
    // nothing the links point at. Starting the piece is what names the
    // targets: the run's dependency pre-sync syncs the argument document and
    // each cell the pattern's descriptors derive before the piece runs, so a
    // cold replica reads their persisted values rather than absent documents.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      const inputs = { selectedBy: "client-a" };
      const rc1 = rt1.getCell<Record<string, never>>(
        space,
        "home-result-query-materialization",
      );
      await rt1.runSynced(rc1, trustExecutable(rt1, pattern), inputs);
      await rc1.pull();

      const internal1 = internalCellOf(rt1, rc1, "activeTab")!;
      const tx = rt1.edit();
      internal1.withTx(tx).set("profile");
      await tx.commit();
      await sm1.synced();

      const internalLink = internalLinkOf(rc1, "activeTab");
      const argumentLink = getMetaLink(rc1, "argument");
      expect(argumentLink).toBeDefined();
      const provider2 = sm2.open(space) as unknown as {
        get(
          id: string,
          scope?: string,
        ):
          | { value?: unknown; argument?: unknown; internal?: unknown }
          | undefined;
      };
      expect(provider2.get(internalLink.id, internalLink.scope))
        .toBeUndefined();
      expect(provider2.get(argumentLink!.id, argumentLink!.scope))
        .toBeUndefined();

      const rc2 = rt2.getCell<Record<string, never>>(
        space,
        "home-result-query-materialization",
      );
      await rc2.sync();
      await sm2.synced();

      const resultDoc = provider2.get(
        rc2.getAsNormalizedFullLink().id,
        rc2.getAsNormalizedFullLink().scope,
      );
      expect(resultDoc).toBeDefined();
      expect(resultDoc?.internal).toBeDefined();
      expect(resultDoc?.argument).toBeDefined();
      expect(provider2.get(internalLink.id, internalLink.scope))
        .toBeUndefined();
      expect(provider2.get(argumentLink!.id, argumentLink!.scope))
        .toBeUndefined();

      // No argument given: the run replays the stored one, so the argument
      // document below is here because the pre-sync named it.
      await rt2.runSynced(rc2, trustExecutable(rt2, pattern));

      const internalDoc = provider2.get(internalLink.id, internalLink.scope);
      expect(internalDoc).toBeDefined();
      expect(internalDoc?.value).toEqual("profile");

      const argumentDoc = provider2.get(argumentLink!.id, argumentLink!.scope);
      expect(argumentDoc).toBeDefined();
      expect(argumentDoc?.value).toEqual(inputs);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
