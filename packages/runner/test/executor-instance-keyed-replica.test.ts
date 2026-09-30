// Server-execution v2 fan-out stage A — OW17's instance-keyed serving
// replica, wire, and tx→replica identity seam, END TO END against a real
// memory server, a live ExecutorHost, and TWO flag-ON clients (Alice,
// Bob):
//
// - the serving replica holds BOTH principals' instances of one scoped
//   doc, and each demanded run reads ITS instance — divergent per-user
//   inputs land divergent per-instance engine rows with the RIGHT
//   values (the OW17 VALUE half; pre-stage-A both runs read the one
//   scope-NAME-keyed local doc, the service's collapsed instance);
// - the R7 wall: Alice's authored per-user draft plus her save event →
//   the served handler runs AS Alice, reads HER draft (not the service
//   instance's empty one), and writes her per-user consequence with the
//   typed value (pre-stage-A: consequenced with zero writes);
// - the resubscribe path is instance-aware: after both instances ran,
//   BOB's input change wakes the node (the N-run loop resubscribes after
//   each instance to the UNION of its logs — pre-stage-A the last instance's
//   subscription replaced the others);
// - S4 (basis rows keyed by the FULL instance address): a demand stamp
//   broader or narrower than the run's discovered instance leaves no
//   stranded rows — a session-scoped watch on a user-discovering node
//   records `user:<p>` rows, never `session:<p>:<s>` (the ragged case's
//   zombie), and a space-discovering node records `space`.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitReplica,
} from "./support/serving-waits.ts";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import {
  acquireExecutionLease,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/** The serving runtime's storage manager, with the serving-loop suite's
 * settle-gate seam: while `settleGate` is set, the loop's settle hangs
 * at its `inputSynced` barrier BEFORE any seal, so a cycle can be held
 * open across a lease tick with NO wave open (no tenure captured) —
 * the same-process reacquire then keeps the loop serving instead of
 * parking on a mid-wave abort. Undefined everywhere else. */
class GatedStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): GatedStorageManager {
    return super.connectTo(server, options) as GatedStorageManager;
  }

  settleGate: Promise<void> | undefined;

  override async inputSynced(): Promise<void> {
    await super.inputSynced();
    if (this.settleGate !== undefined) await this.settleGate;
  }
}

const spaceSigner = await Identity.fromPassphrase("instance-keyed replica");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "instance-keyed replica service",
);
const aliceSigner = await Identity.fromPassphrase(
  "instance-keyed replica alice",
);
const bobSigner = await Identity.fromPassphrase("instance-keyed replica bob");

/** A piece with per-user state on both sides of the run: a PerUser
 * draft the derivations READ, a PerUser save slot the handler WRITES,
 * and one space-only derivation (`label`) whose basis rows must key
 * `space` regardless of who demanded it. */
const PER_USER_PATTERN = [
  "import { computed, Default, handler, pattern, PerUser, Stream, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const draftText = (draft: Draft): string =>",
  "  (draft.get() as string | undefined) ?? '';",
  "const save = handler<unknown, { draft: Draft; saved: Draft }>(",
  "  (_ev, { draft, saved }) => {",
  "    const text = draftText(draft).trim();",
  "    if (text.length > 0) saved.set('saved:' + text);",
  "  },",
  ");",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; saved?: PerUser<Draft>; n?: number },",
  "  { echo: string; savedEcho: string; label: string; save: Stream<unknown> }",
  ">(({ draft, saved, n }) => {",
  "  const draftCell: Draft = draft!;",
  "  const savedCell: Draft = saved!;",
  "  return {",
  "    echo: computed(() => 'echo:' + draftText(draftCell)),",
  "    savedEcho: computed(() => 'saved-echo:' + draftText(savedCell)),",
  "    label: computed(() => 'label:' + String(n ?? 0)),",
  "    save: save({ draft: draftCell, saved: savedCell }),",
  "  };",
  "});",
].join("\n");

/** The same surface with derivations that read NOTHING per-user: no
 * demanded run ever loads a principal's draft instance into the serving
 * replica, so the served save handler's read of Alice's draft is the
 * FIRST touch of her instance — the true R7 shape (group chat: type,
 * then save; the server may never have loaded the draft). */
const PER_USER_PATTERN_HANDLER_ONLY = PER_USER_PATTERN
  .replace("'echo:' + draftText(draftCell)", "'echo:const'")
  .replace("'saved-echo:' + draftText(savedCell)", "'saved-echo:const'");

if (PER_USER_PATTERN_HANDLER_ONLY === PER_USER_PATTERN) {
  throw new Error("handler-only pattern did not derive from the base");
}

const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

/** Every current row of one scope INSTANCE: id → document value. */
const rowsUnder = (
  engine: Engine.Engine,
  scopeKey: string,
): Map<string, unknown> => {
  const rows = engine.database.prepare(
    `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
  ).all({ scope_key: scopeKey }) as Array<{ id: string }>;
  const out = new Map<string, unknown>();
  for (const { id } of rows) {
    out.set(id, Engine.read(engine, { id, scopeKey } as never)?.value);
  }
  return out;
};

const instanceHolds = (
  engine: Engine.Engine,
  scopeKey: string,
  needle: string,
): boolean =>
  [...rowsUnder(engine, scopeKey).values()].some((value) =>
    JSON.stringify(value ?? null).includes(needle)
  );

const basisKeys = (engine: Engine.Engine): Set<string> =>
  new Set(
    (engine.database.prepare(
      `SELECT DISTINCT action_scope_key FROM scheduler_basis`,
    ).all() as Array<{ action_scope_key: string }>).map((row) =>
      row.action_scope_key
    ),
  );

describe("stage A: the instance-keyed serving replica (OW17)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let servingRuntime: Runtime | undefined;
  let servingManager: GatedStorageManager | undefined;
  let sessions: MemoryV2Server.SessionRegistry;
  let activations: ArrivalLog<{ space: string; outcome: string }>;

  const newHost = (
    policy: ConstructorParameters<typeof ExecutorHost>[0]["policy"] = {},
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = GatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        servingManager = manager;
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        servingRuntime = runtime;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000, ...policy },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  /** Resolves once `activatedSpace` has an ACTIVE tenure — activation
   * finishes on no admission or session edge of its own. */
  const activated = (activatedSpace: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === activatedSpace && entry.outcome === "active"
    );

  beforeEach(() => {
    // The registry is the test's own: a detached session lingers for the
    // TTL and its watches are still DEMAND, and the true-R7 test needs
    // an ephemeral typer's session GONE. Owning the registry lets it
    // remove that session outright instead of waiting the window out.
    sessions = new MemoryV2Server.SessionRegistry({ ttlMs: 250 });
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      sessions,
    });
    managers = [];
    runtimes = [];
    servingRuntime = undefined;
    servingManager = undefined;
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const openClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  /** Alice stands the piece up; Bob joins it. Each principal registers
   * BOTH demand halves: the space watch (the value pull) and an
   * identity-bearing scoped watch on the result doc (the demand row the
   * run supply consumes — P2-F's existing supply, which is how stage A
   * reaches cardinality 2 without stage B's space-root demanders). Each
   * writes a DIVERGENT per-user draft through the argument schema (the
   * narrowing write lands it in that principal's instance). */
  const standUpTwoUsers = async (options: {
    bobScope: "user" | "session";
    names: { arg: string; result: string };
    hostPolicy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"];
    pattern?: string;
  }) => {
    // The host first: activation is triggered by session open / admission
    // (serving-loop.md §1), so the clients open against a live host.
    host = newHost(options.hostPolicy);
    const alice = openClient(aliceSigner);
    const bob = openClient(bobSigner);
    const engine = await server.engineForSpace(space);

    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: options.pattern ?? PER_USER_PATTERN,
      }],
    }, { space });
    const aliceArg = alice.getCell<Record<string, unknown>>(
      space,
      options.names.arg,
      undefined,
    );
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      options.names.result,
      compiled.resultSchema,
    );
    await aliceArg.sync();
    await aliceResult.sync();
    {
      const seed = alice.edit();
      aliceArg.withTx(seed).set({ n: 1 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, aliceArg, aliceResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const argId = aliceArg.getAsNormalizedFullLink().id;
    const resultId = aliceResult.getAsNormalizedFullLink().id;

    // Demand FIRST (P2-F's supply — stage B's arrival re-arm is what
    // would let a demander who arrives after a clean run be served; here
    // the input change below is what re-runs the node): the space watch
    // (value pull) plus the identity-bearing scoped watch per principal.
    const bobResult = bob.getCell<Record<string, unknown>>(
      space,
      options.names.result,
      undefined,
    );
    await bobResult.sync();
    const cancelAlice = aliceResult.sink(() => {});
    const cancelBob = bobResult.sink(() => {});
    await alice.getCellFromLink<unknown>({
      ...aliceResult.getAsNormalizedFullLink(),
      scope: "user",
    }).sync();
    await bob.getCellFromLink<unknown>({
      ...bobResult.getAsNormalizedFullLink(),
      scope: options.bobScope,
    }).sync();
    await activated(space);
    await awaitAdmitted(server, () => {
      const demanded = host!.spaceServer(space)?.demandedIdentitiesOf(
        resultId,
      ) ?? [];
      return demanded.some((i) => i.principal === aliceSigner.did()) &&
        demanded.some((i) => i.principal === bobSigner.did());
    });

    // Divergent per-user drafts, written THROUGH the argument schema so
    // the PerUser slot narrows into each writer's own instance. Each is
    // an authored input change that re-runs the demanded node — once
    // per demanded instance.
    const typedAliceArg = alice.getCell<{ draft: string; saved: string }>(
      space,
      options.names.arg,
      compiled.argumentSchema,
    );
    {
      const tx = alice.edit();
      typedAliceArg.key("draft").withTx(tx).set("A");
      // Alice's `saved` slot exists in HER instance before any handler
      // touches it: a handler-only write to a never-written PerUser slot
      // lands at the slot's base scope (pre-existing OFF behavior — the
      // handler's handle carries no scope cap until the slot redirects;
      // flagged in the stage-A report, not stage A's), while a write to
      // an already-narrowed slot follows the sticky redirect into the
      // writer's instance (scopes.md §2 Permanence) — the group-chat
      // shape, where the client types the draft first.
      typedAliceArg.key("saved").withTx(tx).set("");
      expect((await tx.commit()).error).toBeUndefined();
    }
    const typedBobArg = bob.getCell<{ draft: string }>(
      space,
      options.names.arg,
      compiled.argumentSchema,
    );
    await typedBobArg.sync();
    {
      const tx = bob.edit();
      typedBobArg.key("draft").withTx(tx).set("B");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await bob.idle();
    await alice.storageManager.synced();
    await bob.storageManager.synced();
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const bobKey = resolveScopeKey("user", { principal: bobSigner.did() });
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"A"') &&
        instanceHolds(engine, bobKey, '"B"'),
    );

    return {
      alice,
      bob,
      engine,
      compiled,
      argId,
      resultId,
      aliceKey,
      bobKey,
      aliceResult,
      bobResult,
      typedAliceArg,
      typedBobArg,
      cancel: () => {
        cancelAlice();
        cancelBob();
      },
    };
  };

  it("two demanded runs read their OWN per-user inputs through the instance-keyed replica: divergent inputs land divergent per-instance derived rows with the right values, and the serving replica holds both instances of the doc (OW17's value half; the R7 read shape)", async () => {
    const setup = await standUpTwoUsers({
      bobScope: "user",
      names: { arg: "ika-a-arg", result: "ika-a-result" },
    });
    const { engine, aliceKey, bobKey, argId } = setup;

    // THE ARBITRATION: each principal's instance of the echo doc holds
    // ITS OWN input's echo. Pre-stage-A both instance runs read the one
    // scope-NAME-keyed local doc — the service instance's (empty)
    // draft — and wrote "echo:" under both keys.
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    // Never the sibling's value, never the collapsed empty one.
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    expect(instanceHolds(engine, bobKey, '"echo:A"')).toBe(false);
    // The service identity's instance never received a DEMANDED run's
    // value (a pre-demand wave-level fallback run may have left the
    // empty "echo:" there — stage B's B5 residual; never a demander's).
    const serviceKey = resolveScopeKey("user", {
      principal: serviceSigner.did(),
    });
    expect(instanceHolds(engine, serviceKey, '"echo:A"')).toBe(false);
    expect(instanceHolds(engine, serviceKey, '"echo:B"')).toBe(false);

    // The serving replica HOLDS both instances of the argument doc,
    // keyed apart, each with its own draft — the read seam's premise.
    const replica = servingRuntime!.storageManager.open(space).replica;
    const readDraft = (identity: ScopeKeyIdentity | undefined) => {
      const doc = replica.getDocument(argId as never, "user", identity);
      return (doc?.value as { draft?: string } | undefined)?.draft;
    };
    expect(readDraft({ principal: aliceSigner.did() })).toBe("A");
    expect(readDraft({ principal: bobSigner.did() })).toBe("B");
    // And the replica's OWN (service) instance is not either of them.
    expect(readDraft(undefined)).not.toBe("A");
    expect(readDraft(undefined)).not.toBe("B");

    setup.cancel();
  });

  it("R7: Alice's authored per-user draft + her save event → the served handler runs AS Alice, reads HER draft through the instance-keyed replica, and writes her per-user consequence with the typed value (pre-stage-A: consequenced with zero writes)", async () => {
    const setup = await standUpTwoUsers({
      bobScope: "user",
      names: { arg: "ika-r7-arg", result: "ika-r7-result" },
    });
    const { engine, aliceKey, bobKey, alice, aliceResult } = setup;
    // Let the derivations settle first (the save reads the same draft
    // instance the echo run already loaded — and the handler must read
    // it correctly whether or not a prior load happened).
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
    );

    const before = Engine.serverSeq(engine);
    (aliceResult.key("save") as unknown as { send(value: unknown): unknown })
      .send({});
    await alice.idle();
    await alice.storageManager.synced();

    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    await awaitAdmitted(server, () => {
      const value = Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined;
      return (value?.entries?.length ?? 0) >= 1 &&
        value!.entries!.every((entry) => entry.consequenced === true);
    });
    const entries =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!;
    expect(entries[0].firedAt?.user).toBe(aliceSigner.did());
    expect(entries[0].error).toBeUndefined();

    // THE R7 ARBITRATION: the consequence exists, under Alice's instance,
    // with the value she typed — the handler read HER draft, not the
    // service instance's empty one (which writes nothing).
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"saved:A"'),
    );
    // Under HER instance exactly: the arg doc's user instance holds both
    // her draft and the typed consequence; the space slot holds the
    // redirect, never the value.
    expect(rowsUnder(engine, aliceKey).get(setup.argId)).toEqual({
      draft: "A",
      saved: "saved:A",
    });
    expect(
      (rowsUnder(engine, "space").get(setup.argId) as { saved?: unknown })
        ?.saved,
    ).not.toBe("saved:A");
    expect(instanceHolds(engine, bobKey, '"saved:')).toBe(false);
    // The consequence rode a derived commit after the append.
    const consequenceRows = engine.database.prepare(
      `SELECT seq FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL`,
    ).all({ from_seq: before }) as Array<{ seq: number }>;
    expect(consequenceRows.length).toBeGreaterThanOrEqual(1);
    // And the per-user derivation over the SAVED slot re-derived for
    // Alice from her new instance value.
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"saved-echo:saved:A"'),
    );
    setup.cancel();
  });

  it("R7, the true shape: NO derivation ever loaded Alice's draft instance on the serving replica — type, then save — and the served handler still reads HER draft (the presync/preflight AS THE ACTOR is what loads it) and writes her per-user consequence with the typed value", async () => {
    // The pin the shipped R7 test above cannot be: there, Alice's echo
    // derivation had already loaded her instance into the serving
    // replica before the save, so the handler's actor-identity presync
    // and preflight were redundant backstops (the independent review's
    // M15/M16/M17 — each removable, all three together removable, and
    // that test stayed green). Here no demanded run reads the draft, so
    // the served handler's read of Alice's instance is the FIRST — and
    // the presync/preflight as the actor is load-bearing: with both
    // removed the handler reads the service instance's empty draft and
    // writes nothing (this test goes red).
    //
    // Fan-out stage B: the per-demander demand WALK follows a demander's
    // redirects wherever her watches reach — a RENDERING client (whose
    // runtime syncs the argument doc it renders) has its draft instance
    // pre-loaded by the walk, a legitimate demand read. The true-R7
    // shape is therefore the NON-RENDERING actor (RULED 2026-08-16, the
    // event actor as a transient demander): Alice types through an
    // ephemeral runtime BEFORE the host exists (nothing walks), holds NO
    // watch on the space afterwards, and fires the save as a raw event
    // append from a session that syncs nothing. Bob's client watches the
    // root (the piece is demanded and served); Alice's instance is
    // untouched by any walk.
    const engine = await server.engineForSpace(space);
    const names = { arg: "ika-r7-noload-arg", result: "ika-r7-noload-result" };
    let compiled: Awaited<
      ReturnType<Runtime["patternManager"]["compilePattern"]>
    >;
    let argId: string;
    let resultId: string;
    {
      // Ephemeral creator + typer, as Alice, with no host serving.
      const manager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      const creator = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      compiled = await creator.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: PER_USER_PATTERN_HANDLER_ONLY,
        }],
      }, { space });
      const arg = creator.getCell<Record<string, unknown>>(
        space,
        names.arg,
        undefined,
      );
      const result = creator.getCell<Record<string, unknown>>(
        space,
        names.result,
        compiled.resultSchema,
      );
      await arg.sync();
      await result.sync();
      {
        const seed = creator.edit();
        arg.withTx(seed).set({ n: 1 });
        expect((await seed.commit()).error).toBeUndefined();
      }
      {
        const tx = creator.edit();
        creator.run(tx, compiled, arg, result);
        expect((await tx.commit()).error).toBeUndefined();
      }
      await creator.idle();
      argId = arg.getAsNormalizedFullLink().id;
      resultId = result.getAsNormalizedFullLink().id;
      // Type: the draft (and the pre-narrowed `saved` slot) through the
      // argument schema, into HER instance.
      const typed = creator.getCell<{ draft: string; saved: string }>(
        space,
        names.arg,
        compiled.argumentSchema,
      );
      const tx = creator.edit();
      typed.key("draft").withTx(tx).set("A");
      typed.key("saved").withTx(tx).set("");
      expect((await tx.commit()).error).toBeUndefined();
      await creator.storageManager.synced();
      const creatorSession = manager.id;
      await creator.dispose();
      await manager.close();
      // Detaching only starts the resume window; the watch stays DEMAND
      // until the registry prunes it. Remove it outright.
      sessions.remove(space, creatorSession);
    }
    const aliceKey = resolveScopeKey("user", { principal: aliceSigner.did() });
    const bobKey = resolveScopeKey("user", { principal: bobSigner.did() });
    expect(instanceHolds(engine, aliceKey, '"A"')).toBe(true);
    // No watch of Alice's exists when the host activates.
    expect(
      server.watchedRootsForSpace(space, {
        excludePrincipal: serviceSigner.did(),
      }).some((root) => root.identity?.principal === aliceSigner.did()),
    ).toBe(false);

    // NOW the host; Bob's client demands the piece (the root watch).
    host = newHost();
    const bob = openClient(bobSigner);
    const bobResult = bob.getCell<Record<string, unknown>>(
      space,
      names.result,
      compiled.resultSchema,
    );
    await bobResult.sync();
    const cancel = bobResult.sink(() => {});
    await activated(space);
    // The served constant derivations land (the piece is served)…
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, "space", '"echo:const"'),
    );
    // …and the serving replica has NOT loaded Alice's instance of the
    // argument doc — THE PRECONDITION that makes this the true R7 shape
    // (no watch of Alice's exists for any walk to follow).
    const replica = servingRuntime!.storageManager.open(space).replica;
    expect(
      replica.getDocument(argId as never, "user", {
        principal: aliceSigner.did(),
      }),
    ).toBeUndefined();

    // Alice fires the save as a RAW event append from a session that
    // syncs nothing (the non-rendering actor): the entry is admitted
    // under her append authority and server-stamped with her `firedAt`.
    {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      try {
        // The stream the `save` slot links to (as Cell.send resolves it):
        // read off the stored result doc.
        const saveLink = (Engine.read(engine, { id: resultId })?.value as {
          save?: { "/": { "link@1": { id?: string; path?: string[] } } };
        })?.save?.["/"]?.["link@1"];
        const stream = {
          id: saveLink?.id ?? resultId,
          path: saveLink?.path ?? ["save"],
        };
        const delivery = await manager.open(space).replica
          .enqueueEventAppend!({
            sidecarId: streamEntriesDocId(stream as never),
            stream,
            eventId: `evt:${crypto.randomUUID()}:${resultId}`,
            payload: {} as never,
          });
        expect(delivery.delivered).toBe(true);
      } finally {
        await manager.close();
      }
    }
    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    await awaitAdmitted(server, () => {
      const value = Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined;
      return (value?.entries?.length ?? 0) >= 1 &&
        value!.entries!.every((entry) => entry.consequenced === true);
    });
    const entries =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!;
    expect(entries[0].firedAt?.user).toBe(aliceSigner.did());
    expect(entries[0].error).toBeUndefined();
    // THE R7 ARBITRATION under the true shape: the handler read HER
    // draft — loaded by its own actor-identity presync/preflight — and
    // wrote the typed consequence under her instance.
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"saved:A"'),
    );
    expect(rowsUnder(engine, aliceKey).get(argId)).toEqual({
      draft: "A",
      saved: "saved:A",
    });
    expect(instanceHolds(engine, bobKey, '"saved:')).toBe(false);
    cancel();
  });

  it("the resubscribe path is instance-aware: after both instances ran, BOB's input change wakes the node and his instance re-derives (the union of instance logs; pre-stage-A the last instance's subscription won)", async () => {
    const setup = await standUpTwoUsers({
      bobScope: "user",
      names: { arg: "ika-resub-arg", result: "ika-resub-result" },
    });
    const { engine, aliceKey, bobKey, bob, typedBobArg } = setup;
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    // Both instances ran; whichever ran LAST holds the subscription
    // under the pre-stage-A "last instance wins" replacement. Change the
    // input of BOTH, one at a time, and require each to re-derive: the
    // one whose run was NOT last is the mutation target.
    {
      const tx = bob.edit();
      typedBobArg.key("draft").withTx(tx).set("B2");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await bob.idle();
    await bob.storageManager.synced();
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, bobKey, '"echo:B2"'),
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B2"')).toBe(false);
    {
      const tx = setup.alice.edit();
      setup.typedAliceArg.key("draft").withTx(tx).set("A2");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await setup.alice.idle();
    await setup.alice.storageManager.synced();
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A2"'),
    );
    expect(instanceHolds(engine, bobKey, '"echo:A2"')).toBe(false);
    setup.cancel();
  });

  it("a lease lapse the SpaceServer survives in-process does not leave the serving replica silently stale: Alice's write inside the lapse is withheld, then — on the reacquire notice, with NO further write — re-delivered KEYED by the re-arm, her instance re-derives from it, and Bob's instance is untouched (finding 1's silent-stale half, end to end through the serving replica)", async () => {
    // The tick itself is not driven here (see the note below); the renew
    // interval is parked out of the way so no tick can interleave.
    const setup = await standUpTwoUsers({
      bobScope: "user",
      names: { arg: "ika-blip-arg", result: "ika-blip-result" },
      hostPolicy: { renewIntervalMs: 600_000, flushDeadlineMs: 3_000 },
    });
    const { engine, aliceKey, bobKey, alice, argId, typedAliceArg } = setup;
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    const spaceServer = host!.spaceServer(space)!;
    const replica = servingRuntime!.storageManager.open(space).replica;
    const readDraft = (identity: ScopeKeyIdentity | undefined) =>
      (replica.getDocument(argId as never, "user", identity)?.value as
        | { draft?: string }
        | undefined)?.draft;
    expect(readDraft({ principal: aliceSigner.did() })).toBe("A");
    expect(readDraft({ principal: bobSigner.did() })).toBe("B");

    // Hold the loop's next cycle in its settle (before any seal): the
    // cycle Alice's write triggers must not attempt its watermark
    // advance against the expired row — a derived commit under an
    // expired row is refused (engine.ts's derived-class rule) and the
    // loop re-attempts it every cycle until the row is live again
    // (a PRE-EXISTING blip-window shape, recorded in the stage-A fix
    // report; not stage A's and not exercised here).
    const gate = Promise.withResolvers<void>();
    servingManager!.settleGate = gate.promise;

    // THE LAPSE: the lease row expires (an expired row matches nobody —
    // liveness is judged by expiry, serving-loop.md §2). Every push pass
    // now judges the loopback session a FORMER holder.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: spaceServer.holder,
        now: Date.now() - 60_000,
        ttlMs: 1,
      }),
    ).toBe(true);
    // Alice types inside the lapse: the push pass WITHHOLDS her
    // instance from the loopback session (protocol.md §3's filter under
    // a lapsed lease — the P0 rule; never cached as delivered), so the
    // serving replica still reads "A" once the server has drained it.
    {
      const tx = alice.edit();
      typedAliceArg.key("draft").withTx(tx).set("A-blip");
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    await server.idle();
    expect(instanceHolds(engine, aliceKey, '"A-blip"')).toBe(true);
    expect(readDraft({ principal: aliceSigner.did() })).toBe("A");

    // The reacquire, as the SpaceServer's renew arm performs it on a
    // survived blip (serving-loop.md §2's same-process reacquire): the
    // same holder restores the row, then reports it to the memory
    // server (`noteLeaseReacquired` — the arm's own call is pinned in
    // `executor-space-server.test.ts`; the tick is not driven here
    // because two pre-existing SpaceServer shapes make a tick-driven
    // survived blip non-deterministic in this fixture: the rejection
    // spin above, and an EMPTY seal — a read probe or a no-op
    // derivation — opening a `#currentWave` that outlives zero-delta
    // cycles with the pre-blip tenure, so the first real seal after the
    // reacquire aborts lease-lost and parks; both recorded in the fix
    // report as flagged residuals). NO watch is re-issued and NOTHING
    // else is written.
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: spaceServer.holder,
        ttlMs: 600_000,
      }),
    ).toBe(true);
    server.noteLeaseReacquired({ space, principal: serviceSigner.did() });
    // The re-arm's full evaluation re-delivers the withheld instance,
    // keyed. Pre-fix the lapse cleared the exemption for the session's
    // life; the replica kept "A" and every later per-user run of Alice
    // read a stale draft — silently.
    await awaitReplica(
      servingManager!,
      () => readDraft({ principal: aliceSigner.did() }) === "A-blip",
    );
    // Release the held cycle: Alice's instance re-derives from the
    // re-delivered draft (the served per-user run reads the CURRENT
    // instance).
    gate.resolve();
    servingManager!.settleGate = undefined;
    await awaitAdmitted(
      server,
      () => instanceHolds(engine, aliceKey, '"echo:A-blip"'),
    );
    // Bob's instance and Alice's key never crossed: the re-arm named
    // instances, it did not collapse them; the loop kept serving.
    expect(readDraft({ principal: bobSigner.did() })).toBe("B");
    expect(instanceHolds(engine, bobKey, '"echo:A-blip"')).toBe(false);
    expect(host!.spaceServer(space)?.active).toBe(true);
    setup.cancel();
  });

  it("S4: basis rows key by the run's FULL instance address — a session-scoped demand on a user-discovering node records user rows and NO session-keyed zombie; a space-discovering node records `space` under any demand stamp", async () => {
    const setup = await standUpTwoUsers({
      bobScope: "session",
      names: { arg: "ika-s4-arg", result: "ika-s4-result" },
    });
    const { engine, aliceKey, bobKey } = setup;
    await awaitAdmitted(
      server,
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
    );
    await awaitAdmitted(server, () => {
      const keys = basisKeys(engine);
      return keys.has(aliceKey) && keys.has(bobKey) && keys.has("space");
    });
    const keys = basisKeys(engine);
    // Bob demanded through a SESSION-scoped watch: his runs are STAMPED
    // `session:<bob>:<s>`, but every node he ran discovered `user` (the
    // per-user draft) or `space` (`label`) — nothing session-scoped — so
    // no row is recorded under a session key (the ragged case's zombie:
    // rows a departed session could never overwrite).
    expect([...keys].some((key) => key.startsWith("session:"))).toBe(false);
    // The user-discovering derivations recorded rows under each
    // principal's USER instance — the address they actually served.
    expect(keys.has(aliceKey)).toBe(true);
    expect(keys.has(bobKey)).toBe(true);
    // The space-only `label` derivation recorded `space` (never
    // over-keyed under a demander's stamp).
    expect(keys.has("space")).toBe(true);
    // No row under the service identity's user instance: no demanded
    // node ran as the service.
    expect(
      keys.has(resolveScopeKey("user", { principal: serviceSigner.did() })),
    ).toBe(false);
    setup.cancel();
  });
});
