// Two principals, each with a profile under their own `User` clause, both
// showing one served piece whose handler made an instance that reads
// `wish("#profile")`. The serving loop runs that instance's nodes once per
// principal (fan-out), and each principal's instance must carry only that
// principal's clause.
//
// A node that has fanned out stays one node with one subscription: the union
// of its instances' reads. Each principal's run of the `wish` reads that
// principal's home root and profile, documents of the scope `space` in spaces
// of that principal's own, so the union holds both principals' documents. A
// change to one of them, the first load into the serving replica included,
// reaches the node as a cause with no instance key. `dirtyFanOutForCause()`
// (`src/scheduler/fan-out.ts`) then dirties every instance, and
// `causesForInstance()` (`src/scheduler/run.ts`) hands the cause to every
// instance's run as a CFC trigger read (§8.9.2). The flow join of the other
// principal's run takes the profile's `User` clause from that trigger read
// and stamps it on what the run writes in its own instance.

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { useRealClock } from "@commonfabric/test-support/fake-clock";
import { type Cell, sendEvent } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { servingRuntimeFactory } from "../src/executor/serving-runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { seedProfileOwner } from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitReplica } from "./support/serving-waits.ts";

// This file drives a live ExecutorHost, whose flush deadline and idle park are
// real-time policies; auto-advance would fire them as fast as they arm.
useRealClock();

const spaceSigner = await Identity.fromPassphrase(
  "two-principal profile clauses space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "two-principal profile clauses service",
);

/** A principal, its home space and the space its profile is in. */
type Principal = {
  signer: Identity;
  home: MemorySpace;
  profileSpace: MemorySpace;
  name: string;
};

const principalOf = async (who: string): Promise<Principal> => {
  const signer = await Identity.fromPassphrase(
    `two-principal profile clauses ${who}`,
  );
  const profileSigner = await Identity.fromPassphrase(
    `two-principal profile clauses profile ${who}`,
  );
  return {
    signer,
    home: signer.did() as MemorySpace,
    profileSpace: profileSigner.did() as MemorySpace,
    name: `Profile name of ${who}`,
  };
};

const alice = await principalOf("A");
const bob = await principalOf("B");

/** A list of cards; `make` adds one, whose view shows the viewer's name. */
const MADE_PROFILE_PATTERN = [
  "/// <cts-enable />",
  "import { computed, handler, pattern, type Stream, UI, type VNode, wish, Writable } from 'commonfabric';",
  "interface CardResult { [UI]: VNode; title: string; viewer: string }",
  "const Card = pattern<{ title: string }, CardResult>(({ title }) => {",
  "  const profile = wish<Writable<{ name: string }>>({ query: '#profile' });",
  "  const viewer = computed(() => profile.result?.get()?.name ?? '');",
  "  return { [UI]: <div>{title} for {viewer}</div>, title, viewer };",
  "});",
  "const make = handler<{ title: string }, { cards: Writable<CardResult[]> }>(",
  "  (event, { cards }) => { cards.push(Card({ title: event.title })); },",
  ");",
  "export default pattern<",
  "  { cards: Writable<CardResult[]> },",
  "  { cards: CardResult[]; make: Stream<{ title: string }> }",
  ">(({ cards }) => ({ cards, make: make({ cards }) }));",
].join("\n");

/** A profile's schema: its confidentiality is its owner's `User` atom. */
const profileSchema = (owner: string): JSONSchema => ({
  type: "object",
  properties: { name: { type: "string" } },
  ifc: { confidentiality: [cfcAtom.user(owner)] },
} as JSONSchema);

/** What a stored `User` clause names a principal by. */
const digestOf = (principal: Principal): string =>
  JSON.stringify(hashStringOf(principal.signer.did()));

/**
 * The ids of the documents of `engine` whose instance of `principal`'s user
 * scope carries a label naming `other`. A stored envelope holds its labels as
 * references to content-addressed documents, which are read here.
 */
const documentsLabeledFor = (
  engine: Engine.Engine,
  principal: Principal,
  other: Principal,
): string[] => {
  const scopeKey = resolveScopeKey("user", {
    principal: principal.signer.did(),
  });
  const rows = engine.database.prepare(
    `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
  ).all({ scope_key: scopeKey }) as Array<{ id: string }>;
  return rows.map(({ id }) => id).filter((id) => {
    const envelope = JSON.stringify(
      (Engine.read(engine, { id, scopeKey } as never) as { cfc?: unknown })
        ?.cfc ?? null,
    );
    const labels = [...envelope.matchAll(/cid:[A-Za-z0-9_:-]+/g)].map((
      [reference],
    ) =>
      JSON.stringify(
        Engine.read(engine, { id: reference, scopeKey: "space" } as never)
          ?.value ?? null,
      )
    );
    return [envelope, ...labels].some((text) => text.includes(digestOf(other)));
  });
};

/** Whether any revision ever written in `principal`'s user scope held `text`. */
const userScopeEverHeld = (
  engine: Engine.Engine,
  principal: Principal,
  text: string,
): boolean =>
  (engine.database.prepare(
    `SELECT data FROM revision WHERE scope_key = :scope_key`,
  ).all({
    scope_key: resolveScopeKey("user", { principal: principal.signer.did() }),
  }) as Array<{ data: unknown }>).some((row) =>
    JSON.stringify(row.data ?? null).includes(text)
  );

describe("executor-two-principal-profile-clauses", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let runtimes: Runtime[];
  let cancels: (() => void)[];

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [serviceSigner.did()],
    });
    runtimes = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await host?.close();
    host = undefined;
    for (const runtime of runtimes) await runtime.dispose();
    await server.close();
  });

  const openClient = (principal: Principal): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: principal.signer,
      }),
      experimental: { serverExecution: true },
    });
    runtimes.push(runtime);
    return runtime;
  };

  /**
   * Writes `principal`'s profile into its profile space, claims it as
   * `principal`'s, and lists it in the root of `principal`'s home. Returns the
   * profile.
   */
  const seedHome = async (
    runtime: Runtime,
    principal: Principal,
  ): Promise<Cell<{ name: string }>> => {
    const written = runtime.edit();
    const profile = runtime.getCell<{ name: string }>(
      principal.profileSpace,
      "profile",
      profileSchema(principal.home),
      written,
    );
    profile.set({ name: principal.name });
    expect((await written.commit().settled).error).toBeUndefined();
    const claimed = runtime.edit();
    seedProfileOwner(
      claimed,
      profile.getAsNormalizedFullLink(),
      principal.home,
    );
    expect((await claimed.commit().settled).error).toBeUndefined();
    const listed = runtime.edit();
    runtime.getCell(principal.home, principal.home, undefined, listed)
      .key("defaultPattern" as never)
      .set({
        profiles: [
          runtime.getCell(principal.profileSpace, "profile", undefined, listed),
        ],
      } as never);
    expect((await listed.commit().settled).error).toBeUndefined();
    return profile;
  };

  const settled = async () => {
    await host!.whenQuiescent();
    await server.idle();
    for (const runtime of runtimes) await runtime.storageManager.synced();
    await host!.whenQuiescent();
    await server.idle();
  };

  /**
   * Reads `cell` as a client that shows it does: syncs it, holds a sink on
   * it, and follows each link its value holds, `depth` links deep. Returns
   * the value with the links replaced by what they lead to.
   */
  const show = async (
    runtime: Runtime,
    cell: Cell<unknown>,
    depth: number,
  ): Promise<unknown> => {
    await cell.sync();
    cancels.push(cell.sink(() => {}));
    const follow = async (value: unknown): Promise<unknown> => {
      const link = parseLink(value as never, cell);
      if (link !== undefined) {
        return depth <= 0
          ? "<link>"
          : await show(runtime, runtime.getCellFromLink(link), depth - 1);
      }
      if (Array.isArray(value)) {
        const shown = [];
        for (const member of value) shown.push(await follow(member));
        return shown;
      }
      if (value !== null && typeof value === "object") {
        const shown: Record<string, unknown> = {};
        for (const [name, member] of Object.entries(value)) {
          shown[name] = await follow(member);
        }
        return shown;
      }
      return value;
    };
    return await follow(cell.getRaw());
  };

  it("stores no clause of the other principal in either principal's instance of a made card after one principal renames their profile", async () => {
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      ensureSpaceRoots: false,
      createRuntime: servingRuntimeFactory({
        server,
        identity: serviceSigner,
        apiUrl: new URL(import.meta.url),
      }),
      policy: { storeReadThrough: true },
    });
    const aliceClient = openClient(alice);
    const bobClient = openClient(bob);
    await seedHome(aliceClient, alice);
    const bobProfile = await seedHome(bobClient, bob);

    const compiled = await aliceClient.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: MADE_PROFILE_PATTERN }],
    }, { space });
    const result = aliceClient.getCell<unknown>(space, "made cards");
    {
      const tx = aliceClient.edit();
      aliceClient.run(tx, compiled, { cards: [] } as never, result.withTx(tx));
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    const rootOf = (runtime: Runtime) =>
      runtime.getCellFromLink(
        { ...result.getAsNormalizedFullLink(), path: [], scope: "space" },
      ) as Cell<Record<string, unknown>>;
    for (const runtime of [aliceClient, bobClient]) {
      cancels.push(rootOf(runtime).sink(() => {}));
    }
    await settled();

    const make = rootOf(aliceClient).key("make");
    await make.sync();
    await make.resolveAsCell().sync();
    const handled = Promise.withResolvers<void>();
    sendEvent(
      make as never,
      { title: "Card of A" } as never,
      () => handled.resolve(),
      { echo: false },
    );
    await handled.promise;
    await settled();
    const shown = async (runtime: Runtime) =>
      await show(runtime, rootOf(runtime) as Cell<unknown>, 6);
    // The first reading demands each principal's instance of the card.
    await shown(aliceClient);
    await shown(bobClient);
    await settled();
    expect(await shown(aliceClient)).toMatchObject({
      cards: [{ viewer: alice.name }],
    });
    expect(await shown(bobClient)).toMatchObject({
      cards: [{ viewer: bob.name }],
    });
    await settled();

    // Bob renames his profile once both principals' instances are current:
    // the change reaches the `wish` node of the card as a cause on a
    // document of the scope `space`.
    const renamed = "Renamed profile of B";
    {
      await bobProfile.sync();
      const tx = bobClient.edit();
      bobProfile.withTx(tx).key("name").set(renamed);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    // Bob's instance is derived again from his renamed profile.
    await awaitReplica(
      bobClient.storageManager,
      async () => {
        await bobClient.idle();
        const [card] = (await shown(bobClient) as { cards: unknown[] }).cards;
        return (card as { viewer?: unknown }).viewer === renamed;
      },
    );
    await settled();
    expect(await shown(aliceClient)).toMatchObject({
      cards: [{ viewer: alice.name }],
    });

    const engine = await server.engineForSpace(space);
    // No value of one principal reached the other's instances.
    expect(userScopeEverHeld(engine, alice, bob.name)).toBe(false);
    expect(userScopeEverHeld(engine, alice, renamed)).toBe(false);
    expect(userScopeEverHeld(engine, bob, alice.name)).toBe(false);
    // No clause of one principal is stored in the other's instances.
    expect(documentsLabeledFor(engine, alice, bob)).toEqual([]);
    expect(documentsLabeledFor(engine, bob, alice)).toEqual([]);
  });
});
