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
 * with `declarations` standing in the pattern body ahead of it. `operand` is
 * what the callback spreads, `records` unless given.
 */
function spreadOfRecords(declarations: string, operand = "records"): string {
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
      return { fire: ids.map((id) => record({ ...${operand}, log, id })) };
    });
  `;
}

/** The messages of the computation errors a source reports. */
async function computationErrorsOf(source: string): Promise<string[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics
    .filter((diagnostic) => diagnostic.type === "pattern-context:computation")
    .map((diagnostic) => diagnostic.message);
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

    it("reads a numeric key under the name JavaScript gives it", async () => {
      // A numeric literal's key is its value written in decimal, whatever
      // base or notation the source used.
      const { captured, opaque, output } = await spreadReportsOf(
        spreadOfRecords("const records = { 0x10: log, 1e3: prefix };"),
      );

      expect(captured).toHaveLength(0);
      expect(opaque).toHaveLength(0);
      expect(output).toContain(
        'record({ 16: records.key("16"), 1000: records.key("1000"), log, id })',
      );
    });

    it("reads the keys through a wrapper around the operand", async () => {
      for (
        const operand of [
          "(records)",
          "(records as { log: Writable<string[]>; prefix: Writable<string> })",
          "(records satisfies { log: Writable<string[]> })",
          "records!",
        ]
      ) {
        const { captured, opaque, output } = await spreadReportsOf(
          spreadOfRecords("const records = { log, prefix };", operand),
        );

        expect(captured).toHaveLength(0);
        expect(opaque).toHaveLength(0);
        expect(output).toContain(
          'record({ log: records.key("log"), prefix: records.key("prefix"), log, id })',
        );
      }
    });

    it("reads an object two spreads share, each time it is spread", async () => {
      const twice = await spreadReportsOf(
        spreadOfRecords("const records = { ...base, ...base };"),
      );
      expect(twice.captured).toHaveLength(0);
      expect(twice.output).toContain(
        'record({ log: records.key("log"), prefix: records.key("prefix"), log: records.key("log"), prefix: records.key("prefix"), log, id })',
      );

      const diamond = await spreadReportsOf(spreadOfRecords(`
        const left = { ...base, a: "a" };
        const right = { ...base, b: "b" };
        const records = { ...left, ...right };
      `));
      expect(diamond.captured).toHaveLength(0);
      expect(diamond.output).toContain(
        'record({ log: records.key("log"), prefix: records.key("prefix"), a: records.key("a"), log: records.key("log"), prefix: records.key("prefix"), b: records.key("b"), log, id })',
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

    it("reports a call result through a wrapper around the operand", async () => {
      for (
        const operand of [
          "(records)",
          "(records as { prefix: string })",
          "(records satisfies { prefix: string })",
        ]
      ) {
        const { captured, opaque, output } = await spreadReportsOf(
          spreadOfRecords("const records = makePlain();", operand),
        );

        expect(captured).toHaveLength(1);
        expect(opaque).toHaveLength(0);
        // The printer reflows a wrapper's type, so only its start is matched.
        expect(output).toContain("...(records");
      }
    });

    it("reports an alias of a binding that is not a `const` with known keys", async () => {
      const { captured, output } = await spreadReportsOf(
        spreadOfRecords("const records = prefix;"),
      );

      expect(captured).toHaveLength(1);
      expect(output).toContain("...records");
    });

    it("reports a literal with an accessor", async () => {
      // What an accessor yields is not a key the literal's text settles.
      const { captured, output } = await spreadReportsOf(
        spreadOfRecords(
          "const records = { log, get prefix() { return prefix; } };",
        ),
      );

      expect(captured).toHaveLength(1);
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

  // The one-report rule is for a spread two stages both see. Two different
  // errors on one node are each made.
  describe("leaves other computation errors on one node distinct", () => {
    it("reports a non-static default and a rest element of one parameter", async () => {
      const messages = await computationErrorsOf(`
        import { pattern } from "commonfabric";

        const getDefault = () => 42;
        export default pattern<{ a?: number; b: string }>(
          ({ a = getDefault(), ...rest }) => ({ a, rest }),
        );
      `);

      expect(new Set(messages).size).toBe(2);
    });

    it("reports a default and a rest element of one opaque local binding", async () => {
      const messages = await computationErrorsOf(`
        import { pattern } from "commonfabric";

        export default pattern<{ record: { a?: number; b: string } }>(
          ({ record }) => {
            const { a = 1, ...rest } = record;
            return { a, rest };
          },
        );
      `);

      expect(new Set(messages).size).toBe(2);
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
