import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model";
import {
  entityRefFrom,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

// Select the cell-rep regime from the env flag, mirroring how the product reads
// EXPERIMENTAL_MODERN_CELL_REP: unset means "accept the default" (a no-op, since
// `setModernCellRepConfig(undefined)` leaves the default in place), "false"
// forces legacy, anything else forces modern. The bench then exercises whichever
// serialized entity-ref form (`FabricHash` vs the `{ "/": … }` object) that
// regime stores.
const modernCellRepEnv = Deno.env.get("EXPERIMENTAL_MODERN_CELL_REP");
setModernCellRepConfig(
  modernCellRepEnv === undefined ? undefined : modernCellRepEnv !== "false",
);

const signer = await Identity.fromPassphrase("bench mixed query refresh");
const space = signer.did();
const DOC_COUNT = 96;
const UPDATE_COUNT = 5;

// Synthetic source ids are real `FabricHash`es (valid entity references in
// either cell-rep regime); each `of:` URI and the `source` pointer that
// targets it derive from the same hash so the topology stays consistent.
const BASE_HASHES = [0, 1].map((index) =>
  hashOf({ causal: { bench: "mixed-query", source: index } })
);
const BASE_SOURCES = BASE_HASHES.map((hash) => `of:${hash.taggedHashString}`);

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const docUri = (index: number) => `of:mixed-query-refresh-${index}` as const;

const rootSchema = {
  type: "object",
  properties: {
    $UI: {
      type: "object",
      properties: {
        kind: { type: "string" },
        version: { type: "number" },
      },
    },
    argument: {
      type: "object",
      properties: {
        value: { type: "number" },
        element: {
          type: "object",
          properties: {
            id: { type: "number" },
            version: { type: "number" },
            title: { type: "string" },
          },
        },
        pieces: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              version: { type: "number" },
            },
          },
        },
      },
    },
    internal: {
      type: "object",
      properties: {
        "__#0": {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              version: { type: "number" },
            },
          },
        },
        "__#3stream": {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "number" },
          },
        },
        mentionable: { type: "boolean" },
      },
    },
  },
} as const;

const elementSchema = rootSchema.properties.argument.properties.element;
const piecesSchema = rootSchema.properties.argument.properties.pieces;
const internalZeroSchema = rootSchema.properties.internal.properties["__#0"];
const internalStreamSchema =
  rootSchema.properties.internal.properties["__#3stream"];

const buildDoc = (
  index: number,
  version: number,
  sourceIndex: number,
) => ({
  source: entityRefFrom(BASE_HASHES[sourceIndex]!),
  value: {
    $UI: {
      kind: "mixed-query-refresh",
      version,
    },
    argument: {
      value: version,
      element: {
        id: index,
        version,
        title: `doc-${index}-v${version}`,
      },
      pieces: Array.from({ length: 3 }, (_, pieceIndex) => ({
        id: index * 10 + pieceIndex,
        version,
      })),
    },
    internal: {
      "__#0": Array.from({ length: 2 }, (_, childIndex) => ({
        id: index * 100 + childIndex,
        version,
      })),
      "__#3stream": {
        name: `stream-${index}`,
        version,
      },
      mentionable: index % 2 === 0,
    },
  },
});

const setup = async (retargetSources: boolean) => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send(
    BASE_SOURCES.map((uri, index) => ({
      uri,
      value: {
        value: { label: `base-${index}` },
      },
    })),
  );

  await (provider as any).send(
    Array.from({ length: DOC_COUNT }, (_, index) => ({
      uri: docUri(index),
      value: buildDoc(index, 0, 0),
    })),
  );

  for (let index = 0; index < DOC_COUNT; index++) {
    const uri = docUri(index);
    await (provider as any).sync(uri, { path: [], schema: false });
    await (provider as any).sync(uri, { path: [], schema: rootSchema });
    await (provider as any).sync(uri, {
      path: ["argument", "element"],
      schema: elementSchema,
    });
    await (provider as any).sync(uri, {
      path: ["argument", "pieces"],
      schema: piecesSchema,
    });
    await (provider as any).sync(uri, {
      path: ["internal", "__#0"],
      schema: internalZeroSchema,
    });
    await (provider as any).sync(uri, {
      path: ["internal", "__#3stream"],
      schema: internalStreamSchema,
    });
  }

  await storageManager.synced();
  return { storageManager, provider, retargetSources };
};

const cleanup = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await storageManager.close();
};

const runUpdateLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  retargetSources: boolean,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send(
      Array.from({ length: DOC_COUNT }, (_, index) => ({
        uri: docUri(index),
        value: buildDoc(
          index,
          version,
          retargetSources ? version % BASE_SOURCES.length : 0,
        ),
      })),
    );
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - mixed query refresh stable source (96 docs, 6 selectors/doc, 5 updates)",
  { group: "mixed-query-refresh" },
  async () => {
    const { storageManager, provider } = await setup(false);
    try {
      await runUpdateLoop(provider, storageManager, false);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - mixed query refresh retargeted source (96 docs, 6 selectors/doc, 5 updates)",
  { group: "mixed-query-refresh" },
  async () => {
    const { storageManager, provider } = await setup(true);
    try {
      await runUpdateLoop(provider, storageManager, true);
    } finally {
      await cleanup(storageManager);
    }
  },
);
