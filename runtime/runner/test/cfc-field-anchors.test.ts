/**
 * CFC over a collaborative field's anchors, which a handler writes as it
 * writes any cell: the anchors a transaction writes after reading the field
 * are as confidential as the field, by the ordinary flow from what a
 * transaction read to what it wrote, and anchors an edit to the field has
 * moved are as confidential as the field was at that edit, whoever wrote
 * them, until a write replaces them.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FieldAnchors } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  toValuePath,
} from "@commonfabric/memory/v2";

import type { CellScope, JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { cfcLabelViewForCellWithStatus } from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { CfcReadCeilingError } from "../src/cfc/read-ceiling.ts";
import { anchorsDocumentLink } from "../src/field-anchors.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  hasOperationStorageCapability,
  type IExtendedStorageTransaction,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-field-anchors");
const space = signer.did();

const SECRET = "field-anchors-secret";

/** A field that admits only public values. */
const PUBLIC_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { maxConfidentiality: [] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

/** A field labeled confidential, and the same field unlabeled. */
const SECRET_FIELD_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", ifc: { confidentiality: [SECRET] } },
  },
  required: ["body"],
} as const satisfies JSONSchema;

const PLAIN_FIELD_SCHEMA = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
} as const satisfies JSONSchema;

const REVIEWED = "field-anchors-reviewed";

/** A field labeled confidential that also claims integrity. */
const VOUCHED_FIELD_SCHEMA = {
  type: "object",
  properties: {
    body: {
      type: "string",
      ifc: { confidentiality: [SECRET], integrity: [REVIEWED] },
    },
  },
  required: ["body"],
} as const satisfies JSONSchema;

/** The message a refused commit carries, or `undefined` for an accepted one. */
const refusalOf = (
  result: { ok?: unknown; error?: unknown },
): string | undefined =>
  result.ok !== undefined
    ? undefined
    : (result.error as Error | undefined)?.message ?? String(result.error);

describe("cfc-field-anchors", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * The note `name` under `schema`, in `tx` where one is given, and in the
   * instance of `scope` where one is given.
   */
  const noteOf = (
    name: string,
    schema: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: CellScope,
  ): Cell<{ body: string }> => {
    const note = runtime.getCell<{ body: string }>(space, name, schema, tx);
    return scope === undefined ? note : runtime.getCellFromLink(
      { ...note.getAsNormalizedFullLink(), scope },
      schema,
      tx,
    );
  };

  /** The anchors document of the body of the note `name`. */
  const anchorsOf = (
    name: string,
    schema: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: CellScope,
  ): Cell<FieldAnchors | undefined> =>
    runtime.getCellFromLink<FieldAnchors | undefined>(
      anchorsDocumentLink(
        noteOf(name, schema, undefined, scope).key("body")
          .getAsNormalizedFullLink(),
      ),
      undefined,
      tx,
    );

  /**
   * Seeds the note `name` under `schema` with the body `hello world` and a
   * public field beside it, then anchors the `w` of the body from a
   * transaction that read the body, as a handler placing a comment does.
   */
  const anchorWorld = async (
    name: string,
    schema: JSONSchema,
  ): Promise<void> => {
    const seed = runtime.edit();
    noteOf(name, schema, seed).set({ body: "hello world" });
    runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, seed).set({
      out: "",
    });
    expect(refusalOf(await seed.commit().settled)).toBeUndefined();

    const anchor = runtime.edit();
    const from = noteOf(name, schema, anchor).key("body").get().indexOf("w");
    anchorsOf(name, schema, anchor).set({ w: from });
    anchor.prepareCfc();
    expect(refusalOf(await anchor.commit().settled)).toBeUndefined();
    await runtime.storageManager.synced();
    await anchorsOf(name, schema).sync();
  };

  /**
   * Reads the anchors of the note `name` in a transaction that reads nothing
   * else, copies the offset of `w` into the public field beside the note,
   * and returns what that commit refuses. The anchors are `w` at `expected`,
   * or `expected` itself where it gives them all.
   */
  const copyAnchor = async (
    name: string,
    schema: JSONSchema,
    expected: number | FieldAnchors,
    scope?: CellScope,
  ): Promise<string | undefined> => {
    const copy = runtime.edit();
    const anchors = anchorsOf(name, schema, copy, scope).get();
    expect(anchors).toEqual(
      typeof expected === "number" ? { w: expected } : expected,
    );
    runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, copy).key("out")
      .set(String(anchors?.w));
    copy.prepareCfc();
    return refusalOf(await copy.commit().settled);
  };

  /**
   * Seeds the note `name` under `schema` as {@link anchorWorld} does, then
   * writes `anchors` from a transaction that reads nothing.
   */
  const anchorBlind = async (
    name: string,
    schema: JSONSchema,
    anchors: FieldAnchors,
    scope?: CellScope,
  ): Promise<void> => {
    const seed = runtime.edit();
    noteOf(name, schema, seed, scope).set({ body: "hello world" });
    runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, seed).set({
      out: "",
    });
    seed.prepareCfc();
    expect(refusalOf(await seed.commit().settled)).toBeUndefined();
    await writeBlind(name, schema, anchors, scope);
  };

  /**
   * Writes `anchors` as the anchors of the note `name` from a transaction
   * that reads nothing, and returns once this replica holds the write.
   */
  const writeBlind = async (
    name: string,
    schema: JSONSchema,
    anchors: FieldAnchors,
    scope?: CellScope,
  ): Promise<void> => {
    const blind = runtime.edit();
    anchorsOf(name, schema, blind, scope).set(anchors);
    blind.prepareCfc();
    expect(refusalOf(await blind.commit().settled)).toBeUndefined();
    await runtime.storageManager.synced();
    await anchorsOf(name, schema, undefined, scope).sync();
  };

  /**
   * Inserts `oh ` at the start of the body of the note `name`, written
   * through `schema`, and resolves once the anchors document holds `w` at
   * `expected`.
   */
  const insertAtStart = async (
    name: string,
    schema: JSONSchema,
    expected: number,
    scope?: CellScope,
  ): Promise<void> => {
    const moved = Promise.withResolvers<void>();
    const cancel = anchorsOf(name, schema, undefined, scope).sink(
      (anchors) => {
        if (anchors?.w === expected) moved.resolve();
      },
    );
    const edit = runtime.edit();
    noteOf(name, schema, edit, scope).key("body")
      .applyChanges({ from: 0, insert: "oh " });
    edit.prepareCfc();
    expect(refusalOf(await edit.commit().settled)).toBeUndefined();
    await moved.promise;
    cancel();
  };

  /**
   * Appends `!` to the body of the note `name`, written through `schema`,
   * and resolves once the body holds `expected`. An anchor at the end of the
   * body stays ahead of text inserted at it, so the edit moves no anchor.
   */
  const appendAtEnd = async (
    name: string,
    schema: JSONSchema,
    expected: string,
  ): Promise<void> => {
    const landed = Promise.withResolvers<void>();
    const cancel = noteOf(name, schema).key("body").sink((body) => {
      if (body === expected) landed.resolve();
    });
    const edit = runtime.edit();
    noteOf(name, schema, edit).key("body")
      .applyChanges({ from: expected.length - 1, insert: "!" });
    edit.prepareCfc();
    expect(refusalOf(await edit.commit().settled)).toBeUndefined();
    await landed.promise;
    cancel();
    await runtime.storageManager.synced();
  };

  /** The address of the anchors document of the note `name`, at its root. */
  const anchorsAddress = (name: string, schema: JSONSchema) => {
    const { space, id, scope } = anchorsOf(name, schema)
      .getAsNormalizedFullLink();
    return { space, id, scope, type: "application/json" as const, path: [] };
  };

  it("taints a reader of the anchors with the confidentiality of the field their writer read", async () => {
    await anchorWorld("secret-field", SECRET_FIELD_SCHEMA);

    expect(await copyAnchor("secret-field", SECRET_FIELD_SCHEMA, 6))
      .toContain("maxConfidentiality failed at /out");
  });

  it("leaves a reader of the anchors of an unlabeled field untainted", async () => {
    await anchorWorld("plain-field", PLAIN_FIELD_SCHEMA);

    expect(await copyAnchor("plain-field", PLAIN_FIELD_SCHEMA, 6))
      .toBeUndefined();
  });

  it("keeps the anchors as confidential as the field once an edit to the field has moved them", async () => {
    await anchorWorld("edited-field", SECRET_FIELD_SCHEMA);
    const moved = Promise.withResolvers<void>();
    const cancel = anchorsOf("edited-field", SECRET_FIELD_SCHEMA).sink(
      (anchors) => {
        if (anchors?.w === 9) moved.resolve();
      },
    );

    const edit = runtime.edit();
    noteOf("edited-field", SECRET_FIELD_SCHEMA, edit).key("body")
      .applyChanges({ from: 0, insert: "oh " });
    edit.prepareCfc();
    expect(refusalOf(await edit.commit().settled)).toBeUndefined();
    await moved.promise;
    cancel();

    expect(await copyAnchor("edited-field", SECRET_FIELD_SCHEMA, 9))
      .toContain("maxConfidentiality failed at /out");
  });

  it("commits anchors written before an edit in the same transaction, as confidential as the field", async () => {
    // Preparation records the anchors' confidentiality after the edit, which
    // is a write to their document but not to the offsets.

    const seed = runtime.edit();
    noteOf("ordered-field", SECRET_FIELD_SCHEMA, seed).set({
      body: "hello world",
    });
    runtime.getCell(space, "ordered-field-copy", PUBLIC_SCHEMA, seed).set({
      out: "",
    });
    expect(refusalOf(await seed.commit().settled)).toBeUndefined();
    const moved = Promise.withResolvers<void>();
    const cancel = anchorsOf("ordered-field", SECRET_FIELD_SCHEMA).sink(
      (anchors) => {
        if (anchors?.w === 9) moved.resolve();
      },
    );

    const edit = runtime.edit();
    const body = noteOf("ordered-field", SECRET_FIELD_SCHEMA, edit).key("body");
    anchorsOf("ordered-field", SECRET_FIELD_SCHEMA, edit).set({
      w: body.get().indexOf("w"),
    });
    body.applyChanges({ from: 0, insert: "oh " });
    edit.prepareCfc();
    expect(refusalOf(await edit.commit().settled)).toBeUndefined();
    await moved.promise;
    cancel();

    expect(await copyAnchor("ordered-field", SECRET_FIELD_SCHEMA, 9))
      .toContain("maxConfidentiality failed at /out");
  });

  describe("anchors written without reading the field", () => {
    it("leaves their reader untainted while no edit has moved them", async () => {
      await anchorBlind("blind-unmoved", SECRET_FIELD_SCHEMA, { w: 99999 });

      expect(await copyAnchor("blind-unmoved", SECRET_FIELD_SCHEMA, 99999))
        .toBeUndefined();
    });

    it("taints their reader with the confidentiality of the field once an edit has moved them", async () => {
      // The anchor sits past the end of the body, so the edit moves it to
      // the end: its offset is then the length of a body its writer never
      // read.

      await anchorBlind("blind-moved", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-moved", SECRET_FIELD_SCHEMA, 14);

      expect(await copyAnchor("blind-moved", SECRET_FIELD_SCHEMA, 14))
        .toContain("maxConfidentiality failed at /out");
    });

    it("leaves their reader untainted once an edit has moved them on an unlabeled field", async () => {
      await anchorBlind("plain-moved", PLAIN_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("plain-moved", PLAIN_FIELD_SCHEMA, 14);

      expect(await copyAnchor("plain-moved", PLAIN_FIELD_SCHEMA, 14))
        .toBeUndefined();
    });

    it("taints the reader of an anchor the edit did not move", async () => {
      // An anchor at the start of the body stays ahead of text inserted
      // there, so its offset is still the one its writer chose. It takes the
      // field's label with the anchor that moved, since which anchors an
      // edit moves says where it fell.

      await anchorBlind("blind-beside", SECRET_FIELD_SCHEMA, {
        start: 0,
        w: 99999,
      });
      await insertAtStart("blind-beside", SECRET_FIELD_SCHEMA, 14);

      const copy = runtime.edit();
      const start = anchorsOf("blind-beside", SECRET_FIELD_SCHEMA, copy)
        .key("start").get();
      runtime.getCell(space, "blind-beside-copy", PUBLIC_SCHEMA, copy)
        .key("out").set(String(start));
      copy.prepareCfc();

      expect(start).toBe(0);
      expect(refusalOf(await copy.commit().settled))
        .toContain("maxConfidentiality failed at /out");
    });

    it("keeps their reader tainted through a later edit", async () => {
      await anchorBlind("blind-edited", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-edited", SECRET_FIELD_SCHEMA, 14);
      await insertAtStart("blind-edited", SECRET_FIELD_SCHEMA, 17);

      expect(await copyAnchor("blind-edited", SECRET_FIELD_SCHEMA, 17))
        .toContain("maxConfidentiality failed at /out");
    });

    it("keeps their reader tainted after a blind write of another anchor beside them", async () => {
      await anchorBlind("blind-added", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-added", SECRET_FIELD_SCHEMA, 14);
      const add = runtime.edit();
      anchorsOf("blind-added", SECRET_FIELD_SCHEMA, add).key("x").set(1);
      add.prepareCfc();
      expect(refusalOf(await add.commit().settled)).toBeUndefined();
      await runtime.storageManager.synced();

      expect(
        await copyAnchor("blind-added", SECRET_FIELD_SCHEMA, { w: 14, x: 1 }),
      ).toContain("maxConfidentiality failed at /out");
    });

    it("leaves their reader untainted after a blind write that replaces every anchor", async () => {
      // The offsets the edit computed are gone with the write, so nothing
      // the document holds was derived from the field.

      await anchorBlind("blind-replaced", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-replaced", SECRET_FIELD_SCHEMA, 14);
      await writeBlind("blind-replaced", SECRET_FIELD_SCHEMA, { w: 3 });

      expect(await copyAnchor("blind-replaced", SECRET_FIELD_SCHEMA, 3))
        .toBeUndefined();
    });

    it("taints their reader again once an edit moves the anchors a blind write replaced", async () => {
      await anchorBlind("blind-removed", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-removed", SECRET_FIELD_SCHEMA, 14);
      await writeBlind("blind-removed", SECRET_FIELD_SCHEMA, { w: 3 });
      await insertAtStart("blind-removed", SECRET_FIELD_SCHEMA, 6);

      expect(await copyAnchor("blind-removed", SECRET_FIELD_SCHEMA, 6))
        .toContain("maxConfidentiality failed at /out");
    });

    it("taints the reader of a per-user field's moved anchors with that field's confidentiality", async () => {
      await anchorBlind(
        "blind-scoped",
        SECRET_FIELD_SCHEMA,
        { w: 99999 },
        "user",
      );
      await insertAtStart("blind-scoped", SECRET_FIELD_SCHEMA, 14, "user");

      expect(
        await copyAnchor("blind-scoped", SECRET_FIELD_SCHEMA, 14, "user"),
      ).toContain("maxConfidentiality failed at /out");
    });

    it("taints their reader with a label the field takes on in the edit that moves them", async () => {
      // The edit's commit writes the field's label ahead of its operation,
      // so the label is the field's when Memory moves the anchors.

      await anchorBlind("blind-labeled", PLAIN_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-labeled", SECRET_FIELD_SCHEMA, 14);

      expect(await copyAnchor("blind-labeled", PLAIN_FIELD_SCHEMA, 14))
        .toContain("maxConfidentiality failed at /out");
    });

    it("taints their reader with a label the field takes on in an edit that moves no anchor", async () => {
      // Text appended at the end of the body lands after `w`, so the append
      // moves no anchor, and labels `w` with what the field holds after it.

      await anchorBlind("blind-relabeled", PLAIN_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-relabeled", PLAIN_FIELD_SCHEMA, 14);
      await appendAtEnd(
        "blind-relabeled",
        SECRET_FIELD_SCHEMA,
        "oh hello world!",
      );
      expect(await copyAnchor("blind-relabeled", PLAIN_FIELD_SCHEMA, 14))
        .toContain("maxConfidentiality failed at /out");
    });

    it("keeps their reader tainted once the field is released", async () => {
      await anchorBlind("blind-released", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-released", SECRET_FIELD_SCHEMA, 14);
      const replica = storageManager.open(space).replica;
      if (!hasOperationStorageCapability(replica)) {
        throw new Error("the replica lacks the operation capability");
      }
      const { id, path } = noteOf("blind-released", SECRET_FIELD_SCHEMA)
        .key("body").getAsNormalizedFullLink();
      const field = { id, path: toValuePath(path) };
      const { cursor } = await replica.queryOperationField(field);
      await replica.releaseOperationField({
        op: "release-op-field",
        ...field,
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor: cursor!,
      });

      expect(await copyAnchor("blind-released", SECRET_FIELD_SCHEMA, 14))
        .toContain("maxConfidentiality failed at /out");
    });

    it("labels the moved anchors with the field's confidentiality and none of its integrity", async () => {
      await anchorBlind("blind-vouched", VOUCHED_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("blind-vouched", VOUCHED_FIELD_SCHEMA, 14);

      const direct = runtime.edit();
      noteOf("blind-vouched", VOUCHED_FIELD_SCHEMA, direct).key("body").get();
      const ofField = collectConsumedLabel(direct);
      const through = runtime.edit();
      anchorsOf("blind-vouched", VOUCHED_FIELD_SCHEMA, through).key("w").get();
      const ofAnchors = collectConsumedLabel(through);
      const stored = readStoredCfcMetadata(
        through,
        anchorsAddress("blind-vouched", VOUCHED_FIELD_SCHEMA),
      );

      expect(ofField.confidentiality).toEqual([SECRET]);
      expect(ofField.integrity).toEqual([REVIEWED]);
      expect(ofAnchors.confidentiality).toEqual([SECRET]);
      expect(ofAnchors.integrity).toEqual([]);
      expect(stored?.labelMap.entries).toEqual([{
        path: ["w"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: [SECRET] },
      }]);
    });

    it("shows the field's confidentiality in a label view of moved anchors, and none in one of anchors no edit has moved", async () => {
      await anchorBlind("view-unmoved", SECRET_FIELD_SCHEMA, { w: 99999 });
      await anchorBlind("view-moved", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("view-moved", SECRET_FIELD_SCHEMA, 14);

      expect(
        cfcLabelViewForCellWithStatus(
          anchorsOf("view-unmoved", SECRET_FIELD_SCHEMA),
        ),
      ).toEqual({ view: undefined, readFailed: false });
      expect(
        cfcLabelViewForCellWithStatus(
          anchorsOf("view-moved", SECRET_FIELD_SCHEMA),
        ),
      ).toMatchObject({
        view: {
          entries: [{ path: ["w"], label: { confidentiality: [SECRET] } }],
        },
        readFailed: false,
      });
    });

    it("throws `CfcReadCeilingError` for a read of moved anchors under a ceiling the field exceeds", async () => {
      await anchorBlind("ceiling-unmoved", SECRET_FIELD_SCHEMA, { w: 99999 });
      await anchorBlind("ceiling-moved", SECRET_FIELD_SCHEMA, { w: 99999 });
      await insertAtStart("ceiling-moved", SECRET_FIELD_SCHEMA, 14);
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcReadMaxConfidentiality: ["field-anchors-other"],
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
      });
      try {
        const tx = reader.edit();
        const anchorsIn = (name: string) =>
          reader.getCellFromLink<FieldAnchors | undefined>(
            anchorsOf(name, SECRET_FIELD_SCHEMA).getAsNormalizedFullLink(),
            undefined,
            tx,
          );

        expect(anchorsIn("ceiling-unmoved").get()).toEqual({ w: 99999 });
        expect(() => anchorsIn("ceiling-moved").get()).toThrow(
          CfcReadCeilingError,
        );
      } finally {
        await reader.dispose();
      }
    });
  });
});
