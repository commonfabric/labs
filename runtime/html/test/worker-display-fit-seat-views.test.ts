/**
 * What the display boundary decides about the seat views example
 * (`patterns/examples/cfc-exchange-rules/seat-views.tsx`), run as a compiled
 * pattern by three principals, each in a runtime of their own on one memory
 * server. Its exchange rule releases a seat's view to the members of that
 * seat's occupant list, on `ListedIn` evidence the runtime mints only at a
 * display boundary, so a pattern test, which has no such boundary, cannot
 * show the rule firing. These cases fit the labels a read of a view consumed
 * against the ceiling a render gives a viewer, `User(viewer)`, as the
 * reconciler does, in the viewer's own runtime.
 *
 * Every runtime here runs handlers itself: none is a serving runtime.
 *
 * `Deno.test` rather than `describe`/`it`: this package installs its fake
 * clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
 * a `@std/testing/bdd` `it()` callback never receives that context.
 */

import { expect } from "@std/expect";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
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
  createRuntimeListMembershipProvider,
} from "@commonfabric/runner/cfc";
import { defer } from "@commonfabric/async/defer";

import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";
import { readRefusal } from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const SOURCE = await Deno.readTextFile(
  new URL(
    "../../../patterns/examples/cfc-exchange-rules/seat-views.tsx",
    import.meta.url,
  ),
);

// The table with a setup that may be made again. The example's `move`
// refuses a second setup, which is all that keeps a second run pointed at a
// live table's state from getting keys of its own.
const REKEYING_SOURCE = (() => {
  const once = "      if (state.ready) return undefined;\n";
  expect(SOURCE).toContain(once);
  return SOURCE.replace(once, "");
})();

// The table with its seat keys written by a handler of their own, `keyer`,
// and not by `move`. `keyer` reads the state, so the keys it writes still
// pass the capture check.
const FOREIGN_KEY_SOURCE = (() => {
  const edits: [string, string][] = [
    [
      "  WriteAuthorizedBy<Sealed<number>, typeof move>,\n  { members: Pointer }",
      "  WriteAuthorizedBy<Sealed<number>, typeof keyer>,\n  { members: Pointer }",
    ],
    [
      `  if (event.kind === "setup") {
    bound.key0.set(0);
    bound.key1.set(1);
    bound.key2.set(2);
  }
});
`,
      `});

export interface KeyerState {
  state: StoredGame;
  key0: Writable<SeatKey0>;
  key1: Writable<SeatKey1>;
  key2: Writable<SeatKey2>;
}

export const keyer = handler<void, KeyerState>((_, bound) => {
  if (!parsed(String(bound.state ?? "")).ready) return;
  bound.key0.set(0);
  bound.key1.set(1);
  bound.key2.set(2);
});
`,
    ],
    [
      "  move: Stream<Move>;\n",
      "  move: Stream<Move>;\n  keyer: Stream<void>;\n",
    ],
    [
      "    move: move({ state, key0, key1, key2, phase, roster }),\n",
      "    move: move({ state, key0, key1, key2, phase, roster }),\n" +
      "    keyer: keyer({ state, key0, key1, key2 }),\n",
    ],
  ];
  return edits.reduce((source, [from, to]) => {
    expect(source).toContain(from);
    return source.replace(from, to);
  }, SOURCE);
})();

/**
 * The program that runs the table as `table` gives its source. The table is
 * the entry module itself: the capture check compares the run's module with
 * the policy's, so an entry module that only re-exports the table is refused
 * its seat keys ("members requires the output to belong to a run of the
 * module the policy names").
 */
const programOf = (table: string) => ({
  main: "/seat-views.tsx",
  files: [
    { name: "/seat-views.tsx", contents: `/// <cts-enable />\n${table}` },
  ],
});

/**
 * A pattern of another module that binds the table module's own `seating`
 * handler to a seat list it is handed, and to a phase and a roster of its
 * own. The list's declared writer is `seating`, which this is.
 */
const borrowedSeatingProgramOf = (table: string) => ({
  main: "/borrow.tsx",
  files: [
    {
      name: "/borrow.tsx",
      contents: `/// <cts-enable />
import { type Default, pattern, type Writable } from "commonfabric";
import { type Roster, seating, type StoredPhase } from "./seat-views.tsx";

// The list is typed as anything here. An argument position that declares a
// writer cannot be handed a link by the host that starts the run.
interface Input {
  // deno-lint-ignore no-explicit-any
  theirs: any;
  phase: Writable<Default<StoredPhase, "new">>;
  roster: Writable<Default<Roster, []>>;
}

export default pattern<Input>(({ theirs, phase, roster }) => ({
  seating: seating({
    phase,
    roster,
    occupants0: theirs,
    occupants1: theirs,
    occupants2: theirs,
  }),
}));
`,
    },
    { name: "/seat-views.tsx", contents: `/// <cts-enable />\n${table}` },
  ],
});

/**
 * A pattern of another module that runs the table over a state it is handed.
 * The state is typed as anything, as in `borrowedSeatingProgramOf`.
 */
const lentStateProgramOf = (table: string) => ({
  main: "/lend.tsx",
  files: [
    {
      name: "/lend.tsx",
      contents: `/// <cts-enable />
import { pattern } from "commonfabric";
import Table from "./seat-views.tsx";

// deno-lint-ignore no-explicit-any
export default pattern<{ state: any }>(({ state }) => {
  const table = Table({ state } as Parameters<typeof Table>[0]);
  return {
    view0: table.view0,
    view1: table.view1,
    view2: table.view2,
    move: table.move,
    seating: table.seating,
  };
});
`,
    },
    { name: "/seat-views.tsx", contents: `/// <cts-enable />\n${table}` },
  ],
});

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

/** What keeps `seat`'s principal from being shown `cell`, or undefined. */
const refusal = (seat: Seat, cell: Cell<unknown>, space: string) => {
  const policy: RenderPolicy = {
    declassifyConfidentiality: [],
    maxConfidentiality: [cfcAtom.user(seat.did)],
  };
  const resolveConfidentiality = createRenderConfidentialityResolver({
    actingPrincipal: seat.did,
    memberSpaces: [space],
    modulePolicyResolver:
      createRuntimeCfcModulePolicySource(seat.runtime).resolve,
    listMembershipProvider: createRuntimeListMembershipProvider(
      seat.runtime,
      seat.did,
    ),
  });
  const read = readProjected(cell, hostValueOf);
  return readRefusal(cell, [read.consumed], policy, {
    resolveConfidentiality,
  });
};

/** The views `seat`'s principal is shown, of the three, once each is current. */
const shown = async (
  seat: Seat,
  table: Table,
  space: string,
): Promise<string[]> => {
  const views = ["view0", "view1", "view2"];
  for (const view of views) await at(table, view).pull();
  return views.filter((view) =>
    refusal(seat, at(table, view), space) === undefined
  );
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

/** Runs three principals at a table from `source`, and hands them to `body`. */
const atTable = async (
  source: string,
  body: (world: {
    space: string;
    alice: Seat;
    bob: Seat;
    carol: Seat;
    /** Alice's table, and the same table as each of the others holds it. */
    table: Table;
    join: (seat: Seat, table: Table) => Promise<Table>;
    /**
     * Another run as Alice, given `argument`: of the table's pattern, or of
     * `program`.
     */
    secondRun: (
      argument: Record<string, unknown>,
      program?: ReturnType<typeof programOf>,
    ) => Promise<Table>;
  }) => Promise<void>,
): Promise<void> => {
  const identities = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
      Identity.fromPassphrase(`display fit seat views ${name}`)
    ),
  );
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
    });
    return { did: identity.did(), runtime, storageManager };
  });
  try {
    // The access list `spaceAccess()` reads, and the capture check reads for
    // the subject's sole owner: Alice owns the table's space.
    const acl = new ACLManager(alice.runtime, space);
    await acl.set(alice.did as never, "OWNER");
    await acl.set(bob.did as never, "WRITE");
    await acl.set(carol.did as never, "WRITE");

    let runs = 0;
    const run = async (
      argument: Record<string, unknown>,
      program: ReturnType<typeof programOf> = programOf(source),
    ): Promise<Table> => {
      const tx = alice.runtime.edit();
      const pattern = await alice.runtime.patternManager.compilePattern(
        program,
        { space: space as never, tx },
      );
      const result = alice.runtime.getCell<Record<string, unknown>>(
        space as never,
        `seat views table ${runs++}`,
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
    await body({
      space,
      alice,
      bob,
      carol,
      table: await run({}),
      join,
      secondRun: run,
    });
  } finally {
    for (const seat of [alice, bob, carol]) {
      await seat.runtime.idle();
      await seat.runtime.dispose();
      await seat.storageManager.close();
    }
    await server.close();
  }
};

/** Sets a table up, seats Alice at 0 and Bob at 1, and deals. */
const play = async (
  { alice, bob }: { alice: Seat; bob: Seat },
  table: Table,
  bobsTable: Table,
): Promise<void> => {
  await send(alice, table, "move", { kind: "setup" });
  await send(alice, table, "seating", { kind: "open" });
  await until(at(bobsTable, "phase"), (phase) => phase === "open");
  await send(bob, bobsTable, "seating", { kind: "sit", seat: 1 });
  await until(
    at(table, "roster") as Cell<string[]>,
    (roster) => roster?.[1] === bob.did,
  );
  await send(alice, table, "seating", { kind: "sit", seat: 0 });
  await send(alice, table, "seating", { kind: "close" });
  await send(alice, table, "move", { kind: "deal" });
  await at(table, "view0").pull();
};

/** Whether `view` holds a dealt hand. */
const dealt = (view: unknown): boolean =>
  // deno-lint-ignore no-explicit-any
  ((view as any)?.hand?.length ?? 0) > 0;

Deno.test("display fit of the seat views", async (t) => {
  await atTable(SOURCE, async ({ space, alice, bob, carol, table, join }) => {
    const bobsTable = await join(bob, table);
    const carolsTable = await join(carol, table);

    await t.step("shows nobody a view before anyone sits", async () => {
      await send(alice, table, "move", { kind: "setup" });
      await at(table, "view0").pull();
      expect(at(table, "view0", "version").get()).toBe(1);
      expect(await shown(alice, table, space)).toEqual([]);
    });

    await t.step("ignores a seat taken for somebody else", async () => {
      // Carol asks for seat 2 in Bob's name, and Alice, who owns the table,
      // asks for it in Bob's name too.

      await send(alice, table, "seating", { kind: "open" });
      await until(at(carolsTable, "phase"), (phase) => phase === "open");
      await send(carol, carolsTable, "seating", {
        kind: "sit",
        seat: 2,
        occupant: bob.did,
      });
      await send(alice, table, "seating", {
        kind: "sit",
        seat: 2,
        occupant: bob.did,
      });
      await at(table, "roster").pull();
      expect(at(table, "roster").get()).toEqual([]);
      expect(at(table, "occupants2").get()).toEqual([]);
    });

    await t.step("seats each principal who sits for themselves", async () => {
      await until(at(bobsTable, "phase"), (phase) => phase === "open");
      await send(bob, bobsTable, "seating", { kind: "sit", seat: 1 });
      await until(
        at(table, "roster") as Cell<string[]>,
        (roster) => roster?.[1] === bob.did,
      );
      await send(alice, table, "seating", { kind: "sit", seat: 0 });
      await send(alice, table, "seating", { kind: "close" });
      expect(at(table, "roster").get()).toEqual([alice.did, bob.did, ""]);
    });

    await t.step("shows each occupant their own seat's view", async () => {
      await send(alice, table, "move", { kind: "deal" });
      await until(at(bobsTable, "view1"), dealt);
      await until(at(carolsTable, "view1"), dealt);
      await at(table, "view0").pull();
      expect(dealt(at(table, "view0").get())).toBe(true);
      expect(await shown(alice, table, space)).toEqual(["view0"]);
      expect(await shown(bob, bobsTable, space)).toEqual(["view1"]);
    });

    await t.step("shows a watcher no view", async () => {
      expect(await shown(carol, carolsTable, space)).toEqual([]);
    });

    await t.step("shows a hand's cards one at a time too", () => {
      expect(refusal(alice, at(table, "view0", "hand"), space))
        .toBeUndefined();
      expect(refusal(alice, at(table, "view0", "hand", "0"), space))
        .toBeUndefined();
      expect(refusal(alice, at(table, "view1", "hand", "0"), space))
        .toBeDefined();
    });
  });
});

Deno.test(
  "display fit of the seat views against a second run on the table's state",
  async (t) => {
    // The table's owner starts a second run of the table's pattern, inside
    // a pattern that hands it the live table's state, and sits in a seat of
    // it. The second run needs seat keys of its own, which only a setup
    // writes, so this table's `move` lets a setup be made again.

    await atTable(
      REKEYING_SOURCE,
      async ({ space, alice, bob, table, join, secondRun }) => {
        const bobsTable = await join(bob, table);
        await play({ alice, bob }, table, bobsTable);
        const state = table.getArgumentCell<Record<string, unknown>>()!.key(
          "state",
        );
        const second = await secondRun(
          { state },
          lentStateProgramOf(REKEYING_SOURCE),
        );

        await t.step(
          "computes the live table's hands in its views",
          async () => {
            await send(alice, second, "move", { kind: "setup" });
            await send(alice, second, "seating", { kind: "open" });
            await send(alice, second, "seating", { kind: "sit", seat: 1 });
            await at(second, "view1").pull();
            await at(table, "view1").pull();
            expect(dealt(at(second, "view1").get())).toBe(true);
            expect(at(second, "view1", "hand").get()).toEqual(
              at(table, "view1", "hand").get(),
            );
          },
        );

        await t.step("shows the owner none of them", async () => {
          // The second run reaches the state through a link in its argument,
          // a slot `move` did not write, so its views carry no input witness
          // (SEALED-STATE-MACHINE-FINDINGS.md, gap D).

          expect(await shown(alice, second, space)).toEqual([]);
        });

        await t.step("leaves the live table as it was", async () => {
          // The second run's setup wrote the state the two runs share, so
          // the live table's views were computed again.

          expect(await shown(alice, table, space)).toEqual(["view0"]);
          const version = at(table, "view0", "version").get();
          await until(
            at(bobsTable, "view1", "version"),
            (seen) => seen === version,
          );
          expect(await shown(bob, bobsTable, space)).toEqual(["view1"]);
        });
      },
    );
  },
);

Deno.test(
  "display fit of the seat views against a second binding of the list's writer",
  async (t) => {
    // The table's owner runs a pattern of another module that binds the
    // table module's `seating` handler to the live table's seat-1 list, and
    // sits in it.

    await atTable(
      SOURCE,
      async ({ space, alice, bob, table, join, secondRun }) => {
        const bobsTable = await join(bob, table);
        await play({ alice, bob }, table, bobsTable);
        expect(await shown(alice, table, space)).toEqual(["view0"]);
        const borrowed = await secondRun(
          { theirs: at(table, "occupants1") },
          borrowedSeatingProgramOf(SOURCE),
        );

        await t.step(
          "writes the owner into the live table's list",
          async () => {
            await send(alice, borrowed, "seating", { kind: "open" });
            await send(alice, borrowed, "seating", { kind: "sit", seat: 1 });
            await at(table, "occupants1").pull();
            expect(at(table, "occupants1").get()).toEqual([
              { principal: alice.did },
            ]);
            expect(at(table, "roster").get()).toEqual([alice.did, bob.did, ""]);
          },
        );

        await t.step("shows the owner the other player's hand", async () => {
          // A known hole in the draft (SEAT-VIEWS-FINDINGS.md, worry c): a
          // list's declared writer names a handler, and not the run the
          // handler is bound in.

          expect(await shown(alice, table, space)).toEqual(["view0", "view1"]);
        });
      },
    );
  },
);

Deno.test(
  "display fit of the seat views with keys another handler wrote",
  async (t) => {
    // The seat keys are confidential inputs of `seatView`, so a key `move`
    // did not write leaves the view without the input witness the rule
    // names, whatever wrote the state.

    await atTable(FOREIGN_KEY_SOURCE, async ({ space, alice, table }) => {
      await send(alice, table, "move", { kind: "setup" });
      await send(alice, table, "keyer", undefined);
      await send(alice, table, "seating", { kind: "open" });
      await send(alice, table, "seating", { kind: "sit", seat: 0 });
      await send(alice, table, "seating", { kind: "close" });
      await send(alice, table, "move", { kind: "deal" });

      await t.step("computes the occupant's view", async () => {
        await at(table, "view0").pull();
        expect(dealt(at(table, "view0").get())).toBe(true);
      });

      await t.step("shows the occupant nothing", async () => {
        expect(await shown(alice, table, space)).toEqual([]);
      });
    });
  },
);
