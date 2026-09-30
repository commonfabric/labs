import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  seedStoredReferenceEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";

import { createSession, Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece input scoped links");

/** The stored form of a per-user slot: a redirect into the user instance. */
const userRedirect = (path: string[]) => ({
  "/": { "link@1": { overwrite: "redirect", path, scope: "user" } },
});

const schema: JSONSchema = {
  type: "object",
  properties: {
    myName: { type: "string" },
    title: { type: "string" },
  },
  required: ["myName", "title"],
};

describe("piece-controller", () => {
  describe("input writes over stored links", () => {
    let storage: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let session: Awaited<ReturnType<typeof createSession>>;
    let pieces: PiecesController;

    beforeEach(async () => {
      storage = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://localhost:9999"),
        storageManager: storage,
      });
      session = await createSession({
        identity: signer,
        spaceName: crypto.randomUUID(),
      });
      pieces = new PiecesController(session, runtime);
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    /** Installs a schema fixture through the normal persistent-piece setup. */
    async function createWith(
      argumentSchema: JSONSchema,
      input: unknown,
    ): Promise<PieceController> {
      const pattern = runtime.unsafeTrustPattern({
        argumentSchema,
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }, { reason: "stored link input fixture" });
      const result = await pieces.runPersistent(pattern, undefined, undefined, {
        start: true,
      });
      const argument = pieces.getArgument(result).resolveAsCell();
      const written = await runtime.editWithRetry((tx) => {
        writeSeedEnvelopeDoc(tx, session.space);
        const address = { ...argument.getAsNormalizedFullLink(), path: [] };
        const envelope = tx.readOrThrow(address) as Record<string, FabricValue>;
        seedStoredReferenceEnvelope(tx, address, {
          ...envelope,
          value: input as FabricValue,
        });
      });
      expect(written.error).toBeUndefined();
      return new PieceController(pieces, result);
    }

    /** Installs the `myName`/`title` fixture. */
    const create = (input: unknown) => createWith(schema, input);

    /** The argument document as stored, links unresolved. */
    const rawArgument = (piece: PieceController) =>
      pieces.getArgument(piece.getCell()).getRaw() as Record<string, unknown>;

    it("writes a sibling of a per-user slot this principal has not written", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.set("after", ["title"]);

      expect(await piece.input.get(["title"])).toBe("after");
    });

    it("writes the per-user slot itself through its redirect", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.set("me", ["myName"]);

      expect(await piece.input.get(["myName"])).toBe("me");
      // The redirect is what the shared document keeps; the name went to
      // this principal's instance behind it.
      expect(rawArgument(piece).myName).toEqual(userRedirect(["myName"]));
    });

    it("writes a root value that re-supplies the stored redirect unchanged", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.edit((stored) => ({
        value: { ...(stored as Record<string, unknown>), title: "after" },
      }));

      expect(await piece.input.get(["title"])).toBe("after");
      expect(rawArgument(piece).myName).toEqual(userRedirect(["myName"]));
    });

    it("writes a supplied redirect at the slot it points from", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.set(rawArgument(piece).myName, ["myName"]);

      expect(rawArgument(piece).myName).toEqual(userRedirect(["myName"]));
    });

    it("writes below a readable link into the slot it points at", async () => {
      const pair: JSONSchema = {
        type: "object",
        properties: { b: { type: "string" }, c: { type: "string" } },
        required: ["b", "c"],
      };
      // `obj` aliases `inner` within the same document, so a write below
      // `obj` lands in `inner`.
      const alias = { "/": { "link@1": { path: ["inner"] } } };
      const piece = await createWith({
        type: "object",
        properties: { obj: pair, inner: pair },
        required: ["obj", "inner"],
      }, { obj: alias, inner: { b: "before", c: "x" } });

      await piece.input.set("after", ["obj", "b"]);

      expect(await piece.input.get(["inner"])).toEqual({ b: "after", c: "x" });
      expect(rawArgument(piece).obj).toEqual(alias);
    });

    it("throws on `myName` when a linked slot holds a readable wrong-typed value", async () => {
      const tx = runtime.edit();
      const other = runtime.getCell(
        session.space,
        "wrong-typed-name",
        { type: "object", properties: { n: { type: "number" } } },
        tx,
      );
      other.set({ n: 42 });
      await tx.commit();
      const piece = await create({
        myName: other.key("n").getAsLink(),
        title: "before",
      });

      await expect(piece.input.set("after", ["title"])).rejects.toThrow(
        /myName: value does not match type string/,
      );
    });

    it("throws on `myName` when `undefined` is written at the linked slot", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await expect(piece.input.set(undefined, ["myName"])).rejects.toThrow(
        /myName/,
      );
    });
  });
});
