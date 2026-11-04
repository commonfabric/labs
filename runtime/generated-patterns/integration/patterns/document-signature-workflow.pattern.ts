import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type SignatureStatus = "pending" | "signed" | "declined";

interface SignerSeed {
  id?: string;
  name?: string;
  role?: string;
  email?: string;
  status?: string;
  signedAt?: string;
  order?: number;
}

interface SignerEntry extends SignerSeed {
  id: string;
  name: string;
  role: string;
  email: string;
  status: SignatureStatus;
  order: number;
  signedAt?: string;
}

interface DocumentSignatureWorkflowArgs {
  documentTitle: Default<string, typeof defaultDocumentTitle>;
  signers: Default<SignerSeed[], typeof defaultSigners>;
}

interface MarkSignedEvent {
  id?: string;
  signedAt?: string;
}

interface DeclineSignerEvent {
  id?: string;
  reason?: string;
}

interface ResetSignerEvent {
  id?: string;
}

interface DocumentSignatureContext {
  signers: Cell<SignerSeed[]>;
  log: Cell<string[]>;
}

const defaultDocumentTitle = "Master Services Agreement";

const defaultSigners: SignerSeed[] = [
  {
    id: "signer-legal",
    name: "Amelia Edwards",
    role: "Legal Counsel",
    email: "amelia@firm.example",
    status: "signed",
    signedAt: "2024-07-01",
    order: 1,
  },
  {
    id: "signer-sales",
    name: "Noah Chen",
    role: "Account Executive",
    email: "noah@commontools.example",
    status: "pending",
    order: 2,
  },
  {
    id: "signer-client",
    name: "Ravi Patel",
    role: "Client CFO",
    email: "ravi@client-co.example",
    status: "pending",
    order: 3,
  },
];

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    const normalized = trimmed
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length > 0) return normalized;
  }
  return fallback;
};

const sanitizeWhitespace = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeName = (value: unknown, fallback: string): string => {
  const cleaned = sanitizeWhitespace(value, fallback);
  return cleaned
    .split(" ")
    .map((segment) =>
      segment.length > 0
        ? segment[0].toUpperCase() + segment.slice(1).toLowerCase()
        : segment
    )
    .join(" ");
};

const sanitizeRole = (value: unknown, fallback: string): string => {
  const cleaned = sanitizeWhitespace(value, fallback);
  return cleaned.length > 0 ? cleaned : fallback;
};

const sanitizeEmail = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.includes("@") && trimmed.split("@").length === 2) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeStatus = (
  value: unknown,
  fallback: SignatureStatus,
): SignatureStatus => {
  if (value === "pending" || value === "signed" || value === "declined") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "pending" ||
      normalized === "signed" ||
      normalized === "declined"
    ) {
      return normalized as SignatureStatus;
    }
  }
  return fallback;
};

const sanitizeOrder = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const integer = Math.trunc(value);
    return integer < 1 ? 1 : integer;
  }
  return fallback < 1 ? 1 : Math.trunc(fallback);
};

const sanitizeDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\//g, "-");
    if (datePattern.test(normalized)) return normalized;
  }
  return fallback;
};

const sanitizeReason = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : "";
};

const sanitizeTitle = (
  value: unknown,
  fallback: string = defaultDocumentTitle,
): string => {
  const cleaned = sanitizeWhitespace(value, fallback);
  return cleaned.length > 0 ? cleaned : fallback;
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let id = `${candidate}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${candidate}-${index}`;
  }
  used.add(id);
  return id;
};

const defaultSignedDate = (order: number): string => {
  const day = ((order - 1) % 27) + 1;
  return `2024-07-${String(day).padStart(2, "0")}`;
};

const sanitizeSigner = (
  seed: SignerSeed | undefined,
  fallback: SignerSeed,
  index: number,
  used: Set<string>,
): SignerEntry => {
  const fallbackId = typeof fallback.id === "string" && fallback.id.length > 0
    ? fallback.id
    : `signer-${index + 1}`;
  const id = ensureUniqueId(
    sanitizeIdentifier(seed?.id, fallbackId),
    used,
  );
  const fallbackName = sanitizeName(
    fallback.name,
    `Signer ${index + 1}`,
  );
  const name = sanitizeName(seed?.name, fallbackName);
  const fallbackRole = sanitizeRole(fallback.role, "Signer");
  const role = sanitizeRole(seed?.role, fallbackRole);
  const fallbackEmail = sanitizeEmail(
    fallback.email,
    `${id}@signature.local`,
  );
  const email = sanitizeEmail(seed?.email, fallbackEmail);
  const fallbackOrder = sanitizeOrder(fallback.order, index + 1);
  const order = sanitizeOrder(seed?.order, fallbackOrder);
  const fallbackStatus = sanitizeStatus(fallback.status, "pending");
  const status = sanitizeStatus(seed?.status, fallbackStatus);
  const fallbackSignedAt = sanitizeDate(
    fallback.signedAt,
    defaultSignedDate(order),
  );
  const signedAt = status === "signed"
    ? sanitizeDate(seed?.signedAt, fallbackSignedAt)
    : undefined;
  return {
    id,
    name,
    role,
    email,
    status,
    order,
    signedAt,
  };
};

const sortSigners = (entries: readonly SignerEntry[]): SignerEntry[] => {
  return entries.slice().sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
};

const sanitizeSignerList = (
  value: readonly SignerSeed[] | undefined,
): SignerEntry[] => {
  const seeds = Array.isArray(value) && value.length > 0
    ? value
    : defaultSigners;
  const used = new Set<string>();
  const entries: SignerEntry[] = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const fallback = defaultSigners[index % defaultSigners.length];
    const entry = sanitizeSigner(seeds[index], fallback, index, used);
    entries.push(entry);
  }
  return sortSigners(entries);
};

const appendHistory = (
  history: readonly string[],
  entry: string,
): string[] => {
  const next = [...history, entry];
  return next.length > 6 ? next.slice(next.length - 6) : next;
};

const getSanitizedSigners = (
  context: DocumentSignatureContext,
): SignerEntry[] => {
  return sanitizeSignerList(context.signers.get());
};

const storeSigners = (
  context: DocumentSignatureContext,
  entries: readonly SignerEntry[],
) => {
  context.signers.set(entries.map((entry) => ({ ...entry })));
};

const markSignerSigned = handler(
  (event: MarkSignedEvent | undefined, context: DocumentSignatureContext) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedSigners(context);
    const index = current.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = current[index];
    if (entry.status === "signed") return;
    const signedAt = sanitizeDate(
      event?.signedAt,
      defaultSignedDate(entry.order),
    );
    const next = current.slice();
    next[index] = { ...entry, status: "signed", signedAt };
    storeSigners(context, sortSigners(next));
    const message = `${entry.name} (${entry.role}) signed on ${signedAt}`;
    context.log.set(appendHistory(context.log.get() ?? [], message));
  },
);

const markSignerDeclined = handler(
  (
    event: DeclineSignerEvent | undefined,
    context: DocumentSignatureContext,
  ) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedSigners(context);
    const index = current.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = current[index];
    if (entry.status === "declined") return;
    const reason = sanitizeReason(event?.reason);
    const next = current.slice();
    next[index] = { ...entry, status: "declined", signedAt: undefined };
    storeSigners(context, sortSigners(next));
    const suffix = reason.length > 0 ? ` (${reason})` : "";
    const message = `${entry.name} (${entry.role}) declined${suffix}`;
    context.log.set(appendHistory(context.log.get() ?? [], message));
  },
);

const resetSigner = handler(
  (event: ResetSignerEvent | undefined, context: DocumentSignatureContext) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedSigners(context);
    const index = current.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = current[index];
    if (entry.status === "pending" && entry.signedAt === undefined) {
      return;
    }
    const next = current.slice();
    next[index] = { ...entry, status: "pending", signedAt: undefined };
    storeSigners(context, sortSigners(next));
    const message = `${entry.name} reset to pending`;
    context.log.set(appendHistory(context.log.get() ?? [], message));
  },
);

const liftSanitizeTitle = lift((raw: string | undefined) => sanitizeTitle(raw));

const liftSanitizeSignerList = lift(sanitizeSignerList);

const liftOrderedSignersView = lift((entries: SignerEntry[]) =>
  entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    role: entry.role,
    email: entry.email,
    status: entry.status,
    order: entry.order,
    signedAt: entry.signedAt ?? null,
  }))
);

const liftOutstandingEntries = lift((entries: SignerEntry[]) =>
  entries.filter((entry) => entry.status !== "signed")
);

const liftOutstandingSignersView = lift((entries: SignerEntry[]) =>
  entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    role: entry.role,
    status: entry.status,
    order: entry.order,
  }))
);

const liftOutstandingSummary = lift((entries: SignerEntry[]) => {
  if (entries.length === 0) return "All signers completed";
  return entries
    .map((entry) =>
      `${entry.order}. ${entry.name} (${entry.role}) - ${entry.status}`
    )
    .join(" | ");
});

const liftTotalCount = lift((entries: SignerEntry[]) => entries.length);

const liftCompletedCount = lift((entries: SignerEntry[]) =>
  entries.filter((entry) => entry.status === "signed").length
);

const liftOutstandingCount = lift((entries: SignerEntry[]) =>
  entries.filter((entry) => entry.status !== "signed").length
);

const liftNextSigner = lift((entries: SignerEntry[]) => {
  for (const entry of entries) {
    if (entry.status === "pending") return entry;
  }
  return null;
});

const liftNextSignerView = lift((entry: SignerEntry | null) => {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    email: entry.email,
    order: entry.order,
  };
});

const liftStatusLine = lift((input: {
  title: string;
  next: SignerEntry | null;
  outstanding: number;
}) => {
  if (input.outstanding === 0) {
    return `${input.title}: all signatures collected`;
  }
  if (input.next) {
    return `${input.title}: next ${input.next.name} (${input.next.role}); ` +
      `${input.outstanding} outstanding`;
  }
  return `${input.title}: ${input.outstanding} outstanding signatures`;
});

const liftCounts = lift((input: {
  total: number;
  completed: number;
  outstanding: number;
}) => input);

const liftCompletionPercent = lift((input: {
  total: number;
  completed: number;
}) => {
  if (input.total === 0) return 0;
  return Math.round((input.completed / input.total) * 100);
});

const liftActivityLog = lift((input: {
  title: string;
  entries: string[];
}) => {
  const initial = `Signature packet prepared for ${input.title}`;
  const combined = [initial, ...input.entries];
  return combined.length > 6 ? combined.slice(combined.length - 6) : combined;
});

export const documentSignatureWorkflow = pattern<DocumentSignatureWorkflowArgs>(
  ({ documentTitle, signers }) => {
    const logEntries = cell<string[]>([]);

    const titleView = liftSanitizeTitle(documentTitle);

    const orderedSigners = liftSanitizeSignerList(signers);
    const orderedSignersView = liftOrderedSignersView(orderedSigners);

    const outstandingEntries = liftOutstandingEntries(orderedSigners);
    const outstandingSignersView = liftOutstandingSignersView(
      outstandingEntries,
    );

    const outstandingSummary = liftOutstandingSummary(outstandingEntries);

    const totalCount = liftTotalCount(orderedSigners);
    const completedCount = liftCompletedCount(orderedSigners);
    const outstandingCount = liftOutstandingCount(orderedSigners);

    const nextSigner = liftNextSigner(orderedSigners);
    const nextSignerView = liftNextSignerView(nextSigner);

    const statusLine = liftStatusLine({
      title: titleView,
      next: nextSigner,
      outstanding: outstandingCount,
    });

    const counts = liftCounts({
      total: totalCount,
      completed: completedCount,
      outstanding: outstandingCount,
    });

    const completionPercent = liftCompletionPercent({
      total: totalCount,
      completed: completedCount,
    });

    const progressLabel = str`${completionPercent}% complete for ${titleView}`;

    const activityLog = liftActivityLog({
      title: titleView,
      entries: logEntries,
    });

    const context = {
      signers: signers,
      log: logEntries,
    };

    return {
      title: titleView,
      orderedSigners: orderedSignersView,
      outstandingSigners: outstandingSignersView,
      outstandingSummary,
      nextSigner: nextSignerView,
      counts,
      completionPercent,
      statusLine,
      progressLabel,
      activityLog,
      markSigned: markSignerSigned(context),
      markDeclined: markSignerDeclined(context),
      resetSigner: resetSigner(context),
    };
  },
);

export default documentSignatureWorkflow;
