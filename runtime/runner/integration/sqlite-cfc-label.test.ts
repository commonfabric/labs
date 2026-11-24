#!/usr/bin/env -S deno run -A

/**
 * Integration test (CFC Phase 2, read propagation): a `db.query` reading a
 * column declared confidential via per-column `ifc` makes the result CARRY that
 * confidentiality, so a downstream consumer inherits it — through the REAL
 * toolshed server and the real `db.query` builtin (server column-origin capture
 * -> labelResultSchema -> labeled result write). The query aliases the column
 * (`body AS secret`) to also prove labeling keys off the TRUE origin, not the
 * output name.
 */

import { Identity } from "@commonfabric/identity";

import app from "../../toolshed/app.ts";
import { cfcLabelViewForDereferenceTraces } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    "sqlite-cfc-label " + crypto.randomUUID(),
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
      new URL("./sqlite-cfc-label.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `sqlite-cfc-label-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    const result = await runtime.runSynced(resultCell, pattern, {});
    const cancelSink = result.sink(() => {});

    try {
      await runtime.editWithRetry((tx) =>
        result.key("seed").withTx(tx).send({})
      );

      // Wait until the reactOn:db re-query reflects the inserted row.
      const deadline = Date.now() + 25000;
      let ready = false;
      while (Date.now() < deadline) {
        await runtime.idle();
        await runtime.storageManager.synced();
        const arr = result.key("q").key("rows").getRaw() as
          | unknown[]
          | undefined;
        if (Array.isArray(arr) && arr.length === 1) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!ready) {
        throw new Error(
          "query never reflected the seeded row; q=" +
            JSON.stringify(result.key("q").getRaw()),
        );
      }

      // The row read back correctly (aliased output name `secret`). Each row is
      // split into its own entity doc, so `.key(0)` is a link — `.get()`
      // dereferences it to the row value.
      const row = result.key("q").key("rows").key(0).get() as
        | Record<string, unknown>
        | undefined;
      if (!row || row.secret !== "top secret") {
        throw new Error(`unexpected row: ${JSON.stringify(row)}`);
      }

      // THE POINT: a consumer reading `q.rows[0].secret` inherits `body`'s
      // confidentiality. As that read TRAVERSES the links (pattern result ->
      // query result cell -> per-row entity doc), the runtime accumulates
      // dereference traces, and the confidentiality the consumer observes is
      // computed from those traces. This is exactly how the column's label
      // "comes back out of SQLite" and is re-established across the opaque
      // SQLite boundary.
      const dtx = runtime.edit();
      const leaf = result.key("q").key("rows").key(0).key("secret").withTx(
        dtx,
      );
      leaf.get(); // traverse the links -> populate dtx.dereferenceTraces
      const view = cfcLabelViewForDereferenceTraces(
        dtx,
        dtx.getCfcState().dereferenceTraces,
      );
      const conf = cfcConfidentialityForObservationNode({
        labelView: view,
        logicalPath: [],
      });
      await dtx.commit().settled;
      if (!conf.some((a) => a === "secret-body")) {
        throw new Error(
          `result row did not inherit the column confidentiality; got ${
            JSON.stringify(conf)
          }`,
        );
      }
      console.log(
        "=== TEST PASSED: db.query labeled an aliased confidential column; " +
          "the result carries confidentiality:[secret-body] ===",
      );
    } finally {
      cancelSink();
    }
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "sqlite db.query read-label propagation (end to end)",
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
