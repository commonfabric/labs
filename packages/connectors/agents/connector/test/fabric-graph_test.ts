import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { isLinkRef, linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  materializeStableArrayCells,
  planStableArrayCells,
} from "../src/array-cell-identity.ts";
import {
  agentOwnerSchema,
  cellHasOwnerProtection,
  pushStableCellGraph,
  readStableCellGraphValue,
} from "../src/fabric-graph.ts";
import { stableFabricValue } from "../src/stable-fabric-value.ts";

// `pushStableCellGraph` sets its writer identity through the runtime's
// setter, which accepts only a transaction the runtime created. These
// fixtures take one from a real runtime and replace the members the graph
// write calls, so the fixture decides every outcome except that one.
const withRuntimeTransaction = async (
  body: (
    fakeTransaction: (members: Record<string, unknown>) => unknown,
  ) => Promise<void>,
): Promise<void> => {
  const signer = await Identity.fromPassphrase("agent connector graph fixture");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    await body((members) => Object.assign(runtime.edit(), members));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

Deno.test("stable values replace cells inside native errors", async () => {
  const signer = await Identity.fromPassphrase("agent connector error test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const cell = runtime.getCell(signer.did(), { graphTest: "error-cell" });
    const error = new TypeError("provider failed", { cause: cell });
    Object.defineProperty(error, "detail", {
      enumerable: true,
      get: () => ({ cell }),
    });
    const stored = stableFabricValue(error) as FabricError;
    assertEquals(stored instanceof FabricError, true);
    assertEquals(stored.type, "TypeError");
    assertEquals(isLinkRef(stored.cause), true);
    assertEquals(
      isLinkRef(
        (stored.getExtra("detail") as Record<string, unknown>).cell,
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable values retain reserved keys for validation", () => {
  assertThrows(
    () => stableFabricValue({ ["__proto__"]: "invalid" }),
    Error,
  );
});

Deno.test("stable graph writes keep child identity and hydrate linked values", async () => {
  const signer = await Identity.fromPassphrase("agent connector graph test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  let coldRuntime: Runtime | undefined;
  try {
    const parent = runtime.getCell(space, { graphTest: "parent" });
    const childIdsByPass: string[][] = [];
    for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
      const childIds: string[] = [];
      await pushStableCellGraph(connection, [{
        cell: parent,
        value: (materializeCell) => ({
          items: order.map((id) => {
            const child = materializeCell(
              { graphTest: "item", id },
              { id, label: id.toUpperCase() },
            );
            childIds.push(child.getAsNormalizedFullLink().id!);
            return child;
          }),
        }),
      }]);
      childIdsByPass.push(childIds);
    }

    assertEquals(childIdsByPass[0], [
      childIdsByPass[1][1],
      childIdsByPass[1][0],
    ]);

    coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    assertEquals(
      await readStableCellGraphValue(
        { ...connection, runtime: coldRuntime },
        coldRuntime.getCell(space, { graphTest: "parent" }),
      ),
      {
        items: [
          { id: "beta", label: "BETA" },
          { id: "alpha", label: "ALPHA" },
        ],
      },
    );
  } finally {
    await coldRuntime?.dispose();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph writes preserve native `FabricValue`s", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector native graph test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const root = runtime.getCell(space, { graphTest: "native-values" });
    await pushStableCellGraph(connection, [{
      cell: root,
      value: () => ({
        date: new Date("2026-07-27T12:34:56.000Z"),
        expression: /agent-data/gi,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }]);

    const stored = await readStableCellGraphValue(
      connection,
      root,
    ) as Record<string, unknown>;
    const date = stored.date as FabricEpochNsec;
    const expression = stored.expression as FabricRegExp;
    const bytes = stored.bytes as FabricBytes;
    assertEquals(date instanceof FabricEpochNsec, true);
    assertEquals(expression instanceof FabricRegExp, true);
    assertEquals(bytes instanceof FabricBytes, true);
    assertEquals(
      date.value,
      BigInt(new Date("2026-07-27T12:34:56.000Z").getTime()) * 1_000_000n,
    );
    assertEquals(expression.source, "agent-data");
    assertEquals(expression.flags, "gi");
    assertEquals(bytes.slice(), new Uint8Array([1, 2, 3]));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph writes refuse populated unprotected cells", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector unprotected graph test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const unprotectedRoot = runtime.getCell(space, {
      graphTest: "unprotected-root",
    });
    const unprotectedChild = runtime.getCell(space, {
      graphTest: "unprotected-child",
    });
    const confidentialOnly = runtime.getCell(
      space,
      { graphTest: "confidential-only" },
      agentOwnerSchema(space, false),
    );
    await Promise.all([
      unprotectedRoot.sync(),
      unprotectedChild.sync(),
      confidentialOnly.sync(),
    ]);
    await storageManager.synced();
    const seed = runtime.edit();
    unprotectedRoot.withTx(seed).setRawUntyped({ exposed: "root" });
    unprotectedChild.withTx(seed).setRawUntyped({ exposed: "child" });
    const confidentialSeed = confidentialOnly.withTx(seed);
    confidentialSeed.setRawUntyped({ exposed: "confidential" });
    confidentialSeed.applyCfcSchemaToExistingValue();
    seed.prepareCfc();
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    await assertRejects(
      () =>
        pushStableCellGraph(connection, [{
          cell: unprotectedRoot,
          value: () => ({ exposed: false }),
        }]),
      Error,
      "refusing to adopt an unprotected stable graph cell",
    );

    await assertRejects(
      () =>
        pushStableCellGraph(connection, [{
          cell: confidentialOnly,
          value: () => ({ exposed: false }),
        }]),
      Error,
      "refusing to adopt an unprotected stable graph cell",
    );

    const parent = runtime.getCell(space, { graphTest: "protected-parent" });
    await parent.sync();
    await storageManager.synced();
    await assertRejects(
      () =>
        pushStableCellGraph(connection, [{
          cell: parent,
          value: (materializeCell) => ({
            child: materializeCell(
              { graphTest: "unprotected-child" },
              { exposed: false },
            ),
          }),
        }]),
      Error,
      "refusing to adopt an unprotected stable graph cell",
    );
    assertEquals(unprotectedRoot.getRaw(), { exposed: "root" });
    assertEquals(unprotectedChild.getRaw(), { exposed: "child" });
    assertEquals(confidentialOnly.getRaw(), { exposed: "confidential" });
    assertEquals(parent.getRaw(), undefined);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph writes one new cell referenced twice", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector repeated graph cell test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const parent = runtime.getCell(space, { graphTest: "repeated-parent" });
    await pushStableCellGraph(connection, [{
      cell: parent,
      value: (materializeCell) => ({
        first: materializeCell(
          { graphTest: "repeated-child" },
          { value: "shared" },
        ),
        second: materializeCell(
          { graphTest: "repeated-child" },
          { value: "shared" },
        ),
      }),
    }]);

    assertEquals(await readStableCellGraphValue(connection, parent), {
      first: { value: "shared" },
      second: { value: "shared" },
    });
    const child = runtime.getCell(space, { graphTest: "repeated-child" });
    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), child, space),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph deletes fields whose names exist on the prototype", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector inherited field test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const connection = {
    runtime,
    spaceDid: signer.did(),
    ownerDid: signer.did(),
  };
  try {
    const root = runtime.getCell(signer.did(), {
      graphTest: "inherited-fields",
    });
    await pushStableCellGraph(connection, [{
      cell: root,
      value: () => ({ toString: "old", hasOwnProperty: "old" }),
    }]);
    await pushStableCellGraph(connection, [{
      cell: root,
      value: () => ({}),
    }]);
    assertEquals(await readStableCellGraphValue(connection, root), {});
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph reads can preserve links in named fields", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector preserved graph link test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const child = runtime.getCell(space, { graphTest: "preserved-child" });
    const parent = runtime.getCell(space, { graphTest: "preserved-parent" });
    await pushStableCellGraph(connection, [{
      cell: child,
      value: () => ({ value: "child data" }),
    }, {
      cell: parent,
      value: () => ({ manifest: child }),
    }]);

    const preserved = await readStableCellGraphValue(
      connection,
      parent,
      new Map(),
      { preserveLinkFields: new Set(["manifest"]) },
    ) as Record<string, unknown>;

    assertEquals(isLinkRef(preserved.manifest), true);
    assertEquals(await readStableCellGraphValue(connection, parent), {
      manifest: { value: "child data" },
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable array planning preserves links to cell subpaths", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector graph subpath test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    const referenced = runtime.getCell(space, {
      graphTest: "subpath-reference",
    });
    const parent = runtime.getCell(space, { graphTest: "subpath-parent" });
    await pushStableCellGraph(connection, [{
      cell: referenced,
      value: () => ({ selected: "resolved" }),
    }]);
    const plan = await planStableArrayCells(
      { nested: referenced.key("selected") },
      { graphTest: "subpath-elements" },
    );
    await pushStableCellGraph(connection, [{
      cell: parent,
      value: (materializeCell) =>
        materializeStableArrayCells(
          plan,
          materializeCell,
        ) as Record<string, unknown>,
    }]);

    assertEquals(
      await readStableCellGraphValue(connection, parent),
      { nested: "resolved" },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph field writes preserve document metadata", async () => {
  const signer = await Identity.fromPassphrase("agent connector field writes");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const cell = runtime.getCell(space, { graphTest: "field-writes" });
  const connection = { runtime, spaceDid: space, ownerDid: space };
  try {
    await pushStableCellGraph(connection, [{
      cell,
      value: () => ({ retained: "before", removed: "stale" }),
    }]);
    const link = cell.getAsNormalizedFullLink();
    const metadataTx = runtime.edit();
    metadataTx.writeOrThrow(
      {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: ["connectorMetadata"],
      },
      { preserved: true },
    );
    // A manual test tx goes through the same preparation the runtime's own
    // commit paths do: a document-root write is CFC-relevant, and an
    // enforcing rung refuses a relevant transaction that arrives unprepared.
    runtime.prepareTxForCommit(metadataTx);
    const metadataCommit = await metadataTx.commit();
    if (metadataCommit.error) throw metadataCommit.error;

    await pushStableCellGraph(connection, [{
      cell,
      value: () => ({ retained: "after" }),
    }]);

    const inspectionTx = runtime.edit();
    try {
      assertEquals(
        inspectionTx.readOrThrow({
          space: link.space,
          scope: link.scope,
          id: link.id,
          path: ["connectorMetadata"],
        }),
        { preserved: true },
      );
      assertEquals(
        inspectionTx.readValueOrThrow(link),
        { retained: "after" },
      );
    } finally {
      inspectionTx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

function fakeCell(id = "of:parent") {
  const cell = {
    getAsNormalizedFullLink: () => ({
      space: "did:test:space",
      id,
      path: [],
    }),
    sync: () => Promise.resolve(),
    withTx: () => cell,
    asSchema: () => cell,
    setRawUntyped: () => {},
    applyCfcSchemaToExistingValue: () => {},
  };
  return cell;
}

Deno.test("stable graph hydrates the owner-schema cell before writing", async () => {
  await withRuntimeTransaction(async (fakeTransaction) => {
    let schemaBindings = 0;
    let syncs = 0;
    let writes = 0;
    let hydrated = false;
    const link = {
      space: "did:test:space",
      scope: "space",
      id: "of:parent",
      path: [],
    };
    const protectedCell = {
      getAsNormalizedFullLink: () => link,
      sync: () => {
        syncs++;
        hydrated = true;
        return Promise.resolve();
      },
      withTx: () => protectedCell,
      setRawUntyped: () => {
        assertEquals(hydrated, true);
        writes++;
      },
      applyCfcSchemaToExistingValue: () => assertEquals(hydrated, true),
    };
    const makeCell = () => ({
      getAsNormalizedFullLink: () => link,
      asSchema: () => {
        schemaBindings++;
        return protectedCell;
      },
    });
    const firstCell = makeCell();
    const secondCell = makeCell();
    const transaction = fakeTransaction({
      readValueOrThrow: () => undefined,
      writeOrThrow: () => {},
      prepareCfc: () => {},
      abort: () => ({ ok: {} }),
      commit: () => Promise.resolve({ ok: {} }),
    });

    await pushStableCellGraph(
      // deno-lint-ignore no-explicit-any -- focused runtime fixture.
      {
        runtime: { edit: () => transaction },
        spaceDid: "did:test:space",
        ownerDid: "did:test:owner",
      } as any,
      [
        {
          // deno-lint-ignore no-explicit-any -- focused cell fixture.
          cell: firstCell as any,
          value: () => ({ value: "first" }),
        },
        {
          // deno-lint-ignore no-explicit-any -- focused cell fixture.
          cell: secondCell as any,
          value: () => ({ value: "second" }),
        },
      ],
    );

    assertEquals(schemaBindings, 1);
    assertEquals(syncs, 1);
    assertEquals(writes, 2);
  });
});

Deno.test("stable graph writes await one commit", async () => {
  await withRuntimeTransaction(async (fakeTransaction) => {
    const commitStarted = Promise.withResolvers<void>();
    const commitResult = Promise.withResolvers<{
      ok: Record<string, never>;
    }>();
    let commitCount = 0;
    const transaction = fakeTransaction({
      readValueOrThrow: () => undefined,
      writeOrThrow: () => {},
      writeValueOrThrow: () => {},
      prepareCfc: () => {},
      abort: () => ({ ok: {} }),
      commit: () => {
        commitCount++;
        commitStarted.resolve();
        return commitResult.promise;
      },
    });
    const connection = {
      runtime: {
        edit: () => transaction,
      },
      spaceDid: "did:test:space",
      ownerDid: "did:test:owner",
    };
    let settled = false;
    const pending = pushStableCellGraph(
      // deno-lint-ignore no-explicit-any -- focused runtime fixture.
      connection as any,
      [{
        // deno-lint-ignore no-explicit-any -- focused cell fixture.
        cell: fakeCell() as any,
        value: () => ({ value: "ready" }),
      }],
    ).finally(() => settled = true);
    await commitStarted.promise;
    await Promise.resolve();
    assertFalse(settled);
    commitResult.resolve({ ok: {} });
    await pending;
    assertEquals(commitCount, 1);
  });
});

Deno.test("stable graph writes surface a commit failure without retrying", async () => {
  await withRuntimeTransaction(async (fakeTransaction) => {
    const commitError = {
      name: "ConflictError",
      message: "commit rejected",
      transaction: { operations: [{ type: "write" }] },
    };
    let commitCount = 0;
    const connection = {
      runtime: {
        edit: () =>
          fakeTransaction({
            readValueOrThrow: () => undefined,
            writeOrThrow: () => {},
            writeValueOrThrow: () => {},
            prepareCfc: () => {},
            abort: () => ({ ok: {} }),
            commit: () => {
              commitCount++;
              return Promise.resolve({ error: commitError });
            },
          }),
      },
      spaceDid: "did:test:space",
      ownerDid: "did:test:owner",
    };
    const error = await assertRejects(
      () =>
        pushStableCellGraph(
          // deno-lint-ignore no-explicit-any -- focused runtime fixture.
          connection as any,
          [{
            // deno-lint-ignore no-explicit-any -- focused cell fixture.
            cell: fakeCell() as any,
            value: () => ({ value: "ready" }),
          }],
        ),
      Error,
      "commit rejected",
    );
    assertEquals(error.cause, commitError);
    assertEquals(commitCount, 1);
  });
});

Deno.test("stable graph hydration bounds concurrent child syncs", async () => {
  const space = "did:test:space";
  const firstBatchStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = 0;
  let active = 0;
  let maximumActive = 0;
  const links = Array.from(
    { length: 51 },
    (_, index) => linkRefFrom({ id: `of:child-${index}`, path: [], space }),
  );
  const parent = {
    sync: () => Promise.resolve(),
    getRaw: () => links,
  };
  const runtime = {
    storageManager: { synced: () => Promise.resolve() },
    getCellFromLink: (link: { id: string }) => ({
      async sync() {
        started++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (started === 50) firstBatchStarted.resolve();
        await release.promise;
        active--;
      },
      getRaw: () => ({ id: link.id }),
    }),
  };
  const pending = readStableCellGraphValue(
    // deno-lint-ignore no-explicit-any -- focused runtime fixture.
    { runtime, spaceDid: space, ownerDid: space } as any,
    // deno-lint-ignore no-explicit-any -- focused cell fixture.
    parent as any,
  );

  await firstBatchStarted.promise;
  await Promise.resolve();
  const observedMaximum = maximumActive;
  const observedStarted = started;
  release.resolve();
  const value = await pending;

  assertEquals(observedMaximum, 50);
  assertEquals(observedStarted, 50);
  assertEquals(maximumActive, 50);
  assertEquals(started, 51);
  assertEquals((value as unknown[]).length, 51);
});
