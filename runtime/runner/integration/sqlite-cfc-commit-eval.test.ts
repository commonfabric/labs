#!/usr/bin/env -S deno run -A

/**
 * Integration test (CFC Phase 3.c): SERVER-SIDE commit-time row-label
 * re-derivation, through the REAL toolshed server. The runner's write gate —
 * seeing the server advertise `sqliteCommitRowLabelEval` — admits the shapes
 * it cannot attribute (INSERT…SELECT, upsert), and the server evaluates the
 * SHARED rule against the TRUE committed rows inside the commit transaction:
 *
 *  - an INSERT…SELECT that would commit a rule-violating row rolls back
 *    ATOMICALLY — nothing persists, not even the valid rows riding the same
 *    statement;
 *  - an upsert re-derives from the POST-IMAGE: a violating flip rolls back
 *    (the old row survives), a valid flip lands and the read side re-derives
 *    the row's label from the NEW value.
 */

import { Identity } from "@commonfabric/identity";

import app from "../../toolshed/app.ts";
import { cfcLabelViewForDereferenceTraces } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    "sqlite-cfc-commit-eval " + crypto.randomUUID(),
  );
  const runtime = new Runtime({
    apiUrl: base,
    // Server-execution v2 posture (testing.md §2): this test serves
    // toolshed's `app.ts` IN-PROCESS (`Deno.serve` below) with NO
    // ExecutorHost, so it is a single-process harness — client and memory
    // server in one process, nothing serving — and its client is OFF BY
    // CONSTRUCTION, whatever EXPERIMENTAL_SERVER_EXECUTION says (a flag-ON
    // client here would divert its derivations to a server that does not
    // exist and wedge). The CI ON lane's env does not reach this file;
    // only the tests that talk to the lane's toolshed (API_URL) declare
    // the posture from the env (P7 review finding 7).
    storageManager: StorageManager.open({
      as: account,
      memoryHost: new URL(base),
    }),
  });
  const space = account.did();

  try {
    const patternSource = await Deno.readTextFile(
      new URL("./sqlite-cfc-commit-eval.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `sqlite-cfc-commit-eval-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    const result = await runtime.runSynced(resultCell, pattern, {});
    const cancelSink = result.sink(() => {});

    const send = (key: string) =>
      runtime.editWithRetry((tx) => result.key(key).withTx(tx).send({}));

    // NOTE: a handler whose commit the server refuses (a RowLabelCommitError)
    // is now classified as a TERMINAL rejection and runs exactly once — it does
    // NOT re-run through the scheduler's retry budget (storage/rejection.ts
    // `isTerminalRejection`; server preserves the class name). So the next
    // handler can be sent immediately: there are no doomed re-runs whose
    // speculative rev bumps would starve the successor's commit, and no drain is
    // needed between sends. If this test flakes, that classification regressed.

    const dumpQ = (k: string) => ({
      pending: result.key(k).key("pending").getRaw(),
      error: result.key(k).key("error").getRaw(),
      result: result.key(k).key("result").getRaw(),
    });

    // Poll until `q` (and staging) reflect `predicate`; settles the scheduler
    // and storage between probes so terminally-rejected commits drain too.
    const waitFor = async (
      what: string,
      predicate: () => boolean,
      ms = 30000,
    ) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await runtime.idle();
        await runtime.storageManager.synced();
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(
        `${what} never settled; q=${JSON.stringify(dumpQ("q"))} qStaging=${
          JSON.stringify(dumpQ("qStaging"))
        }`,
      );
    };

    // Row COUNT probes read the raw array (links); row CONTENT reads resolve.
    const qRowCount = () =>
      ((result.key("q").key("result").getRaw() ?? []) as unknown[]).length;
    const qRows = () =>
      (result.key("q").key("result").get() ?? []) as {
        id: number;
        from_addr: string;
      }[];

    try {
      // Seed: one valid guarded row; staging = 1 valid + 1 violating.
      await send("seed");
      await waitFor(
        "seed",
        () =>
          (result.key("q").key("pending").get() as unknown) === false &&
          qRowCount() === 1 &&
          (result.key("qStaging").key("result").getRaw() as unknown[])
              ?.length === 2,
      );

      // THE POINT (rollback): copy EVERY staging row into the guarded
      // table. The runner gate admits the INSERT…SELECT (the server
      // advertised 3.c); the server evaluates the two committed rows, the
      // violating one refuses, and the WHOLE statement rolls back.
      await send("copyBad");
      // The failed commit rolls back the db-handle rev bump too, so `q` does
      // not re-run for it; the next SUCCESSFUL write re-queries server truth.
      await send("copyGood");
      await waitFor(
        "copyGood after rolled-back copyBad",
        () => qRowCount() === 2,
      );
      // Exactly the seed row + ONE valid copy. Had copyBad half-persisted,
      // carol would appear twice (or the junk sender at all).
      const afterCopy = qRows();
      if (
        afterCopy[0].from_addr !== "alice@a.example" ||
        afterCopy[1].from_addr !== "carol@c.example" ||
        afterCopy.some((r) => r.from_addr === "not an address")
      ) {
        throw new Error(
          `copyBad must roll back atomically; got ${JSON.stringify(afterCopy)}`,
        );
      }

      // Upsert, violating post-image: row 2's sender flips to junk ->
      // the server re-derives the post-image, refuses, rolls back.
      await send("upsertBad");
      // Upsert, valid post-image: row 1's sender flips to carol2. Its
      // successful commit bumps the handle rev, forcing a FRESH query cycle
      // against server truth (no dependency on rolled-back speculation).
      await send("upsertGood");
      await waitFor(
        "upserts settled",
        () =>
          qRowCount() === 2 &&
          qRows()[0]?.from_addr === "carol2@c.example",
        60000,
      );
      const afterUpserts = qRows();
      if (afterUpserts[1].from_addr !== "carol@c.example") {
        throw new Error(
          `upsertBad must roll back (row 2 keeps its sender); got ${
            JSON.stringify(afterUpserts)
          }`,
        );
      }

      // The read side re-derives row 1's label from the POST-IMAGE.
      const rowLabel = async (i: number) => {
        const dtx = runtime.edit();
        const leaf = result.key("q").key("result").key(i).key("body")
          .withTx(dtx);
        leaf.get();
        const view = cfcLabelViewForDereferenceTraces(
          dtx,
          dtx.getCfcState().dereferenceTraces,
        );
        await dtx.commit().settled;
        const conf: unknown[] = [];
        for (const entry of view?.entries ?? []) {
          for (const atom of entry.label.confidentiality ?? []) {
            conf.push(atom);
          }
        }
        return conf.map((a) => JSON.stringify(a));
      };
      const row0 = await rowLabel(0);
      if (!row0.includes(JSON.stringify("did:mailto:carol2@c.example"))) {
        throw new Error(
          `row 1's label must re-derive from the upserted sender; got ${row0}`,
        );
      }
      if (row0.includes(JSON.stringify("did:mailto:alice@a.example"))) {
        throw new Error(
          `row 1's label must NOT keep the pre-upsert sender; got ${row0}`,
        );
      }

      console.log(
        "=== TEST PASSED: 3.c server commit evaluation — violating " +
          "INSERT…SELECT rolled back atomically; upsert re-derived from the " +
          "post-image (violating flip rolled back, valid flip relabeled) ===",
      );
    } finally {
      cancelSink();
    }
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "sqlite CFC 3.c server-side commit-time re-derivation (end to end)",
  fn: async () => {
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
    try {
      await runTest(base);
    } finally {
      await server.shutdown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
