import {
  Cell,
  cell,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
} from "commonfabric";

// the simple piece (to which we'll store references within a cell)
const SimplePattern = pattern(() => ({
  [NAME]: "Some Simple Pattern",
  [UI]: <div>Some Simple Pattern</div>,
}));

// Create a cell to store an array of pieces
const createCellRef = lift(
  ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
      console.log("Creating cellRef - first time");
      const newCellRef = Cell.for<any[]>("piecesArray");
      newCellRef.set([]);
      const storedCellValue: Cell<unknown> = storedCellRef;
      storedCellValue.set(newCellRef);
      isInitialized.set(true);
      return {
        cellRef: newCellRef,
      };
    } else {
      console.log("cellRef already initialized");
    }
    // If already initialized, return the stored cellRef
    return {
      cellRef: storedCellRef,
    };
  },
  {
    type: "object",
    properties: {
      isInitialized: { type: "boolean", "default": false, asCell: ["cell"] },
      storedCellRef: { type: "object", asCell: ["cell"] },
    },
    required: ["isInitialized", "storedCellRef"],
  },
);

// Add a piece to the array and navigate to it
// we get a new isInitialized passed in for each
// piece we add to the list. this makes sure
// we only try to add the piece once to the list
// and we only call navigateTo once
const addPieceAndNavigate = lift(
  ({ piece, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
      if (cellRef) {
        cellRef.push(piece);
        isInitialized.set(true);
        return navigateTo(piece);
      } else {
        console.log("addPieceAndNavigate undefined cellRef");
      }
    }
    return undefined;
  },
  {
    type: "object",
    properties: {
      piece: { type: "object" },
      cellRef: { type: "array", asCell: ["cell"] },
      isInitialized: { type: "boolean", asCell: ["cell"] },
    },
    required: ["piece", "isInitialized"],
  },
);

// Create a new SimplePattern and add it to the array
const createSimplePattern = handler<unknown, { cellRef: Cell<any[]> }>(
  (_, { cellRef }) => {
    // Create isInitialized cell for this piece addition
    const isInitialized = cell(false);

    // Create the piece
    const piece = SimplePattern({});

    // Store the piece in the array and navigate
    return addPieceAndNavigate({ piece, cellRef, isInitialized });
  },
);

// Handler to navigate to a specific piece from the list
const goToPiece = handler<unknown, { piece: any }>(
  (_, { piece }) => {
    console.log("goToPiece clicked");
    return navigateTo(piece);
  },
);

// FIXTURE: reactive-cell-map
// Verifies: a reactive factory result still rewrites JSX ifElse predicates after
//           the forbidden Reactive cast is removed
//   ifElse(!cellRef?.length, <div>, <ul>) → ifElse(schema..., lift(...)(...), <div>, <ul>)
//   cellRef.map((piece, index) => <li>...) → mapWithPattern(...) even with
//     `as { cellRef: any[] }`, because the cast does not change the reactive origin
// Context: Real-world pattern using Cell.for<any[]>(), handler, lift, and navigateTo
// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
  // cell to store array of pieces we created
  const { cellRef } = createCellRef({
    isInitialized: cell(false),
    storedCellRef: cell(),
  }) as { cellRef: any[] };

  return {
    [NAME]: "Pieces Launcher",
    [UI]: (
      <div>
        <h3>Stored Pieces:</h3>
        {ifElse(
          !cellRef?.length,
          <div>No pieces created yet</div>,
          <ul>
            {cellRef.map((piece: any, index: number) => (
              <li>
                <cf-button
                  onClick={goToPiece({ piece })}
                >
                  Go to Piece {index + 1}
                </cf-button>
                <span>Piece {index + 1}: {piece[NAME] || "Unnamed"}</span>
              </li>
            ))}
          </ul>,
        )}

        <cf-button
          onClick={createSimplePattern({ cellRef })}
        >
          Create New Piece
        </cf-button>
      </div>
    ),
    cellRef,
  };
});
