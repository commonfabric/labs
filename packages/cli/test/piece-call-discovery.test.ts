import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { callFromCommand } from "../commands/piece.ts";
import {
  describePiece,
  executePieceCallable,
  getCellValue,
  type PieceCallableDependencies,
  UnknownPieceVerbError,
} from "../lib/piece.ts";
import {
  deferSkewNoteUntilFailureExit,
  resetDeferredSkewNoteForTest,
} from "../lib/version-check.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { action, cell, pattern, Stream } from "commonfabric";

interface Board {
  items: string[];
  addItem: Stream<{ title: string }>;
}

export default pattern<Record<string, never>, Board>(() => {
  const items = cell(["glazed"]);
  const addItem = action(({ title }: { title: string }) => {
    items.push(title);
  });
  return { items, addItem };
});
`,
  }],
};

describe("piece-call-discovery", () => {
  it("identifies the error and marks wrapper and deprecated recovery choices", () => {
    const error = new UnknownPieceVerbError("listItems", {
      apiUrl: "http://localhost:8000",
      identity: "/nonexistent/test-key",
      space: "did:key:discovery",
      piece: "of:discovery-board",
    }, [
      { name: "addItem", kind: "handler", on: "result", inputSchema: true },
      {
        name: "submitForm",
        kind: "handler",
        on: "result",
        inputSchema: true,
        tier: "wrapper",
      },
      {
        name: "legacyAdd",
        kind: "handler",
        on: "result",
        inputSchema: true,
        deprecated: true,
      },
      {
        name: "legacyForm",
        kind: "handler",
        on: "result",
        inputSchema: true,
        tier: "wrapper",
        deprecated: true,
      },
    ]);
    expect(String(error)).toContain(
      "UnknownPieceVerbError: Unknown verb `listItems`",
    );
    expect(error.message).toContain(
      "Available verbs (including wrappers and deprecated verbs): " +
        "`addItem`, `submitForm` (wrapper), `legacyAdd` (deprecated), " +
        "`legacyForm` (wrapper, deprecated).",
    );
    expect(Object.keys(error)).toEqual([]);
  });

  it("reports a guessed verb before dispatch and leaves the board readable and callable", async () => {
    // Real cells exercise the permissive stream cast. A double that only
    // recognizes the authored verb would reject the guess on its own.

    const signer = await Identity.fromPassphrase("piece-call-discovery");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const space = signer.did();
    const config = {
      apiUrl: "http://localhost:8000",
      identity: "/nonexistent/test-key",
      space,
      piece: "of:discovery-board",
    };

    try {
      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const tx = runtime.edit();
      const root = runtime.run(
        tx,
        compiled,
        {},
        runtime.getCell(space, "discovery-board", undefined, tx),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await root.pull();

      const piece = {
        result: {
          getCell: () => Promise.resolve(root),
          get: (path: (string | number)[]) => root.key(...path).pull(),
        },
        input: {
          getCell: () => Promise.resolve(runtime.getCell(space, "empty-input")),
        },
        getCell: () => root,
        getPattern: () => Promise.resolve(compiled),
      };
      const connection: PieceCallableDependencies = {
        loadPieces: () =>
          Promise.resolve({
            getSpace: () => space,
            get: () => Promise.resolve(piece),
            getPieceCell: () => Promise.resolve(root),
            getResult: () => root,
            runtime,
          }),
        loadPiece: () => Promise.resolve(piece),
        isStdinTerminal: () => true,
      };

      for (const verb of ["listItems", "items"]) {
        const errors: string[] = [];
        const outputs: string[] = [];
        const phases: string[] = [];
        const versionNotes: string[] = [];
        const unload: Array<() => void> = [];
        resetDeferredSkewNoteForTest();
        deferSkewNoteUntilFailureExit("server is 71 commits behind", {
          warn: (note) => versionNotes.push(note),
          addUnloadListener: (handler) => unload.push(handler),
          exitCode: () => 1,
        });

        await expect(callFromCommand(
          {
            ...config,
            space: "discovery-alias",
            cell: config.piece,
            quiet: true,
          },
          "piece call",
          verb,
          [],
          ["--cell", config.piece, verb],
          [],
          {
            executePieceCallable: (target, name, args, deps) =>
              executePieceCallable(target, name, args, {
                ...deps,
                ...connection,
                onPhase: (phase) => phases.push(phase),
              }),
            printError: (message) => errors.push(message),
            render: (message) => outputs.push(String(message)),
            hint: (message) => outputs.push(message),
            announce: (message) => outputs.push(message),
            exit: (code) => {
              expect(code).toBe(1);
              throw new Error("exit-sentinel");
            },
          },
        )).rejects.toThrow("exit-sentinel");

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`Unknown verb \`${verb}\``);
        expect(errors[0]).toContain(
          "Available verbs (including wrappers and deprecated verbs): `addItem`.",
        );
        expect(errors[0]).toContain(
          `cf piece describe --cell //${space}/${config.piece}@space`,
        );
        expect(errors[0]).toContain(
          `cf cell get --cell //${space}/${config.piece}@space <field>`,
        );
        expect(phases).toEqual([]);
        expect(outputs).toEqual([]);
        unload[0]();
        expect(versionNotes).toEqual([]);
      }

      const description = await describePiece(config, connection);
      expect(description.state?.map((field) => field.name)).toEqual(["items"]);
      expect(description.verbs.map((verb) => verb.name)).toEqual(["addItem"]);
      expect(await getCellValue(config, ["items"], {}, connection)).toEqual([
        "glazed",
      ]);

      await executePieceCallable(
        config,
        "addItem",
        ["--title", "cruller"],
        connection,
      );
      expect(await getCellValue(config, ["items"], {}, connection)).toEqual([
        "glazed",
        "cruller",
      ]);
    } finally {
      resetDeferredSkewNoteForTest();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
