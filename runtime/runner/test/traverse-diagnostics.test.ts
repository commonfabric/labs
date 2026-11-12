/**
 * The debug- and info-level diagnostics `traverse.ts` logs while it reads.
 * Each message is built lazily, so it runs only at a level that admits it;
 * every case here captures the traversal logger at `debug` for its duration
 * and states the result the traversal returned alongside what it logged.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink, StoredValuePath } from "../src/link-types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { NotFound } from "../src/storage/transaction/attestation.ts";
import {
  createDefaultTraversalContext,
  getAtPath,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { type CapturedLogs, captureLogs } from "./support/captured-logs.ts";

const SPACE = "did:null:null" as MemorySpace;
const TYPE = "application/json" as const;
const ROOT = "of:diagnostics-root" as URI;
const MISSING = "of:diagnostics-missing" as URI;

const linkTo = (
  id: URI,
  options: { schema?: JSONSchema; overwrite?: "redirect" } = {},
) => ({ "/": { [LINK_V1_TAG]: { id, path: [], ...options } } });

const docAt = (
  value: FabricValue | undefined,
  path: StoredValuePath = ["value"],
): IMemorySpaceValueAttestation => ({
  address: { space: SPACE, id: ROOT, type: TYPE, path },
  value,
});

/**
 * Returns a traverser for `selector` over a store holding `docs`, keyed by id,
 * and `root` under `ROOT`.
 */
function traverserOver(
  selector: SchemaPathSelector,
  root: FabricValue | undefined,
  docs: Record<string, FabricValue> = {},
  traverseCells = true,
): SchemaObjectTraverser<FabricValue> {
  const store = new Map<string, Revision<State>>();
  const entries = root === undefined ? docs : { ...docs, [ROOT]: root };
  for (const [id, value] of Object.entries(entries)) {
    store.set(`${id}/${TYPE}`, {
      the: TYPE,
      of: id as Entity,
      is: { value },
      since: 1,
    });
  }
  return new SchemaObjectTraverser(
    new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store)),
    ),
    selector,
    createDefaultTraversalContext({
      principal: "did:test:alice",
      sessionId: "session-1",
    }, traverseCells),
  );
}

/** Traverses `value`, stored at the root of `ROOT`, with `schema`. */
function traverseRoot(
  value: FabricValue | undefined,
  schema: JSONSchema,
  docs: Record<string, FabricValue> = {},
) {
  return traverserOver({ path: ["value"], schema }, value, docs).traverse(
    docAt(value),
  );
}

describe("traverse-diagnostics", () => {
  let captured: CapturedLogs;

  beforeEach(() => {
    captured = captureLogs("traverse");
  });

  afterEach(() => captured[Symbol.dispose]());

  /** Whether a line logged under `key` begins with `message`. */
  const wasLogged = (key: string, message: string) =>
    captured.textsOf(key).some((text) => text.startsWith(message));

  describe("links whose target holds no value", () => {
    it("logs a missing document and an undefined array entry, and reads the entry as `null`", () => {
      const { ok } = traverseRoot([linkTo(MISSING)], true);

      expect(ok).toEqual([null]);
      expect(wasLogged("traverse", "followPointer found missing document"))
        .toBe(true);
      expect(
        wasLogged(
          "traverse",
          "getAtPath returned undefined value for array entry",
        ),
      ).toBe(true);
    });

    it("logs a write redirect to an undefined value under an object, and reads it as `null`", () => {
      const { ok } = traverseRoot(
        { a: linkTo(MISSING, { overwrite: "redirect" }) },
        true,
      );

      expect(ok).toEqual({ a: null });
      expect(wasLogged("traverse", "getAtPath returned undefined value for"))
        .toBe(true);
    });

    it("logs nothing about a link whose target holds a value", () => {
      const { ok } = traverseRoot({ a: linkTo(MISSING) }, true, {
        [MISSING]: 1,
      });

      expect(ok).toEqual({ a: 1 });
      expect(wasLogged("traverse", "getAtPath returned undefined value for"))
        .toBe(false);
      expect(wasLogged("traverse", "followPointer found missing document"))
        .toBe(false);
    });

    it("logs an undefined array element reached through an element link", () => {
      const { ok } = traverseRoot([linkTo(MISSING)], {
        type: "array",
        items: { type: "number" },
      });

      expect(ok).toBeUndefined();
      expect(
        wasLogged(
          "traverse",
          "Value is undefined following array element link",
        ),
      ).toBe(true);
    });

    it("logs a write redirect to an undefined value under a schema", () => {
      const { ok } = traverseRoot(
        linkTo(MISSING, { overwrite: "redirect" }),
        { type: "number" },
      );

      expect(ok).toBeUndefined();
      expect(
        wasLogged(
          "traversePointerWithSchema",
          "Encountered link to undefined value",
        ),
      ).toBe(true);
    });
  });

  describe("a link carrying a schema its target fails", () => {
    it("logs the failure and reads the link as `null`", () => {
      const { ok } = traverseRoot(
        { a: linkTo(MISSING, { schema: { type: "number" } }) },
        true,
        { [MISSING]: "text" },
      );

      expect(ok).toEqual({ a: null });
      expect(
        wasLogged(
          "traverse",
          "traverseLinkedDoc schema traversal failed, link schema:",
        ),
      ).toBe(true);
    });

    it("logs nothing about a target the schema accepts", () => {
      const { ok } = traverseRoot(
        { a: linkTo(MISSING, { schema: { type: "number" } }) },
        true,
        { [MISSING]: 5 },
      );

      expect(ok).toEqual({ a: 5 });
      expect(
        wasLogged(
          "traverse",
          "traverseLinkedDoc schema traversal failed, link schema:",
        ),
      ).toBe(false);
    });
  });

  describe("an `asCell` link", () => {
    // A traversal that does not walk cells mints a handle for the link, which
    // the query's object creator leaves as no value, rather than reading the
    // target. One that walks cells reads on into the target.

    const traverseCellLink = (traverseCells: boolean) => {
      const value = linkTo(MISSING);
      const schema: JSONSchema = { type: "number", asCell: ["cell"] };
      return traverserOver(
        { path: ["value"], schema },
        value,
        { [MISSING]: 5 },
        traverseCells,
      ).traverse(docAt(value));
    };

    it("logs the cell link it mints when not walking cells", () => {
      expect(traverseCellLink(false)).toEqual({ ok: undefined });
      expect(wasLogged("traverse", "Next cell link:")).toBe(true);
    });

    it("logs no cell link when walking cells", () => {
      expect(traverseCellLink(true)).toEqual({ ok: 5 });
      expect(wasLogged("traverse", "Next cell link:")).toBe(false);
    });
  });

  describe("traverse()", () => {
    it("logs a failed validation of a value", () => {
      const { error } = traverseRoot("text", { type: "number" });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "Call to traverse failed validation")).toBe(
        true,
      );
    });

    it("logs a failed validation of a missing value", () => {
      const { error } = traverseRoot(undefined, { type: "number" });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "Call to traverse failed validation")).toBe(
        true,
      );
    });

    it("logs nothing about a value the schema accepts", () => {
      const { ok } = traverseRoot(5, { type: "number" });

      expect(ok).toBe(5);
      expect(wasLogged("traverse", "Call to traverse failed validation")).toBe(
        false,
      );
    });
  });

  describe("traverseWithSelector()", () => {
    it("logs a selector path that diverges from the document's, and fails", () => {
      const traverser = traverserOver({ path: ["value"], schema: true }, {
        a: 1,
      });
      const { error } = traverser.traverseWithSelector(
        docAt({ a: 1 }, ["value", "a"]),
        { path: ["value", "b", "c"], schema: true },
      );

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "path mismatch")).toBe(true);
    });

    it("logs a selector path that reaches no value", () => {
      const traverser = traverserOver({ path: ["value"], schema: true }, {
        a: 1,
      });
      const { ok, error } = traverser.traverseWithSelector(
        docAt({ a: 1 }),
        { path: ["value", "b"], schema: { type: "number" } },
      );

      expect(ok).toBeUndefined();
      expect(error).toBeDefined();
      expect(wasLogged("traverse", "value is undefined")).toBe(true);
    });

    it("throws for a document path longer than the selector's", () => {
      const traverser = traverserOver({ path: ["value"], schema: true }, {
        a: 1,
      });

      expect(() =>
        traverser.traverseWithSelector(docAt(1, ["value", "a"]), {
          path: ["value"],
          schema: true,
        })
      ).toThrow("Doc path should never exceed selector path");
    });
  });

  describe("traverseWithSchema()", () => {
    it("logs and throws for a schema that is neither a boolean nor an object", () => {
      // A schema read out of stored data is not held to the type.
      const schema = JSON.parse("5");
      const traverser = traverserOver({ path: ["value"], schema: true }, 1);

      expect(() => traverser.traverseWithSchema(docAt(1), schema)).toThrow(
        "Schema is neither boolean nor an object",
      );
      expect(wasLogged("traverse", "Invalid schema is not an object")).toBe(
        true,
      );
    });
  });

  describe("getAtPath()", () => {
    const context = () =>
      createDefaultTraversalContext({
        principal: "did:test:alice",
        sessionId: "session-1",
      });

    /** A transaction over `MISSING`, which holds `{ x: 1 }`. */
    const txOverTarget = () =>
      new ExtendedStorageTransaction(
        new ManagedStorageTransaction(
          new StoreObjectManager(
            new Map([[`${MISSING}/${TYPE}`, {
              the: TYPE,
              of: MISSING as Entity,
              is: { value: { x: 1 } },
              since: 1,
            }]]),
          ),
        ),
      );

    it("logs a selector diverging from the link it follows, and selects nothing past it", () => {
      const [found, selector] = getAtPath(
        txOverTarget(),
        docAt(linkTo(MISSING), ["value", "a"]),
        [],
        context(),
        { path: ["value", "b"], schema: { type: "object" } },
      );

      expect(found.value).toEqual({ x: 1 });
      expect(selector).toEqual({ path: ["value"], schema: false });
      expect(wasLogged("traverse", "Mismatched paths")).toBe(true);
    });

    it("carries a selector matching the link it follows to the link's target", () => {
      const [, selector] = getAtPath(
        txOverTarget(),
        docAt(linkTo(MISSING), ["value", "a"]),
        [],
        context(),
        { path: ["value", "a"], schema: { type: "object" } },
      );

      expect(selector).toEqual({ path: ["value"], schema: { type: "object" } });
      expect(wasLogged("traverse", "Mismatched paths")).toBe(false);
    });

    describe("a missing link target", () => {
      const reportFor = (link: ReturnType<typeof linkTo>) => {
        const missing: NormalizedFullLink[] = [];
        const [found] = getAtPath(
          new ExtendedStorageTransaction(
            new ManagedStorageTransaction(new StoreObjectManager(new Map())),
          ),
          docAt(link),
          [],
          createDefaultTraversalContext(
            { principal: "did:test:alice", sessionId: "session-1" },
            true,
            new MapSetStringToPathSelectors(true),
            (link) => missing.push(link),
          ),
        );
        expect(found.value).toBeUndefined();
        return missing;
      };

      it("is reported without a schema when neither the read nor the link carries one", () => {
        const missing = reportFor(linkTo(MISSING));

        expect(missing).toEqual([{
          space: SPACE,
          id: MISSING,
          path: [],
          scope: undefined,
        }]);
        expect("schema" in missing[0]).toBe(false);
        expect(wasLogged("traverse", "followPointer found missing document"))
          .toBe(true);
      });

      it("is reported with the link's schema when the read carries none", () => {
        const missing = reportFor(
          linkTo(MISSING, { schema: { type: "number" } }),
        );

        expect(missing.map((link) => link.schema)).toEqual([
          { type: "number" },
        ]);
      });
    });

    it("logs and throws when the transaction reports a missing key outside `value`", () => {
      // The storage layer reports a missing key on the path it was asked for,
      // which for a link target is always under `value`. A transaction
      // reporting one elsewhere is broken, and following the link stops.

      const managed = new ManagedStorageTransaction(
        new StoreObjectManager(new Map()),
      );
      managed.read = (address) => ({
        error: NotFound(
          { address: { ...address, path: [] }, value: {} },
          address,
          ["meta", "x"],
        ),
      });
      const link = {
        "/": { [LINK_V1_TAG]: { id: MISSING, path: ["x"] } },
      };

      expect(() =>
        getAtPath(
          new ExtendedStorageTransaction(managed),
          docAt(link),
          [],
          context(),
        )
      ).toThrow("Invalid path (not a StoredValuePath)");
      expect(wasLogged("traverse", "Invalid path:")).toBe(true);
    });

    it("logs a path into a value that is not a record, and returns no value", () => {
      const tx = new ExtendedStorageTransaction(
        new ManagedStorageTransaction(new StoreObjectManager(new Map())),
      );
      const [found] = getAtPath(tx, docAt(5), ["x", "y"], context());

      expect(found.value).toBeUndefined();
      expect(found.address.path).toEqual(["value", "x", "y"]);
      expect(
        wasLogged(
          "traverse",
          "Attempted to traverse into non-object/non-array value",
        ),
      ).toBe(true);
    });
  });

  describe("combinators", () => {
    for (
      const [form, prepare] of [
        ["a fresh schema", (schema: JSONSchema) => schema],
        ["an interned schema", (schema: JSONSchema) => internSchema(schema)],
      ] as const
    ) {
      it(`logs an \`anyOf\` with no matching branch, for ${form}`, () => {
        // `traverse()` interns its selector, so the schema is handed to
        // `traverseWithSchema()` as it stands.

        const { error } = traverserOver(
          { path: ["value"], schema: true },
          "text",
        )
          .traverseWithSchema(
            docAt("text"),
            prepare({ anyOf: [{ type: "number" }, { type: "boolean" }] }),
          );

        expect(error).toBeDefined();
        expect(wasLogged("traverse", "No matching anyOf")).toBe(true);
      });
    }

    it("logs a `oneOf` with no matching branch", () => {
      const { error } = traverseRoot("text", {
        oneOf: [{ type: "number" }, { type: "boolean" }],
      });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "No matching oneOf")).toBe(true);
    });

    it("logs a `oneOf` with more than one matching branch", () => {
      const { error } = traverseRoot(5, {
        oneOf: [{ type: "number" }, { type: "integer" }],
      });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "Multiple matching oneOf")).toBe(true);
    });

    it("logs nothing about a `oneOf` with exactly one matching branch", () => {
      const { ok } = traverseRoot(5, {
        oneOf: [{ type: "number" }, { type: "string" }],
      });

      expect(ok).toBe(5);
      expect(wasLogged("traverse", "No matching oneOf")).toBe(false);
      expect(wasLogged("traverse", "Multiple matching oneOf")).toBe(false);
    });

    it("logs a `false` branch of an `allOf`", () => {
      const { error } = traverseRoot(5, { allOf: [{ type: "number" }, false] });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "Encountered false in allOf")).toBe(true);
    });

    it("logs an `allOf` branch the value fails", () => {
      const { error } = traverseRoot(5, {
        allOf: [{ type: "number" }, { type: "string" }],
      });

      expect(error).toBeDefined();
      expect(wasLogged("traverse", "Failed entry in allOf")).toBe(true);
    });
  });

  describe("property defaults", () => {
    it("logs a schema default it fills in for a missing property", () => {
      const { ok } = traverseRoot({}, {
        type: "object",
        properties: { a: { type: "number", default: 7 } },
      });

      expect(ok).toEqual({ a: 7 });
      expect(wasLogged("traverse", "merging schema default")).toBe(true);
    });

    it("logs an `asCell` default it fills in for a missing property", () => {
      const { ok } = traverseRoot({}, {
        type: "object",
        properties: { a: { type: "number", default: 7, asCell: ["cell"] } },
      });

      expect(ok).toHaveProperty("a");
      expect(wasLogged("traverse", "merging asCell/asStream default")).toBe(
        true,
      );
    });

    it("logs no default for a property the value holds", () => {
      const { ok } = traverseRoot({ a: 1 }, {
        type: "object",
        properties: { a: { type: "number", default: 7 } },
      });

      expect(ok).toEqual({ a: 1 });
      expect(wasLogged("traverse", "merging schema default")).toBe(false);
    });
  });
});
