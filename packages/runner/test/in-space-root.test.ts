import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { type Cell } from "../src/cell.ts";
import { getEntityId } from "../src/create-ref.ts";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  ensureSpaceRootPattern,
  type EnsureSpaceRootResult,
  patternSourceUrl,
  resolveSpaceRootPattern,
} from "../src/ensure-space-root.ts";
import { parseLink } from "../src/link-utils.ts";
import { inSpaceRootCause } from "../src/runner.ts";
import { Runtime, type RuntimeFetch } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("in-space root signer");
const home = signer.did();
const aliceSigner = await Identity.fromPassphrase("in-space root alice");
const serviceSigner = await Identity.fromPassphrase("in-space root service");

const API_URL = new URL("http://toolshed.test");

/** The system default root, which a space-root ensure creates. */
const DEFAULT_APP_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "const Root = pattern<Record<string, never>, { marker: string }>(" +
  `() => ({ marker: computed(() => "default-app") }));`,
  "export default Root;",
  "",
].join("\n");

const fetchDefaultApp: RuntimeFetch = (input) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  );
  return Promise.resolve(
    url.pathname ===
        patternSourceUrl(DEFAULT_APP_PATTERN_SOURCE, API_URL).pathname
      ? new Response(DEFAULT_APP_SOURCE)
      : new Response("not found", { status: 404 }),
  );
};

describe("in-space root", () => {
  let server: MemoryV2Server.Server;
  const opened: Runtime[] = [];

  /** A runtime of its own over this test's server, as another process. */
  const openRuntime = (
    options: { as?: Identity; servingPosture?: boolean } = {},
  ): Runtime => {
    const next = new Runtime({
      apiUrl: API_URL,
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: options.as ?? signer,
      }),
      fetch: fetchDefaultApp,
      ...(options.servingPosture
        ? { servingPosture: true, experimental: { serverExecution: true } }
        : {}),
    });
    opened.push(next);
    return next;
  };

  /** The root linked in `space`, as `reader` resolves it. */
  const rootOf = async (
    reader: Runtime,
    space: MemorySpace,
  ): Promise<Cell<unknown> | undefined> => {
    await reader.storageManager.synced();
    return await resolveSpaceRootPattern(reader, space);
  };

  /** The address the genesis reservation of an `inSpace` root names. */
  const reservedRootOf = (reader: Runtime, space: MemorySpace) =>
    reader.getCell(space, inSpaceRootCause(space));

  /**
   * Runs a root pattern whose `create` handler appends the children `make`
   * returns, and returns a way to send it events and read the spaces its
   * children landed in.
   */
  const spawnRoot = async (
    runtime: Runtime,
    make: (Child: any, value: string) => unknown[],
  ) => {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const create = handler<
      { value: string },
      { children: Cell<unknown[]> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: { children: { asCell: ["cell"] } },
      required: ["children"],
    }, ({ value }, { children }) => {
      for (const child of make(Child, value)) children.push(child);
    });
    const Root = pattern<{ children: Cell<unknown[]> }>(
      ({ children }) => ({ children, create: create({ children }) }),
      {
        type: "object",
        properties: { children: { asCell: ["cell"] } },
        required: ["children"],
      } as const,
    );
    const tx = runtime.edit();
    const children = runtime.getCell<unknown[]>(
      home,
      `in-space root children ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    children.set([]);
    const result = runtime.run(
      tx,
      Root,
      { children },
      runtime.getCell(
        home,
        `in-space root root ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    return {
      send: async (value: string) => {
        result.key("create").send({ value });
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      spaces: async (): Promise<MemorySpace[]> => {
        await children.pull();
        return (children.getRaw() as unknown[]).map((raw) =>
          parseLink(raw, children)!.space! as MemorySpace
        );
      },
    };
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    for (const each of opened.splice(0)) await each.dispose();
    await server.close();
  });

  it("places the child at the reserved address, links it as the root of its space, and seals the reservation at genesis", async () => {
    const runtime = openRuntime();
    const root = await spawnRoot(runtime, (Child, value) => [
      Child.inSpace(undefined, { root: true })({ value }),
    ]);
    await root.send("first");

    const [space] = await root.spaces();
    expect(space).not.toBe(home);
    expect(readGenesisRoot(await server.engineForSpace(space))).toEqual({
      cause: inSpaceRootCause(space),
    });
    const reader = openRuntime();
    const linked = await rootOf(reader, space);
    expect(linked?.equals(reservedRootOf(reader, space))).toBe(true);
    expect(
      await linked!.key("value").asSchema({ type: "string" }).pull(),
    ).toBe("first");
  });

  it("keeps the one root when a second event names the same space", async () => {
    const runtime = openRuntime();
    const root = await spawnRoot(runtime, (Child, value) => [
      Child.inSpace("room", { root: true })({ value }),
    ]);
    await root.send("first");
    await root.send("second");

    const [first, second] = await root.spaces();
    expect(second).toBe(first);
    const reader = openRuntime();
    expect(
      (await rootOf(reader, first))?.equals(
        reservedRootOf(reader, first),
      ),
    ).toBe(true);
  });

  it("gives the roots of two spaces different entities", async () => {
    // A pattern keys a record by the entity a cell names, as one keys a
    // person's record by their profile, so two spaces' roots must name two.
    const runtime = openRuntime();
    const root = await spawnRoot(runtime, (Child, value) => [
      Child.inSpace(value, { root: true })({ value }),
    ]);
    await root.send("first");
    await root.send("second");

    const [first, second] = await root.spaces();
    expect(second).not.toBe(first);
    const reader = openRuntime();
    const firstEntity = getEntityId(await rootOf(reader, first));
    const secondEntity = getEntityId(await rootOf(reader, second));
    expect(firstEntity).toBeDefined();
    expect(secondEntity).toBeDefined();
    expect(secondEntity).not.toEqual(firstEntity);
  });

  it("wins the race with a space-root ensure that runs between the space's genesis and the child's commit", async () => {
    const runtime = openRuntime();
    const ensurer = openRuntime();
    const outcomes: EnsureSpaceRootResult["outcome"][] = [];
    const create = runtime.createSpace.bind(runtime);
    runtime.createSpace = async (options) => {
      const space = await create(options);
      const result = await ensureSpaceRootPattern(ensurer, space, {
        isHomeSpace: false,
        genesisRoot: readGenesisRoot(await server.engineForSpace(space)),
      });
      outcomes.push(result.outcome);
      await ensurer.idle();
      await ensurer.storageManager.synced();
      return space;
    };
    const root = await spawnRoot(runtime, (Child, value) => [
      Child.inSpace(undefined, { root: true })({ value }),
    ]);
    await root.send("first");

    expect(outcomes).toEqual(["awaiting-creator"]);
    const [space] = await root.spaces();
    const reader = openRuntime();
    expect(
      (await rootOf(reader, space))?.equals(
        reservedRootOf(reader, space),
      ),
    ).toBe(true);
  });

  it("places the root in the same space when a run abandoned after the space's genesis is followed by another", async () => {
    const runtime = openRuntime();
    const create = runtime.createSpace.bind(runtime);
    const created: MemorySpace[] = [];
    runtime.createSpace = async (options) => {
      const space = await create(options);
      created.push(space);
      return space;
    };
    let calls = 0;
    const root = await spawnRoot(runtime, (Child, value) => {
      calls++;
      // The first call names a space nothing has created; the second, its
      // re-run once the space exists, is abandoned before it commits.
      if (calls === 2) throw new Error("abandoned after genesis");
      return [Child.inSpace("room", { root: true })({ value })];
    });
    await root.send("abandoned");
    expect(calls).toBe(2);
    expect(created.length).toBe(1);
    expect(await root.spaces()).toEqual([]);
    const reader = openRuntime();
    expect(await rootOf(reader, created[0])).toBeUndefined();

    await root.send("again");
    expect(created.length).toBe(1);
    expect(await root.spaces()).toEqual([created[0]]);
    expect(
      (await rootOf(reader, created[0]))?.equals(
        reservedRootOf(reader, created[0]),
      ),
    ).toBe(true);
  });

  it("leaves a root the named space already links in place", async () => {
    const runtime = openRuntime();
    const existing = await runtime.createSpace();
    const linkedPrior = await runtime.editWithRetry((tx) => {
      const prior = runtime.getCell<{ prior: boolean }>(
        existing,
        "prior-root",
        undefined,
        tx,
      );
      prior.set({ prior: true });
      runtime.getSpaceCell(existing).withTx(tx).key("defaultPattern").set(
        prior,
      );
    });
    expect(linkedPrior.error).toBeUndefined();
    const recorded = await runtime.editWithRetry((tx) => {
      runtime.getCell(
        home,
        { inSpaceAllocation: { space: home, name: "existing" } },
        undefined,
        tx,
      ).set({ did: existing });
    });
    expect(recorded.error).toBeUndefined();
    const root = await spawnRoot(runtime, (Child, value) => [
      Child.inSpace("existing", { root: true })({ value }),
    ]);
    await root.send("first");

    expect(await root.spaces()).toEqual([existing]);
    const reader = openRuntime();
    expect(
      (await rootOf(reader, existing))?.equals(
        reader.getCell(existing, "prior-root"),
      ),
    ).toBe(true);
  });

  it("refuses `root` for a space named by its DID", () => {
    const runtime = openRuntime();
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    expect(() => Child.inSpace(home, { root: true })).toThrow(
      "a DID or a cell names a space that exists",
    );
  });

  it("refuses `root` for a pattern whose result is not space-scoped, whichever of `asScope()` and `inSpace()` comes first", () => {
    const runtime = openRuntime();
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    expect(() => Child.asScope("user").inSpace("room", { root: true }))
      .toThrow("this one is `user`-scoped");
    expect(() => Child.inSpace("room", { root: true }).asScope("session"))
      .toThrow("this one is `session`-scoped");
    expect(() => Child.asScope("space").inSpace("room", { root: true })).not
      .toThrow();
  });

  it("reserves the root in the genesis of a space a serving runtime creates for its acting user", async () => {
    const serving = openRuntime({ as: serviceSigner, servingPosture: true });
    const space = await serving.resolveInSpaceName(home, "served-room", {
      owner: aliceSigner.did(),
      root: true,
    });
    const engine = await server.engineForSpace(space);
    expect(readGenesisRoot(engine)).toEqual({
      cause: inSpaceRootCause(space),
    });
    expect((await server.readDocument(space, `of:${space}`))?.value).toEqual({
      [aliceSigner.did()]: "OWNER",
    });
  });
});
