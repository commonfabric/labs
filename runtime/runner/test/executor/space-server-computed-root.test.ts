import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../../src/executor/host.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const space = (await Identity.fromPassphrase(
  "space-server computed root space",
)).did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server computed root service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server computed root setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server computed root alice",
);
const bobSigner = await Identity.fromPassphrase(
  "space-server computed root bob",
);

/** A piece with one output, `total`, derived from its input. */
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }, { total: number }>(",
      "  ({ n }) => ({ total: computed(() => n + 1) }),",
      ");",
    ].join("\n"),
  }],
};

/** A piece with one output, `mine`, derived once for each viewer. */
const PER_USER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, PerUser } from 'commonfabric';",
      "export default pattern<{ n: number }, { mine: string }>(({ n }) => {",
      "  const mine = computed((): PerUser<string> => 'mine:' + String(n));",
      "  return { mine };",
      "});",
    ].join("\n"),
  }],
};

/** The id of a document that holds a link to the piece's `total`. */
const POINTER_ID = "of:computed-root-pointer";

/** Longer than the memory server keeps the session of a client that left. */
const DETACHED_SESSION_MS = 31_000;

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;

  /** The runtimes the host made, one for each tenure it has served. */
  let servingRuntimes: Runtime[];
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A client runtime over the shared server, acting for `as`. */
  const openRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    opened.push({ runtime, manager });
    return runtime;
  };

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    servingRuntimes = [];
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.push(runtime);
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { idleParkMs: 600_000 },
    });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const { runtime, manager } of opened.splice(0)) {
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** Whether a serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntimes.some((runtime) =>
      runtime.runner.isRunning(runtime.getCellFromLink(root))
    );

  /** Has the client that `openRuntime()` returned last leave. */
  const closeLastRuntime = async () => {
    const { runtime, manager } = opened.pop()!;
    await runtime.dispose();
    await manager.close();
  };

  /**
   * Stands a piece of `program` up as a client that then leaves, with a
   * document that links to its output `output`, parks the space, and then
   * changes the piece's input to 41 with no client, so that the output the
   * store holds is out of date and nothing runs the piece. With `viewer`,
   * that viewer watches the piece's result before the space is parked, so
   * that the store holds their own instance of the output. Returns the
   * piece's root and the address of the `computed:` document that holds
   * the output, as the viewer reads it where there is one.
   */
  const standUpParkAndChange = async (
    program: RuntimeProgram,
    output: string,
    viewer?: Identity,
  ) => {
    const setup = openRuntime(setupSigner);
    const compiled = await setup.patternManager.compilePattern(program, {
      space,
    });
    const argument = setup.getCell<{ n: number }>(
      space,
      "computed root argument",
      compiled.argumentSchema,
    );
    const result = setup.getCell<Record<string, unknown>>(
      space,
      "computed root result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const tx = setup.edit();
    argument.withTx(tx).set({ n: 1 });
    setup.run(tx, compiled, argument, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    result.sink(() => {});
    await waitForCellValue(
      setup,
      result.key(output),
      (value: unknown) => value !== undefined,
      { stuckLabel: "the piece to derive its first output" },
    );
    await host!.whenQuiescent();
    const pointer = setup.getCellFromLink<Record<string, unknown>>({
      space,
      id: POINTER_ID as never,
      path: [],
    });
    await pointer.sync();
    const link = setup.edit();
    pointer.withTx(link).set({ to: result.withTx(link).key(output) });
    expect((await link.commit().settled).error).toBeUndefined();
    const root = result.getAsNormalizedFullLink();
    const input = argument.getAsNormalizedFullLink().id;
    let derived = result.key(output).resolveAsCell().getAsNormalizedFullLink();
    await closeLastRuntime();
    if (viewer !== undefined) {
      const viewing = openRuntime(viewer);
      const viewed = viewing.getCell<Record<string, unknown>>(
        space,
        "computed root result",
        compiled.resultSchema,
      );
      await viewed.sync();
      viewed.sink(() => {});
      await waitForCellValue(
        viewing,
        viewed.key(output),
        (value: unknown) => value !== undefined,
        { stuckLabel: "the piece to derive the viewer's own output" },
      );
      await host!.whenQuiescent();
      derived = viewed.key(output).resolveAsCell().getAsNormalizedFullLink();
      await closeLastRuntime();
    }
    expect(derived.id.startsWith("computed:")).toBe(true);
    await host!.whenQuiescent();
    await clock.tick(DETACHED_SESSION_MS);
    await host!.whenQuiescent();
    await host!.spaceServer(space)?.park("test-park");
    const held = await server.readDocument(space, input);
    await server.writeDocument(space, input, {
      ...(held?.value as Record<string, unknown>),
      n: 41,
    });
    await server.idle();
    return { root, derived };
  };

  /** The demand rows of the space's sessions for the document `id`. */
  const rowsFor = (id: string) =>
    server.demandForSpace(space, { excludePrincipal: serviceSigner.did() })
      .flatMap((share) => [...share.rows.values()])
      .filter((row) => row.id === id);

  describe("instance members", () => {
    describe("a demanded `computed:` document", () => {
      it("starts the piece for a viewer who names the document and watches nothing else of the piece", async () => {
        const { root, derived } = await standUpParkAndChange(PROGRAM, "total");
        expect(serves(root)).toBe(false);

        const alice = openRuntime(aliceSigner);
        const cell = alice.getCellFromLink<number>({
          space,
          id: derived.id,
          path: [],
        });
        await cell.sync();
        cell.sink(() => {});

        await waitForCellValue(
          alice,
          cell,
          (value: number | undefined) => value === 42,
          { stuckLabel: "alice to read the total derived from the new input" },
        );
        expect(serves(root)).toBe(true);
      });

      it("starts the piece for a viewer who names their own instance of the document and watches nothing else of the piece", async () => {
        // The serving identity holds no instance of an output derived once
        // for each viewer, and the space holds none either, so the piece is
        // found through the instance of the viewer who demands it.

        const { root, derived } = await standUpParkAndChange(
          PER_USER_PROGRAM,
          "mine",
          aliceSigner,
        );
        expect(derived.scope).toBe("user");
        expect(serves(root)).toBe(false);

        const alice = openRuntime(aliceSigner);
        const cell = alice.getCellFromLink<string>({
          space,
          id: derived.id,
          scope: "user",
          path: [],
        });
        await cell.sync();
        cell.sink(() => {});

        await waitForCellValue(
          alice,
          cell,
          (value: string | undefined) => value === "mine:41",
          { stuckLabel: "alice to read her output derived from the new input" },
        );
        expect(serves(root)).toBe(true);
      });

      it("derives the instance of a viewer who names it while the piece runs for another viewer", async () => {
        const { root, derived } = await standUpParkAndChange(
          PER_USER_PROGRAM,
          "mine",
          aliceSigner,
        );
        const bob = openRuntime(bobSigner);
        const watched = bob.getCellFromLink<{ mine: string }>({
          space,
          id: root.id,
          path: [],
        }).asSchema({
          type: "object",
          properties: { mine: { type: "string" } },
        });
        await watched.sync();
        watched.sink(() => {});
        await waitForCellValue(
          bob,
          watched.key("mine"),
          (value: string | undefined) => value === "mine:41",
          { stuckLabel: "bob to read his output derived from the new input" },
        );
        expect(serves(root)).toBe(true);

        const alice = openRuntime(aliceSigner);
        const cell = alice.getCellFromLink<string>({
          space,
          id: derived.id,
          scope: "user",
          path: [],
        });
        await cell.sync();
        cell.sink(() => {});

        await waitForCellValue(
          alice,
          cell,
          (value: string | undefined) => value === "mine:41",
          { stuckLabel: "alice to read her output derived from the new input" },
        );
      });

      it("starts nothing for a viewer who was sent the document and names another", async () => {
        // The viewer names a document that links to the piece's output, so
        // the output is sent along with it and no watch names it.

        const { root, derived } = await standUpParkAndChange(PROGRAM, "total");

        const alice = openRuntime(aliceSigner);
        const pointer = alice.getCellFromLink<{ to: number }>({
          space,
          id: POINTER_ID as never,
          path: [],
        }).asSchema({
          type: "object",
          properties: { to: { type: "number" } },
        });
        await pointer.sync();
        await host!.whenQuiescent();

        expect(
          rowsFor(derived.id).map(({ root, piece }) => ({ root, piece })),
        ).toEqual([{ root: false, piece: true }]);
        expect(serves(root)).toBe(false);
        expect((await server.readDocument(space, derived.id))?.value).toBe(2);
      });
    });
  });
});
