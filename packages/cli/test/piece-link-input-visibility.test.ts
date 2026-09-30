/**
 * Measures forced links through CLI helpers, compiled patterns, and a shared
 * emulated store. Fresh replicas separate unloaded links from invalid data
 * when comparing input visibility, source checks, and source updates.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  isLink,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  getCellValue,
  linkPieces,
  LinkValidationError,
  type PieceConfig,
  type PieceResolutionDeps,
  setCellValue,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const signer = await Identity.fromPassphrase("issue 6965 reproduction");

/** Packages a self-contained fixture for the production pattern compiler. */
function program(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

const sourceProgram = program(`
import { computed, Default, pattern } from "commonfabric";
export default pattern<
  { names: string[] },
  { namesTable: string[] | Default<[]> }
>(
  ({ names }) => ({ namesTable: computed(() => names.map((name) => name)) }),
);
`);

const oldProgram = program(`
import { pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => ({ title }));
`);

const newProgram = program(`
import { Default, pattern, ReadonlyCell } from "commonfabric";
interface Input {
  title: string;
  boardNames?: ReadonlyCell<string[] | Default<[]>>;
}
export default pattern<Input>(({ title, boardNames }) => ({ title, boardNames }));
`);

describe("piece-link-input-visibility", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let spaceName: string;
  let runtime: Runtime;
  let pieces: PiecesController;
  let deps: PieceResolutionDeps;

  beforeEach(async () => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    spaceName = "issue-6965-" + crypto.randomUUID();
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      runtime,
    );
    await pieces.synced();
    deps = {
      loadPieces: () => Promise.resolve(pieces),
      resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
    };
    resetWriteReceipts();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  /** Runs one operation over a fresh replica of the same durable store. */
  async function withFreshPiece<T>(
    id: string,
    operation: (piece: PieceController) => Promise<T>,
  ): Promise<T> {
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    try {
      const readerPieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        readerRuntime,
      );
      await readerPieces.synced();
      return await operation(await readerPieces.get(id, false));
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  }

  /** Creates a producer and an older consumer that declares only `title`. */
  async function createPair(
    consumerProgram = oldProgram,
    input: unknown = { title: "Topic" },
  ) {
    const source = new PieceController(
      pieces,
      await pieces.runPersistent(
        await runtime.patternManager.compilePattern(sourceProgram, {
          space: pieces.getSpace(),
        }),
        { names: ["Ada"] },
        "source",
        { start: true },
      ),
    );
    const target = new PieceController(
      pieces,
      await pieces.runPersistent(
        await runtime.patternManager.compilePattern(consumerProgram, {
          space: pieces.getSpace(),
        }),
        input,
        "target",
        { start: true },
      ),
    );
    const config: PieceConfig = {
      apiUrl: "http://localhost:9999",
      space: pieces.getSpace(),
      identity: "/nonexistent/test-identity",
      piece: target.id,
    };
    const bind = (allowNonExisting = false) =>
      linkPieces(
        config,
        source.id,
        ["namesTable"],
        target.id,
        ["boardNames"],
        { allowNonExisting },
        deps,
      );
    // Seed persisted state authored by clients that did not check input visibility.
    const seedLegacyLink = async (sourceCell?: Cell<unknown>) => {
      const input = await target.input.getCell();
      const output = sourceCell ??
        (await source.result.getCell()).key("namesTable");
      const result = await runtime.editWithRetry((tx) => {
        input.withTx(tx).key("boardNames").setRawUntyped(output.getAsLink({
          base: input,
          includeSchema: true,
        }));
      });
      if (result.error) throw result.error;
      await pieces.synced();
    };
    return { source, target, config, bind, seedLegacyLink };
  }

  it("refuses an invisible target with or without --allow-non-existing without writing", async () => {
    const { target, bind } = await createPair();
    for (const force of [false, true]) {
      const receipt = await captureStderr(async () => {
        await expect(bind(force)).rejects.toThrow(LinkValidationError);
        await expect(bind(force)).rejects.toThrow(
          "current pattern's input schema",
        );
      });
      expect(receipt).not.toContain("wrote to space");
      expect((await target.input.getCell()).getRaw()).toEqual({
        title: "Topic",
      });
    }
  });

  it("keeps targeted input reads within the current projection for legacy links", async () => {
    const { target, config, seedLegacyLink } = await createPair();
    await seedLegacyLink();
    expect(await getCellValue(config, [], { input: true }, deps)).toEqual({
      title: "Topic",
    });
    for (const options of [{ input: true }, { input: true, step: true }]) {
      await expect(getCellValue(config, ["boardNames"], options, deps))
        .rejects.toThrow("current pattern's input schema");
    }
    const raw = (await target.input.getCell()).getRaw() as {
      boardNames: unknown;
    };
    expect(isLink(raw.boardNames)).toBe(true);
  });

  it("refuses invisible input writes without storing data or issuing a receipt", async () => {
    const { target, config } = await createPair();
    for (const value of [["forced"], "not-an-array"]) {
      const receipt = await captureStderr(async () => {
        await expect(
          setCellValue(config, ["boardNames"], value, { input: true }, deps),
        ).rejects.toThrow("current pattern's input schema");
      });
      expect(receipt).not.toContain("wrote to space");
      expect((await target.input.getCell()).getRaw()).toEqual({
        title: "Topic",
      });
      expect((await target.checkPattern(newProgram)).compatible).toBe(true);
    }
    await captureStderr(async () => {
      await setCellValue(config, ["title"], "Updated", { input: true }, deps);
    });
    expect(await target.input.get(["title"])).toBe("Updated");
  });

  it("requires the force flag for absent optional inputs, array slots, and record keys", async () => {
    const consumer = program(`
      import { pattern, ReadonlyCell } from "commonfabric";
      interface Input {
        title: string;
        optional?: ReadonlyCell<string[]>;
        rows: string[][];
        groups: Record<string, string[]>;
      }
      export default pattern<Input>(({title}) => ({title}));
    `);
    const { source, target, config } = await createPair(consumer, {
      title: "Topic",
      rows: [],
      groups: {},
    });
    for (const path of [["optional"], ["rows", "0"], ["groups", "new"]]) {
      const before = (await target.input.getCell()).getRaw();
      const refusal = await captureStderr(async () => {
        await expect(linkPieces(
          config,
          source.id,
          ["namesTable"],
          target.id,
          path,
          undefined,
          deps,
        )).rejects.toThrow(`Target path "${path.join("/")}" does not exist`);
      });
      expect(refusal).not.toContain("wrote to space");
      expect((await target.input.getCell()).getRaw()).toEqual(before);
      await captureStderr(() =>
        linkPieces(
          config,
          source.id,
          ["namesTable"],
          target.id,
          path,
          { allowNonExisting: true },
          deps,
        )
      );
      expect(await target.input.get(path)).toEqual(["Ada"]);
    }
    await source.input.set(["Grace"], ["names"]);
    for (const path of [["optional"], ["rows", "0"], ["groups", "new"]]) {
      expect(await target.input.get(path)).toEqual(["Grace"]);
    }
  });

  it("preserves open inputs whose durable argument links omit permissive schemas", async () => {
    const consumer = program(`
      import { pattern } from "commonfabric";
      export default pattern<any>(({title}) => ({title}));
    `);
    const { source, target } = await createPair(consumer);
    await withFreshPiece(target.id, async (reader) => {
      expect((await reader.input.getCell()).getAsNormalizedFullLink().schema)
        .toBeUndefined();
      await reader.input.set("Added", ["newField"]);
      expect(await reader.input.get(["newField"])).toBe("Added");
      await reader.pieces().link(
        source.id,
        ["namesTable"],
        reader.id,
        ["boardNames"],
      );
      expect(await reader.input.get(["boardNames"])).toEqual(["Ada"]);
    });
  });

  for (
    const sourceKind of [
      "result",
      "argument",
      "user-scoped argument",
      "session-scoped argument",
    ] as const
  ) {
    it(`accepts a fresh source check over a legacy producer ${sourceKind} link without changing stored arguments`, async () => {
      const { source, target, seedLegacyLink } = await createPair();
      let sourceCell = sourceKind === "result"
        ? (await source.result.getCell()).key("namesTable")
        : (await source.input.getCell()).key("names");
      if (
        sourceKind === "user-scoped argument" ||
        sourceKind === "session-scoped argument"
      ) {
        // Scoped redirects store a value in their own partition while the
        // producer's argument contract belongs to its base partition.
        sourceCell = runtime.getCellFromLink({
          ...sourceCell.getAsNormalizedFullLink(),
          scope: sourceKind === "user-scoped argument" ? "user" : "session",
        });
        const write = await runtime.editWithRetry((tx) => {
          sourceCell.withTx(tx).setRawUntyped(["Ada"]);
        });
        if (write.error) throw write.error;
      }
      await seedLegacyLink(sourceCell);
      await withFreshPiece(target.id, async (reader) => {
        const rawBefore = (await reader.input.getCell()).getRaw();
        const after = await reader.checkPattern(newProgram);
        expect(after.issues).toEqual({});
        expect(after.compatible).toBe(true);
        expect((await reader.input.getCell()).getRaw()).toEqual(rawBefore);
      });
    });
  }

  it("refuses a forged carried schema when the fresh producer contract is incompatible", async () => {
    const { source, target, seedLegacyLink } = await createPair();
    const argument = await source.input.getCell();
    await seedLegacyLink(
      argument.asSchema({ type: "array", items: { type: "string" } }),
    );
    await withFreshPiece(target.id, async (reader) => {
      const before = (await reader.input.getCell()).getRaw();
      const report = await reader.checkPattern(newProgram);
      expect(report.compatible).toBe(false);
      expect(report.issues.retainedLinks).toContain("boardNames");
      expect(report.issues.retainedLinks).not.toContain("unconstrained schema");
      expect((await reader.input.getCell()).getRaw()).toEqual(before);
    });
  });

  it("accepts stored undefined at an optional input in a fresh source check", async () => {
    const consumer = program(`
      import { pattern } from "commonfabric";
      export default pattern<{title: string; note?: string}>(({title}) => ({title}));
    `);
    const { target } = await createPair(consumer);
    const input = await target.input.getCell();
    const write = await runtime.editWithRetry((tx) =>
      input.withTx(tx).key("note").setRawUntyped(undefined)
    );
    if (write.error) throw write.error;
    await pieces.synced();
    await withFreshPiece(target.id, async (reader) => {
      const before = (await reader.input.getCell()).getRaw();
      const report = await reader.checkPattern(consumer);
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      expect((await reader.input.getCell()).getRaw()).toEqual(before);
    });
  });

  it("refuses readable invalid linked values during a fresh source check", async () => {
    const { target, source, seedLegacyLink } = await createPair();
    await seedLegacyLink();
    const output = await source.result.getCell();
    const write = await runtime.editWithRetry((tx) => {
      output.withTx(tx).key("namesTable").setRawUntyped(123);
    });
    if (write.error) throw write.error;
    await pieces.synced();
    await withFreshPiece(target.id, async (reader) => {
      const before = (await reader.input.getCell()).getRaw();
      const report = await reader.checkPattern(newProgram);
      expect(report.compatible).toBe(false);
      expect(report.issues.argument).toContain(
        "boardNames: value does not match type array",
      );
      expect((await reader.input.getCell()).getRaw()).toEqual(before);
    });
  });

  it("accepts a fresh check when the source update precedes the ordinary bind", async () => {
    const { target, bind } = await createPair();
    expect((await target.setPattern(newProgram)).refresh.status).toBe(
      "completed",
    );
    await captureStderr(() => bind());

    await withFreshPiece(target.id, async (reader) => {
      expect((await reader.checkPattern(newProgram)).compatible).toBe(true);
      expect(await reader.input.get(["boardNames"])).toEqual(["Ada"]);
    });
  });

  it("accepts a candidate that stops declaring an input holding a retained link", async () => {
    // The two candidates publish the SAME result and differ only in whether
    // they declare the input, so what decides is the retained-link proof and
    // not the ordinary schema comparison. `keep` also does not publish the
    // path, which is what a consumer holding a board table looks like.
    const keep = program(`
      import { Default, pattern, ReadonlyCell } from "commonfabric";
      interface Input {
        title: string;
        boardNames?: ReadonlyCell<string[] | Default<[]>>;
      }
      export default pattern<Input>(({ title }) => ({ title }));
    `);
    const drop = program(`
      import { pattern } from "commonfabric";
      export default pattern<{ title: string }>(({ title }) => ({ title }));
    `);
    const { target, seedLegacyLink } = await createPair(keep);
    await seedLegacyLink();
    expect(await target.input.get(["boardNames"])).toEqual(["Ada"]);

    await withFreshPiece(target.id, async (reader) => {
      const before = (await reader.input.getCell()).getRaw();
      const report = await reader.checkPattern(drop);
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      expect((await reader.input.getCell()).getRaw()).toEqual(before);
      // And the apply goes through, leaving the link where it was: a candidate
      // that declares no path there reaches it with neither a proof obligation
      // nor a write, so the stored link survives, unreachable through the new
      // projection.
      expect((await reader.setPattern(drop)).status).toBe("committed");
      const raw = (await reader.input.getCell()).getRaw() as {
        boardNames: unknown;
      };
      expect(isLink(raw.boardNames)).toBe(true);
      await expect(reader.input.get(["boardNames"])).rejects.toThrow(
        "current pattern's input schema",
      );
    });
  });

  it("refuses a candidate that stops publishing a path it stops declaring", async () => {
    // The bound on the case above, and the reason it is about the input alone:
    // a candidate that also drops the RESULT field is refused, by the ordinary
    // backward-compatibility check rather than by anything about the link.
    const { target, seedLegacyLink } = await createPair();
    await seedLegacyLink();
    expect((await target.setPattern(newProgram)).refresh.status).toBe(
      "completed",
    );
    await withFreshPiece(target.id, async (reader) => {
      const before = (await reader.input.getCell()).getRaw();
      const report = await reader.checkPattern(oldProgram);
      expect(report.compatible).toBe(false);
      expect(report.issues.schema).toContain(
        "result.boardNames: existing result field was removed",
      );
      expect(report.issues.retainedLinks).toBeUndefined();
      expect((await reader.input.getCell()).getRaw()).toEqual(before);
    });
  });

  it("applies the source update from a fresh replica over a legacy link", async () => {
    const { target, seedLegacyLink } = await createPair();
    await seedLegacyLink();

    await withFreshPiece(target.id, async (reader) => {
      const receipt = await reader.setPattern(newProgram);
      expect(receipt.status).toBe("committed");
      expect(receipt.refresh.status).toBe("completed");
      expect(await reader.input.get(["boardNames"])).toEqual(["Ada"]);
      expect(await reader.result.get(["boardNames"])).toEqual(["Ada"]);
    });
  });
});
