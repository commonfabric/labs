import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase(
  "bench subscription filter refresh",
);
const space = signer.did();
const SUBSCRIPTION_COUNT = 256;
const UPDATE_COUNT = 5;
const HOT_URI = "of:subscription-filter-hot" as const;
const HOT_SCOPED_URI = "of:subscription-filter-scoped-hot" as const;
const PATTERN_A_URI = "of:subscription-filter-pattern-a" as const;
const PATTERN_B_URI = "of:subscription-filter-pattern-b" as const;
const TARGET_A_URI = "of:subscription-filter-target-a" as const;
const TARGET_B_URI = "of:subscription-filter-target-b" as const;

type TestProvider = ReturnType<typeof StorageManager.emulate> extends {
  open(space: string): infer T;
} ? T
  : never;

const coldUri = (index: number) =>
  `of:subscription-filter-cold-${index}` as const;

const linkTo = (id: string) => ({
  "/": {
    "link@1": {
      id,
      path: [],
      space,
    },
  },
});

const buildDoc = (
  version: number,
  patternId: string,
) => ({
  value: {
    title: `Doc ${version}`,
    spell: linkTo(patternId),
    internal: {
      "__#0stream": { $stream: true },
    },
  },
});

const selector = {
  path: [],
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      spell: { type: "object" },
      internal: {
        type: "object",
        properties: {
          "__#0stream": { type: "object" },
        },
      },
    },
  },
} as const;

const scopedSelector = {
  path: ["argument", "element"],
  schema: {
    type: "object",
    properties: {
      label: { type: "string" },
    },
  },
} as const;

const setup = async () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send([
    {
      uri: PATTERN_A_URI,
      value: { value: { name: "Pattern A" } },
    },
    {
      uri: PATTERN_B_URI,
      value: { value: { name: "Pattern B" } },
    },
    {
      uri: HOT_URI,
      value: buildDoc(0, PATTERN_A_URI),
    },
    ...Array.from({ length: SUBSCRIPTION_COUNT - 1 }, (_, index) => ({
      uri: coldUri(index),
      value: buildDoc(index + 1, PATTERN_A_URI),
    })),
  ]);

  await (provider as any).sync(HOT_URI, selector);
  for (let index = 0; index < SUBSCRIPTION_COUNT - 1; index++) {
    await (provider as any).sync(coldUri(index), selector);
  }

  await storageManager.synced();
  return { storageManager, provider };
};

const buildScopedDoc = (label: string, targetId: string) => ({
  value: {
    argument: {
      element: {
        label,
      },
    },
    internal: {
      helper: linkTo(targetId),
    },
  },
});

const setupScoped = async () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const provider = storageManager.open(space) as unknown as TestProvider;

  await (provider as any).send([
    {
      uri: TARGET_A_URI,
      value: { value: { name: "Target A" } },
    },
    {
      uri: TARGET_B_URI,
      value: { value: { name: "Target B" } },
    },
    {
      uri: HOT_SCOPED_URI,
      value: buildScopedDoc("Hot", TARGET_A_URI),
    },
    ...Array.from({ length: SUBSCRIPTION_COUNT - 1 }, (_, index) => ({
      uri: coldUri(index),
      value: buildScopedDoc(`Cold ${index}`, TARGET_A_URI),
    })),
  ]);

  await (provider as any).sync(HOT_SCOPED_URI, scopedSelector);
  for (let index = 0; index < SUBSCRIPTION_COUNT - 1; index++) {
    await (provider as any).sync(coldUri(index), scopedSelector);
  }

  await storageManager.synced();
  return { storageManager, provider };
};

const cleanup = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await storageManager.close();
};

const runValueUpdateLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri: HOT_URI,
      value: buildDoc(version, PATTERN_A_URI),
    }]);
    await storageManager.synced();
  }
};

const runSigilRetargetLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri: HOT_URI,
      value: buildDoc(
        version,
        version % 2 === 0 ? PATTERN_A_URI : PATTERN_B_URI,
      ),
    }]);
    await storageManager.synced();
  }
};

const runScopedSigilRetargetLoop = async (
  provider: TestProvider,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  for (let version = 1; version <= UPDATE_COUNT; version++) {
    await (provider as any).send([{
      uri: HOT_SCOPED_URI,
      value: buildScopedDoc(
        "Hot",
        version % 2 === 0 ? TARGET_A_URI : TARGET_B_URI,
      ),
    }]);
    await storageManager.synced();
  }
};

Deno.bench(
  "Storage - schema subscription refresh many cold docs (256 subscriptions, 1 hot doc, 5 value updates)",
  { group: "subscription-filter" },
  async () => {
    const { storageManager, provider } = await setup();
    try {
      await runValueUpdateLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - schema sigil topology refresh many cold docs (256 subscriptions, 1 hot doc, 5 retargets)",
  { group: "subscription-filter" },
  async () => {
    const { storageManager, provider } = await setup();
    try {
      await runSigilRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);

Deno.bench(
  "Storage - path-scoped schema refresh many cold docs (256 subscriptions, 1 hot doc, 5 unrelated sigil retargets)",
  { group: "subscription-filter" },
  async () => {
    const { storageManager, provider } = await setupScoped();
    try {
      await runScopedSigilRetargetLoop(provider, storageManager);
    } finally {
      await cleanup(storageManager);
    }
  },
);
