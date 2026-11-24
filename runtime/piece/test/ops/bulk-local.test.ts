import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { getPatternIdentityRef, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  localRetargetOp,
  programEntryIdentity,
} from "../../src/ops/bulk-local.deno.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("bulk local");

const entryContents = [
  "import { NAME, pattern } from 'commonfabric';",
  "import { flavor } from './flavor.ts';",
  "export default pattern(() => ({",
  "  [NAME]: 'Pinned',",
  "  flavor,",
  "}));",
  "",
].join("\n");

const flavorContents = 'export const flavor = "cruller";\n';

describe("bulk-local", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

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
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("programEntryIdentity()", () => {
    it("returns the identity a piece created from the same program carries", async () => {
      const program = {
        main: "/main.tsx",
        files: [
          { name: "/main.tsx", contents: entryContents },
          { name: "/flavor.ts", contents: flavorContents },
        ],
      };
      const computed = await programEntryIdentity(program);
      const piece = await pieces.create(program, { input: {} });
      const stored = getPatternIdentityRef(piece.getCell());
      expect(stored?.identity).toBe(computed);
    });

    it("returns the stored identity for a program carrying a data file", async () => {
      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { dataFile, NAME, pattern } from 'commonfabric';",
              "export default pattern(() => ({",
              "  [NAME]: 'Reads a data file',",
              "  cities: JSON.parse(dataFile('/data/cities.json')).cities,",
              "}));",
              "",
            ].join("\n"),
          },
          { name: "/data/cities.json", contents: '{ "cities": ["Oslo"] }\n' },
        ],
        dataFiles: ["/data/cities.json"],
      };
      const computed = await programEntryIdentity(program);
      // The compiler folds the data file into the entry's hash, so the bare
      // import-closure identity is a different value.
      expect(computed).not.toBe(
        await programEntryIdentity({ ...program, dataFiles: undefined }),
      );
      const piece = await pieces.create(program, { input: {} });
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(computed);
    });

    it("throws when the program lacks a file the entry imports", async () => {
      const program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: entryContents }],
      };
      await expect(programEntryIdentity(program)).rejects.toThrow(
        "/flavor.ts",
      );
    });
  });

  describe("localRetargetOp()", () => {
    it("normalizes an empty mainExport to the default export", async () => {
      const dir = await Deno.makeTempDir({ prefix: "bulk-local-empty" });
      try {
        await Deno.writeTextFile(`${dir}/main.tsx`, entryContents);
        await Deno.writeTextFile(`${dir}/flavor.ts`, flavorContents);
        const op = await localRetargetOp(runtime, {
          source: { main: `${dir}/main.tsx`, mainExport: "" },
        });
        expect(op.symbol).toBe("default");
        // The op the codec accepts is the op the apply performs: the empty
        // export is gone, not carried as text the resolver would drop. The
        // key itself must be absent — present-but-undefined would survive
        // an undefined-tolerant serializer as text saying "".
        expect(Object.hasOwn(op.source, "mainExport")).toBe(false);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns an op pinned to the identity the on-disk source produces", async () => {
      const dir = await Deno.makeTempDir({ prefix: "bulk-local-test" });
      try {
        await Deno.writeTextFile(`${dir}/main.tsx`, entryContents);
        await Deno.writeTextFile(`${dir}/flavor.ts`, flavorContents);
        const op = await localRetargetOp(runtime, {
          source: { main: `${dir}/main.tsx` },
          rev: "abc123",
        });
        expect(op.kind).toBe("retarget");
        expect(op.rev).toBe("abc123");
        expect(op.symbol).toBe("default");
        expect(op.patternIdentity).toBe(
          await programEntryIdentity({
            main: "/main.tsx",
            files: [
              { name: "/main.tsx", contents: entryContents },
              { name: "/flavor.ts", contents: flavorContents },
            ],
          }),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
