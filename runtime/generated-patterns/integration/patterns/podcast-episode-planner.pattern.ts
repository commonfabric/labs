import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface EpisodeSegmentInput {
  id?: string;
  title?: string;
  duration?: number;
}

interface EpisodeSegment {
  id: string;
  title: string;
  duration: number;
}

interface PodcastEpisodePlannerArgs {
  segments: Default<EpisodeSegmentInput[], typeof defaultSegments>;
}

interface OutlineEntry extends EpisodeSegment {
  startMinute: number;
  endMinute: number;
  label: string;
}

const defaultSegments: EpisodeSegment[] = [
  { id: "intro", title: "Intro", duration: 2 },
  { id: "interview", title: "Interview", duration: 25 },
  { id: "outro", title: "Outro", duration: 3 },
];

const sanitizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "");
};

const slugFromTitle = (title: string): string => {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return normalized.length > 0 ? normalized : "segment";
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded > 0 ? rounded : 1;
  }
  return 5;
};

const sanitizeSegments = (
  input: readonly EpisodeSegmentInput[] | undefined,
): EpisodeSegment[] => {
  const base = Array.isArray(input) && input.length > 0
    ? input
    : defaultSegments;
  const seen = new Set<string>();
  const sanitized: EpisodeSegment[] = [];
  let index = 0;
  for (const entry of base) {
    const fallbackTitle = `Segment ${index + 1}`;
    const rawTitle = (entry as EpisodeSegmentInput)?.title;
    const title = sanitizeTitle(rawTitle, fallbackTitle);
    const rawId = (entry as EpisodeSegmentInput)?.id;
    const candidate = sanitizeId(rawId) ?? slugFromTitle(title);
    const baseId = candidate.length > 0 ? candidate : `segment-${index + 1}`;
    let id = baseId;
    let suffix = 1;
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    const rawDuration = (entry as EpisodeSegmentInput)?.duration;
    const duration = sanitizeDuration(rawDuration);
    sanitized.push({ id, title, duration });
    index += 1;
  }
  if (sanitized.length === 0) {
    return defaultSegments.map((segment) => ({ ...segment }));
  }
  return sanitized;
};

const ensureSegments = (
  segments: Cell<EpisodeSegmentInput[]>,
): EpisodeSegment[] => {
  const raw = segments.get();
  const sanitized = sanitizeSegments(raw);
  if (
    !Array.isArray(raw) ||
    raw.length !== sanitized.length ||
    sanitized.some((segment, idx) => {
      const current = raw?.[idx] as EpisodeSegmentInput | undefined;
      if (!current) return true;
      const normalizedTitle = sanitizeTitle(current.title, segment.title);
      const normalizedDuration = sanitizeDuration(current.duration);
      return current.id !== segment.id ||
        normalizedTitle !== segment.title ||
        normalizedDuration !== segment.duration;
    })
  ) {
    segments.set(sanitized.map((segment) => ({ ...segment })));
  }
  return sanitized;
};

const clampIndex = (value: unknown, length: number): number => {
  if (length <= 1) return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    const index = Math.trunc(value);
    if (index < 0) return 0;
    if (index >= length) return length - 1;
    return index;
  }
  return 0;
};

const updateSegmentDetails = handler(
  (
    event:
      | { id?: string; title?: string; duration?: number }
      | undefined,
    context: { segments: Cell<EpisodeSegmentInput[]> },
  ) => {
    if (!event) return;
    const segments = ensureSegments(context.segments);
    const identifier = sanitizeId(event.id);
    if (!identifier) return;
    const index = segments.findIndex((segment) => segment.id === identifier);
    if (index < 0) return;
    const current = segments[index];
    const hasTitleUpdate = Object.prototype.hasOwnProperty.call(event, "title");
    const hasDurationUpdate = Object.prototype.hasOwnProperty.call(
      event,
      "duration",
    );
    const nextTitle = hasTitleUpdate
      ? sanitizeTitle(event.title, current.title)
      : current.title;
    const nextDuration = hasDurationUpdate
      ? sanitizeDuration(event.duration)
      : current.duration;
    if (nextTitle === current.title && nextDuration === current.duration) {
      return;
    }
    const next = segments.slice();
    next[index] = { ...current, title: nextTitle, duration: nextDuration };
    context.segments.set(next);
  },
);

const reorderSegments = handler(
  (
    event: { from?: number; to?: number } | undefined,
    context: { segments: Cell<EpisodeSegmentInput[]> },
  ) => {
    const segments = ensureSegments(context.segments);
    if (segments.length < 2) return;
    const fromIndex = clampIndex(event?.from, segments.length);
    const toIndex = clampIndex(event?.to, segments.length);
    if (fromIndex === toIndex) return;
    const next = segments.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    context.segments.set(next);
  },
);

const buildTimeline = (segments: readonly EpisodeSegment[]): OutlineEntry[] => {
  const entries: OutlineEntry[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const startMinute = cursor;
    const endMinute = cursor + segment.duration;
    entries.push({
      ...segment,
      startMinute,
      endMinute,
      label:
        `${segment.title} (${segment.duration}m) @${startMinute}-${endMinute}`,
    });
    cursor = endMinute;
  }
  return entries;
};

// Module-scope lift definitions
const liftSanitizeSegments = lift(
  (value: EpisodeSegmentInput[] | undefined): EpisodeSegment[] =>
    sanitizeSegments(value),
);

const liftBuildTimeline = lift(
  (entries: EpisodeSegment[] | undefined): OutlineEntry[] =>
    buildTimeline(Array.isArray(entries) ? entries : []),
);

const liftOutlineLabel = lift(
  (entries: OutlineEntry[] | undefined): string => {
    if (!entries || entries.length === 0) return "(empty outline)";
    return entries.map((entry) => entry.label).join(" -> ");
  },
);

const liftTotalMinutes = lift(
  (entries: OutlineEntry[] | undefined): number => {
    if (!entries || entries.length === 0) return 0;
    return entries[entries.length - 1].endMinute;
  },
);

/** Pattern orchestrating podcast episode segments into a timed outline. */
export const podcastEpisodePlanner = pattern<PodcastEpisodePlannerArgs>(
  ({ segments }) => {
    const segmentsView = liftSanitizeSegments(segments);

    const timeline = liftBuildTimeline(segmentsView);

    const outline = liftOutlineLabel(timeline);

    const totalMinutes = liftTotalMinutes(timeline);

    return {
      segments,
      segmentsView,
      timeline,
      outline,
      totalMinutes,
      label: str`Episode Outline: ${outline}`,
      reorderSegments: reorderSegments({ segments }),
      updateSegment: updateSegmentDetails({ segments }),
    };
  },
);

export default podcastEpisodePlanner;
