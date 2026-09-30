import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { validateSource } from "../utils.ts";

const SPREAD_MESSAGE =
  "Spread traversal of opaque pattern values is not lowerable";

/** The spread diagnostics a source reports, and its transformed output. */
async function spreadDiagnosticsOf(source: string): Promise<{
  messages: string[];
  output: string;
}> {
  const { diagnostics, output } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return {
    messages: diagnostics
      .map((diagnostic) => diagnostic.message)
      .filter((message) => message.includes(SPREAD_MESSAGE)),
    output,
  };
}

describe("expandCapturedObjectSpreads()", () => {
  // A spread whose keys are not known where its operand is declared is left
  // as written, so the pattern-context check still reports it rather than
  // the callback copying a guessed set of keys.

  it("leaves a spread of a captured call result for the spread diagnostic", async () => {
    const { messages, output } = await spreadDiagnosticsOf(`
      import { handler, pattern, type Writable } from "commonfabric";

      const record = handler<void, { log: Writable<string[]>; id: string }>(
        (_, { log, id }) => {
          log.push(id);
        },
      );

      function makeBindings(log: Writable<string[]>) {
        return { log };
      }

      export default pattern<{ ids: string[]; log: Writable<string[]> }>(
        ({ ids, log }) => {
          const made = makeBindings(log);
          return { fire: ids.map((id) => record({ ...made, id })) };
        },
      );
    `);

    expect(messages).toHaveLength(1);
    expect(output).toContain("...made");
  });

  it("leaves a spread of an enclosing callback's element for the spread diagnostic", async () => {
    const { messages, output } = await spreadDiagnosticsOf(`
      import { handler, pattern, type Writable } from "commonfabric";

      interface Row {
        log: Writable<string[]>;
        ids: string[];
      }

      const record = handler<void, { log: Writable<string[]>; id: string }>(
        (_, { log, id }) => {
          log.push(id);
        },
      );

      export default pattern<{ rows: Row[] }>(({ rows }) => {
        return {
          fire: rows.map((row) =>
            row.ids.map((id) => record({ ...row, id }))
          ),
        };
      });
    `);

    expect(messages).toHaveLength(1);
    expect(output).toContain("...row");
  });
});
