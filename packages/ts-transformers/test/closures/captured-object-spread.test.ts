import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { validateSource } from "../utils.ts";

/** The closure stage's report of a captured spread it cannot write out. */
const CAPTURED_SPREAD_MESSAGE = "copies nothing";

/** The pattern-context check's report of a spread of an opaque value. */
const OPAQUE_SPREAD_MESSAGE =
  "Spread traversal of opaque pattern values is not lowerable";

const RECORD_HANDLER = `
  const record = handler<
    void,
    { log: Writable<string[]>; prefix: Writable<string>; id: string }
  >((_, { log, prefix, id }) => {
    log.push(prefix.get() + id);
  });
`;

/**
 * A pattern whose `.map()` callback binds `record({ ...records, log, id })`,
 * with `declarations` standing in the pattern body ahead of it.
 */
function spreadOfRecords(declarations: string): string {
  return `
    import { handler, pattern, type Writable } from "commonfabric";
    ${RECORD_HANDLER}
    function makePlain() {
      return { prefix: "p" };
    }

    export default pattern<
      { ids: string[]; log: Writable<string[]>; prefix: Writable<string> }
    >(({ ids, log, prefix }) => {
      const base = { log, prefix };
      ${declarations}
      return { fire: ids.map((id) => record({ ...records, log, id })) };
    });
  `;
}

/** What a source reports about a spread, and its transformed output. */
async function spreadReportsOf(source: string): Promise<{
  captured: string[];
  opaque: string[];
  output: string;
}> {
  const { diagnostics, output } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const messages = diagnostics.map((diagnostic) => diagnostic.message);
  return {
    captured: messages.filter((message) =>
      message.includes(CAPTURED_SPREAD_MESSAGE)
    ),
    opaque: messages.filter((message) =>
      message.includes(OPAQUE_SPREAD_MESSAGE)
    ),
    output,
  };
}

describe("expandCapturedObjectSpreads()", () => {
  describe("writes out a spread whose keys are known where it is declared", () => {
    it("reads a numeric key through the capture", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords("const records = { 0: log, prefix };"),
      );

      expect(captured).toHaveLength(0);
      expect(opaque).toHaveLength(0);
      expect(output).toContain(
        'record({ 0: records.key("0"), prefix: records.key("prefix"), log, id })',
      );
    });

    it("reads the keys of the literal an alias names", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords("const records = base;"),
      );

      expect(captured).toHaveLength(0);
      expect(opaque).toHaveLength(0);
      expect(output).toContain(
        'record({ log: records.key("log"), prefix: records.key("prefix"), log, id })',
      );
    });

    it("reads the keys a literal's own spread copies, in place", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords('const records = { first: "f", ...base, last: "l" };'),
      );

      expect(captured).toHaveLength(0);
      expect(opaque).toHaveLength(0);
      expect(output).toContain(
        'record({ first: records.key("first"), log: records.key("log"), prefix: records.key("prefix"), last: records.key("last"), log, id })',
      );
    });
  });

  // A spread of a capture whose keys are not known where it is declared
  // copies nothing when it runs. It is left as written and reported, once.
  describe("reports a spread whose keys are not known where it is declared", () => {
    it("reports a literal with a computed key", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords(
          'const k = "log"; const records = { [k]: log, prefix };',
        ),
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("`records`");
      expect(opaque).toHaveLength(0);
      expect(output).toContain("...records");
    });

    it("reports a call result the pattern-context check does not track", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords("const records = makePlain();"),
      );

      expect(captured).toHaveLength(1);
      expect(opaque).toHaveLength(0);
      expect(output).toContain("...records");
    });

    it("reports a literal that spreads a call result", async () => {
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords("const records = { ...makePlain(), log };"),
      );

      expect(captured).toHaveLength(1);
      expect(opaque).toHaveLength(0);
      expect(output).toContain("...records");
    });

    it("reports a literal that spreads its own `const`", async () => {
      // The literal reads `records` before it is initialized. The code does
      // not run, but it compiles, and the key walk must not loop on it.
      const { captured, output } = await spreadReportsOf(
        spreadOfRecords(
          "const records: { log?: Writable<string[]> } = { ...records };",
        ),
      );

      expect(captured).toHaveLength(1);
      expect(output).toContain("...records");
    });

    it("reports a captured call result once, where the pattern-context check tracks it too", async () => {
      const { captured, opaque, output } = await spreadReportsOf(`
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

      expect(captured).toHaveLength(1);
      expect(opaque).toHaveLength(0);
      expect(output).toContain("...made");
    });

    it("reports an enclosing callback's element once, where the pattern-context check tracks it too", async () => {
      const { captured, opaque, output } = await spreadReportsOf(`
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

      expect(captured).toHaveLength(1);
      expect(opaque).toHaveLength(0);
      expect(output).toContain("...row");
    });
  });

  it("leaves a spread of an opaque value outside a callback to the pattern-context check", async () => {
    const { captured, opaque } = await spreadReportsOf(`
      import { pattern } from "commonfabric";

      export default pattern<{ row: { a: string; b: string } }>(({ row }) => {
        return { copy: { ...row } };
      });
    `);

    expect(captured).toHaveLength(0);
    expect(opaque).toHaveLength(1);
  });
});
