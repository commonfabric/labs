import {
  computed,
  type Default,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { type MentionablePiece } from "./backlinks-index.tsx";

export type SummarizablePiece = MentionablePiece & { summary?: string };

export type SummaryIndexEntry = {
  piece: Writable<SummarizablePiece>;
  summary: string;
  name: string;
};

type Input = Record<string, never>;

export type Output = {
  entries: SummaryIndexEntry[];
  search: PatternToolResult<{ entries: SummaryIndexEntry[] }>;
};

function isCellLike<T>(value: unknown): value is { get: () => T } {
  return !!value && typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function";
}

function extractSummary(piece: any): string | undefined {
  const summary = piece?.summary;
  if (!summary) return undefined;

  if (isCellLike<string>(summary)) {
    const value = summary.get();
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

/** Search sub-pattern: filters entries by query matching summary or name. */
interface SearchInput {
  /** Substring to match against piece names and summaries. Pass an empty string to return all entries. */
  query: string;
  entries: Writable<SummaryIndexEntry>[];
}

export const searchPattern = pattern<
  SearchInput,
  Writable<SummaryIndexEntry>[]
>(({ query, entries }) => {
  return computed(() => {
    if (!query || query.trim() === "") return entries;
    const lowerQuery = query.toLowerCase().trim();
    return entries.filter(
      (entry) => {
        // Guard partially-hydrated entries: `entries` is caller-supplied,
        // and a snapshot can surface an entry whose summary/name are not
        // (yet) strings — reachable under serving-order execution, where
        // `.toLowerCase()` on undefined crashed the lift and the failed
        // action was rescheduled without backoff (worker storm). Match
        // extractSummary's typeof discipline above.
        const value = entry.get();
        const summary = typeof value?.summary === "string" ? value.summary : "";
        const name = typeof value?.name === "string" ? value.name : "";
        return summary.toLowerCase().includes(lowerQuery) ||
          name.toLowerCase().includes(lowerQuery);
      },
    );
  });
});

const SummaryIndex = pattern<Input, Output>(() => {
  const mentionable = wish<Default<Writable<SummarizablePiece>[], []>>({
    query: "#mentionable",
  }).result;

  const query = new Writable("");

  const entries = computed(() => {
    const result: SummaryIndexEntry[] = [];
    for (const piece of (Array.isArray(mentionable) ? mentionable : [])) {
      if (!piece) continue;
      const value = piece.get();
      const summary = extractSummary(value);
      if (!summary) continue;
      const name = (value[NAME] ?? "").toString();
      result.push({ piece, summary, name });
    }
    return result;
  });

  const filtered = computed(() => {
    const q = query.get().toLowerCase().trim();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.summary.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q),
    );
  });

  const entryCount = computed(() => entries.length);
  const filteredCount = computed(() => filtered.length);

  return {
    [NAME]: "SummaryIndex",
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Search</h2>
        </cf-toolbar>

        <cf-vstack gap="4" padding="6">
          <cf-input $value={query} placeholder="Search summaries..." />
          <span
            style={{
              fontSize: "13px",
              color: "var(--cf-theme-color-text-secondary)",
            }}
          >
            {filteredCount} of {entryCount} pieces
          </span>

          <cf-table full-width>
            <tbody>
              {filtered.map((entry) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <cf-render variant="chip" $cell={entry.piece} />
                  </td>
                  <td
                    style={{
                      fontSize: "13px",
                      color: "var(--cf-theme-color-text-secondary)",
                    }}
                  >
                    {entry.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </cf-table>
        </cf-vstack>
      </cf-screen>
    ),
    entries,
    search: patternTool(searchPattern, { entries }),
  };
});

export default SummaryIndex;
