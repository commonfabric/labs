import { NAME, pattern, UI, type VNode } from "commonfabric";

import UIVariantsDemo from "../../examples/ui-variants-demo.tsx";

// deno-lint-ignore no-empty-interface
interface RenderStoryInput {}
export interface RenderStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

interface SingleUIInput {
  label: string;
}
export interface SingleUIOutput {
  [NAME]: string;
  [UI]: VNode;
}

/**
 * A piece that exports ONLY [UI] — no [CHIP_UI]/[TILE_UI]. Used to demonstrate
 * the cf-render platform defaults (chip → a chip showing [NAME]; tile → the
 * full [UI] scaled to ~0.5).
 */
const SingleUIPiece = pattern<SingleUIInput, SingleUIOutput>(({ label }) => ({
  [NAME]: label,
  [UI]: (
    <div
      style={{
        padding: "16px",
        borderRadius: "8px",
        border: "1px solid #e5e7eb",
        background: "#ffffff",
      }}
    >
      <strong>{label}</strong>
      <div style={{ fontSize: "13px", color: "#6b7280" }}>
        This piece exports only [UI].
      </div>
    </div>
  ),
}));

const cellStyle = {
  border: "1px dashed #cbd5e1",
  borderRadius: "8px",
  padding: "12px",
  background: "#fafafa",
  minHeight: "80px",
};

const labelStyle = {
  fontSize: "12px",
  fontWeight: "700",
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: "8px",
};

const sectionTitleStyle = {
  fontSize: "15px",
  fontWeight: "700",
  color: "#0f172a",
  margin: "8px 0",
};

const noteStyle = {
  fontSize: "13px",
  color: "#64748b",
  marginBottom: "12px",
};

export default pattern<RenderStoryInput, RenderStoryOutput>(() => {
  // A piece exporting the full variant spectrum ([UI], [CHIP_UI], [TILE_UI]).
  const demo = UIVariantsDemo({ title: "UI Variants Demo" });

  // A piece exporting only [UI], to exercise the platform-default failover.
  const single = SingleUIPiece({ label: "Single-UI Piece" });

  return {
    [NAME]: "cf-render Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "640px" }}>
        <div style={sectionTitleStyle}>Exported variants (CT-1321)</div>
        <div style={noteStyle}>
          {"<cf-render>"}{" "}
          renders the piece's matching variant key when the piece exports it:
          [UI] for full, [CHIP_UI] for chip, [TILE_UI] for tile.
        </div>

        <div style={{ display: "grid", gap: "16px" }}>
          <div>
            <div style={labelStyle}>variant="full" (default)</div>
            <div style={cellStyle}>
              <cf-render $cell={demo} variant="full" />
            </div>
          </div>

          <div>
            <div style={labelStyle}>variant="chip"</div>
            <div style={cellStyle}>
              <cf-render $cell={demo} variant="chip" />
            </div>
          </div>

          <div>
            <div style={labelStyle}>variant="tile"</div>
            <div style={{ ...cellStyle, width: "220px", height: "120px" }}>
              <cf-render $cell={demo} variant="tile" />
            </div>
          </div>
        </div>

        <div style={{ ...sectionTitleStyle, marginTop: "24px" }}>
          Platform defaults (failover)
        </div>
        <div style={noteStyle}>
          A piece that exports only [UI] still renders at every variant via the
          per-variant platform default: chip falls over to a chip showing
          [NAME]; tile falls over to the full [UI] scaled to ~0.5.
        </div>

        <div style={{ display: "grid", gap: "16px" }}>
          <div>
            <div style={labelStyle}>variant="chip" → chip default</div>
            <div style={cellStyle}>
              <cf-render $cell={single} variant="chip" />
            </div>
          </div>

          <div>
            <div style={labelStyle}>variant="tile" → scaled [UI] default</div>
            <div style={{ ...cellStyle, width: "220px", height: "120px" }}>
              <cf-render $cell={single} variant="tile" />
            </div>
          </div>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. This story renders {"<cf-render>"}{" "}
        at each UI variant for a full-spectrum piece and a single-[UI] piece.
      </div>
    ),
  };
});
