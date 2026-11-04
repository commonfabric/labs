import { CHIP_UI, Default, NAME, pattern, TILE_UI, UI } from "commonfabric";

/**
 * CT-1321 UI-variants demo. Exports the full size spectrum:
 * - [UI]      full standalone rendering
 * - [CHIP_UI] inline chip
 * - [TILE_UI] gallery/grid tile
 *
 * Render any variant with `<cf-render variant="chip|tile|full" .cell=... />`.
 * A piece that omits [CHIP_UI]/[TILE_UI] still renders at those variants via
 * the platform defaults (a chip showing [NAME] for chip, the full [UI] scaled
 * for tile).
 */
export default pattern<{ title: string | Default<"UI Variants Demo"> }>(
  ({ title }) => ({
    [NAME]: title,
    [UI]: (
      <div style={{ padding: "16px", border: "1px solid #e5e7eb" }}>
        <h1 style={{ margin: "0 0 8px" }}>{title}</h1>
        <p style={{ margin: "0", color: "#6b7280" }}>
          Full standalone [UI] — the universal floor.
        </p>
      </div>
    ),
    [CHIP_UI]: (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 8px",
          borderRadius: "999px",
          background: "#eef2ff",
          color: "#4338ca",
          fontSize: "13px",
        }}
      >
        🔖 {title}
      </span>
    ),
    [TILE_UI]: (
      <div
        style={{
          padding: "12px",
          borderRadius: "8px",
          border: "1px solid #e5e7eb",
          background: "#fafafa",
        }}
      >
        <strong>{title}</strong>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>tile variant</div>
      </div>
    ),
    title,
  }),
);
