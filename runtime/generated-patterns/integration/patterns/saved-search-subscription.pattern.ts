import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type Frequency = "daily" | "weekly" | "monthly";

interface SavedSearchInput {
  id?: string;
  name?: string;
  query?: string;
  frequency?: string;
  channels?: string[];
}

interface SavedSearchSubscription {
  id: string;
  name: string;
  query: string;
  frequency: Frequency;
  channels: string[];
}

interface SavedSearchArgs {
  savedSubscriptions: Default<
    SavedSearchInput[],
    typeof defaultSavedSubscriptions
  >;
}

interface SavedSubscriptionEvent {
  id?: string;
  name?: string;
  query?: string;
  frequency?: string;
  channels?: string[];
}

interface TriggerSubscriptionEvent {
  id?: string;
}

const defaultFrequency: Frequency = "weekly";
const defaultChannels = ["email"] as const;
const defaultSubscriptionName = "Saved Search";
const defaultSubscriptionQuery = "all results";

const allowedFrequencies: ReadonlySet<Frequency> = new Set([
  "daily",
  "weekly",
  "monthly",
]);

const channelOrder = new Map<string, number>([
  ["email", 0],
  ["push", 1],
  ["sms", 2],
  ["digest", 3],
]);

const defaultSavedSubscriptions: SavedSearchInput[] = [
  {
    id: "remote-design-weekly",
    name: "Remote Design Roles",
    query: "designer remote",
    frequency: "weekly",
    channels: ["email", "push"],
  },
  {
    id: "analytics-alerts-daily",
    name: "Analytics Alerts",
    query: "analytics engineer",
    frequency: "daily",
    channels: ["email"],
  },
];

const titleCase = (value: string): string => {
  return value.split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const lower = segment.toLowerCase();
      const head = lower.charAt(0).toUpperCase();
      return `${head}${lower.slice(1)}`;
    })
    .join(" ");
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return titleCase(trimmed);
    }
  }
  return titleCase(fallback);
};

const sanitizeQuery = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeFrequency = (
  value: unknown,
  fallback: Frequency,
): Frequency => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (allowedFrequencies.has(normalized as Frequency)) {
      return normalized as Frequency;
    }
  }
  return fallback;
};

const sanitizeChannels = (
  value: unknown,
  fallback: readonly string[],
): string[] => {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (!channelOrder.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    sanitized.push(normalized);
  }
  if (sanitized.length === 0) {
    return fallback.map((channel) => channel.toLowerCase());
  }
  sanitized.sort((left, right) => {
    const leftRank = channelOrder.get(left) ?? 99;
    const rightRank = channelOrder.get(right) ?? 99;
    return leftRank - rightRank;
  });
  return sanitized;
};

const slugify = (value: string): string => {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").replace(/-+$/, "");
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  const base = candidate.length > 0 ? candidate : "saved-search";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${base}-${suffix}`;
  used.add(unique);
  return unique;
};

const createSubscription = (
  raw: SavedSearchInput | SavedSubscriptionEvent | undefined,
  fallback: SavedSearchInput,
  used: Set<string>,
): SavedSearchSubscription => {
  const fallbackName = sanitizeName(
    fallback?.name,
    defaultSubscriptionName,
  );
  const fallbackQuery = sanitizeQuery(
    fallback?.query,
    defaultSubscriptionQuery,
  );
  const fallbackFrequency = sanitizeFrequency(
    fallback?.frequency,
    defaultFrequency,
  );
  const fallbackChannels = sanitizeChannels(
    fallback?.channels,
    defaultChannels,
  );

  const name = sanitizeName(raw?.name, fallbackName);
  const query = sanitizeQuery(raw?.query, fallbackQuery);
  const frequency = sanitizeFrequency(raw?.frequency, fallbackFrequency);
  const channels = sanitizeChannels(raw?.channels, fallbackChannels);

  const idSource = typeof raw?.id === "string"
    ? raw.id
    : `${name}-${frequency}`;
  const id = ensureUniqueId(slugify(idSource), used);

  return { id, name, query, frequency, channels };
};

const sanitizeSubscriptions = (
  value: unknown,
): SavedSearchSubscription[] => {
  const entries = Array.isArray(value) && value.length > 0
    ? (value as SavedSearchInput[])
    : defaultSavedSubscriptions;
  const used = new Set<string>();
  const sanitized: SavedSearchSubscription[] = [];
  for (let index = 0; index < entries.length; index++) {
    const fallback = defaultSavedSubscriptions[
      index % defaultSavedSubscriptions.length
    ];
    const subscription = createSubscription(entries[index], fallback, used);
    sanitized.push(subscription);
  }
  if (sanitized.length === 0) {
    sanitized.push(
      createSubscription(undefined, defaultSavedSubscriptions[0], used),
    );
  }
  return sanitized;
};

const toStringList = (value: unknown): string[] => {
  return Array.isArray(value) ? (value as string[]) : [];
};

const formatChannels = (channels: readonly string[]): string => {
  return channels.map((channel) => titleCase(channel)).join(", ");
};

const summarizeSubscription = (
  subscription: SavedSearchSubscription,
): string => {
  const channelLabel = formatChannels(subscription.channels);
  return `${subscription.name} • ${subscription.frequency} • ${channelLabel}` +
    ` • "${subscription.query}"`;
};

const describeSaveAction = (
  subscription: SavedSearchSubscription,
): string => {
  const channelLabel = formatChannels(subscription.channels);
  return `Saved ${subscription.name} (${subscription.frequency}) via ` +
    `${channelLabel} for "${subscription.query}"`;
};

const describeTriggerAction = (
  subscription: SavedSearchSubscription,
): string => {
  const channelLabel = formatChannels(subscription.channels);
  return `Triggered ${subscription.name} (${subscription.frequency}) ` +
    `via ${channelLabel} for "${subscription.query}"`;
};

const addSubscription = handler(
  (
    event: SavedSubscriptionEvent | undefined,
    context: {
      savedSubscriptions: Cell<SavedSearchInput[]>;
      savedLog: Cell<string[]>;
    },
  ) => {
    if (!event) return;
    const rawValue = context.savedSubscriptions.get();
    const current = sanitizeSubscriptions(rawValue);
    const used = new Set(current.map((entry) => entry.id));
    const fallback = defaultSavedSubscriptions[
      current.length % defaultSavedSubscriptions.length
    ];
    const nextSubscription = createSubscription(event, fallback, used);
    const updated = [...current, nextSubscription];
    context.savedSubscriptions.set(updated.map((entry) => ({
      id: entry.id,
      name: entry.name,
      query: entry.query,
      frequency: entry.frequency,
      channels: entry.channels,
    })));

    const savedEntries = toStringList(context.savedLog.get());
    context.savedLog.set([
      ...savedEntries,
      describeSaveAction(nextSubscription),
    ]);
  },
);

const triggerAllSubscriptions = handler(
  (
    _event: unknown,
    context: {
      savedSubscriptions: Cell<SavedSearchInput[]>;
      triggerLog: Cell<string[]>;
    },
  ) => {
    const subscriptions = sanitizeSubscriptions(
      context.savedSubscriptions.get(),
    );
    if (subscriptions.length === 0) return;
    const existing = toStringList(context.triggerLog.get());
    const updates = subscriptions.map(describeTriggerAction);
    context.triggerLog.set([...existing, ...updates]);
  },
);

const triggerSubscription = handler(
  (
    event: TriggerSubscriptionEvent | undefined,
    context: {
      savedSubscriptions: Cell<SavedSearchInput[]>;
      triggerLog: Cell<string[]>;
    },
  ) => {
    if (!event?.id) return;
    const normalized = slugify(event.id);
    if (normalized.length === 0) return;
    const subscriptions = sanitizeSubscriptions(
      context.savedSubscriptions.get(),
    );
    const target = subscriptions.find((entry) =>
      entry.id === normalized || slugify(entry.name) === normalized
    );
    if (!target) return;
    const existing = toStringList(context.triggerLog.get());
    context.triggerLog.set([
      ...existing,
      describeTriggerAction(target),
    ]);
  },
);

// Module-scope lift definitions
const liftSanitizeSubscriptions = lift(sanitizeSubscriptions);
const liftTotalSubscriptions = lift((list: SavedSearchSubscription[]) =>
  list.length
);
const liftSubscriptionSummaries = lift((list: SavedSearchSubscription[]) =>
  list.map(summarizeSubscription)
);
const liftPersistedQueries = lift((list: SavedSearchSubscription[]) =>
  list.map((entry) => entry.query)
);
const liftLatestTrigger = lift((entries: string[]) => {
  if (entries.length === 0) return "No triggers yet";
  return entries[entries.length - 1];
});

export const savedSearchSubscription = pattern<SavedSearchArgs>(
  ({ savedSubscriptions }) => {
    const savedLog = cell<string[]>([]);
    const triggerLog = cell<string[]>([]);

    const sanitizedSubscriptions = liftSanitizeSubscriptions(
      savedSubscriptions,
    );
    const totalSubscriptions = liftTotalSubscriptions(sanitizedSubscriptions);
    const subscriptionSummaries = liftSubscriptionSummaries(
      sanitizedSubscriptions,
    );
    const persistedQueries = liftPersistedQueries(sanitizedSubscriptions);
    const latestTrigger = liftLatestTrigger(triggerLog);

    const statusLabel = str`${totalSubscriptions} saved searches active`;

    return {
      subscriptions: sanitizedSubscriptions,
      views: {
        total: totalSubscriptions,
        summaries: subscriptionSummaries,
        queries: persistedQueries,
        latestTrigger,
        status: statusLabel,
      },
      logs: {
        saved: savedLog,
        triggers: triggerLog,
      },
      controls: {
        addSubscription: addSubscription({
          savedSubscriptions,
          savedLog,
        }),
        triggerAll: triggerAllSubscriptions({
          savedSubscriptions,
          triggerLog,
        }),
        triggerSubscription: triggerSubscription({
          savedSubscriptions,
          triggerLog,
        }),
      },
    };
  },
);

export default savedSearchSubscription;
