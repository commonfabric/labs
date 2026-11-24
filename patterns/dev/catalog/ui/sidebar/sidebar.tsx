import {
  computed,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
} from "commonfabric";
import { Category } from "../../catalog.tsx";

interface SidebarInput {
  selected: string;
  categories: Category[];
  onSelect: Stream<{ id: string }>;
  onCollapse?: Stream<void>;
}

export interface SidebarOutput {
  [NAME]: string;
  [UI]: VNode;
}

// One flat render row: either a category heading or a selectable item.
type SidebarRow =
  | { kind: "header"; name: string; id: string; label: string }
  | { kind: "item"; name: string; id: string; label: string };

const styles = {
  root: {
    width: "220px",
    backgroundColor: "var(--cf-theme-color-surface, #f6f7f9)",
    borderRight: "1px solid var(--cf-theme-color-border, #e6e9ed)",
    overflowY: "auto",
    flexShrink: "0",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  header: {
    padding: "12px 16px",
    borderBottom: "1px solid var(--cf-theme-color-border, #e6e9ed)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  headerTitle: {
    fontSize: "14px",
    fontWeight: "700",
    color: "var(--cf-theme-color-text, #2e3438)",
    letterSpacing: "-0.01em",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  heading: {
    padding: "10px 16px 4px",
    fontSize: "11px",
    fontWeight: "700",
    color: "var(--cf-theme-color-text-muted, #798186)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  item: {
    padding: "4px 12px",
    margin: "1px 8px",
    borderRadius: "4px",
    fontSize: "13px",
    cursor: "pointer",
  },
};

export const Sidebar = pattern<SidebarInput, SidebarOutput>(
  ({ selected, categories, onSelect, onCollapse }) => {
    // Flatten the nested category/items structure into a single list so the UI
    // can map ONCE over a direct cell. Two problems are avoided by flattening:
    //   1. A per-item `.map` on `category.items` (reached through the outer
    //      map's entry) is not reactive — `item` is undefined at build time.
    //   2. Forwarding `onSelect` into a per-item *sub-pattern* through `.map`
    //      drops its `$stream: true` marker, so the handler is misinstantiated
    //      as a lift (runner.ts:3094) and the sidebar fails to render.
    // A single map over this computed keeps `onSelect` a live stream captured by
    // the onClick closure — the canonical inline-`.send()` list idiom.
    const rows = computed<SidebarRow[]>(() => {
      const out: SidebarRow[] = [];
      for (const category of categories ?? []) {
        out.push({
          kind: "header",
          name: category.name,
          id: "",
          label: category.name,
        });
        for (const item of category.items ?? []) {
          out.push({
            kind: "item",
            name: category.name,
            id: item.id,
            label: item.label,
          });
        }
      }
      return out;
    });

    return {
      [NAME]: "Sidebar",
      [UI]: (
        <div style={styles.root}>
          {/* Header area */}
          <div style={styles.header}>
            <cf-button
              variant="ghost"
              onClick={onCollapse}
              style="font-size: 18px; padding: 2px 6px; flex-shrink: 0;"
            >
              &#9776;
            </cf-button>
            <div style={styles.headerTitle}>
              Component Catalog
            </div>
          </div>

          {/* Content area — single flat map; see `rows` above. */}
          <div style={styles.content}>
            {rows.map((row) =>
              ifElse(
                computed(() => row.kind === "header"),
                <div style={styles.heading}>{row.label}</div>,
                <div
                  style={{
                    ...styles.item,
                    color: selected === row.id
                      ? "var(--cf-theme-color-primary, #1ea7fd)"
                      : "var(--cf-theme-color-text, #2e3438)",
                    backgroundColor: selected === row.id
                      ? "var(--cf-theme-color-primary-light, #e8f4fd)"
                      : "transparent",
                    fontWeight: selected === row.id ? "600" : "400",
                  }}
                  onClick={() => onSelect.send({ id: row.id })}
                >
                  {row.label}
                </div>,
              )
            )}
          </div>
        </div>
      ),
    };
  },
);
