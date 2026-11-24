import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface IssueInput {
  id: string;
  title?: string;
  dependencies?: string[];
}

interface IssueDependencyArgs {
  issues: Default<IssueInput[], []>;
}

interface Issue {
  id: string;
  title: string;
  dependencies: string[];
}

type RejectionReason = "missing" | "self" | "cycle";

interface RejectedEdge {
  from: string;
  to: string;
  reason: RejectionReason;
}

interface GraphDetails {
  adjacency: Record<string, string[]>;
  order: string[];
  roots: string[];
  blocked: string[];
  hasCycle: boolean;
}

interface GraphContext {
  source: Cell<IssueInput[]>;
  rejected: Cell<RejectedEdge[]>;
}

const normalizeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const extractDependencyList = (value: unknown, selfId: string): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    const dependency = normalizeId(candidate);
    if (!dependency) continue;
    if (dependency === selfId) continue;
    if (result.includes(dependency)) continue;
    result.push(dependency);
  }
  return result;
};

const sanitizeIssueList = (value: unknown): Issue[] => {
  if (!Array.isArray(value)) return [];
  const raw: Issue[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = normalizeId((entry as IssueInput).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = normalizeTitle((entry as IssueInput).title, id);
    const dependencies = extractDependencyList(
      (entry as IssueInput).dependencies,
      id,
    );
    raw.push({ id, title, dependencies });
  }
  const knownIds = new Set(raw.map((item) => item.id));
  return raw.map((item) => ({
    id: item.id,
    title: item.title,
    dependencies: item.dependencies.filter((dep) => knownIds.has(dep)),
  }));
};

const prepareDependencyList = (
  dependencies: string[],
  knownIds: Set<string>,
  selfId: string,
): string[] => {
  const result: string[] = [];
  for (const candidate of dependencies) {
    const dependency = normalizeId(candidate);
    if (!dependency) continue;
    if (dependency === selfId) continue;
    if (!knownIds.has(dependency)) continue;
    if (result.includes(dependency)) continue;
    result.push(dependency);
  }
  return result;
};

const copyIssueForArgument = (issue: Issue): IssueInput => ({
  id: issue.id,
  title: issue.title,
  dependencies: issue.dependencies.slice(),
});

const recordRejection = (
  cellRef: Cell<RejectedEdge[]>,
  entry: RejectedEdge,
) => {
  const existing = cellRef.get();
  const history = Array.isArray(existing) ? existing.slice(-4) : [];
  history.push(entry);
  cellRef.set(history);
};

const commitIssues = (context: GraphContext, entries: Issue[]) => {
  context.source.set(entries.map(copyIssueForArgument));
};

const buildGraphDetails = (issues: Issue[]): GraphDetails => {
  const dependencyMap: Record<string, string[]> = {};
  const dependentMap: Record<string, string[]> = {};
  const indegree = new Map<string, number>();

  for (const issue of issues) {
    dependencyMap[issue.id] = [];
    dependentMap[issue.id] = [];
    indegree.set(issue.id, 0);
  }

  for (const issue of issues) {
    for (const dependency of issue.dependencies) {
      if (!indegree.has(dependency)) continue;
      dependencyMap[issue.id].push(dependency);
      dependentMap[dependency].push(issue.id);
      indegree.set(issue.id, (indegree.get(issue.id) ?? 0) + 1);
    }
  }

  const initialDegrees = new Map(indegree);
  const queue = Array.from(indegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) break;
    order.push(currentId);
    const dependents = dependentMap[currentId] ?? [];
    for (const dependent of dependents) {
      const nextDegree = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  const hasCycle = order.length !== issues.length;
  const blocked = hasCycle
    ? issues
      .map((issue) => issue.id)
      .filter((id) => !order.includes(id))
      .sort()
    : [];
  const roots = Array.from(initialDegrees.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  return { adjacency: dependencyMap, order, roots, blocked, hasCycle };
};

const wouldCreateCycle = (issues: Issue[]): boolean =>
  buildGraphDetails(issues).hasCycle;

const registerNewIssue = handler(
  (
    event:
      | { id?: string; title?: string; dependencies?: string[] }
      | undefined,
    context: GraphContext,
  ) => {
    const id = normalizeId(event?.id);
    if (!id) return;
    const current = sanitizeIssueList(context.source.get());
    if (current.some((issue) => issue.id === id)) return;
    const knownIds = new Set(current.map((issue) => issue.id));
    const dependencies = prepareDependencyList(
      extractDependencyList(event?.dependencies, id),
      knownIds,
      id,
    );
    const title = normalizeTitle(event?.title, id);
    const next = [...current, { id, title, dependencies }];
    commitIssues(context, next);
  },
);

const linkDependency = handler(
  (
    event: { from?: string; to?: string } | undefined,
    context: GraphContext,
  ) => {
    const from = normalizeId(event?.from);
    const to = normalizeId(event?.to);
    if (!from || !to) return;
    if (from === to) {
      recordRejection(context.rejected, { from, to, reason: "self" });
      return;
    }
    const current = sanitizeIssueList(context.source.get());
    const fromIndex = current.findIndex((issue) => issue.id === from);
    const toExists = current.some((issue) => issue.id === to);
    if (fromIndex === -1 || !toExists) {
      recordRejection(context.rejected, { from, to, reason: "missing" });
      return;
    }
    const knownIds = new Set(current.map((issue) => issue.id));
    const baseIssue = current[fromIndex];
    const mergedDependencies = [
      ...baseIssue.dependencies,
      to,
    ];
    const dependencies = prepareDependencyList(
      mergedDependencies,
      knownIds,
      from,
    );
    if (dependencies.length === baseIssue.dependencies.length) return;
    const next = current.slice();
    next[fromIndex] = { ...baseIssue, dependencies };
    if (wouldCreateCycle(next)) {
      recordRejection(context.rejected, { from, to, reason: "cycle" });
      return;
    }
    commitIssues(context, next);
  },
);

const unlinkDependency = handler(
  (
    event: { from?: string; to?: string } | undefined,
    context: GraphContext,
  ) => {
    const from = normalizeId(event?.from);
    const to = normalizeId(event?.to);
    if (!from || !to) return;
    const current = sanitizeIssueList(context.source.get());
    const fromIndex = current.findIndex((issue) => issue.id === from);
    if (fromIndex === -1) return;
    const baseIssue = current[fromIndex];
    if (!baseIssue.dependencies.includes(to)) return;
    const next = current.slice();
    next[fromIndex] = {
      ...baseIssue,
      dependencies: baseIssue.dependencies.filter((dep) => dep !== to),
    };
    commitIssues(context, next);
  },
);

// Module-scope lift definitions
const liftSanitizeIssues = lift(sanitizeIssueList);

const liftIssuesView = lift((entries: Issue[]) =>
  entries.map((issue) => ({
    id: issue.id,
    title: issue.title,
    dependencies: issue.dependencies.slice(),
  }))
);

const liftGraphDetails = lift(buildGraphDetails);

const liftAdjacency = lift((details: GraphDetails) => {
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(details.adjacency)) {
    result[key] = details.adjacency[key].slice();
  }
  return result;
});

const liftOrder = lift((details: GraphDetails) => details.order.slice());
const liftRoots = lift((details: GraphDetails) => details.roots.slice());
const liftBlocked = lift((details: GraphDetails) => details.blocked.slice());
const liftHasCycle = lift((details: GraphDetails) => details.hasCycle);

const liftRejectionHistory = lift((entries: RejectedEdge[] | undefined) =>
  Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
);

const liftOrderText = lift((ids: string[]) =>
  ids.length > 0 ? ids.join(" -> ") : "none"
);

const liftCycleStatus = lift((flag: boolean) => flag ? "cycle" : "valid");

export const issueDependencyGraph = pattern<IssueDependencyArgs>(
  ({ issues }) => {
    const rejectedEdges = cell<RejectedEdge[]>([]);

    const sanitizedIssues = liftSanitizeIssues(issues);
    const issuesView = liftIssuesView(sanitizedIssues);
    const graphDetails = liftGraphDetails(sanitizedIssues);
    const adjacency = liftAdjacency(graphDetails);
    const order = liftOrder(graphDetails);
    const roots = liftRoots(graphDetails);
    const blocked = liftBlocked(graphDetails);
    const hasCycle = liftHasCycle(graphDetails);
    const rejectionHistory = liftRejectionHistory(rejectedEdges);

    const orderText = liftOrderText(order);
    const cycleStatus = liftCycleStatus(hasCycle);
    const summary = str`${cycleStatus}: ${orderText}`;

    return {
      issues: issuesView,
      adjacency,
      order,
      roots,
      blocked,
      hasCycle,
      summary,
      rejectionHistory,
      addIssue: registerNewIssue({
        source: issues,
        rejected: rejectedEdges,
      }),
      linkDependency: linkDependency({
        source: issues,
        rejected: rejectedEdges,
      }),
      unlinkDependency: unlinkDependency({
        source: issues,
        rejected: rejectedEdges,
      }),
    };
  },
);

export default issueDependencyGraph;
