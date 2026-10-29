import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-value-stamps");
const space = signer.did();

const REVIEWED = "reviewed";
const CHECKED = "checked";

const stamped = (...atoms: string[]) =>
  ({ type: "string", ifc: { addIntegrity: atoms } }) as const;

const NOTE_PLAIN = {
  type: "object",
  properties: { note: { type: "string" }, other: { type: "string" } },
} as const satisfies JSONSchema;

const NOTE_REVIEWED = {
  type: "object",
  properties: { note: stamped(REVIEWED), other: { type: "string" } },
} as const satisfies JSONSchema;

const NOTE_CHECKED = {
  type: "object",
  properties: { note: stamped(CHECKED), other: { type: "string" } },
} as const satisfies JSONSchema;

const LIST_PLAIN = {
  type: "array",
  items: { type: "string" },
} as const satisfies JSONSchema;

const LIST_REVIEWED = {
  type: "array",
  items: stamped(REVIEWED),
} as const satisfies JSONSchema;

const ROWS_PLAIN = {
  type: "array",
  items: { type: "object", properties: { text: { type: "string" } } },
} as const satisfies JSONSchema;

const ROWS_REVIEWED = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" } },
    ifc: { addIntegrity: [REVIEWED] },
  },
} as const satisfies JSONSchema;

describe("value stamps (`ifc.addIntegrity`)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Commits one transaction that writes through a cell of `schema`. */
  const write = async (
    cause: string,
    schema: JSONSchema,
    // deno-lint-ignore no-explicit-any
    act: (cell: Cell<any>, tx: IExtendedStorageTransaction) => void,
  ): Promise<void> => {
    const { error } = await runtime.editWithRetry((tx) => {
      act(runtime.getCell(space, cause, schema, tx), tx);
    });
    expect(error).toBeUndefined();
  };

  const idOf = (cause: string): string =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  const storedDocument = (id: string) =>
    (storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        value?: unknown;
        cfc?: { labelMap?: { entries: LabelMapEntry[] } };
      } | undefined;
    }).getDocument(id);

  /** The stored stamps of a document, as `path: atoms` lines. */
  const stampsOf = (id: string): string[] =>
    (storedDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((entry) => entry.origin === "minted")
      .map((entry) =>
        `/${entry.path.join("/")}: ${(entry.label.integrity ?? []).join(",")}`
      )
      .sort();

  /** The integrity a reader of one element or field of `cause` is shown. */
  const integrityAt = (
    cause: string,
    schema: JSONSchema,
    key: string | number,
  ): unknown[] => {
    const tx = runtime.edit();
    try {
      const view = cfcLabelViewForCell(
        // deno-lint-ignore no-explicit-any
        (runtime.getCell(space, cause, schema, tx) as Cell<any>).key(key),
      );
      return (view?.entries ?? []).flatMap((entry) =>
        entry.label.integrity ?? []
      );
    } finally {
      tx.abort();
    }
  };

  describe("on a field", () => {
    it("stores the stamp at the written path, in the minted component", async () => {
      await write("field-mint", NOTE_REVIEWED, (cell) => {
        cell.set({ note: "a", other: "b" });
      });

      expect(stampsOf(idOf("field-mint"))).toEqual(["/note: reviewed"]);
      expect(integrityAt("field-mint", NOTE_PLAIN, "note")).toEqual([REVIEWED]);
      expect(integrityAt("field-mint", NOTE_PLAIN, "other")).toEqual([]);
    });

    it("keeps the stamp when another field changes", async () => {
      await write("field-sibling", NOTE_REVIEWED, (cell) => {
        cell.set({ note: "a", other: "b" });
      });
      await write("field-sibling", NOTE_PLAIN, (cell) => {
        cell.key("other").set("c");
      });

      expect(stampsOf(idOf("field-sibling"))).toEqual(["/note: reviewed"]);
    });

    it("withdraws the stamp when a writer through a plain schema changes the value", async () => {
      await write("field-plain", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("stamped");
      });
      await write("field-plain", NOTE_PLAIN, (cell) => {
        cell.key("note").set("unreviewed");
      });

      expect(storedDocument(idOf("field-plain"))?.value).toEqual({
        note: "unreviewed",
      });
      expect(stampsOf(idOf("field-plain"))).toEqual([]);
      expect(integrityAt("field-plain", NOTE_PLAIN, "note")).toEqual([]);
    });

    it("withdraws the stamp when a write carrying no schema changes the value", async () => {
      await write("field-raw", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("stamped");
      });
      const id = idOf("field-raw");
      await write("field-raw", NOTE_PLAIN, (_cell, tx) => {
        tx.writeOrThrow(
          { space, id: id as never, scope: "space", path: ["value", "note"] },
          "unreviewed",
        );
      });

      expect(storedDocument(id)?.value).toEqual({ note: "unreviewed" });
      expect(stampsOf(id)).toEqual([]);
    });

    it("keeps the stamp when a plain schema writes the same value back", async () => {
      await write("field-same", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("stamped");
      });
      await write("field-same", NOTE_PLAIN, (cell) => {
        cell.key("note").set("stamped");
      });

      expect(stampsOf(idOf("field-same"))).toEqual(["/note: reviewed"]);
    });

    it("keeps the stamp when the stamping schema writes the value again", async () => {
      await write("field-again", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("first");
      });
      await write("field-again", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("second");
      });

      expect(stampsOf(idOf("field-again"))).toEqual(["/note: reviewed"]);
    });

    it("replaces the stamp when a writer stamps the value with other atoms", async () => {
      await write("field-other", NOTE_REVIEWED, (cell) => {
        cell.key("note").set("first");
      });
      await write("field-other", NOTE_CHECKED, (cell) => {
        cell.key("note").set("second");
      });

      expect(stampsOf(idOf("field-other"))).toEqual(["/note: checked"]);
    });
  });

  describe("on a value written in parts", () => {
    const CARD = {
      type: "object",
      properties: {
        text: { type: "string", ifc: { addIntegrity: [REVIEWED] } },
        tags: { type: "array", items: { type: "string" } },
      },
      ifc: { addIntegrity: [REVIEWED] },
    } as const satisfies JSONSchema;

    const CARD_PLAIN = {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    } as const satisfies JSONSchema;

    it("keeps the whole value's stamp when the part that changes is stamped the same", async () => {
      await write("parts-stamped", CARD, (cell) => {
        cell.set({ text: "a", tags: [] });
      });
      await write("parts-stamped", CARD, (cell) => cell.key("text").set("b"));

      expect(stampsOf(idOf("parts-stamped"))).toContain("/: reviewed");
      expect(integrityAt("parts-stamped", CARD_PLAIN, "tags")).toEqual([
        REVIEWED,
      ]);
    });

    it("withdraws the whole value's stamp when a part changes unstamped", async () => {
      await write("parts-plain", CARD, (cell) => {
        cell.set({ text: "a", tags: [] });
      });
      await write("parts-plain", CARD_PLAIN, (cell) => {
        cell.key("text").set("b");
      });

      expect(stampsOf(idOf("parts-plain"))).toEqual([]);
      expect(integrityAt("parts-plain", CARD_PLAIN, "tags")).toEqual([]);
    });
  });

  describe("on a list of plain values", () => {
    it("stores one `*` entry while every element carries the stamp", async () => {
      await write("list-uniform", LIST_REVIEWED, (cell) => cell.push("a"));
      await write("list-uniform", LIST_REVIEWED, (cell) => cell.push("b"));

      expect(stampsOf(idOf("list-uniform"))).toEqual(["/*: reviewed"]);
      expect(integrityAt("list-uniform", LIST_PLAIN, 1)).toEqual([REVIEWED]);
    });

    it("replaces the `*` entry with one per stamped element when an element arrives without the stamp", async () => {
      await write("list-split", LIST_REVIEWED, (cell) => cell.push("a"));
      await write("list-split", LIST_REVIEWED, (cell) => cell.push("b"));
      await write("list-split", LIST_PLAIN, (cell) => cell.push("c"));

      expect(stampsOf(idOf("list-split"))).toEqual([
        "/0: reviewed",
        "/1: reviewed",
      ]);
      expect(integrityAt("list-split", LIST_PLAIN, 1)).toEqual([REVIEWED]);
      expect(integrityAt("list-split", LIST_PLAIN, 2)).toEqual([]);
    });

    it("stamps only the element pushed onto a list holding unstamped ones", async () => {
      await write("list-late", LIST_PLAIN, (cell) => cell.push("a"));
      await write("list-late", LIST_REVIEWED, (cell) => cell.push("b"));
      await write("list-late", LIST_PLAIN, (cell) => cell.push("c"));

      expect(stampsOf(idOf("list-late"))).toEqual(["/1: reviewed"]);
      expect(integrityAt("list-late", LIST_PLAIN, 0)).toEqual([]);
      expect(integrityAt("list-late", LIST_PLAIN, 1)).toEqual([REVIEWED]);
      expect(integrityAt("list-late", LIST_PLAIN, 2)).toEqual([]);
    });

    it("stores no stamp for a list emptied of its stamped elements", async () => {
      await write(
        "list-emptied",
        LIST_REVIEWED,
        (cell) => cell.set(["a", "b"]),
      );
      expect(stampsOf(idOf("list-emptied"))).toEqual(["/*: reviewed"]);

      await write("list-emptied", LIST_PLAIN, (cell) => cell.set([]));
      expect(stampsOf(idOf("list-emptied"))).toEqual([]);
    });

    it("withdraws every stamp when a plain schema replaces the list", async () => {
      await write(
        "list-replaced",
        LIST_REVIEWED,
        (cell) => cell.set(["a", "b"]),
      );
      await write("list-replaced", LIST_PLAIN, (cell) => cell.set(["x", "y"]));

      expect(stampsOf(idOf("list-replaced"))).toEqual([]);
    });
  });

  describe("on a record", () => {
    // A record's `additionalProperties` is one schema position for every
    // entry, as a list's `items` is for every element. Its keys do not move,
    // so an entry keeps its stamp whatever is added or removed beside it.

    const RECORD_PLAIN = {
      type: "object",
      additionalProperties: { type: "string" },
    } as const satisfies JSONSchema;

    const record = (...atoms: string[]) =>
      ({
        type: "object",
        additionalProperties: stamped(...atoms),
      }) as const satisfies JSONSchema;

    it("stores one `*` entry while every entry carries the stamp", async () => {
      await write("record-uniform", record(REVIEWED), (cell) => {
        cell.set({ a: "x", b: "y" });
      });
      await write("record-uniform", record(REVIEWED), (cell) => {
        cell.key("c").set("z");
      });

      expect(stampsOf(idOf("record-uniform"))).toEqual(["/*: reviewed"]);
      expect(integrityAt("record-uniform", RECORD_PLAIN, "c")).toEqual([
        REVIEWED,
      ]);
    });

    it("replaces the `*` entry with one per stamped entry when an entry arrives without the stamp", async () => {
      await write("record-split", record(REVIEWED), (cell) => {
        cell.set({ a: "x", b: "y" });
      });
      await write("record-split", RECORD_PLAIN, (cell) => {
        cell.key("c").set("z");
      });

      expect(stampsOf(idOf("record-split"))).toEqual([
        "/a: reviewed",
        "/b: reviewed",
      ]);
      expect(integrityAt("record-split", RECORD_PLAIN, "c")).toEqual([]);
    });

    it("gives each entry the atoms of the writer that added it", async () => {
      await write("record-sources", record(REVIEWED), (cell) => {
        cell.set({ a: "x" });
      });
      await write("record-sources", record(CHECKED), (cell) => {
        cell.key("b").set("y");
      });
      await write("record-sources", RECORD_PLAIN, (cell) => {
        cell.key("c").set("z");
      });

      expect(stampsOf(idOf("record-sources"))).toEqual([
        "/a: reviewed",
        "/b: checked",
      ]);
      expect(integrityAt("record-sources", RECORD_PLAIN, "a")).toEqual([
        REVIEWED,
      ]);
      expect(integrityAt("record-sources", RECORD_PLAIN, "b")).toEqual([
        CHECKED,
      ]);
      expect(integrityAt("record-sources", RECORD_PLAIN, "c")).toEqual([]);
    });

    it("keeps an entry's stamp when another entry is removed", async () => {
      await write("record-removal", record(REVIEWED), (cell) => {
        cell.set({ a: "x", b: "y" });
      });
      await write("record-removal", RECORD_PLAIN, (cell) => {
        cell.key("c").set("z");
      });
      await write("record-removal", RECORD_PLAIN, (cell) => {
        cell.set({ b: "y", c: "z" });
      });

      expect(stampsOf(idOf("record-removal"))).toEqual(["/b: reviewed"]);
    });
  });

  describe("on a list of objects", () => {
    // `push()` stores each object in a document of its own and the list holds
    // a reference to it, so the stamp is the element document's.

    /** The id of the document the list's element at `index` is stored in. */
    const elementId = (cause: string, index: number): string => {
      const list = storedDocument(idOf(cause))?.value as unknown[];
      return parseLink(list[index], runtime.getCell(space, cause))!.id!;
    };

    for (
      const [order, stampedIndex, plainIndex] of [
        ["the plain element first", 1, 0],
        ["the stamped element first", 0, 1],
      ] as const
    ) {
      it(`stamps the pushed element's document and leaves the list unstamped, ${order}`, async () => {
        const cause = `rows-${stampedIndex}`;
        const pushes = [
          () => write(cause, ROWS_PLAIN, (cell) => cell.push({ text: "u" })),
          () => write(cause, ROWS_REVIEWED, (cell) => cell.push({ text: "s" })),
        ];
        if (stampedIndex === 0) pushes.reverse();
        for (const push of pushes) await push();

        expect(stampsOf(idOf(cause))).toEqual([]);
        expect(stampsOf(elementId(cause, stampedIndex))).toEqual([
          "/: reviewed",
        ]);
        expect(stampsOf(elementId(cause, plainIndex))).toEqual([]);
        expect(integrityAt(cause, ROWS_PLAIN, stampedIndex)).toEqual([
          REVIEWED,
        ]);
        expect(integrityAt(cause, ROWS_PLAIN, plainIndex)).toEqual([]);
      });
    }
  });
});
