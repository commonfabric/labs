import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { getPatternIdentityRef, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { setCompileCacheRuntimeVersionForTesting } from "../../runner/src/compilation-cache/cell-cache.ts";
import { checkPiecePattern } from "../lib/piece.ts";

const base = `import { pattern } from "commonfabric";
export default pattern<{seed?: string}, {label: string}>(
  ({seed}) => ({label: seed ?? "unset"})
);`;
const compatible = base.replace('seed ?? "unset"', '`seen:${seed ?? "unset"}`');
const refused = `import { pattern } from "commonfabric";
export default pattern<{required: number}, {label: string}>(
  ({required}) => ({label: String(required)})
);`;

describe("piece check storage", () => {
  for (const cache of ["warm", "stale", "source-only"]) {
    it(`leaves all storage unchanged with a ${cache} current compiled cache`, async () => {
      const signer = await Identity.fromPassphrase("piece check storage");
      const session = createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      });
      const server = newLoopbackServer();
      const directory = await Deno.makeTempDir();
      const mainPath = `${directory}/main.tsx`;
      const openClient = async () => {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: storage,
        });
        const pieces = new PiecesController(session, runtime);
        await pieces.synced();
        return { storage, runtime, pieces };
      };
      let restoreVersion: (() => void) | undefined;
      try {
        const writer = await openClient();
        let pieceId: string;
        let otherPieceId: string;
        let importSource: string;
        try {
          const library = await writer.runtime.patternManager.compilePattern({
            main: "/library.tsx",
            files: [{
              name: "/library.tsx",
              contents:
                'import { pattern } from "commonfabric"; export const suffix = "!"; export default pattern(() => ({}));',
            }],
          }, { space: session.space });
          const libraryRef = writer.runtime.patternManager.getArtifactEntryRef(
            library,
          )!;
          importSource =
            `import { suffix } from "cf:pattern:${libraryRef.identity}";\n`;
          const piece = await writer.pieces.create({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: base }],
          }, { input: { seed: "hello" } });
          pieceId = piece.id;
          const other = await writer.pieces.create({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: compatible }],
          }, { input: { seed: "other" } });
          otherPieceId = other.id;
          await writer.runtime.idle();
        } finally {
          await writer.runtime.dispose();
        }
        if (cache !== "warm") {
          restoreVersion = setCompileCacheRuntimeVersionForTesting(
            cache === "stale" ? "preflight-new-compiler" : undefined,
          );
        }
        const db = (await server.engineForSpace(session.space)).database;
        const snapshot = () => ({
          commits:
            db.prepare('SELECT COUNT(*) FROM "commit"').value<[number]>()![0],
          revisions:
            db.prepare("SELECT COUNT(*) FROM revision").value<[number]>()![0],
          heads: db.prepare(
            "SELECT branch, id, scope_key, seq, op_index, op FROM head ORDER BY branch, id, scope_key",
          ).all(),
        });
        const before = snapshot();
        const imported = importSource! +
          compatible.replace(
            '`seen:${seed ?? "unset"}`',
            '`seen:${seed ?? "unset"}${suffix}`',
          );
        for (
          const source of [refused, compatible, imported, refused, compatible]
        ) {
          await Deno.writeTextFile(mainPath, source);
          const reader = await openClient();
          try {
            const piece = await reader.pieces.get(pieceId, false);
            const previous = getPatternIdentityRef(piece.getCell())!;
            using starts = spy(reader.runtime.runner, "start");
            // Pinned RuntimeProgram input exercises the fabric resolver directly.
            const report = source === imported
              ? await piece.checkPattern({
                main: "/main.tsx",
                files: [{ name: "/main.tsx", contents: source }],
              })
              : await checkPiecePattern(
                {
                  apiUrl: "http://toolshed.test",
                  identity: "/unused/injected-identity",
                  space: session.space,
                  piece: pieceId,
                },
                { mainPath, rootPath: directory },
                { loadPieces: () => Promise.resolve(reader.pieces) },
              );
            await reader.runtime.patternManager.flushCompileCacheWrites();
            await reader.runtime.idle();
            await reader.storage.synced();
            expect(report.compatible).toBe(source !== refused);
            expect(starts.calls).toHaveLength(0);
            expect(getPatternIdentityRef(piece.getCell())).toEqual(previous);
            const tx = reader.runtime.edit();
            try {
              expect(
                tx.getCfcState().moduleDelegations.get(session.space)
                  ?.get(report.candidate.identity) ?? [],
              ).not.toContain(previous.identity);
            } finally {
              tx.abort();
            }
            expect(snapshot()).toEqual(before);
          } finally {
            await reader.runtime.dispose();
          }
          expect(snapshot()).toEqual(before);
        }
        if (cache === "stale") {
          const reader = await openClient();
          try {
            const piece = await reader.pieces.get(pieceId, false);
            await piece.checkPattern({
              main: "/main.tsx",
              files: [{ name: "/main.tsx", contents: compatible }],
            });
            expect(snapshot()).toEqual(before);
            await piece.getPattern();
            await reader.runtime.patternManager.flushCompileCacheWrites();
            expect(snapshot().commits).toBeGreaterThan(before.commits);
            const afterCurrentRepair = snapshot();
            const other = await reader.pieces.get(otherPieceId, false);
            await other.getPattern();
            await reader.runtime.patternManager.flushCompileCacheWrites();
            expect(snapshot().commits).toBeGreaterThan(
              afterCurrentRepair.commits,
            );
          } finally {
            await reader.runtime.dispose();
          }
        }
      } finally {
        restoreVersion?.();
        await server.close();
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});
