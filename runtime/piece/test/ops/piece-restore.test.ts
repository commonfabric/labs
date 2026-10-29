/**
 * The restore seam: the revisions a piece could be returned to, the
 * resolution from a recorded reference to the revision that carries it, and
 * the single-piece restore itself — its listing, its dry preflight, its
 * write, and the refusals it makes instead of one.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { resolveLocalSourceProgram } from "../../src/ops/bulk-local.deno.ts";
import {
  readRestorableSource,
  type RestorableRevision,
  restorePiece,
  selectRestoreRevision,
} from "../../src/ops/piece-restore.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece restore");

/** A generation's source text; `version` is what tells generations apart. */
function memberSource(version: string): string {
  return [
    "import { NAME, pattern } from 'commonfabric';",
    "export default pattern<{ seed?: string }>(({ seed }) => ({",
    "  [NAME]: 'Member',",
    `  version: ${JSON.stringify(version)},`,
    "  seed,",
    "}));",
    "",
  ].join("\n");
}

/** A revision as the log would hold it, for the pure selection tests. */
function revision(
  overrides: Partial<RestorableRevision> & { revisionId: string },
): RestorableRevision {
  return {
    timestamp: 1,
    patternIdentity: "old",
    symbol: "default",
    operation: "baseline",
    retained: true,
    current: false,
    ...overrides,
  };
}

describe("piece-restore", () => {
  describe("selectRestoreRevision()", () => {
    it("returns the revision a recorded id names", () => {
      const chosen = selectRestoreRevision(
        [revision({ revisionId: "r1" }), revision({ revisionId: "r2" })],
        { patternIdentity: "old", symbol: "default", revisionId: "r2" },
      );
      expect(chosen).toEqual({ revision: revision({ revisionId: "r2" }) });
    });

    it("returns a problem naming a recorded id the log does not hold", () => {
      const chosen = selectRestoreRevision([revision({ revisionId: "r1" })], {
        patternIdentity: "old",
        symbol: "default",
        revisionId: "gone",
      });
      expect(chosen).toEqual({
        problem: "The piece's source log holds no revision gone.",
      });
    });

    it("returns a problem for a recorded id carrying another reference", () => {
      // The log is not the one the plan was derived from, so restoring this
      // revision would return the piece to something its reader never saw.
      const chosen = selectRestoreRevision(
        [revision({ revisionId: "r1", patternIdentity: "other" })],
        { patternIdentity: "old", symbol: "default", revisionId: "r1" },
      );
      expect(chosen).toEqual({
        problem:
          "Revision r1 is on other#default, not the old#default this row " +
          "recorded.",
      });
    });

    it("returns the most recent revision on a reference with no id recorded", () => {
      const chosen = selectRestoreRevision([
        revision({ revisionId: "r1" }),
        revision({ revisionId: "r2", patternIdentity: "new" }),
        revision({ revisionId: "r3", operation: "revert" }),
      ], { patternIdentity: "old", symbol: "default" });
      expect(chosen).toEqual({
        revision: revision({ revisionId: "r3", operation: "revert" }),
      });
    });

    it("compares both halves of a reference, not the identity alone", () => {
      // Two patterns one module exports share an identity and differ only
      // in symbol, so an identity-only match would restore the wrong export.
      const chosen = selectRestoreRevision(
        [revision({ revisionId: "r1", symbol: "MemberAlias" })],
        { patternIdentity: "old", symbol: "default" },
      );
      expect(chosen).toEqual({
        problem: "The piece's source log holds no revision on old#default.",
      });
    });

    it("returns a problem for a revision whose source is not retained", () => {
      const chosen = selectRestoreRevision(
        [revision({ revisionId: "r1", retained: false })],
        { patternIdentity: "old", symbol: "default" },
      );
      expect(chosen).toEqual({
        problem:
          "The source behind old#default is not retained in this space, so " +
          "revision r1 cannot be restored.",
      });
    });
  });

  describe("restorePiece()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let dir: string;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
      dir = await Deno.makeTempDir({ prefix: "piece-restore-src" });
      await Deno.writeTextFile(`${dir}/member-v1.tsx`, memberSource("one"));
      await Deno.writeTextFile(`${dir}/member-v2.tsx`, memberSource("two"));
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
      await Deno.remove(dir, { recursive: true });
    });

    /** A piece on v1, moved to v2 — so its log holds both generations. */
    async function movedPiece(): Promise<{ id: string; v1: string }> {
      const v1 = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/member-v1.tsx`,
      });
      const v2 = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/member-v2.tsx`,
      });
      const piece = await pieces.create(v1, { input: { seed: "s" } });
      const controller = await pieces.get(piece.id, false);
      await controller.setPattern(v2);
      await pieces.synced();
      const { revisions } = await readRestorableSource(pieces, controller);
      return { id: piece.id, v1: revisions[0].revisionId };
    }

    it("returns the piece's revisions oldest first, with the current one flagged", async () => {
      const { id } = await movedPiece();
      const outcome = await restorePiece(pieces, id);
      // Creation records the generation the piece started on; the move
      // records the one it went to.
      expect(outcome.revisions.length).toBe(2);
      expect(outcome.revisions.map((entry) => entry.operation)).toEqual([
        "create",
        "edit",
      ]);
      expect(outcome.revisions.map((entry) => entry.current)).toEqual([
        false,
        true,
      ]);
      expect(outcome.revisions.every((entry) => entry.retained)).toBe(true);
      expect(outcome.restored).toBe(false);
      expect(Object.keys(outcome).sort()).toEqual([
        "piece",
        "restored",
        "revisions",
      ]);
    });

    it("writes nothing without apply, naming the revision it would restore", async () => {
      const { id, v1 } = await movedPiece();
      const outcome = await restorePiece(pieces, id, { revisionId: v1 });
      expect(outcome.selected?.revisionId).toBe(v1);
      expect(outcome.restored).toBe(false);
      expect(outcome.problem).toBeUndefined();
      // Equal in value, and a different object: the CLI's JSON serializer
      // renders a second reference to one object as a circular reference,
      // so an alias here would reach a `--json` reader as one.
      expect(outcome.selected).toEqual(outcome.revisions[0]);
      expect(outcome.selected).not.toBe(outcome.revisions[0]);
      const after = await pieces.get(id, false);
      expect(await after.result.get(["version"])).toBe("two");
    });

    it("returns the piece to the named revision under apply", async () => {
      const { id, v1 } = await movedPiece();
      const outcome = await restorePiece(pieces, id, {
        revisionId: v1,
        apply: true,
      });
      expect(outcome.restored).toBe(true);
      expect(outcome.problem).toBeUndefined();
      const after = await pieces.get(id, false);
      expect(await after.result.get(["version"])).toBe("one");
    });

    it("reports a piece already running the named revision without rewriting it", async () => {
      const { id, v1 } = await movedPiece();
      await restorePiece(pieces, id, { revisionId: v1, apply: true });
      const controller = await pieces.get(id, false);
      const before =
        (await readRestorableSource(pieces, controller)).revisions.length;
      const again = await restorePiece(pieces, id, {
        revisionId: v1,
        apply: true,
      });
      // Nothing wrong, and nothing written: no revision was appended, which
      // is what makes restoring resumable one piece at a time.
      expect(again.restored).toBe(false);
      expect(again.problem).toBeUndefined();
      expect(again.selected?.current).toBe(true);
      expect(
        (await readRestorableSource(pieces, controller)).revisions.length,
      ).toBe(
        before,
      );
    });

    it("severs the origin a piece follows when it already runs the named revision's reference", async () => {
      // A restore is a detach as much as it is a reload: it runs the
      // retained bytes AND clears the active origin. So a piece that runs
      // the named revision's reference while still following an origin is
      // not where the restore would leave it, and skipping the write would
      // leave it taking that origin's next update — the operation the
      // operator named having silently not happened.
      const v1 = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/member-v1.tsx`,
      });
      const upstream = "https://example.test/member-v1.tsx";
      const piece = await pieces.create(v1, {
        input: { seed: "s" },
        origin: upstream,
      });
      const controller = await pieces.get(piece.id, false);
      await pieces.synced();
      const before = await readRestorableSource(pieces, controller);
      expect(before.origin).toBe(upstream);
      const head = before.revisions.at(-1)!;
      expect(head.current).toBe(true);

      // The dry run reports the origin, so a caller reading `current` sees
      // the write this run would still make.
      const dry = await restorePiece(pieces, piece.id, {
        revisionId: head.revisionId,
      });
      expect(dry.origin).toBe(upstream);
      expect(dry.restored).toBe(false);

      const outcome = await restorePiece(pieces, piece.id, {
        revisionId: head.revisionId,
        apply: true,
      });
      expect(outcome.restored).toBe(true);
      expect(outcome.problem).toBeUndefined();
      const after = await readRestorableSource(pieces, controller);
      expect(after.origin).toBeNull();
      expect(after.revisions.length).toBe(before.revisions.length + 1);
      expect(after.revisions.at(-1)?.operation).toBe("revert");
    });

    it("reports a restore the runtime judges incompatible rather than forcing it", async () => {
      // The piece is forced onto a source whose result shape the first one
      // cannot produce. Returning to the first is what a rollback row asks
      // for, and the runtime judges it incompatible: a restore carries no
      // override, so the verdict is reported and nothing is written.
      await Deno.writeTextFile(
        `${dir}/text.tsx`,
        [
          "import { NAME, pattern } from 'commonfabric';",
          "export default pattern<{ seed?: string }>(() => ({",
          "  [NAME]: 'Member',",
          "  shown: 'text',",
          "}));",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        `${dir}/number.tsx`,
        [
          "import { NAME, pattern } from 'commonfabric';",
          "export default pattern<{ seed?: string }>(() => ({",
          "  [NAME]: 'Member',",
          "  shown: 7,",
          "}));",
          "",
        ].join("\n"),
      );
      const text = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/text.tsx`,
      });
      const numeric = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/number.tsx`,
      });
      const piece = await pieces.create(text, { input: { seed: "s" } });
      const controller = await pieces.get(piece.id, false);
      // The gate opened deliberately, and only here: it is what puts the
      // piece somewhere the reversal cannot follow without one.
      await controller.setPattern(numeric, {
        dangerouslyAllowIncompatibleSchema: true,
      });
      await pieces.synced();
      const { revisions } = await readRestorableSource(pieces, controller);
      const textRevision = revisions[0].revisionId;
      const outcome = await restorePiece(pieces, piece.id, {
        revisionId: textRevision,
        apply: true,
      });
      expect(outcome.restored).toBe(false);
      expect(outcome.selected?.revisionId).toBe(textRevision);
      expect(outcome.problem).toBeDefined();
      // Nothing written: the piece still runs what it was running.
      const { revisions: after } = await readRestorableSource(
        pieces,
        controller,
      );
      expect(after.map((entry) => entry.revisionId)).toEqual(
        revisions.map((entry) => entry.revisionId),
      );
      expect(await controller.result.get(["shown"])).toBe(7);
    });

    it("refuses a restore the piece's own documents have moved past", async () => {
      // The piece is widened to a source that accepts a number where the
      // first accepted only a string, and then holds one. Restoring the
      // first source is what a rollback row would ask for, and it cannot
      // run: the argument it would be handed is not one it accepts. A
      // restore has no override, so this is a refusal rather than a force.
      // Only the argument differs. Both produce the same result shape, so
      // the widening move is compatible and only the reverse is not.
      await Deno.writeTextFile(
        `${dir}/strict.tsx`,
        [
          "import { NAME, pattern } from 'commonfabric';",
          "export default pattern<{ title: string }>(({ title }) => ({",
          "  [NAME]: 'Member',",
          "  shown: String(title),",
          "}));",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        `${dir}/wide.tsx`,
        [
          "import { NAME, pattern } from 'commonfabric';",
          "export default pattern<{ title: string | number }>(",
          "  ({ title }) => ({ [NAME]: 'Member', shown: String(title) }),",
          ");",
          "",
        ].join("\n"),
      );
      const strict = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/strict.tsx`,
      });
      const wide = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/wide.tsx`,
      });
      const piece = await pieces.create(strict, { input: { title: "a" } });
      const controller = await pieces.get(piece.id, false);
      await controller.setPattern(wide);
      await controller.input.set(7, ["title"]);
      await pieces.synced();
      const { revisions } = await readRestorableSource(pieces, controller);
      const strictRevision = revisions[0].revisionId;
      // An argument the candidate cannot use at all is the runtime's own
      // hard refusal: it throws rather than reporting a compatibility
      // verdict, and nothing here converts that into a quieter answer.
      await expect(
        restorePiece(pieces, piece.id, {
          revisionId: strictRevision,
          apply: true,
        }),
      ).rejects.toThrow("updated arguments do not match the candidate schema");
      // The piece keeps running what it was running: a refused restore
      // leaves it where it stood, appending no revision.
      const { revisions: after } = await readRestorableSource(
        pieces,
        controller,
      );
      expect(after.map((entry) => entry.revisionId)).toEqual(
        revisions.map((entry) => entry.revisionId),
      );
      expect(after.at(-1)?.current).toBe(true);
    });

    it("refuses a restore when another writer moved the piece since the read", async () => {
      // Finding 1's window: the listing this run reported is the proof it
      // writes against, so a writer landing between the read and the write
      // is refused rather than written over. The race is injected exactly
      // there — the controller's `changeSource` is the write, so moving the
      // piece on its way in lands after `readRestorableSource` observed it.
      const { id, v1 } = await movedPiece();
      await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
      const third = await resolveLocalSourceProgram(runtime, {
        main: `${dir}/member-v3.tsx`,
      });
      let raced = false;
      const racing = new Proxy(pieces, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (...args: unknown[]) => {
              const controller = await (target.get as unknown as (
                ...a: unknown[]
              ) => Promise<Record<string, unknown>>)(...args);
              return new Proxy(controller, {
                get(inner, name, innerReceiver) {
                  if (name === "changeSource") {
                    return async (...callArgs: unknown[]) => {
                      if (!raced) {
                        raced = true;
                        const victim = await target.get(id, false);
                        await victim.setPattern(third, {
                          dangerouslyAllowIncompatibleSchema: true,
                        });
                        await target.synced();
                      }
                      return await (inner.changeSource as (
                        ...a: unknown[]
                      ) => Promise<unknown>).apply(inner, callArgs);
                    };
                  }
                  const value = Reflect.get(inner, name, innerReceiver);
                  return typeof value === "function"
                    ? value.bind(inner)
                    : value;
                },
              });
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PiecesController;
      const outcome = await restorePiece(racing, id, {
        revisionId: v1,
        apply: true,
      });
      expect(raced).toBe(true);
      expect(outcome.restored).toBe(false);
      expect(outcome.problem).toContain("proved against");
      // The other writer's change stands.
      const after = await pieces.get(id, false);
      expect(await after.result.get(["version"])).toBe("three");
    });

    it("names every revision it does hold for an id it does not", async () => {
      const { id, v1 } = await movedPiece();
      const outcome = await restorePiece(pieces, id, {
        revisionId: "not-a-revision",
        apply: true,
      });
      expect(outcome.restored).toBe(false);
      expect(outcome.problem).toContain("no revision not-a-revision");
      // A refusal that names what is available is what lets the caller pick.
      expect(outcome.problem).toContain(v1);
    });
  });
});
