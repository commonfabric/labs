import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { NAME } from "@commonfabric/runner";
import {
  buildPieceDescription,
  type PieceDescription,
  schemaTypeLabel,
} from "../lib/piece-describe.ts";
import type { PieceCallablesListing } from "../lib/piece.ts";
import { describePiece } from "../lib/piece.ts";
import {
  describePieceFromCommand,
  piece,
  pieceDescribeJson,
  pieceDescribeLines,
} from "../commands/piece.ts";
import { decode } from "@commonfabric/utils/encoding";

/** A result schema shaped as the generator emits a board-like pattern's: an
 * inline root carrying its interface's doc comment, a stream-marked verb
 * property, documented and undocumented data fields, and the runtime's
 * `$NAME` slot. */
const BOARD_RESULT: JSONSchema = {
  type: "object",
  description: "A work tracker: root items on a board.",
  properties: {
    items: {
      "$ref": "#/$defs/AnonymousType_1",
      description: "Root items only.",
    },
    addItem: {
      "$ref": "#/$defs/AddItemEvent",
      asCell: ["stream"],
      description: "File a new root item on the board.",
    },
    "$NAME": { type: "string" },
  },
  required: ["items", "addItem", "$NAME"],
  "$defs": {
    AnonymousType_1: {
      type: "array",
      items: { "$ref": "#/$defs/ItemOutput" },
    },
    ItemOutput: {
      type: "object",
      properties: { title: { type: "string" } },
    },
    AddItemEvent: {
      type: "object",
      properties: { title: { type: "string" } },
    },
  },
} as JSONSchema;

const BOARD_ARGUMENT: JSONSchema = {
  type: "object",
  properties: {
    items: {
      "$ref": "#/$defs/AnonymousType_1",
      default: [],
      asCell: ["cell"],
    },
    seed: { type: "string", description: "Where the board starts." },
  },
  required: ["seed"],
  "$defs": {
    AnonymousType_1: {
      type: "array",
      items: { "$ref": "#/$defs/ItemOutput" },
    },
    ItemOutput: { type: "object", properties: { title: { type: "string" } } },
  },
} as JSONSchema;

/** A created piece's result schema: the root is a reference into `$defs`,
 * and the interface's own doc comment lives on the definition it names. */
const ITEM_RESULT: JSONSchema = {
  "$ref": "#/$defs/ItemOutput",
  "$defs": {
    ItemOutput: {
      type: "object",
      description: "One work item.",
      properties: {
        title: { type: "string" },
        parent: {
          anyOf: [{ "$ref": "#/$defs/ItemOutput" }, { type: "null" }],
          description: "The item this one files under.",
        },
        archive: {
          asCell: ["stream", "opaque"],
          description: "Mark this item archived.",
        },
      },
      required: ["title", "parent", "archive"],
    },
  },
} as JSONSchema;

const ADD_ITEM_ROW: PieceCallablesListing["verbs"][number] = {
  name: "addItem",
  kind: "handler",
  on: "result",
  inputSchema: true,
  description: "File a new root item on the board.",
};

function listingOf(
  verbs: PieceCallablesListing["verbs"],
  extra: Partial<PieceCallablesListing> = {},
): PieceCallablesListing {
  return { pattern: null, verbs, ...extra };
}

describe("piece-describe", () => {
  describe("schemaTypeLabel", () => {
    const root = BOARD_RESULT;

    it("names a named definition without opening it", () => {
      expect(schemaTypeLabel({ "$ref": "#/$defs/ItemOutput" }, root)).toBe(
        "ItemOutput",
      );
    });

    it("reads an anonymous definition through to its shape", () => {
      expect(schemaTypeLabel({ "$ref": "#/$defs/AnonymousType_1" }, root))
        .toBe("ItemOutput[]");
    });

    it("labels an inline array by its element", () => {
      expect(
        schemaTypeLabel(
          { type: "array", items: { "$ref": "#/$defs/ItemOutput" } },
          root,
        ),
      ).toBe("ItemOutput[]");
    });

    it("joins a union's members and drops duplicates", () => {
      expect(
        schemaTypeLabel(
          {
            anyOf: [
              { "$ref": "#/$defs/ItemOutput" },
              { type: "null" },
              { type: "null" },
            ],
          },
          root,
        ),
      ).toBe("ItemOutput | null");
    });

    it("parenthesizes a union element inside an array", () => {
      expect(
        schemaTypeLabel(
          {
            type: "array",
            items: {
              anyOf: [{ "$ref": "#/$defs/ItemOutput" }, { type: "null" }],
            },
          },
          root,
        ),
      ).toBe("(ItemOutput | null)[]");
    });

    it("labels an enum by its literal values", () => {
      expect(schemaTypeLabel({ enum: ["open", "done"] }, root)).toBe(
        '"open" | "done"',
      );
    });

    it("answers unknown for an unconstrained schema", () => {
      expect(schemaTypeLabel(true, root)).toBe("unknown");
      expect(schemaTypeLabel({}, root)).toBe("unknown");
    });

    it("labels the shapes that carry no single type keyword", () => {
      expect(schemaTypeLabel(42, root)).toBe("unknown");
      expect(schemaTypeLabel({ "$ref": "http://elsewhere/schema" }, root))
        .toBe("unknown");
      expect(schemaTypeLabel({ type: ["string", "null"] }, root)).toBe(
        "string | null",
      );
      expect(schemaTypeLabel(
        { properties: { title: { type: "string" } } },
        root,
      )).toBe("object");
    });

    it("stops at a self-referential anonymous definition", () => {
      const cyclic: JSONSchema = {
        "$defs": {
          AnonymousType_1: {
            type: "array",
            items: { "$ref": "#/$defs/AnonymousType_1" },
          },
        },
      } as JSONSchema;
      // The guard yields the definition's own name rather than recursing.
      expect(
        schemaTypeLabel({ "$ref": "#/$defs/AnonymousType_1" }, cyclic),
      ).toBe("AnonymousType_1[]");
    });
  });

  describe("buildPieceDescription", () => {
    it("reads purpose, state, and inputs off an inline-rooted pattern", () => {
      const description = buildPieceDescription({
        name: "Work tracker",
        listing: listingOf([ADD_ITEM_ROW]),
        compiled: {
          argumentSchema: BOARD_ARGUMENT,
          resultSchema: BOARD_RESULT,
        },
      });

      expect(description.name).toBe("Work tracker");
      expect(description.purpose).toBe(
        "A work tracker: root items on a board.",
      );
      // State excludes the listed callable and the `$`-prefixed runtime slot.
      expect(description.state).toEqual([{
        name: "items",
        type: "ItemOutput[]",
        description: "Root items only.",
      }]);
      // Required marks ride inputs only — a result's `required` array names
      // fields the pattern owns, which is not a claim on the caller.
      expect(description.inputs).toEqual([
        { name: "items", type: "ItemOutput[]" },
        {
          name: "seed",
          type: "string",
          required: true,
          description: "Where the board starts.",
        },
      ]);
      expect(description.verbs).toEqual([ADD_ITEM_ROW]);
    });

    it("reads a created piece's purpose through the root reference", () => {
      const description = buildPieceDescription({
        listing: listingOf([]),
        compiled: { resultSchema: ITEM_RESULT },
      });

      expect(description.purpose).toBe("One work item.");
      // `archive` is stream-marked and never listed (the listing is empty
      // here), so the mark alone must keep it out of the state section.
      expect(description.state?.map((field) => field.name)).toEqual([
        "title",
        "parent",
      ]);
      expect(description.state?.[1]).toEqual({
        name: "parent",
        type: "ItemOutput | null",
        description: "The item this one files under.",
      });
      // No argument schema compiled: nothing to document, honestly empty.
      expect(description.inputs).toEqual([]);
    });

    it("documents no fields off a properties map that is not a plain object", () => {
      // A malformed or hand-assembled schema can carry `properties` as an
      // array; entries over one would list its indices as fields.
      const description = buildPieceDescription({
        listing: listingOf([]),
        compiled: {
          argumentSchema: {
            type: "object",
            properties: [{ type: "string" }],
          } as never,
          resultSchema: {
            type: "object",
            description: "Still the purpose.",
            properties: [{ type: "string" }],
          } as never,
        },
      });

      expect(description.state).toEqual([]);
      expect(description.inputs).toEqual([]);
      // The root prose is undamaged by the malformed property map.
      expect(description.purpose).toBe("Still the purpose.");
    });

    it("yields no documentation from schemas that resolve to nothing usable", () => {
      // A root reference resolving to a non-object, and a property that is
      // not an object at all: both are shapes a hand-assembled or truncated
      // schema can carry, and both must degrade a field, never the page.
      const description = buildPieceDescription({
        listing: listingOf([]),
        compiled: {
          argumentSchema: {
            type: "object",
            properties: { ok: { type: "string" }, bad: true },
          } as never,
          resultSchema: {
            "$ref": "#/$defs/Gone",
            "$defs": { Gone: true },
          } as never,
        },
      });

      expect(Object.hasOwn(description, "purpose")).toBe(false);
      expect(description.state).toEqual([]);
      expect(description.inputs).toEqual([{ name: "ok", type: "string" }]);
    });

    it("omits the documentation half when the pattern was unreadable", () => {
      const description = buildPieceDescription({
        listing: listingOf([ADD_ITEM_ROW], {
          incomplete: "pattern-unavailable",
        }),
        compiled: null,
      });

      // Absent, not empty: an empty section would claim the pattern declares
      // nothing, and nothing here read the pattern.
      expect(Object.hasOwn(description, "purpose")).toBe(false);
      expect(Object.hasOwn(description, "state")).toBe(false);
      expect(Object.hasOwn(description, "inputs")).toBe(false);
      expect(description.incomplete).toBe("pattern-unavailable");
      expect(description.verbs).toEqual([ADD_ITEM_ROW]);
    });
  });

  describe("describePiece", () => {
    /** A piece double with a compiled pattern declaring one stream, and a
     * NAME cell — the two sources the description assembles. */
    function pieceDouble(overrides: Record<string, unknown> = {}) {
      const compiled = Object.assign(() => {}, {
        argumentSchema: BOARD_ARGUMENT,
        resultSchema: BOARD_RESULT,
        result: {},
        nodes: [],
      });
      return {
        getPattern: () => Promise.resolve(compiled),
        getCell: () => ({
          get: () => ({}),
          asSchema: (_schema: unknown) => ({ get: () => undefined }),
          key: (key: unknown) =>
            key === NAME
              ? { pull: () => Promise.resolve("Work tracker") }
              : { pull: () => Promise.resolve(undefined) },
        }),
        ...overrides,
      };
    }

    const config = {
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      piece: "fid1:piece-desc",
      space: "home",
    };

    it("loads the addressed piece without starting it or the space root", async () => {
      // Discovery reads the addressed piece and nothing else: the space
      // root's bootstrap and the target's start are dispatch concerns, not a
      // description's. The root double carries no pattern a controller could
      // load, so the description it yields is the honest empty one.
      const pieceRoot = { entityId: { "/": config.piece } };
      const getPieceCellCalls: unknown[][] = [];
      let ensureCalls = 0;
      const manager = {
        ensureDefaultPattern: () => {
          ensureCalls++;
          return Promise.resolve();
        },
        getPieceCell: (...args: unknown[]) => {
          getPieceCellCalls.push(args);
          return Promise.resolve(pieceRoot);
        },
        getSpace: () => "home",
      };

      const description = await describePiece(config, {
        loadPieces: () => Promise.resolve(manager as never),
      });

      expect(ensureCalls).toBe(0);
      expect(getPieceCellCalls).toEqual([
        [
          config.piece,
          { reconcile: true, start: false },
          undefined,
          undefined,
        ],
      ]);
      expect(description.verbs).toEqual([]);
      expect(description.incomplete).toBe("pattern-unavailable");
    });

    it("assembles name, purpose, fields, and verbs from one piece", async () => {
      const description = await describePiece(config, {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(pieceDouble() as never),
      });

      expect(description.name).toBe("Work tracker");
      expect(description.purpose).toBe(
        "A work tracker: root items on a board.",
      );
      expect(description.state?.map((field) => field.name)).toEqual(["items"]);
      expect(description.inputs?.map((field) => field.name)).toEqual([
        "items",
        "seed",
      ]);
      expect(description.verbs.map((verb) => verb.name)).toEqual(["addItem"]);
      // The verb row is the listing's own, prose included.
      expect(description.verbs[0].description).toBe(
        "File a new root item on the board.",
      );
    });

    it("reads a controller's already-loaded name without pulling its cell", async () => {
      const base = pieceDouble();
      const baseCell = base.getCell();
      const piece = pieceDouble({
        name: () => "Local name",
        getCell: () => ({
          ...baseCell,
          key: (key: unknown) =>
            key === NAME
              ? {
                pull: () => {
                  throw new Error("pulled the already-loaded name");
                },
              }
              : baseCell.key(key),
        }),
      });

      const description = await describePiece(config, {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      });

      expect(description.name).toBe("Local name");
    });

    it("describes an unnamed piece without a name key", async () => {
      const description = await describePiece(config, {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () =>
          Promise.resolve(
            pieceDouble({
              getCell: () => ({
                get: () => ({}),
                asSchema: (_schema: unknown) => ({ get: () => undefined }),
                key: () => ({ pull: () => Promise.reject(new Error("gone")) }),
              }),
            }) as never,
          ),
      });

      expect(Object.hasOwn(description, "name")).toBe(false);
      // The failure stays local to the header: the rest still documents.
      expect(description.purpose).toBe(
        "A work tracker: root items on a board.",
      );
    });
  });

  describe("describePieceFromCommand", () => {
    function captureStdout(fn: () => Promise<void>): Promise<string> {
      let captured = "";
      const original = Deno.stdout.writeSync;
      Deno.stdout.writeSync = (data: Uint8Array): number => {
        captured += decode(data);
        return data.length;
      };
      return fn().then(() => captured).finally(() => {
        Deno.stdout.writeSync = original;
      });
    }

    const OPTIONS = {
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      space: "home",
      cell: "board",
      quiet: true,
    };

    const DESCRIPTION: PieceDescription = {
      name: "Work tracker",
      pattern: null,
      purpose: "A work tracker.",
      state: [],
      inputs: [],
      verbs: [ADD_ITEM_ROW],
    };

    it("renders the JSON spelling and nothing else under --json", async () => {
      const out = await captureStdout(() =>
        describePieceFromCommand({ ...OPTIONS, json: true }, {
          describePiece: () => Promise.resolve(DESCRIPTION),
        })
      );
      expect(JSON.parse(out).purpose).toBe("A work tracker.");
    });

    it("renders the page lines on the text spelling", async () => {
      const out = await captureStdout(() =>
        describePieceFromCommand(OPTIONS, {
          describePiece: () => Promise.resolve(DESCRIPTION),
        })
      );
      expect(out).toContain("NAME    Work tracker");
      expect(out).toContain("  A work tracker.");
      expect(out).toContain("  addItem");
    });

    it("writes the page and its next steps to the sinks the caller supplies", async () => {
      // Without the sinks the page reaches stdout and the tip reaches
      // stderr, which is right for a one-shot verb and wrong for a caller
      // that has somewhere else to put them. A supplied sink is handed the
      // message whatever `--quiet` says, suppressing it being the caller's
      // decision from there on rather than this command's.

      const rendered: unknown[] = [];
      const hinted: string[] = [];
      await describePieceFromCommand(OPTIONS, {
        describePiece: () => Promise.resolve(DESCRIPTION),
        render: (value) => {
          rendered.push(value);
        },
        hint: (message) => {
          hinted.push(message);
        },
      });
      expect(rendered).toContain("NAME    Work tracker");
      expect(hinted[0]).toContain("cf piece verbs --cell board");
    });

    it("is the action the piece command registers for describe", () => {
      const registered = piece.getCommand("describe") as unknown as {
        actionHandler: unknown;
      };
      expect(registered.actionHandler).toBe(describePieceFromCommand);
    });
  });

  describe("cf piece describe rendering", () => {
    const FULL: PieceDescription = {
      name: "Work tracker",
      pattern: {
        identity: "sha256:feed",
        symbol: "default",
        source: { ref: "sha256:feed", entry: "/tracker.tsx" },
      } as never,
      purpose: "A work tracker: root items on a board.",
      state: [{
        name: "items",
        type: "ItemOutput[]",
        description: "Root items only.",
      }],
      inputs: [
        { name: "items", type: "ItemOutput[]" },
        { name: "seed", type: "string", required: true },
      ],
      verbs: [ADD_ITEM_ROW],
    };

    it("prints the page in section order with the author's prose", () => {
      const lines = pieceDescribeLines(FULL, false);

      expect(lines[0]).toBe("NAME    Work tracker");
      expect(lines[1]).toBe(
        "PATTERN cf:module/sha256:feed#default (/tracker.tsx)",
      );
      const text = lines.join("\n");
      expect(text).toContain("\n  A work tracker: root items on a board.");
      const order = ["STATE", "INPUTS", "VERBS"].map((label) =>
        lines.indexOf(label)
      );
      expect(order.every((at) => at > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text).toContain("  items  ItemOutput[]\n      Root items only.");
      expect(text).toContain("  addItem\n      File a new root item");
    });

    it("marks a required input ahead of its prose, and alone without one", () => {
      const lines = pieceDescribeLines(
        {
          ...FULL,
          inputs: [
            {
              name: "seed",
              type: "string",
              required: true,
              description: "Where the board starts.",
            },
            { name: "salt", type: "string", required: true },
          ],
        },
        false,
      );
      const text = lines.join("\n");
      expect(text).toContain("      Required. Where the board starts.");
      expect(text).toContain("  salt  string\n      Required.");
    });

    it("splits a multi-line doc comment across indented lines", () => {
      const lines = pieceDescribeLines(
        {
          ...FULL,
          state: [{
            name: "notes",
            type: "Note[]",
            description: "Append-only.\nThe pattern reads the clock.",
          }],
        },
        false,
      );
      const text = lines.join("\n");
      expect(text).toContain(
        "  notes  Note[]\n      Append-only.\n      The pattern reads the clock.",
      );
    });

    it("renders an unnamed, pattern-less description without either line", () => {
      const lines = pieceDescribeLines(
        { pattern: null, verbs: [] },
        false,
      );
      expect(lines[0]).toBe("NAME    <unnamed>");
      expect(lines.some((line) => line.startsWith("PATTERN"))).toBe(false);
      expect(lines).toContain("  <no callable verbs>");
    });

    it("omits state and inputs when the pattern was unreadable, and says so once", () => {
      const lines = pieceDescribeLines(
        {
          name: "Work tracker",
          pattern: null,
          verbs: [ADD_ITEM_ROW],
          incomplete: "pattern-unavailable",
        },
        false,
      );
      expect(lines).not.toContain("STATE");
      expect(lines).not.toContain("INPUTS");
      expect(lines[lines.length - 1]).toBe(
        "(the pattern could not be read, so its purpose, state, inputs, and verbs are missing; a verb the piece stores is still callable by name)",
      );
    });

    it("hides marked verbs by default and shows them under --all", () => {
      const marked: PieceDescription = {
        ...FULL,
        verbs: [ADD_ITEM_ROW, {
          name: "submitTopic",
          kind: "handler",
          on: "result",
          inputSchema: true,
          tier: "wrapper",
        }],
      };
      const byDefault = pieceDescribeLines(marked, false).join("\n");
      expect(byDefault).not.toContain("submitTopic");
      expect(byDefault).toContain(
        "(1 wrapper, 0 deprecated hidden; --all lists them)",
      );
      const withAll = pieceDescribeLines(marked, true).join("\n");
      expect(withAll).toContain("  submitTopic (wrapper)");
      expect(withAll).not.toContain("hidden; --all lists them");
    });

    it("keeps a described field's absence distinct in the JSON payload", () => {
      const whole = pieceDescribeJson(FULL, false);
      expect(Object.keys(whole)).toEqual([
        "name",
        "purpose",
        "state",
        "inputs",
        "pattern",
        "verbs",
      ]);

      const degraded = pieceDescribeJson(
        {
          pattern: null,
          verbs: [ADD_ITEM_ROW],
          incomplete: "pattern-unavailable",
        },
        false,
      );
      expect(Object.hasOwn(degraded, "name")).toBe(false);
      expect(Object.hasOwn(degraded, "purpose")).toBe(false);
      expect(Object.hasOwn(degraded, "state")).toBe(false);
      expect(Object.hasOwn(degraded, "inputs")).toBe(false);
      expect(degraded.incomplete).toBe("pattern-unavailable");

      // The verb partition is the verbs listing's own.
      const hidden = pieceDescribeJson(
        {
          ...FULL,
          verbs: [{ ...ADD_ITEM_ROW, deprecated: true }],
        },
        false,
      );
      expect(hidden.verbs).toEqual([]);
      expect(hidden.hidden).toEqual({ wrapper: 0, deprecated: 1 });
    });
  });
});
