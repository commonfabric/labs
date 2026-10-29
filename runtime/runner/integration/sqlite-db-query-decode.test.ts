#!/usr/bin/env -S deno run -A

/**
 * Integration test: a typed `db.query<{ author_cf_link: Cell<User> }>` surfaces
 * a `_cf_link` result column as a LIVE Cell end to end — transformer rowSchema
 * injection (db.query<Row>) + runtime decode (sigil string -> object) + the
 * consumer's `<Row>` asCell read — through the REAL toolshed server. Also
 * exercises the imperative `db.exec` write folded into a handler commit against
 * the real server.
 */

import { Identity } from "@commonfabric/identity";

import app from "../../toolshed/app.ts";
import { Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    "sqlite-db-query-decode " + crypto.randomUUID(),
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
      new URL("./sqlite-db-query-decode.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `sqlite-db-query-decode-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    // Read through the COMPILED pattern.resultSchema — which the transformer
    // derived from the <Row> return type, so q.result.items.author_cf_link
    // carries asCell. No hand-written schema override.
    const result = await runtime.runSynced(resultCell, pattern, {});
    const cancelSink = result.sink(() => {});

    try {
      // Trigger the write+bump handler.
      await runtime.editWithRetry((tx) =>
        result.key("seed").withTx(tx).send({})
      );

      // Wait until the reactOn:version re-query reflects the inserted row.
      const deadline = Date.now() + 25000;
      let ready = false;
      while (Date.now() < deadline) {
        await runtime.idle();
        await runtime.storageManager.synced();
        if ((result.key("q").key("pending").get() as unknown) === false) {
          const arr = result.key("q").key("result").getRaw() as
            | unknown[]
            | undefined;
          if (Array.isArray(arr) && arr.length === 1) {
            ready = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!ready) {
        throw new Error("query never reflected the seeded row");
      }

      // Piece A: the runtime decoded the stored sigil-link STRING to a sigil
      // OBJECT (driven by the transformer-injected rowSchema for db.query<Row>).
      const colCell = result.key("q").key("result").key(0).key(
        "author_cf_link",
      );
      const sigil = colCell.getRaw();
      if (
        !sigil || typeof sigil !== "object" ||
        !("/" in (sigil as Record<string, unknown>))
      ) {
        throw new Error(
          `column is not a decoded sigil-link object: ${JSON.stringify(sigil)}`,
        );
      }
      // ...and the sigil link resolves to the author cell (round-trip).
      const linked = runtime.getCellFromLink(
        sigil as Parameters<typeof runtime.getCellFromLink>[0],
      );
      await linked.sync();
      const value = linked.get();
      if (JSON.stringify(value) !== JSON.stringify({ name: "Ada" })) {
        throw new Error(
          `linked cell resolved to ${
            JSON.stringify(value)
          }, expected {name:"Ada"}`,
        );
      }
      // The same column read under the consumer's <Row> asCell schema is proven
      // to surface a live Cell at the runtime level in
      // test/sqlite-query-rowschema-decode.test.ts.
      console.log(
        "=== TEST PASSED: typed db.query<Row> returned a decoded, resolvable _cf_link ===",
      );
    } finally {
      cancelSink();
    }
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "sqlite db.query<Row> _cf_link decode (end to end)",
  fn: async () => {
    const server = Deno.serve({ port: 0 }, app.fetch);
    const base = new URL(
      `http://${server.addr.hostname}:${server.addr.port}`,
    );
    try {
      await runTest(base);
    } finally {
      await server.shutdown();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
