import {
  type Cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

export interface ReactionMessageInput {
  id?: string;
  content?: string;
  reactions?: Record<string, number>;
}

interface ReactionEvent {
  messageId?: string;
  reaction?: string;
  delta?: number;
}

export interface NormalizedMessage {
  id: string;
  content: string;
  reactions: Record<string, number>;
}

export interface ReactionCountEntry {
  reaction: string;
  count: number;
}

export interface MessageReactionView {
  id: string;
  content: string;
  reactions: ReactionCountEntry[];
}

export interface MessageTotalEntry {
  id: string;
  content: string;
  total: number;
}

export interface ReactionTotalEntry {
  reaction: string;
  count: number;
}

export interface ReactionMatrixRow {
  messageId: string;
  reaction: string;
  count: number;
}

export interface ChatReactionTrackerArgs {
  messages: Default<ReactionMessageInput[], []>;
  reactionCatalog: Default<string[], []>;
}

const normalizeMessageId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeReactionKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : undefined;
};

const sanitizeReactionCatalog = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const reaction = normalizeReactionKey(entry);
    if (!reaction || seen.has(reaction)) continue;
    seen.add(reaction);
  }
  return [...seen].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
};

const sanitizeReactionCounts = (
  value: unknown,
  catalog: readonly string[],
): Record<string, number> => {
  const map = new Map<string, number>();
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [rawKey, rawValue] of entries) {
      const reaction = normalizeReactionKey(rawKey);
      const count = toNonNegativeInteger(rawValue);
      if (!reaction || count === undefined) continue;
      map.set(reaction, count);
    }
  }

  for (const reaction of catalog) {
    if (!map.has(reaction)) {
      map.set(reaction, 0);
    }
  }

  const normalized = [...map.entries()].sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  const result: Record<string, number> = {};
  for (const [reaction, count] of normalized) {
    result[reaction] = count;
  }
  return result;
};

const sanitizeMessageContent = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeMessages = (
  value: unknown,
  catalog: readonly string[],
): NormalizedMessage[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const sanitized: NormalizedMessage[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const base = entry as ReactionMessageInput;
    const id = normalizeMessageId(base.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const content = sanitizeMessageContent(base.content, id);
    const reactions = sanitizeReactionCounts(base.reactions, catalog);
    sanitized.push({ id, content, reactions });
  }

  sanitized.sort((a, b) => a.id.localeCompare(b.id));
  return sanitized;
};

const cloneNormalizedMessage = (
  message: NormalizedMessage,
): ReactionMessageInput => ({
  id: message.id,
  content: message.content,
  reactions: { ...message.reactions },
});

const sumReactions = (counts: Record<string, number>): number => {
  let total = 0;
  for (const value of Object.values(counts)) {
    total += value;
  }
  return total;
};

const sanitizeDelta = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const integer = Math.trunc(value);
  return integer === 0 ? 0 : integer;
};

const recordMessageReaction = handler(
  (
    event: ReactionEvent | undefined,
    context: {
      messages: Cell<ReactionMessageInput[]>;
      reactionCatalog: Cell<string[]>;
    },
  ) => {
    const messageId = normalizeMessageId(event?.messageId);
    const reactionKey = normalizeReactionKey(event?.reaction);
    const delta = sanitizeDelta(event?.delta);

    if (!messageId || !reactionKey || delta === 0) {
      return;
    }

    const baseCatalog = sanitizeReactionCatalog(
      context.reactionCatalog.get(),
    );
    const nextCatalog = sanitizeReactionCatalog([
      ...baseCatalog,
      reactionKey,
    ]);
    context.reactionCatalog.set([...nextCatalog]);

    const currentMessages = sanitizeMessages(
      context.messages.get(),
      nextCatalog,
    );
    const index = currentMessages.findIndex((item) => item.id === messageId);
    if (index === -1) return;

    const target = currentMessages[index];
    const currentCount = target.reactions[reactionKey] ?? 0;
    const updatedCount = currentCount + delta;
    const nextCount = updatedCount < 0 ? 0 : updatedCount;

    const updatedMessages = currentMessages.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const reactions = sanitizeReactionCounts(
        { ...item.reactions, [reactionKey]: nextCount },
        nextCatalog,
      );
      return { ...item, reactions };
    });

    context.messages.set(
      updatedMessages.map((message) => cloneNormalizedMessage(message)),
    );
  },
);

const liftNormalizedMessages = lift(
  (input: {
    list: ReactionMessageInput[] | undefined;
    catalog: string[];
  }) => sanitizeMessages(input.list, input.catalog),
);

const liftMessagesView = lift((entries: NormalizedMessage[]) =>
  entries.map((message) => {
    const reactions = Object.entries(message.reactions)
      .map(([reaction, count]) => ({ reaction, count }))
      .sort((a, b) => {
        if (a.reaction < b.reaction) return -1;
        if (a.reaction > b.reaction) return 1;
        return 0;
      });
    return { id: message.id, content: message.content, reactions };
  })
);

const liftMessageTotals = lift((entries: NormalizedMessage[]) =>
  entries.map((message) => ({
    id: message.id,
    content: message.content,
    total: sumReactions(message.reactions),
  }))
);

const liftReactionTotals = lift((entries: NormalizedMessage[]) => {
  const totals = new Map<string, number>();
  for (const message of entries) {
    for (const [reaction, count] of Object.entries(message.reactions)) {
      totals.set(reaction, (totals.get(reaction) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    })
    .map(([reaction, count]) => ({ reaction, count }));
});

const liftMessageCount = lift(
  (entries: NormalizedMessage[]) => entries.length,
);

const liftTotalReactions = lift((entries: ReactionTotalEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.count, 0)
);

const liftSanitizeReactionCatalog = lift(sanitizeReactionCatalog);

export const chatReactionTracker = pattern<ChatReactionTrackerArgs>(
  ({ messages, reactionCatalog }) => {
    const catalogView = liftSanitizeReactionCatalog(reactionCatalog);

    const normalizedMessages = liftNormalizedMessages({
      list: messages,
      catalog: catalogView,
    });

    const messagesView = liftMessagesView(normalizedMessages);

    const messageTotals = liftMessageTotals(normalizedMessages);

    const reactionTotals = liftReactionTotals(normalizedMessages);

    const reactionMatrix = computed(() => {
      const rows: ReactionMatrixRow[] = [];
      for (const message of normalizedMessages) {
        const reactions = Object.entries(message.reactions).sort((a, b) => {
          if (a[0] < b[0]) return -1;
          if (a[0] > b[0]) return 1;
          return 0;
        });
        for (const [reaction, count] of reactions) {
          rows.push({ messageId: message.id, reaction, count });
        }
      }
      return rows;
    });

    const messageCount = liftMessageCount(normalizedMessages);

    const totalReactions = liftTotalReactions(reactionTotals);

    const summary = str`${totalReactions} reactions across ${messageCount} \
messages`;

    return {
      messages: messagesView,
      reactionCatalog: catalogView,
      messageTotals,
      reactionTotals,
      reactionMatrix,
      messageCount,
      totalReactions,
      summary,
      recordReaction: recordMessageReaction({ messages, reactionCatalog }),
    };
  },
);

export default chatReactionTracker;
