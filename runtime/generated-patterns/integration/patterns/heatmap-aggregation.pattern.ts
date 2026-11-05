import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface HeatmapAggregationArgs {
  width: Default<number, 4>;
  height: Default<number, 3>;
  interactions: Default<HeatmapInteractionInput[], []>;
}

interface HeatmapInteractionInput {
  x?: number;
  y?: number;
  weight?: number;
}

interface HeatmapBucket {
  x: number;
  y: number;
  weight: number;
}

interface HeatmapPeak {
  x: number;
  y: number;
  intensity: number;
}

interface RecordInteractionEvent {
  x?: number;
  y?: number;
  weight?: number;
}

interface RecordInteractionBatchEvent {
  points?: RecordInteractionEvent[];
}

type InteractionEvent = RecordInteractionEvent | RecordInteractionBatchEvent;

const sanitizeDimension = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  if (rounded > 50) return 50;
  return rounded;
};

const sanitizeWeight = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const sanitized = Math.max(0, value);
  return Math.round(sanitized * 100) / 100;
};

const clampCoordinate = (value: unknown, maxIndex: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  if (floored > maxIndex) return maxIndex;
  return floored;
};

const sanitizeInteractions = (
  value: unknown,
  width: number,
  height: number,
): HeatmapBucket[] => {
  if (!Array.isArray(value)) return [];
  const maxX = width > 0 ? width - 1 : 0;
  const maxY = height > 0 ? height - 1 : 0;
  const sanitized: HeatmapBucket[] = [];
  for (const item of value) {
    const record = item as HeatmapInteractionInput | undefined;
    const x = clampCoordinate(record?.x, maxX);
    const y = clampCoordinate(record?.y, maxY);
    const weight = sanitizeWeight(record?.weight);
    sanitized.push({ x, y, weight });
  }
  return sanitized;
};

const buildGrid = (
  width: number,
  height: number,
  buckets: readonly HeatmapBucket[],
): number[][] => {
  const rows = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => 0),
  );
  for (const bucket of buckets) {
    const row = rows[bucket.y] ?? rows[rows.length - 1];
    if (!row) continue;
    const current = row[bucket.x] ?? 0;
    const next = Math.round((current + bucket.weight) * 100) / 100;
    row[bucket.x] = next;
  }
  return rows;
};

const findMaxIntensity = (grid: readonly (readonly number[])[]): number => {
  let max = 0;
  for (const row of grid) {
    for (const value of row) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value > max) max = value;
    }
  }
  return Math.round(max * 100) / 100;
};

const normalizeGrid = (
  grid: readonly (readonly number[])[],
  maxIntensity: number,
): number[][] => {
  if (maxIntensity <= 0) {
    return grid.map((row) => row.map(() => 0));
  }
  const factor = 1 / maxIntensity;
  return grid.map((row) =>
    row.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      const normalized = value * factor;
      return Math.round(normalized * 100) / 100;
    })
  );
};

const locatePeaks = (
  grid: readonly (readonly number[])[],
  maxIntensity: number,
): HeatmapPeak[] => {
  if (maxIntensity <= 0) return [];
  const peaks: HeatmapPeak[] = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const value = row[x];
      if (value === maxIntensity) {
        peaks.push({ x, y, intensity: value });
      }
    }
  }
  return peaks;
};

const describePeaks = (peaks: readonly HeatmapPeak[]): string => {
  if (peaks.length === 0) return "no hotspots";
  if (peaks.length === 1) {
    const [peak] = peaks;
    return `(${peak.x},${peak.y})`;
  }
  return peaks
    .map((peak) => `(${peak.x},${peak.y})`)
    .join(" • ");
};

const recordInteraction = handler(
  (
    event: InteractionEvent | undefined,
    context: {
      interactions: Cell<HeatmapInteractionInput[]>;
      width: Cell<number>;
      height: Cell<number>;
    },
  ) => {
    const width = sanitizeDimension(context.width.get(), 4);
    const height = sanitizeDimension(context.height.get(), 3);
    if (context.width.get() !== width) context.width.set(width);
    if (context.height.get() !== height) context.height.set(height);

    const current = context.interactions.get();
    const list = Array.isArray(current) ? current.slice() : [];

    const applyPoint = (point: RecordInteractionEvent | undefined) => {
      if (!point) return;
      const [bucket] = sanitizeInteractions([point], width, height);
      if (!bucket) return;
      list.push({ x: bucket.x, y: bucket.y, weight: bucket.weight });
    };

    if (
      Array.isArray((event as RecordInteractionBatchEvent | undefined)?.points)
    ) {
      for (const item of (event as RecordInteractionBatchEvent).points ?? []) {
        applyPoint(item);
      }
    } else {
      applyPoint(event as RecordInteractionEvent | undefined);
    }

    context.interactions.set(list);
  },
);

const updateDimensions = handler(
  (
    event: { width?: number; height?: number } | undefined,
    context: { width: Cell<number>; height: Cell<number> },
  ) => {
    const currentWidth = sanitizeDimension(context.width.get(), 4);
    const currentHeight = sanitizeDimension(context.height.get(), 3);
    const nextWidth = sanitizeDimension(event?.width, currentWidth);
    const nextHeight = sanitizeDimension(event?.height, currentHeight);
    if (nextWidth !== currentWidth) context.width.set(nextWidth);
    if (nextHeight !== currentHeight) context.height.set(nextHeight);
  },
);

// Module-scope lift definitions
const liftSanitizeWidth = lift((value: number | undefined) =>
  sanitizeDimension(value, 4)
);
const liftSanitizeHeight = lift((value: number | undefined) =>
  sanitizeDimension(value, 3)
);

const liftBuckets = lift(
  (
    inputs: {
      source: HeatmapInteractionInput[];
      width: number;
      height: number;
    },
  ): HeatmapBucket[] =>
    sanitizeInteractions(
      inputs.source,
      inputs.width,
      inputs.height,
    ),
);

const liftBucketGrid = lift(
  (
    inputs: { width: number; height: number; buckets: HeatmapBucket[] },
  ): number[][] => buildGrid(inputs.width, inputs.height, inputs.buckets),
);

const liftMaxIntensity = lift(findMaxIntensity);

const liftNormalizedGrid = lift(
  (inputs: { grid: number[][]; max: number }) =>
    normalizeGrid(inputs.grid, inputs.max),
);

const liftPeaks = lift(
  (inputs: { grid: number[][]; max: number }) =>
    locatePeaks(inputs.grid, inputs.max),
);

const liftInteractionCount = lift((items: HeatmapBucket[]) => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  return Math.round(total * 100) / 100;
});

const liftPeakSummary = lift(describePeaks);

export const heatmapAggregation = pattern<HeatmapAggregationArgs>(
  ({ width, height, interactions }) => {
    const sanitizedWidth = liftSanitizeWidth(width);
    const sanitizedHeight = liftSanitizeHeight(height);

    const buckets = liftBuckets({
      source: interactions,
      width: sanitizedWidth,
      height: sanitizedHeight,
    });

    const bucketGrid = liftBucketGrid({
      buckets,
      width: sanitizedWidth,
      height: sanitizedHeight,
    });

    const maxIntensity = liftMaxIntensity(bucketGrid);

    const normalizedGrid = liftNormalizedGrid({
      grid: bucketGrid,
      max: maxIntensity,
    });

    const peaks = liftPeaks({ grid: bucketGrid, max: maxIntensity });

    const interactionCount = liftInteractionCount(buckets);

    const peakSummary = liftPeakSummary(peaks);

    const label = str`Peak intensity ${maxIntensity} at ${peakSummary}`;

    return {
      width,
      height,
      interactions,
      sanitizedWidth,
      sanitizedHeight,
      buckets,
      bucketGrid,
      normalizedGrid,
      maxIntensity,
      peaks,
      interactionCount,
      peakSummary,
      label,
      record: recordInteraction({ interactions, width, height }),
      resize: updateDimensions({ width, height }),
    };
  },
);

export default heatmapAggregation;
