/**
 * Simple List Module - A checklist with indent support
 *
 * A composable pattern that runs standalone or embeds in another pattern as a
 * JSX tag. Provides rapid keyboard entry, checkboxes, and indent toggle.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** Ballot box with check, shown ahead of the summary in [NAME]. */
const LIST_ICON = "\u2611";

// ===== Types =====
export interface SimpleListItem {
  text: string;
  indented: boolean | Default<false>;
  done: boolean | Default<false>;
}

export interface SimpleListInput {
  items?: Writable<SimpleListItem[] | Default<[]>>;
}

export interface SimpleListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: SimpleListItem[];
  summary: string;
  toggleIndent: Stream<{ index: number }>;
  setIndent: Stream<{ index: number; indented: boolean }>;
  deleteItem: Stream<{ index: number }>;
  addItem: Stream<{ text: string }>;
}

// ===== The Pattern =====
export const SimpleListModule = pattern<
  SimpleListInput,
  SimpleListOutput
>(({ items }) => {
  // Pattern-body actions - preferred for single-use handlers
  const toggleIndent = action(({ index }: { index: number }) => {
    const current = items.get() || [];
    if (index < 0 || index >= current.length) return;

    const updated = [...current];
    updated[index] = {
      ...updated[index],
      indented: !updated[index].indented,
    };
    items.set(updated);
  });

  const setIndent = action(
    ({ index, indented }: { index: number; indented: boolean }) => {
      const current = items.get() || [];
      if (index < 0 || index >= current.length) return;

      const updated = [...current];
      updated[index] = { ...updated[index], indented };
      items.set(updated);
    },
  );

  const deleteItem = action(({ index }: { index: number }) => {
    const current = items.get() || [];
    if (index < 0 || index >= current.length) return;

    items.set(current.toSpliced(index, 1));
  });

  const addItem = action(({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (trimmed) {
      items.push({ text: trimmed, indented: false, done: false });
    }
  });

  // Computed summary for NAME
  const displayText = computed(() => {
    const list = items.get() || [];
    const total = list.length;
    if (total === 0) return "Empty";
    const done = list.filter((item) => item.done).length;
    return `${done}/${total}`;
  });

  const summary = computed(() => {
    return (items.get() || [])
      .map((item) => `${item.done ? "✓" : "○"} ${item.text}`)
      .join(", ");
  });

  return {
    [NAME]: computed(() => `${LIST_ICON} List: ${displayText}`),
    [UI]: (
      <cf-vstack gap="2">
        {/* List items */}
        <cf-vstack gap="0">
          {items.map((item, index: number) => (
            <cf-hstack
              gap="2"
              style={{
                alignItems: "center",
                padding: "6px 8px",
                paddingLeft: item.indented ? "28px" : "8px",
                borderBottom: "1px solid var(--border-subtle, #f0f0f0)",
              }}
            >
              {/* Checkbox */}
              <cf-checkbox $checked={item.done} style={{ flexShrink: "0" }} />

              {/* Editable text with Cmd+[ / Cmd+] for indent */}
              <cf-input
                $value={item.text}
                placeholder="..."
                style={{
                  flex: "1",
                  background: "transparent",
                  border: "none",
                  padding: "2px 4px",
                  fontSize: "14px",
                  textDecoration: item.done ? "line-through" : "none",
                  opacity: item.done ? "0.5" : "1",
                  color: "inherit",
                }}
                oncf-keydown={(e: {
                  detail?: {
                    key: string;
                    metaKey?: boolean;
                    ctrlKey?: boolean;
                  };
                }) => {
                  const d = e.detail;
                  if (!d) return;
                  // Cmd+] or Ctrl+] = indent
                  if (d.key === "]" && (d.metaKey || d.ctrlKey)) {
                    setIndent.send({ index, indented: true });
                  }
                  // Cmd+[ or Ctrl+[ = outdent
                  if (d.key === "[" && (d.metaKey || d.ctrlKey)) {
                    setIndent.send({ index, indented: false });
                  }
                }}
              />

              {/* Indent toggle */}
              <button
                type="button"
                onClick={() => toggleIndent.send({ index })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                  fontSize: "12px",
                  color: item.indented ? "#666" : "#ccc",
                  opacity: "0.6",
                  transition: "opacity 0.15s",
                }}
                title={item.indented ? "Outdent" : "Indent"}
              >
                {item.indented ? "\u2190" : "\u2192"}
              </button>

              {/* Delete - subtle until hover */}
              <button
                type="button"
                onClick={() => deleteItem.send({ index })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                  fontSize: "14px",
                  color: "#ccc",
                  opacity: "0.5",
                  transition: "opacity 0.15s",
                }}
                title="Delete"
              >
                x
              </button>
            </cf-hstack>
          ))}
        </cf-vstack>

        {/* Add item input - at bottom for natural list growth */}
        <cf-message-input
          placeholder="Add item..."
          button-text="+"
          style={{
            fontSize: "14px",
          }}
          oncf-send={(e: { detail?: { message?: string } }) => {
            const text = e.detail?.message;
            if (text) {
              addItem.send({ text });
            }
          }}
        />
      </cf-vstack>
    ),
    items,
    summary,
    toggleIndent,
    setIndent,
    deleteItem,
    addItem,
  };
});

export default SimpleListModule;
