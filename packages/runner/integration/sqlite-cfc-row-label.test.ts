#!/usr/bin/env -S deno run -A

/**
 * Integration test (CFC Phase 3, per-row data-derived labels): rows of a
 * rule-bearing table come back from `db.query` carrying DISTINCT per-row
 * confidentiality computed from each row's own columns (sender/recipients via
 * regex + the db owner), with integrity gated on the row's auth column —
 * through the REAL toolshed server (origin capture -> rule evaluation ->
 * per-row root label on each split row entity doc). Also: an aggregate on the
 * rule-bearing table fails closed, and a declared output ceiling with
 * onExceed:"skip" returns exactly the fitting rows.
 */

import { Identity } from "@commonfabric/identity";

import app from "../../toolshed/app.ts";
import { cfcLabelViewForDereferenceTraces } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function runTest(base: URL) {
  const account = await Identity.fromPassphrase(
    "sqlite-cfc-row-label " + crypto.randomUUID(),
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
  const owner = account.did(); // default trust snapshot: the signer

  try {
    const patternSource = await Deno.readTextFile(
      new URL("./sqlite-cfc-row-label.tsx", import.meta.url),
    );
    const pattern = await runtime.patternManager.compilePattern(patternSource, {
      space,
    });

    const resultCell = runtime.getCell(
      space,
      `sqlite-cfc-row-label-${crypto.randomUUID()}`,
      pattern.resultSchema,
    );
    const result = await runtime.runSynced(resultCell, pattern, {});
    const cancelSink = result.sink(() => {});

    try {
      await runtime.editWithRetry((tx) =>
        result.key("seed").withTx(tx).send({})
      );

      // Wait until all three queries settled (q + qSkim with rows, qCount
      // with an error).
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline) {
        await runtime.idle();
        await runtime.storageManager.synced();
        const qPending = result.key("q").key("pending").get() as unknown;
        const skimPending = result.key("qSkim").key("pending").get() as
          | boolean
          | unknown;
        const countPending = result.key("qCount").key("pending").get() as
          | boolean
          | unknown;
        const clearPending = result.key("qClear").key("pending").get() as
          | boolean
          | unknown;
        if (
          qPending === false && skimPending === false &&
          countPending === false && clearPending === false
        ) {
          const arr = result.key("q").key("result").getRaw() as
            | unknown[]
            | undefined;
          if (Array.isArray(arr) && arr.length === 2) {
            ready = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!ready) {
        const dump = (k: string) => {
          const q = result.key(k);
          return {
            pending: q.key("pending").getRaw(),
            error: q.key("error").getRaw(),
            result: q.key("result").getRaw(),
          };
        };
        throw new Error(
          "queries never settled; " + JSON.stringify({
            q: dump("q"),
            qCount: dump("qCount"),
            qSkim: dump("qSkim"),
          }),
        );
      }

      // THE POINT: distinct per-row labels, re-derived from row data.
      // Reading row[i] traverses pattern result -> query result -> the row's
      // own entity doc; the labels the consumer observes accumulate across
      // those dereferences (per-row ROOT label + per-column field labels).
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
        const integ: unknown[] = [];
        for (const entry of view?.entries ?? []) {
          for (const atom of entry.label.confidentiality ?? []) {
            conf.push(atom);
          }
          for (const atom of entry.label.integrity ?? []) integ.push(atom);
        }
        return { conf, integ };
      };

      const row0 = await rowLabel(0);
      const row1 = await rowLabel(1);

      const expectAtoms = (
        got: unknown[],
        want: unknown[],
        wantAbsent: unknown[],
        what: string,
      ) => {
        for (const w of want) {
          if (!got.some((g) => JSON.stringify(g) === JSON.stringify(w))) {
            throw new Error(
              `${what}: missing ${JSON.stringify(w)} in ${JSON.stringify(got)}`,
            );
          }
        }
        for (const w of wantAbsent) {
          if (got.some((g) => JSON.stringify(g) === JSON.stringify(w))) {
            throw new Error(
              `${what}: unexpected ${JSON.stringify(w)} in ${
                JSON.stringify(got)
              }`,
            );
          }
        }
      };

      // Row 0: alice -> bob, dmarc=pass. Normalized (Alice@A.example ->
      // alice@a.example), owner present, carol's participants ABSENT, and the
      // gated authored-by claim minted.
      expectAtoms(
        row0.conf,
        ["did:mailto:alice@a.example", "did:mailto:bob@example.com", owner],
        ["did:mailto:carol@c.example", "did:mailto:dave@d.example"],
        "row 0 confidentiality",
      );
      expectAtoms(
        row0.integ,
        [{
          kind: "claimed-authored-by",
          subject: "did:mailto:alice@a.example",
        }],
        [],
        "row 0 integrity",
      );

      // Row 1: carol -> dave+erin (dirty display-name list split by regex),
      // no dmarc -> NO authored-by claim; alice/bob ABSENT (distinctness).
      expectAtoms(
        row1.conf,
        [
          "did:mailto:carol@c.example",
          "did:mailto:dave@d.example",
          "did:mailto:erin@e.example",
          owner,
        ],
        ["did:mailto:alice@a.example", "did:mailto:bob@example.com"],
        "row 1 confidentiality",
      );
      expectAtoms(
        row1.integ,
        [],
        [{
          kind: "claimed-authored-by",
          subject: "did:mailto:carol@c.example",
        }],
        "row 1 integrity",
      );

      // Aggregate on a rule-bearing table fails closed.
      const countError = result.key("qCount").key("error").get() as unknown;
      if (
        typeof countError !== "string" || !countError.includes("aggregate")
      ) {
        throw new Error(
          `qCount should have failed closed; got error=${
            JSON.stringify(countError)
          } result=${
            JSON.stringify(result.key("qCount").key("result").getRaw())
          }`,
        );
      }

      // Declared ceiling + onExceed:"skip": exactly row 1 survives.
      const skim = result.key("qSkim").key("result").get() as
        | { id: number }[]
        | undefined;
      if (!Array.isArray(skim) || skim.length !== 1 || skim[0].id !== 1) {
        throw new Error(
          `qSkim should keep exactly the fitting row; got ${
            JSON.stringify(skim)
          } error=${JSON.stringify(result.key("qSkim").key("error").getRaw())}`,
        );
      }

      // Read-time clearance (Phase 3.b): the owner satisfies no row's
      // conjunctive rule (the did:mailto participants are required too), so a
      // cleared query returns zero rows and reports withheld: 2.
      const clearErr = result.key("qClear").key("error").getRaw();
      const cleared = result.key("qClear").key("result").get() as
        | unknown[]
        | undefined;
      const withheld = result.key("qClear").key("withheld").get() as unknown;
      if (clearErr !== undefined) {
        throw new Error(
          `qClear should not error; got ${JSON.stringify(clearErr)}`,
        );
      }
      if (!Array.isArray(cleared) || cleared.length !== 0) {
        throw new Error(
          `qClear should withhold every row for the owner; got ${
            JSON.stringify(cleared)
          }`,
        );
      }
      if (withheld !== 2) {
        throw new Error(
          `qClear should report withheld: 2; got ${JSON.stringify(withheld)}`,
        );
      }

      console.log(
        "=== TEST PASSED: per-row data-derived labels (distinct per row, " +
          "origin-resolved, integrity-gated); aggregate failed closed; " +
          "ceiling+skip returned exactly the fitting row; read-time clearance " +
          "withheld all rows the owner cannot read ===",
      );
    } finally {
      cancelSink();
    }
  } finally {
    await runtime.dispose();
  }
}

Deno.test({
  name: "sqlite per-row data-derived CFC labels (end to end)",
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
