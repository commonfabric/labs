/**
 * Pins the refusal `cf piece call` gives a payload carrying a field the verb's
 * event schema does not declare: which positions it fires at, the wording a
 * caller reads, and — in equal measure — the positions it passes over, each
 * asserted as the call still dispatching.
 *
 * The gate itself is `verbInputSchemaError` (../lib/callable.ts). What is
 * driven here is the whole path a caller takes to it, so the refusal is pinned
 * against schemas the transformer emits rather than against hand-built ones
 * that could only assert back what this file assumed.
 */

import { describe, it } from "@std/testing/bdd";
import { resolvedSchema } from "../../runner/test/schema-ref-helpers.ts";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  eventSchemaJudgesRootFields,
  executeResolvedCallable,
  undeclaredVerbFieldError,
  verbInputSchemaError,
  VerbInputValidationError,
} from "../lib/callable.ts";
import { executePieceCallable } from "../lib/piece.ts";

/**
 * Dispatch `payload` at a verb publishing `schema`, through the same
 * pre-dispatch gate `cf piece call` runs, and hand back what reached the
 * stream.
 *
 * A position the walk passes over has to be asserted as the call DISPATCHING,
 * not as the refusal being absent. Those are different facts, and only the
 * first one fails when a branch that fails open starts failing closed — which
 * on this feature means refusing a call that should have gone out. Reading the
 * dispatched value back states it: the payload reached the stream, and reached
 * it whole.
 */
async function dispatchedPayload(
  schema: JSONSchema,
  payload: unknown,
): Promise<unknown> {
  let sent: unknown;
  const callableCell = {
    schema,
    get: () => ({ $stream: true }),
    getRaw: () => ({ $stream: true }),
    getAsNormalizedFullLink: () => ({ scope: "space" }),
    send: (value: unknown, onCommit?: (tx: unknown) => void) => {
      sent = value;
      onCommit?.({ status: () => ({ status: "ok" }) });
    },
  };
  await executeResolvedCallable({
    callableCell: callableCell as never,
    callableKind: "handler",
    cellKey: "probe",
    pieces: { runtime: {} } as never,
    space: "did:key:undeclared-field-probe" as never,
    inputSchema: schema,
  }, payload);
  return sent;
}

/**
 * A list whose verbs cover the positions a payload can put a field in: the
 * event root, an object below it, and an element of an array below that.
 *
 * Driven against a COMPILED, RUN pattern rather than a hand-built schema,
 * because the shape the refusal keys on is one the TRANSFORMER emits. It emits
 * an event schema naming the fields the handler body READS — `done` and `id`
 * are in the interfaces below and reach the schema only because the bodies
 * touch them — so a hand-written schema would assert back whatever this test
 * assumed rather than what a real verb declares.
 *
 * `ping` is the verb that declares nothing: its event type names no field, and
 * what the transformer emits for it is no schema at all.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, NAME, pattern, type PatternFactory, type Stream, Writable } from "commonfabric";',
      "",
      "interface AddItemEvent { title: string; done: boolean; }",
      "interface Recorded { entry: string; }",
      "interface RenameEvent { item: { id: string; label: string }; }",
      "interface TagEvent { tags: { name: string }[]; }",
      "type PingEvent = Record<string, never>;",
      "",
      "export interface ListOutput {",
      "  addItem: Stream<AddItemEvent, Recorded>;",
      "  rename: Stream<RenameEvent, Recorded>;",
      "  tag: Stream<TagEvent, Recorded>;",
      "  ping: Stream<PingEvent, Recorded>;",
      "  entries: string[];",
      "  [NAME]: string;",
      "}",
      "",
      "interface ListInput { label?: string; }",
      "",
      "export const List: PatternFactory<ListInput, ListOutput> = pattern<ListInput, ListOutput>(",
      "  () => {",
      "    const entries = new Writable<string[]>([]);",
      "    const addItem = action<AddItemEvent, Recorded>((event) => {",
      "      const entry = JSON.stringify({ title: event.title, done: event.done });",
      "      entries.push(entry);",
      "      return { entry };",
      "    });",
      "    const rename = action<RenameEvent, Recorded>((event) => {",
      "      const entry = JSON.stringify({ id: event.item?.id, label: event.item?.label });",
      "      entries.push(entry);",
      "      return { entry };",
      "    });",
      "    const tag = action<TagEvent, Recorded>((event) => {",
      "      const entry = JSON.stringify((event.tags ?? []).map((tag) => tag.name));",
      "      entries.push(entry);",
      "      return { entry };",
      "    });",
      "    const ping = action<PingEvent, Recorded>(() => {",
      "      entries.push('ping');",
      "      return { entry: 'ping' };",
      "    });",
      "    return { [NAME]: 'List', entries, addItem, rename, tag, ping };",
      "  },",
      ");",
      "",
      "export default List;",
    ].join("\n"),
  }],
};

/**
 * Two verbs whose event schemas are written out rather than derived from a
 * TypeScript event type, which is how a pattern reaches the object shapes the
 * transformer never emits: a `properties` map with no `type` beside it, and a
 * conjunction holding one.
 */
const EXPLICIT_SCHEMA_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { handler, NAME, pattern, schema, type Stream } from "commonfabric";',
      'import "commonfabric/schema";',
      "",
      "interface Output {",
      "  [NAME]: string;",
      "  count: number;",
      "  bare: Stream<{ title: string }>;",
      "  conjunct: Stream<{ title: string }>;",
      "}",
      "",
      "interface Input { count: number; }",
      "",
      "const model = schema({",
      "  type: 'object',",
      "  properties: { count: { type: 'number', default: 0, asCell: ['cell'] } },",
      "  default: { count: 0 },",
      "});",
      "",
      "const bare = handler(",
      "  { properties: { title: { type: 'string' } } } as const,",
      "  model,",
      "  (_event, state) => { state.count.set(state.count.get() + 1); },",
      ");",
      "",
      "const conjunct = handler(",
      "  { allOf: [{ type: 'object', properties: { title: { type: 'string' } } }] } as const,",
      "  model,",
      "  (_event, state) => { state.count.set(state.count.get() + 1); },",
      ");",
      "",
      "export default pattern<Input, Output>((state) => ({",
      "  [NAME]: 'Explicit',",
      "  count: state.count,",
      "  bare: bare(state),",
      "  conjunct: conjunct(state),",
      "}), model);",
    ].join("\n"),
  }],
};

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:live",
  space: "" as string,
};

interface Tracker {
  /** Dispatch `verb` the way `cf piece call` does, with `payload` spelled as
   * the one positional JSON argument a caller writes by hand. */
  call: (
    verb: string,
    payload: unknown,
    invocationId?: string,
  ) => Promise<{ id: string; status: string; deduplicated?: boolean }>;

  /** What the handlers recorded, read off the cell rather than through any
   * rendering, so it says what the handler actually received. */
  entries: () => string[];

  root: Cell<any>;
}

/** Run `program` and hand a driver to `body`. */
async function withProgram<T>(
  passphrase: string,
  program: typeof PROGRAM,
  body: (tracker: Tracker) => Promise<T>,
): Promise<T> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      program as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, "undeclared-field", undefined, tx);
    const root = runtime.run(tx, compiled, {}, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await root.pull();

    const piece = {
      result: { getCell: () => Promise.resolve(root) },
      input: { getCell: () => Promise.resolve(root) },
      getCell: () => root,
      getPattern: () => Promise.resolve(compiled),
    };
    const deps = {
      loadPieces: () =>
        Promise.resolve({ getSpace: () => space, runtime } as never),
      loadPiece: () => Promise.resolve(piece as never),
    };

    let dispatched = 0;
    return await body({
      root,
      entries: () => (root.key("entries").get() ?? []) as unknown as string[],
      call: async (verb, payload, invocationId) => {
        dispatched++;
        const executed = await executePieceCallable(
          { ...CONFIG, space },
          verb,
          ["--json", JSON.stringify(payload)],
          {
            ...deps,
            invocation: {
              id: invocationId ?? `inv-${dispatched}`,
              session: "sess",
            },
          } as never,
        );
        return executed.invocation as never;
      },
    });
  } finally {
    await runtime.dispose?.();
    await storageManager.close?.();
  }
}

/** Run the list program above and hand a driver to `body`. */
function withList<T>(
  passphrase: string,
  body: (tracker: Tracker) => Promise<T>,
): Promise<T> {
  return withProgram(passphrase, PROGRAM, body);
}

describe("verb-undeclared-field", () => {
  describe("undeclaredVerbFieldError()", () => {
    const addItem: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" }, done: { type: "boolean" } },
      required: ["title"],
    };

    it("names the field, the position it sat at, and the vocabulary that position takes", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, addItem),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title", "done"',
        );
    });

    it("suggests the declared field a misspelling is one edit from", () => {
      expect(undeclaredVerbFieldError({ titel: "Milk" }, addItem)).toBe(
        '"titel" at <event> is not a field this verb declares. ' +
          'Did you mean "title"? <event> takes "title", "done"',
      );
    });

    it("counts an adjacent transposition as one edit", () => {
      // A transposition is one slip to the caller who made it, whatever it
      // costs to spell as substitutions, and the threshold for a four-character
      // key is one edit.

      expect(undeclaredVerbFieldError({ doen: true }, addItem)).toMatch(
        /Did you mean "done"\?/,
      );
    });

    it("returns `undefined` for a payload carrying exactly the declared fields", () => {
      expect(undeclaredVerbFieldError({ title: "Milk", done: true }, addItem))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ title: "Milk" }, addItem))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({}, addItem)).toBeUndefined();
    });

    it("returns `undefined` where the verb declares no schema", () => {
      expect(undeclaredVerbFieldError({ anything: 1 }, undefined))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ anything: 1 }, true)).toBeUndefined();
    });

    it("returns `undefined` for an object schema stating no `properties`", () => {
      // A position with no property map is open by construction: the runtime
      // delivers the whole payload there, so nothing is dropped and nothing is
      // refused.

      expect(undeclaredVerbFieldError({ anything: 1 }, { type: "object" }))
        .toBeUndefined();
    });

    it("refuses every field against an explicitly empty `properties` map", () => {
      // The other reading of "declares no fields": an explicit empty map, which
      // the runtime answers by delivering nothing at all. Every field a caller
      // writes there is refused, and there is no vocabulary to offer instead.

      expect(
        undeclaredVerbFieldError({ title: "Milk" }, {
          type: "object",
          properties: {},
        }),
      ).toBe(
        '"title" at <event> is not a field this verb declares. ' +
          "<event> declares no fields at all",
      );
    });

    it("returns `undefined` where the position declares `additionalProperties`", () => {
      // `additionalProperties` is what makes the runtime deliver a field no map
      // names, so a position carrying one honors what it is sent.

      for (const additionalProperties of [true, {}, { type: "string" }]) {
        expect(
          undeclaredVerbFieldError({ title: "Milk", colour: "red" }, {
            ...addItem,
            additionalProperties,
          } as JSONSchema),
        ).toBeUndefined();
      }
    });

    it("names a nested object position", () => {
      // The position half of the message is load-bearing: a field goes missing
      // wherever its enclosing position drops what it does not name, not only
      // at the root.

      expect(
        undeclaredVerbFieldError({ item: { id: "1", lable: "Milk" } }, {
          type: "object",
          properties: {
            item: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
            },
          },
        }),
      ).toBe(
        '"lable" at <event>.item is not a field this verb declares. ' +
          'Did you mean "label"? <event>.item takes "id", "label"',
      );
    });

    it("names an array element by its index", () => {
      expect(
        undeclaredVerbFieldError({
          tags: [{ name: "a" }, { name: "b", colour: "red" }],
        }, {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        }),
      ).toBe(
        '"colour" at <event>.tags[1] is not a field this verb declares. ' +
          '<event>.tags[1] takes "name"',
      );
    });

    it("resolves the top-level `$ref` a stream schema wraps its event in", () => {
      expect(
        undeclaredVerbFieldError({ titel: "Milk" }, {
          $ref: "#/$defs/AddItem",
          asCell: ["stream"],
          $defs: {
            AddItem: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        } as JSONSchema),
      ).toMatch(/"titel" at <event> .* Did you mean "title"\?/);
    });

    it("returns `undefined` inside a position marked `asCell`", () => {
      // Below the root a marked position is where a caller may write a link
      // instead of a value, and `"/"` is not a field anybody declared.

      const schema: JSONSchema = {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { n: { type: "number" } },
            asCell: ["cell"],
          },
        },
      };
      expect(undeclaredVerbFieldError({ target: { n: 1, extra: 2 } }, schema))
        .toBeUndefined();
      expect(
        undeclaredVerbFieldError(
          { target: { "/": { id: "of:abc", path: [], space: "did:x:y" } } },
          schema,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` at a position carrying a combinator", () => {
      // A payload need satisfy only one branch of a disjunction, and schema
      // traversal unions the branches before deciding which children exist, so
      // a field only one branch names is one the runtime still delivers.

      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, {
          type: "object",
          properties: { title: { type: "string" } },
          anyOf: [
            { required: ["title"] },
            {
              type: "object",
              properties: { colour: { type: "string" } },
            },
          ],
        } as JSONSchema),
      ).toBeUndefined();
    });
  });

  describe('an object-shaped position with no explicit `type: "object"`', () => {
    // Every shape `schemaIsObjectShaped` recognizes drops what its maps do not
    // name, so every one of them is judged. An explicit `type: "object"` is
    // only the most common of the four.

    const bareProperties: JSONSchema = {
      properties: { title: { type: "string" } },
    } as JSONSchema;
    const conjunction: JSONSchema = {
      allOf: [{ type: "object", properties: { title: { type: "string" } } }],
    } as JSONSchema;
    const typeUnion: JSONSchema = {
      type: ["object", "null"],
      properties: { title: { type: "string" } },
    } as JSONSchema;

    it("refuses an undeclared field against a bare `properties` map", () => {
      expect(
        undeclaredVerbFieldError(
          { title: "Milk", colour: "red" },
          bareProperties,
        ),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("refuses an undeclared field against a conjunction", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, conjunction),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("refuses an undeclared field against a type union admitting an object", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, typeUnion),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("takes the fields a conjunction declares as the union across its members", () => {
      // A payload satisfying a conjunction satisfies every member, so the
      // fields it declares are the union across them.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [
          { properties: { body: { type: "string" } } },
          { $ref: "#/$defs/Signed" },
        ],
        $defs: {
          Signed: {
            type: "object",
            properties: { agentName: { type: "string" } },
          },
        },
      } as JSONSchema;
      expect(
        undeclaredVerbFieldError(
          { title: "Milk", body: "b", agentName: "Sol" },
          schema,
        ),
      ).toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body", "agentName"',
      );
    });

    it("takes nothing from a conjunction member that is a boolean schema", () => {
      // A member spelled `true` constrains nothing and declares nothing, so the
      // rest of the conjunction is the whole vocabulary.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [true, { properties: { body: { type: "string" } } }],
      } as JSONSchema;
      expect(undeclaredVerbFieldError({ title: "Milk", body: "b" }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body"',
      );
    });

    it("takes the fields of a conjunction that names itself, once", () => {
      // A definition whose conjunction names itself contributes its fields once
      // and terminates, which is what lets a recursive event schema be judged
      // at all.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [{ $ref: "#/$defs/Loop" }],
        $defs: {
          Loop: {
            type: "object",
            properties: { body: { type: "string" } },
            allOf: [{ $ref: "#/$defs/Loop" }],
          },
        },
      } as JSONSchema;
      expect(undeclaredVerbFieldError({ title: "Milk", body: "b" }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body"',
      );
    });

    it("refuses an undeclared field inside a type union admitting an array", () => {
      // The array counterpart of the object type union: schema traversal
      // descends the array branch, so the element's undeclared field goes
      // missing there.

      expect(
        undeclaredVerbFieldError({ tags: [{ name: "a", colour: "red" }] }, {
          type: "object",
          properties: {
            tags: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        } as JSONSchema),
      ).toBe(
        '"colour" at <event>.tags[0] is not a field this verb declares. ' +
          '<event>.tags[0] takes "name"',
      );
    });

    it("dispatches a declared payload against a bare `properties` map", async () => {
      const payload = { title: "Milk" };
      expect(await dispatchedPayload(bareProperties, payload)).toEqual(payload);
    });

    it("dispatches a declared payload against a conjunction", async () => {
      const payload = { title: "Milk" };
      expect(await dispatchedPayload(conjunction, payload)).toEqual(payload);
    });

    it("dispatches an undeclared field where a conjunction holds a disjunction", async () => {
      // A disjunction inside a conjunction makes the whole position honor
      // everything: the branch a payload was meant for may name a field the
      // others do not.

      const schema = {
        allOf: [
          { type: "object", properties: { title: { type: "string" } } },
          {
            anyOf: [
              { type: "object", properties: { colour: { type: "string" } } },
              { type: "object", properties: { size: { type: "string" } } },
            ],
          },
        ],
      } as JSONSchema;
      const payload = { title: "Milk", colour: "red" };
      expect(await dispatchedPayload(schema, payload)).toEqual(payload);
    });

    it("refuses an undeclared field inside an untyped `items` position", () => {
      // An untyped position naming `items` describes an array the same way an
      // untyped position naming `properties` describes an object.

      expect(
        undeclaredVerbFieldError({ tags: [{ name: "a", colour: "red" }] }, {
          type: "object",
          properties: {
            tags: {
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        } as JSONSchema),
      ).toBe(
        '"colour" at <event>.tags[0] is not a field this verb declares. ' +
          '<event>.tags[0] takes "name"',
      );
    });
  });

  describe("a schema that forbids undeclared fields", () => {
    it("refuses the undeclared field rather than letting it be dropped", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: false,
      };
      expect(undeclaredVerbFieldError({ titel: "x" }, schema))
        .toMatch(/"titel" at <event> is not a field this verb declares/);
    });
  });

  describe("eventSchemaJudgesRootFields()", () => {
    // The predicate `cf exec`'s flag door reads to decide whether an
    // unrecognized flag is a misspelling to refuse or a field the schema
    // never undertook to judge. Asserted here rather than through the flag
    // door, because each guard below answers for a schema shape no flag
    // parser can construct on its own.

    it("judges a schema that names fields and admits no others", () => {
      expect(eventSchemaJudgesRootFields({
        type: "object",
        properties: { title: { type: "string" } },
      })).toBe(true);
    });

    it("judges fields a conjunction contributes", () => {
      expect(eventSchemaJudgesRootFields({
        type: "object",
        allOf: [{ type: "object", properties: { count: { type: "number" } } }],
      })).toBe(true);
    });

    it("does not judge a schema naming no fields", () => {
      expect(eventSchemaJudgesRootFields({ type: "object" })).toBe(false);
    });

    it("does not judge a schema welcoming undeclared fields", () => {
      expect(eventSchemaJudgesRootFields({
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: true,
      })).toBe(false);
      // A schema for the extra fields is still permission to send them.
      expect(eventSchemaJudgesRootFields({
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: { type: "string" },
      })).toBe(false);
    });

    it("judges a schema that forbids undeclared fields", () => {
      // `false` is the one value that does NOT welcome them, so reading mere
      // presence of the keyword as permission turns the strictest spelling
      // into the most permissive one. A caller's extra field would then be
      // accepted here, dropped by the runtime, and the call reported settled.
      expect(eventSchemaJudgesRootFields({
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: false,
      })).toBe(true);
    });

    it("does not judge a disjunction", () => {
      // A payload need satisfy only one branch, so no single vocabulary
      // describes the position and refusing against one would refuse what
      // another branch declares. The payload door passes these over too.
      expect(eventSchemaJudgesRootFields({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      })).toBe(false);
      expect(eventSchemaJudgesRootFields({
        oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
      })).toBe(false);
    });

    it("does not judge a position that is not object-shaped", () => {
      expect(eventSchemaJudgesRootFields({ type: "string" })).toBe(false);
    });

    it("does not judge a schema that is not an object at all", () => {
      // `true` admits everything and `undefined` says nothing was published;
      // neither names a field, so neither can call one undeclared.
      expect(eventSchemaJudgesRootFields(true)).toBe(false);
      expect(eventSchemaJudgesRootFields(undefined)).toBe(false);
    });

    it("does not judge a reference that resolves to nothing", () => {
      // A `$ref` naming a definition the document does not carry resolves to
      // no schema, which is not a shape that can judge anything.
      expect(eventSchemaJudgesRootFields({ $ref: "#/$defs/Absent" }))
        .toBe(false);
    });

    it("does not judge a reference resolving to something that is not an object", () => {
      // `true` admits any value, so the definition names no fields; the walk
      // has to read what the reference RESOLVES to rather than the reference,
      // which carries no `properties` of its own either way.
      expect(eventSchemaJudgesRootFields({
        $ref: "#/$defs/Anything",
        $defs: { Anything: true },
      })).toBe(false);
    });
  });

  describe("a position the walk cannot judge", () => {
    // Positions the walk cannot judge, each asserted as the call GOING OUT
    // rather than as no refusal coming back. The two are different facts, and
    // only the first one states that a caller can still make the call.

    it("dispatches an array whose elements all carry declared fields", async () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      };
      const payload = { tags: [{ name: "urgent" }, { name: "kitchen" }] };
      expect(await dispatchedPayload(schema, payload)).toEqual(payload);
    });

    it("dispatches an array element whose position declares no schema", async () => {
      // No `items` beside the `type: "array"`, so the element has no schema and
      // nothing there declares anything. The runtime delivers the element
      // whole.

      const schema: JSONSchema = {
        type: "object",
        properties: { tags: { type: "array" } },
      };
      const payload = { tags: [{ name: "urgent", colour: "red" }] };
      expect(await dispatchedPayload(schema, payload)).toEqual(payload);
    });

    it("dispatches a position whose `$ref` resolves to a boolean schema", async () => {
      // A `$ref` naming a definition spelled `true` resolves to the wildcard
      // schema, which declares nothing and refuses nothing.

      const schema = {
        type: "object",
        properties: { detail: { $ref: "#/$defs/Anything" } },
        $defs: { Anything: true },
      } as JSONSchema;
      const payload = { detail: { shape: "unconstrained", n: 1 } };
      expect(await dispatchedPayload(schema, payload)).toEqual(payload);
    });

    it("dispatches a position whose `asCell` marker rides the `$ref` target", async () => {
      // The marker rides the DEFINITION rather than the reference site, so it
      // is reached only after the reference resolves.

      const schema = {
        type: "object",
        properties: { target: { $ref: "#/$defs/Target" } },
        $defs: {
          Target: {
            type: "object",
            properties: { n: { type: "number" } },
            asCell: ["cell"],
          },
        },
      } as JSONSchema;
      const payload = { target: { n: 1, extra: 2 } };
      expect(await dispatchedPayload(schema, payload)).toEqual(payload);
    });
  });

  describe("verbInputSchemaError()", () => {
    const addItem: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };

    it("reports the undeclared field ahead of the required one it displaced", () => {
      // Both refusals hold for this payload: `title` is missing and `titel` is
      // undeclared. Only one of the two answers names something the caller
      // wrote, and that is the one they get.

      expect(verbInputSchemaError({ titel: "Milk" }, addItem)).toBe(
        '"titel" at <event> is not a field this verb declares. ' +
          'Did you mean "title"? <event> takes "title"',
      );
    });

    it("returns `undefined` for a payload carrying exactly the declared fields", () => {
      expect(verbInputSchemaError({ title: "Milk" }, addItem)).toBeUndefined();
    });

    it("still reports a declared field of the wrong type", () => {
      expect(verbInputSchemaError({ title: 7 }, addItem)).toMatch(/title/);
    });
  });

  describe("cf piece call against a live verb", () => {
    it("declares an event schema naming `properties` with no `additionalProperties`", async () => {
      // The coupling every refusal below rests on: the shape the transformer
      // emits is one that drops what it does not name. The link the verb is
      // reached through declares the stream in front of that shape.
      await withList("undeclared-shape", ({ root }) => {
        expect(resolvedSchema(root.key("addItem").schema)).toEqual({
          asCell: ["stream"],
          type: "object",
          properties: { title: { type: "string" }, done: { type: "boolean" } },
          required: ["title", "done"],
        });
        // A verb declaring no event schema still declares the stream.
        expect(resolvedSchema(root.key("ping").schema)).toEqual({
          asCell: ["stream"],
        });
        return Promise.resolve();
      });
    });

    it("refuses a payload carrying a field the verb does not declare", async () => {
      await withList("undeclared-refused", async ({ call, entries }) => {
        await expect(call("addItem", {
          title: "Milk",
          done: false,
          colour: "red",
        })).rejects.toThrow(VerbInputValidationError);
        // Nothing dispatched, so nothing was recorded: the field was refused
        // rather than dropped on the way in.
        expect(entries()).toEqual([]);
      });
    });

    it("names the verb, the field, the position and the near miss in what the caller reads", async () => {
      await withList("undeclared-message", async ({ call }) => {
        await expect(call("addItem", { titel: "Milk", done: false })).rejects
          .toThrow(
            'Invalid input for "addItem": "titel" at <event> is not a field ' +
              'this verb declares. Did you mean "title"? <event> takes ' +
              '"title", "done"',
          );
      });
    });

    it("names a nested position on a live verb", async () => {
      await withList("undeclared-nested", async ({ call }) => {
        await expect(call("rename", { item: { id: "1", lable: "Milk" } }))
          .rejects.toThrow(
            '"lable" at <event>.item is not a field this verb declares. ' +
              'Did you mean "label"? <event>.item takes "id", "label"',
          );
      });
    });

    it("names an array element position on a live verb", async () => {
      await withList("undeclared-element", async ({ call }) => {
        await expect(
          call("tag", { tags: [{ name: "a" }, { name: "b", colour: "red" }] }),
        ).rejects.toThrow('"colour" at <event>.tags[1] is not a field');
      });
    });

    it("dispatches a payload carrying exactly the declared fields", async () => {
      await withList("undeclared-negative", async ({ call, entries }) => {
        const outcome = await call("addItem", { title: "Milk", done: false });
        expect(outcome.status).toBe("settled");
        expect(entries()).toEqual(['{"title":"Milk","done":false}']);
      });
    });

    it("dispatches every payload at a verb that declares no schema", async () => {
      await withList("undeclared-open", async ({ call, entries }) => {
        const outcome = await call("ping", { anything: 1 });
        expect(outcome.status).toBe("settled");
        expect(entries()).toEqual(["ping"]);
      });
    });

    it("leaves the invocation id spendable by the corrected retry", async () => {
      await withList("undeclared-id", async ({ call, entries }) => {
        await expect(
          call("addItem", { title: "Milk", colour: "red" }, "inv-once"),
        ).rejects.toThrow(VerbInputValidationError);
        const outcome = await call(
          "addItem",
          { title: "Milk", done: false },
          "inv-once",
        );
        expect(outcome.status).toBe("settled");
        expect(outcome.deduplicated).toBeUndefined();
        expect(entries()).toEqual(['{"title":"Milk","done":false}']);
      });
    });
  });

  describe("cf piece call on a verb whose event schema states no `type`", () => {
    // The same two shapes on a running piece, reached through a verb whose
    // event schema the pattern writes out. `count` reads what committed, so a
    // dispatch is stated as the handling landing rather than as the command
    // returning.

    const withExplicit = <T>(
      passphrase: string,
      body: (tracker: Tracker) => Promise<T>,
    ) => withProgram(passphrase, EXPLICIT_SCHEMA_PROGRAM, body);

    it("refuses an undeclared field against a bare `properties` map", async () => {
      await withExplicit("explicit-bare-refused", async ({ call, root }) => {
        await expect(call("bare", { title: "Milk", colour: "red" })).rejects
          .toThrow(
            '"colour" at <event> is not a field this verb declares. ' +
              '<event> takes "title"',
          );
        // Nothing counted: unwritten, the cell has not materialized its
        // default, so an absent count and a zero one are the same fact here.
        expect(root.key("count").get() ?? 0).toBe(0);
      });
    });

    it("refuses an undeclared field against a conjunction", async () => {
      await withExplicit("explicit-allof-refused", async ({ call, root }) => {
        await expect(call("conjunct", { title: "Milk", colour: "red" }))
          .rejects.toThrow(
            '"colour" at <event> is not a field this verb declares. ' +
              '<event> takes "title"',
          );
        // Nothing counted: unwritten, the cell has not materialized its
        // default, so an absent count and a zero one are the same fact here.
        expect(root.key("count").get() ?? 0).toBe(0);
      });
    });

    it("dispatches a declared payload against a bare `properties` map", async () => {
      await withExplicit("explicit-bare-dispatch", async ({ call, root }) => {
        const outcome = await call("bare", { title: "Milk" });
        expect(outcome.status).toBe("settled");
        expect(root.key("count").get()).toBe(1);
      });
    });

    it("dispatches a declared payload against a conjunction", async () => {
      await withExplicit("explicit-allof-dispatch", async ({ call, root }) => {
        const outcome = await call("conjunct", { title: "Milk" });
        expect(outcome.status).toBe("settled");
        expect(root.key("count").get()).toBe(1);
      });
    });
  });

  describe("a reference a caller names", () => {
    const link = {
      "/": {
        "link@1": {
          id: "of:fid1:target",
          space: "did:key:zTest",
          path: [],
          scope: "space",
        },
      },
    };
    // The schema the CLI actually holds: the handler's narrowed read of the
    // event, which carries no `asCell` — so nothing here says the position is
    // a reference, and nothing needs to.
    const narrowed: JSONSchema = {
      type: "object",
      properties: { on: { $ref: "#/$defs/Item" } },
      required: ["on"],
      $defs: {
        Item: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    };

    it("accepts a link at a position carrying no marker at all", () => {
      // The runtime accepts one anywhere (`acceptOpaqueValue: isCellLink`,
      // unconditional), so a CLI that refused it was the stricter of two
      // gates on the same payload.
      expect(verbInputSchemaError({ on: link }, narrowed)).toBeUndefined();
    });

    it("does not read the envelope's own key as an undeclared field", () => {
      // `/` is the envelope's structure, not a name the caller chose. Reading
      // it as a field is what produced `"/" at <event>.on is not a field this
      // verb declares` for every reference ever named.
      expect(verbInputSchemaError({ on: link }, narrowed) ?? "")
        .not.toMatch(/"\/"/);
    });

    it("still refuses a field the verb does not declare, beside a link", () => {
      // Accepting links is not accepting anything.
      expect(verbInputSchemaError({ on: link, titel: "x" }, narrowed))
        .toMatch(/"titel" at <event> is not a field this verb declares/);
    });

    it("still refuses a declared field of the wrong type, beside a link", () => {
      const both: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item" }, count: { type: "number" } },
        required: ["on"],
        $defs: { Item: { type: "object", properties: {} } },
      };
      expect(verbInputSchemaError({ on: link, count: "no" }, both))
        .toMatch(/count/);
    });

    it("accepts the link forms that carry no id", () => {
      // A relative link legitimately has only a path, and an id alone is a
      // complete address. Requiring an `id` would be tighter and wrong.
      expect(verbInputSchemaError(
        { on: { "/": { "link@1": { id: "of:fid1:x" } } } },
        narrowed,
      )).toBeUndefined();
      expect(verbInputSchemaError(
        { on: { "/": { "link@1": { path: ["a"] } } } },
        narrowed,
      )).toBeUndefined();
    });

    it("refuses an envelope whose payload is not a record", () => {
      // `isLink` answers on the envelope's SHAPE and says nothing about what
      // rides inside, so it is true of all three of these. Bypassing the walk
      // on that answer would let malformed data through as a reference and
      // normalize to an empty relative link rather than being refused.
      for (
        const payload of ["nope", [1], null, 42] as const
      ) {
        expect(
          verbInputSchemaError(
            { on: { "/": { "link@1": payload } } },
            narrowed,
          ),
          `payload ${JSON.stringify(payload)} must not pass as a reference`,
        ).toBeDefined();
      }
    });

    it("treats a live cell as opaque without inspecting a payload", async () => {
      // A `Cell` satisfies `isLink` while carrying no envelope at all, so the
      // payload check has nothing to read. It reaches this gate from code
      // rather than from a caller's JSON, and there is nothing to malform.
      const signer = await Identity.fromPassphrase("undeclared-field-cell");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "opaque-probe",
          undefined,
          tx,
        );
        cell.set({ title: "held" });
        await tx.commit();
        expect(verbInputSchemaError({ on: cell }, narrowed)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still refuses a non-link object that does not fit its position", () => {
      // The link is what is opaque, not the position. A plain object at the
      // same place is judged exactly as before.
      expect(verbInputSchemaError({ on: { wrong: 1 } }, narrowed))
        .toMatch(/is not a field this verb declares|title/);
    });
  });
});
