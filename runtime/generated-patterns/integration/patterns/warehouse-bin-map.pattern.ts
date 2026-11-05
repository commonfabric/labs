import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface BinDefinition {
  id: string;
  capacity: number;
}

interface ItemPlacement {
  id: string;
  bin: string;
}

interface WarehouseBinMapArgs {
  bins: Default<BinDefinition[], typeof defaultBins>;
  items: Default<ItemPlacement[], typeof defaultItems>;
}

interface RelocateEvent {
  itemId?: string;
  targetBin?: string;
}

interface OccupancyEntry {
  capacity: number;
  used: number;
  available: number;
}

const defaultBins: BinDefinition[] = [
  { id: "A1", capacity: 2 },
  { id: "B2", capacity: 3 },
  { id: "C3", capacity: 1 },
];

const defaultItems: ItemPlacement[] = [
  { id: "widget-100", bin: "A1" },
  { id: "widget-200", bin: "A1" },
  { id: "widget-300", bin: "B2" },
];

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
};

const sanitizeBins = (value: unknown): BinDefinition[] => {
  if (!Array.isArray(value)) {
    return structuredClone(defaultBins);
  }
  const seen = new Set<string>();
  const bins: BinDefinition[] = [];
  for (const entry of value) {
    const id = sanitizeId((entry as BinDefinition | undefined)?.id);
    if (!id || seen.has(id)) continue;
    const capacityValue = (entry as BinDefinition | undefined)?.capacity;
    const capacity = typeof capacityValue === "number" && capacityValue > 0
      ? Math.floor(capacityValue)
      : 1;
    seen.add(id);
    bins.push({ id, capacity });
  }
  if (bins.length === 0) {
    return structuredClone(defaultBins);
  }
  return bins;
};

const sanitizePlacementList = (
  entries: readonly ItemPlacement[] | undefined,
  bins: readonly BinDefinition[],
): ItemPlacement[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const capacities = new Map<string, number>();
  for (const bin of bins) {
    capacities.set(bin.id, bin.capacity);
  }
  const usage = new Map<string, number>();
  const seen = new Set<string>();
  const placements: ItemPlacement[] = [];
  for (const entry of entries) {
    const id = sanitizeId(entry?.id);
    const bin = sanitizeId(entry?.bin);
    if (!id || !bin || seen.has(id) || !capacities.has(bin)) continue;
    const used = usage.get(bin) ?? 0;
    const limit = capacities.get(bin) ?? 0;
    if (used >= limit) continue;
    placements.push({ id, bin });
    usage.set(bin, used + 1);
    seen.add(id);
  }
  return placements;
};

const sanitizePlacements = (
  value: unknown,
  bins: readonly BinDefinition[],
): ItemPlacement[] => {
  const initial = sanitizePlacementList(
    Array.isArray(value) ? value as ItemPlacement[] : undefined,
    bins,
  );
  if (initial.length > 0) return initial;
  return sanitizePlacementList(defaultItems, bins);
};

const buildOccupancy = (
  bins: readonly BinDefinition[],
  placements: readonly ItemPlacement[],
): Record<string, OccupancyEntry> => {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    const next = (counts.get(placement.bin) ?? 0) + 1;
    counts.set(placement.bin, next);
  }
  const occupancy: Record<string, OccupancyEntry> = {};
  for (const bin of bins) {
    const used = counts.get(bin.id) ?? 0;
    const capacity = bin.capacity;
    const available = capacity - used;
    occupancy[bin.id] = {
      capacity,
      used,
      available: available > 0 ? available : 0,
    };
  }
  return occupancy;
};

// Module-scope lift definitions
const liftSanitizeBins = lift(sanitizeBins);

const liftRawItems = lift((value: ItemPlacement[] | undefined) =>
  Array.isArray(value) ? value : []
);

const liftPlacements = lift((input: {
  entries: ItemPlacement[];
  binList: BinDefinition[];
}) => sanitizePlacements(input.entries, input.binList));

const liftOccupancy = lift((input: {
  binList: BinDefinition[];
  placements: ItemPlacement[];
}) => buildOccupancy(input.binList, input.placements));

const liftAvailableBins = lift((summary: Record<string, OccupancyEntry>) =>
  Object.keys(summary).filter((id) => summary[id].available > 0)
);

const liftTotalItems = lift((list: ItemPlacement[]) => list.length);
const liftBinCount = lift((list: BinDefinition[]) => list.length);

const liftLastAction = lift((entries: string[]) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "initialized";
  }
  return entries[entries.length - 1];
});

const relocateInventory = handler(
  (
    event: RelocateEvent | undefined,
    context: {
      items: Cell<ItemPlacement[]>;
      bins: Cell<BinDefinition[]>;
      placements: Cell<ItemPlacement[]>;
      history: Cell<string[]>;
    },
  ) => {
    const itemId = sanitizeId(event?.itemId);
    const targetBin = sanitizeId(event?.targetBin);
    if (!itemId || !targetBin) return;

    const bins = context.bins.get() ?? [];
    if (!bins.some((entry) => entry.id === targetBin)) return;

    const placements = context.placements.get() ?? [];
    const index = placements.findIndex((entry) => entry.id === itemId);
    if (index === -1) return;
    const currentPlacement = placements[index];
    if (currentPlacement.bin === targetBin) return;

    const capacities = new Map<string, number>();
    for (const bin of bins) {
      capacities.set(bin.id, bin.capacity);
    }
    const usage = new Map<string, number>();
    for (let i = 0; i < placements.length; i++) {
      if (i === index) continue;
      const entry = placements[i];
      usage.set(entry.bin, (usage.get(entry.bin) ?? 0) + 1);
    }

    const limit = capacities.get(targetBin) ?? 0;
    const used = usage.get(targetBin) ?? 0;
    if (used >= limit) return;

    const updated = placements.map((entry, position) => ({
      id: entry.id,
      bin: position === index ? targetBin : entry.bin,
    }));
    context.items.set(updated);

    const history = context.history.get();
    const log = Array.isArray(history) ? history : [];
    const message =
      `Moved ${itemId} from ${currentPlacement.bin} to ${targetBin}`;
    context.history.set([...log, message]);

    buildOccupancy(bins, updated);
  },
);

export const warehouseBinMap = pattern<WarehouseBinMapArgs>(
  ({ bins, items }) => {
    const binsList = liftSanitizeBins(bins);
    const rawItems = liftRawItems(items);
    const placements = liftPlacements({
      entries: rawItems,
      binList: binsList,
    });

    const occupancy = liftOccupancy({
      binList: binsList,
      placements,
    });

    const availableBins = liftAvailableBins(occupancy);

    const totalItems = liftTotalItems(placements);
    const binCount = liftBinCount(binsList);
    const status = str`${totalItems} items across ${binCount} bins`;

    const history = cell<string[]>([]);
    const lastAction = liftLastAction(history);

    const relocate = relocateInventory({
      items,
      bins: binsList,
      placements,
      history,
    });

    return {
      bins: binsList,
      items,
      placements,
      occupancy,
      availableBins,
      status,
      history,
      lastAction,
      relocate,
    };
  },
);

export default warehouseBinMap;
