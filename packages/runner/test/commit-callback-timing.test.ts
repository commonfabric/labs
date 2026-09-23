// The accepted-commit half of the verdict/commit callback split (the rejection
// half lives in commit-conflict-reconcile.test.ts): on accept, the verdict
// callback fires at the verdict, while the commit callback and the commit
// promise wait for marker coverage. The runtime talks to a real
// MemoryV2Server through the plain loopback transport, so the verdict
// arrives on a zero-delay delivery turn — inside a clock.settle() drain —
// while the coverage marker rides the server's TIMED fan-out, whose
// positive-delay timer the drain leaves unfired (settle pauses
// auto-advance).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("commit-callback-timing");
const space = signer.did();

describe("commit callback timing", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("fires the verdict callback at the accept verdict, the commit callback and promise at coverage", async () => {
    const cell = runtime.getCell<{ v: string }>(
      space,
      "accept-timing-doc",
      undefined,
    );
    {
      const tx = runtime.edit();
      cell.withTx(tx).set({ v: "v0" });
      runtime.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // A live watch makes accepts PARK: coverage now needs the marker.
    await cell.sync();
    await cell.pull();
    expect(cell.get()).toEqual({ v: "v0" });

    const tx = runtime.edit();
    cell.withTx(tx).set({ v: "v1" });
    runtime.prepareTxForCommit(tx);

    let verdictResult: { error?: unknown } | undefined;
    tx.addVerdictCallback((_tx, result) => {
      verdictResult = result;
    });
    let commitCallbackFired = false;
    tx.addCommitCallback(() => {
      commitCallbackFired = true;
    });
    let promiseSettled = false;
    const commitP = tx.commit().then((result) => {
      promiseSettled = true;
      return result;
    });

    // Held-clock fixpoint: the accept verdict has arrived (its delivery
    // turn fires inside the drain), the coverage marker has not (the timed
    // fan-out's positive-delay timer stays unfired while settle pauses
    // auto-advance).
    await clock.settle();
    expect(verdictResult, "verdict callback fired at the accept verdict")
      .toBeDefined();
    expect(verdictResult?.error, "verdict callback saw the accept")
      .toBeUndefined();
    expect(
      commitCallbackFired,
      "commit callback still waiting for coverage",
    ).toBe(false);
    expect(promiseSettled, "commit promise still waiting for coverage")
      .toBe(false);

    // The await yields to auto-advance: the fan-out timer fires, the
    // marker arrives, the promise resolves, and the commit callback fires
    // with the same accepted result.
    const res = await commitP;
    expect(res.error, `commit: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(commitCallbackFired, "commit callback fired at coverage").toBe(true);
    expect(cell.get()).toEqual({ v: "v1" });
  });

  it("settles an accepted resolveAt-verdict promise at the verdict, while its commit callback waits for coverage", async () => {
    const cell = runtime.getCell<{ v: string }>(
      space,
      "accept-verdict-mode-doc",
      undefined,
    );
    {
      const tx = runtime.edit();
      cell.withTx(tx).set({ v: "v0" });
      runtime.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    await cell.sync();
    await cell.pull();
    expect(cell.get()).toEqual({ v: "v0" });

    const tx = runtime.edit();
    cell.withTx(tx).set({ v: "v1" });
    runtime.prepareTxForCommit(tx);

    const commitCallbackDone = Promise.withResolvers<void>();
    let commitCallbackFired = false;
    tx.addCommitCallback(() => {
      commitCallbackFired = true;
      commitCallbackDone.resolve();
    });
    let verdictModeResult: { error?: unknown } | undefined;
    const commitP = tx.commit({ resolveAt: "verdict" }).then((result) => {
      verdictModeResult = result;
      return result;
    });

    // Held-clock fixpoint: the verdict-mode promise has settled with the
    // accept, but the commit callback — on the full settlement timeline —
    // is still gated on the coverage marker the timed fan-out has not
    // delivered.
    await clock.settle();
    expect(verdictModeResult, "verdict-mode promise settled at the verdict")
      .toBeDefined();
    expect(verdictModeResult?.error, "the accept reached the caller")
      .toBeUndefined();
    expect(
      commitCallbackFired,
      "commit callback still waiting for coverage",
    ).toBe(false);

    // The await yields to auto-advance: the fan-out timer fires, the
    // marker arrives, and the settlement timeline — and with it the commit
    // callback — completes.
    await commitP;
    await commitCallbackDone.promise;
    expect(commitCallbackFired).toBe(true);
    expect(cell.get()).toEqual({ v: "v1" });
  });

  it("resolves a coverage commit on a doc outside the watch set via the marker-only frame", async () => {
    // A live watch on an UNRELATED doc makes accepts park on coverage.
    const watched = runtime.getCell<{ v: string }>(
      space,
      "unwatched-set-watched-doc",
      undefined,
    );
    {
      const tx = runtime.edit();
      watched.withTx(tx).set({ v: "w" });
      runtime.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }
    await watched.sync();
    await watched.pull();

    // The set targets a doc NO watch covers: its coverage marker cannot
    // ride any document delivery — only the otherwise-empty marker frame
    // the accept's catch-up obligation forces. The promise resolving IS
    // the pin: a server that stamped markers only on document-bearing
    // frames would hold this await forever.
    const unwatched = runtime.getCell<{ v: string }>(
      space,
      "unwatched-set-target-doc",
      undefined,
    );
    const tx = runtime.edit();
    unwatched.withTx(tx).set({ v: "x" });
    runtime.prepareTxForCommit(tx);
    const res = await tx.commit();
    expect(res.error, `commit: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(unwatched.get()).toEqual({ v: "x" });
  });
});
