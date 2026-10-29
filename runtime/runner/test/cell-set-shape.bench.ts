import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { diffAndUpdate, normalizeAndDiff } from "../src/data-updating.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

const schemaWithAsCell = {
  type: "object",
  properties: {
    name: { type: "string" },
    profile: {
      type: "object",
      properties: {
        bio: { type: "string" },
        avatar: { type: "string" },
      },
      asCell: ["cell"],
    },
    settings: {
      type: "object",
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" },
      },
      asCell: ["cell"],
    },
    metadata: {
      type: "object",
      properties: {
        created: { type: "string" },
        updated: { type: "string" },
      },
      asCell: ["cell"],
    },
  },
} as const satisfies JSONSchema;

const makeUserValue = (index: number) => ({
  name: `User ${index}`,
  profile: { bio: `Bio for ${index}`, avatar: `avatar${index}.png` },
  settings: { theme: "dark", notifications: true },
  metadata: { created: "2024-01-01", updated: "2024-02-01" },
});

function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  _storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit().settled;
  await runtime.dispose();
}

Deno.bench({
  name: "Cell set shape - normalizeAndDiff only, schemaless (100x)",
  group: "shape",
  baseline: true,
  async fn() {
    const { runtime, tx } = setup();
    const cell = runtime.getCell<any>(
      space,
      "bench-shape-normalize",
      undefined,
      tx,
    );
    const link = resolveLink(
      runtime,
      runtime.readTx(tx),
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
    );

    for (let i = 0; i < 100; i++) {
      normalizeAndDiff(runtime, tx, link, makeUserValue(i));
    }

    tx.abort();
    await runtime.dispose();
  },
});

Deno.bench({
  name: "Cell set shape - diffAndUpdate only, schemaless (100x)",
  group: "shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell<any>(space, "bench-shape-diff", undefined, tx);
    const link = resolveLink(
      runtime,
      runtime.readTx(tx),
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
    );

    for (let i = 0; i < 100; i++) {
      diffAndUpdate(runtime, tx, link, makeUserValue(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell set shape - cell.set loop, schemaless (100x)",
  group: "shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell<any>(space, "bench-shape-set", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set(makeUserValue(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell set shape - cell.set loop, asCell schema (100x)",
  group: "shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell(
      space,
      "bench-shape-set-ascell",
      schemaWithAsCell,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set(makeUserValue(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});
