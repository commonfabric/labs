/**
 * An attacker pattern, compiled and run in the pattern sandbox, whose handler
 * runs a function body of the test's choosing against a cell it is handed.
 * Tests use it to check what pattern code can and cannot do with a cell.
 */

import type { Cell, MemorySpace } from "../../src/cell.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { Runtime } from "../../src/runtime.ts";

const ATTACKER_FILE = "/attacker/main.tsx";

// The handler runs `claim`, a function body that sees `cell`, the target cell
// the attacker was handed as a `Writable<targetType>`, and `event`, the event
// that triggered it. It writes into `note` what `claim` returned, or the name
// and message of what it threw.
const attackerProgram = (
  claim: string,
  targetType: string,
): RuntimeProgram => ({
  main: ATTACKER_FILE,
  files: [{
    name: ATTACKER_FILE,
    contents: [
      "/// <cts-enable />",
      'import { handler, pattern, type Stream, Writable } from "commonfabric";',
      "",
      "type Event = { id?: string };",
      "",
      "const attack = handler<",
      "  Event,",
      `  { target: Writable<${targetType}>; note: Writable<unknown> }`,
      ">((event, state) => {",
      "  const cell: any = state.target;",
      "  let outcome: unknown;",
      "  try {",
      "    outcome = (() => {",
      claim,
      "    })();",
      "  } catch (error) {",
      "    outcome = 'threw ' + (error as Error).name + ': ' +",
      "      (error as Error).message;",
      "  }",
      "  state.note.set(outcome);",
      "});",
      "",
      "export default pattern<",
      `  { target: Writable<${targetType}>; note: Writable<unknown> },`,
      "  { attack: Stream<Event> }",
      ">(({ target, note }) => ({ attack: attack({ target, note }) }));",
    ].join("\n"),
  }],
});

/** What `runAttacker()` returns. */
export type Attack = {
  /** The cell the attacker writes the claim's outcome into. */
  note: Cell<unknown>;

  /**
   * Runs the claim once, with `event` as its event, and returns what it
   * returned or threw.
   */
  probe(event?: { id?: string }): Promise<unknown>;
};

/**
 * Runs an attacker piece in `runtime` handed `target`, the attacker running
 * `claim` on each event. `targetType` is the TypeScript type the attacker
 * declares the target cell's value as, which decides what the runtime reads to
 * hand the attacker that cell.
 */
export async function runAttacker(
  runtime: Runtime,
  space: MemorySpace,
  target: Cell<unknown>,
  claim: string,
  targetType = "unknown",
): Promise<Attack> {
  const attackerPattern = await runtime.patternManager.compilePattern(
    attackerProgram(claim, targetType),
    { space },
  );
  const attacker = runtime.getCell<{ attack: unknown }>(
    space,
    `attacker-${crypto.randomUUID()}`,
    attackerPattern.resultSchema,
  );
  const note = runtime.getCell<unknown>(space, `note-${crypto.randomUUID()}`);
  await runtime.runSynced(attacker, attackerPattern, { target, note });
  await runtime.idle();
  return {
    note,
    probe: async (event = {}) => {
      await runtime.editWithRetry((tx) =>
        attacker.key("attack").withTx(tx).send(event)
      );
      await runtime.idle();
      return await note.pull();
    },
  };
}
