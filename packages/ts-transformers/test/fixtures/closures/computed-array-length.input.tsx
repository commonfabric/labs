/**
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - pieceRegistry comes from wish<{ pieceRegistry: MentionablePiece[] }>
 * - computed(() => pieceRegistry.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */

import { computed, NAME, pattern, resultOf, UI, wish } from "commonfabric";

interface Piece {
  id: string;
  name: string;
}

// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on a Reactive<T[]> is closure-extracted
//   computed(() => pieceRegistry.length) → lift(({ pieceRegistry }) => pieceRegistry.length)({ pieceRegistry: { length: pieceRegistry.length } })
//   pieceRegistry.map(fn) → pieceRegistry.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
  const piecesWish = wish<{ pieceRegistry: Piece[] }>({ query: "/" });
  const { pieceRegistry } = resultOf(piecesWish.result);

  return {
    [NAME]: computed(() => `Pieces (${pieceRegistry.length})`),
    [UI]: (
      <div>
        <span>Count: {computed(() => pieceRegistry.length)}</span>
        <ul>
          {pieceRegistry.map((piece) => (
            <li>{piece.name}</li>
          ))}
        </ul>
      </div>
    ),
  };
});
