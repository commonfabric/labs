import {
  computed,
  type JSXElement,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { type SummaryIndexEntry } from "../../system/summary-index/summary-index.tsx";

type SummaryIndexResult = {
  entries: SummaryIndexEntry[];
  search: { pattern: unknown; extraParams: { entries: SummaryIndexEntry[] } };
};

export interface SummaryIndexBrowserInput {
  /** The index entries to list. */
  entries: SummaryIndexEntry[];

  /** Text an entry's name or summary has to contain to be listed. */
  query: Writable<string>;
}

export interface SummaryIndexTesterOutput {
  [NAME]: string;
  [UI]: JSXElement;
}

/** Lists summary index entries, filtered by the query typed above them. */
export const SummaryIndexBrowser = pattern<
  SummaryIndexBrowserInput,
  SummaryIndexTesterOutput
>(({ entries, query }) => {
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
    [NAME]: "Summary Index Tester",
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Summary Index Tester</h2>
        </cf-toolbar>

        <cf-vstack gap="6" padding="6">
          <cf-vstack gap="2">
            <strong>
              Index: {entryCount} entries
            </strong>
            <cf-input
              $value={query}
              placeholder="Search summaries..."
            />
            <span
              style={{
                fontSize: "13px",
                color: "var(--cf-theme-color-text-secondary)",
              }}
            >
              Showing {filteredCount} results
            </span>
          </cf-vstack>

          <cf-table fullWidth>
            <thead>
              <tr>
                <th>Name</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <cf-cell-link $cell={entry.piece} />
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
  };
});

export default pattern<Record<string, never>, SummaryIndexTesterOutput>(
  (_) => {
    const index = wish<SummaryIndexResult>({ query: "#summaryIndex" });
    // A space with no summary index lists nothing.
    const entries = computed(() => index.result?.entries ?? []);
    return SummaryIndexBrowser({ entries, query: new Writable("") });
  },
);
