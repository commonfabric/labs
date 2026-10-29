/** Pins non-clearance SQLite requests to their served result instances. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getServerExecutionConfig } from "@commonfabric/memory/v2";
import type { ScopeKeyIdentity, SqliteDbRef } from "@commonfabric/memory/v2";
import { serverSeq } from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { table } from "@commonfabric/memory/sqlite/schema";

import { sqliteQuery } from "../../src/builtins/sqlite-builtins.ts";
import type { Cell } from "../../src/cell.ts";
import type { PostCommitSideEffect } from "../../src/cfc/types.ts";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import { SpaceOutbox } from "../../src/executor/outbox.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveRunContextOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const service = await Identity.fromPassphrase("sqlite-instance-service");
const alice = await Identity.fromPassphrase("sqlite-instance-alice");
const bob = await Identity.fromPassphrase("sqlite-instance-bob");
const space = service.did();
const aliceOne = { principal: alice.did(), sessionId: "alice-one" };
const aliceTwo = { principal: alice.did(), sessionId: "alice-two" };
const bobOne = { principal: bob.did(), sessionId: "bob-one" };
type Scope = "space" | "user" | "session";
type QueryState = {
  pending?: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
};

describe("sqlite-served-instances", () => {
  let server: ReturnType<typeof newSharedServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let outbox: SpaceOutbox;
  let servingDisposed = false;
  let withdraw: (tx: IExtendedStorageTransaction) => Promise<void>;
  const transactions: IExtendedStorageTransaction[] = [];

  beforeEach(async () => {
    servingDisposed = false;
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const engine = await server.engineForSpace(space);
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(service.did()),
    });
    expect(lease.acquire()).toBe(true);
    manager = EmulatedStorageManager.connectTo(server, { as: service });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
      cfcFlowLabels: "off",
    });
    const sink = new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: lease.holder,
    });
    outbox = new SpaceOutbox({
      stats: emptyServingLoopStats(),
      server,
      engine,
      space,
      sessionId: lease.holder,
      localSeqRef: { value: 0 },
    });
    let heldWave: WaveAccumulator | undefined;
    runtime.installSealDestination({
      deferSealedEffects: () => heldWave !== undefined,
      seal: async (tx) => {
        if (heldWave) return heldWave.seal(tx);
        if (!waveRunContextOf(tx)) {
          stampWaveRunContext(tx, {
            kind: "bookkeeping",
            actionId: "sqlite-fixture-completion",
            scopeKeyIdentity: tx.tx.scopeKeyIdentity,
          });
        }
        const wave = new WaveAccumulator({
          space,
          basisSeq: serverSeq(engine),
          scopeKeyIdentity: runtime.scopeKeyIdentity,
          replicaFor: (space) => manager.open(space).replica,
          lease,
        });
        const sealed = await wave.seal(tx);
        if (sealed.error) return sealed;
        const outcome = await wave.commitWave(sink);
        await wave.settled();
        expect(outcome.aborted).toBeUndefined();
        expect(
          outcome.dispositions.every((entry) => entry.kind === "committed"),
        ).toBe(true);
        return sealed;
      },
    });
    withdraw = async (tx) => {
      const wave = new WaveAccumulator({
        space,
        basisSeq: serverSeq(engine),
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (space) => manager.open(space).replica,
        lease,
      });
      heldWave = wave;
      try {
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        wave.abandon("fixture withdrawal");
        await wave.settled();
      } finally {
        heldWave = undefined;
        wave.abandon("fixture cleanup");
      }
      await runtime.settled();
    };
  });

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort();
    await outbox.settle();
    await manager.synced();
    try {
      if (!servingDisposed) await runtime.dispose({ closeStorage: false });
    } finally {
      await manager.close();
      await server.close();
    }
  });

  function edit(identity: ScopeKeyIdentity) {
    const tx = runtime.edit();
    transactions.push(tx);
    stampWaveRunContext(tx, {
      kind: "derivation",
      actionId: "sqlite-instance",
      scopeKeyIdentity: identity,
      attributionFromScope: true,
    });
    tx.tx.scopeKeyIdentity = identity;
    return tx;
  }

  async function commit(tx: IExtendedStorageTransaction) {
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.settled();
  }

  function read<T>(cell: Cell<T>, identity: ScopeKeyIdentity): T {
    const tx = runtime.readTx();
    tx.tx.scopeKeyIdentity = identity;
    return cell.withTx(tx).get();
  }

  async function fixture(scope: Scope, bindingScope: Scope = "space") {
    const db = {
      id: "of:sqlite-instance-db",
      tables: { notes: table({ body: "text" }) },
      scope: "space",
    } as unknown as SqliteDbRef;
    const tx = edit(aliceOne);
    const input = runtime.getCell<{ db: SqliteDbRef; sql: string }>(
      space,
      "sqlite-instance-input",
      undefined,
      tx,
    );
    input.set({ db, sql: "SELECT body FROM notes" });
    const parent = runtime.getCell(
      space,
      "sqlite-instance-parent",
      undefined,
      tx,
    );
    await commit(tx);
    const binding = runtime.getCellFromLink<{ selected?: Scope }>({
      ...parent.getAsNormalizedFullLink(),
      scope: bindingScope,
    });
    let result: Cell<QueryState>;
    const publications: ScopeKeyIdentity[] = [];
    const builtin = sqliteQuery(
      input,
      (tx, cell) => {
        result = cell;
        binding.withTx(tx).set({
          selected: cell.getAsNormalizedFullLink().scope ?? "space",
        });
        publications.push(tx.tx.scopeKeyIdentity!);
      },
      () => {},
      [parent],
      parent,
      runtime,
      { ...parent.getAsNormalizedFullLink(), scope },
      false,
      binding.getAsNormalizedFullLink(),
    );
    function stage(identity: ScopeKeyIdentity) {
      const tx = edit(identity);
      const effects: PostCommitSideEffect[] = [];
      const enqueue = tx.enqueuePostCommitEffect.bind(tx);
      tx.enqueuePostCommitEffect = (effect) => {
        effects.push(effect);
        enqueue({ ...effect, flush: () => {} });
      };
      builtin.action(tx);
      return {
        tx,
        effects,
        admit: () =>
          outbox.admitSealedEffects([{
            tx,
            effects,
            context: waveRunContextOf(tx),
          }]),
      };
    }
    return {
      stage,
      input,
      binding,
      publications,
      get result() {
        return result;
      },
    };
  }

  for (
    const [scope, second, calls] of [
      ["space", bobOne, 1],
      ["user", aliceTwo, 1],
      ["user", bobOne, 2],
      ["session", aliceTwo, 2],
    ] as const
  ) {
    it(`settles both ${scope} result instances with ${calls} RPCs for ${second.sessionId}`, async () => {
      const f = await fixture(scope);
      const responses: Array<
        ReturnType<typeof Promise.withResolvers<{ rows: { body: string }[] }>>
      > = [];
      using rpc = stub(manager.open(space), "sqliteQuery", () => {
        const response = Promise.withResolvers<{ rows: { body: string }[] }>();
        responses.push(response);
        return response.promise;
      });
      const first = f.stage(aliceOne);
      await commit(first.tx);
      first.admit();
      const other = f.stage(second);
      await commit(other.tx);
      other.admit();
      try {
        expect(read(f.result, aliceOne)?.pending).toBe(true);
        expect(read(f.result, second)?.pending).toBe(true);
      } finally {
        for (const [index, response] of responses.entries()) {
          response.resolve({ rows: [{ body: `reply-${index}` }] });
        }
        await outbox.settle();
      }
      expect(rpc.calls).toHaveLength(calls);
      expect(read(f.result, aliceOne)?.pending).toBe(false);
      expect(read(f.result, second)?.pending).toBe(false);
      expect(read(f.result, aliceOne)?.result).toEqual([{ body: "reply-0" }]);
      expect(read(f.result, second)?.result).toEqual([{
        body: `reply-${calls - 1}`,
      }]);
      if (calls === 2) {
        expect(first.effects[0].id).toBe(other.effects[0].id);
        expect(first.effects[0].idempotencyKey).not.toBe(
          other.effects[0].idempotencyKey,
        );
      }
    });
  }

  for (const scope of ["user", "session"] as const) {
    it(`settles an uncommitted ${scope} request refusal in its issuing instance`, async () => {
      const f = await fixture(scope);
      const first = f.stage(aliceOne);
      first.effects[0].abandon?.(new Error("fixture refusal"));
      await runtime.settled();
      expect(read(f.result, aliceOne)?.pending).toBe(false);
      expect(read(f.result, aliceOne)?.error).toBe(
        "sqliteQuery request was refused before it started",
      );
      expect(
        read(f.result, { principal: service.did(), sessionId: manager.id })
          ?.error,
      ).toBeUndefined();
    });
  }
  for (
    const [scope, neighbor] of [["user", bobOne], [
      "session",
      aliceTwo,
    ]] as const
  ) {
    it(`settles both independently refused ${scope} instances`, async () => {
      const f = await fixture(scope);
      const first = f.stage(aliceOne);
      const second = f.stage(neighbor);
      first.effects[0].abandon?.(new Error("first refused"));
      await runtime.settled();
      second.effects[0].abandon?.(new Error("second refused"));
      await runtime.settled();
      expect(read(f.result, aliceOne)?.error).toBe(
        "sqliteQuery request was refused before it started",
      );
      expect(read(f.result, neighbor)?.error).toBe(
        "sqliteQuery request was refused before it started",
      );
    });
  }

  it("keeps a completed A result when an intervening B is refused after returning to A", async () => {
    const f = await fixture("user");
    using rpc = stub(
      manager.open(space),
      "sqliteQuery",
      () => Promise.resolve({ rows: [{ body: "A" }] }),
    );
    const first = f.stage(aliceOne);
    await commit(first.tx);
    first.admit();
    await outbox.settle();
    const change = edit(aliceOne);
    f.input.withTx(change).key("sql").set(
      "SELECT body FROM notes WHERE body = 'B'",
    );
    await commit(change);
    const middle = f.stage(aliceOne);
    const reset = edit(aliceOne);
    f.input.withTx(reset).key("sql").set("SELECT body FROM notes");
    await commit(reset);
    const last = f.stage(aliceOne);
    await commit(last.tx);
    expect(last.effects).toHaveLength(0);
    middle.effects[0].abandon?.(new Error("B refused"));
    await runtime.settled();
    expect(read(f.result, aliceOne)?.result).toEqual([{ body: "A" }]);
    expect(read(f.result, aliceOne)?.error).toBeUndefined();
    expect(rpc.calls).toHaveLength(1);
  });
  it("completes the issuing result after the same closure selects a narrower result", async () => {
    const f = await fixture("space");
    const response = Promise.withResolvers<{ rows: { body: string }[] }>();
    using _rpc = stub(
      manager.open(space),
      "sqliteQuery",
      () => response.promise,
    );
    const first = f.stage(aliceOne);
    const original = f.result;
    await commit(first.tx);
    first.admit();
    try {
      const change = edit(aliceOne);
      f.input.withTx(change).key("db").key("scope").set("user");
      await commit(change);
      await commit(f.stage(aliceOne).tx);
      expect(f.result.getAsNormalizedFullLink().scope).toBe("user");
    } finally {
      response.resolve({ rows: [{ body: "original" }] });
      await outbox.settle();
    }
    expect(read(original, aliceOne)?.pending).toBe(false);
    expect(read(original, aliceOne)?.result).toEqual([{ body: "original" }]);
    expect(read(f.result, aliceOne)?.pending).toBe(true);
  });

  it("keeps a newer accepted result scope selected after an older scope is refused", async () => {
    const f = await fixture("space");
    const old = f.stage(aliceOne);
    const change = edit(aliceOne);
    f.input.withTx(change).key("db").key("scope").set("user");
    await commit(change);
    await commit(f.stage(aliceOne).tx);
    expect(read(f.binding, aliceOne)?.selected).toBe("user");
    old.effects[0].abandon?.(new Error("old scope refused"));
    await runtime.settled();
    expect(read(f.binding, aliceOne)?.selected).toBe("user");
  });
  for (const complete of [false, true]) {
    it(`announces a shared ${complete ? "settled" : "pending"} result to an independently refused binding`, async () => {
      const f = await fixture("user", "session");
      const response = Promise.withResolvers<{ rows: { body: string }[] }>();
      using _rpc = stub(
        manager.open(space),
        "sqliteQuery",
        () => response.promise,
      );
      const first = f.stage(aliceOne);
      const second = f.stage(aliceTwo);
      await commit(second.tx);
      second.admit();
      try {
        if (complete) {
          response.resolve({ rows: [{ body: "shared" }] });
          await outbox.settle();
        }
        first.effects[0].abandon?.(new Error("first binding refused"));
        await runtime.settled();
        expect(read(f.binding, aliceOne)?.selected).toBe("user");
        expect(read(f.binding, aliceTwo)?.selected).toBe("user");
        expect(read(f.result, aliceOne)?.error).toBeUndefined();
        expect(read(f.result, aliceOne)?.pending).toBe(!complete);
      } finally {
        response.resolve({ rows: [{ body: "shared" }] });
        await outbox.settle();
      }
    });
  }

  it("preserves a newer refusal publication when the older scope is also refused", async () => {
    const f = await fixture("space");
    const old = f.stage(aliceOne);
    const change = edit(aliceOne);
    f.input.withTx(change).key("db").key("scope").set("user");
    await commit(change);
    const newer = f.stage(aliceOne);
    newer.effects[0].abandon?.(new Error("newer refused"));
    await runtime.settled();
    expect(read(f.binding, aliceOne)?.selected).toBe("user");
    old.effects[0].abandon?.(new Error("older refused"));
    await runtime.settled();
    expect(read(f.binding, aliceOne)?.selected).toBe("user");
  });
  for (const empty of [false, true]) {
    it(`allows an older scope refusal after a newer ${empty ? "empty" : "request"} publication is withdrawn`, async () => {
      const f = await fixture("space");
      const old = f.stage(aliceOne);
      const change = edit(aliceOne);
      f.input.withTx(change).key("db").key("scope").set("user");
      if (empty) {
        f.input.withTx(change).key("sql").asSchema(true).set(undefined);
      }
      await commit(change);
      const newer = f.stage(aliceOne);
      expect(newer.effects).toHaveLength(empty ? 0 : 1);
      await withdraw(newer.tx);
      old.effects[0].abandon?.(new Error("older refused"));
      await runtime.settled();
      expect(read(f.binding, aliceOne)?.selected).toBe("space");
    });
  }

  it("keeps a settled memo selected when another binding refuses an intervening query", async () => {
    const f = await fixture("user", "session");
    using rpc = stub(
      manager.open(space),
      "sqliteQuery",
      () => Promise.resolve({ rows: [{ body: "A" }] }),
    );
    const first = f.stage(aliceOne);
    await commit(first.tx);
    first.admit();
    await outbox.settle();
    const change = edit(aliceOne);
    f.input.withTx(change).key("sql").set(
      "SELECT body FROM notes WHERE body = 'B'",
    );
    await commit(change);
    const middle = f.stage(aliceOne);
    const reset = edit(aliceOne);
    f.input.withTx(reset).key("sql").set("SELECT body FROM notes");
    await commit(reset);
    const memo = f.stage(aliceTwo);
    await commit(memo.tx);
    expect(memo.effects).toHaveLength(0);
    middle.effects[0].abandon?.(new Error("B refused"));
    await runtime.settled();
    expect(read(f.result, aliceOne)?.result).toEqual([{ body: "A" }]);
    expect(read(f.result, aliceOne)?.error).toBeUndefined();
    expect(rpc.calls).toHaveLength(1);
  });
  for (const coordinate of [false, true]) {
    it(`preserves the selected OFF result scope ${coordinate ? "with" : "without"} a physical binding coordinate`, async () => {
      await runtime.dispose({ closeStorage: false });
      servingDisposed = true;
      const offManager = EmulatedStorageManager.emulate({ as: service });
      const off = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: offManager,
        experimental: { serverExecution: false },
      });
      try {
        expect(getServerExecutionConfig()).toBe(false);
        const seed = off.edit();
        const input = off.getCell<{ db: SqliteDbRef; sql: string }>(
          space,
          "off-query-input",
          undefined,
          seed,
        );
        input.set({
          db: {
            id: "of:off-query-db",
            tables: { notes: table({ body: "text" }) },
            scope: "space",
          } as unknown as SqliteDbRef,
          sql: "SELECT body FROM notes",
        });
        const parent = off.getCell<{ selected?: string }>(
          space,
          "off-query-result",
          undefined,
          seed,
        );
        expect((await seed.commit().settled).error).toBeUndefined();
        const builtin = sqliteQuery(
          input,
          (tx, result: Cell<QueryState>) =>
            parent.withTx(tx).set({
              selected: result.getAsNormalizedFullLink().scope,
            }),
          () => {},
          [parent],
          parent,
          off,
          parent.getAsNormalizedFullLink(),
          false,
          coordinate ? parent.getAsNormalizedFullLink() : undefined,
        );
        const stage = () => {
          const tx = off.edit();
          const effects: PostCommitSideEffect[] = [];
          const enqueue = tx.enqueuePostCommitEffect.bind(tx);
          tx.enqueuePostCommitEffect = (effect) => {
            effects.push(effect);
            enqueue({ ...effect, flush: () => {} });
          };
          builtin.action(tx);
          return { tx, effects };
        };
        const first = stage();
        const change = off.edit();
        input.withTx(change).key("db").key("scope").set("user");
        expect((await change.commit().settled).error).toBeUndefined();
        const next = stage();
        expect((await next.tx.commit().settled).error).toBeUndefined();
        expect(parent.get()?.selected).toBe("user");
        first.effects[0].abandon?.(new Error("old OFF request refused"));
        await off.settled();
        first.tx.abort();
        expect(parent.get()?.selected).toBe("user");
      } finally {
        await off.dispose();
      }
    });
  }
  it("settles one user RPC failure while its neighbor succeeds", async () => {
    const f = await fixture("user");
    const replies: Array<
      ReturnType<typeof Promise.withResolvers<{ rows: { body: string }[] }>>
    > = [];
    using _rpc = stub(manager.open(space), "sqliteQuery", () => {
      const reply = Promise.withResolvers<{ rows: { body: string }[] }>();
      replies.push(reply);
      return reply.promise;
    });
    const first = f.stage(aliceOne);
    await commit(first.tx);
    first.admit();
    const second = f.stage(bobOne);
    await commit(second.tx);
    second.admit();
    try {
      expect(replies).toHaveLength(2);
      replies[0].reject(new Error("query rejected"));
      replies[1].resolve({ rows: [{ body: "neighbor" }] });
    } finally {
      for (const reply of replies) reply.resolve({ rows: [] });
      await outbox.settle();
    }
    expect(read(f.result, aliceOne)?.pending).toBe(false);
    expect(read(f.result, aliceOne)?.error).toBe("query rejected");
    expect(read(f.result, bobOne)?.result).toEqual([{ body: "neighbor" }]);
    expect(read(f.result, bobOne)?.error).toBeUndefined();
  });
  it("reattaches A after A to B to A while the original RPC is pending", async () => {
    const f = await fixture("user");
    const replies: Array<
      ReturnType<typeof Promise.withResolvers<{ rows: { body: string }[] }>>
    > = [];
    using rpc = stub(manager.open(space), "sqliteQuery", () => {
      const reply = Promise.withResolvers<{ rows: { body: string }[] }>();
      replies.push(reply);
      return reply.promise;
    });
    const first = f.stage(aliceOne);
    const flush = first.effects[0].flush;
    let firstDone: Promise<unknown> | undefined;
    first.effects[0].flush = (tx) => {
      const result = flush(tx);
      firstDone = Promise.resolve(result);
      return result;
    };
    await commit(first.tx);
    first.admit();
    try {
      const change = edit(aliceOne);
      f.input.withTx(change).key("sql").set(
        "SELECT body FROM notes WHERE body = 'B'",
      );
      await commit(change);
      const middle = f.stage(aliceOne);
      await commit(middle.tx);
      middle.admit();
      const reset = edit(aliceOne);
      f.input.withTx(reset).key("sql").set("SELECT body FROM notes");
      await commit(reset);
      const last = f.stage(aliceOne);
      await commit(last.tx);
      last.admit();
      expect(rpc.calls).toHaveLength(2);
      expect(last.effects[0].idempotencyKey).toBe(
        first.effects[0].idempotencyKey,
      );
      replies[0].resolve({ rows: [{ body: "A" }] });
      await firstDone;
      expect(read(f.result, aliceOne)?.result).toEqual([{ body: "A" }]);
      replies[1].resolve({ rows: [{ body: "B" }] });
      await outbox.settle();
      expect(read(f.result, aliceOne)?.result).toEqual([{ body: "A" }]);
      expect(read(f.result, aliceOne)?.pending).toBe(false);
    } finally {
      for (const reply of replies) reply.resolve({ rows: [] });
      await outbox.settle();
    }
  });
});
