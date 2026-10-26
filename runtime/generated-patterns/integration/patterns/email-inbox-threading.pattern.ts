import {
  Cell,
  cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  timestamp: number;
  snippet: string;
}

type EmailEvent = Partial<EmailMessage>;

interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  latestTimestamp: number;
  messageCount: number;
  senders: string[];
  messages: EmailMessage[];
}

interface EmailInboxArgs {
  messages: Default<EmailMessage[], []>;
  activeThreadId: Default<string | null, null>;
}

function normalizeMessage(
  input: EmailEvent,
  fallbackIndex: number,
): EmailMessage {
  const threadId =
    typeof input.threadId === "string" && input.threadId.length > 0
      ? input.threadId
      : `thread-${fallbackIndex}`;
  const timestamp = typeof input.timestamp === "number"
    ? input.timestamp
    : fallbackIndex;
  const subject = typeof input.subject === "string" && input.subject.length > 0
    ? input.subject
    : `Conversation ${threadId}`;
  const sender = typeof input.sender === "string" && input.sender.length > 0
    ? input.sender
    : "unknown";
  const snippet = typeof input.snippet === "string" ? input.snippet : "";
  const id = typeof input.id === "string" && input.id.length > 0
    ? input.id
    : `message-${fallbackIndex}`;

  return {
    id,
    threadId,
    subject,
    sender,
    timestamp,
    snippet,
  };
}

const receiveEmail = handler(
  (
    event: EmailEvent | undefined,
    context: {
      messages: Cell<EmailMessage[]>;
      threadActivity: Cell<string[]>;
      activeThreadId: Cell<string | null>;
    },
  ) => {
    const existing = context.messages.get();
    const currentMessages = Array.isArray(existing) ? existing : [];
    const index = currentMessages.length + 1;
    const message = normalizeMessage(event ?? {}, index);
    const nextMessages = [...currentMessages, message];
    context.messages.set(nextMessages);

    const activity = context.threadActivity.get();
    const currentActivity = Array.isArray(activity) ? activity : [];
    context.threadActivity.set([
      ...currentActivity,
      `${message.threadId}:${message.timestamp}`,
    ]);

    const active = context.activeThreadId.get();
    if (typeof active !== "string" || active.length === 0) {
      context.activeThreadId.set(message.threadId);
      return;
    }

    const latestForActive = nextMessages.reduce(
      (max, entry) =>
        entry.threadId === active ? Math.max(max, entry.timestamp) : max,
      Number.NEGATIVE_INFINITY,
    );
    if (message.timestamp >= latestForActive) {
      context.activeThreadId.set(message.threadId);
    }
  },
);

const liftSanitizedMessages = lift(
  (value: EmailMessage[] | undefined): EmailMessage[] => {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => normalizeMessage(item, index + 1));
  },
);

const liftThreadCount = lift((items: ThreadSummary[]) => items.length);

const liftTopThreadLabel = lift(
  (thread: ThreadSummary | null): string => {
    if (!thread) return "Inbox empty";
    return `${thread.subject} (${thread.messageCount})`;
  },
);

const liftActiveThreadView = lift(
  (value: string | null | undefined): string | null =>
    typeof value === "string" && value.length > 0 ? value : null,
);

const liftActiveThreadSummary = lift(
  (
    input: { threads: ThreadSummary[]; active: string | null },
  ): ThreadSummary | null => {
    if (!input.active) return null;
    return input.threads.find((item) => item.threadId === input.active) ??
      null;
  },
);

export const emailInboxThreading = pattern<EmailInboxArgs>(
  ({ messages, activeThreadId }) => {
    const threadActivity = cell<string[]>([]);

    const sanitizedMessages = liftSanitizedMessages(messages);

    const threads = computed((): ThreadSummary[] => {
      const collection = sanitizedMessages;
      const groups = new Map<string, ThreadSummary>();
      for (const entry of collection) {
        const existing = groups.get(entry.threadId);
        if (existing) {
          const updatedMessages = [...existing.messages, entry];
          const latestTimestamp = entry.timestamp > existing.latestTimestamp
            ? entry.timestamp
            : existing.latestTimestamp;
          groups.set(entry.threadId, {
            threadId: entry.threadId,
            subject: entry.timestamp >= existing.latestTimestamp
              ? entry.subject
              : existing.subject,
            snippet: entry.timestamp >= existing.latestTimestamp
              ? entry.snippet
              : existing.snippet,
            latestTimestamp,
            messageCount: updatedMessages.length,
            senders: Array.from(new Set([...existing.senders, entry.sender])),
            messages: updatedMessages.sort(
              (a, b) => a.timestamp - b.timestamp,
            ),
          });
        } else {
          groups.set(entry.threadId, {
            threadId: entry.threadId,
            subject: entry.subject,
            snippet: entry.snippet,
            latestTimestamp: entry.timestamp,
            messageCount: 1,
            senders: [entry.sender],
            messages: [entry],
          });
        }
      }

      return Array.from(groups.values()).sort(
        (a, b) => b.latestTimestamp - a.latestTimestamp,
      );
    });

    const threadCount = liftThreadCount(threads);
    const orderedThreadIds = computed(() =>
      threads.map((item) => item.threadId)
    );
    const topThread = computed(() => threads.length > 0 ? threads[0] : null);
    const topThreadLabel = liftTopThreadLabel(topThread);
    const activeThreadView = liftActiveThreadView(activeThreadId);
    const activeThreadSummary = liftActiveThreadSummary({
      threads,
      active: activeThreadView,
    });

    return {
      messages,
      sanitizedMessages,
      threads,
      orderedThreadIds,
      threadCount,
      topThread,
      topThreadLabel,
      activeThreadId,
      activeThreadView,
      activeThreadSummary,
      threadActivity,
      summary: str`${threadCount} threads`,
      topThreadStatus: str`Top thread: ${topThreadLabel}`,
      receive: receiveEmail({
        messages,
        threadActivity,
        activeThreadId,
      }),
    };
  },
);

export default emailInboxThreading;
