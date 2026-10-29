import {
  computed,
  equals,
  NAME,
  pattern,
  SELF,
  UI,
  Writable,
} from "commonfabric";

type Piece = Writable<{ [NAME]?: string }>;

type Input = {
  pieces: Piece[];
};

export default pattern<Input>(({ pieces, [SELF]: self }) => {
  // Filter out self to prevent infinite recursion if this grid view
  // appears in the pieces list it's rendering
  const filtered = computed(() =>
    pieces.filter((piece: Piece) => !equals(piece, self))
  );

  return {
    [NAME]: "Grid View",
    [UI]: (
      <cf-grid columns="3" gap="4" padding="4">
        {filtered.map((piece: Piece) => (
          <div
            style={{
              border: "1px solid var(--cf-theme-color-border, #e5e5e7)",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            {
              /* Tile variant: cf-render owns the scaled, clipped,
                click-to-navigate preview (no hand-rolled scaling). */
            }
            <div style={{ width: "100%", height: "200px" }}>
              <cf-render variant="tile" $cell={piece} />
            </div>
            <div style={{ padding: "8px" }}>
              <cf-render variant="chip" $cell={piece} />
            </div>
          </div>
        ))}
      </cf-grid>
    ),
  };
});
