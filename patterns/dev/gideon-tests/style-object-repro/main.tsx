// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { NAME, pattern, UI, type VNode } from "commonfabric";

// ===== Types =====

type ReproInput = Record<string, never>;

export interface ReproOutput {
  [NAME]: string;
  [UI]: VNode;
}

// ===== Shared style object (BUG) =====
// This single object reference is reused across all siblings.
// The runtime sees the same reference and assumes nothing changed,
// so only the first element actually gets the style applied.
const sharedCardStyle = {
  background: "white",
  borderRadius: "8px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
  padding: "16px",
  borderLeft: "4px solid #3b82f6",
  marginBottom: "8px",
};

// ===== Factory function (FIX) =====
// Returns a fresh object each time, so the runtime sees a new
// reference for every sibling and applies the style correctly.
function makeCardStyle() {
  return {
    background: "white",
    borderRadius: "8px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
    padding: "16px",
    borderLeft: "4px solid #10b981",
    marginBottom: "8px",
  };
}

// ===== Pattern =====

const StyleObjectRepro = pattern<ReproInput, ReproOutput>(() => {
  const bugItems = ["Card A", "Card B", "Card C", "Card D", "Card E"];
  const fixItems = ["Card A", "Card B", "Card C", "Card D", "Card E"];

  return {
    [NAME]: "Style Object Reference Gotcha",
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={4}>Style Object Reference Gotcha</cf-heading>
        </cf-vstack>

        <cf-vscroll style="flex: 1; padding: 1.5rem;">
          {/* ===== BUG DEMO ===== */}
          <cf-vstack gap="2">
            <cf-heading level={5} style="color: #ef4444;">
              Bug Demo (shared style object)
            </cf-heading>
            <div style="color: var(--cf-color-gray-500); font-size: 0.875rem; margin-bottom: 8px;">
              These boxes share a style object reference — only the first one
              renders correctly:
            </div>
            {bugItems.map((label) => (
              <div style={sharedCardStyle}>
                <span style="fontWeight: 600;">{label}</span>
                <span style="color: var(--cf-color-gray-400); marginLeft: 8px;">
                  — using sharedCardStyle
                </span>
              </div>
            ))}
          </cf-vstack>

          {/* ===== Divider ===== */}
          <div
            style={{
              borderTop: "2px dashed var(--cf-color-gray-300)",
              margin: "8px 0",
            }}
          />

          {/* ===== FIX DEMO ===== */}
          <cf-vstack gap="2">
            <cf-heading level={5} style="color: #10b981;">
              Fix Demo (factory function)
            </cf-heading>
            <div style="color: var(--cf-color-gray-500); font-size: 0.875rem; margin-bottom: 8px;">
              These boxes each get a fresh style object from a factory function
              — all render correctly:
            </div>
            {fixItems.map((label) => (
              <div style={makeCardStyle()}>
                <span style="fontWeight: 600;">{label}</span>
                <span style="color: var(--cf-color-gray-400); marginLeft: 8px;">
                  — using makeCardStyle()
                </span>
              </div>
            ))}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
  };
});

export default StyleObjectRepro;
