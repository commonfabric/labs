/**
 * The default pattern `cf test` gives a test's space, so that
 * `wish({ query: "#default" })` resolves as it does in a deployed space, where
 * `default-app.tsx` provides it. It holds the piece registry, its `addPiece`
 * stream, and the `testPieceRegistrationCount` a test reads to see that a
 * registration happened.
 *
 * It is a compiled pattern rather than a handler registered on the test's
 * runtime because on the server-execution arm the serving loop runs the
 * handler an event is sent to, and the loop starts a handler from the program
 * the stream's piece was compiled from. The file name ends in `.test.tsx` so
 * that pattern coverage, which leaves test files out, does not report it.
 */

import type { RuntimeProgram } from "@commonfabric/runner";

const NAME = "/cf-test-default-pattern.test.tsx";

const SOURCE = `
import { handler, pattern, Writable } from "commonfabric";

const addPiece = handler<
  { piece?: Writable<unknown> },
  {
    pieceRegistry: Writable<unknown[]>;
    testPieceRegistrationCount: Writable<number>;
  }
>((event, { pieceRegistry, testPieceRegistrationCount }) => {
  const piece = event?.piece;
  if (!piece) return;
  pieceRegistry.addUnique(piece);
  testPieceRegistrationCount.set(testPieceRegistrationCount.get() + 1);
});

export default pattern(() => {
  const pieceRegistry = new Writable<unknown[]>([]);
  const testPieceRegistrationCount = new Writable(0);
  return {
    pieceRegistry,
    addPiece: addPiece({ pieceRegistry, testPieceRegistrationCount }),
    testPieceRegistrationCount,
    backlinksIndex: { mentionable: [] },
  };
});
`;

/** The program of the default pattern `cf test` gives a test's space. */
export const TEST_DEFAULT_PATTERN_PROGRAM: RuntimeProgram = {
  main: NAME,
  files: [{ name: NAME, contents: SOURCE }],
};
