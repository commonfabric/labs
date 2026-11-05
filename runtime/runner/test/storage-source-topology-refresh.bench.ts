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

const signer = await Identity.fromPassphrase("bench source topology refresh");
const space = signer.did();
const SUBSCRIPTION_COUNT = 256;
const UPDATE_COUNT = 5;

// Synthetic ids are real `FabricHash`es so they're valid entity references in
// either cell-rep regime; each `of:` URI and its `source` pointer derive from
// the same hash so the topology stays consistent.
const idHash = (name: string) =>
  hashOf({ causal: { bench: "source-topology", name } });

const PROCESS_HASH = idHash("process");
const BASE_HASHES = [idHash("base-1"), idHash("base-2")] as const;
const PROCESS_URI = `of:${PROCESS_HASH.taggedHashString}`;
const BASE_URIS = BASE_HASHES.map((hash) => `of:${hash.taggedHashString}`);
const PATTERN_ID = "bench-pattern:source-topology";
const PATTERN_URI = `of:${
  hashOf({ causal: { patternId: PATTERN_ID, type: "pattern" } })
    .taggedHashString
}`;

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const pieceUri = (index: number) =>
  `of:${idHash(`piece-${index}`).taggedHashString}`;

const pieceValue = (withPatternLink: boolean) =>
  withPatternLink
    ? {
      source: entityRefFrom(PROCESS_HASH),
      value: { $TYPE: PATTERN_ID },
    }
    : {
      source: entityRefFrom(PROCESS_HASH),
    };

const setup = async (withPatternLink: boolean) => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send([
    {
      uri: BASE_URIS[0],
      value: {
        value: { label: "Base 1" },
      },
    },
    {
      uri: BASE_URIS[1],
      value: {
        value: { label: "Base 2" },
      },
    },
    {
      uri: PROCESS_URI,
      value: {
        source: entityRefFrom(BASE_HASHES[0]),
      },
    },
    ...(withPatternLink
      ? [{
        uri: PATTERN_URI,
        value: {
          value: { name: "Bench Pattern" },
        },
      }]
      : []),
    ...Array.from({ length: SUBSCRIPTION_COUNT }, (_, index) => ({
      uri: pieceUri(index),
      value: pieceValue(withPatternLink),
    })),
  ]);

  for (let index = 0; index < SUBSCRIPTION_COUNT; index++) {
    await (provider as any).sync(pieceUri(index), {
      path: [],
      schema: false,
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

const runRetargetLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 0; version < UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri: PROCESS_URI,
      value: {
        source: entityRefFrom(
          version % 2 === 0 ? BASE_HASHES[1] : BASE_HASHES[0],
        ),
      },
    }]);
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - source topology refresh plain roots (256 subscriptions, 5 retargets)",
  { group: "source-topology-refresh" },
  async () => {
    const { storageManager, provider } = await setup(false);
    try {
      await runRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - source topology refresh pattern-linked roots (256 subscriptions, 5 retargets)",
  { group: "source-topology-refresh" },
  async () => {
    const { storageManager, provider } = await setup(true);
    try {
      await runRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);
