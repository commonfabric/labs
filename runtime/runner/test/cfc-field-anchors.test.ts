/**
 * CFC over a collaborative field's anchors: an anchor change is a write of
 * the field, judged by the field's write policy as `set()` is, and
 * `anchorsOf()` is as confidential as the field it reads.
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
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-field-anchors");
const space = signer.did();

const AUTHOR = "bio-author";
const SECRET = "field-anchors-secret";

/** A field only `AUTHOR` may write. */
const AUTHORED_SCHEMA = {
  type: "object",
  properties: {
    bio: { type: "string", ifc: { writeAuthorizedBy: [AUTHOR] } },
  },
  required: ["bio"],
} as const satisfies JSONSchema;

/** A labeled value, so that a transaction reading it is tainted. */
const SOURCE_SCHEMA = {
  type: "object",
  properties: { v: { type: "string", ifc: { confidentiality: [SECRET] } } },
  required: ["v"],
} as const satisfies JSONSchema;

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

  /** Commits `write` in a transaction running as the builtin `writer`. */
  const writeAs = async (
    writer: string,
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string | undefined> => {
    const tx = runtime.edit();
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
    setCfcImplementationIdentity(tx, { kind: "builtin", builtinId: writer });
    write(tx);
    const refusal = refusalOf(await tx.commit().settled);
    await runtime.storageManager.synced();
    return refusal;
  };

  describe("write authorization", () => {
    /**
     * The authored field `name`, holding `hello` and an anchor `h` its author
     * added, with its anchors document loaded.
     */
    const authoredField = async (name: string) => {
      const bio = (tx: IExtendedStorageTransaction) =>
        runtime.getCell(space, name, AUTHORED_SCHEMA, tx).key("bio");
      expect(
        await writeAs(
          AUTHOR,
          (tx) =>
            runtime.getCell(space, name, AUTHORED_SCHEMA, tx).set({
              bio: "hello",
            }),
        ),
      ).toBeUndefined();
      expect(
        await writeAs(
          AUTHOR,
          (tx) => bio(tx).addAnchor("h", { from: 0, to: 5 }),
        ),
      ).toBeUndefined();
      await runtime.getCellFromLink(
        anchorsDocumentLink(
          runtime.getCell(space, name, AUTHORED_SCHEMA).key("bio")
            .getAsNormalizedFullLink(),
        ),
      ).sync();
      return bio;
    };

    it("refuses `set()` from a writer the field does not name", async () => {
      // The baseline the anchor changes below are held to.

      const bio = await authoredField("authored-set");

      expect(await writeAs("mallory", (tx) => bio(tx).set("pwned")))
        .toContain("writeAuthorizedBy failed at /bio");
    });

    it("refuses an anchor added without a base by a writer the field does not name", async () => {
      const bio = await authoredField("authored-add");

      expect(
        await writeAs(
          "mallory",
          (tx) => bio(tx).addAnchor("x", { from: 0, to: 5 }),
        ),
      ).toContain("writeAuthorizedBy failed at /bio");
      expect(
        await writeAs(
          AUTHOR,
          (tx) => bio(tx).addAnchor("x", { from: 0, to: 5 }),
        ),
      ).toBeUndefined();
    });

    it("refuses an anchor added against a version by a writer the field does not name", async () => {
      const bio = await authoredField("authored-based");
      const base = { epoch: 1, version: 0 };

      expect(
        await writeAs(
          "mallory",
          (tx) => bio(tx).addAnchor("x", { from: 0, to: 5 }, { base }),
        ),
      ).toContain("writeAuthorizedBy failed at /bio");
      expect(
        await writeAs(
          AUTHOR,
          (tx) => bio(tx).addAnchor("x", { from: 0, to: 5 }, { base }),
        ),
      ).toBeUndefined();
    });

    it("refuses a remove by a writer the field does not name", async () => {
      const bio = await authoredField("authored-remove");

      expect(await writeAs("mallory", (tx) => bio(tx).removeAnchor("h")))
        .toContain("writeAuthorizedBy failed at /bio");
      expect(await writeAs(AUTHOR, (tx) => bio(tx).removeAnchor("h")))
        .toBeUndefined();
    });
  });

  describe("confidentiality", () => {
    /**
     * Seeds the labeled source and the public field `name`, and returns what
     * committing `write` refuses, from a transaction that read the source.
     */
    const afterReadingSecret = async (
      name: string,
      write: (out: Cell<string>, secret: string) => void,
    ): Promise<string | undefined> => {
      const seed = runtime.edit();
      runtime.getCell(space, "anchors-source", SOURCE_SCHEMA, seed).set({
        v: "hunter2",
      });
      runtime.getCell(space, name, PUBLIC_SCHEMA, seed).set({
        out: "public text",
      });
      expect(refusalOf(await seed.commit().settled)).toBeUndefined();
      await runtime.storageManager.synced();

      const tx = runtime.edit();
      const secret = runtime.getCell(space, "anchors-source", SOURCE_SCHEMA, tx)
        .key("v").get();
      write(
        runtime.getCell(space, name, PUBLIC_SCHEMA, tx).key("out"),
        secret,
      );
      tx.prepareCfc();
      const refusal = refusalOf(await tx.commit().settled);
      await runtime.storageManager.synced();
      return refusal;
    };

    it("refuses `set()` of a tainted value into a public field", async () => {
      // The baseline the anchor below is held to.

      expect(
        await afterReadingSecret(
          "public-set",
          (out, secret) => out.set(`leak:${secret}`),
        ),
      ).toContain("maxConfidentiality failed at /out");
    });

    it("refuses an anchor from a tainted transaction on a public field", async () => {
      expect(
        await afterReadingSecret(
          "public-anchor",
          (out, secret) =>
            out.addAnchor(`leak:${secret}`, { from: 0, to: secret.length }),
        ),
      ).toContain("maxConfidentiality failed at /out");
    });

    it("commits an anchor on a public field from a transaction that read nothing labeled", async () => {
      const seed = runtime.edit();
      runtime.getCell(space, "public-clean", PUBLIC_SCHEMA, seed).set({
        out: "public text",
      });
      expect(refusalOf(await seed.commit().settled)).toBeUndefined();
      await runtime.storageManager.synced();

      const tx = runtime.edit();
      runtime.getCell(space, "public-clean", PUBLIC_SCHEMA, tx).key("out")
        .addAnchor("p", { from: 0, to: 6 });
      tx.prepareCfc();
      expect(refusalOf(await tx.commit().settled)).toBeUndefined();
    });

    /**
     * Anchors `name`'s body under `schema`, reads its `anchorsOf()` in another
     * transaction, copies an anchor id into a public field there, and returns
     * what that copy's commit refuses.
     */
    const copyAnchorsOf = async (
      name: string,
      schema: JSONSchema,
    ): Promise<string | undefined> => {
      const seed = runtime.edit();
      const note = runtime.getCell<{ body: string }>(space, name, schema, seed);
      note.set({ body: "hello world" });
      runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, seed).set({
        out: "",
      });
      expect(refusalOf(await seed.commit().settled)).toBeUndefined();
      const anchor = runtime.edit();
      note.withTx(anchor).key("body").addAnchor("w", { from: 6, to: 11 });
      expect(refusalOf(await anchor.commit().settled)).toBeUndefined();
      await runtime.storageManager.synced();

      const { commonfabric } = createTrustedBuilder(runtime);
      const reader = commonfabric.pattern<{ body: string }>(({ body }) => ({
        anchors: commonfabric.anchorsOf(body),
      }));
      const setup = runtime.edit();
      const result = runtime.run(
        setup,
        reader,
        { body: note.key("body") },
        runtime.getCell(space, `${name}-reader`, undefined, setup),
      );
      expect(refusalOf(await setup.commit().settled)).toBeUndefined();
      const arrived = Promise.withResolvers<void>();
      const cancel = result.key("anchors").sink((anchors) => {
        if (anchors !== undefined) arrived.resolve();
      });
      await arrived.promise;
      cancel();
      await runtime.idle();

      const copy = runtime.edit();
      const anchors = result.withTx(copy).key("anchors").get() as
        | FieldAnchors
        | undefined;
      expect(anchors?.anchors.map(({ id }) => id)).toEqual(["w"]);
      runtime.getCell(space, `${name}-copy`, PUBLIC_SCHEMA, copy).key("out")
        .set(anchors?.anchors[0].id ?? "");
      copy.prepareCfc();
      return refusalOf(await copy.commit().settled);
    };

    it("taints a reader of `anchorsOf()` with the confidentiality of the field", async () => {
      expect(await copyAnchorsOf("secret-field", SECRET_FIELD_SCHEMA))
        .toContain("maxConfidentiality failed at /out");
    });

    it("leaves a reader of `anchorsOf()` on an unlabeled field untainted", async () => {
      expect(await copyAnchorsOf("plain-field", PLAIN_FIELD_SCHEMA))
        .toBeUndefined();
    });
  });
});
