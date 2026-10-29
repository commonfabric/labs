import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type HierarchicalPath = Array<string | number>;

interface NodeMetrics {
  alpha: number;
  beta: number;
}

interface NodeState {
  metrics: NodeMetrics;
}

interface ClusterState {
  nodes: NodeState[];
}

interface HierarchyState {
  clusters: Record<string, ClusterState>;
}

/** Arguments for the hierarchical key path counter pattern. */
interface HierarchyArgs {
  hierarchy: Default<
    HierarchyState,
    {
      clusters: {
        north: { nodes: [{ metrics: { alpha: 0; beta: 0 } }] };
        south: { nodes: [{ metrics: { alpha: 0; beta: 0 } }] };
      };
    }
  >;
}

interface HierarchyUpdateEvent {
  path?: HierarchicalPath;
  amount?: number;
}

const DEFAULT_PATH: HierarchicalPath = [
  "clusters",
  "north",
  "nodes",
  0,
  "metrics",
  "alpha",
];

const DEFAULT_PATH_STRING = DEFAULT_PATH
  .map((segment) => String(segment))
  .join(".");

const normalizePath = (
  path: HierarchicalPath | undefined,
): HierarchicalPath => {
  if (!Array.isArray(path)) return DEFAULT_PATH;
  const cleaned = path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || Number.isInteger(segment),
  );
  if (cleaned.length === 0) return DEFAULT_PATH;
  if (cleaned[0] !== "clusters") {
    return ["clusters", ...cleaned];
  }
  return cleaned;
};

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : 0;

const computeClusterTotals = (
  state: HierarchyState | undefined,
): Record<string, number> => {
  const clusters = state?.clusters;
  if (!clusters || typeof clusters !== "object") return {};
  const summary: Record<string, number> = {};
  for (const [key, cluster] of Object.entries(clusters)) {
    const nodes = Array.isArray(cluster?.nodes) ? cluster.nodes : [];
    const total = nodes.reduce((sum, node) => {
      const metrics = node?.metrics ?? {};
      return sum + toNumber(metrics.alpha) + toNumber(metrics.beta);
    }, 0);
    summary[key] = total;
  }
  return summary;
};

const sumTotals = (summary: Record<string, number>): number => {
  return Object.values(summary).reduce((sum, value) => sum + value, 0);
};

const clampPathLog = (entries: string[] | undefined): string[] => {
  return Array.isArray(entries) ? entries : [];
};

const updateHierarchicalCounter = handler(
  (
    event: HierarchyUpdateEvent | undefined,
    context: {
      hierarchy: Cell<HierarchyState>;
      updateCount: Cell<number>;
      pathLog: Cell<string[]>;
      lastPath: Cell<string>;
    },
  ) => {
    const path = normalizePath(event?.path);
    const amount = typeof event?.amount === "number" ? event.amount : 1;

    let current: Cell<any> = context.hierarchy;
    const recordedPath: string[] = [];
    for (const key of path) {
      current = current.key(key as never);
      recordedPath.push(String(key));
    }

    const leaf: Cell<number> = current;
    const base = toNumber(leaf.get());
    leaf.set(base + amount);

    const previous = toNumber(context.updateCount.get());
    context.updateCount.set(previous + 1);

    const joined = recordedPath.join(".");
    context.lastPath.set(joined);

    const existing = context.pathLog.get();
    const entries = Array.isArray(existing) ? existing.slice() : [];
    entries.push(joined);
    context.pathLog.set(entries);
  },
);

const liftOverall = lift(sumTotals);
const liftUpdates = lift((count: number | undefined) => count ?? 0);
const liftLastUpdatedPath = lift(
  (value: string | undefined) => value ?? DEFAULT_PATH_STRING,
);
const liftPathLogView = lift(clampPathLog);

/** Pattern updating nested counters by traversing key paths. */
export const counterWithHierarchicalKeyPath = pattern<HierarchyArgs>(
  ({ hierarchy }) => {
    const updateCount = cell(0);
    const lastPath = cell(DEFAULT_PATH_STRING);
    const pathLog = cell<string[]>([]);

    const totals = computeClusterTotals(hierarchy);
    const overall = liftOverall(totals);
    const updates = liftUpdates(updateCount);
    const lastUpdatedPath = liftLastUpdatedPath(lastPath);
    const pathLogView = liftPathLogView(pathLog);
    const label = str`${updates} updates via ${lastUpdatedPath}`;

    return {
      hierarchy,
      totals,
      overall,
      updates,
      lastUpdatedPath,
      pathLog: pathLogView,
      label,
      defaultPath: DEFAULT_PATH_STRING,
      adjust: updateHierarchicalCounter({
        hierarchy,
        updateCount,
        pathLog,
        lastPath,
      }),
    };
  },
);

export default counterWithHierarchicalKeyPath;
