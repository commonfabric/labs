/**
 * CFC over a collaborative field's anchors, which a handler writes as it
 * writes any cell: the anchors a transaction writes after reading the field
 * are as confidential as the field, by the ordinary flow from what a
 * transaction read to what it wrote, and stay so when an edit to the field
 * moves them.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FieldAnchors } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { anchorsDocumentLink } from "../src/field-anchors.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

  /** The note `name` under `schema`, in `tx` where one is given. */
  const noteOf = (
    name: string,
    schema: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<{ body: string }> =>
    runtime.getCell<{ body: string }>(space, name, schema, tx);

  /** The anchors document of the body of the note `name`. */
  const anchorsOf = (
    name: string,
    schema: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<FieldAnchors | undefined> =>
    runtime.getCellFromLink<FieldAnchors | undefined>(
      anchorsDocumentLink(
        noteOf(name, schema).key("body").getAsNormalizedFullLink(),
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
   * and returns what that commit refuses.
   */
  const copyAnchor = async (
    name: string,
    schema: JSONSchema,
    expected: number,
  ): Promise<string | undefined> => {
    const copy = runtime.edit();
    const anchors = anchorsOf(name, schema, copy).get();
    expect(anchors).toEqual({ w: expected });
    runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, copy).key("out")
      .set(String(anchors?.w));
    copy.prepareCfc();
    return refusalOf(await copy.commit().settled);
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
});
