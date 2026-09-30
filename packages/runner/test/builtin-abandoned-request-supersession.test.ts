/// <reference path="./clock.d.ts" />

/**
 * Whose cells a builtin's abandoned-request ending writes.
 *
 * The ending runs on cells a request may already hold, so it reads the store
 * as it stands and decides there. Two answers, and the store says which: a
 * request that is running holds its cells and the ending leaves them alone; a
 * request that finished holds nothing, and the ending replaces its answer,
 * which no longer describes the inputs the pattern is asking about.
 *
 * The refusal is arranged the way `builtin-abandoned-request.test.ts` arranges
 * it, with a caveat the sink's declared ceiling does not admit. What differs
 * here is that the refused request is not the node's first, so there is
 * committed state for the ending to decide against.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { createBuilder } from "../src/builder/factory.ts";
import { getPatternEnvironment, setPatternEnvironment } from "../src/env.ts";
import { Runtime } from "../src/runtime.ts";
import {
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
} from "../src/runtime-presets.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

/** A caveated string, as a cell an input slot can be pointed at later. */
const HOSTILE_STRING_SCHEMA = {
  type: "string",
  ifc: { confidentiality: [PROMPT_INFLUENCE] },
} as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => resolve = res);
  return { promise, resolve };
}

describe("whose cells an abandoned request's ending writes", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];
  let originalFetch: typeof globalThis.fetch;
  let originalPatternEnvironment: ReturnType<typeof getPatternEnvironment>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalPatternEnvironment = getPatternEnvironment();
    setPatternEnvironment({ apiUrl: new URL("http://mock-test-server.local") });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      cfcEnforcementMode: "enforce-strict",
      // The bundle declares a ceiling for the fetch and streamData sinks and
      // none for the LLM ones, so an LLM request is ungated on
      // confidentiality there. These cases are about the ENDING a refused
      // request leaves behind, so they declare the ceiling the refusal comes
      // from. Before the runtime's own stores declared what flowed into them,
      // the refusal arrived by accident instead: the builtin's result store
      // could not hold the caveat, so the transaction staging the request was
      // refused for a reason about the store rather than about the request.
      cfcSinkMaxConfidentiality: {
        ...MAX_ENFORCEMENT_SINK_CEILINGS,
        llm: [],
        llmDialog: [],
        generateText: [],
        generateObject: [],
        // The `sqliteQuery` sink is ungated under the bundle for a reason of
        // its own — the bound a read wants is the database's space, which a
        // clause list cannot hold — so the query case here declares the
        // ceiling its refusal comes from, as the llm cases above do.
        sqliteQuery: [],
      },
    });
    tx = runtime.edit();
    ({ commonfabric } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalPatternEnvironment);
    await tx.commit();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Resolve once a commit is refused by CFC enforcement. The scheduler reports
   * a terminal rejection and then, in the same turn, tells the work staged on
   * that transaction that no further attempt is coming — so a caller that
   * resumes on this has an ending that has already decided.
   */
  function waitForRefusal(): Promise<void> {
    const refused = deferred<void>();
    runtime.scheduler.onError((error: Error) => {
      if (error.message.includes("CFC enforcement rejected commit")) {
        refused.resolve();
      }
    });
    return refused.promise;
  }

  it("replaces a finished fetch's answer when the next request is refused", async () => {
    globalThis.fetch = (input: string | URL | Request) =>
      Promise.resolve(
        new Response(JSON.stringify({ from: String(input) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const { pattern, fetchJson } = commonfabric;
    const testPattern = pattern<{ url: string }>(({ url }) =>
      // deno-lint-ignore no-explicit-any
      fetchJson({ url } as any)
    );

    const hostileUrl = runtime.getCell<string>(
      space,
      "finished-fetch-hostile-url",
      HOSTILE_STRING_SCHEMA,
      tx,
    );
    hostileUrl.set("http://mock-test-server.local/api/hostile");
    const inputs = runtime.getCell<{ url: string }>(
      space,
      "finished-fetch-inputs",
      undefined,
      tx,
    );
    inputs.set({ url: "http://mock-test-server.local/api/first" });
    const resultCell = runtime.getCell(
      space,
      "finished-fetch-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, inputs, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const answered = await waitForCellValue<{ result?: { from?: string } }>(
      runtime,
      result,
      (value) => value?.result !== undefined,
    );
    expect(answered.result?.from).toContain("/api/first");

    // The finished request left its claim id standing with the pending flag
    // down. Pointing the input at the caveated url stages a request whose
    // commit is refused, so the ending decides against exactly that state.
    await runtime.editWithRetry((edit) => {
      // deno-lint-ignore no-explicit-any
      inputs.withTx(edit).key("url").set(hostileUrl as any);
    });

    const settled = await waitForCellValue<{ error?: string }>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
    // The answer the pattern was left holding described the url it no longer
    // asks about, so the ending clears it along with the flag.
    expect(result.withTx().key("result").get()).toBeUndefined();
  });

  it("leaves a running fetch's claim alone when the next request is refused", async () => {
    const issued = deferred<void>();
    const held = deferred<Response>();
    globalThis.fetch = () => {
      issued.resolve();
      return held.promise;
    };

    const { pattern, fetchJson } = commonfabric;
    const testPattern = pattern<{ url: string }>(({ url }) =>
      // deno-lint-ignore no-explicit-any
      fetchJson({ url } as any)
    );

    const hostileUrl = runtime.getCell<string>(
      space,
      "running-fetch-hostile-url",
      HOSTILE_STRING_SCHEMA,
      tx,
    );
    hostileUrl.set("http://mock-test-server.local/api/hostile");
    const inputs = runtime.getCell<{ url: string }>(
      space,
      "running-fetch-inputs",
      undefined,
      tx,
    );
    inputs.set({ url: "http://mock-test-server.local/api/held" });
    const resultCell = runtime.getCell(
      space,
      "running-fetch-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, inputs, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    // A reader has to demand the fetch before it is issued; the runtime's
    // disposal ends the subscription.
    result.sink(() => {});

    // The held response keeps the claim standing: the pending flag stays up
    // and the claim id stays that request's, which is the state the ending
    // must leave alone.
    await issued.promise;
    await waitForCellValue<{ pending?: boolean }>(
      runtime,
      result,
      (value) => value?.pending === true,
    );

    const refused = waitForRefusal();
    await runtime.editWithRetry((edit) => {
      // deno-lint-ignore no-explicit-any
      inputs.withTx(edit).key("url").set(hostileUrl as any);
    });
    // The re-run is what stages the refused request, and the builtin's own
    // scheduling decides when it happens; settling the clock runs it. Awaiting
    // the refusal after that is what says the ending ran at all, so the two
    // assertions below cannot pass on a request that was never staged.
    await result.pull();
    await clock.settle();
    await refused;

    // Asserted here, while the claim is still standing, so what holds the
    // pending flag up is the request the ending stepped around rather than
    // anything later in the case.
    expect(result.withTx().key("pending").get()).toBe(true);
    expect(result.withTx().key("error").get()).toBeUndefined();

    // Releasing the response settles the ending's own writeback, which is what
    // a commit the guard did not stop would ride. The released response writes
    // nothing itself: the run that changed the inputs aborted this request, and
    // its writeback compares against the inputs as they stand, which have moved.
    held.resolve(
      new Response(JSON.stringify({ from: "held" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await runtime.settled();

    expect(result.withTx().key("pending").get()).toBe(true);
    expect(result.withTx().key("error").get()).toBeUndefined();
  });

  it("replaces a finished query's rows when the next query is refused", async () => {
    const { pattern, sqliteQuery } = commonfabric;
    // A database of this case's own: the emulated engine keeps a file per
    // handle id, so a fixed id would carry one run's rows into the next.
    const db: SqliteDbRef = {
      id: `of:finished-query-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const seed = async (sql: string, params?: SqliteParamsWire) => {
      const seedTx = runtime.edit();
      seedTx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
      runtime.prepareTxForCommit(seedTx);
      const seeded = await seedTx.commit();
      if (seeded.error) throw seeded.error;
    };
    await seed("INSERT INTO notes (body) VALUES (?)", ["one"]);

    const hostileSql = runtime.getCell<string>(
      space,
      "finished-query-hostile-sql",
      HOSTILE_STRING_SCHEMA,
      tx,
    );
    hostileSql.set("SELECT body FROM notes");
    const inputs = runtime.getCell<{ sql: string }>(
      space,
      "finished-query-inputs",
      undefined,
      tx,
    );
    inputs.set({ sql: "SELECT id FROM notes" });

    const testPattern = pattern<{ sql: string }>(({ sql }) =>
      // deno-lint-ignore no-explicit-any
      sqliteQuery({ db, sql, reactOn: db } as any)
    );
    const resultCell = runtime.getCell(
      space,
      "finished-query-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, inputs, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const answered = await waitForCellValue<
      { result?: Array<Record<string, unknown>> }
    >(
      runtime,
      result,
      (value) => Array.isArray(value?.result),
    );
    expect(answered.result?.[0]).toEqual({ id: 1 });

    // The finished query left its request hash standing with the pending flag
    // down, and the statement the pattern asks about has moved on.
    await runtime.editWithRetry((edit) => {
      // deno-lint-ignore no-explicit-any
      inputs.withTx(edit).key("sql").set(hostileSql as any);
    });

    const settled = await waitForCellValue<{ error?: string }>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(result.withTx().key("pending").get()).toBe(false);
    expect(result.withTx().key("result").get()).toBeUndefined();
  });
});
