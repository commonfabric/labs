/**
 * The setup a headless FabriChat integration test spends almost all of its
 * time in: bringing up a new person's Home, creating their profile, creating a
 * group room, and starting a fresh client of a Home that already exists. The
 * `fabrichat-room-list-*` tests do each of these many times before they
 * assert anything, and `fabrichat-room-fixture.ts` does them for every member
 * of a seeded room.
 *
 * Each step is its own benchmark in the `fabrichat setup` group:
 *
 * - `home cold`: `ensureDefaultPattern()` for a new person, until the client
 *   has settled, with the client, and the serving loop when it runs in this
 *   process, compiling into one compile cache that starts empty, so the Home
 *   pattern compiles from source once. What the process keeps beyond that
 *   cache, the compiler's own modules and its parse memos among them, is
 *   already warm when the first measured invocation starts.
 * - `home warm`: the same with the compile caches holding what earlier
 *   bring-ups compiled.
 * - `profile`: Home's `createProfile`, sent as a click on its reviewed action,
 *   until Home lists the profile and the client has settled.
 * - `room`: `RoomListServer.createGroup()`, the room-list tests' way of
 *   creating a room: the manager's `createGroup`, sent the same way, until the
 *   request reports done and the client has settled, and the read of the new
 *   room's link that follows.
 * - `reopen`: `RoomListServer.bootClient()`, the room-list tests' way of
 *   starting a fresh client of a Home, here one holding a profile and a room:
 *   from starting its controller through `ensureDefaultPattern()` and
 *   `adoptCatalogRooms()` until it has settled, with the record of every
 *   document it loads that those tests keep.
 *
 * "Settled" is `RoomListServer.settle()`, which the room-list tests wait on
 * between steps.
 *
 * Every invocation starts a `RoomListServer` of its own and generates new
 * people, outside the measured window, so no invocation sees another's
 * spaces. What a step needs before it, a Home or a profile or a room, is done
 * untimed with the warm compile cache. The posture resolves from
 * `EXPERIMENTAL_SERVER_EXECUTION`, as the tests' does, and goes to stderr at
 * startup.
 *
 * No toolshed or browser is needed. Locally:
 *
 *     CF_LOG_LEVEL=silent deno bench -A \
 *       patterns/integration/fabrichat-setup.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import {
  type ModuleByteCache,
  ProcessModuleByteCache,
} from "@commonfabric/test-support/compile-byte-cache";
import { describeThrown } from "../../runtime/integration/describe-thrown.ts";
import { reporter } from "./fabrichat-room-bench-support.ts";
import {
  closeMember,
  createProfile,
  openMember,
} from "./fabrichat-room-fixture.ts";
import {
  type Client,
  memberOf,
  RoomListServer,
  serving,
} from "./fabrichat-room-list-fixture.ts";
import {
  initializePiecesController,
  moduleByteCache,
} from "./pieces-controller.ts";

/**
 * Stable dashboard group used with this file and the benchmark name to
 * identify each step's series.
 */
const GROUP = "fabrichat setup";

/**
 * Measured iterations per step. `Deno.bench` invokes a body `n + 2` times and
 * drops only the first invocation, whatever `warmup` is set to (measured on
 * Deno 2.9.4), so `n` is one less than the iterations a run measures.
 */
const ITERATIONS = 5;

const report = reporter("fabrichat-setup");

report(
  `server execution ${serving ? "on" : "off"}; ${ITERATIONS} measured ` +
    "iterations per step",
);

/** A person no earlier invocation has seen. */
const newPerson = () => Identity.generate({ implementation: "noble" });

/** Times `operation`, and nothing else. */
type Timed = (operation: () => Promise<void>) => Promise<void>;

/**
 * Registers a step. Each invocation starts a server, runs `measure` with the
 * timer bracketing only what `measure` hands to `timed`, which it must do
 * exactly once, and closes the server whatever happens. The server's serving
 * loop, when it has one in this process, compiles into what `cache()` returns,
 * which `measure` is handed too.
 */
function step(
  name: string,
  measure: (
    server: RoomListServer,
    timed: Timed,
    cache: ModuleByteCache,
  ) => Promise<void>,
  cache: () => ModuleByteCache = () => moduleByteCache,
): void {
  Deno.bench({ name, group: GROUP, n: ITERATIONS - 1 }, async (b) => {
    const compiled = cache();
    const server = await RoomListServer.start(compiled);
    try {
      let times = 0;
      await measure(server, async (operation) => {
        times++;
        b.start();
        await operation();
        b.end();
      }, compiled);
      if (times !== 1) {
        throw new Error(`${name} timed ${times} operations rather than one`);
      }
    } catch (error) {
      report(`${name} failed: ${describeThrown(error)}`);
      throw error;
    } finally {
      await server.close();
    }
  });
}

/** Brings up a new person's Home in a client compiling into `cache`. */
async function bringUpHome(
  server: RoomListServer,
  timed: Timed,
  cache: ModuleByteCache,
): Promise<void> {
  const person = await newPerson();
  const controller = await initializePiecesController({
    space: person.did(),
    apiUrl: server.url,
    identity: person,
    moduleByteCache: cache,
  });
  try {
    await timed(async () => {
      await controller.ensureDefaultPattern();
      await server.settle(controller);
    });
  } finally {
    await controller.dispose();
  }
}

step("home cold", bringUpHome, () => new ProcessModuleByteCache());

step("home warm", bringUpHome);

step("profile", async (server, timed) => {
  const person = await newPerson();
  const client = await server.bootClient({ person, adopt: false });
  try {
    await timed(async () => {
      await createProfile(memberOf(client, person));
      await server.settle(client.controller);
    });
  } finally {
    await server.dispose(client.controller);
  }
});

step("room", async (server, timed) => {
  const member = await openMember(server.url, await newPerson(), 0);
  try {
    await server.settle(member.controller);
    await timed(async () => {
      await server.createGroup(member, "benchmark", "Benchmark room");
    });
  } finally {
    await closeMember(member);
  }
});

step("reopen", async (server, timed) => {
  const person = await newPerson();
  const member = await openMember(server.url, person, 0);
  try {
    await server.createGroup(member, "benchmark", "Benchmark room");
  } finally {
    await closeMember(member);
  }
  let client: Client | undefined;
  try {
    await timed(async () => {
      client = await server.bootClient({ person });
    });
  } finally {
    if (client !== undefined) await server.dispose(client.controller);
  }
});
