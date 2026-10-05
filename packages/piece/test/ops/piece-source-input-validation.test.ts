/**
 * Source-update validation over linked and scoped inputs, including retained
 * profile handles whose producer enforces its own write policy.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPieceSourceSnapshot,
  isLink,
  type JSONSchema,
  parseLinkOrThrow,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  assertSuppliedLinkSchemasCompatible,
  type PieceController,
} from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("source input validation");

function program(version: string, avatarType = "string"): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
import { Cell, Default, pattern, PerSpace, PerUser } from "commonfabric";
interface Profile { name: string; }
interface Row { profile: Cell<Profile>; count: number; note?: string; }
interface Input {
  viewer?: PerUser<{ name?: string } | Default<{}>>;
  rows?: PerSpace<Row[] | Default<[]>>;
  host?: { profile?: Cell<{ avatar?: ${avatarType} }> };
}
export default pattern<Input, { version: string; count: number }>(
  ({ rows }) => ({ version: ${JSON.stringify(version)}, count: rows.length }),
);
`,
    }],
  };
}

/** Declares a writable row projection with defaults on its visible fields. */
function rowProjectionProgram(
  version: string,
  titleDefault = "",
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
import { Default, lift, NAME, pattern, ReadonlyCell, Writable } from "commonfabric";
interface Row {
  [NAME]: string | Default<""> | undefined;
  title: string | Default<${JSON.stringify(titleDefault)}>;
}
interface Input { rows?: Writable<Row[] | Default<[]>>; }
const labelOf = lift((rows: ReadonlyCell<Row[]>) => rows.get()?.[0]?.title ?? "empty");
export default pattern<Input, { label: string; version: string }>(({ rows }) => ({
  label: labelOf(rows!),
  version: ${JSON.stringify(version)},
}));
`,
    }],
  };
}

describe("piece-controller", () => {
  describe("source input validation", () => {
    let storage: EmulatedStorageManager;
    let server: ReturnType<typeof newLoopbackServer>;
    let runtime: Runtime;
    let pieces: PiecesController;

    async function withFreshPiece(
      id: string,
      run: (piece: PieceController, replica: PiecesController) => Promise<void>,
    ): Promise<void> {
      await runtime.idle();
      await storage.synced();
      const freshStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const freshRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: freshStorage,
      });
      try {
        const freshPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          freshRuntime,
        );
        await freshPieces.synced();
        await run(await freshPieces.get(id, false), freshPieces);
      } finally {
        await freshRuntime.dispose();
        await freshStorage.close();
      }
    }

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      storage = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: storage,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
      await server.close();
    });

    it("returns a compatible verdict for an uninitialized user-scoped input", async () => {
      const piece = await pieces.create(program("v1"));
      const argument = pieces.getArgument(piece.getCell());
      const before = getPieceSourceSnapshot(piece.getCell());
      expect(isLink((argument.getRaw() as { viewer: unknown }).viewer)).toBe(
        true,
      );
      const scoped = runtime.getCellFromLink(parseLinkOrThrow(
        (argument.getRaw() as { viewer: unknown }).viewer,
        argument,
      ));
      const { error } = await runtime.editWithRetry((tx) => {
        scoped.withTx(tx).asSchema(undefined).set(undefined);
      });
      expect(error).toBeUndefined();

      const report = await piece.checkPattern(program("v2"));
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      expect(getPieceSourceSnapshot(piece.getCell())).toEqual(before);

      await piece.setPattern(program("v2"));
      expect(await piece.result.get()).toMatchObject({
        version: "v2",
        count: 0,
      });
    });

    it("returns a compatible verdict for an optional `undefined` field in a linked row", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "Baker" });
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: 2, note: undefined });
      });
      expect(error).toBeUndefined();
      expect(isLink((argument.getRaw() as { rows: unknown[] }).rows[0])).toBe(
        true,
      );

      await withFreshPiece(piece.id, async (reloaded, replica) => {
        const report = await reloaded.checkPattern(program("v2"));
        expect(report.issues).toEqual({});
        expect(report.compatible).toBe(true);
        await reloaded.setPattern(program("v2"));
        expect(await reloaded.result.get()).toMatchObject({
          version: "v2",
          count: 1,
        });
        expect(
          await replica.getArgument(reloaded.getCell()).asSchema(undefined)
            .pull(),
        )
          .toMatchObject({ rows: [{ profile: { name: "Baker" }, count: 2 }] });
      });
    });

    it("defers an unreadable linked profile until its value arrives", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: 2, note: "linked" });
      });
      expect(error).toBeUndefined();
      expect(isLink((argument.getRaw() as { rows: unknown[] }).rows[0])).toBe(
        true,
      );

      await withFreshPiece(piece.id, async (reloaded, replica) => {
        const report = await reloaded.checkPattern(program("v2"));
        expect(report.issues).toEqual({});
        expect(report.compatible).toBe(true);
        await reloaded.setPattern(program("v2"));
        expect(await reloaded.result.get()).toMatchObject({
          version: "v2",
          count: 1,
        });
        const { error } = await replica.runtime.editWithRetry((tx) => {
          replica.runtime.getCellFromLink(profile.getAsNormalizedFullLink())
            .withTx(tx).set({ name: "Baker" });
        });
        expect(error).toBeUndefined();
        expect(
          await replica.getArgument(reloaded.getCell()).asSchema(undefined)
            .pull(),
        )
          .toMatchObject({
            rows: [{ profile: { name: "Baker" }, count: 2, note: "linked" }],
          });
      });
    });

    it("refuses a readable wrong-typed value inside a linked row", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "Baker" });
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: "two" });
      });
      expect(error).toBeUndefined();
      await argument.asSchema(undefined).pull();
      const before = getPieceSourceSnapshot(piece.getCell());
      const report = await piece.checkPattern(program("v2"));
      expect(report.compatible).toBe(false);
      expect(report.issues.argument).toContain(
        "count: value does not match type number",
      );
      await expect(piece.setPattern(program("v2"))).rejects.toThrow("count");
      expect(getPieceSourceSnapshot(piece.getCell())).toEqual(before);
    });

    it("returns a compatible verdict for a retained owner-protected profile", async () => {
      const profile = await pieces.create({
        main: "/profile.tsx",
        files: [{
          name: "/profile.tsx",
          contents: `
import {
  Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser,
  Writable, WriteAuthorizedBy,
} from "commonfabric";
const setAvatar = handler<string, { avatar: Writable<string> }>(
  (value, { avatar }) => avatar.set(value),
);
type Owned = RepresentsCurrentUser<Cfc<
  WriteAuthorizedBy<string, typeof setAvatar>,
  { ownerPrincipal: CurrentPrincipal }
>>;
export default pattern<{ avatar: string }, { avatar: Owned }>(
  ({ avatar }) => ({ avatar }),
);
`,
        }],
      }, { input: { avatar: "donut" } });
      expect(await profile.result.get()).toMatchObject({ avatar: "donut" });
      const piece = await pieces.create(program("v1"));
      const argument = pieces.getArgument(piece.getCell());
      const candidate = await runtime.patternManager.compilePattern(
        program("v2"),
        {
          space: pieces.getSpace(),
        },
      );
      expect(() =>
        assertSuppliedLinkSchemasCompatible(
          [{ path: ["host", "profile"], value: profile.getCell() }],
          candidate.argumentSchema,
          argument,
          pieces,
          {
            priorArgumentSchema: candidate.argumentSchema,
            linksPreservedVerbatim: true,
          },
        )
      ).toThrow("ifc changed");
      const { error } = await runtime.editWithRetry((tx) => {
        argument.withTx(tx).asSchema<{ host: unknown }>(undefined).key("host")
          .set({ profile: profile.getCell() });
      });
      expect(error).toBeUndefined();
      const report = await piece.checkPattern(program("v2"));
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      const profileBefore = profile.getCell().getRaw();
      const profileSchemaBefore = profile.getCell().getMetaRaw("schema");
      expect(profileSchemaBefore).toBeDefined();
      await piece.setPattern(program("v2"));
      expect(await piece.result.get()).toMatchObject({ version: "v2" });
      expect(profile.getCell().getRaw()).toEqual(profileBefore);
      expect(profile.getCell().getMetaRaw("schema")).toEqual(
        profileSchemaBefore,
      );

      const changed = await piece.checkPattern(program("v3", "number"));
      expect(changed.compatible).toBe(false);
      expect(changed.issues.retainedLinks).toBeDefined();
      await expect(piece.setPattern(program("v3", "number"))).rejects.toThrow();
      expect(await piece.result.get()).toMatchObject({ version: "v2" });
    });

    it("requires the producer proof when a retained handle's scalar default changes", async () => {
      const producer = runtime.getCell<string>(pieces.getSpace(), "producer");
      const argument = runtime.getCell<{ value: unknown }>(
        pieces.getSpace(),
        "argument",
      );
      // Seed the committed binding independently of new-link admission so the
      // consumer's unchanged contract is what permits retention.
      const { error } = await runtime.editWithRetry((tx) => {
        producer.withTx(tx).set("a");
        producer.withTx(tx).setMetaRaw(
          "schema",
          { type: "string", enum: ["a"] },
          rawMetaWriteAuthorization,
        );
        argument.withTx(tx).set({ value: producer });
      });
      expect(error).toBeUndefined();

      const schema = (defaultValue: string): JSONSchema => ({
        type: "object",
        properties: {
          value: { type: "string", asCell: ["cell"], default: defaultValue },
        },
        required: ["value"],
      });
      const priorArgumentSchema = schema("a");
      const links = [{ path: ["value"], value: argument.getRaw()?.value }];
      expect(isLink(links[0].value)).toBe(true);
      const restore = (candidate: JSONSchema) =>
        assertSuppliedLinkSchemasCompatible(
          links,
          candidate,
          argument,
          pieces,
          { priorArgumentSchema, linksPreservedVerbatim: true },
        );

      expect(() => restore(schema("a"))).not.toThrow();
      expect(() => restore(schema("b"))).toThrow(
        "enum/const became more restrictive",
      );
    });

    it("checks the producer contract when a retained handle's prior consumer schema cannot resolve", async () => {
      const producer = runtime.getCell<string>(pieces.getSpace(), "producer");
      const argument = runtime.getCell<{ value: unknown }>(
        pieces.getSpace(),
        "argument",
      );
      const { error } = await runtime.editWithRetry((tx) => {
        producer.withTx(tx).set("a");
        producer.withTx(tx).setMetaRaw(
          "schema",
          { type: "string" },
          rawMetaWriteAuthorization,
        );
        argument.withTx(tx).set({ value: producer });
      });
      expect(error).toBeUndefined();

      const links = [{ path: ["value"], value: argument.getRaw()?.value }];
      expect(isLink(links[0].value)).toBe(true);
      const restore = (type: "string" | "number") =>
        assertSuppliedLinkSchemasCompatible(
          links,
          {
            type: "object",
            properties: { value: { type, asCell: ["cell"] } },
            required: ["value"],
          },
          argument,
          pieces,
          {
            priorArgumentSchema: { $ref: "#/$defs/missing" },
            linksPreservedVerbatim: true,
          },
        );

      expect(() => restore("string")).not.toThrow();
      expect(() => restore("number")).toThrow(
        "type string is not accepted by the candidate schema",
      );
    });

    it("retains unchanged row defaults for identical source and a stopped source update", async () => {
      const producer = await pieces.create({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
import { NAME, pattern } from "commonfabric";
interface Row { [NAME]: string; title: string; piece: unknown; }
export default pattern<Record<string, never>, { rows: Row[] }>(() => ({
  rows: [{ [NAME]: "Donut", title: "Donut", piece: { reference: "preserved" } }],
}));
`,
        }],
      });
      const source = rowProjectionProgram("v1");
      const consumer = await pieces.create(source);
      expect((await consumer.checkPattern(source)).compatible).toBe(true);
      const pattern = await runtime.patternManager.compilePattern(source, {
        space: pieces.getSpace(),
      });
      const argument = pieces.getArgument(consumer.getCell());
      // Seed an existing binding independently of new-link admission, so this
      // test exercises retention of the consumer's writable projection.
      const { error } = await runtime.editWithRetry((tx) => {
        const input = argument.withTx(tx);
        input.key("rows").setRawUntyped(
          producer.getCell().withTx(tx).asSchemaFromLinks().key("rows")
            .getAsLink({ base: input, includeSchema: true }),
        );
      });
      expect(error).toBeUndefined();
      const before = argument.getRaw();

      const sameSource = await consumer.checkPattern(source);
      expect(sameSource.issues).toEqual({});
      expect(sameSource.compatible).toBe(true);
      const nextSource = rowProjectionProgram("v2");
      const changedSource = await consumer.checkPattern(nextSource);
      expect(changedSource.issues).toEqual({});
      expect(changedSource.compatible).toBe(true);
      runtime.runner.stop(consumer.getCell());
      await consumer.setPattern(nextSource);
      expect(await consumer.result.get()).toMatchObject({
        label: "Donut",
        version: "v2",
      });
      expect(
        valueEqual(argument.getRaw() as FabricValue, before as FabricValue),
      )
        .toBe(true);

      const changedDefaults = await consumer.checkPattern(
        rowProjectionProgram("v3", "Glaze"),
      );
      expect(changedDefaults.compatible).toBe(false);
      expect(changedDefaults.issues.retainedLinks).toBeDefined();

      const otherProducer = await pieces.create({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
import { pattern } from "commonfabric";
export default pattern<Record<string, never>, { rows: { title: number }[] }>(
  () => ({ rows: [{ title: 1 }] }),
);
`,
        }],
      });
      expect(() =>
        assertSuppliedLinkSchemasCompatible(
          [{
            path: ["rows"],
            value: otherProducer.getCell().key("rows").getAsLink({
              base: argument,
              includeSchema: false,
            }),
          }],
          pattern.argumentSchema,
          argument,
          pieces,
          {
            priorArgumentSchema: pattern.argumentSchema,
            linksPreservedVerbatim: true,
          },
        )
      ).toThrow();
    });
  });
});
