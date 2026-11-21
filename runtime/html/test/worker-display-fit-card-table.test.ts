/**
 * What the display boundary decides about the card table example
 * (`patterns/examples/cfc-exchange-rules/card-table.tsx`), run as a compiled
 * pattern by three principals, each in a runtime of their own on one memory
 * server. Its exchange rule releases the table's view to the principal each
 * instance of it was computed for, on the viewer the flow stage stamps on
 * what `viewFor` writes (the `viewerBoundRelease` experimental option). These
 * cases fit the labels a read of a view consumed against the ceiling a
 * render gives a viewer, `User(viewer)`, as the reconciler does.
 *
 * Every runtime here runs handlers and computations itself: none is a
 * serving runtime, so each holds its own principal's instance of the view and
 * nobody else's. A case that asks what one principal would be shown of
 * another's instance reads that instance in its holder's runtime, and fits it
 * against the asking principal's ceiling.
 *
 * `Deno.test` rather than `describe`/`it`: this package installs its fake
 * clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
 * a `@std/testing/bdd` `it()` callback never receives that context.
 */

import { expect } from "@std/expect";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ACLManager,
  type Cell,
  hostValueOf,
  readProjected,
  Runtime,
} from "@commonfabric/runner";
import {
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
} from "@commonfabric/runner/cfc";
import { defer } from "@commonfabric/async/defer";

import { ExecutorHost } from "../../runner/src/executor/host.ts";
import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";
import { awaitAdmitted } from "../../runner/test/support/serving-waits.ts";
import { readRefusal } from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const SOURCE = await Deno.readTextFile(
  new URL(
    "../../../patterns/examples/cfc-exchange-rules/card-table.tsx",
    import.meta.url,
  ),
);

const TABLE_FILE = {
  name: "/card-table.tsx",
  contents: `/// <cts-enable />\n${SOURCE}`,
};

/** A program: its entry module and the files it is made of. */
interface Program {
  main: string;
  files: { name: string; contents: string }[];
}

/** The program that runs the table. */
const TABLE_PROGRAM: Program = {
  main: "/card-table.tsx",
  files: [TABLE_FILE],
};

/**
 * A pattern of another module that binds the table module's own `move`
 * handler to a state it is handed. The state's declared writer is `move`,
 * which this is.
 */
const BORROWED_MOVE_PROGRAM: Program = {
  main: "/borrow.tsx",
  files: [
    {
      name: "/borrow.tsx",
      contents: `/// <cts-enable />
import { pattern } from "commonfabric";
import { move } from "./card-table.tsx";

// The state is typed as anything here. An argument position that declares a
// writer cannot be handed a link by the host that starts the run.
// deno-lint-ignore no-explicit-any
export default pattern<{ theirs: any }>(({ theirs }) => ({
  move: move({ state: theirs }),
}));
`,
    },
    TABLE_FILE,
  ],
};

/**
 * A pattern of another module that runs the table over a state it is handed.
 * The state is typed as anything, as in `BORROWED_MOVE_PROGRAM`.
 */
const LENT_STATE_PROGRAM: Program = {
  main: "/lend.tsx",
  files: [
    {
      name: "/lend.tsx",
      contents: `/// <cts-enable />
import { pattern } from "commonfabric";
import Table from "./card-table.tsx";

// deno-lint-ignore no-explicit-any
export default pattern<{ state: any }>(({ state }) => {
  const table = Table({ state } as Parameters<typeof Table>[0]);
  return { view: table.view, move: table.move };
});
`,
    },
    TABLE_FILE,
  ],
};

/**
 * A pattern of another module with a handler of its own that writes a state
 * it is handed: every seat's hand into the sender's seat.
 */
const FORGING_PROGRAM: Program = {
  main: "/forge.tsx",
  files: [
    {
      name: "/forge.tsx",
      contents: `/// <cts-enable />
import { handler, pattern, type Writable } from "commonfabric";

// deno-lint-ignore no-explicit-any
const forge = handler<{ occupant: string }, { state: Writable<any> }>(
  (event, { state }) => {
    const game = state.get();
    state.set({
      ...game,
      occupants: game.occupants.map(() => event.occupant),
      version: game.version + 1,
    });
  },
);

// deno-lint-ignore no-explicit-any
export default pattern<{ theirs: any }>(({ theirs }) => ({
  forge: forge({ state: theirs }),
}));
`,
    },
    TABLE_FILE,
  ],
};

type Table = Cell<Record<string, unknown>>;

/** One principal's runtime on the shared server. */
interface Seat {
  readonly did: string;
  readonly runtime: Runtime;
  readonly storageManager: EmulatedStorageManager;
}

/** `table` at `path`. */
const at = (table: Table, ...path: string[]): Cell<unknown> =>
  path.reduce(
    (cell, key) => cell.key(key as never) as Cell<unknown>,
    table as Cell<unknown>,
  );

/** Resolves once `cell` holds a value `done` accepts. */
const until = async <T>(
  cell: Cell<T>,
  done: (value: T) => boolean,
): Promise<void> => {
  const reached = defer<void>();
  const cancel = cell.sink((value) => {
    if (done(value as T)) reached.resolve();
  });
  await reached.promise;
  cancel();
};

/**
 * What keeps `viewer`'s principal from being shown `cell` as `holder`'s
 * runtime holds it, or undefined. `holder` is `viewer` unless the cell is
 * another principal's instance, which only that principal's runtime holds.
 */
const refusal = (
  viewer: Seat,
  cell: Cell<unknown>,
  space: string,
  holder: Seat = viewer,
) => {
  const policy: RenderPolicy = {
    declassifyConfidentiality: [],
    maxConfidentiality: [cfcAtom.user(viewer.did)],
  };
  const resolveConfidentiality = createRenderConfidentialityResolver({
    actingPrincipal: viewer.did,
    memberSpaces: [space],
    modulePolicyResolver:
      createRuntimeCfcModulePolicySource(holder.runtime).resolve,
  });
  const read = readProjected(cell, hostValueOf);
  return readRefusal(cell, [read.consumed], policy, {
    resolveConfidentiality,
  });
};

/** Sends `event` to `table`'s `stream` as `seat`, and lets its run commit. */
const send = async (
  seat: Seat,
  table: Table,
  stream: string,
  event: unknown,
): Promise<void> => {
  const tx = seat.runtime.edit();
  // deno-lint-ignore no-explicit-any
  (table.withTx(tx) as any).key(stream).send(event);
  expect((await tx.commit().settled).error).toBeUndefined();
  await seat.runtime.idle();
  await seat.storageManager.synced();
  await seat.runtime.idle();
};

/**
 * Runs three principals at a table, and hands them to `body`. With `served`,
 * a serving runtime runs the table's handlers and computations for them, as
 * a deployment with server execution on does, and each principal's runtime
 * commits only what its own principal sends.
 */
const atTable = async (
  body: (world: {
    space: string;
    alice: Seat;
    bob: Seat;
    carol: Seat;
    /** Alice's table, and the same table as each of the others holds it. */
    table: Table;
    join: (seat: Seat, table: Table) => Promise<Table>;
    /**
     * Resolves once the memory server stores an instance of `view` for
     * `seat`'s principal, and returns the principals its label's
     * `TransformedBy` atoms name as their viewer, once each.
     */
    storedViewers: (seat: Seat, view: Cell<unknown>) => Promise<string[]>;
    /**
     * Another run as Alice, given `argument`: of the table's pattern, or of
     * `program`.
     */
    secondRun: (
      argument: Record<string, unknown>,
      program?: Program,
    ) => Promise<Table>;
  }) => Promise<void>,
  served = false,
): Promise<void> => {
  const identities = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
      Identity.fromPassphrase(`display fit card table ${name}`)
    ),
  );
  const experimental = {
    viewerBoundRelease: true,
    serverExecution: served,
  };
  const space = identities[0].did();
  // This package freezes every timer with a positive delay, so the server
  // refreshes its subscriptions with none.
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const [alice, bob, carol] = identities.map((identity): Seat => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: identity,
    });
    const runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      experimental,
    });
    return { did: identity.did(), runtime, storageManager };
  });
  const service = await Identity.fromPassphrase(
    "display fit card table service",
  );
  const host = served
    ? new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const storageManager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const runtime = new Runtime({
          storageManager,
          apiUrl: new URL(import.meta.url),
          servingPosture: true,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          experimental,
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await storageManager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    })
    : undefined;
  try {
    // The access list `spaceAccess()` reads: Alice owns the table's space.
    const acl = new ACLManager(alice.runtime, space);
    await acl.set(alice.did as never, "OWNER");
    await acl.set(bob.did as never, "WRITE");
    await acl.set(carol.did as never, "WRITE");

    let runs = 0;
    const run = async (
      argument: Record<string, unknown>,
      program: Program = TABLE_PROGRAM,
    ): Promise<Table> => {
      const tx = alice.runtime.edit();
      const pattern = await alice.runtime.patternManager.compilePattern(
        program,
        { space: space as never, tx },
      );
      const result = alice.runtime.getCell<Record<string, unknown>>(
        space as never,
        `card table ${runs++}`,
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      alice.runtime.run(tx, pattern as any, argument, result);
      alice.runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await result.pull();
      await alice.runtime.idle();
      await alice.runtime.patternManager.flushCompileCacheWrites();
      await alice.storageManager.synced();
      await alice.runtime.idle();
      return result;
    };
    const join = async (seat: Seat, table: Table): Promise<Table> => {
      const mine = seat.runtime.getCellFromLink(
        table.getAsNormalizedFullLink(),
      ) as Table;
      await mine.sync();
      expect(await seat.runtime.start(mine)).toBeTruthy();
      await seat.runtime.idle();
      await seat.storageManager.synced();
      return mine;
    };
    const storedViewers = async (
      seat: Seat,
      view: Cell<unknown>,
    ): Promise<string[]> => {
      const engine = await server.engineForSpace(space as never);
      const address = {
        id: view.resolveAsCell().getAsNormalizedFullLink().id,
        scopeKey: resolveScopeKey("user", { principal: seat.did }),
      } as never;
      const viewers = (): string[] => {
        const record = Engine.read(engine, address) as {
          cfc?: {
            labelMap?: {
              entries?: { label?: { integrity?: { viewer?: string }[] } }[];
            };
          };
        } | undefined;
        return [
          ...new Set(
            (record?.cfc?.labelMap?.entries ?? []).flatMap((entry) =>
              (entry.label?.integrity ?? []).flatMap((atom) =>
                typeof atom?.viewer === "string" ? [atom.viewer] : []
              )
            ),
          ),
        ];
      };
      await awaitAdmitted(server, () => viewers().length > 0);
      return viewers();
    };
    await body({
      space,
      alice,
      bob,
      carol,
      table: await run({}),
      join,
      storedViewers,
      secondRun: run,
    });
  } finally {
    await host?.close();
    for (const seat of [alice, bob, carol]) {
      await seat.runtime.idle();
      await seat.runtime.dispose();
      await seat.storageManager.close();
    }
    await server.close();
  }
};

/** `table`'s view, as the runtime holding `table` computed it. */
const viewOf = (table: Table): Cell<Record<string, unknown>> =>
  at(table, "view") as Cell<Record<string, unknown>>;

/** Resolves once `table`'s view is of the table after `version` moves. */
const seen = async (table: Table, version: number): Promise<void> => {
  await until(viewOf(table), (view) => view?.version === version);
  await viewOf(table).pull();
};

/** The hand `table`'s view holds. */
const handOf = (table: Table): string[] =>
  at(table, "view", "hand").get() as string[];

/**
 * Sets a four-seat table up, seats Bob at 2, and deals: three moves. Alice,
 * who owns the table, takes seat 0 first when `ownerSits`, which makes four.
 */
const play = async (
  { alice, bob }: { alice: Seat; bob: Seat },
  table: Table,
  bobsTable: Table,
  ownerSits: boolean,
): Promise<number> => {
  await send(alice, table, "move", { kind: "setup", seats: 4 });
  await seen(bobsTable, 1);
  await send(bob, bobsTable, "move", { kind: "sit", seat: 2 });
  await seen(table, 2);
  if (ownerSits) await send(alice, table, "move", { kind: "sit", seat: 0 });
  await send(alice, table, "move", { kind: "deal" });
  const moves = ownerSits ? 4 : 3;
  await seen(table, moves);
  await seen(bobsTable, moves);
  return moves;
};

Deno.test("display fit of the card table", async (t) => {
  await atTable(async ({ space, alice, bob, carol, table, join }) => {
    const bobsTable = await join(bob, table);
    const carolsTable = await join(carol, table);

    await t.step("shows each principal the empty table", async () => {
      await send(alice, table, "move", { kind: "setup", seats: 4 });
      await seen(table, 1);
      await seen(bobsTable, 1);
      expect(viewOf(table).get()).toMatchObject({ seat: -1, phase: "seating" });
      expect(refusal(alice, viewOf(table), space)).toBeUndefined();
      expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
    });

    await t.step("seats the sender of a request naming another", async () => {
      // Carol asks for seat 3 in Bob's name. A move carries no proposer, so
      // the seat is hers, and Bob holds none.

      await seen(carolsTable, 1);
      await send(carol, carolsTable, "move", {
        kind: "sit",
        seat: 3,
        occupant: bob.did,
        proposer: bob.did,
      });
      await seen(carolsTable, 2);
      await seen(bobsTable, 2);
      expect(viewOf(carolsTable).get()).toMatchObject({ seat: 3 });
      expect(viewOf(bobsTable).get()).toMatchObject({ seat: -1 });
      await send(carol, carolsTable, "move", { kind: "leave" });
      await seen(carolsTable, 3);
    });

    await t.step("shows each player their own hand", async () => {
      await seen(bobsTable, 3);
      await send(bob, bobsTable, "move", { kind: "sit", seat: 2 });
      await seen(table, 4);
      await send(alice, table, "move", { kind: "sit", seat: 0 });
      await send(alice, table, "move", { kind: "deal" });
      await seen(table, 6);
      await seen(bobsTable, 6);
      expect(viewOf(table).get()).toMatchObject({ seat: 0 });
      expect(viewOf(bobsTable).get()).toMatchObject({ seat: 2 });
      expect(handOf(table).length).toBe(3);
      expect(handOf(bobsTable).length).toBe(3);
      expect(handOf(table)).not.toEqual(handOf(bobsTable));
      expect(refusal(alice, viewOf(table), space)).toBeUndefined();
      expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
    });

    await t.step("shows a hand's cards one at a time too", () => {
      expect(refusal(alice, at(table, "view", "hand"), space))
        .toBeUndefined();
      expect(refusal(alice, at(table, "view", "hand", "0"), space))
        .toBeUndefined();
    });

    await t.step("shows a watcher the table and no hand", async () => {
      await seen(carolsTable, 6);
      expect(viewOf(carolsTable).get()).toMatchObject({
        seat: -1,
        hand: [],
        counts: [3, 0, 3, 0],
      });
      expect(refusal(carol, viewOf(carolsTable), space)).toBeUndefined();
    });

    await t.step("shows nobody another principal's view", () => {
      expect(refusal(bob, viewOf(table), space, alice)).toBeDefined();
      expect(refusal(carol, viewOf(table), space, alice)).toBeDefined();
      expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
      expect(refusal(carol, viewOf(bobsTable), space, bob)).toBeDefined();
      expect(refusal(alice, at(bobsTable, "view", "hand", "0"), space, bob))
        .toBeDefined();
    });

    await t.step("shows nobody the state or every hand", async () => {
      const state = table.getArgumentCell<Record<string, unknown>>()!.key(
        "state",
      ) as Cell<unknown>;
      await at(table, "peek").pull();
      expect(String(at(table, "peek").get())).toContain(handOf(table)[0]);
      for (const viewer of [alice, bob, carol]) {
        expect(refusal(viewer, at(table, "peek"), space, alice)).toBeDefined();
        expect(refusal(viewer, state, space, alice)).toBeDefined();
      }
    });

    await t.step("takes a player who leaves out of their hand", async () => {
      await send(bob, bobsTable, "move", { kind: "leave" });
      await seen(bobsTable, 7);
      await seen(table, 7);
      expect(viewOf(bobsTable).get()).toMatchObject({ seat: -1, hand: [] });
      expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
      expect(viewOf(table).get()).toMatchObject({ counts: [3, 0, 0, 0] });
      expect(refusal(bob, viewOf(table), space, alice)).toBeDefined();
    });
  });
});

Deno.test("display fit of the card table for an owner with no seat", async (t) => {
  await atTable(async ({ space, alice, bob, table, join }) => {
    const bobsTable = await join(bob, table);
    await play({ alice, bob }, table, bobsTable, false);

    await t.step("shows the owner the table and no hand", () => {
      expect(viewOf(table).get()).toMatchObject({
        seat: -1,
        hand: [],
        counts: [0, 0, 3, 0],
      });
      expect(refusal(alice, viewOf(table), space)).toBeUndefined();
    });

    await t.step("shows the owner nothing of the player's view", () => {
      expect(handOf(bobsTable).length).toBe(3);
      expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
      expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
    });
  });
});

Deno.test(
  "display fit of the card table against a second binding of its writer",
  async (t) => {
    // The table's owner runs a pattern of another module that binds the
    // table module's `move` handler to the live table's state, and moves
    // through it.

    await atTable(
      async ({ space, alice, bob, table, join, secondRun }) => {
        const bobsTable = await join(bob, table);
        await send(alice, table, "move", { kind: "setup", seats: 4 });
        await seen(bobsTable, 1);
        await send(bob, bobsTable, "move", { kind: "sit", seat: 2 });
        await seen(table, 2);
        const state = table.getArgumentCell<Record<string, unknown>>()!.key(
          "state",
        );
        const borrowed = await secondRun(
          { theirs: state },
          BORROWED_MOVE_PROGRAM,
        );

        await t.step("makes the owner's own moves and no others", async () => {
          // A seat in Bob's name, which seats nobody: the proposer is the
          // owner, and the request's own fields do not say otherwise. Then
          // the deal, which is the owner's to make at the table too.

          await send(alice, borrowed, "move", {
            kind: "sit",
            seat: 2,
            occupant: alice.did,
          });
          await send(alice, borrowed, "move", { kind: "draw" });
          await viewOf(table).pull();
          expect(viewOf(table).get()).toMatchObject({ seat: -1, version: 2 });
          await send(alice, borrowed, "move", { kind: "deal" });
          await seen(table, 3);
          await seen(bobsTable, 3);
        });

        await t.step("shows the owner no hand", () => {
          expect(viewOf(table).get()).toMatchObject({ seat: -1, hand: [] });
          expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
        });

        await t.step("shows the player the hand it dealt", () => {
          expect(handOf(bobsTable).length).toBe(3);
          expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
        });
      },
    );
  },
);

Deno.test(
  "display fit of the card table against a second run on its state",
  async (t) => {
    // The table's owner starts a second run of the table's pattern, inside
    // a pattern that hands it the live table's state.

    await atTable(
      async ({ space, alice, bob, table, join, secondRun }) => {
        const bobsTable = await join(bob, table);
        const moves = await play({ alice, bob }, table, bobsTable, true);
        const state = table.getArgumentCell<Record<string, unknown>>()!.key(
          "state",
        );
        const second = await secondRun({ state }, LENT_STATE_PROGRAM);

        await t.step("computes the owner's own view again", async () => {
          await seen(second, moves);
          expect(viewOf(second).get()).toEqual(viewOf(table).get());
          expect(handOf(second)).not.toEqual(handOf(bobsTable));
        });

        await t.step("shows the owner none of it", () => {
          // The second run reaches the state through a link in its argument,
          // a slot `move` did not write, so its view carries no input
          // witness.

          expect(refusal(alice, viewOf(second), space)).toBeDefined();
        });

        await t.step("leaves the live table as it was", () => {
          expect(refusal(alice, viewOf(table), space)).toBeUndefined();
          expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
          expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
        });
      },
    );
  },
);

Deno.test(
  "display fit of the card table against a write by other code",
  async (t) => {
    // The table's owner runs a pattern of another module whose own handler
    // writes the live table's state, putting the owner in every seat.

    await atTable(
      async ({ space, alice, bob, table, join, secondRun }) => {
        const bobsTable = await join(bob, table);
        const moves = await play({ alice, bob }, table, bobsTable, false);
        const state = table.getArgumentCell<Record<string, unknown>>()!.key(
          "state",
        );
        const forging = await secondRun({ theirs: state }, FORGING_PROGRAM);

        await t.step("leaves the state as it was", async () => {
          await send(alice, forging, "forge", { occupant: alice.did });
          await viewOf(table).pull();
          expect(viewOf(table).get()).toMatchObject({
            seat: -1,
            hand: [],
            version: moves,
          });
        });

        await t.step("shows the owner no hand", () => {
          expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
        });

        await t.step("shows the player their hand still", () => {
          expect(handOf(bobsTable).length).toBe(3);
          expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
        });
      },
    );
  },
);

Deno.test("display fit of the card table on a serving runtime", async (t) => {
  await atTable(async (
    { space, alice, bob, table, join, storedViewers },
  ) => {
    const bobsTable = await join(bob, table);
    await play({ alice, bob }, table, bobsTable, true);

    await t.step("stores each principal's view stamped with them", async () => {
      // A client commits no instance of a computation under server execution,
      // so an instance the memory server stores is one the serving runtime
      // computed.

      expect(await storedViewers(alice, viewOf(table))).toEqual([alice.did]);
      expect(await storedViewers(bob, viewOf(bobsTable))).toEqual([bob.did]);
      await alice.storageManager.synced();
      await bob.storageManager.synced();
    });

    await t.step("shows each player their own hand", () => {
      expect(viewOf(table).get()).toMatchObject({ seat: 0 });
      expect(viewOf(bobsTable).get()).toMatchObject({ seat: 2 });
      expect(handOf(table).length).toBe(3);
      expect(handOf(bobsTable).length).toBe(3);
      expect(refusal(alice, viewOf(table), space)).toBeUndefined();
      expect(refusal(bob, viewOf(bobsTable), space)).toBeUndefined();
    });

    await t.step("shows nobody another principal's view", () => {
      expect(refusal(bob, viewOf(table), space, alice)).toBeDefined();
      expect(refusal(alice, viewOf(bobsTable), space, bob)).toBeDefined();
    });
  }, true);
});
