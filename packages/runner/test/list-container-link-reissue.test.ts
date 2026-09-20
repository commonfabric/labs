import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { isRawBuiltinResult, raw } from "../src/module.ts";
import { map } from "../src/builtins/map.ts";
import { filter } from "../src/builtins/filter.ts";
import { flatMap } from "../src/builtins/flatmap.ts";

// A list coordinator mints its result container and then holds it in memory
// across reconciles. The link that makes the container reachable is a write
// like any other: the reconcile carrying it can fail to commit.
//
// `sendResult` writes the link from the node's output spot to the container the
// coordinator mints. A later reconcile takes the `result` the coordinator
// already holds in memory, and unless the link is owed it writes the
// container's VALUE alone. The per-element setup writes have a ledger for
// exactly this — `trackListSetupRollback` marks each element `needsSetup` when
// the transaction carrying its writes fails, stale basis included, so the next
// reconcile issues them again. The container link is on that ledger too:
// `issueResultContainerSetup()` records it as issued, and a reconcile that
// finds the record marked `needsSetup` issues the link again against the
// container already in hand. A container that nothing points at would leave
// the output spot reading `undefined` for as long as the coordinator lives.
//
// Each coordinator gets the same two runs, differing only in whether its first
// reconcile commits, so the rejection is what they isolate:
//
//   1. Runtime A builds the durable aggregate, then empties the node's output
//      spot. That is the state a session starts in when the spot is a fresh
//      holder over a container that persists at space scope: the container and
//      its per-element runs are durable, and the link to them is not.
//   2. Runtime B resumes over that state. On a COLD replica the container is
//      unreachable from the emptied spot, so B never loads it, and the
//      coordinator's first reconcile reads it as absent — a confirmed read at
//      seq 0 against a document the server holds at a later seq, which the
//      server rejects as a stale basis. Nothing here is timed: whether B holds
//      the container is decided by whether anything links to it, so the
//      rejection is a property of the arrangement rather than of the schedule.
//   3. On a WARM replica B already holds every document, the same first
//      reconcile commits, and the link comes back. That control is what pins
//      the rejection, rather than the emptied spot, as the cause.
//
// `map`, `filter` and `flatMap` carry the same guard and the same single
// `sendResult` call site.

const signer = await Identity.fromPassphrase("list container link reissue");
const space = signer.did();

class SharedSessionFactory implements SessionFactory {
  readonly #getServer: () => MemoryV2Server.Server;

  constructor(getServer: () => MemoryV2Server.Server) {
    this.#getServer = getServer;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#getServer()),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}

class SharedServerStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
  ): SharedServerStorageManager {
    return new SharedServerStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new SharedSessionFactory(() => server));
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

const makeServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

/** How one reconcile of the coordinator under test went. */
type ReconcileRecord = {
  attempt: number;

  /** Whether this reconcile called `sendResult`, the container link's only writer. */
  issuedLink: boolean;

  outcome: string;
};

// The three list builtins, each with a program whose aggregate the coordinator
// owns and the value that aggregate holds once it has converged.
const COORDINATORS = [
  {
    name: "map",
    // deno-lint-ignore no-explicit-any
    implementation: map as any,
    body: "items.map((n) => n * 2)",
    expected: [2, 4, 6],
  },
  {
    name: "filter",
    // deno-lint-ignore no-explicit-any
    implementation: filter as any,
    body: "items.filter((n) => n > 1)",
    expected: [2, 3],
  },
  {
    name: "flatMap",
    // deno-lint-ignore no-explicit-any
    implementation: flatMap as any,
    body: "items.flatMap((n) => n * 2)",
    expected: [2, 4, 6],
  },
] as const;

const programFor = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: number[] }>(({ items }) => {",
      `  return { aggregate: ${body} };`,
      "});",
    ].join("\n"),
  }],
});

/**
 * Re-register a list builtin so the test can see how many times the
 * coordinator issued its container link and how each reconcile's transaction
 * settled. The coordinator, its rollback bookkeeping and its writes are the
 * real ones; only the reporting is added.
 */
function observeCoordinator(
  runtime: Runtime,
  ref: string,
  // deno-lint-ignore no-explicit-any
  implementation: any,
): { issued: Cell<unknown[]>[]; log: ReconcileRecord[] } {
  const issued: Cell<unknown[]>[] = [];
  const log: ReconcileRecord[] = [];
  runtime.moduleRegistry.addModuleByRef(
    ref,
    raw((
      inputsCell,
      sendResult,
      addCancel,
      cause,
      parentCell,
      rt,
      outputBinding,
      awaitSync,
      // deno-lint-ignore no-explicit-any
    ): any => {
      const built = implementation(
        inputsCell,
        // deno-lint-ignore no-explicit-any
        (tx: IExtendedStorageTransaction, value: any) => {
          issued.push(value as Cell<unknown[]>);
          sendResult(tx, value);
        },
        addCancel,
        cause,
        parentCell,
        rt,
        outputBinding,
        awaitSync,
      );
      const action = isRawBuiltinResult(built) ? built.action : built;
      let attempts = 0;
      const observed = (tx: IExtendedStorageTransaction) => {
        const attempt = ++attempts;
        const before = issued.length;
        action(tx);
        const issuedLink = issued.length > before;
        tx.addCommitCallback((_settled, result) => {
          log.push({
            attempt,
            issuedLink,
            outcome: result.error ? `rejected:${result.error.name}` : "commits",
          });
        });
      };
      return isRawBuiltinResult(built)
        ? { ...built, action: observed }
        : observed;
      // deno-lint-ignore no-explicit-any
    }) as any,
  );
  return { issued, log };
}

type ResumeOutcome = {
  aggregate: unknown;
  container: unknown;
  issuedCount: number;
  log: ReconcileRecord[];
};

/**
 * Build the aggregate in one runtime, empty the node's output spot, and resume
 * in a second runtime. `replica` decides what that second runtime knows when
 * its coordinator first reconciles: a `warm` replica already holds the
 * container and its per-element runs, so the reconcile commits; a `cold` one
 * has never seen them — nothing links to them while the spot is empty — so the
 * reconcile reads them as absent and the server rejects its commit against its
 * own later sequence numbers.
 */
async function resumeOverEmptiedSpot(
  coordinator: typeof COORDINATORS[number],
  cellId: string,
  { replica }: { replica: "warm" | "cold" },
): Promise<ResumeOutcome> {
  const program = programFor(coordinator.body);
  const server = makeServer();
  const sm1 = SharedServerStorageManager.make(signer, server);
  const sm2 = replica === "warm"
    ? sm1
    : SharedServerStorageManager.make(signer, server);

  const rt1 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm1,
  });
  let spotLink: NormalizedFullLink;
  let containerLink: NormalizedFullLink;
  try {
    const compiled = await rt1.patternManager.compilePattern(program, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<Record<string, unknown>>(
      space,
      cellId,
      compiled.resultSchema,
      tx0,
    );
    rt1.run(tx0, compiled, { items: [1, 2, 3] }, rc1);
    expect((await tx0.commit()).error).toBeUndefined();
    await rc1.pull();
    await rt1.settled();
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(
      rc1.key("aggregate").getAsQueryResult(),
      "the first runtime built the aggregate",
    ).toEqual(coordinator.expected);

    // The node's output spot, and the container it points at. The spot is the
    // write-redirect target of the aggregate key; `sendResult` writes the
    // container's link into it, and nothing else ever does.
    const probeTx = rt1.edit();
    spotLink = resolveLink(
      rt1,
      probeTx,
      rc1.key("aggregate").getAsNormalizedFullLink(),
      "writeRedirect",
    );
    containerLink = rc1.key("aggregate").resolveAsCell()
      .getAsNormalizedFullLink();
    probeTx.abort("output spot probe");

    // Empty the spot, leaving the container and its per-element runs durable.
    const clearTx = rt1.edit();
    rt1.getCellFromLink(spotLink, undefined, clearTx).setRaw(undefined);
    rt1.prepareTxForCommit(clearTx);
    expect((await clearTx.commit()).error).toBeUndefined();
    await rt1.settled();
    await sm1.synced();
    expect(
      rc1.key("aggregate").getAsQueryResult(),
      "the aggregate is unreachable while the spot is empty",
    ).toBeUndefined();
  } finally {
    await rt1.dispose({ closeStorage: false });
  }

  const rt2 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm2,
  });
  const { issued, log } = observeCoordinator(
    rt2,
    coordinator.name,
    coordinator.implementation,
  );
  try {
    const compiled2 = await rt2.patternManager.compilePattern(program, {
      space,
    });
    const tx = rt2.edit();
    const rc2 = rt2.getCell<Record<string, unknown>>(
      space,
      cellId,
      compiled2.resultSchema,
      tx,
    );
    expect((await tx.commit()).error).toBeUndefined();

    expect(await rt2.start(rc2)).toBe(true);
    await rc2.pull();
    await rt2.settled();

    return {
      aggregate: await rc2.key("aggregate").pull(),
      container: await rt2.getCellFromLink<unknown[]>(containerLink).pull(),
      issuedCount: issued.length,
      log,
    };
  } finally {
    await rt2.dispose({ closeStorage: false });
    await sm1.close();
    if (sm2 !== sm1) await sm2.close();
    await server.close();
  }
}

describe("list container link reissue", () => {
  for (const coordinator of COORDINATORS) {
    describe(coordinator.name, () => {
      it("re-issues the container link when its first reconcile commits", async () => {
        const outcome = await resumeOverEmptiedSpot(
          coordinator,
          `${coordinator.name} link control`,
          { replica: "warm" },
        );

        expect(
          outcome.log[0],
          "the first reconcile issued the container link and committed",
        ).toEqual({ attempt: 1, issuedLink: true, outcome: "commits" });
        expect(
          outcome.aggregate,
          "the aggregate is reachable again through the re-issued link",
        ).toEqual(coordinator.expected);
      });

      it("re-issues the container link when its first reconcile is rejected on a stale basis", async () => {
        const outcome = await resumeOverEmptiedSpot(
          coordinator,
          `${coordinator.name} link regression`,
          { replica: "cold" },
        );

        // The scenario this test exists to cover: the reconcile that issued the
        // link lost its commit, and a later one converged. Found by
        // attempt, not by position in the log: a reconcile's verdict lands
        // when its commit settles, and a rejected first attempt's rejection
        // rides a catch-up that later, fresher attempts can commit ahead of —
        // the resume pre-sync names the coordinator's children, so those
        // attempts read warm results rather than sharing the stale basis.
        expect(
          outcome.log.find((record) => record.attempt === 1),
          "the first reconcile issued the container link and was rejected on a stale basis",
        ).toEqual({
          attempt: 1,
          issuedLink: true,
          outcome: "rejected:ConflictError",
        });
        expect(
          outcome.log.some((record) => record.outcome === "commits"),
          "a later reconcile committed",
        ).toBe(true);
        expect(
          outcome.container,
          "the converged reconcile committed the container's value",
        ).toEqual(coordinator.expected);

        // `sendResult` is the container link's only writer, so the retry that
        // carries the container's value has to carry the link too.
        expect(
          outcome.issuedCount,
          "the container link is issued again by the reconcile that replaces the rejected one",
        ).toBeGreaterThan(1);
        expect(
          outcome.aggregate,
          "the aggregate is reachable through the re-issued link",
        ).toEqual(coordinator.expected);
      });
    });
  }
});
