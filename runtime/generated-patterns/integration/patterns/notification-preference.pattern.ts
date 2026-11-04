import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type ChannelId = "email" | "sms" | "push" | "digest";

type Frequency = "immediate" | "hourly" | "daily" | "weekly";

interface ChannelPreference {
  channel: ChannelId;
  enabled: boolean;
  frequency: Frequency;
}

type ChannelPreferenceInput = Partial<ChannelPreference> & {
  channel?: string;
  frequency?: string;
};

const channelOrder: readonly ChannelId[] = [
  "email",
  "sms",
  "push",
  "digest",
];

const channelLabels: Record<ChannelId, string> = {
  email: "Email",
  sms: "SMS",
  push: "Push",
  digest: "Digest",
};

const frequencyDetails: Record<Frequency, { label: string; window: string }> = {
  immediate: {
    label: "Immediate alerts",
    window: "sent instantly",
  },
  hourly: {
    label: "Hourly updates",
    window: "top of every hour",
  },
  daily: {
    label: "Daily summary",
    window: "08:00 local time",
  },
  weekly: {
    label: "Weekly digest",
    window: "Mondays 09:00",
  },
};

const defaultPreferences: ChannelPreference[] = [
  { channel: "email", enabled: true, frequency: "daily" },
  { channel: "sms", enabled: false, frequency: "weekly" },
  { channel: "push", enabled: true, frequency: "immediate" },
  { channel: "digest", enabled: true, frequency: "daily" },
];

interface NotificationPreferenceArgs {
  channels: Default<ChannelPreferenceInput[], typeof defaultPreferences>;
}

interface ConfigureChannelEvent {
  channel?: string;
  enabled?: boolean;
  frequency?: string;
}

const resolveChannelId = (value: unknown): ChannelId | null => {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return channelOrder.find((channel) => channel === lower) ?? null;
};

const sanitizeFrequency = (
  value: unknown,
  fallback: Frequency,
): Frequency => {
  if (typeof value !== "string") return fallback;
  const lower = value.toLowerCase() as Frequency;
  return lower in frequencyDetails ? lower : fallback;
};

const sanitizePreferenceList = (
  value: readonly ChannelPreferenceInput[] | undefined,
): ChannelPreference[] => {
  const base = new Map<ChannelId, ChannelPreference>();
  for (const entry of defaultPreferences) {
    base.set(entry.channel, { ...entry });
  }

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const channel = resolveChannelId(candidate?.channel);
      if (!channel) continue;
      const previous = base.get(channel) ?? {
        channel,
        enabled: true,
        frequency: "daily" as Frequency,
      };
      const enabled = typeof candidate?.enabled === "boolean"
        ? candidate.enabled
        : previous.enabled;
      const frequency = sanitizeFrequency(
        candidate?.frequency,
        previous.frequency,
      );
      base.set(channel, { channel, enabled, frequency });
    }
  }

  return channelOrder.map((channel) => {
    const preference = base.get(channel);
    return preference ? { ...preference } : {
      channel,
      enabled: false,
      frequency: "daily",
    };
  });
};

const buildScheduleMap = (
  entries: readonly ChannelPreference[],
): Record<ChannelId, string> => {
  const result = {} as Record<ChannelId, string>;
  for (const preference of entries) {
    if (!preference.enabled) {
      result[preference.channel] = "paused";
      continue;
    }
    const detail = frequencyDetails[preference.frequency];
    result[preference.channel] = `${detail.label} (${detail.window})`;
  }
  return result;
};

const formatActiveSummary = (
  entries: readonly ChannelPreference[],
): string => {
  const active = entries.filter((entry) => entry.enabled);
  if (active.length === 0) return "No active channels";
  const pieces = active.map((entry) => {
    const label = channelLabels[entry.channel];
    const detail = frequencyDetails[entry.frequency];
    return `${label} ${detail.label.toLowerCase()}`;
  });
  const noun = active.length === 1 ? "channel" : "channels";
  return `${active.length} active ${noun}: ${pieces.join(", ")}`;
};

const configureChannel = handler(
  (
    event: ConfigureChannelEvent | undefined,
    context: {
      channels: Cell<ChannelPreferenceInput[]>;
      lastChange: Cell<string>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const channel = resolveChannelId(event?.channel);
    if (!channel) return;

    const current = sanitizePreferenceList(context.channels.get());
    const existing = current.find((entry) => entry.channel === channel);
    if (!existing) return;

    const enabled = typeof event?.enabled === "boolean"
      ? event.enabled
      : existing.enabled;
    const frequency = sanitizeFrequency(event?.frequency, existing.frequency);

    const updated = current.map((entry) =>
      entry.channel === channel ? { channel, enabled, frequency } : entry
    );
    context.channels.set(updated);

    const detail = frequencyDetails[frequency];
    const summary = enabled
      ? `${channelLabels[channel]} ${detail.label} (${detail.window})`
      : `${channelLabels[channel]} paused`;
    context.lastChange.set(summary);

    const previous = context.history.get() ?? [];
    const appended = [...previous, summary];
    const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
    context.history.set(trimmed);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

// Module-scope lift definitions
const liftSanitizePreferenceList = lift(sanitizePreferenceList);
const liftBuildScheduleMap = lift(buildScheduleMap);
const liftFormatActiveSummary = lift(formatActiveSummary);
const liftActiveCount = lift((entries: readonly ChannelPreference[]) =>
  entries.filter((entry) => entry.enabled).length
);

export const notificationPreferences = pattern<NotificationPreferenceArgs>(
  ({ channels }) => {
    const lastChange = cell("Preferences loaded");
    const history = cell<string[]>(["Preferences loaded"]);
    const sequence = cell(0);

    const channelList = liftSanitizePreferenceList(channels);
    const scheduleMap = liftBuildScheduleMap(channelList);

    const summaryBase = liftFormatActiveSummary(channelList);
    const scheduleSummary = str`Notification schedules — ${summaryBase}`;

    const activeCount = liftActiveCount(channelList);

    return {
      channels,
      channelList,
      scheduleMap,
      scheduleSummary,
      activeCount,
      lastChange,
      history,
      configureChannel: configureChannel({
        channels,
        lastChange,
        history,
        sequence,
      }),
    };
  },
);

export default notificationPreferences;
