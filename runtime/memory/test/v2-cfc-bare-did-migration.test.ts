import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import {
  BARE_DID_RESPELLING,
  type DocumentMigration,
  isMigrationDone,
  migrationSessionId,
  respellBareDidEnvelope,
  retireBareDidLabels,
  runDocumentMigration,
} from "../v2/cfc-bare-did-migration.ts";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import { restoreBranch } from "../v2/history.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import type { Operation } from "../v2.ts";

const OWNER = "did:key:z6MkBareDidOwnerFixture";
const OTHER = "did:key:z6MkBareDidOtherFixture";
const SPACE = OWNER;

const user = (did: string) => ({ type: CFC_ATOM_TYPE.User, subject: did });
const personalSpace = (did: string) => ({
  type: CFC_ATOM_TYPE.PersonalSpace,
  owner: did,
});

const schema = { type: "object" } as const;
const schemaHash = internSchemaAsTaggedHashString(schema);

const envelope = (entries: unknown[]) => ({
  version: 1,
  schemaHash,
  labelMap: { version: 1, entries },
});

const entry = (
  path: string[],
  origin: string,
  confidentiality: unknown[],
  observes?: string,
) => ({
  path,
  origin,
  ...(observes === undefined ? {} : { observes }),
  label: { confidentiality },
});

/** A label map naming the owner by bare DID, once for each origin. */
const STALE = envelope([
  entry([], "derived", [OWNER], "shape"),
  entry([], "structure", [OWNER, personalSpace(OTHER)], "enumerate"),
  entry(["items"], "declared", [{ anyOf: [OWNER, user(OTHER)] }]),
  entry(["items"], "link", [OWNER]),
  entry(["cfc", "labels"], "label-metadata", [OWNER]),
]);

/** `STALE` with every bare DID named as `User{subject}`. */
const RESPELLED = envelope([
  entry([], "derived", [user(OWNER)], "shape"),
  entry([], "structure", [user(OWNER), personalSpace(OTHER)], "enumerate"),
  entry(["items"], "declared", [{ anyOf: [user(OWNER), user(OTHER)] }]),
  entry(["items"], "link", [user(OWNER)]),
  entry(["cfc", "labels"], "label-metadata", [user(OWNER)]),
]);

const VALUE = { items: ["a", "b"], members: [OWNER, OTHER] };

/** Sets `stale: false` on every document holding `stale: true`. */
const freshen: DocumentMigration = {
  name: "freshen/1",
  scopes: ["space", "user"],
  rewrite: (document) =>
    (document.value as { stale?: boolean } | undefined)?.stale === true
      ? [{ op: "replace", path: "/value/stale", value: false }]
      : undefined,
};

describe("cfc-bare-did-migration", () => {
  let path: string;
  let engine: Engine;
  let localSeq: number;

  const commit = (
    operations: unknown[],
    options: { principal?: string; sessionId?: string } = {},
  ) =>
    applyCommit(engine, {
      sessionId: options.sessionId ?? "s:fixture",
      space: SPACE,
      principal: options.principal ?? OWNER,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: operations as Operation[],
      },
    });

  const seed = (id: string, cfc: unknown, scope?: "user" | "session") =>
    commit([
      { op: "set", id: `cid:${schemaHash}`, value: { value: schema } },
      {
        op: "set",
        id,
        ...(scope === undefined ? {} : { scope }),
        value: { value: VALUE, cfc },
      },
    ]);

  const stored = (id: string, scope?: "user" | "session") =>
    read(engine, {
      id,
      ...(scope === undefined ? {} : { scope, principal: OWNER }),
      ...(scope === "session" ? { sessionId: "s:fixture" } : {}),
    }) as { value?: unknown; cfc?: unknown } | null;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  describe("retireBareDidLabels()", () => {
    it("respells every origin's bare DID at space and user scope", async () => {
      seed("of:space-doc", STALE);
      seed("of:user-doc", STALE, "user");

      const report = await retireBareDidLabels(engine, { space: SPACE });

      expect(report).toEqual({ done: true, rewritten: 2, skipped: [] });
      expect(stored("of:space-doc")?.cfc).toEqual(RESPELLED);
      expect(stored("of:user-doc", "user")?.cfc).toEqual(RESPELLED);
    });

    it("leaves every document value as it was", async () => {
      seed("of:space-doc", STALE);
      seed("of:user-doc", STALE, "user");

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:space-doc")?.value).toEqual(VALUE);
      expect(stored("of:user-doc", "user")?.value).toEqual(VALUE);
    });

    it("leaves a session's instances as they are", async () => {
      seed("of:session-doc", STALE, "session");

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:session-doc", "session")?.cfc).toEqual(STALE);
    });

    it("respells a bare DID a patch wrote into one clause", async () => {
      seed("of:patched", RESPELLED);
      commit([{
        op: "patch",
        id: "of:patched",
        patches: [{
          op: "replace",
          path: "/cfc/labelMap/entries/3/label/confidentiality/0",
          value: OWNER,
        }],
      }]);
      expect(
        (stored("of:patched")?.cfc as typeof STALE).labelMap.entries[3],
      ).toEqual(entry(["items"], "link", [OWNER]));

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:patched")?.cfc).toEqual(RESPELLED);
    });

    it("leaves a document whose labels name no bare DID untouched", async () => {
      seed("of:clean", RESPELLED);
      const before = read(engine, { id: "of:clean" });

      const report = await retireBareDidLabels(engine, { space: SPACE });

      expect(report.rewritten).toBe(0);
      expect(read(engine, { id: "of:clean" })).toEqual(before);
    });

    it("writes inline the respelled label of an entry held by reference", async () => {
      const label = { confidentiality: [OWNER] };
      const labelId = `cid:${taggedHashStringOf(label)}`;
      commit([{ op: "set", id: labelId, value: { value: label } }]);
      seed("of:by-ref", {
        version: 2,
        schemaHash,
        labelMap: {
          version: 1,
          entries: [{ path: [], origin: "derived", label: { $ref: labelId } }],
        },
      });

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:by-ref")?.cfc).toEqual({
        version: 2,
        schemaHash,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "derived",
            label: { confidentiality: [user(OWNER)] },
          }],
        },
      });
    });

    it("drops an alternative or clause the respelling makes a repeat of another", async () => {
      seed(
        "of:repeats",
        envelope([
          entry([], "derived", [
            { anyOf: [OWNER, user(OWNER), user(OTHER)] },
            OWNER,
            user(OWNER),
          ]),
        ]),
      );

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:repeats")?.cfc).toEqual(
        envelope([
          entry([], "derived", [
            { anyOf: [user(OWNER), user(OTHER)] },
            user(OWNER),
          ]),
        ]),
      );
    });

    it("leaves a DID string that is malformed or of another method", async () => {
      const others = envelope([
        entry([], "derived", ["did:key: spaced", "did:web:example.com"]),
      ]);
      seed("of:others", others);

      await retireBareDidLabels(engine, { space: SPACE });

      expect(stored("of:others")?.cfc).toEqual(others);
    });

    it("writes back respelled the labels of a restore to a point before it", async () => {
      const before = seed("of:space-doc", STALE).seq;
      commit([{
        op: "patch",
        id: "of:space-doc",
        patches: [{ op: "replace", path: "/value/items", value: ["c"] }],
      }]);
      await retireBareDidLabels(engine, { space: SPACE });

      restoreBranch(engine, {
        space: SPACE,
        sourceSeq: before,
        sessionId: "s:restore",
        localSeq: 1,
      });

      expect(stored("of:space-doc")).toEqual({ value: VALUE, cfc: RESPELLED });
    });

    it("writes back inline and respelled a label a restored document held by reference", async () => {
      const label = { confidentiality: [OWNER] };
      const labelId = `cid:${taggedHashStringOf(label)}`;
      const byReference = {
        version: 2,
        schemaHash,
        labelMap: {
          version: 1,
          entries: [{ path: [], origin: "derived", label: { $ref: labelId } }],
        },
      };
      commit([{ op: "set", id: labelId, value: { value: label } }]);
      const before = seed("of:by-ref", byReference).seq;
      commit([{
        op: "patch",
        id: "of:by-ref",
        patches: [{ op: "replace", path: "/value/items", value: ["c"] }],
      }]);
      await retireBareDidLabels(engine, { space: SPACE });

      restoreBranch(engine, {
        space: SPACE,
        sourceSeq: before,
        sessionId: "s:restore",
        localSeq: 1,
      });

      expect(stored("of:by-ref")?.cfc).toEqual({
        ...byReference,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "derived",
            label: { confidentiality: [user(OWNER)] },
          }],
        },
      });
    });

    it("writes back as recorded the labels of a restore on a store not respelled", () => {
      const before = seed("of:space-doc", STALE).seq;
      commit([{
        op: "patch",
        id: "of:space-doc",
        patches: [{ op: "replace", path: "/value/items", value: ["c"] }],
      }]);

      restoreBranch(engine, {
        space: SPACE,
        sourceSeq: before,
        sessionId: "s:restore",
        localSeq: 1,
      });

      expect(stored("of:space-doc")).toEqual({ value: VALUE, cfc: STALE });
    });

    it("marks the store done, so a later run leaves a new bare DID", async () => {
      seed("of:space-doc", STALE);
      await retireBareDidLabels(engine, { space: SPACE });
      seed("of:new", STALE);

      const report = await retireBareDidLabels(engine, { space: SPACE });

      expect(isMigrationDone(engine, BARE_DID_RESPELLING.name)).toBe(true);
      expect(report).toEqual({ done: true, rewritten: 0, skipped: [] });
      expect(stored("of:new")?.cfc).toEqual(STALE);
    });
  });

  describe("respellBareDidEnvelope()", () => {
    it("leaves as they are the entries it cannot read a confidentiality from", () => {
      const unreadable = [
        "not an entry",
        { path: [], origin: "derived", label: "not a label" },
        { path: [], origin: "derived", label: { confidentiality: "none" } },
      ];

      const respelled = respellBareDidEnvelope(
        envelope([...unreadable, entry([], "declared", [OWNER])]),
        () => undefined,
      );

      expect(respelled).toEqual(
        envelope([...unreadable, entry([], "declared", [user(OWNER)])]),
      );
    });

    it("returns undefined for an envelope without a label map", () => {
      expect(respellBareDidEnvelope({ version: 1 }, () => undefined))
        .toBeUndefined();
    });
  });

  describe("a memory server opening a store", () => {
    const serve = (retireBareDidLabels: boolean, store: URL) =>
      new Server({
        store,
        subscriptionRefreshDelayMs: "manual",
        authorizeSessionOpen: () => undefined,
        sessionOpenAuth: { audience: "did:key:z6MkBareDidAudienceFixture" },
        retireBareDidLabels,
      });

    let store: URL;

    beforeEach(async () => {
      close(engine);
      const directory = await Deno.makeTempDir();
      store = toFileUrl(`${directory}/`);
      const url = resolveSpaceStoreUrl(
        store,
        SPACE as `did:${string}:${string}`,
      );
      await Deno.mkdir(new URL(".", url), { recursive: true });
      engine = await open({ url });
      seed("of:space-doc", STALE);
      close(engine);
    });

    afterEach(async () => {
      await Deno.remove(store, { recursive: true });
      engine = await open({ url: toFileUrl(path) });
    });

    it("respells the store's labels before serving it when retiring them", async () => {
      const server = serve(true, store);
      const served = await server.engineForSpace(SPACE);

      expect(
        (read(served, { id: "of:space-doc" }) as { cfc?: unknown })?.cfc,
      ).toEqual(RESPELLED);
      expect(isMigrationDone(served, BARE_DID_RESPELLING.name)).toBe(true);
      await server.close();
    });

    it("serves the store with its labels as they stand when the respelling fails", async () => {
      // A view where the migration's marker table belongs lets the walk
      // finish and refuses only its last write, the marker.
      engine = await open({
        url: resolveSpaceStoreUrl(store, SPACE as `did:${string}:${string}`),
      });
      engine.prepare(
        `CREATE VIEW store_migration AS SELECT 'x' AS name WHERE 0`,
      ).run();
      close(engine);
      const server = serve(true, store);
      const served = await server.engineForSpace(SPACE);

      expect(read(served, { id: "of:space-doc" })).not.toBeNull();
      expect(isMigrationDone(served, BARE_DID_RESPELLING.name)).toBe(false);
      await server.close();
    });

    it("leaves the store's labels as they are when not retiring them", async () => {
      const server = serve(false, store);
      const served = await server.engineForSpace(SPACE);

      expect(
        (read(served, { id: "of:space-doc" }) as { cfc?: unknown })?.cfc,
      ).toEqual(STALE);
      await server.close();
    });
  });

  describe("runDocumentMigration() over any rewrite", () => {
    let path: string;
    let engine: Engine;
    let localSeq: number;

    const commit = (operations: unknown[]) =>
      applyCommit(engine, {
        sessionId: "s:fixture",
        principal: OWNER,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: operations as Operation[],
        },
      });

    const set = (id: string, value: unknown, scope?: "user" | "session") => ({
      op: "set",
      id,
      ...(scope === undefined ? {} : { scope }),
      value: { value },
    });

    const valueOf = (id: string, scope?: "user" | "session") =>
      (read(engine, {
        id,
        ...(scope === undefined ? {} : { scope, principal: OWNER }),
        ...(scope === "session" ? { sessionId: "s:fixture" } : {}),
      }) as { value?: unknown } | null)?.value;

    beforeEach(async () => {
      path = await Deno.makeTempFile({ suffix: ".sqlite" });
      engine = await open({ url: toFileUrl(path) });
      localSeq = 0;
    });

    afterEach(async () => {
      close(engine);
      await Deno.remove(path);
    });

    describe("a run", () => {
      it("rewrites the instances of the scopes it reaches, and marks the store done", async () => {
        commit([
          set("of:space", { stale: true }),
          set("of:user", { stale: true }, "user"),
          set("of:clean", { stale: false }),
        ]);

        const report = await runDocumentMigration(engine, freshen);

        expect(report).toEqual({ done: true, rewritten: 2, skipped: [] });
        expect(valueOf("of:space")).toEqual({ stale: false });
        expect(valueOf("of:user", "user")).toEqual({ stale: false });
        expect(isMigrationDone(engine, freshen.name)).toBe(true);
      });

      it("leaves the instances of a scope it does not reach", async () => {
        commit([set("of:session", { stale: true }, "session")]);

        await runDocumentMigration(engine, freshen);

        expect(valueOf("of:session", "session")).toEqual({ stale: true });
      });

      it("commits as the migration's own system session", async () => {
        commit([set("of:space", { stale: true })]);

        await runDocumentMigration(engine, freshen);

        expect(
          engine.database.prepare(
            `SELECT DISTINCT class FROM "commit" WHERE session_id = :session`,
          ).all({ session: migrationSessionId(freshen) }),
        ).toEqual([{ class: "system" }]);
      });

      it("returns done and rewrites nothing on a store already marked", async () => {
        commit([set("of:space", { stale: true })]);
        await runDocumentMigration(engine, freshen);
        commit([set("of:later", { stale: true })]);

        const report = await runDocumentMigration(engine, freshen);

        expect(report).toEqual({ done: true, rewritten: 0, skipped: [] });
        expect(valueOf("of:later")).toEqual({ stale: true });
      });

      it("rewrites every other instance of a batch the store refuses one of, reports it, and marks the store done", async () => {
        commit([
          set("of:a", { stale: true }),
          set("of:b", { stale: true, broken: true }),
          set("of:c", { stale: true }),
        ]);
        const refusing: DocumentMigration = {
          ...freshen,
          rewrite: (document) =>
            (document.value as { broken?: boolean }).broken === true
              ? [{ op: "replace", path: "/value/missing/deep", value: 1 }]
              : freshen.rewrite(document, () => undefined),
        };

        const report = await runDocumentMigration(engine, refusing);

        expect(report.done).toBe(true);
        expect(report.rewritten).toBe(2);
        expect(report.skipped.map(({ id }) => id)).toEqual(["of:b"]);
        expect(valueOf("of:a")).toEqual({ stale: false });
        expect(valueOf("of:b")).toEqual({ stale: true, broken: true });
        expect(valueOf("of:c")).toEqual({ stale: false });
        expect(isMigrationDone(engine, freshen.name)).toBe(true);
      });

      it("rejects, rather than skipping, an instance whose rewrite throws on its retry", async () => {
        commit([
          set("of:a", { stale: true, broken: true }),
          set("of:b", { stale: true }),
        ]);
        let calls = 0;
        const failing: DocumentMigration = {
          ...freshen,
          rewrite: (document) => {
            if ((document.value as { broken?: boolean }).broken !== true) {
              return freshen.rewrite(document, () => undefined);
            }
            calls += 1;
            if (calls > 1) throw new Error("rewrite bug");
            return [{ op: "replace", path: "/value/missing/deep", value: 1 }];
          },
        };

        await expect(runDocumentMigration(engine, failing)).rejects.toThrow(
          "rewrite bug",
        );
        expect(isMigrationDone(engine, freshen.name)).toBe(false);
      });

      it("finishes on a later run what an interrupted run left", async () => {
        const ids = Array.from(
          { length: 300 },
          (_, index) => `of:${String(index).padStart(3, "0")}`,
        );
        commit(ids.map((id) => set(id, { stale: true })));
        const interrupted: DocumentMigration = {
          ...freshen,
          rewrite: (document, readDocument) => {
            if ((document.value as { stop?: boolean }).stop === true) {
              throw new Error("interrupted");
            }
            return freshen.rewrite(document, readDocument);
          },
        };
        commit([set("of:299", { stale: true, stop: true })]);

        await expect(runDocumentMigration(engine, interrupted)).rejects.toThrow(
          "interrupted",
        );
        expect(valueOf("of:000")).toEqual({ stale: false });
        expect(isMigrationDone(engine, freshen.name)).toBe(false);

        commit([set("of:299", { stale: true })]);
        const report = await runDocumentMigration(engine, freshen);

        expect(report.done).toBe(true);
        expect(report.rewritten).toBe(44);
        expect(ids.every((id) => valueOf(id)?.valueOf() !== undefined)).toBe(
          true,
        );
        expect(valueOf("of:299")).toEqual({ stale: false });
      });
    });
  });
});
