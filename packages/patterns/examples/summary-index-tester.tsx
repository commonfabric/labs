import {
  computed,
  NAME,
  pattern,
  resultOf,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { type SummaryIndexEntry } from "../system/summary-index.tsx";

type SummaryIndexResult = {
  entries: SummaryIndexEntry[];
  search: { pattern: unknown; extraParams: { entries: SummaryIndexEntry[] } };
};

export default pattern<Record<string, never>>((_) => {
  const query = new Writable("");

  const summaryWish = wish<SummaryIndexResult>({
    query: "#summaryIndex",
  });
  const { entries } = resultOf(summaryWish.result);

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

          <cf-table full-width>
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
