import {
  type Cell,
  Default,
  handler,
  lift,
  pattern,
  str,
  type Writable,
} from "commonfabric";

type CitationStyle = "APA" | "MLA" | "Chicago";

interface CitationInput {
  id?: string;
  title?: string;
  authors?: string[];
  topic?: string;
  year?: number;
  style?: CitationStyle | string;
  summary?: string;
}

interface CitationRecord {
  id: string;
  title: string;
  authors: string[];
  topic: string;
  year: number;
  style: CitationStyle;
  summary: string;
}

interface CitationArgs {
  citations: Default<CitationInput[], []>;
  style: Default<CitationStyle | string, "APA">;
}

interface BibliographyGroups {
  byTopic: Record<string, CitationRecord[]>;
  byStyle: Record<string, CitationRecord[]>;
}

interface BibliographySnapshot {
  total: number;
  topics: number;
  styles: number;
  activeStyle: CitationStyle;
  activeBibliography: string[];
  headline: string;
}

interface AddCitationEvent {
  id?: string;
  title?: string;
  authors?: string[];
  topic?: string;
  year?: number;
  style?: CitationStyle | string;
  summary?: string;
}

interface RetagCitationEvent {
  id?: string;
  topic?: string;
  style?: CitationStyle | string;
}

const allowedStyles: readonly CitationStyle[] = [
  "APA",
  "MLA",
  "Chicago",
];

const styleOrder = new Map<CitationStyle, number>([
  ["APA", 0],
  ["MLA", 1],
  ["Chicago", 2],
]);

const normalizeStyle = (
  value: unknown,
  fallback: CitationStyle,
): CitationStyle => {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  const style = allowedStyles.find((entry) => entry.toUpperCase() === upper);
  return style ?? fallback;
};

const normalizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const topicLabel = (index: number): string => `Topic ${index}`;

const normalizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const normalizeAuthors = (value: unknown): string[] => {
  if (!Array.isArray(value)) return ["Unknown Author"];
  const authors = value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
  return authors.length > 0 ? authors : ["Unknown Author"];
};

const normalizeYear = (value: unknown, fallbackIndex: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 2000 + fallbackIndex;
  }
  return Math.trunc(value);
};

const generateId = (
  desired: string,
  existing: ReadonlySet<string>,
): string => {
  if (!existing.has(desired)) return desired;
  let suffix = 2;
  while (existing.has(`${desired}-${suffix}`)) {
    suffix++;
  }
  return `${desired}-${suffix}`;
};

const formatSummary = (citation: CitationRecord): string => {
  const authors = citation.authors.join(", ");
  return `${authors} (${citation.year}). ${citation.title}.`;
};

const sanitizeCitation = (
  input: CitationInput,
  fallbackIndex: number,
  fallbackStyle: CitationStyle,
  existing: ReadonlySet<string>,
): CitationRecord => {
  const baseId = normalizeText(
    typeof input?.id === "string" ? input.id : "",
    `citation-${fallbackIndex}`,
  );
  const id = generateId(baseId, existing);
  const title = normalizeText(input?.title, `Untitled ${fallbackIndex}`);
  const authors = normalizeAuthors(input?.authors);
  const topic = normalizeTopic(input?.topic, topicLabel(fallbackIndex));
  const year = normalizeYear(input?.year, fallbackIndex);
  const style = normalizeStyle(input?.style, fallbackStyle);
  const summary = normalizeText(
    input?.summary,
    formatSummary({
      id,
      title,
      authors,
      topic,
      year,
      style,
      summary: "",
    }),
  );

  return { id, title, authors, topic, year, style, summary };
};

const sanitizeCitations = (
  value: readonly CitationInput[] | undefined,
  fallbackStyle: CitationStyle,
): CitationRecord[] => {
  if (!Array.isArray(value)) return [];
  const result: CitationRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] ?? {};
    const record = sanitizeCitation(entry, index + 1, fallbackStyle, seen);
    seen.add(record.id);
    result.push(record);
  }
  return result;
};

const copyCitation = (citation: CitationRecord): CitationRecord => ({
  id: citation.id,
  title: citation.title,
  authors: [...citation.authors],
  topic: citation.topic,
  year: citation.year,
  style: citation.style,
  summary: citation.summary,
});

const sortCitations = (entries: CitationRecord[]): CitationRecord[] => {
  return [...entries].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const topicCompare = a.topic.localeCompare(b.topic);
    if (topicCompare !== 0) return topicCompare;
    return a.title.localeCompare(b.title);
  });
};

const buildGroups = (
  entries: readonly CitationRecord[],
): BibliographyGroups => {
  const byTopic = new Map<string, CitationRecord[]>();
  const byStyle = new Map<string, CitationRecord[]>();

  for (const entry of entries) {
    const topicGroup = byTopic.get(entry.topic) ?? [];
    topicGroup.push(copyCitation(entry));
    byTopic.set(entry.topic, topicGroup);

    const styleGroup = byStyle.get(entry.style) ?? [];
    styleGroup.push(copyCitation(entry));
    byStyle.set(entry.style, styleGroup);
  }

  const topicResult: Record<string, CitationRecord[]> = {};
  const sortedTopics = Array.from(byTopic.keys()).sort((lhs, rhs) =>
    lhs.localeCompare(rhs)
  );
  for (const topic of sortedTopics) {
    topicResult[topic] = sortCitations(byTopic.get(topic) ?? []);
  }

  const styleResult: Record<string, CitationRecord[]> = {};
  const sortedStyles = Array.from(byStyle.keys()).sort((lhs, rhs) => {
    const leftOrder = styleOrder.get(lhs as CitationStyle) ??
      Number.MAX_SAFE_INTEGER;
    const rightOrder = styleOrder.get(rhs as CitationStyle) ??
      Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return lhs.localeCompare(rhs);
  });
  for (const style of sortedStyles) {
    styleResult[style] = sortCitations(byStyle.get(style) ?? []);
  }

  return { byTopic: topicResult, byStyle: styleResult };
};

const formatBibliography = (
  entries: readonly CitationRecord[],
): string[] => {
  return entries.map((entry) => {
    const authors = entry.authors.join(", ");
    return `${authors} (${entry.year}). ${entry.title} — ${entry.topic}. [${entry.style}]`;
  });
};

const toInputList = (
  entries: readonly CitationRecord[],
): CitationInput[] =>
  entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    authors: [...entry.authors],
    topic: entry.topic,
    year: entry.year,
    style: entry.style,
    summary: entry.summary,
  }));

const addCitation = handler(
  (
    event: AddCitationEvent | undefined,
    context: {
      argument: Cell<CitationInput[]>;
      style: Cell<CitationStyle | string>;
    },
  ) => {
    const fallbackStyle = normalizeStyle(context.style.get(), "APA");
    const current = sanitizeCitations(context.argument.get(), fallbackStyle);
    const nextIndex = current.length + 1;
    const seen = new Set(current.map((entry) => entry.id));
    const record = sanitizeCitation(
      event ?? {},
      nextIndex,
      normalizeStyle(event?.style, fallbackStyle),
      seen,
    );
    const nextCatalog = [...current, record];
    context.argument.set(toInputList(nextCatalog));
  },
);

const retagCitation = handler(
  (
    event: RetagCitationEvent | undefined,
    context: {
      argument: Cell<CitationInput[]>;
      style: Cell<CitationStyle | string>;
    },
  ) => {
    const targetId = typeof event?.id === "string" ? event.id : null;
    if (!targetId) return;
    const fallbackStyle = normalizeStyle(context.style.get(), "APA");
    const list = sanitizeCitations(context.argument.get(), fallbackStyle);
    const next = list.map((entry) => {
      if (entry.id !== targetId) return entry;
      const nextTopic = normalizeTopic(event?.topic, entry.topic);
      const nextStyle = normalizeStyle(event?.style, entry.style);
      const updated: CitationRecord = {
        ...entry,
        topic: nextTopic,
        style: nextStyle,
      };
      return { ...updated, summary: formatSummary(updated) };
    });
    context.argument.set(toInputList(next));
  },
);

const updateActiveStyle = handler(
  (
    event: { style?: string } | string | undefined,
    context: { style: Cell<CitationStyle | string> },
  ) => {
    const requested = typeof event === "string"
      ? event
      : typeof event?.style === "string"
      ? event.style
      : context.style.get();
    const sanitized = normalizeStyle(requested, "APA");
    context.style.set(sanitized);
  },
);

// Module-scope lift definitions
const liftActiveStyle = lift(
  (value: CitationStyle | string | undefined) => normalizeStyle(value, "APA"),
);

const liftCitationCatalog = lift<{
  entries: Writable<CitationInput[]>;
  fallback: Writable<CitationStyle>;
}>(({ entries, fallback }) => sanitizeCitations(entries.get(), fallback.get()));

const liftGroups = lift<{ entries: Writable<CitationRecord[]> }>(
  ({ entries }) => buildGroups(entries.get() ?? []),
);

const liftTopicBibliographies = lift(
  (mapping: Record<string, CitationRecord[]>) => {
    const labels: Record<string, string[]> = {};
    for (const key of Object.keys(mapping)) {
      labels[key] = formatBibliography(mapping[key]);
    }
    return labels;
  },
);

const liftStyleBibliographies = lift(
  (mapping: Record<string, CitationRecord[]>) => {
    const labels: Record<string, string[]> = {};
    for (const key of Object.keys(mapping)) {
      labels[key] = formatBibliography(mapping[key]);
    }
    return labels;
  },
);

const liftActiveBibliography = lift<
  {
    style: Writable<CitationStyle>;
    catalog: Writable<Record<string, string[]>>;
  }
>(({ style: active, catalog }) => {
  const current = active.get();
  const mapping = catalog.get() ?? {};
  return mapping[current] ?? [];
});

const liftSnapshot = lift<{
  entries: Writable<CitationRecord[]>;
  topics: Writable<Record<string, CitationRecord[]>>;
  styles: Writable<Record<string, CitationRecord[]>>;
  active: Writable<CitationStyle>;
  bibliography: Writable<string[]>;
}>(({ entries, topics, styles, active, bibliography }) => {
  const catalog = entries.get() ?? [];
  const topicKeys = Object.keys(topics.get() ?? {});
  const styleKeys = Object.keys(styles.get() ?? {});
  const activeStyleValue = active.get();
  const headline =
    `${catalog.length} citations across ${topicKeys.length} topics using ${styleKeys.length} styles.`;
  return {
    total: catalog.length,
    topics: topicKeys.length,
    styles: styleKeys.length,
    activeStyle: activeStyleValue,
    activeBibliography: bibliography.get() ?? [],
    headline,
  };
});

export const researchCitationManager = pattern<CitationArgs>(
  ({ citations, style }) => {
    const activeStyle = liftActiveStyle(style);

    const citationCatalog = liftCitationCatalog({
      entries: citations,
      fallback: activeStyle,
    });

    const groups = liftGroups({ entries: citationCatalog });

    const groupedByTopic = groups.byTopic;
    const groupedByStyle = groups.byStyle;

    const topicBibliographies = liftTopicBibliographies(groupedByTopic);

    const styleBibliographies = liftStyleBibliographies(groupedByStyle);

    const activeBibliography = liftActiveBibliography({
      style: activeStyle,
      catalog: styleBibliographies,
    });

    const snapshot = liftSnapshot({
      entries: citationCatalog,
      topics: groupedByTopic,
      styles: groupedByStyle,
      active: activeStyle,
      bibliography: activeBibliography,
    });

    const summary = str`${snapshot.key("total")} citations in ${
      snapshot.key("topics")
    } topics with ${snapshot.key("styles")} styles (active ${activeStyle}).`;

    return {
      citations: citationCatalog,
      groupedByTopic,
      groupedByStyle,
      topicBibliographies,
      styleBibliographies,
      activeStyle,
      activeBibliography,
      snapshot,
      summary,
      controls: {
        addCitation: addCitation({ argument: citations, style }),
        retagCitation: retagCitation({ argument: citations, style }),
        setStyle: updateActiveStyle({ style }),
      },
    };
  },
);

export default researchCitationManager;
