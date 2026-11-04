import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface OrgMember {
  id: string;
  name: string;
  manager: string | null;
}

interface OrgChartArgs {
  members: Default<OrgMember[], typeof defaultMembers>;
}

interface OrgChartNode {
  id: string;
  name: string;
  reports: OrgChartNode[];
}

interface RelocateEvent {
  employeeId?: string;
  newManagerId?: string | null;
}

const defaultMembers: OrgMember[] = [
  { id: "ceo", name: "Avery CEO", manager: null },
  { id: "cto", name: "Casey CTO", manager: "ceo" },
  { id: "eng-lead", name: "Riley Eng Lead", manager: "cto" },
  { id: "designer", name: "Sky Designer", manager: "eng-lead" },
  { id: "ops", name: "Morgan Ops", manager: "ceo" },
];

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const baseMemberList = (value: unknown): OrgMember[] => {
  if (!Array.isArray(value)) {
    return structuredClone(defaultMembers);
  }
  const seen = new Set<string>();
  const members: OrgMember[] = [];
  for (const entry of value) {
    const candidate = entry as OrgMember | undefined;
    const id = sanitizeId(candidate?.id);
    if (!id || seen.has(id)) continue;
    const name = sanitizeName(candidate?.name, id);
    const managerValue = candidate?.manager;
    const manager = typeof managerValue === "string"
      ? sanitizeId(managerValue)
      : managerValue === null
      ? null
      : null;
    members.push({ id, name, manager });
    seen.add(id);
  }
  if (members.length === 0) {
    return structuredClone(defaultMembers);
  }
  return members;
};

const resolveCycles = (members: readonly OrgMember[]): OrgMember[] => {
  const parent = new Map<string, string | null>();
  for (const member of members) {
    parent.set(member.id, member.manager);
  }
  for (const member of members) {
    const origin = member.id;
    const visited = new Set<string>([origin]);
    let current = parent.get(origin) ?? null;
    while (current) {
      if (!parent.has(current) || visited.has(current)) {
        parent.set(origin, null);
        break;
      }
      visited.add(current);
      current = parent.get(current) ?? null;
    }
  }
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    manager: parent.get(member.id) ?? null,
  }));
};

const sanitizeMembers = (value: unknown): OrgMember[] => {
  const base = baseMemberList(value);
  const ids = new Set(base.map((member) => member.id));
  const validated = base.map((member) => {
    if (!member.manager) {
      return { ...member, manager: null };
    }
    if (!ids.has(member.manager) || member.manager === member.id) {
      return { ...member, manager: null };
    }
    return member;
  });
  if (!validated.some((member) => member.manager === null)) {
    validated[0] = { ...validated[0], manager: null };
  }
  const resolved = resolveCycles(validated);
  return resolved
    .map((member) => ({ ...member }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

const sortTree = (list: OrgChartNode[]) => {
  list.sort((left, right) => left.id.localeCompare(right.id));
  for (const entry of list) {
    sortTree(entry.reports);
  }
};

const buildHierarchy = (members: readonly OrgMember[]): OrgChartNode[] => {
  const nodes = new Map<string, OrgChartNode>();
  for (const member of members) {
    nodes.set(member.id, {
      id: member.id,
      name: member.name,
      reports: [],
    });
  }
  const roots: OrgChartNode[] = [];
  for (const member of members) {
    const node = nodes.get(member.id);
    if (!node) continue;
    if (member.manager && nodes.has(member.manager)) {
      nodes.get(member.manager)?.reports.push(node);
    } else {
      roots.push(node);
    }
  }
  sortTree(roots);
  return roots;
};

const buildReportingChains = (
  members: readonly OrgMember[],
): Record<string, string[]> => {
  const byId = new Map<string, OrgMember>();
  for (const member of members) {
    byId.set(member.id, member);
  }
  const cache = new Map<string, string[]>();
  const resolve = (memberId: string): string[] => {
    const cached = cache.get(memberId);
    if (cached) return [...cached];
    const names: string[] = [];
    const visited = new Set<string>();
    let current: string | null = memberId;
    let guard = 0;
    while (current && guard <= members.length) {
      if (visited.has(current)) break;
      visited.add(current);
      const member = byId.get(current);
      if (!member) break;
      names.push(member.name);
      current = member.manager;
      guard += 1;
    }
    const chain = names.reverse();
    cache.set(memberId, chain);
    return [...chain];
  };
  const entries: [string, string[]][] = [];
  for (const member of members) {
    entries.push([member.id, resolve(member.id)]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries.map(([id, chain]) => [id, [...chain]]));
};

const createsCycle = (
  members: readonly OrgMember[],
  employeeId: string,
  candidateManager: string,
): boolean => {
  const children = new Map<string, string[]>();
  for (const member of members) {
    if (!member.manager) continue;
    const list = children.get(member.manager) ?? [];
    list.push(member.id);
    children.set(member.manager, list);
  }
  const queue = [...(children.get(employeeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === candidateManager) return true;
    const next = children.get(current);
    if (next && next.length > 0) {
      for (const child of next) queue.push(child);
    }
  }
  return false;
};

const relocateMember = handler(
  (
    event: RelocateEvent | undefined,
    context: { members: Cell<OrgMember[]>; history: Cell<string[]> },
  ) => {
    const employeeId = sanitizeId(event?.employeeId);
    if (!employeeId) return;

    const rawMembers = context.members.get();
    const members = sanitizeMembers(rawMembers);
    const employee = members.find((entry) => entry.id === employeeId);
    if (!employee) return;

    let nextManager: string | null;
    if (event?.newManagerId === null) {
      nextManager = null;
    } else if (typeof event?.newManagerId === "string") {
      const sanitizedManager = sanitizeId(event.newManagerId);
      if (!sanitizedManager) return;
      nextManager = sanitizedManager;
    } else if (event?.newManagerId === undefined) {
      nextManager = null;
    } else {
      return;
    }

    if (nextManager === employee.manager) return;

    const ids = new Set(members.map((member) => member.id));
    if (nextManager) {
      if (!ids.has(nextManager) || nextManager === employeeId) return;
      if (createsCycle(members, employeeId, nextManager)) return;
    }

    const updated = members.map((member) =>
      member.id === employeeId ? { ...member, manager: nextManager } : member
    );
    const canonical = sanitizeMembers(updated);

    const nameById = new Map(members.map((member) => [member.id, member.name]));
    const previousManagerName = employee.manager
      ? nameById.get(employee.manager) ?? "Top Level"
      : "Top Level";
    const targetManagerName = nextManager
      ? nameById.get(nextManager) ?? "Top Level"
      : "Top Level";

    context.members.set(canonical);

    const history = context.history.get();
    const log = Array.isArray(history) ? history : [];
    const message =
      `Relocated ${employee.name} from ${previousManagerName} to ` +
      `${nextManager ? targetManagerName : "Top Level"}`;
    context.history.set([...log, message]);
  },
);

// Module-scope lift definitions
const liftSanitizeMembers = lift((value: OrgMember[] | undefined) =>
  sanitizeMembers(value)
);
const liftBuildHierarchy = lift(buildHierarchy);
const liftBuildReportingChains = lift(buildReportingChains);
const liftTopLevelNames = lift((nodes: OrgChartNode[]) =>
  nodes.map((node) => node.name)
);
const liftMemberCount = lift((entries: OrgMember[]) => entries.length);
const liftRootCount = lift((nodes: OrgChartNode[]) => nodes.length);
const liftChainSummaries = lift((chains: Record<string, string[]>) =>
  Object.entries(chains)
    .map(([id, chain]) => `${id}: ${chain.join(" > ")}`)
    .sort((left, right) => left.localeCompare(right))
);

export const orgChartHierarchy = pattern<OrgChartArgs>(
  ({ members }) => {
    const history = cell<string[]>([]);

    const memberList = liftSanitizeMembers(members);
    const hierarchy = liftBuildHierarchy(memberList);
    const reportingChains = liftBuildReportingChains(memberList);
    const topLevelNames = liftTopLevelNames(hierarchy);
    const memberCount = liftMemberCount(memberList);
    const rootCount = liftRootCount(hierarchy);
    const summary =
      str`Org has ${memberCount} members across ${rootCount} root nodes`;
    const chainSummaries = liftChainSummaries(reportingChains);

    return {
      members,
      hierarchy,
      reportingChains,
      topLevelNames,
      summary,
      chainSummaries,
      history,
      relocate: relocateMember({ members, history }),
    };
  },
);

export default orgChartHierarchy;
