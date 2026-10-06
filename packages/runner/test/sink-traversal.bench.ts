import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

type NestedPayload = {
  meta: {
    version: number;
    label: string;
  };
  sections: Array<{
    id: number;
    title: string;
    stats: {
      score: number;
      active: boolean;
    };
    tags: string[];
  }>;
};

const nestedPayloadSchema = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        version: { type: "number" },
        label: { type: "string" },
      },
      required: ["version", "label"],
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          stats: {
            type: "object",
            properties: {
              score: { type: "number" },
              active: { type: "boolean" },
            },
            required: ["score", "active"],
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["id", "title", "stats", "tags"],
      },
    },
  },
  required: ["meta", "sections"],
} as const satisfies JSONSchema;

function createPayload(version: number, sectionCount = 80): NestedPayload {
  return {
    meta: {
      version,
      label: `payload-${version}`,
    },
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      id: index,
      title: `section-${version}-${index}`,
      stats: {
        score: version + index,
        active: (version + index) % 2 === 0,
      },
      tags: [
        `group-${index % 5}`,
        `version-${version % 7}`,
        `bucket-${(index + version) % 11}`,
      ],
    })),
  };
}

async function runSinkTraversalBench(
  name: string,
  schema?: typeof nestedPayloadSchema,
) {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx = runtime.edit();
  const cell = runtime.getCell<NestedPayload>(space, name, schema, tx);
  cell.set(createPayload(0));
  await tx.commit().settled;

  const cancel = cell.sink(() => {});

  for (let version = 1; version <= 10; version++) {
    tx = runtime.edit();
    cell.withTx(tx).set(createPayload(version));
    await tx.commit().settled;
    await runtime.idle();
  }

  cancel();
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench(
  "Cell sink - schemaless plain nested payload traversal (10 updates)",
  { group: "sink-traversal" },
  async () => {
    await runSinkTraversalBench("bench-sink-traversal-schemaless");
  },
);

Deno.bench(
  "Cell sink - typed plain nested payload (10 updates)",
  { group: "sink-traversal" },
  async () => {
    await runSinkTraversalBench(
      "bench-sink-traversal-typed",
      nestedPayloadSchema,
    );
  },
);
