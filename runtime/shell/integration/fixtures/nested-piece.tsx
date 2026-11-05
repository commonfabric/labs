import { NAME, pattern, UI, type VNode } from "commonfabric";

interface PieceOutput {
  [NAME]: string;
  [UI]: VNode;
}

const InnerPiece = pattern<void, PieceOutput>(() => ({
  [NAME]: "Inner piece",
  [UI]: (
    <>
      <article
        id="inner-piece-root"
        style={{ width: "220px", height: "100px" }}
      >
        <button id="inner-piece-button" type="button">Inner action</button>
      </article>
    </>
  ),
}));

const MiddlePiece = pattern<void, PieceOutput>(() => {
  const inner = InnerPiece();
  return {
    [NAME]: "Middle piece",
    [UI]: (
      <section
        id="middle-piece-root"
        style={{ width: "240px", height: "120px" }}
      >
        {inner}
      </section>
    ),
  };
});

export default pattern<void, PieceOutput>(() => {
  const middle = MiddlePiece();
  return {
    [NAME]: "Nested piece fixture",
    [UI]: (
      <main id="outer-piece-root">
        <div
          id="nested-piece-clip"
          style={{
            width: "180px",
            height: "80px",
            overflow: "auto",
            border: "4px solid black",
            transform: "scale(0.75)",
            transformOrigin: "top left",
          }}
        >
          {middle}
        </div>
      </main>
    ),
  };
});
