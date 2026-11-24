#!/usr/bin/env -S deno run -A

/**
 * Integration test (CFC Phase 2): a single `db.query` that projects BOTH a
 * CFC-labeled column AND an asCell `_cf_link` column. The labeled-write path
 * (rows written under the per-field label schema) must NOT break link decoding:
 * the consumer must (a) inherit the labeled column's confidentiality AND (b)
 * resolve the link column to a live Cell — through the real toolshed server.
 */

import { Identity } from "@commonfabric/identity";

import app from "../../toolshed/app.ts";
import { cfcLabelViewForDereferenceTraces } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    "sqlite-cfc-label-link " + crypto.randomUUID(),
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
      new URL("./sqlite-cfc-label-link.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `sqlite-cfc-label-link-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    const result = await runtime.runSynced(resultCell, pattern, {});
    const cancelSink = result.sink(() => {});

    try {
      await runtime.editWithRetry((tx) =>
        result.key("seed").withTx(tx).send({})
      );

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
      if (!ready) throw new Error("query never reflected the seeded row");

      // (a) The link column still decoded to a resolvable sigil-link object and
      // round-trips to the author cell — labeling did not corrupt it.
      const sigil = result.key("q").key("rows").key(0).key("author_cf_link")
        .getRaw();
      if (
        !sigil || typeof sigil !== "object" ||
        !("/" in (sigil as Record<string, unknown>))
      ) {
        throw new Error(
          `link column is not a decoded sigil-link object: ${
            JSON.stringify(sigil)
          }`,
        );
      }
      const linked = runtime.getCellFromLink(
        sigil as Parameters<typeof runtime.getCellFromLink>[0],
      );
      await linked.sync();
      if (JSON.stringify(linked.get()) !== JSON.stringify({ name: "Ada" })) {
        throw new Error(
          `linked cell resolved to ${
            JSON.stringify(linked.get())
          }, expected {name:"Ada"}`,
        );
      }

      // (b) A consumer reading `q.rows[0].note` inherits its confidentiality
      // (via dereference-trace accumulation as the read traverses the links).
      const dtx = runtime.edit();
      result.key("q").key("rows").key(0).key("note").withTx(dtx).get();
      const view = cfcLabelViewForDereferenceTraces(
        dtx,
        dtx.getCfcState().dereferenceTraces,
      );
      const conf = cfcConfidentialityForObservationNode({
        labelView: view,
        logicalPath: [],
      });
      await dtx.commit().settled;
      if (!conf.some((a) => a === "secret-note")) {
        throw new Error(
          `note did not inherit confidentiality; got ${JSON.stringify(conf)}`,
        );
      }

      console.log(
        "=== TEST PASSED: labeled column + asCell link column coexist; the " +
          "consumer inherits confidentiality:[secret-note] AND resolves the link ===",
      );
    } finally {
      cancelSink();
    }
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "sqlite db.query labeled column + asCell link column (end to end)",
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
