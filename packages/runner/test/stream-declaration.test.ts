import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isStream } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";
import {
  createLLMFriendlyLink,
  getDerivedInternalCell,
  getMetaLink,
  KeepAsCell,
  ownerStreamSchema,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type ExternalReferenceResolver,
  externalReferenceResolverOver,
} from "../src/cfc/schema-primitives.ts";
import { declaredHandleKind } from "../src/stream-declaration.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("stream-declaration");
const space = signer.did();

// The result type names `count` alone, so the result schema says nothing
// about `bump`: a reader reaching it has only the stored links to go on.
const COUNTER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Record<string, never>, { count: Writable<number> }>(",
  "  () => {",
  "    const count = new Writable<number>(0).for('count');",
  "    return { count, bump: bump({ count }) };",
  "  },",
  ");",
  "",
].join("\n");

// `onPick` is forwarded into a sub-pattern through `.map`, which hands the
// sub-pattern's result back the same stream under another name.
const PICKER = [
  "import { Stream, Writable, handler, pattern } from 'commonfabric';",
  "interface Row { id: string }",
  "const Item = pattern<{ row: Row; onPick: Stream<{ id: string }> }>(",
  "  ({ row, onPick }) => ({ row, pick: onPick }),",
  ");",
  "const pick = handler<{ id: string }, { picked: Writable<string[]> }>(",
  "  ({ id }, { picked }) => {",
  "    picked.set([...(picked.get() ?? []), id]);",
  "  },",
  ");",
  "export default pattern<Record<string, never>>(() => {",
  "  const picked = new Writable<string[]>([]).for('picked');",
  "  const rows = new Writable<Row[]>([{ id: 'a' }, { id: 'b' }]).for('rows');",
  "  const onPick = pick({ picked });",
  "  return { picked, items: rows.map((row) => Item({ row, onPick })) };",
  "});",
  "",
].join("\n");

// Each conditional builtin selects a handler that belongs to a sub-pattern,
// so the stream is reached through that sub-pattern's stored result link.
const GATED = [
  "import {",
  "  Writable, handler, ifElse, pattern, unless, when,",
  "} from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "const Counter = pattern<Record<string, never>>(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "export default pattern<Record<string, never>>(() => {",
  "  const on = new Writable<boolean>(true).for('on');",
  "  const off = new Writable<boolean>(false).for('off');",
  "  const counter = Counter({});",
  "  return {",
  "    count: counter.count,",
  "    viaIfElse: ifElse(on, counter.bump, undefined),",
  "    viaWhen: when(on, counter.bump),",
  "    viaUnless: unless(off, counter.bump),",
  "  };",
  "});",
  "",
].join("\n");

// A builtin's handler, exposed under another name.
const DIALOG = [
  "import { Writable, llmDialog, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>>(() => {",
  "  const messages = new Writable<any[]>([]).for('messages');",
  "  const dialog = llmDialog({ messages });",
  "  return { cancel: dialog.cancelGeneration };",
  "});",
  "",
].join("\n");

// The same three builtins selecting the pattern's own handler, whose stream
// is one hop from the builtin's inputs with no stored result link between.
const GATED_OWN = [
  "import {",
  "  Writable, handler, ifElse, pattern, unless, when,",
  "} from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Record<string, never>>(() => {",
  "  const on = new Writable<boolean>(true).for('on');",
  "  const off = new Writable<boolean>(false).for('off');",
  "  const count = new Writable<number>(0).for('count');",
  "  const own = bump({ count });",
  "  return {",
  "    count,",
  "    viaIfElse: ifElse(on, own, undefined),",
  "    viaWhen: when(on, own),",
  "    viaUnless: unless(off, own),",
  "  };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

const asCellKindOf = (schema: JSONSchema | undefined) =>
  ContextualFlowControl.getAsCellKind(
    ContextualFlowControl.getAsCellValues(schema).at(0),
  );

describe("stream declaration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt.dispose();
    await storageManager?.close();
  });

  const runProgram = async (source: string, cause: string) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(programOf(source), {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, pattern, {}, cell);
    await tx.commit();
    await running.pull();
    return { pattern, cell };
  };

  const countOf = (cell: Cell<Record<string, unknown>>) =>
    (cell.getAsQueryResult() as { count: number }).count;

  it("declares a handler's stream in its owner's manifest link, and leaves the stream's document with only its back-link", async () => {
    const { pattern, cell } = await runProgram(COUNTER, "counter");
    const descriptor = (pattern.derivedInternalCells ?? []).find((candidate) =>
      asCellKindOf(candidate.schema) === "stream"
    );
    expect(descriptor).toBeDefined();
    const stream = getDerivedInternalCell(cell, descriptor!);
    expect(stream.getRaw()).toBeUndefined();
    expect(getMetaLink(stream, "result")).toBeDefined();
    expect(stream.getMetaRaw("schema")).toBeUndefined();

    const manifest = cell.getMetaRaw("internal") as { link: unknown }[];
    const streamId = stream.getAsNormalizedFullLink().id;
    const entry = manifest
      .map(({ link }) => parseLink(link, cell))
      .find((link) => link?.id === streamId);
    expect(entry).toBeDefined();
    expect(ContextualFlowControl.declaresStream(entry!.schema)).toBe(true);
  });

  it("resolves a result field to a stream through its stored link alone", async () => {
    const { cell } = await runProgram(COUNTER, "counter-links");
    const bump = cell.key("bump");
    expect(isStream(bump)).toBe(true);
    const view = cell.getAsQueryResult() as {
      bump: { send: (event: unknown) => void };
    };
    expect(typeof view.bump.send).toBe("function");
    const before = countOf(cell);
    view.bump.send({});
    await cell.pull();
    expect(countOf(cell)).toBe(before + 1);
  });

  it("keeps a stream forwarded into a mapped sub-pattern dispatchable", async () => {
    const { cell } = await runProgram(PICKER, "picker");
    await rt.idle();
    const pick = cell.key("items").key(0).key("pick");
    expect(isStream(pick)).toBe(true);
    (pick as unknown as { send: (event: unknown) => void }).send({ id: "a" });
    await cell.pull();
    expect(cell.key("picked").get()).toEqual(["a"]);
  });

  it("keeps a handle re-created from its serialized reference a stream", async () => {
    // A client holds a stream as the reference the handle serialized to, and
    // sends by re-creating a cell from it: nothing of the handle's kind
    // survives the trip, only the reference's schema.
    const { cell } = await runProgram(COUNTER, "counter-reference");
    const view = cell.asSchema({
      type: "object",
      properties: {
        count: { type: "number" },
        bump: { asCell: ["stream"] },
      },
    }).get() as unknown as { bump: Cell<unknown> };
    const reference = view.bump.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    });

    const recreated = rt.getCellFromLink(parseLink(reference, cell)!);
    expect(isStream(recreated)).toBe(true);
    const before = countOf(cell);
    const tx = rt.edit();
    recreated.withTx(tx).send({});
    await tx.commit();
    await cell.pull();
    expect(countOf(cell)).toBe(before + 1);
    expect(recreated.getRaw()).toBeUndefined();
    await rt.storageManager.synced();
  });

  describe("a reader whose schema types a stream's position as something else", () => {
    // A consumer that types another piece's handler loosely still reaches it
    // to send: the link that names a stream declares it whatever shape the
    // reader brought, since the document behind it holds nothing to shape.
    for (
      const [label, position] of [
        ["`unknown`", { type: "unknown" }],
        ["an object", { type: "object" }],
      ] as const
    ) {
      it(`hands a reader typing it as ${label} the stream`, async () => {
        const { cell } = await runProgram(COUNTER, `counter-typed-${label}`);
        const view = cell.asSchema({
          type: "object",
          properties: { count: { type: "number" }, bump: position },
          required: ["bump"],
        } as JSONSchema).get() as unknown as { bump: Cell<unknown> };

        expect(view).toBeDefined();
        expect(isStream(view.bump)).toBe(true);
        const before = countOf(cell);
        view.bump.send({});
        await cell.pull();
        expect(countOf(cell)).toBe(before + 1);
        await rt.storageManager.synced();
      });
    }

    it("refuses a reader asking for a plain cell", async () => {
      // The reader named the kind of endpoint it wants, and a stream is not
      // one: a mismatch, which drops an optional position, and not a reason to
      // hand over a stream of cells. `combine-schema.test.ts` holds the rule
      // itself, for both spellings of the reader.
      const { cell } = await runProgram(COUNTER, "counter-cell");
      const view = cell.asSchema({
        type: "object",
        properties: {
          count: { type: "number" },
          bump: { asCell: ["cell"] },
        },
      } as JSONSchema).get() as unknown as { count: number; bump: unknown };

      expect(view.count).toBe(0);
      expect(view.bump).toBeUndefined();
    });

    it("hands a reader that declares the stream its handle", async () => {
      const { cell } = await runProgram(COUNTER, "counter-declared");
      const view = cell.asSchema({
        type: "object",
        properties: {
          count: { type: "number" },
          bump: { asCell: ["stream"] },
        },
        required: ["bump"],
      } as JSONSchema).get() as unknown as { bump: Cell<unknown> };

      expect(isStream(view.bump)).toBe(true);
    });

    for (const mode of ["eager", "lazy"] as const) {
      it(
        `hands a reader offering both a cell and a stream the stream, on ${
          mode === "lazy" ? "a lazy" : "an eager"
        } read`,
        async () => {
          // A view node's prop schema is this union. The plain-cell branch is a
          // mismatch against a stream, which leaves the stream branch to apply;
          // committing to the first handle branch would drop the handler.
          const { cell } = await runProgram(COUNTER, `counter-union-${mode}`);
          const tx = rt.edit();
          if (mode === "lazy") tx.markLazyMaterialize(true);
          const view = cell.withTx(tx).asSchema({
            type: "object",
            properties: {
              count: { type: "number" },
              bump: {
                anyOf: [
                  { type: "string" },
                  { asCell: ["cell"] },
                  { asCell: ["stream"] },
                ],
              },
            },
          } as JSONSchema).get() as unknown as { bump: unknown };

          expect(isStream(view.bump)).toBe(true);
          tx.abort();
        },
      );
    }
  });

  describe("a required stream the data does not name", () => {
    // A stream position is absent from stored data by design, so a reader
    // that requires one reads an object that lacks the key. Both read modes
    // have to stand the declaration in for it, however it is spelled.
    const inline = {
      type: "object",
      required: ["events"],
      properties: { events: { asCell: ["stream"], type: "number" } },
    } as JSONSchema;
    const referenced = {
      type: "object",
      required: ["events"],
      properties: { events: { $ref: "#/$defs/Event" } },
      $defs: { Event: { asCell: ["stream"], type: "number" } },
    } as JSONSchema;

    // Two branches naming one definition: the second visit to `Event` is a
    // sibling's, not a cycle.
    const shared = {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          anyOf: [
            { $ref: "#/$defs/Event", description: "one" },
            { $ref: "#/$defs/Event", description: "two" },
          ],
        },
      },
      $defs: { Event: { asCell: ["stream"], type: "number" } },
    } as JSONSchema;

    for (
      const [spelling, schema] of [
        ["inline", inline],
        ["through a local `$ref`", referenced],
        ["through two local `$ref`s to one definition", shared],
      ] as const
    ) {
      for (const mode of ["eager", "lazy"] as const) {
        it(`materializes its handle, declared ${spelling}, on ${mode === "lazy" ? "a lazy" : "an eager"} read`, async () => {
          const holder = rt.getCell(space, `holder-${spelling}-${mode}`);
          await rt.editWithRetry((tx) => holder.withTx(tx).setRaw({}));

          const tx = rt.edit();
          if (mode === "lazy") tx.markLazyMaterialize(true);
          const view = holder.withTx(tx).asSchema(schema).get() as unknown as {
            events: unknown;
          };
          expect(view).toBeDefined();
          expect(isStream(view.events)).toBe(true);
          tx.abort();
        });
      }
    }
  });

  it("does not tell union branches apart by a required stream", async () => {
    // The exemption that lets a required stream be absent from the data also
    // holds inside a union's branches, so branches that differ only by one
    // all match: `anyOf` merges them and mints a handle for each branch's
    // stream, the second of which addresses a position no handler is
    // registered on. Pinned as the limitation it is; discriminating such
    // branches by whether the data names the stream is a follow-up.
    const { cell } = await runProgram(COUNTER, "counter-union");
    const view = cell.asSchema({
      anyOf: [
        {
          type: "object",
          required: ["bump"],
          properties: { bump: { asCell: ["stream"] } },
        },
        {
          type: "object",
          required: ["poke"],
          properties: { poke: { asCell: ["stream"] } },
        },
      ],
    } as JSONSchema).get() as unknown as { bump: unknown; poke: unknown };
    expect(isStream(view.bump)).toBe(true);
    expect(isStream(view.poke)).toBe(true);
  });

  describe("a declaration read through references", () => {
    const event = { asCell: ["stream"], type: "number" } as JSONSchema & object;

    it("reads a definition once for each branch that names it", () => {
      expect(ContextualFlowControl.declaresStream({
        anyOf: [
          { $ref: "#/$defs/Event", description: "one" },
          { $ref: "#/$defs/Event", description: "two" },
        ],
        $defs: { Event: event },
      })).toBe(true);
    });

    it("stops at a reference that leads back to itself", () => {
      expect(ContextualFlowControl.declaredHandleKind({
        $ref: "#/$defs/Loop",
        $defs: { Loop: { $ref: "#/$defs/Loop" } },
      })).toBeUndefined();
      // A branch that loops declares nothing, and `anyOf` needs every branch.
      expect(ContextualFlowControl.declaredHandleKind({
        anyOf: [{ $ref: "#/$defs/Loop" }, event],
        $defs: { Loop: { anyOf: [{ $ref: "#/$defs/Loop" }] } },
      })).toBeUndefined();
    });
  });

  describe("the reading a reader holding no runtime shares", () => {
    const event = { asCell: ["stream"], type: "number" } as JSONSchema & object;
    const external = { $ref: "cid:evt" } as JSONSchema;

    it("declares nothing for an external reference given no resolver", () => {
      expect(declaredHandleKind(external)).toBeUndefined();
    });

    it("reads a resolved reference against the document it resolved to", () => {
      const resolveExternal: ExternalReferenceResolver = () => ({
        schema: { $ref: "#/$defs/Event" } as JSONSchema,
        root: { $defs: { Event: event } } as JSONSchema,
      });
      expect(declaredHandleKind(external, { resolveExternal })).toBe("stream");
      // The root it was reached from names another definition by that name.
      expect(declaredHandleKind(external, {
        root: { $defs: { Event: { asCell: ["cell"] } } } as JSONSchema,
        resolveExternal,
      })).toBe("stream");
    });

    it("declares nothing where the resolver refuses the reference", () => {
      expect(declaredHandleKind(external, { resolveExternal: () => undefined }))
        .toBeUndefined();
    });

    describe("a resolver over schema documents", () => {
      const documents: Record<string, JSONSchema> = {
        evt: event,
        wrapper: { $ref: "cid:evt", description: "An event" } as JSONSchema,
        defs: { $defs: { Ev: event } } as JSONSchema,
        plain: { type: "number" } as JSONSchema,
        anything: true,
        loop: { $ref: "cid:loop" } as JSONSchema,
      };
      const resolveExternal = externalReferenceResolverOver((hash) =>
        documents[hash]
      );
      const declared = (schema: JSONSchema) =>
        declaredHandleKind(schema, { resolveExternal });

      it("follows a reference whose document is itself a reference", () => {
        expect(declared({ $ref: "cid:wrapper" } as JSONSchema)).toBe("stream");
      });

      it("selects the definition a fragment names", () => {
        expect(declared({ $ref: "cid:defs#/$defs/Ev" } as JSONSchema))
          .toBe("stream");
        expect(declared({ $ref: "cid:defs#/$defs/Missing" } as JSONSchema))
          .toBeUndefined();
      });

      it("reads a keyword beside the reference over the document", () => {
        expect(
          declared({ $ref: "cid:plain", asCell: ["stream"] } as JSONSchema),
        )
          .toBe("stream");
        // A boolean document takes the keyword as well.
        expect(
          declared({ $ref: "cid:anything", asCell: ["stream"] } as JSONSchema),
        )
          .toBe("stream");
        // Whatever kind the keyword declares.
        expect(declared({ $ref: "cid:plain", asCell: ["cell"] } as JSONSchema))
          .toBe("cell");
      });

      it("declares nothing for a document the reader lacks, or a chain that loops", () => {
        expect(declared({ $ref: "cid:absent" } as JSONSchema)).toBeUndefined();
        expect(declared({ $ref: "cid:loop" } as JSONSchema)).toBeUndefined();
      });

      it("declares nothing for a boolean document read alone, or a fragment into one", () => {
        expect(declared({ $ref: "cid:anything" } as JSONSchema))
          .toBeUndefined();
        expect(declared({ $ref: "cid:anything#/$defs/Ev" } as JSONSchema))
          .toBeUndefined();
      });

      it("resolves a reference that is not well formed to nothing", () => {
        expect(resolveExternal({ $ref: "cid:" })).toBeUndefined();
      });
    });
  });

  describe("an address that names a stream's document alone", () => {
    const streamDocumentOf = async (cause: string) => {
      const { pattern, cell } = await runProgram(COUNTER, cause);
      const descriptor = (pattern.derivedInternalCells ?? []).find((
        candidate,
      ) => asCellKindOf(candidate.schema) === "stream");
      const { id } = getDerivedInternalCell(cell, descriptor!)
        .getAsNormalizedFullLink();
      return { cell, bare: rt.getCellFromLink({ id, space, path: [] }) };
    };

    it("is declared a stream by its owner's manifest", async () => {
      const { cell, bare } = await streamDocumentOf("counter-bare");
      // No stored link hop, no caller schema, and nothing in the document.
      expect(isStream(bare)).toBe(false);
      expect(ContextualFlowControl.declaresStream(ownerStreamSchema(bare)))
        .toBe(true);
      // The piece's result document names an owner for nothing.
      expect(ownerStreamSchema(cell)).toBeUndefined();
    });

    it("is invoked, not read, when a tool call names it", async () => {
      const { cell, bare } = await streamDocumentOf("counter-tool");
      const path = createLLMFriendlyLink(
        bare.getAsNormalizedFullLink(),
        space,
      );
      const catalog = { llmTools: {}, dynamicToolCells: new Map() };
      const callNamed = (toolName: string) =>
        llmDialogTestHelpers.resolveToolCall(rt, space, {
          type: "tool-call",
          toolCallId: toolName,
          toolName,
          input: { path },
        }, catalog);

      expect(() => callNamed("read")).toThrow("use invoke() instead");
      const resolved = callNamed("invoke") as unknown as {
        type: string;
        handler: Cell<unknown>;
      };
      expect(resolved.type).toBe("invoke");
      // The integrity gate reads its floors off the handle's schema, so the
      // handle carries the owner's declaration whole, event schema included.
      expect(resolved.handler.schema).toEqual(ownerStreamSchema(bare));

      const before = countOf(cell);
      const tx = rt.edit();
      resolved.handler.withTx(tx).send({});
      await tx.commit();
      await cell.pull();
      expect(countOf(cell)).toBe(before + 1);
      expect(bare.getRaw()).toBeUndefined();
      await rt.storageManager.synced();
    });
  });

  it("invokes a builtin's handler through the address an observation gave out", async () => {
    // A dialog's handlers are fields of the builtin's own result document,
    // not documents with an owner to ask. The address an observation hands
    // out is that document and a path, with no schema; the document's result
    // schema is what types it.
    const { cell } = await runProgram(DIALOG, "dialog");
    await rt.idle();
    const cancel = cell.key("cancel");
    expect(isStream(cancel)).toBe(true);

    const observed = llmDialogTestHelpers.serializeForLLMObservation({
      value: cancel,
      contextSpace: space,
    }).value as { "@link": string };
    expect(typeof observed["@link"]).toBe("string");
    await rt.storageManager.synced();

    // A second runtime over the same storage holds none of the first one's
    // handles, only what was stored.
    const fresh = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const target = fresh.getCellFromLink(
        llmDialogTestHelpers.parseLLMFriendlyLink(observed["@link"], space),
      );
      await target.sync();
      const callNamed = (toolName: string) =>
        llmDialogTestHelpers.resolveToolCall(fresh, space, {
          type: "tool-call",
          toolCallId: toolName,
          toolName,
          input: { path: observed["@link"] },
        }, { llmTools: {}, dynamicToolCells: new Map() });

      expect(() => callNamed("read")).toThrow("use invoke() instead");
      const resolved = callNamed("invoke") as unknown as {
        type: string;
        handler: Cell<unknown>;
      };
      expect(resolved.type).toBe("invoke");
      expect(isStream(resolved.handler)).toBe(true);
    } finally {
      await fresh.dispose();
    }
  });

  it("reads an object whose required stream is declared through a local `$ref`", async () => {
    // `extra` is a stream the data does not name, required, and declared in
    // the schema's own `$defs`. The union's prefilter and the object
    // traversal both have to see the declaration through the reference: one
    // exempts the key from `required`, the other mints its handle.
    const { cell } = await runProgram(COUNTER, "counter-ref-required");
    const view = cell.asSchema({
      $defs: { Extra: { asCell: ["stream"] } },
      anyOf: [
        {
          type: "object",
          properties: {
            count: { type: "number" },
            extra: { $ref: "#/$defs/Extra" },
          },
          required: ["count", "extra"],
        },
        { type: "null" },
      ],
    } as JSONSchema).get() as unknown as { count: number; extra: unknown };

    expect(view).toBeDefined();
    expect(view).not.toBeNull();
    expect(view.count).toBe(0);
    expect(isStream(view.extra)).toBe(true);
  });

  it("returns the stream from a read of a stream handle", async () => {
    // A view node's prop schema leaves an `opaque` entry behind the stream's
    // on the handle's own schema. A read that minted that handle would hand
    // back one nothing marks as a stream, on the stream's own document.
    const { cell } = await runProgram(COUNTER, "counter-read");
    const view = cell.asSchema({
      type: "object",
      properties: {
        count: { type: "number" },
        bump: { asCell: ["stream", "opaque"] },
      },
    } as JSONSchema).get() as unknown as { bump: Cell<unknown> };
    const read = view.bump.get() as unknown as Cell<unknown>;

    expect(isStream(read)).toBe(true);
    const before = countOf(cell);
    read.send({});
    await cell.pull();
    expect(countOf(cell)).toBe(before + 1);
    await rt.storageManager.synced();
  });

  for (
    const [owner, program] of [
      ["a sub-pattern's", GATED],
      ["the pattern's own", GATED_OWN],
    ] as const
  ) {
    for (const field of ["viaIfElse", "viaWhen", "viaUnless"] as const) {
      it(`keeps ${owner} stream dispatchable when \`${field}\` selects it`, async () => {
        const { cell } = await runProgram(program, `gated-${owner}-${field}`);
        await rt.idle();
        const selected = cell.key(field);
        expect(isStream(selected)).toBe(true);
        const before = countOf(cell);
        (selected as unknown as { send: (event: unknown) => void }).send({});
        await cell.pull();
        expect(countOf(cell)).toBe(before + 1);
        await rt.storageManager.synced();
      });
    }
  }
});

describe("a stream declared through a reference or a composition", () => {
  const NUMBER_STREAM = { type: "number", asCell: ["stream"] } as const;
  const WITH_DEFS = (event: JSONSchema): JSONSchema => ({
    type: "object",
    properties: { event: { $ref: "#/$defs/Event" } },
    $defs: { Event: event, NumberStream: NUMBER_STREAM },
  });
  const declaredAt = (schema: JSONSchema) =>
    ContextualFlowControl.declaredHandleKind(
      ContextualFlowControl.getSchemaAtPath(schema, ["event"]),
    );

  it("reads the declaration through a local reference", () => {
    expect(declaredAt(WITH_DEFS({ $ref: "#/$defs/NumberStream" }))).toBe(
      "stream",
    );
  });

  it("reads what any allOf branch declares, beside plain constraints", () => {
    expect(declaredAt(WITH_DEFS({
      allOf: [{ $ref: "#/$defs/NumberStream" }, { minimum: 0 }],
    }))).toBe("stream");
  });

  it("reads what every anyOf branch declares, and nothing when one does not", () => {
    expect(declaredAt(WITH_DEFS({
      anyOf: [
        { $ref: "#/$defs/NumberStream" },
        { type: "undefined", asCell: ["stream"] },
      ],
    }))).toBe("stream");
    expect(declaredAt(WITH_DEFS({
      anyOf: [{ $ref: "#/$defs/NumberStream" }, { type: "null" }],
    }))).toBeUndefined();
    expect(declaredAt(WITH_DEFS({
      anyOf: [{ $ref: "#/$defs/NumberStream" }, { asCell: ["cell"] }],
    }))).toBeUndefined();
  });

  it("declares nothing where nothing is declared", () => {
    expect(declaredAt(WITH_DEFS({ type: "number" }))).toBeUndefined();
    expect(ContextualFlowControl.declaredHandleKind(undefined)).toBeUndefined();
    expect(ContextualFlowControl.declaredHandleKind(true)).toBeUndefined();
  });

  it("makes a handle at such a position a stream with nothing stored", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const holder = rt.getCell(
        space,
        "composed-stream-holder",
        WITH_DEFS({
          allOf: [{ $ref: "#/$defs/NumberStream" }, { minimum: 0 }],
        }),
      );
      const event = holder.key("event");
      expect(isStream(event)).toBe(true);
      const received: unknown[] = [];
      rt.scheduler.addEventHandler((_tx, payload) => {
        received.push(payload);
      }, event.getAsNormalizedFullLink());
      event.send(5 as never);
      await rt.idle();
      expect(received).toEqual([5]);
      expect(holder.getRaw()).toBeUndefined();
    } finally {
      await rt.dispose();
      await storageManager.close();
    }
  });
});
