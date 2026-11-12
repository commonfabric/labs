/**
 * The helpers `llmDialog` uses to show a model what cells hold: the schema it
 * documents a cell with, the serialized value it renders, and the "Available
 * Cells" section of the system prompt that both feed.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";

import {
  llmDialogTestHelpers,
  llmToolExecutionHelpers,
} from "../../src/builtins/llm-dialog.ts";
import type { Cell } from "../../src/cell.ts";
import {
  createLLMFriendlyLink,
  type NormalizedFullLink,
} from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const {
  buildAssistantMessage,
  extractStringField,
  getCellSchema,
  hasValidContent,
  serializeForLLMObservation,
  traverseAndCellify,
} = llmDialogTestHelpers;
const { buildAvailableCellsDocumentation, flattenTools } =
  llmToolExecutionHelpers;

const signer = await Identity.fromPassphrase("llm dialog observation");
const space = signer.did();

const ENTITY_ID =
  "of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai";

/**
 * A stand-in for a cell, answering the reads the documentation helpers make of
 * a context or pinned cell. `value` is what both `get()` and `getRaw()` read,
 * and where `unreadable` is set both throw instead.
 */
function stubCell(params: {
  schema?: JSONSchema;
  value?: unknown;
  path?: string[];
  unreadable?: boolean;
}): Cell<unknown> {
  const link: NormalizedFullLink = {
    id: ENTITY_ID,
    space,
    scope: "space",
    path: params.path ?? [],
    ...(params.schema !== undefined && { schema: params.schema }),
  };
  const schemaless = { ...link, schema: undefined };
  const read = () => {
    if (params.unreadable) throw new Error("unreadable");
    return params.value;
  };
  const cell = {
    schema: params.schema,
    get: read,
    getRaw: read,
    getMetaRaw: () => undefined,
    getAsNormalizedFullLink: () => link,
    resolveAsCell: () => cell,
    asSchemaFromLinks: () => cell,
    asSchema: () => ({
      ...cell,
      getAsNormalizedFullLink: () => schemaless,
      asSchemaFromLinks: () => ({
        getAsNormalizedFullLink: () => schemaless,
      }),
    }),
  };
  return cell as unknown as Cell<unknown>;
}

/** The pinned-cell list the documentation helpers read, holding `pinned`. */
function pinnedList(
  pinned: { path: string; name: string }[],
): Cell<{ path: string; name: string }[]> {
  return { get: () => pinned } as unknown as Cell<
    { path: string; name: string }[]
  >;
}

/** A runtime whose only use here is resolving a pinned path to `cell`. */
function runtimeResolvingTo(cell: Cell<unknown>): Runtime {
  return { getCellFromLink: () => cell } as unknown as Runtime;
}

describe("llm-dialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("getCellSchema()", () => {
    it("returns the schema a link along the resolved chain carries when the cell's own link has none", () => {
      const chainSchema = {
        type: "object",
        properties: { title: { type: "string" } },
      } as const satisfies JSONSchema;
      const resolved = {
        asSchema: () => ({
          asSchemaFromLinks: () => ({
            getAsNormalizedFullLink: () => ({ schema: chainSchema }),
          }),
        }),
      };
      const cell = {
        asSchemaFromLinks: () => ({
          getAsNormalizedFullLink: () => ({ schema: undefined }),
        }),
        resolveAsCell: () => resolved,
      } as unknown as Cell<unknown>;

      expect(getCellSchema(cell)).toBe(chainSchema);
    });

    it("returns `undefined` when every lookup past the cell's own link throws", () => {
      // Each fallback is tried in turn, and a lookup that throws is passed
      // over rather than failing the documentation of the cell.
      const throwing = () => {
        throw new Error("unreadable");
      };
      const cell = {
        asSchemaFromLinks: () => ({
          getAsNormalizedFullLink: () => ({ schema: undefined }),
        }),
        resolveAsCell: throwing,
        asSchema: throwing,
      } as unknown as Cell<unknown>;

      expect(getCellSchema(cell)).toBeUndefined();
    });
  });

  describe("serializeForLLMObservation()", () => {
    const secretSchema = {
      type: "object",
      ifc: { confidentiality: ["secret"] },
    } as const satisfies JSONSchema;

    async function storedCell(cause: string, value: unknown) {
      const cell = runtime.getCell<unknown>(space, cause, undefined, tx);
      cell.set(value);
      await tx.commit().settled;
      tx = runtime.edit();
      return cell;
    }

    it("renders a cell above the ceiling as its handle when there is no root link", async () => {
      const cell = await storedCell("over-ceiling cell", { body: "secret" });

      const result = serializeForLLMObservation({
        value: cell,
        schema: secretSchema,
        contextSpace: space,
        observationMaxConfidentiality: ["internal"],
      });

      expect(result.value).toEqual({
        "@link": createLLMFriendlyLink(
          cell.resolveAsCell().getAsNormalizedFullLink(),
          space,
        ),
      });
      expect(JSON.stringify(result.value)).not.toContain('secret"');
    });

    it("renders a query result above the ceiling as the handle of the cell behind it", async () => {
      const cell = await storedCell("over-ceiling query result", {
        body: "secret",
      });

      const result = serializeForLLMObservation({
        value: cell.getAsQueryResult(),
        schema: secretSchema,
        contextSpace: space,
        observationMaxConfidentiality: ["internal"],
      });

      expect(result.value).toEqual({
        "@link": createLLMFriendlyLink(
          cell.resolveAsCell().getAsNormalizedFullLink(),
          space,
        ),
      });
    });

    it("renders an inline cell by its contents and a stored cell as a link", async () => {
      const inline = runtime.getImmutableCell(space, { title: "inline" });
      const stored = await storedCell("stored cell", { title: "stored" });

      expect(serializeForLLMObservation({ value: inline }).value).toEqual({
        title: "inline",
      });
      expect(
        serializeForLLMObservation({ value: stored, contextSpace: space })
          .value,
      ).toEqual({
        "@link": createLLMFriendlyLink(
          stored.resolveAsCell().getAsNormalizedFullLink(),
          space,
        ),
      });
    });

    it("renders a query result met again on its own path as a link to its cell", async () => {
      const cell = await storedCell("revisited query result", { title: "x" });
      const proxy = cell.getAsQueryResult();

      const result = serializeForLLMObservation({
        value: proxy,
        seen: new Set([proxy]),
        contextSpace: space,
      });

      expect(result.value).toEqual({
        "@link": createLLMFriendlyLink(
          cell.resolveAsCell().getAsNormalizedFullLink(),
          space,
        ),
      });
    });

    it("throws for a plain value that contains itself", () => {
      const cyclic: Record<string, unknown> = { title: "loop" };
      cyclic.self = cyclic;

      expect(() => serializeForLLMObservation({ value: cyclic })).toThrow(
        "Cannot serialize a value that has already been seen and cannot be mapped to a cell.",
      );
    });

    it("tags each object element of a queried array with its own handle, and leaves primitive elements alone", async () => {
      const objects = await storedCell("queried objects", [
        { title: "first" },
        { title: "second" },
      ]);
      const primitives = await storedCell("queried primitives", [1, 2]);

      const result = serializeForLLMObservation({
        value: objects.getAsQueryResult(),
        contextSpace: space,
      });

      const handleOf = (index: number) =>
        createLLMFriendlyLink(
          objects.key(index).resolveAsCell().getAsNormalizedFullLink(),
          space,
        );
      expect(result.value).toEqual([
        { "@arrayEntry": handleOf(0), title: "first" },
        { "@arrayEntry": handleOf(1), title: "second" },
      ]);
      expect(
        serializeForLLMObservation({
          value: primitives.getAsQueryResult(),
          contextSpace: space,
        }).value,
      ).toEqual([1, 2]);
    });
  });

  describe("buildAvailableCellsDocumentation()", () => {
    it("documents a cell holding no value with its schema's default", () => {
      const cell = stubCell({
        schema: { type: "string", default: "the default greeting" },
      });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(cell),
        space,
        { Greeting: cell },
        pinnedList([]),
      );

      expect(docs).toContain("## Greeting");
      expect(docs).toContain('"the default greeting"');
    });

    it("truncates a value longer than 2000 characters", () => {
      const cell = stubCell({
        schema: { type: "string" },
        value: "a".repeat(3000),
      });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(cell),
        space,
        { Long: cell },
        pinnedList([]),
      );

      expect(docs).toContain("\n... (truncated)");
      expect(docs).not.toContain("a".repeat(2001));
      expect(docs).toContain("a".repeat(1990));
    });

    it("truncates a schema longer than 1000 characters", () => {
      const properties = Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `aRatherLongPropertyName${i}`,
          { type: "string" } as const,
        ]),
      );
      const cell = stubCell({
        schema: { type: "object", properties },
        value: { aRatherLongPropertyName0: "x" },
      });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(cell),
        space,
        { Wide: cell },
        pinnedList([]),
      );

      expect(docs).toContain("aRatherLongPropertyName0");
      expect(docs).toContain("\n  // ... truncated");
      expect(docs).not.toContain("aRatherLongPropertyName79");
    });

    it("documents a cell whose value cannot be serialized without failing the rest", () => {
      const cyclic: Record<string, unknown> = { title: "loop" };
      cyclic.self = cyclic;
      const broken = stubCell({ value: cyclic, path: ["broken"] });
      const fine = stubCell({ value: "readable", path: ["fine"] });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(fine),
        space,
        { Broken: broken, Fine: fine },
        pinnedList([]),
      );

      expect(docs).toContain("## Broken");
      expect(docs).toContain("- Current Value: (unable to serialize)");
      expect(docs).toContain("## Fine");
      expect(docs).toContain('"readable"');
    });

    it("documents a cell whose value cannot be read", () => {
      const unreadable = stubCell({
        schema: { type: "string" },
        unreadable: true,
      });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(unreadable),
        space,
        { Unreadable: unreadable },
        pinnedList([]),
      );

      expect(docs).toContain("## Unreadable");
      expect(docs).toContain("- Schema:");
      expect(docs).toContain("- Current Value: (unable to serialize)");
    });

    it("keeps a context entry with a schema over a pinned entry without one for the same cell", () => {
      const withSchema = stubCell({ schema: { type: "string" }, value: "hi" });
      const withoutSchema = stubCell({ value: "hi" });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(withoutSchema),
        space,
        { FromContext: withSchema },
        pinnedList([{ path: `/${ENTITY_ID}`, name: "FromPin" }]),
      );

      expect(docs).toContain("## FromContext");
      expect(docs).toContain("- Schema:");
      expect(docs).not.toContain("FromPin");
    });

    it("documents a pinned cell without a schema when nothing else documents it", () => {
      const withoutSchema = stubCell({ value: "hi" });

      const docs = buildAvailableCellsDocumentation(
        runtimeResolvingTo(withoutSchema),
        space,
        undefined,
        pinnedList([{ path: `/${ENTITY_ID}`, name: "FromPin" }]),
      );

      expect(docs).toContain("## FromPin");
      expect(docs).not.toContain("- Schema:");
    });
  });

  describe("flattenTools()", () => {
    it("removes the injected `result` from an object input schema and leaves any other schema as written", () => {
      const tools = runtime.getCell<Record<string, unknown>>(
        space,
        "flattened tools",
        undefined,
        tx,
      );
      const listSchema = { type: "array", items: { type: "string" } };
      tools.set({
        search: {
          description: "Search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, result: {} },
            required: ["query", "result"],
          },
        },
        list: { description: "List", inputSchema: listSchema },
      });

      const flattened = flattenTools(tools, false);

      expect(flattened.search.inputSchema).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });
      expect(flattened.list.inputSchema).toEqual(listSchema);
    });
  });

  describe("extractStringField()", () => {
    it("throws for a field holding only whitespace", () => {
      expect(() => extractStringField({ path: "   " }, "path", "/of:x"))
        .toThrow(
          'path must be a non-empty string, e.g. "/of:x".',
        );
    });

    it("throws for input that is neither a string nor an object", () => {
      expect(() => extractStringField(42, "path", "/of:x")).toThrow(
        'path must be a non-empty string, e.g. "/of:x".',
      );
    });

    it("returns the trimmed field", () => {
      expect(extractStringField({ path: "  /of:y " }, "path", "/of:x")).toBe(
        "/of:y",
      );
    });
  });

  describe("traverseAndCellify()", () => {
    it("returns a brace-wrapped string that is not JSON unchanged", () => {
      expect(traverseAndCellify(runtime, space, "{not json}")).toBe(
        "{not json}",
      );
    });
  });

  describe("hasValidContent()", () => {
    it("returns `false` for content holding only parts it does not recognize", () => {
      const content = [
        { type: "image", image: "data" },
      ] as unknown as BuiltInLLMMessage["content"];

      expect(hasValidContent(content)).toBe(false);
    });

    it("returns `false` for content that is neither a string nor a list", () => {
      expect(
        hasValidContent(undefined as unknown as BuiltInLLMMessage["content"]),
      ).toBe(false);
    });
  });

  describe("buildAssistantMessage()", () => {
    it("keeps the text parts of list content and replaces its tool calls with the ones given", () => {
      const toolCall = {
        type: "tool-call" as const,
        toolCallId: "call-1",
        toolName: "read",
        input: {},
      };

      const message = buildAssistantMessage(
        [
          { type: "text", text: "Looking it up." },
          { ...toolCall, toolCallId: "stale" },
        ],
        [toolCall],
      );

      expect(message).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Looking it up." }, toolCall],
      });
    });
  });
});
