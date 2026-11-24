import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  type UnavailableVariant,
} from "@commonfabric/data-model/availability";
/// <reference path="./clock.d.ts" />

/**
 * What a refused `fetchProgram` takeover leaves behind.
 *
 * A cache entry says who is resolving a program, and a replica that finds one
 * older than the staleness bound takes it over, because nothing reports whether
 * the replica that made it is still there. The takeover's own claim rides the
 * transaction that stages the request, so a refused commit leaves the entry
 * exactly as the other replica wrote it — and that replica may still be
 * resolving. The ending reads the entry and steps around anything that is not
 * idle, so a resolution running elsewhere keeps its entry and reaches its
 * result.
 *
 * Two replicas on one memory server are what make that arrangement real. The
 * holder keeps a program request open; the taker is the one whose commit is
 * refused, by the caveat `builtin-abandoned-request.test.ts` uses. Only the
 * taker enforces, so only the taker's commit is refused, and both run the same
 * pattern over the same argument and result cells, which is what puts their two
 * nodes on one cache document.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { getPatternEnvironment, setPatternEnvironment } from "../src/env.ts";
import { Runtime } from "../src/runtime.ts";
import { MAX_ENFORCEMENT_CFC_OPTIONS } from "../src/runtime-presets.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

// Well past the bound `fetchProgram` treats a claim as stale after, so the
// taker's run finds an entry it is entitled to take over.
const PAST_THE_STALENESS_BOUND = 60_000;

const PROGRAM_URL = "http://mock-test-server.local/held-program.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => resolve = res);
  return { promise, resolve };
}

function moduleResponse(): Response {
  return new Response("export const value = 1;\n", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("a refused fetchProgram takeover", () => {
  let server: MemoryV2Server.Server;
  let holderStorage: EmulatedStorageManager;
  let takerStorage: EmulatedStorageManager;
  let holder: Runtime;
  let taker: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let originalPatternEnvironment: ReturnType<typeof getPatternEnvironment>;
  let released = false;
  let issued: Deferred<void>;
  let held: Deferred<Response>;

  beforeEach(() => {
    originalPatternEnvironment = getPatternEnvironment();
    setPatternEnvironment({ apiUrl: new URL("http://mock-test-server.local") });
    originalFetch = globalThis.fetch;
    // Program resolution reaches for the global rather than the runtime's own
    // fetch. Only the holder's request is ever issued: the taker's commit is
    // refused before its own would go out.
    released = false;
    issued = deferred<void>();
    held = deferred<Response>();
    globalThis.fetch = () => {
      issued.resolve();
      // The holder's first request is the one that is held; once it is
      // released, the resolver's remaining requests are answered directly.
      return released ? Promise.resolve(moduleResponse()) : held.promise;
    };
    server = new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
    holderStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    takerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    holder = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: holderStorage,
    });
    taker = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: takerStorage,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      cfcEnforcementMode: "enforce-strict",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalPatternEnvironment);
    released = true;
    held.resolve(moduleResponse());
    await taker.dispose();
    await holder.dispose();
    await takerStorage.close();
    await holderStorage.close();
  });

  /** Start the shared pattern on `runtime`, over the shared argument cell. */
  async function runOn(runtime: Runtime) {
    const { pattern, fetchProgram } = createTrustedBuilder(runtime)
      .commonfabric;
    const testPattern = pattern<{ url: string }>(({ url }) =>
      // deno-lint-ignore no-explicit-any
      fetchProgram({ url } as any)
    );
    const tx = runtime.edit();
    const inputs = runtime.getCell<{ url: string }>(
      space,
      "takeover-inputs",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell(
      space,
      "takeover-result",
      testPattern.resultSchema,
      tx,
    );
    await inputs.sync();
    const result = runtime.run(tx, testPattern, inputs, resultCell);
    runtime.prepareTxForCommit(tx);
    return { result, committed: tx.commit().settled };
  }

  it("leaves the running replica's claim alone", async () => {
    // A plain url to begin with: the holder claims the entry under it, and the
    // taker's first run has to see that claim, which means its own cache
    // document has to be loaded before the run that stages a takeover. The
    // builtin loads that document from inside its first run, so the taker runs
    // once here against a claim that is not yet stale — it stages nothing, and
    // what it leaves behind is a warm cache view.

    const seedTx = holder.edit();
    const seedInputs = holder.getCell<{ url: string }>(
      space,
      "takeover-inputs",
      undefined,
      seedTx,
    );
    seedInputs.set({ url: PROGRAM_URL });
    holder.prepareTxForCommit(seedTx);
    const seeded = await seedTx.commit().settled;
    if (seeded.error) throw seeded.error;

    const holderRun = await runOn(holder);
    await holderRun.committed;
    await holderRun.result.pull();
    await issued.promise;

    const takerRun = await runOn(taker);
    await takerRun.committed;
    await takerRun.result.pull();
    await clock.settle();
    // The taker is reading the holder's claim rather than an empty cache, so
    // the run below decides against a claim that is really there.
    expect(takerRun.result.withTx().get()).toBe(UNAVAILABLE_PENDING);

    const refused = deferred<void>();
    taker.scheduler.onError((error: Error) => {
      if (error.message.includes("CFC enforcement rejected commit")) {
        refused.resolve();
      }
    });

    // Age the holder's claim past the bound before anything re-runs the
    // taker, so the run the slot change below triggers is entitled to take
    // the claim over and therefore stages a request at all. A run against a
    // claim still inside the bound stages nothing and leaves the node clean,
    // and aging the claim afterwards re-runs nothing.
    await clock.tick(PAST_THE_STALENESS_BOUND);

    // Point the url slot at a caveated cell holding the same url. The request
    // is the same request — same hash, same cache entry — and the read that
    // builds it now carries a confidentiality the taker's result store does
    // not declare, so the transaction staging it is refused.
    const caveatTx = taker.edit();
    const hostileUrl = taker.getCell<string>(
      space,
      "takeover-hostile-url",
      { type: "string", ifc: { confidentiality: [PROMPT_INFLUENCE] } },
      caveatTx,
    );
    hostileUrl.set(PROGRAM_URL);
    const takerInputs = taker.getCell<{ url: string }>(
      space,
      "takeover-inputs",
      undefined,
      caveatTx,
    );
    // deno-lint-ignore no-explicit-any
    takerInputs.withTx(caveatTx).key("url").set(hostileUrl as any);
    taker.prepareTxForCommit(caveatTx);
    const caveated = await caveatTx.commit().settled;
    if (caveated.error) throw caveated.error;

    await takerRun.result.pull();
    await clock.settle();
    await refused.promise;
    await taker.settled();

    // Nothing of the ending landed: the entry is still the holder's, so the
    // taker reports no refusal over a resolution that is still running.
    expect(takerRun.result.withTx().get()).toBe(UNAVAILABLE_PENDING);

    // And the holder's resolution still reaches its result.
    released = true;
    held.resolve(moduleResponse());
    const resolved = await waitForCellValue<
      { main?: string } | UnavailableVariant
    >(
      holder,
      holderRun.result,
      (value) => !isUnavailable(value) && value?.main !== undefined,
    );
    expect(isUnavailable(resolved)).toBe(false);
    if (!isUnavailable(resolved)) {
      expect(resolved.main).toBe("/held-program.ts");
    }
  });
});
