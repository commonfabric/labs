/**
 * Verb listing marks, producer 1 (verb contract WS-F): `VerbTierMarkTransformer`
 * stamps `tier: "wrapper"` onto result-schema stream properties whose handler
 * binds session-scoped state AND takes a void event. The second conjunct is the
 * measured narrowing recorded in current-behavior §12.1: without it the
 * inference marks `topics.addTopic` — a headless verb that merely CLEARS a
 * session composer draft after a create.
 *
 * Sources compile against the real commonfabric surface, through the full
 * pipeline, and the assertions read the emitted result-schema literal — the
 * artifact `cf piece verbs` will consult.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { StaticCache } from "@commonfabric/static";
import { describe, it, test } from "@commonfabric/test-support/test";
import ts from "typescript";

import { transformCfDirective } from "../src/mod.ts";
import { VerbTierMarkTransformer } from "../src/transformers/verb-tier-mark.ts";
import { createInMemoryProgram, transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

async function emit(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

/** The marked/unmarked state of one result-schema property in the output. */
function tierMarked(output: string, property: string): boolean {
  // The result-schema literal renders the property as `<name>: { ... }`;
  // a marked one carries `tier: "wrapper"` inside that literal. Slice from
  // the property name to the next property at the same indentation.
  const start = output.indexOf(`${property}: {`);
  if (start < 0) throw new Error(`property ${property} not found in output`);
  const slice = output.slice(start, start + 400);
  return slice.includes('tier: "wrapper"');
}

test("a void-event action over a session cell is wrapper-tier", async () => {
  const output = await emit(`
    import { action, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface Out {
      draft: PerSession<Writable<string>>;
      openComposer: Stream<void>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const draft = new Writable("");
      const openComposer = action(() => {
        draft.set("");
      });
      return { draft, openComposer };
    });
  `);
  assertEquals(tierMarked(output, "openComposer"), true);
  assertStringIncludes(output, 'tier: "wrapper"');
});

test("a quoted wrapper verb name is marked like a bare one", async () => {
  // Two things at once, both previously untested: the returned property is a
  // STRING-LITERAL name (the inference and mutation passes must agree on
  // static names), and the wrapper is a directly-authored `handler(...)`
  // whose sessionness lives in the APPLICATION binding (signal 2), not in a
  // lowered action's bound-state schema (signal 1).
  const output = await emit(`
    import { handler, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface Out {
      draft: PerSession<Writable<string>>;
      "open-composer": Stream<void>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const draft = new Writable("");
      const openComposer = handler<void, { draft: Writable<string> }>(
        (_event, state) => {
          state.draft.set("");
        },
      );
      return { draft, "open-composer": openComposer({ draft }) };
    });
  `);
  assertEquals(tierMarked(output, '"open-composer"'), true);
});

test("a payload-carrying verb touching a session cell stays unmarked", async () => {
  // The addTopic shape: real event payload, incidental session-draft clear.
  const output = await emit(`
    import { action, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface CreateEvent { title: string; }
    interface Out {
      titles: string[];
      draft: PerSession<Writable<string>>;
      create: Stream<CreateEvent>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const titles = new Writable<string[]>([]);
      const draft = new Writable("");
      const create = action((event: CreateEvent) => {
        titles.push(event.title);
        draft.set("");
      });
      return { titles, draft, create };
    });
  `);
  assertEquals(tierMarked(output, "create"), false);
});

test("a headless verb without session bindings stays unmarked", async () => {
  const output = await emit(`
    import { action, pattern, Stream, type Writable } from "commonfabric";
    interface AddEvent { value: number; }
    interface Out {
      total: number;
      add: Stream<AddEvent>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const total = new Writable(0);
      const add = action((event: AddEvent) => {
        total.set(total.get() + event.value);
      });
      return { total, add };
    });
  `);
  assertEquals(tierMarked(output, "add"), false);
  assertEquals(output.includes('tier: "wrapper"'), false);
});

describe("VerbTierMarkTransformer", () => {
  // These cases run the transformer alone over source already in the shape
  // the stages before it emit: module-scope handler factories with literal
  // schemas, and a pattern call carrying its input and result schemas.

  const libraries = StaticCache.fromFileSystem().getText("types/es2023.d.ts");

  /**
   * The module printed before and after the transformer runs over it. The
   * module declares `bump`, a handler factory whose state schema is
   * session-scoped, and `plain`, one whose state schema is not.
   */
  async function markTiers(
    moduleBody: string,
  ): Promise<{ before: string; after: string }> {
    const program = createInMemoryProgram({
      "/test.ts": transformCfDirective(
        `import { handler, pattern } from "commonfabric";
const bump = handler(false, {
  type: "object",
  properties: { draft: { type: "string", scope: "session" } },
}, (_event: unknown, _state: unknown) => {});
const plain = handler(false, { type: "object" }, () => {});
${moduleBody}`,
      ),
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
      "/cfc.ts": COMMONFABRIC_TYPES["cfc.ts"]!,
      "/lib.d.ts": await libraries,
    }, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS });
    const sourceFile = program.getSourceFile("/test.ts")!;
    const printer = ts.createPrinter();
    const result = ts.transform(sourceFile, [
      new VerbTierMarkTransformer({}).toFactory(program),
    ]);
    try {
      return {
        before: printer.printFile(sourceFile),
        after: printer.printFile(result.transformed[0]!),
      };
    } finally {
      result.dispose();
    }
  }

  /**
   * A pattern returning `go: <go>` with result schema `resultSchema`, whose
   * input schema marks nothing session-scoped.
   */
  function patternReturning(go: string, resultSchema: string): string {
    return `export default pattern((input: any) => {
  const draft = input.draft;
  return { draft, go: ${go} };
}, {
  type: "object",
  properties: { draft: { type: "string" } },
}, ${resultSchema});`;
  }

  const streamResult = `{
  type: "object",
  properties: { go: { asCell: ["stream"] } }
}`;

  it("marks a stream whose handler's state schema is session-scoped", async () => {
    const { before, after } = await markTiers(
      patternReturning("bump({ draft })", streamResult),
    );
    expect(after).toBe(
      before.replace(
        'go: { asCell: ["stream"] }',
        'go: { asCell: ["stream"], tier: "wrapper" }',
      ),
    );
  });

  it("keeps the wrappers around a result schema it marks", async () => {
    const { before, after } = await markTiers(
      patternReturning("bump({ draft })", `(${streamResult} as const)`),
    );
    expect(after).toBe(
      before.replace(
        'go: { asCell: ["stream"] }',
        'go: { asCell: ["stream"], tier: "wrapper" }',
      ),
    );
    expect(after).toContain("} as const)");
  });

  it("marks a stream beside a spread in the result schema's properties", async () => {
    const { before, after } = await markTiers(
      `const extra = {};
${
        patternReturning(
          "bump({ draft })",
          `{
  type: "object",
  properties: { ...extra, go: { asCell: ["stream"] } }
}`,
        )
      }`,
    );
    expect(after).toBe(
      before.replace(
        'go: { asCell: ["stream"] }',
        'go: { asCell: ["stream"], tier: "wrapper" }',
      ),
    );
  });

  describe("leaves the module unchanged", () => {
    const unchanged: Record<string, string> = {
      "for a handler whose state schema is not session-scoped":
        patternReturning(
          "plain({ draft: 1 })",
          streamResult,
        ),
      "for a pattern call without schemas":
        `export default pattern((input: any) => ({ go: bump({ draft: input.draft }) }));`,
      "for a result schema that is not a literal":
        `const result = ${streamResult};
${patternReturning("bump({ draft })", "result")}`,
      "for a result schema without `properties`": patternReturning(
        "bump({ draft })",
        `{ type: "object" }`,
      ),
      "for result schema `properties` that are not a literal":
        `const props = {};
${
          patternReturning(
            "bump({ draft })",
            `{ type: "object", properties: props }`,
          )
        }`,
      "for a property schema that is not a literal": `const goSchema = {};
${
        patternReturning(
          "bump({ draft })",
          `{ type: "object", properties: { go: goSchema } }`,
        )
      }`,
      "for a property schema that is not a stream": patternReturning(
        "bump({ draft })",
        `{ type: "object", properties: { go: { type: "string" } } }`,
      ),
      "for a stream that already has a tier": patternReturning(
        "bump({ draft })",
        `{ type: "object", properties: { go: { asCell: ["stream"], tier: "headless" } } }`,
      ),
      "for names that resolve to each other in a cycle":
        `const first: any = second;
const second: any = first;
${patternReturning("first", streamResult)}`,
      "for a handler whose event schema is not a literal": `const event = false;
const evented = handler(event, {
  type: "object",
  properties: { draft: { type: "string", scope: "session" } },
}, () => {});
${patternReturning("evented({ draft })", streamResult)}`,
    };
    for (const [description, moduleBody] of Object.entries(unchanged)) {
      it(description, async () => {
        const { before, after } = await markTiers(moduleBody);
        expect(after).toBe(before);
      });
    }
  });

  describe("session-scoped bindings in the input schema", () => {
    it("marks a stream whose handler binds a property the input schema marks session-scoped", async () => {
      const { before, after } = await markTiers(
        `export default pattern((input: any) => {
  const draft = input.draft;
  return { go: plain({ draft }) };
}, {
  type: "object",
  properties: { other: {}, draft: { type: "string", scope: "session" } },
}, ${streamResult});`,
      );
      expect(after).toBe(
        before.replace(
          'go: { asCell: ["stream"] }',
          'go: { asCell: ["stream"], tier: "wrapper" }',
        ),
      );
    });

    it("reads no session-scoped names from input schema `properties` that are not a literal", async () => {
      const { before, after } = await markTiers(
        `const props = {};
export default pattern((input: any) => {
  const draft = input.draft;
  return { go: plain({ draft }) };
}, { type: "object", properties: props }, ${streamResult});`,
      );
      expect(after).toBe(before);
    });
  });
});
