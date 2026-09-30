import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Cell } from "../src/cell.ts";
import { type JSONSchema, NAME } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("wish mentionable schema bench");
const space = signer.did();

type BenchEnv = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  results: Cell<unknown>[];
};

const PARENT_WISH_COUNT = 30;
const MENTIONABLE_COUNT = 30;

let resultSink = 0;

function mentionableSchema(index: number): JSONSchema {
  return {
    type: "object",
    title: `Bench note ${index}`,
    description:
      "Synthetic mentionable schema tagged with #bench-only so #notebook misses.",
    properties: {
      [NAME]: { type: "string" },
      body: { type: "string" },
      metadata: {
        type: "object",
        properties: {
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          backlinks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                id: { type: "string" },
              },
            },
          },
        },
      },
    },
    required: [NAME, "body"],
  };
}

function mentionableData(index: number): Record<string, unknown> {
  return {
    [NAME]: `note-${index}`,
    body: `Synthetic note body ${index}`,
    metadata: {
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
      tags: ["bench-only"],
      backlinks: [
        { title: `Backlink ${index}`, id: `backlink-${index}` },
      ],
    },
  };
}

async function setupMentionableWishBench(
  options: {
    prefix: string;
    withSchemas: boolean;
  },
): Promise<BenchEnv> {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
  const defaultPatternCell = runtime.getCell(
    space,
    `${options.prefix}-default-pattern`,
    undefined,
    tx,
  );
  const backlinksIndexCell = runtime.getCell(
    space,
    `${options.prefix}-backlinks-index`,
    undefined,
    tx,
  );
  const mentionables: Cell<unknown>[] = [];

  for (let index = 0; index < MENTIONABLE_COUNT; index++) {
    const pieceCell = runtime.getCell(
      space,
      `${options.prefix}-mentionable-${index}`,
      options.withSchemas ? mentionableSchema(index) : undefined,
      tx,
    );
    pieceCell.set(mentionableData(index));
    mentionables.push(pieceCell as Cell<unknown>);
  }

  backlinksIndexCell.set({ mentionable: mentionables });
  defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
  spaceCell.key("defaultPattern").set(defaultPatternCell);

  const { commonfabric } = createTrustedBuilder(runtime);
  const wishPattern = commonfabric.pattern(() => {
    return {
      result: commonfabric.wish({
        query: "#notebook",
        scope: ["."],
        headless: true,
      }),
    };
  });

  const results = Array.from({ length: PARENT_WISH_COUNT }, (_, index) => {
    const resultCell = runtime.getCell(
      space,
      `${options.prefix}-result-${index}`,
      undefined,
      tx,
    );
    return runtime.run(tx, wishPattern, {}, resultCell) as Cell<unknown>;
  });

  await tx.commit();
  await runtime.idle();

  return {
    runtime,
    storageManager,
    results,
  };
}

async function cleanup(env: BenchEnv): Promise<void> {
  await env.runtime.dispose();
  await env.storageManager.close();
}

function consumeResult(result: unknown): void {
  if (isObjectOrArray(result) && "result" in result) {
    resultSink += Object.keys(result).length;
  }
}

async function runWishMissBench(
  b: Deno.BenchContext,
  options: {
    prefix: string;
    withSchemas: boolean;
  },
): Promise<void> {
  const env = await setupMentionableWishBench(options);
  try {
    b.start();
    const values = await Promise.all(
      env.results.map((result) => result.pull()),
    );
    b.end();

    for (const value of values) consumeResult(value);
  } finally {
    await cleanup(env);
  }
}

Deno.bench({
  name:
    "Wish mentionable hashtag fanout - schemaless scan (30 mentionables, 30 parent wishes)",
  group: "wish-mentionable-hashtag",
  baseline: true,
  async fn(b) {
    await runWishMissBench(b, {
      prefix: "wish-mentionable-schemaless",
      withSchemas: false,
    });
  },
});

Deno.bench({
  name:
    "Wish mentionable hashtag fanout - schema reconstruction scan (30 mentionables, 30 parent wishes)",
  group: "wish-mentionable-hashtag",
  async fn(b) {
    await runWishMissBench(b, {
      prefix: "wish-mentionable-schema",
      withSchemas: true,
    });
  },
});

if (resultSink < 0 && Deno.env.get("BENCH_DIAGNOSTICS") === "1") {
  console.error(resultSink);
}
