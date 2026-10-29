import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const lifecycleStages = [
  "procured",
  "in_service",
  "maintenance",
  "retired",
] as const;

type AssetStage = typeof lifecycleStages[number];

type StageCountMap = Record<AssetStage, number>;

interface AssetInput {
  id?: string;
  name?: string;
  owner?: string;
  stage?: string;
}

interface AssetRecord {
  id: string;
  name: string;
  owner: string;
  stage: AssetStage;
}

interface LifecycleBucket {
  stage: AssetStage;
  label: string;
  count: number;
  assets: AssetSnapshot[];
}

interface AssetSnapshot {
  id: string;
  name: string;
  owner: string;
  stageLabel: string;
}

interface AssetLifecycleTrackerArgs {
  assets: Default<AssetInput[], typeof defaultAssets>;
}

interface StageAdvanceEvent {
  assetId?: string;
}

interface StageSetEvent {
  assetId?: string;
}

interface TransitionEntry {
  sequence: number;
  assetId: string;
  assetName: string;
  from: AssetStage;
  to: AssetStage;
  message: string;
}

interface StageChangeSnapshot {
  asset: AssetRecord;
  from: AssetStage;
  to: AssetStage;
}

const stageLabels: Record<AssetStage, string> = {
  procured: "Procured",
  in_service: "In Service",
  maintenance: "In Maintenance",
  retired: "Retired",
};

const lifecycleStageSet = new Set<AssetStage>(lifecycleStages);

const defaultAssets: AssetRecord[] = [
  {
    id: "SRV-001",
    name: "Build Server",
    owner: "Infrastructure",
    stage: "procured",
  },
  {
    id: "LPT-104",
    name: "Design Laptop",
    owner: "Design",
    stage: "in_service",
  },
  {
    id: "PRJ-205",
    name: "Projector Kit",
    owner: "Facilities",
    stage: "maintenance",
  },
];

const cloneAssets = (entries: readonly AssetRecord[]): AssetRecord[] =>
  entries.map((entry) => ({ ...entry }));

const sanitizeAssetId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed ? trimmed : null;
};

const sanitizeAssetName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
};

const sanitizeOwner = (value: unknown): string => {
  if (typeof value !== "string") return "General";
  const trimmed = value.trim();
  return trimmed ? trimmed : "General";
};

const sanitizeStage = (value: unknown): AssetStage => {
  if (typeof value !== "string") return "procured";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (lifecycleStageSet.has(normalized as AssetStage)) {
    return normalized as AssetStage;
  }
  return "procured";
};

const sanitizeAsset = (value: unknown): AssetRecord | null => {
  const candidate = value as AssetInput | undefined;
  const id = sanitizeAssetId(candidate?.id);
  if (!id) return null;
  const stage = sanitizeStage(candidate?.stage);
  const name = sanitizeAssetName(candidate?.name, `Asset ${id}`);
  const owner = sanitizeOwner(candidate?.owner);
  return { id, stage, name, owner };
};

const compareAssets = (left: AssetRecord, right: AssetRecord): number => {
  const leftIndex = lifecycleStages.indexOf(left.stage);
  const rightIndex = lifecycleStages.indexOf(right.stage);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const nameCompare = left.name.localeCompare(right.name);
  if (nameCompare !== 0) return nameCompare;
  return left.id.localeCompare(right.id);
};

const sanitizeAssetList = (value: unknown): AssetRecord[] => {
  if (!Array.isArray(value)) {
    return cloneAssets(defaultAssets);
  }
  const seen = new Set<string>();
  const sanitized: AssetRecord[] = [];
  for (const raw of value) {
    const asset = sanitizeAsset(raw);
    if (!asset) continue;
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    sanitized.push(asset);
  }
  if (sanitized.length === 0) {
    return cloneAssets(defaultAssets);
  }
  sanitized.sort(compareAssets);
  return sanitized;
};

const createEmptyCounts = (): StageCountMap => ({
  procured: 0,
  in_service: 0,
  maintenance: 0,
  retired: 0,
});

const nextStage = (stage: AssetStage): AssetStage | null => {
  const index = lifecycleStages.indexOf(stage);
  const next = lifecycleStages[index + 1];
  return next ?? null;
};

const toAssetInputs = (entries: readonly AssetRecord[]): AssetInput[] =>
  entries.map((entry) => ({ ...entry }));

const applyStageChange = (
  entries: AssetRecord[],
  id: string,
  resolve: (asset: AssetRecord) => AssetStage | null,
): { list: AssetRecord[]; change: StageChangeSnapshot | null } => {
  const updated: AssetRecord[] = [];
  let change: StageChangeSnapshot | null = null;
  for (const asset of entries) {
    if (asset.id !== id) {
      updated.push(asset);
      continue;
    }
    const next = resolve(asset);
    if (!next || next === asset.stage) {
      updated.push(asset);
      continue;
    }
    const mutated = { ...asset, stage: next };
    change = { asset: mutated, from: asset.stage, to: next };
    updated.push(mutated);
  }
  if (!change) return { list: entries, change: null };
  return { list: sanitizeAssetList(updated), change };
};

const recordTransition = (
  history: Cell<TransitionEntry[]>,
  asset: AssetRecord,
  from: AssetStage,
  to: AssetStage,
) => {
  if (from === to) return;
  const entries = history.get();
  const log = Array.isArray(entries) ? [...entries] : [];
  const message = `${asset.name} moved from ${stageLabels[from]} to ${
    stageLabels[to]
  }`;
  const entry: TransitionEntry = {
    sequence: log.length + 1,
    assetId: asset.id,
    assetName: asset.name,
    from,
    to,
    message,
  };
  log.push(entry);
  history.set(log);
};

const advanceLifecycle = handler(
  (
    event: StageAdvanceEvent | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(
      current,
      id,
      (asset) => nextStage(asset.stage),
    );
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const markMaintenance = handler(
  (
    event: StageSetEvent | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "maintenance");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const retireAsset = handler(
  (
    event: StageSetEvent | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "retired");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const restoreAsset = handler(
  (
    event: StageSetEvent | undefined,
    context: { assets: Cell<AssetInput[]>; history: Cell<TransitionEntry[]> },
  ) => {
    const id = sanitizeAssetId(event?.assetId);
    if (!id) return;
    const current = sanitizeAssetList(context.assets.get());
    const result = applyStageChange(current, id, () => "in_service");
    if (!result.change) return;
    context.assets.set(toAssetInputs(result.list));
    recordTransition(
      context.history,
      result.change.asset,
      result.change.from,
      result.change.to,
    );
  },
);

const liftSanitizeAssetList = lift(sanitizeAssetList);

const liftStageBuckets = lift((entries: AssetRecord[]): LifecycleBucket[] => {
  const buckets = lifecycleStages.map((stage) => ({
    stage,
    label: stageLabels[stage],
    count: 0,
    assets: [] as AssetSnapshot[],
  }));
  const lookup = new Map<AssetStage, LifecycleBucket>();
  for (const bucket of buckets) lookup.set(bucket.stage, bucket);
  for (const asset of entries) {
    const bucket = lookup.get(asset.stage);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.assets.push({
      id: asset.id,
      name: asset.name,
      owner: asset.owner,
      stageLabel: stageLabels[asset.stage],
    });
  }
  return buckets;
});

const liftStageCounts = lift((entries: AssetRecord[]): StageCountMap => {
  const counts = createEmptyCounts();
  for (const asset of entries) {
    counts[asset.stage] += 1;
  }
  return counts;
});

const liftTotalAssets = lift((counts: StageCountMap) =>
  lifecycleStages.reduce((sum, stage) => sum + counts[stage], 0)
);

const liftActiveCount = lift((counts: StageCountMap) =>
  counts.procured + counts.in_service + counts.maintenance
);

const liftLifecycleProgress = lift(
  (input: { active: number; total: number }) => {
    if (input.total === 0) return 0;
    return Math.round((input.active / input.total) * 100);
  },
);

const liftActiveAssetIds = lift((entries: AssetRecord[]) =>
  entries.filter((asset) => asset.stage !== "retired").map((asset) => asset.id)
);

const liftTransitionHistory = lift((entries: TransitionEntry[]) =>
  entries.map((entry) => ({
    sequence: entry.sequence,
    assetId: entry.assetId,
    from: stageLabels[entry.from],
    to: stageLabels[entry.to],
    message: entry.message,
  }))
);

const liftTransitionMessages = lift((entries: TransitionEntry[]) =>
  entries.map((entry) => entry.message)
);

const liftBusiestStage = lift((buckets: LifecycleBucket[]) => {
  let current: { label: string; count: number } = {
    label: "Procured",
    count: 0,
  };
  for (const bucket of buckets) {
    if (bucket.count > current.count) {
      current = { label: bucket.label, count: bucket.count };
    }
  }
  return current;
});

export const assetLifecycleTracker = pattern<AssetLifecycleTrackerArgs>(
  ({ assets }) => {
    const transitionLog = cell<TransitionEntry[]>([]);

    const assetsView = liftSanitizeAssetList(assets);
    const stageBuckets = liftStageBuckets(assetsView);
    const stageCounts = liftStageCounts(assetsView);
    const totalAssets = liftTotalAssets(stageCounts);
    const activeCount = liftActiveCount(stageCounts);
    const lifecycleProgress = liftLifecycleProgress({
      active: activeCount,
      total: totalAssets,
    });

    const lifecycleLabel = str`${activeCount} active of ${totalAssets} assets`;

    const activeAssetIds = liftActiveAssetIds(assetsView);
    const transitionHistory = liftTransitionHistory(transitionLog);
    const transitionMessages = liftTransitionMessages(transitionLog);
    const busiestStage = liftBusiestStage(stageBuckets);

    return {
      assets,
      assetsView,
      stageBuckets,
      stageCounts,
      activeAssetIds,
      lifecycleLabel,
      lifecycleProgress,
      transitionHistory,
      transitionMessages,
      busiestStage,
      advanceLifecycle: advanceLifecycle({ assets, history: transitionLog }),
      markMaintenance: markMaintenance({ assets, history: transitionLog }),
      retireAsset: retireAsset({ assets, history: transitionLog }),
      restoreAsset: restoreAsset({ assets, history: transitionLog }),
    };
  },
);

export type {
  AssetInput,
  AssetLifecycleTrackerArgs,
  AssetRecord,
  AssetSnapshot,
  AssetStage,
  LifecycleBucket,
  StageCountMap,
  TransitionEntry,
};

export default assetLifecycleTracker;
