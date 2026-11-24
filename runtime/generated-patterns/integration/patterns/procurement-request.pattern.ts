import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

/** Pattern managing procurement approvals with derived spending summaries. */
export type StageStatus = "pending" | "approved" | "rejected";

export type RequestStatus = "routing" | "approved" | "rejected";

export interface ApprovalStageSeed {
  key?: string;
  label?: string;
  approver?: string;
  status?: string;
}

export interface ApprovalStage {
  key: StageKey;
  label: string;
  approver: string;
  status: StageStatus;
}

export interface ProcurementRequestSeed {
  id?: string;
  requester?: string;
  department?: string;
  vendor?: string;
  description?: string;
  amount?: number;
  currency?: string;
  stages?: ApprovalStageSeed[];
}

export interface ProcurementRequest {
  id: string;
  requester: string;
  department: string;
  vendor: string;
  description: string;
  amount: number;
  currency: string;
  stages: readonly ApprovalStage[];
  status: RequestStatus;
}

export interface RequestCounts {
  total: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface AmountTotals {
  requested: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface DepartmentTotals {
  department: string;
  requested: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface RoutingAssignment {
  id: string;
  vendor: string;
  department: string;
  stage: string;
  approver: string;
  amount: number;
  currency: string;
}

export interface ProcurementRequestArgs {
  requests: Default<ProcurementRequestSeed[], typeof defaultRequests>;
}

export interface ApprovalDecisionEvent {
  id?: string;
  stage?: string;
  decision?: string;
  note?: string;
}

export interface RerouteEvent {
  id?: string;
  stage?: string;
  approver?: string;
  note?: string;
}

type StageKey = "department" | "procurement" | "finance";

type StageTemplate = {
  key: StageKey;
  label: string;
  fallbackApprover: string;
};

const stageCatalog: readonly StageTemplate[] = [
  {
    key: "department",
    label: "Department Review",
    fallbackApprover: "Department Head",
  },
  {
    key: "procurement",
    label: "Procurement Desk",
    fallbackApprover: "Procurement Lead",
  },
  {
    key: "finance",
    label: "Finance Approval",
    fallbackApprover: "Finance Controller",
  },
];

const defaultRequests: ProcurementRequestSeed[] = [
  {
    id: "monitor-upgrade",
    requester: "Jordan Smith",
    department: "Engineering",
    vendor: "Display Hub",
    description: '24" workstation monitor replacements',
    amount: 3200,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Morgan Patel",
        status: "approved",
      },
      {
        label: "Procurement Desk",
        approver: "Ariana Flores",
        status: "pending",
      },
      {
        label: "Finance Approval",
        approver: "Casey Liu",
        status: "pending",
      },
    ],
  },
  {
    id: "ergonomic-chairs",
    requester: "Kendall Ortiz",
    department: "Operations",
    vendor: "Comfort Office",
    description: "Ergonomic chairs for support pod",
    amount: 1850,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Jamie Lynn",
        status: "pending",
      },
      {
        label: "Procurement Desk",
        approver: "Samir Adey",
        status: "pending",
      },
      {
        label: "Finance Approval",
        approver: "Wei Tan",
        status: "pending",
      },
    ],
  },
  {
    id: "software-renewal",
    requester: "Hayden Lee",
    department: "Product",
    vendor: "Workflow Soft",
    description: "Annual workflow suite renewal",
    amount: 2400,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Ally Ng",
        status: "approved",
      },
      {
        label: "Procurement Desk",
        approver: "Asha Ray",
        status: "approved",
      },
      {
        label: "Finance Approval",
        approver: "Jonas Pike",
        status: "approved",
      },
    ],
  },
];

const HISTORY_LIMIT = 8;

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeCurrency = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : fallback;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(fallback);
  }
  return roundCurrency(value < 0 ? 0 : value);
};

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
};

const slugOrFallback = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const ensureUniqueId = (base: string, used: Set<string>): string => {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeStageStatus = (
  value: unknown,
  fallback: StageStatus,
): StageStatus => {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "pending" ||
      normalized === "approved" ||
      normalized === "rejected"
    ) {
      return normalized as StageStatus;
    }
  }
  return fallback;
};

const normalizeStageKey = (value: unknown): StageKey | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  for (const stage of stageCatalog) {
    if (normalized === stage.key) return stage.key;
    if (normalized === stage.label.toLowerCase()) return stage.key;
  }
  return undefined;
};

const defaultStageSeeds = (): ApprovalStageSeed[] => {
  return stageCatalog.map((stage) => ({
    key: stage.key,
    label: stage.label,
    approver: stage.fallbackApprover,
    status: "pending",
  }));
};

const sanitizeStageList = (
  value: readonly ApprovalStageSeed[] | undefined,
  fallback: readonly ApprovalStageSeed[],
): ApprovalStage[] => {
  const base = Array.isArray(value) && value.length > 0 ? value : fallback;
  return stageCatalog.map((stage, index) => {
    const raw = base[index] ?? fallback[index] ?? {};
    const fallbackApprover = sanitizeText(
      fallback[index]?.approver,
      stage.fallbackApprover,
    );
    const fallbackStatus = sanitizeStageStatus(
      fallback[index]?.status,
      "pending",
    );
    const approver = sanitizeText(raw?.approver, fallbackApprover);
    const label = sanitizeText(raw?.label, stage.label);
    const status = sanitizeStageStatus(raw?.status, fallbackStatus);
    return {
      key: stage.key,
      label,
      approver,
      status,
    };
  });
};

const deriveRequestStatus = (
  stages: readonly ApprovalStage[],
): RequestStatus => {
  if (stages.some((stage) => stage.status === "rejected")) {
    return "rejected";
  }
  if (stages.every((stage) => stage.status === "approved")) {
    return "approved";
  }
  return "routing";
};

const sanitizeRequests = (
  value: readonly ProcurementRequestSeed[] | undefined,
): ProcurementRequest[] => {
  const base = Array.isArray(value) && value.length > 0
    ? value
    : defaultRequests;
  const used = new Set<string>();
  const sanitized: ProcurementRequest[] = [];

  for (let index = 0; index < base.length; index++) {
    const raw = base[index] ?? {};
    const defaults = defaultRequests[index] ?? {};
    const fallbackId = slugOrFallback(
      defaults.id,
      `request-${index + 1}`,
    );
    const idBase = slugOrFallback(raw.id, fallbackId);
    const id = ensureUniqueId(idBase, used);
    const requester = sanitizeText(
      raw.requester,
      sanitizeText(defaults.requester, `Requester ${index + 1}`),
    );
    const department = sanitizeText(
      raw.department,
      sanitizeText(defaults.department, "Operations"),
    );
    const vendor = sanitizeText(
      raw.vendor,
      sanitizeText(defaults.vendor, `Vendor ${index + 1}`),
    );
    const description = sanitizeText(
      raw.description,
      sanitizeText(defaults.description, "Procurement request"),
    );
    const amount = sanitizeAmount(
      raw.amount,
      sanitizeAmount(defaults.amount, 1000),
    );
    const currency = sanitizeCurrency(
      raw.currency,
      sanitizeCurrency(defaults.currency, "USD"),
    );
    const fallbackStages = Array.isArray(defaults.stages) &&
        defaults.stages.length > 0
      ? defaults.stages
      : defaultStageSeeds();
    const stages = sanitizeStageList(raw.stages, fallbackStages);
    const status = deriveRequestStatus(stages);
    sanitized.push({
      id,
      requester,
      department,
      vendor,
      description,
      amount,
      currency,
      stages,
      status,
    });
  }

  if (sanitized.length === 0) {
    return sanitizeRequests(defaultRequests);
  }

  return sanitized;
};

const serializeRequest = (
  request: ProcurementRequest,
): ProcurementRequestSeed => {
  return {
    id: request.id,
    requester: request.requester,
    department: request.department,
    vendor: request.vendor,
    description: request.description,
    amount: request.amount,
    currency: request.currency,
    stages: request.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      approver: stage.approver,
      status: stage.status,
    })),
  };
};

const calculateTotals = (
  requests: readonly ProcurementRequest[],
): AmountTotals => {
  let requested = 0;
  let routing = 0;
  let approved = 0;
  let rejected = 0;

  for (const request of requests) {
    const amount = roundCurrency(request.amount);
    requested += amount;
    if (request.status === "routing") {
      routing += amount;
    } else if (request.status === "approved") {
      approved += amount;
    } else {
      rejected += amount;
    }
  }

  return {
    requested: roundCurrency(requested),
    routing: roundCurrency(routing),
    approved: roundCurrency(approved),
    rejected: roundCurrency(rejected),
  };
};

const calculateCounts = (
  requests: readonly ProcurementRequest[],
): RequestCounts => {
  let routing = 0;
  let approved = 0;
  let rejected = 0;
  for (const request of requests) {
    if (request.status === "routing") routing += 1;
    else if (request.status === "approved") approved += 1;
    else rejected += 1;
  }
  return {
    total: requests.length,
    routing,
    approved,
    rejected,
  };
};

const buildDepartmentTotals = (
  requests: readonly ProcurementRequest[],
): DepartmentTotals[] => {
  const totals = new Map<string, DepartmentTotals>();

  for (const request of requests) {
    const existing = totals.get(request.department) ?? {
      department: request.department,
      requested: 0,
      routing: 0,
      approved: 0,
      rejected: 0,
    };
    existing.requested = roundCurrency(existing.requested + request.amount);
    if (request.status === "routing") {
      existing.routing = roundCurrency(existing.routing + request.amount);
    } else if (request.status === "approved") {
      existing.approved = roundCurrency(existing.approved + request.amount);
    } else {
      existing.rejected = roundCurrency(existing.rejected + request.amount);
    }
    totals.set(request.department, existing);
  }

  return Array.from(totals.values()).sort((left, right) =>
    left.department.localeCompare(right.department)
  );
};

const buildAssignments = (
  requests: readonly ProcurementRequest[],
): RoutingAssignment[] => {
  const assignments: RoutingAssignment[] = [];
  for (const request of requests) {
    if (request.status !== "routing") continue;
    const nextStage = request.stages.find((stage) =>
      stage.status === "pending"
    );
    if (!nextStage) continue;
    assignments.push({
      id: request.id,
      vendor: request.vendor,
      department: request.department,
      stage: nextStage.label,
      approver: nextStage.approver,
      amount: request.amount,
      currency: request.currency,
    });
  }
  return assignments.sort((left, right) => left.id.localeCompare(right.id));
};

const formatCurrency = (amount: number, currency: string): string => {
  return `${currency} ${roundCurrency(amount).toFixed(2)}`;
};

const buildSummaryLine = (
  requests: readonly ProcurementRequest[],
): string => {
  if (requests.length === 0) return "No procurement requests";
  const totals = calculateTotals(requests);
  const counts = calculateCounts(requests);
  const currency = requests[0]?.currency ?? "USD";
  const routingLabel = formatCurrency(totals.routing, currency);
  const approvedLabel = formatCurrency(totals.approved, currency);
  const rejectedLabel = formatCurrency(totals.rejected, currency);
  const parts = [
    `${counts.routing} routing (${routingLabel})`,
    `${counts.approved} approved (${approvedLabel})`,
    `${counts.rejected} rejected (${rejectedLabel})`,
  ];
  return `${counts.total} requests: ${parts.join(", ")}`;
};

const normalizeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeDecision = (value: unknown): StageStatus | undefined => {
  if (value === "approved" || value === "rejected") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "approved" || normalized === "rejected") {
      return normalized as StageStatus;
    }
  }
  return undefined;
};

const pushHistory = (
  history: Cell<string[]>,
  sequence: Cell<number>,
  message: string,
) => {
  const current = sequence.get() ?? 1;
  const nextSequence = current + 1;
  sequence.set(nextSequence);
  const entry = `${nextSequence}. ${message}`;
  const previous = history.get() ?? [];
  const appended = [...previous, entry];
  if (appended.length > HISTORY_LIMIT) {
    history.set(appended.slice(-HISTORY_LIMIT));
    return;
  }
  history.set(appended);
};

const buildDecisionMessage = (
  request: ProcurementRequest,
  stage: ApprovalStage,
  decision: StageStatus,
): string => {
  const amount = formatCurrency(request.amount, request.currency);
  if (decision === "approved") {
    if (request.status === "approved") {
      return [
        "Completed approval for",
        `${request.vendor} (${request.id})`,
        amount,
      ].join(" ");
    }
    return [
      "Approved",
      stage.label,
      "for",
      request.id,
      `(${stage.approver})`,
    ].join(" ");
  }
  return [
    "Rejected",
    request.id,
    "at",
    stage.label,
    `(${amount})`,
  ].join(" ");
};

const buildRerouteMessage = (
  request: ProcurementRequest,
  stage: ApprovalStage,
): string => {
  const amount = formatCurrency(request.amount, request.currency);
  return [
    "Rerouted",
    request.id,
    "to",
    stage.approver,
    "for",
    stage.label,
    `(${amount})`,
  ].join(" ");
};

// Module-scope lift definitions
const liftSanitizeRequests = lift(sanitizeRequests);
const liftCalculateTotals = lift(calculateTotals);
const liftCalculateCounts = lift(calculateCounts);
const liftBuildDepartmentTotals = lift(buildDepartmentTotals);
const liftBuildAssignments = lift(buildAssignments);
const liftBuildSummaryLine = lift(buildSummaryLine);

const recordDecision = handler(
  (
    event: ApprovalDecisionEvent | undefined,
    context: {
      requests: Cell<ProcurementRequestSeed[]>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const id = normalizeId(event?.id);
    const decision = normalizeDecision(event?.decision);
    if (!id || !decision) return;

    const sanitized = sanitizeRequests(context.requests.get());
    const index = sanitized.findIndex((request) => request.id === id);
    if (index === -1) return;

    const request = sanitized[index];
    const stageKey = normalizeStageKey(event?.stage) ??
      request.stages.find((stage) => stage.status === "pending")?.key;
    if (!stageKey) return;

    const stageIndex = request.stages.findIndex((stage) =>
      stage.key === stageKey
    );
    if (stageIndex === -1) return;

    const targetStage = request.stages[stageIndex];
    if (decision === targetStage.status) return;

    const updatedStages = request.stages.map(
      (stage, stageIdx): ApprovalStage => {
        if (stageIdx === stageIndex) {
          return { ...stage, status: decision };
        }
        if (decision === "rejected" && stageIdx > stageIndex) {
          return { ...stage, status: "pending" };
        }
        return stage;
      },
    );

    const updatedRequest: ProcurementRequest = {
      ...request,
      stages: updatedStages,
      status: deriveRequestStatus(updatedStages),
    };

    const nextRequests = sanitized.map((entry, entryIndex) =>
      entryIndex === index ? updatedRequest : entry
    );
    context.requests.set(nextRequests.map(serializeRequest));

    const message = buildDecisionMessage(
      updatedRequest,
      updatedStages[stageIndex],
      decision,
    );
    pushHistory(context.history, context.sequence, message);
  },
);

const rerouteStage = handler(
  (
    event: RerouteEvent | undefined,
    context: {
      requests: Cell<ProcurementRequestSeed[]>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const id = normalizeId(event?.id);
    if (!id) return;
    const sanitized = sanitizeRequests(context.requests.get());
    const index = sanitized.findIndex((request) => request.id === id);
    if (index === -1) return;

    const request = sanitized[index];
    const stageKey = normalizeStageKey(event?.stage) ??
      request.stages.find((stage) => stage.status !== "approved")?.key;
    if (!stageKey) return;

    const stageIndex = request.stages.findIndex((stage) =>
      stage.key === stageKey
    );
    if (stageIndex === -1) return;

    const currentStage = request.stages[stageIndex];
    const approver = sanitizeText(
      event?.approver,
      currentStage.approver,
    );

    const updatedStages = request.stages.map(
      (stage, stageIdx): ApprovalStage => {
        if (stageIdx === stageIndex) {
          return { ...stage, approver, status: "pending" };
        }
        if (stageIdx > stageIndex) {
          return { ...stage, status: "pending" };
        }
        return stage;
      },
    );

    const updatedRequest: ProcurementRequest = {
      ...request,
      stages: updatedStages,
      status: deriveRequestStatus(updatedStages),
    };

    const nextRequests = sanitized.map((entry, entryIndex) =>
      entryIndex === index ? updatedRequest : entry
    );
    context.requests.set(nextRequests.map(serializeRequest));

    const message = buildRerouteMessage(
      updatedRequest,
      updatedStages[stageIndex],
    );
    pushHistory(context.history, context.sequence, message);
  },
);

/**
 * Builds a procurement approval workflow that tracks routing progress while
 * deriving deterministic spending summaries for the harness.
 */
export const procurementRequest = pattern<ProcurementRequestArgs>(
  ({ requests }) => {
    const history = cell<string[]>(["1. Procurement queue initialized"]);
    const sequence = cell(1);

    const requestList = liftSanitizeRequests(requests);
    const totals = liftCalculateTotals(requestList);
    const counts = liftCalculateCounts(requestList);
    const departmentTotals = liftBuildDepartmentTotals(requestList);
    const routingAssignments = liftBuildAssignments(requestList);
    const summaryLine = liftBuildSummaryLine(requestList);
    const stageHeadline = str`${counts.routing} requests awaiting review`;

    const handlerContext = { requests, history, sequence };

    return {
      requests,
      requestList,
      totals,
      counts,
      departmentTotals,
      routingAssignments,
      summaryLine,
      stageHeadline,
      activityLog: history,
      recordDecision: recordDecision(handlerContext),
      rerouteStage: rerouteStage(handlerContext),
    };
  },
);

export default procurementRequest;
