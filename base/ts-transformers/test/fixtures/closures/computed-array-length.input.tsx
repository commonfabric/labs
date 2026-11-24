/**
 * `.length` read inside a computed on an array that `wish()` returns.
 *
 * `computed(() => pieceRegistry.length)` reads only the array's `length`, so
 * the capture is that member: the lift is handed
 * `{ pieceRegistry: { length: pieceRegistry.key("length") } }`, and its input
 * schema describes `pieceRegistry` as an object holding `length`, which is the
 * value it receives. The array itself reaches only the `.map()`.
 */

import { computed, NAME, pattern, UI, wish } from "commonfabric";

interface Piece {
  id: string;
  name: string;
}

// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on a Reactive<T[]> is closure-extracted
//   computed(() => pieceRegistry.length) → lift(({ pieceRegistry }) => pieceRegistry.length)({ pieceRegistry: { length: pieceRegistry.length } })
//   pieceRegistry.map(fn) → pieceRegistry.mapWithPattern(pattern(fn, ...schemas), {})
// Context: the capture is the `length` member, so the lift's input schema is
//   an object holding `length`, not the array the member is read from.
export default pattern(() => {
  const { pieceRegistry } = wish<{ pieceRegistry: Piece[] }>({ query: "/" }).result!;

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
