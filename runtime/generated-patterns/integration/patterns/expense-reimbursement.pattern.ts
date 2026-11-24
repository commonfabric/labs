import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type ClaimStatus = "submitted" | "approved" | "rejected" | "paid";

type ActionKind = "approved" | "rejected" | "paid";

interface ExpenseClaimInput {
  id?: string;
  employee?: string;
  description?: string;
  amount?: number;
  status?: string;
}

interface ExpenseClaim {
  id: string;
  employee: string;
  description: string;
  amount: number;
  status: ClaimStatus;
}

interface ExpenseTotals {
  submitted: number;
  approved: number;
  rejected: number;
  paid: number;
  pendingPayment: number;
  totalRequested: number;
}

interface ExpenseReimbursementArgs {
  claims: Default<ExpenseClaimInput[], typeof defaultClaims>;
}

interface StatusChangeEvent {
  id?: string;
}

interface StatusHandlerContext {
  claims: Cell<ExpenseClaimInput[]>;
  history: Cell<string[]>;
  latestAction: Cell<string>;
  sequence: Cell<number>;
  kind: ActionKind;
  nextStatus: ClaimStatus;
  allowed: readonly ClaimStatus[];
}

const defaultClaims: ExpenseClaimInput[] = [
  {
    id: "travel-001",
    employee: "Avery",
    description: "Quarterly offsite travel",
    amount: 186.25,
    status: "submitted",
  },
  {
    id: "supplies-002",
    employee: "Briar",
    description: "Workshop materials",
    amount: 92.4,
    status: "submitted",
  },
  {
    id: "team-lunch-003",
    employee: "Sky",
    description: "Team lunch with client",
    amount: 48.5,
    status: "approved",
  },
  {
    id: "lodging-004",
    employee: "Riley",
    description: "Conference lodging",
    amount: 220,
    status: "paid",
  },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(0, value));
};

const normalizeText = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizeStatus = (
  value: unknown,
  fallback: ClaimStatus,
): ClaimStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase();
  if (
    normalized === "submitted" ||
    normalized === "approved" ||
    normalized === "rejected" ||
    normalized === "paid"
  ) {
    return normalized;
  }
  return fallback;
};

const slugify = (value: string): string => {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const slugOrFallback = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const ensureUniqueId = (
  base: string,
  used: Set<string>,
  fallback: string,
): string => {
  const initial = base.length > 0 ? base : fallback;
  let candidate = initial;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${initial}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeClaimList = (
  value: readonly ExpenseClaimInput[] | undefined,
): ExpenseClaim[] => {
  const source = Array.isArray(value) ? value : [];
  const base = source.length > 0 ? source : defaultClaims;
  const usedIds = new Set<string>();
  const sanitized: ExpenseClaim[] = [];

  for (let index = 0; index < base.length; index++) {
    const raw = base[index];
    const defaults = defaultClaims[index] ?? {};
    const fallbackEmployee = normalizeText(
      defaults.employee,
      `Employee ${index + 1}`,
    );
    const fallbackDescription = normalizeText(
      defaults.description,
      `Expense ${index + 1}`,
    );
    const fallbackAmount = sanitizeAmount(defaults.amount, 0);
    const fallbackStatus = normalizeStatus(defaults.status, "submitted");
    const fallbackSlug = slugOrFallback(defaults.id, `claim-${index + 1}`);
    const baseSlug = slugOrFallback(raw?.id, fallbackSlug);
    const id = ensureUniqueId(baseSlug, usedIds, fallbackSlug);
    const employee = normalizeText(raw?.employee, fallbackEmployee);
    const description = normalizeText(raw?.description, fallbackDescription);
    const amount = sanitizeAmount(raw?.amount, fallbackAmount);
    const status = normalizeStatus(raw?.status, fallbackStatus);
    sanitized.push({ id, employee, description, amount, status });
  }

  if (sanitized.length === 0) {
    return sanitizeClaimList(defaultClaims);
  }

  return sanitized;
};

const calculateTotals = (claims: readonly ExpenseClaim[]): ExpenseTotals => {
  let submitted = 0;
  let approved = 0;
  let rejected = 0;
  let paid = 0;

  for (const claim of claims) {
    const amount = roundCurrency(claim.amount);
    switch (claim.status) {
      case "submitted":
        submitted += amount;
        break;
      case "approved":
        approved += amount;
        break;
      case "rejected":
        rejected += amount;
        break;
      case "paid":
        paid += amount;
        break;
    }
  }

  const totalRequested = claims.reduce(
    (sum, claim) => sum + roundCurrency(claim.amount),
    0,
  );

  return {
    submitted: roundCurrency(submitted),
    approved: roundCurrency(approved),
    rejected: roundCurrency(rejected),
    paid: roundCurrency(paid),
    pendingPayment: roundCurrency(approved),
    totalRequested: roundCurrency(totalRequested),
  };
};

const formatCurrency = (value: number): string => {
  return `$${roundCurrency(value).toFixed(2)}`;
};

const buildSummaryLabel = (totals: ExpenseTotals): string => {
  const requested = formatCurrency(totals.totalRequested);
  const paid = formatCurrency(totals.paid);
  const pending = formatCurrency(totals.pendingPayment);
  return `Recorded ${requested} in claims; reimbursed ${paid}; pending ${pending}.`;
};

const buildActionMessage = (
  kind: ActionKind,
  claim: ExpenseClaim,
): string => {
  const amount = formatCurrency(claim.amount);
  if (kind === "approved") {
    return `Approved ${claim.id} for ${claim.employee} (${amount})`;
  }
  if (kind === "rejected") {
    return `Rejected ${claim.id} for ${claim.employee} (${amount})`;
  }
  return `Recorded payment for ${claim.id} (${amount})`;
};

const statusChangeHandler = handler(
  (event: StatusChangeEvent | undefined, context: StatusHandlerContext) => {
    const id = typeof event?.id === "string" ? event.id.trim() : "";
    if (id.length === 0) return;

    const sanitized = sanitizeClaimList(context.claims.get());
    const index = sanitized.findIndex((claim) => claim.id === id);
    if (index === -1) return;

    const target = sanitized[index];
    if (!context.allowed.includes(target.status)) return;

    const updatedClaim: ExpenseClaim = {
      ...target,
      status: context.nextStatus,
    };
    const nextClaims = sanitized.map((claim, claimIndex) =>
      claimIndex === index ? updatedClaim : claim
    );
    context.claims.set(nextClaims.map((claim) => ({ ...claim })));

    const message = buildActionMessage(context.kind, updatedClaim);
    context.latestAction.set(message);

    const previousHistory = context.history.get() ?? [];
    const appended = [...previousHistory, message];
    const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
    context.history.set(trimmed);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const liftSanitizeClaimList = lift(sanitizeClaimList);
const liftCalculateTotals = lift(calculateTotals);

const liftClaimCount = lift((entries: readonly ExpenseClaim[]) =>
  entries.length
);
const liftSubmittedTotal = lift((data: ExpenseTotals) => data.submitted);
const liftApprovedTotal = lift((data: ExpenseTotals) => data.approved);
const liftRejectedTotal = lift((data: ExpenseTotals) => data.rejected);
const liftPaidTotal = lift((data: ExpenseTotals) => data.paid);
const liftPendingPayment = lift((data: ExpenseTotals) => data.pendingPayment);
const liftSummaryLabel = lift(buildSummaryLabel);

export const expenseReimbursement = pattern<ExpenseReimbursementArgs>(
  ({ claims }) => {
    const history = cell<string[]>(["Reimbursement tracker initialized"]);
    const latestAction = cell("Reimbursement tracker initialized");
    const sequence = cell(0);

    const claimList = liftSanitizeClaimList(claims);
    const totals = liftCalculateTotals(claimList);

    const claimCount = liftClaimCount(claimList);
    const submittedTotal = liftSubmittedTotal(totals);
    const approvedTotal = liftApprovedTotal(totals);
    const rejectedTotal = liftRejectedTotal(totals);
    const paidTotal = liftPaidTotal(totals);
    const pendingPayment = liftPendingPayment(totals);
    const summaryLabel = liftSummaryLabel(totals);
    const statusHeadline = str`${claimCount} claims ready for review`;

    const handlerContext = { claims, history, latestAction, sequence };

    return {
      claims,
      claimList,
      totals,
      claimCount,
      submittedTotal,
      approvedTotal,
      rejectedTotal,
      paidTotal,
      pendingPayment,
      summaryLabel,
      statusHeadline,
      latestAction,
      activityLog: history,
      approveClaim: statusChangeHandler({
        ...handlerContext,
        kind: "approved",
        nextStatus: "approved",
        allowed: ["submitted"],
      }),
      recordPayment: statusChangeHandler({
        ...handlerContext,
        kind: "paid",
        nextStatus: "paid",
        allowed: ["approved"],
      }),
      rejectClaim: statusChangeHandler({
        ...handlerContext,
        kind: "rejected",
        nextStatus: "rejected",
        allowed: ["submitted", "approved"],
      }),
    };
  },
);

export default expenseReimbursement;
