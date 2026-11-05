import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface LibraryItem {
  id: string;
  title: string;
  copiesTotal: number;
}

interface LoanRecord {
  sequence: number;
  itemId: string;
  memberId: string;
}

interface HoldRecord {
  sequence: number;
  itemId: string;
  memberId: string;
}

interface CheckoutEvent {
  itemId?: string;
  memberId?: string;
}

interface HoldEvent {
  itemId?: string;
  memberId?: string;
}

interface CirculationChange {
  sequence: number;
  type: "checkout" | "return" | "hold" | "cancel";
  itemId: string;
  memberId: string;
  note: string;
}

interface LibraryCheckoutArgs {
  catalog: Default<LibraryItem[], typeof defaultCatalog>;
  loans: Default<LoanRecord[], typeof defaultLoans>;
  holds: Default<HoldRecord[], typeof defaultHolds>;
}

interface ItemAvailability {
  id: string;
  title: string;
  totalCopies: number;
  activeLoans: number;
  availableCopies: number;
  holdsQueued: number;
  loanMembers: string[];
  holdMembers: string[];
  nextHold: string | null;
  status: "available" | "limited" | "on-hold" | "unavailable";
  statusLabel: string;
}

interface CirculationContext {
  catalog: Cell<LibraryItem[]>;
  loans: Cell<LoanRecord[]>;
  holds: Cell<HoldRecord[]>;
  eventSequence: Cell<number>;
  lastChange: Cell<CirculationChange | null>;
}

const defaultCatalog: LibraryItem[] = [
  { id: "atlas-of-dawn", title: "Atlas of Dawn", copiesTotal: 3 },
  { id: "modular-thoughts", title: "Modular Thoughts", copiesTotal: 1 },
  { id: "synthesis-primer", title: "Synthesis Primer", copiesTotal: 2 },
];

const defaultLoans: LoanRecord[] = [
  { sequence: 1, itemId: "atlas-of-dawn", memberId: "member-alba" },
  { sequence: 2, itemId: "modular-thoughts", memberId: "member-luis" },
];

const defaultHolds: HoldRecord[] = [
  { sequence: 1, itemId: "modular-thoughts", memberId: "member-jade" },
];

const slugify = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
};

const sanitizeItemId = (value: unknown): string | null => {
  const slug = slugify(value);
  return slug ?? null;
};

const sanitizeMemberId = (value: unknown): string | null => {
  const slug = slugify(value);
  if (!slug) return null;
  return slug.startsWith("member-") ? slug : `member-${slug}`;
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCopies = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    if (normalized > 0) return normalized;
  }
  return fallback;
};

const cloneCatalog = (items: readonly LibraryItem[]): LibraryItem[] =>
  items.map((item) => ({ ...item }));

const cloneLoans = (loans: readonly LoanRecord[]): LoanRecord[] =>
  loans.map((loan) => ({ ...loan }));

const cloneHolds = (holds: readonly HoldRecord[]): HoldRecord[] =>
  holds.map((hold) => ({ ...hold }));

const sanitizeCatalogList = (value: readonly LibraryItem[]): LibraryItem[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneCatalog(defaultCatalog);
  }
  const used = new Set<string>();
  const sanitized: LibraryItem[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as Partial<LibraryItem> | undefined;
    const fallback = defaultCatalog[index] ?? defaultCatalog[0];
    const id = sanitizeItemId(entry?.id ?? fallback.id);
    if (!id || used.has(id)) continue;
    const title = sanitizeTitle(entry?.title, fallback.title);
    const copies = sanitizeCopies(entry?.copiesTotal, fallback.copiesTotal);
    sanitized.push({ id, title, copiesTotal: copies });
    used.add(id);
  }
  return sanitized.length > 0 ? sanitized : cloneCatalog(defaultCatalog);
};

const sanitizeLoanList = (
  catalog: readonly LibraryItem[],
  value: unknown,
): LoanRecord[] => {
  const validItems = new Set(catalog.map((item) => item.id));
  if (!Array.isArray(value)) {
    return cloneLoans(
      defaultLoans.filter((loan) => validItems.has(loan.itemId)),
    );
  }
  if (value.length === 0) return [];
  const seen = new Set<string>();
  const sanitized: LoanRecord[] = [];
  for (const candidate of value) {
    const raw = candidate as Partial<LoanRecord> | undefined;
    const itemId = sanitizeItemId(raw?.itemId);
    const memberId = sanitizeMemberId(raw?.memberId);
    if (!itemId || !memberId || !validItems.has(itemId)) continue;
    const key = `${itemId}|${memberId}`;
    if (seen.has(key)) continue;
    sanitized.push({
      sequence: sanitized.length + 1,
      itemId,
      memberId,
    });
    seen.add(key);
  }
  return sanitized;
};

const sanitizeHoldList = (
  catalog: readonly LibraryItem[],
  value: unknown,
): HoldRecord[] => {
  const validItems = new Set(catalog.map((item) => item.id));
  if (!Array.isArray(value)) {
    return cloneHolds(
      defaultHolds.filter((hold) => validItems.has(hold.itemId)),
    );
  }
  if (value.length === 0) return [];
  const seen = new Set<string>();
  const sanitized: HoldRecord[] = [];
  for (const candidate of value) {
    const raw = candidate as Partial<HoldRecord> | undefined;
    const itemId = sanitizeItemId(raw?.itemId);
    const memberId = sanitizeMemberId(raw?.memberId);
    if (!itemId || !memberId || !validItems.has(itemId)) continue;
    const key = `${itemId}|${memberId}`;
    if (seen.has(key)) continue;
    sanitized.push({
      sequence: sanitized.length + 1,
      itemId,
      memberId,
    });
    seen.add(key);
  }
  return sanitized;
};

const formatCount = (
  count: number,
  singular: string,
  plural: string,
): string => {
  const value = count === 1 ? singular : plural;
  return `${count} ${value}`;
};

const statusLabelFor = (
  status: ItemAvailability["status"],
  available: number,
  total: number,
  holdCount: number,
): string => {
  switch (status) {
    case "available": {
      const base = `All ${total} copies available`;
      if (holdCount === 0) return base;
      const holdLabel = holdCount === 1
        ? "1 hold queued"
        : `${holdCount} holds queued`;
      return `${base}; ${holdLabel}`;
    }
    case "limited": {
      const base = `${available} of ${total} copies available`;
      if (holdCount === 0) return base;
      const holdLabel = holdCount === 1
        ? "1 hold queued"
        : `${holdCount} holds queued`;
      return `${base}; ${holdLabel}`;
    }
    case "on-hold": {
      const holdLabel = holdCount === 1
        ? "1 hold waiting"
        : `${holdCount} holds waiting`;
      return `All copies loaned; ${holdLabel}`;
    }
    case "unavailable":
      return "All copies loaned out";
  }
};

const computeAvailability = (
  catalog: readonly LibraryItem[],
  loans: readonly LoanRecord[],
  holds: readonly HoldRecord[],
): ItemAvailability[] => {
  const loansByItem = new Map<string, LoanRecord[]>();
  for (const loan of loans) {
    const bucket = loansByItem.get(loan.itemId) ?? [];
    // FIXME(@ubik2) - workaround for transformer removing unused memberId
    // from bucket contents, which makes the result invalid.
    const _memberId = loan.memberId;
    bucket.push(loan);
    loansByItem.set(loan.itemId, bucket);
  }
  const holdsByItem = new Map<string, HoldRecord[]>();
  for (const hold of holds) {
    const bucket = holdsByItem.get(hold.itemId) ?? [];
    // FIXME(@ubik2) - workaround for transformer removing unused memberId
    // from bucket contents, which makes the result invalid.
    const _memberId = hold.memberId;
    bucket.push(hold);
    holdsByItem.set(hold.itemId, bucket);
  }
  return catalog.map((item) => {
    const itemLoans = loansByItem.get(item.id) ?? [];
    const itemHolds = holdsByItem.get(item.id) ?? [];
    const availableCopies = Math.max(item.copiesTotal - itemLoans.length, 0);
    const holdCount = itemHolds.length;
    let status: ItemAvailability["status"];
    if (availableCopies === item.copiesTotal) status = "available";
    else if (availableCopies > 0) status = "limited";
    else if (holdCount > 0) status = "on-hold";
    else status = "unavailable";
    const statusLabel = statusLabelFor(
      status,
      availableCopies,
      item.copiesTotal,
      holdCount,
    );
    return {
      id: item.id,
      title: item.title,
      totalCopies: item.copiesTotal,
      activeLoans: itemLoans.length,
      availableCopies,
      holdsQueued: holdCount,
      loanMembers: itemLoans.map((loan) => loan.memberId),
      holdMembers: itemHolds.map((hold) => hold.memberId),
      nextHold: itemHolds.length > 0 ? itemHolds[0]?.memberId ?? null : null,
      status,
      statusLabel,
    };
  });
};

const recordChange = (
  context: CirculationContext,
  change: Omit<CirculationChange, "sequence">,
) => {
  const current = context.eventSequence.get();
  const base = typeof current === "number" && Number.isFinite(current) &&
      current > 0
    ? current
    : 1;
  context.lastChange.set({ sequence: base, ...change });
  context.eventSequence.set(base + 1);
};

const checkoutItem = handler(
  (
    event: CheckoutEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    const loansList = sanitizeLoanList(catalogList, context.loans.get());
    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    if (
      loansList.some((loan) =>
        loan.itemId === itemId && loan.memberId === memberId
      )
    ) {
      return;
    }

    const activeForItem = loansList.filter((loan) => loan.itemId === itemId);
    if (activeForItem.length >= item.copiesTotal) return;

    const appended = [
      ...loansList,
      { sequence: loansList.length + 1, itemId, memberId },
    ];
    const sanitizedLoans = sanitizeLoanList(catalogList, appended);
    context.loans.set(sanitizedLoans);

    const filteredHolds = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filteredHolds.length !== holdsList.length) {
      context.holds.set(sanitizeHoldList(catalogList, filteredHolds));
    }

    recordChange(context, {
      type: "checkout",
      itemId,
      memberId,
      note: `${memberId} checked out ${item.title}`,
    });
  },
);

const returnItem = handler(
  (
    event: CheckoutEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const requestedMember = sanitizeMemberId(event?.memberId);
    if (!itemId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const sanitizedLoans = sanitizeLoanList(
      catalogList,
      context.loans.get(),
    );
    const sanitizedHolds = sanitizeHoldList(
      catalogList,
      context.holds.get(),
    );

    const loanIndex = sanitizedLoans.findIndex((loan) => {
      if (loan.itemId !== itemId) return false;
      if (!requestedMember) return true;
      return loan.memberId === requestedMember;
    });
    if (loanIndex === -1) return;

    const removedLoan = sanitizedLoans[loanIndex];
    let loansAfter = sanitizeLoanList(
      catalogList,
      sanitizedLoans.filter((_, index) => index !== loanIndex),
    );

    let holdsAfter = sanitizedHolds;
    let promotedNote = "";
    let promotedMember: string | null = null;

    let promotedHold: HoldRecord | null = null;
    const holdRemainder: HoldRecord[] = [];
    for (const hold of holdsAfter) {
      if (!promotedHold && hold.itemId === itemId) {
        promotedHold = hold;
        promotedMember = hold.memberId;
        continue;
      }
      holdRemainder.push(hold);
    }

    if (promotedHold) {
      holdsAfter = sanitizeHoldList(catalogList, holdRemainder);
      loansAfter = sanitizeLoanList(catalogList, [
        ...loansAfter,
        {
          sequence: loansAfter.length + 1,
          itemId: promotedHold.itemId,
          memberId: promotedHold.memberId,
        },
      ]);
      promotedNote = `; promoted hold for ${promotedHold.memberId}`;
    }

    context.loans.set(loansAfter);
    context.holds.set(holdsAfter);

    recordChange(context, {
      type: "return",
      itemId,
      memberId: removedLoan.memberId,
      note: `${removedLoan.memberId} returned ${item.title}${promotedNote}`,
    });

    if (promotedMember) {
      recordChange(context, {
        type: "checkout",
        itemId,
        memberId: promotedMember,
        note: `${promotedMember} checked out ${item.title} via hold`,
      });
    }
  },
);

const placeHold = handler(
  (
    event: HoldEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    if (
      holdsList.some((hold) =>
        hold.itemId === itemId && hold.memberId === memberId
      )
    ) {
      return;
    }

    const appended = [
      ...holdsList,
      { sequence: holdsList.length + 1, itemId, memberId },
    ];
    context.holds.set(sanitizeHoldList(catalogList, appended));

    recordChange(context, {
      type: "hold",
      itemId,
      memberId,
      note: `${memberId} placed hold on ${item.title}`,
    });
  },
);

const cancelHold = handler(
  (
    event: HoldEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    const filtered = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filtered.length === holdsList.length) return;

    context.holds.set(sanitizeHoldList(catalogList, filtered));

    recordChange(context, {
      type: "cancel",
      itemId,
      memberId,
      note: `${memberId} canceled hold on ${item.title}`,
    });
  },
);

// Module-scope lift definitions
const liftSanitizeCatalogList = lift(sanitizeCatalogList);
const liftCloneLoans = lift(cloneLoans);
const liftCloneHolds = lift(cloneHolds);

const liftAvailabilityRaw = lift(
  (
    input: {
      catalog: LibraryItem[];
      loans: LoanRecord[];
      holds: HoldRecord[];
    },
  ) => computeAvailability(input.catalog, input.loans, input.holds),
);

const liftAvailability = lift((entries: ItemAvailability[]) =>
  entries.map((entry) => ({ ...entry }))
);

const liftAvailabilitySignals = lift((entries: ItemAvailability[]) =>
  entries.map((entry) =>
    `${entry.id}|${entry.status}|${entry.availableCopies}|${entry.holdsQueued}`
  )
);

const liftAvailableTitleCount = lift((entries: ItemAvailability[]) =>
  entries.filter((entry) => entry.availableCopies > 0).length
);

const liftTotalTitles = lift((entries: ItemAvailability[]) => entries.length);

const liftActiveLoanCount = lift((entries: LoanRecord[]) => entries.length);

const liftPendingHoldCount = lift((entries: HoldRecord[]) => entries.length);

const liftLoanSummary = lift((count: number) =>
  formatCount(count, "active loan", "active loans")
);

const liftHoldSummary = lift((count: number) =>
  formatCount(count, "hold queued", "holds queued")
);

const liftLastChangeLabel = lift((change: CirculationChange | null) => {
  if (!change) return "No circulation changes yet";
  return `${change.note} (#${change.sequence})`;
});

export const libraryCheckoutSystem = pattern<LibraryCheckoutArgs>(
  ({ catalog }) => {
    const eventSequence = cell(1);
    const lastChange = cell<CirculationChange | null>(null);
    const loanState = cell<LoanRecord[]>(cloneLoans(defaultLoans));
    const holdState = cell<HoldRecord[]>(cloneHolds(defaultHolds));

    const catalogView = liftSanitizeCatalogList(catalog);

    const loanEntries = liftCloneLoans(loanState);
    const holdEntries = liftCloneHolds(holdState);

    const availabilityRaw = liftAvailabilityRaw({
      catalog: catalogView,
      loans: loanState,
      holds: holdState,
    });
    const availability = liftAvailability(availabilityRaw);
    const availabilitySignals = liftAvailabilitySignals(availability);

    const availableTitleCount = liftAvailableTitleCount(availability);
    const totalTitles = liftTotalTitles(availability);
    const activeLoanCount = liftActiveLoanCount(loanEntries);
    const pendingHoldCount = liftPendingHoldCount(holdEntries);

    const loanSummary = liftLoanSummary(activeLoanCount);
    const holdSummary = liftHoldSummary(pendingHoldCount);

    const availabilitySummary =
      str`${availableTitleCount}/${totalTitles} titles open · ${loanSummary} · ${holdSummary}`;

    const lastChangeLabel = liftLastChangeLabel(lastChange);

    const context = {
      catalog,
      loans: loanState,
      holds: holdState,
      eventSequence,
      lastChange,
    };

    return {
      catalog,
      loans: loanState,
      holds: holdState,
      catalogView,
      loanEntries,
      holdEntries,
      availability,
      availableTitleCount,
      activeLoanCount,
      pendingHoldCount,
      availabilitySummary,
      availabilitySignals,
      lastChange,
      lastChangeLabel,
      checkout: checkoutItem(context),
      returnLoan: returnItem(context),
      placeHold: placeHold(context),
      cancelHold: cancelHold(context),
    };
  },
);

export type {
  CirculationChange,
  HoldRecord,
  ItemAvailability,
  LibraryItem,
  LoanRecord,
};

export default libraryCheckoutSystem;
