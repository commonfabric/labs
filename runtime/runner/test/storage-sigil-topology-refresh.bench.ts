import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("bench sigil topology refresh");
const space = signer.did();
const DOC_COUNT = 48;
const UPDATE_COUNT = 5;
const LINKS_PER_DOC = 4;

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const docUri = (index: number) => `of:sigil-topology-refresh-${index}` as const;
const targetUri = (index: number, version: number) =>
  `of:sigil-target-${index}-${version}` as const;

const rootSchema = {
  type: "object",
  properties: {
    $UI: { type: "object", additionalProperties: true },
    argument: {
      type: "object",
      properties: {
        element: { type: "object", additionalProperties: true },
        params: {
          type: "object",
          properties: {
            pieceRegistry: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        backlinks: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
    internal: {
      type: "object",
      properties: {
        "__#0": {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        "__#3stream": { type: "object", additionalProperties: true },
      },
    },
  },
} as const;

const pieceRegistrySchema =
  rootSchema.properties.argument.properties.params.properties.pieceRegistry;
const backlinksSchema = rootSchema.properties.argument.properties.backlinks;
const elementSchema = rootSchema.properties.argument.properties.element;
const internalZeroSchema = rootSchema.properties.internal.properties["__#0"];
const internalStreamSchema =
  rootSchema.properties.internal.properties["__#3stream"];

const sigilLink = (id: string) => ({
  "/": {
    [LINK_V1_TAG]: {
      id,
    },
  },
});

const targetDoc = (id: string, version: number) => ({
  uri: id,
  value: {
    value: {
      id,
      version,
    },
  },
});

const buildDoc = (index: number, version: number) => {
  const linkIds = Array.from(
    { length: LINKS_PER_DOC },
    (_, offset) => targetUri(index * LINKS_PER_DOC + offset, version),
  );
  return {
    value: {
      $UI: sigilLink(linkIds[0]!),
      argument: {
        element: sigilLink(linkIds[1]!),
        params: {
          pieceRegistry: linkIds.map((id) => sigilLink(id)),
        },
        backlinks: linkIds.slice(0, 2).map((id) => sigilLink(id)),
      },
      internal: {
        "__#0": linkIds.slice(1).map((id) => sigilLink(id)),
        "__#3stream": sigilLink(linkIds[0]!),
      },
    },
  };
};

const setup = async () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send(
    Array.from(
      { length: DOC_COUNT * LINKS_PER_DOC },
      (_, index) => targetDoc(targetUri(index, 0), 0),
    ),
  );

  await (provider as any).send(
    Array.from({ length: DOC_COUNT }, (_, index) => ({
      uri: docUri(index),
      value: buildDoc(index, 0),
    })),
  );

  for (let index = 0; index < DOC_COUNT; index++) {
    const uri = docUri(index);
    await (provider as any).sync(uri, { path: [], schema: false });
    await (provider as any).sync(uri, { path: [], schema: rootSchema });
    await (provider as any).sync(uri, {
      path: ["$UI"],
      schema: rootSchema.properties.$UI,
    });
    await (provider as any).sync(uri, {
      path: ["argument", "element"],
      schema: elementSchema,
    });
    await (provider as any).sync(uri, {
      path: ["argument", "params", "pieceRegistry"],
      schema: pieceRegistrySchema,
    });
    await (provider as any).sync(uri, {
      path: ["argument", "backlinks"],
      schema: backlinksSchema,
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
  return { storageManager, provider };
};

const cleanup = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await storageManager.close();
};

const runUpdateLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send(
      Array.from(
        { length: DOC_COUNT * LINKS_PER_DOC },
        (_, index) => targetDoc(targetUri(index, version), version),
      ),
    );
    await (provider as any).send(
      Array.from({ length: DOC_COUNT }, (_, index) => ({
        uri: docUri(index),
        value: buildDoc(index, version),
      })),
    );
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - sigil topology refresh (48 docs, 8 selectors/doc, 5 updates)",
  { group: "sigil-topology-refresh" },
  async () => {
    const { storageManager, provider } = await setup();
    try {
      await runUpdateLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);
