import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  getPieceReconciliation,
  getPieceSourceSnapshot,
  Runtime,
  type RuntimeProgram,
  setPatternSource,
  setPieceReconciliation,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  readPieceSourceRevision,
  readPieceSourceState,
  reconcilePieceSource,
} from "../src/ops/piece-origin.ts";
import type { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

const signer = await Identity.fromPassphrase("piece source lifecycle");

function versionProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(() => ({",
        "  [NAME]: 'Source lifecycle',",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

// A pattern that reads a data file, with the file attached and classified as
// data. What the source state and a revision say about it is what a writer
// built on either would need to put the package back the way it came.
function dataFileProgram(): RuntimeProgram {
  return {
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
}

function incompatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ required: number }>(({ required }) => ({",
        "  required: required ?? 0,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function incompatibleSeedProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ seed?: number }>(() => ({",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function optionalModeProgram(version: 1 | 2): RuntimeProgram {
  const input = version === 1
    ? "interface Input { value: number; }"
    : "interface Input { value: number; mode?: number; }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        input,
        "export default pattern<Input>(({ value }) => ({ value }));",
        "",
      ].join("\n"),
    }],
  };
}

function incompatibleOptionalModeProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Input { value: number; mode?: number; }",
        "export default pattern<Input, { value: string }>(() => ({",
        "  value: 'changed',",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function unionValueProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Output { value: number | string; }",
        "export default pattern<{}, Output>(() => ({ value: 1 }));",
        "",
      ].join("\n"),
    }],
  };
}

function installFetchStub(
  sources: Record<string, RuntimeProgram>,
  onFetch: () => void = () => {},
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    onFetch();
    const program = sources[url.pathname];
    if (program === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const entry = program.files.find((file) => file.name === program.main);
    return Promise.resolve(
      new Response(entry?.contents ?? "not found", {
        status: entry === undefined ? 404 : 200,
        headers: { "content-type": "text/typescript-jsx" },
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("piece source lifecycle", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let webSources: Record<string, RuntimeProgram>;
  let webFetches: number;
  let restoreFetch: () => void;

  beforeEach(async () => {
    webSources = {};
    webFetches = 0;
    restoreFetch = installFetchStub(webSources, () => webFetches++);
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `piece-source-lifecycle-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    restoreFetch();
  });

  async function stampOrigin(
    piece: Awaited<ReturnType<PiecesController["create"]>>,
    origin: string,
  ): Promise<void> {
    const { error } = await runtime.editWithRetry((tx) => {
      setPatternSource(piece.getCell(), tx, origin);
    });
    if (error !== undefined) throw error;
  }

  it("preloads source verification before creating a piece", async () => {
    const worker = new Worker(
      new URL(
        "./fixtures/piece-source-compiler-preload.ts",
        import.meta.url,
      ).href,
      { type: "module" },
    );
    const result = await new Promise<{
      history?: string[];
      error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) =>
        reject(event.error ?? new Error(event.message));
    }).finally(() => worker.terminate());

    expect(result.error).toBeUndefined();
    expect(result.history).toEqual(["create"]);
  });

  it("preloads source verification before an unavailable-baseline transition", async () => {
    const worker = new Worker(
      new URL(
        "./fixtures/piece-source-transition-compiler-preload.ts",
        import.meta.url,
      ).href,
      { type: "module" },
    );
    const result = await new Promise<{
      baseline?: string;
      history?: string[];
      error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) =>
        reject(event.error ?? new Error(event.message));
    }).finally(() => worker.terminate());

    expect(result.error).toBeUndefined();
    expect(result.baseline).toBe("unavailable");
    expect(result.history).toEqual(["repoint"]);
  });

  it("keeps a directly-created same-host piece detached", async () => {
    // A module's authored filename says nothing about where its code came
    // from, even when it is spelled like a route this deployment serves.
    const path = "/api/patterns/system/manual-piece.tsx";
    const program = {
      ...versionProgram("local"),
      main: path,
      files: [{
        ...versionProgram("local").files[0],
        name: path,
      }],
    };
    webSources[path] = versionProgram("remote");

    const piece = await pieces.create(program, { input: {} });
    expect(await reconcilePieceSource(runtime, piece.getCell()))
      .toBe("detached");

    expect(webFetches).toBe(0);
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    const sourceState = await readPieceSourceState(runtime, piece.getCell());
    expect(sourceState.history.map((revision) => revision.operation)).toEqual([
      "create",
    ]);
    const revisionSource = await readPieceSourceRevision(
      runtime,
      piece.getCell(),
      sourceState.history[0].revisionId,
    );
    expect(revisionSource.files).toEqual(program.files);
    await expect(
      readPieceSourceRevision(runtime, piece.getCell(), "missing-revision"),
    ).rejects.toThrow("source revision missing-revision was not found");
    expect(await piece.result.get(["version"])).toBe("local");
  });

  it("says which of a piece's source files carry data", async () => {
    const program = dataFileProgram();
    const piece = await pieces.create(program, { input: {} });
    const sourceState = await readPieceSourceState(runtime, piece.getCell());
    expect(sourceState.files.map((file) => file.name).sort()).toEqual([
      "/data/cities.json",
      "/main.tsx",
    ]);
    // Without this the two entries are indistinguishable, and rebuilding the
    // package from them compiles the JSON as TypeScript.
    expect(sourceState.dataFiles).toEqual(["/data/cities.json"]);
    const revisionSource = await readPieceSourceRevision(
      runtime,
      piece.getCell(),
      sourceState.history[0].revisionId,
    );
    expect(revisionSource.dataFiles).toEqual(["/data/cities.json"]);
  });

  it("rejects malformed actions and actions that do not apply", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const state = await readPieceSourceState(runtime, piece.getCell());

    await expect(
      piece.changeSource(null as never),
    ).rejects.toThrow("unsupported piece source action");
    await expect(
      piece.changeSource({ kind: "unsupported" } as never),
    ).rejects.toThrow("unsupported piece source action");
    await expect(
      piece.changeSource({ kind: "detach" }),
    ).rejects.toThrow("piece is not following a source");
    await expect(
      piece.changeSource({ kind: "restore", revisionId: "missing" }),
    ).rejects.toThrow("source revision missing does not exist");
    await expect(
      piece.changeSource({
        kind: "follow",
        revisionId: state.history[0].revisionId,
      }),
    ).rejects.toThrow("has no origin to follow");
    await expect(
      piece.changeSource({ kind: "repoint", url: "   " } as never),
    ).rejects.toThrow("unsupported piece source action");
    await expect(
      piece.changeSource({ kind: "adopt" }),
    ).rejects.toThrow("piece is not following a source");
  });

  it("refuses an entered origin the source URL policy does not allow", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });

    await expect(
      piece.changeSource({ kind: "repoint", url: "../pattern.tsx" }),
    ).rejects.toThrow("is not an absolute URL");
    await expect(
      piece.changeSource({ kind: "repoint", url: "ftp://source.test/p.tsx" }),
    ).rejects.toThrow("names no program");
    await expect(
      piece.changeSource({
        kind: "repoint",
        url: "https://source.test/p.tsx",
      }),
    ).rejects.toThrow("is an external endpoint");
    // A URL's origin excludes its user information, so the patterns route
    // spelled with credentials still resolves to this host and is followable
    // but for them. The credentials guard is what refuses it.
    await expect(
      piece.changeSource({
        kind: "repoint",
        url: "http://user:secret@toolshed.test/api/patterns/p.tsx",
      }),
    ).rejects.toThrow("may not carry credentials");
    // A protocol-relative string reads as a path on this host and resolves to
    // another authority, and nothing follows one, so a piece that accepted it
    // would report an origin as fine that no reconciliation can ever reach.
    await expect(
      piece.changeSource({ kind: "repoint", url: "//evil.example/p.tsx" }),
    ).rejects.toThrow("resolves to http://evil.example");
    // A backslash is a separator to the URL parser, so this one swaps hosts
    // too while looking even more like a local path.
    await expect(
      piece.changeSource({ kind: "repoint", url: "/\\evil.example/p.tsx" }),
    ).rejects.toThrow("resolves to http://evil.example");
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.map((revision) => revision.operation)).toEqual([
      "create",
    ]);
  });

  it("refuses to point a piece at itself", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });

    await expect(
      piece.changeSource({
        kind: "repoint",
        url: `cf:/${pieces.getSpace()}/${piece.id}`,
      }),
    ).rejects.toThrow("a piece cannot follow itself");
    expect(getPatternSource(piece.getCell())).toBeUndefined();
  });

  it("points a piece at a deployment pattern it has never followed", async () => {
    webSources["/api/patterns/entered.tsx"] = versionProgram("entered-v1");
    const piece = await pieces.create(versionProgram("v1"), { input: {} });

    expect(
      await piece.changeSource({
        kind: "repoint",
        url: "system:entered.tsx",
      }),
    ).toEqual({ status: "applied" });

    expect(getPatternSource(piece.getCell())).toBe("system:entered.tsx");
    expect(await piece.result.get(["version"])).toBe("entered-v1");
    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({ operation: "repoint" });
    expect(state.origin).toMatchObject({
      kind: "system",
      recorded: "system:entered.tsx",
    });
  });

  it("points a piece at a fabric piece it has never followed", async () => {
    const source = await pieces.create(versionProgram("source-v1"), {
      input: {},
    });
    const target = await pieces.create(versionProgram("target-v1"), {
      input: {},
    });
    const url = `cf:/${pieces.getSpace()}/${source.id}`;

    expect(
      await target.changeSource({ kind: "repoint", url }),
    ).toEqual({ status: "applied" });

    expect(getPatternSource(target.getCell())).toBe(url);
    expect(await target.result.get(["version"])).toBe("source-v1");
  });

  it("drops a recorded outcome when a transition supersedes it", async () => {
    const origin = "system:superseded.tsx";
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);
    const { error } = await runtime.editWithRetry((tx) => {
      setPieceReconciliation(piece.getCell(), tx, {
        outcome: "refused",
        at: Date.now(),
        origin,
        reason: "incompatible-schema",
      });
    });
    expect(error).toBeUndefined();
    expect(getPieceReconciliation(piece.getCell())).toBeDefined();

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });

    // The recorded outcome describes a relationship the piece has left.
    expect(getPieceReconciliation(piece.getCell())).toBeUndefined();
  });

  it("adopts what the active origin offers now, keeping the origin", async () => {
    const origin = "system:adopted.tsx";
    webSources["/api/patterns/adopted.tsx"] = versionProgram("origin-v1");
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);

    expect(await piece.changeSource({ kind: "adopt" })).toEqual({
      status: "applied",
    });

    expect(getPatternSource(piece.getCell())).toBe(origin);
    expect(await piece.result.get(["version"])).toBe("origin-v1");
    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({ operation: "origin-update" });
    expect(state.history.at(-1)?.origin?.recorded).toBe(origin);
  });

  it("records an update that found the origin already current", async () => {
    const origin = "system:already-current.tsx";
    webSources["/api/patterns/already-current.tsx"] = versionProgram(
      "origin-v1",
    );
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);

    // The first ask moves the piece onto what the origin serves.
    expect(await piece.changeSource({ kind: "adopt" })).toEqual({
      status: "applied",
    });
    expect(await piece.result.get(["version"])).toBe("origin-v1");
    const before = await readPieceSourceState(runtime, piece.getCell());
    expect(before.history.at(-1)?.operation).toBe("origin-update");

    // The second finds the same source there.
    expect(await piece.changeSource({ kind: "adopt" })).toEqual({
      status: "applied",
    });

    // Nothing moved, so nothing is appended: the whole result is the piece
    // saying its origin has been asked and offers what it runs.
    const after = await readPieceSourceState(runtime, piece.getCell());
    expect(after.history).toEqual(before.history);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(getPieceReconciliation(piece.getCell())).toMatchObject({
      outcome: "followed",
      origin,
    });
  });

  it("records an update that could not reach the origin", async () => {
    const origin = "system:missing.tsx";
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);

    await expect(piece.changeSource({ kind: "adopt" })).rejects.toThrow();

    expect(await piece.result.get(["version"])).toBe("v1");
    expect(getPieceReconciliation(piece.getCell())).toMatchObject({
      outcome: "unreachable",
      origin,
    });
  });

  it("drops an outcome about a piece that moved while it was being reached", async () => {
    const origin = "system:moves-underneath.tsx";
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);
    // Repoint the piece from inside the fetch, so that by the time the
    // attempt concludes it describes an origin the piece no longer records.
    // Stamping rather than transitioning is what makes this test say
    // something: a transition would clear the record on its own, and then an
    // absent record would prove nothing about the guard.
    const moved = "system:moved-to.tsx";
    const original = globalThis.fetch;
    globalThis.fetch =
      (() =>
        stampOrigin(piece, moved).then(() =>
          new Response("not found", { status: 404 })
        )) as typeof globalThis.fetch;
    try {
      await expect(piece.changeSource({ kind: "adopt" })).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }

    expect(getPatternSource(piece.getCell())).toBe(moved);
    expect(getPieceReconciliation(piece.getCell())).toBeUndefined();
  });

  it("applies the exact candidate a confirmed entered origin reviewed", async () => {
    const origin = "system:entered-changing.tsx";
    webSources["/api/patterns/entered-changing.tsx"] = incompatibleSeedProgram(
      "reviewed",
    );
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const action = { kind: "repoint" as const, url: origin };

    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    // The origin moves between the review and the confirmation. Consent was
    // given for what was reviewed, so that is what lands.
    webSources["/api/patterns/entered-changing.tsx"] = incompatibleSeedProgram(
      "later",
    );
    expect(
      await piece.changeSource(action, { confirmedChange: warning.prepared }),
    ).toEqual({ status: "applied" });
    expect(await piece.result.get(["version"])).toBe("reviewed");
    expect(getPatternSource(piece.getCell())).toBe(origin);
  });

  it("records an update the piece refused, and clears it on acceptance", async () => {
    const origin = "system:refused.tsx";
    webSources["/api/patterns/refused.tsx"] = incompatibleSeedProgram(
      "candidate",
    );
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);

    const refused = await piece.changeSource({ kind: "adopt" });
    expect(refused.status).toBe("incompatible");
    expect(getPieceReconciliation(piece.getCell())).toMatchObject({
      outcome: "refused",
      reason: "incompatible-schema",
      origin,
    });

    expect(
      await piece.changeSource({ kind: "adopt" }, {
        confirmedChange: refused.status === "incompatible"
          ? refused.prepared
          : undefined,
      }),
    ).toEqual({ status: "applied" });

    // The piece now runs what the origin offered, which is the fresh answer
    // and not the refusal it replaces.
    expect(await piece.result.get(["version"])).toBe("candidate");
    expect(getPieceReconciliation(piece.getCell())).toMatchObject({
      outcome: "followed",
      origin,
    });
  });

  it("keeps the origin when an incompatible candidate is adopted anyway", async () => {
    const origin = "system:incompatible-origin.tsx";
    webSources["/api/patterns/incompatible-origin.tsx"] =
      incompatibleSeedProgram(
        "candidate",
      );
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);

    const refused = await piece.changeSource({ kind: "adopt" });
    expect(refused.status).toBe("incompatible");
    expect(await piece.result.get(["version"])).toBe("v1");
    expect(getPatternSource(piece.getCell())).toBe(origin);

    expect(
      await piece.changeSource({ kind: "adopt" }, {
        confirmedChange: refused.status === "incompatible"
          ? refused.prepared
          : undefined,
      }),
    ).toEqual({ status: "applied" });

    // An accepted refusal is the owner choosing to go on following the
    // origin, which is what separates it from a manual replacement.
    expect(getPatternSource(piece.getCell())).toBe(origin);
    expect(await piece.result.get(["version"])).toBe("candidate");
    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({ operation: "origin-update" });
  });

  it("rejects a source action if its pattern identity disappears while loading", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const cell = piece.getCell();
    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let cleared = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const pattern = await loadPattern(identity, symbol, space);
      if (!cleared) {
        cleared = true;
        const tx = runtime.edit();
        cell.withTx(tx).setMetaRaw(
          "patternIdentity",
          undefined,
          rawMetaWriteAuthorization,
        );
        await tx.commit();
      }
      return pattern;
    };

    try {
      await expect(
        piece.changeSource({ kind: "detach" }),
      ).rejects.toThrow("piece missing source state");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("rejects an edit if its pattern identity disappears while loading", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const cell = piece.getCell();
    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let cleared = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const pattern = await loadPattern(identity, symbol, space);
      if (!cleared) {
        cleared = true;
        const tx = runtime.edit();
        cell.withTx(tx).setMetaRaw(
          "patternIdentity",
          undefined,
          rawMetaWriteAuthorization,
        );
        await tx.commit();
      }
      return pattern;
    };

    try {
      await expect(
        piece.setPattern(versionProgram("candidate")),
      ).rejects.toThrow("piece missing source state");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("does not accept compatibility confirmation for detach", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, "system:current.tsx");
    const expected = getPieceSourceSnapshot(piece.getCell())!;
    const action = { kind: "detach" } as const;

    await expect(
      piece.changeSource(action, {
        confirmedChange: {
          action,
          expected,
          candidate: expected.pattern,
          origin: null,
          operation: "detach",
          baseline: { kind: "retain", revisionId: "unused" },
          review: { argumentEvidence: "unused", issues: {} },
        },
      }),
    ).rejects.toThrow("detach does not use compatibility confirmation");
  });

  it("surfaces a detach transaction failure without changing source state", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const origin = "system:current.tsx";
    await stampOrigin(piece, origin);
    const editWithRetry = runtime.editWithRetry;
    runtime.editWithRetry = (() =>
      Promise.resolve({
        ok: false,
        error: "source commit rejected",
      })) as unknown as typeof runtime.editWithRetry;

    let reason: unknown;
    try {
      await piece.changeSource({ kind: "detach" });
    } catch (error) {
      reason = error;
    } finally {
      runtime.editWithRetry = editWithRetry;
    }

    expect(reason).toBe("source commit rejected");
    expect(getPatternSource(piece.getCell())).toBe(origin);
  });

  it("preserves the commit error when source history becomes unreadable", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, "system:current.tsx");
    const cell = piece.getCell();
    const editWithRetry = runtime.editWithRetry;
    runtime.editWithRetry = (async () => {
      const tx = runtime.edit();
      cell.withTx(tx).setMetaRaw(
        "pieceSourceHistory",
        "invalid",
        rawMetaWriteAuthorization,
      );
      await tx.commit();
      return {
        ok: false,
        error: new Error("source commit rejected"),
      };
    }) as unknown as typeof runtime.editWithRetry;

    try {
      await expect(
        piece.changeSource({ kind: "detach" }),
      ).rejects.toThrow("source commit rejected");
    } finally {
      runtime.editWithRetry = editWithRetry;
    }
  });

  it("applies a compiled nullable literal widening while retaining its stored argument", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { pattern } from "commonfabric";
          export default pattern<{ state: ${stateType} }, { active: boolean }>(
            ({ state }) => ({ active: state !== null }),
          );
        `,
      }],
    });
    for (
      const [stateType, value] of [
        ["null", null],
        ['"open" | null', null],
        ['"open" | null', "open"],
      ] as const
    ) {
      const previous = program(stateType);
      const piece = await pieces.create(previous, { input: { state: value } });
      await piece.setPattern(program('"open" | "closed" | null'));
      expect(await piece.input.get(["state"])).toBe(value);
      expect(await piece.result.get(["active"])).toBe(value !== null);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(previous)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies compiled boolean argument widening while retaining both stored values", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { pattern } from "commonfabric";
          export default pattern<{ state: ${stateType} }, { active: boolean }>(
            ({ state }) => ({ active: state === true }),
          );
        `,
      }],
    });
    const narrower = program("boolean");
    const wider = program('boolean | "auto"');
    for (const value of [false, true]) {
      const piece = await pieces.create(narrower, { input: { state: value } });
      await piece.setPattern(wider);
      expect(await piece.input.get(["state"])).toBe(value);
      expect(await piece.result.get(["active"])).toBe(value);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(narrower)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies compiled boolean result narrowing and refuses its reverse", async () => {
    const program = (stateType: string, value: boolean): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { pattern } from "commonfabric";
          export default pattern<{ seed: number }, { state: ${stateType} }>(
            () => ({ state: ${value} }),
          );
        `,
      }],
    });
    for (const value of [false, true]) {
      const wider = program('boolean | "auto"', value);
      const piece = await pieces.create(wider, { input: { seed: 42 } });
      await piece.setPattern(program("boolean", value));
      expect(await piece.input.get(["seed"])).toBe(42);
      expect(await piece.result.get(["state"])).toBe(value);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(wider)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies compiled boolean anyOf argument widening while retaining both stored values", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Cell, pattern } from "commonfabric";
          export default pattern<{ state: ${stateType} }, { active: boolean }>(
            () => ({ active: true }),
          );
        `,
      }],
    });
    const narrower = program("Cell<boolean> | number");
    const wider = program('Cell<boolean | "auto"> | number');
    for (const source of [narrower, wider]) {
      const compiled = await runtime.patternManager.compilePattern(source, {
        space: pieces.getSpace(),
      });
      expect(compiled.argumentSchema).toMatchObject({
        properties: { state: { anyOf: expect.any(Array) } },
      });
    }
    for (const value of [false, true]) {
      const piece = await pieces.create(narrower, { input: { state: value } });
      await piece.setPattern(wider);
      expect(await piece.input.get(["state"])).toBe(value);
      expect(await piece.result.get(["active"])).toBe(true);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(narrower)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies compiled boolean anyOf result narrowing and refuses its reverse", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Cell, pattern } from "commonfabric";
          export default pattern<{ flag: Cell<boolean> }, { state: ${stateType} }>(
            ({ flag }) => ({ state: flag }),
          );
        `,
      }],
    });
    const narrower = program("Cell<boolean> | number");
    const wider = program('Cell<boolean | "auto"> | number');
    for (const source of [narrower, wider]) {
      const compiled = await runtime.patternManager.compilePattern(source, {
        space: pieces.getSpace(),
      });
      expect(compiled.resultSchema).toMatchObject({
        properties: { state: { anyOf: expect.any(Array) } },
      });
    }
    // The result flows a boolean through the narrowed branch itself, so each
    // stored value witnesses the narrowing rather than the untouched number
    // branch.
    for (const value of [false, true]) {
      const piece = await pieces.create(wider, { input: { flag: value } });
      await piece.setPattern(narrower);
      expect(await piece.input.get(["flag"])).toBe(value);
      expect(await piece.result.get(["state"])).toBe(value);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(wider)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies compiled boolean widening that retains its default", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Default, pattern } from "commonfabric";
          export default pattern<{ state?: ${stateType} }, { active: boolean }>(
            ({ state }) => ({ active: state === true }),
          );
        `,
      }],
    });
    const narrower = program("Default<boolean, false>");
    const wider = program('Default<boolean | "auto", false>');
    for (const value of [false, true]) {
      const piece = await pieces.create(narrower, { input: { state: value } });
      await piece.setPattern(wider);
      expect(await piece.input.get(["state"])).toBe(value);
      expect(await piece.result.get(["active"])).toBe(value);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(narrower)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
    // A widening that also moves the default stays refused.
    const piece = await pieces.create(narrower, { input: { state: true } });
    await expect(piece.setPattern(program('Default<boolean | "auto", "auto">')))
      .rejects.toThrow("Pattern schemas are not backward compatible");
  });

  it("applies a compiled union widening that retains a mixed-enum cell branch", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Cell, pattern } from "commonfabric";
          export default pattern<{ state?: ${stateType} }, { active: boolean }>(
            ({ state }) => ({ active: state !== undefined }),
          );
        `,
      }],
    });
    const previous = program('Cell<"open" | "closed" | null> | number');
    for (
      const wider of [
        'Cell<"open" | "closed" | "archived" | null> | number',
        'Cell<"open" | "closed" | null> | number | boolean',
      ]
    ) {
      const piece = await pieces.create(previous, { input: { state: 42 } });
      await piece.setPattern(program(wider));
      expect(await piece.input.get(["state"])).toBe(42);
      expect(await piece.result.get(["active"])).toBe(true);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(previous)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies argument widening through a nested union retaining its default", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Cell, type Default, pattern } from "commonfabric";
          export default pattern<{ state?: ${stateType} }, { active: boolean }>(
            ({ state }) => ({ active: state !== undefined }),
          );
        `,
      }],
    });
    const narrower = program(
      'Cell<Default<"open" | "closed" | null, "open"> | number> | string',
    );
    for (
      const stateType of [
        'Cell<Default<"open" | "closed" | null, "open"> | number> | string | boolean',
        'Cell<Default<"open" | "closed" | "archived" | null, "open"> | number> | string',
      ]
    ) {
      const piece = await pieces.create(narrower, {
        input: { state: "ready" },
      });
      await piece.setPattern(program(stateType));
      expect(await piece.input.get(["state"])).toBe("ready");
      expect(await piece.result.get(["active"])).toBe(true);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(narrower)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("applies result narrowing through a nested union retaining its default", async () => {
    const program = (stateType: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { type Cell, type Default, pattern } from "commonfabric";
          export default pattern<{ seed: number }, { state: ${stateType} }>(
            () => ({ state: "ready" }),
          );
        `,
      }],
    });
    const narrower = program(
      'Cell<Default<"open" | "closed" | null, "open"> | number> | string',
    );
    for (
      const stateType of [
        'Cell<Default<"open" | "closed" | null, "open"> | number> | string | boolean',
        'Cell<Default<"open" | "closed" | "archived" | null, "open"> | number> | string',
      ]
    ) {
      const wider = program(stateType);
      const piece = await pieces.create(wider, { input: { seed: 42 } });
      await piece.setPattern(narrower);
      expect(await piece.input.get(["seed"])).toBe(42);
      expect(await piece.result.get(["state"])).toBe("ready");
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)?.operation).toBe("edit");
      await expect(piece.setPattern(wider)).rejects.toThrow(
        "Pattern schemas are not backward compatible",
      );
    }
  });

  it("rejects an edit when recorded source is unavailable", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const before = await readPieceSourceState(runtime, piece.getCell());
    const originalLookup = runtime.patternManager
      .getPatternSourceProgramByIdentity;
    runtime.patternManager.getPatternSourceProgramByIdentity = () =>
      Promise.resolve(undefined);

    try {
      await expect(piece.setPattern(versionProgram("candidate"))).rejects
        .toThrow("the piece's current source is not available");
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLookup;
    }

    const after = await readPieceSourceState(runtime, piece.getCell());
    expect(after.pattern).toEqual(before.pattern);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.history).toEqual(before.history);
    expect(await piece.result.get(["version"])).toBe("current");
  });

  it("rejects a different pattern at an existing creation identity", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const secondPattern = await runtime.patternManager.compilePattern(
      versionProgram("second"),
      { space: pieces.getSpace() },
    );
    const cause = "piece-creation-collision-" + crypto.randomUUID();
    const piece = await pieces.setupPersistent(firstPattern, {}, cause);
    const firstRef = getPatternIdentityRef(piece);

    await expect(
      pieces.setupPersistent(secondPattern, {}, cause),
    ).rejects.toThrow("piece already exists with a different pattern");

    await piece.sync();
    expect(getPatternIdentityRef(piece)).toEqual(firstRef);
    expect(
      (await readPieceSourceState(runtime, piece)).history.map((revision) =>
        revision.pattern
      ),
    ).toEqual([firstRef]);
  });

  it("allows only one pattern to win a concurrent creation identity", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const secondPattern = await runtime.patternManager.compilePattern(
      versionProgram("second"),
      { space: pieces.getSpace() },
    );
    const cause = "concurrent-piece-creation-" + crypto.randomUUID();

    const results = await Promise.allSettled([
      pieces.setupPersistent(firstPattern, {}, cause),
      pieces.setupPersistent(secondPattern, {}, cause),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "piece already exists with a different pattern",
    );

    const piece = (fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof pieces.setupPersistent>>
    >).value;
    await piece.sync();
    const current = getPatternIdentityRef(piece);
    const history = (await readPieceSourceState(runtime, piece)).history;
    expect(history).toHaveLength(1);
    expect(history[0].pattern).toEqual(current);
  });

  it("validates initialized history when the same creation identity is reused", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const cause = "reused-piece-creation-" + crypto.randomUUID();
    const first = await pieces.setupPersistent(pattern, {}, cause);
    const second = await pieces.setupPersistent(pattern, {}, cause);
    expect(second.entityId).toEqual(first.entityId);

    const tx = runtime.edit();
    first.withTx(tx).setMetaRaw(
      "patternIdentity",
      undefined,
      rawMetaWriteAuthorization,
    );
    await tx.commit();
    await expect(
      pieces.setupPersistent(pattern, {}, cause),
    ).rejects.toThrow(
      "piece source history exists without a pattern identity",
    );
  });

  it("detaches, restores exact source, and follows its origin again", async () => {
    const origin = "system:pattern.tsx";
    webSources["/api/patterns/pattern.tsx"] = versionProgram("web-v3");
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);
    const originalRef = getPatternIdentityRef(piece.getCell())!;

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(getPatternIdentityRef(piece.getCell())).toEqual(originalRef);
    expect(await piece.result.get(["version"])).toBe("v1");

    let state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.map((revision) => revision.operation)).toEqual([
      "create",
      "baseline",
      "detach",
    ]);
    const originalRevision = state.history.find((revision) =>
      revision.origin?.recorded === origin
    )!;
    expect(originalRevision.operation).toBe("baseline");
    const originalRevisionId = originalRevision.revisionId;

    await piece.setPattern(versionProgram("v2"));
    expect(await piece.result.get(["version"])).toBe("v2");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)?.operation).toBe("edit");

    expect(
      await piece.changeSource({
        kind: "restore",
        revisionId: originalRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(getPatternIdentityRef(piece.getCell())).toEqual(originalRef);
    expect(await piece.result.get(["version"])).toBe("v1");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({
      operation: "revert",
      selectedRevisionId: originalRevisionId,
    });

    expect(
      await piece.changeSource({
        kind: "follow",
        revisionId: originalRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(piece.getCell())).toBe(origin);
    expect(await piece.result.get(["version"])).toBe("web-v3");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({
      operation: "repoint",
      selectedRevisionId: originalRevisionId,
    });
  });

  it("freezes a legacy relative origin before recording source history", async () => {
    const origin = "/api/patterns/system/example.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(
      state.history.find((revision) => revision.operation === "baseline")
        ?.origin,
    ).toEqual({
      url: "http://toolshed.test/api/patterns/system/example.tsx",
      kind: "system",
      recorded: origin,
    });
  });

  it("follows the latest source of a mutable fabric piece", async () => {
    const source = await pieces.create(versionProgram("source-v1"), {
      input: {},
    });
    const target = await pieces.create(versionProgram("target-v1"), {
      input: {},
    });
    const origin = `cf:/${pieces.getSpace()}/${source.id}`;
    await stampOrigin(target, origin);
    await target.changeSource({ kind: "detach" });
    const detachedState = await readPieceSourceState(
      runtime,
      target.getCell(),
    );
    const followedRevisionId =
      detachedState.history.find((revision) =>
        (revision.origin?.recorded ?? revision.origin?.url) === origin
      )!
        .revisionId;

    await source.setPattern(versionProgram("source-v2"));
    expect(await source.result.get(["version"])).toBe("source-v2");

    expect(
      await target.changeSource({
        kind: "follow",
        revisionId: followedRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(target.getCell())).toBe(origin);
    expect(await target.result.get(["version"])).toBe("source-v2");
  });

  it("returns an incompatibility warning without changing lifecycle state", async () => {
    const origin = "system:incompatible.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const before = await readPieceSourceState(runtime, piece.getCell());
    webSources["/api/patterns/incompatible.tsx"] = incompatibleSeedProgram(
      "candidate",
    );

    const result = await piece.changeSource({
      kind: "follow",
      revisionId: before.history.find((revision) =>
        (revision.origin?.recorded ?? revision.origin?.url) === origin
      )!.revisionId,
    });

    expect(result.status).toBe("incompatible");
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(await piece.result.get(["version"])).toBe("current");
    const after = await readPieceSourceState(runtime, piece.getCell());
    expect(after.pattern).toEqual(before.pattern);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.history).toEqual(before.history);
  });

  it("validates every compatibility confirmation against current state", async () => {
    const origin = "system:confirmation.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    webSources["/api/patterns/confirmation.tsx"] = incompatibleSeedProgram(
      "candidate",
    );
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    await expect(
      piece.changeSource(
        { kind: "restore", revisionId: revision.revisionId },
        { confirmedChange: warning.prepared },
      ),
    ).rejects.toThrow("source changed after compatibility was checked");
    await expect(
      piece.changeSource(action, {
        confirmedChange: {
          ...warning.prepared,
          expected: { ...warning.prepared.expected, origin: "changed" },
        },
      }),
    ).rejects.toThrow("source changed after compatibility was checked");
    await expect(
      piece.changeSource(action, {
        confirmedChange: { ...warning.prepared, review: undefined },
      }),
    ).rejects.toThrow("compatibility confirmation is incomplete");

    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    runtime.patternManager.loadPatternByIdentity = (
      identity,
      symbol,
      space,
    ) =>
      identity === warning.prepared.candidate.identity
        ? Promise.resolve(undefined)
        : loadPattern(identity, symbol, space);
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow("confirmed source version is not available");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("rejects an exact revision whose retained source is unavailable", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await piece.setPattern(versionProgram("v2"));
    const state = await readPieceSourceState(runtime, piece.getCell());
    const oldRevision = state.history.find((revision) =>
      revision.pattern.identity !== state.pattern?.identity
    )!;
    const getProgram = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
    runtime.patternManager.getPatternSourceProgramByIdentity = (
      identity,
      space,
    ) =>
      identity === oldRevision.pattern.identity
        ? Promise.resolve(undefined)
        : getProgram(identity, space);

    try {
      await expect(
        piece.changeSource({
          kind: "restore",
          revisionId: oldRevision.revisionId,
        }),
      ).rejects.toThrow(
        `source revision ${oldRevision.revisionId} is not available`,
      );
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = getProgram;
    }
  });

  it("rejects a compiled candidate without an entry identity", async () => {
    const origin = "system:no-entry.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/no-entry.tsx"] = versionProgram("candidate");
    const getEntryRef = runtime.patternManager.getArtifactEntryRef.bind(
      runtime.patternManager,
    );
    runtime.patternManager.getArtifactEntryRef = () => undefined;

    try {
      await expect(
        piece.changeSource({
          kind: "follow",
          revisionId: revision.revisionId,
        }),
      ).rejects.toThrow("candidate source has no pattern identity");
    } finally {
      runtime.patternManager.getArtifactEntryRef = getEntryRef;
    }
  });

  it("rejects a source that cannot use the retained argument", async () => {
    const origin = "system:required-argument.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const selected = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) =>
        (revision.origin?.recorded ?? revision.origin?.url) === origin
      )!;
    const action = {
      kind: "follow" as const,
      revisionId: selected.revisionId,
    };
    webSources["/api/patterns/required-argument.tsx"] = incompatibleProgram();

    await expect(piece.changeSource(action)).rejects.toThrow(
      "missing required property required",
    );
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(await piece.result.get(["version"])).toBe("current");
  });

  it("records a refusal over data the new source cannot run on", async () => {
    const origin = "system:needs-argument.tsx";
    webSources["/api/patterns/needs-argument.tsx"] = incompatibleProgram();
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);

    await expect(piece.changeSource({ kind: "adopt" })).rejects.toThrow(
      "missing required property required",
    );

    // Refusing this one is a reconciliation outcome like any other. Raised
    // and not recorded, it left the piece reporting that nothing had looked.
    expect(await piece.result.get(["version"])).toBe("current");
    expect(getPatternSource(piece.getCell())).toBe(origin);
    // The classifying prefix is dropped from what the panel shows: it
    // restates the state's own name, and the part worth reading is which
    // property does not fit.
    expect(getPieceReconciliation(piece.getCell())).toMatchObject({
      outcome: "refused",
      reason: "argument-mismatch",
      origin,
      detail: "missing required property required",
    });
  });

  it("leaves an origin the piece does not follow out of its outcomes", async () => {
    const origin = "system:entered-needs-argument.tsx";
    webSources["/api/patterns/entered-needs-argument.tsx"] =
      incompatibleProgram();
    const piece = await pieces.create(versionProgram("current"), { input: {} });

    await expect(
      piece.changeSource({ kind: "repoint", url: origin }),
    ).rejects.toThrow("missing required property required");

    // Being pointed somewhere new is not a relationship the piece has, so
    // there is no outcome about it to record.
    expect(getPieceReconciliation(piece.getCell())).toBeUndefined();
    expect(getPatternSource(piece.getCell())).toBeUndefined();
  });

  it("applies the exact candidate that produced a compatibility warning", async () => {
    const origin = "system:changing.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) =>
        (revision.origin?.recorded ?? revision.origin?.url) === origin
      )!;
    const action = {
      kind: "follow" as const,
      revisionId: baseline.revisionId,
    };

    webSources["/api/patterns/changing.tsx"] = incompatibleSeedProgram(
      "reviewed",
    );
    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    webSources["/api/patterns/changing.tsx"] = incompatibleSeedProgram(
      "not-reviewed",
    );
    expect(
      await piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).toEqual({ status: "applied" });
    expect(await piece.result.get(["version"])).toBe("reviewed");
  });

  /** Seeds retained input authored by a client that bypassed piece projection. */
  async function seedLegacyModeLink(
    piece: PieceController,
    source: Cell<unknown>,
  ) {
    const input = await piece.input.getCell();
    const write = await runtime.editWithRetry((tx) => {
      input.withTx(tx).key("mode").setRawUntyped(source.getAsLink({
        base: input,
        includeSchema: true,
      }));
    });
    expect(write.error).toBeUndefined();
    await pieces.synced();
  }

  it("offers confirmation for a retained-link incompatibility", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const sourceResult = await source.result.getCell();
    await seedLegacyModeLink(piece, sourceResult.key("value"));

    const origin = "system:linked.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) =>
        (revision.origin?.recorded ?? revision.origin?.url) === origin
      )!;
    webSources["/api/patterns/linked.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: baseline.revisionId,
    };

    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.message).toContain(
      "piece source is incompatible with retained input",
    );

    expect(
      await piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).toEqual({ status: "applied" });
    expect(await piece.result.get(["value"])).toBe(4);
  });

  it("records evidence for a retained link without a durable contract", async () => {
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "system:contractless-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    const argument = pieces.getArgument(piece.getCell());
    const contractless = runtime.getCell(
      pieces.getSpace(),
      `contractless-${crypto.randomUUID()}`,
    );
    await runtime.editWithRetry((tx) => {
      contractless.withTx(tx).setRawUntyped(3);
      argument.withTx(tx).setRawUntyped({
        value: 4,
        mode: contractless.getAsLink(),
      });
    });
    webSources["/api/patterns/contractless-link.tsx"] = optionalModeProgram(2);

    const warning = await piece.changeSource({
      kind: "follow",
      revisionId: revision.revisionId,
    });
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.prepared.review?.argumentEvidence).toBeDefined();
  });

  it("hashes malformed retained-link evidence without failing the review", async () => {
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "system:malformed-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    const argument = pieces.getArgument(piece.getCell());
    const getArgument = pieces.getArgument;
    const getRawUntyped = argument.getRawUntyped;
    pieces.getArgument = (() => argument) as typeof pieces.getArgument;
    // `getRaw()` reads through `getRawUntyped()`, so this reaches both.
    argument.getRawUntyped = (() => {
      return {
        value: 4,
        mode: linkRefFrom({ path: "not an array" } as never),
      };
    }) as typeof argument.getRawUntyped;
    webSources["/api/patterns/malformed-link.tsx"] = optionalModeProgram(2);

    try {
      const result = await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
      expect(result.status).toBe("incompatible");
      if (result.status === "incompatible") {
        expect(result.prepared.review?.argumentEvidence).toBeDefined();
      }
    } finally {
      argument.getRawUntyped = getRawUntyped;
      pieces.getArgument = getArgument;
    }
  });

  it("reports schema and retained-link incompatibilities together", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await seedLegacyModeLink(
      piece,
      (await source.result.getCell()).key("value"),
    );

    const origin = "system:combined-warning.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/combined-warning.tsx"] =
      incompatibleOptionalModeProgram();

    const warning = await piece.changeSource({
      kind: "follow",
      revisionId: revision.revisionId,
    });
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.message).toContain(
      "Pattern schemas are not backward compatible",
    );
    expect(warning.message).toContain(
      "piece source is incompatible with retained input",
    );
  });

  it("requires a fresh confirmation after a retained link changes", async () => {
    const firstSource = await pieces.create(unionValueProgram(), { input: {} });
    const secondSource = await pieces.create(unionValueProgram(), {
      input: {},
    });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await seedLegacyModeLink(
      piece,
      (await firstSource.result.getCell()).key("value"),
    );

    const origin = "system:changed-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/changed-link.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };

    const firstWarning = await piece.changeSource(action);
    expect(firstWarning.status).toBe("incompatible");
    if (firstWarning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    await seedLegacyModeLink(
      piece,
      (await secondSource.result.getCell()).key("value"),
    );

    const secondWarning = await piece.changeSource(action, {
      confirmedChange: firstWarning.prepared,
    });
    expect(secondWarning.status).toBe("incompatible");
    if (secondWarning.status !== "incompatible") {
      throw new Error("expected a fresh incompatibility warning");
    }
    expect(secondWarning.prepared.review?.argumentEvidence).not.toBe(
      firstWarning.prepared.review?.argumentEvidence,
    );
    expect(getPatternSource(piece.getCell())).toBeUndefined();

    expect(
      await piece.changeSource(action, {
        confirmedChange: secondWarning.prepared,
      }),
    ).toEqual({ status: "applied" });
  });

  it("rejects a confirmation when its earlier link issue has disappeared", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await seedLegacyModeLink(
      piece,
      (await source.result.getCell()).key("value"),
    );
    const origin = "system:resolved-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/resolved-link.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    await piece.input.set({ value: 4 });

    await expect(
      piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).rejects.toThrow(
      "retained piece input changed after compatibility was checked",
    );
  });

  it("rejects a confirmation when retained input changes during execution", async () => {
    const firstSource = await pieces.create(unionValueProgram(), { input: {} });
    const secondSource = await pieces.create(unionValueProgram(), {
      input: {},
    });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await seedLegacyModeLink(
      piece,
      (await firstSource.result.getCell()).key("value"),
    );
    const origin = "system:execution-race.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/execution-race.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    const mutablePieces = pieces as unknown as {
      runPatternUpdate: typeof pieces.runPatternUpdate;
    };
    const runPatternUpdate = pieces.runPatternUpdate.bind(pieces);
    mutablePieces.runPatternUpdate = async (...args) => {
      await seedLegacyModeLink(
        piece,
        (await secondSource.result.getCell()).key("value"),
      );
      return await runPatternUpdate(...args);
    };
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow(
        "retained piece input changed after compatibility was checked",
      );
    } finally {
      mutablePieces.runPatternUpdate = runPatternUpdate;
    }
  });

  it("rejects a confirmation when its argument link disappears during execution", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await seedLegacyModeLink(
      piece,
      (await source.result.getCell()).key("value"),
    );
    const origin = "system:missing-argument.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/missing-argument.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    const mutablePieces = pieces as unknown as {
      runPatternUpdate: typeof pieces.runPatternUpdate;
    };
    const runPatternUpdate = pieces.runPatternUpdate.bind(pieces);
    mutablePieces.runPatternUpdate = async (...args) => {
      const tx = runtime.edit();
      piece.getCell().withTx(tx).setMetaRaw(
        "argument",
        undefined,
        rawMetaWriteAuthorization,
      );
      await tx.commit();
      return await runPatternUpdate(...args);
    };
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow("piece missing its current argument");
    } finally {
      mutablePieces.runPatternUpdate = runPatternUpdate;
    }
  });

  it("returns a warning for a retained link added during execution", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "system:new-link-race.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/new-link-race.tsx"] = optionalModeProgram(2);

    const mutablePieces = pieces as unknown as {
      runPatternUpdate: typeof pieces.runPatternUpdate;
    };
    const runPatternUpdate = pieces.runPatternUpdate.bind(pieces);
    mutablePieces.runPatternUpdate = async (...args) => {
      await seedLegacyModeLink(
        piece,
        (await source.result.getCell()).key("value"),
      );
      return await runPatternUpdate(...args);
    };
    try {
      const result = await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
      expect(result.status).toBe("incompatible");
      if (result.status === "incompatible") {
        expect(result.message).toContain(
          "piece source is incompatible with retained input",
        );
      }
    } finally {
      mutablePieces.runPatternUpdate = runPatternUpdate;
    }
  });

  it("does not replace an execution error with a clean compatibility review", async () => {
    const origin = "system:spurious-runtime-error.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/spurious-runtime-error.tsx"] = versionProgram(
      "candidate",
    );

    const mutablePieces = pieces as unknown as {
      runPatternUpdate: typeof pieces.runPatternUpdate;
    };
    const runPatternUpdate = pieces.runPatternUpdate;
    mutablePieces.runPatternUpdate = () => {
      throw new Error(
        "piece source is incompatible with retained input: synthetic",
      );
    };
    try {
      await expect(
        piece.changeSource({
          kind: "follow",
          revisionId: revision.revisionId,
        }),
      ).rejects.toThrow("retained input: synthetic");
    } finally {
      mutablePieces.runPatternUpdate = runPatternUpdate;
    }
  });

  it("preserves a non-error execution rejection", async () => {
    const origin = "system:non-error.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) =>
        (entry.origin?.recorded ?? entry.origin?.url) === origin
      )!;
    webSources["/api/patterns/non-error.tsx"] = versionProgram("candidate");

    const mutablePieces = pieces as unknown as {
      runPatternUpdate: typeof pieces.runPatternUpdate;
    };
    const runPatternUpdate = pieces.runPatternUpdate;
    mutablePieces.runPatternUpdate =
      (() =>
        Promise.reject("raw execution rejection")) as typeof runPatternUpdate;
    let reason: unknown;
    try {
      await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
    } catch (error) {
      reason = error;
    } finally {
      mutablePieces.runPatternUpdate = runPatternUpdate;
    }
    expect(reason).toBe("raw execution rejection");
  });

  it("reports a saved transition separately from a later refresh failure", async () => {
    // Injected at the post-commit work the update path actually performs:
    // `runPatternUpdate` synchronizes the pattern AFTER its setup transaction
    // is accepted, so a failure there is the refresh failing over a committed
    // transition, and the verdict below has to say so from that transaction's
    // receipt rather than report the transition unsaved.

    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    const origin = "system:post-commit.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history[0];
    await piece.setPattern(versionProgram("v2"));

    const mutablePieces = pieces as unknown as {
      syncPattern: typeof pieces.syncPattern;
    };
    const syncPattern = pieces.syncPattern.bind(pieces);
    mutablePieces.syncPattern = async (...args) => {
      await syncPattern(...args);
      throw new Error("post-commit refresh failed");
    };
    try {
      expect(
        await piece.changeSource({
          kind: "restore",
          revisionId: baseline.revisionId,
        }),
      ).toEqual({
        status: "applied",
        executionWarning: "post-commit refresh failed",
      });
    } finally {
      mutablePieces.syncPattern = syncPattern;
    }

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)?.operation).toBe("revert");
    expect(
      state.history.filter((revision) => revision.operation === "revert"),
    ).toHaveLength(1);
  });

  it("reports a restore's refresh failure without rereading source history after its receipt", async () => {
    // What the receipt replaces: confirming the transition by synchronizing
    // the piece and re-reading its revision list. Such a read answers a
    // different question — which revisions the piece holds now, after any
    // concurrent change — and `syncCell` resolves normally over a provider
    // error, so a cache hit reads as durable truth. The guard is armed the
    // moment the setup transaction issues its receipt and fails every source
    // history read from then on, so a read-back added beside the receipt
    // fails this case rather than quietly agreeing with it.

    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, "system:receipt-guard.tsx");
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history[0];
    await piece.setPattern(versionProgram("v2"));

    const mutablePieces = pieces as unknown as {
      syncPattern: typeof pieces.syncPattern;
    };
    const syncPattern = pieces.syncPattern;
    const runSyncedWithCommit = runtime.runSyncedWithCommit.bind(runtime);
    const cellPrototype = Object.getPrototypeOf(piece.getCell()) as {
      getMetaRaw: (field: string, options?: unknown) => unknown;
    };
    const getMetaRaw = cellPrototype.getMetaRaw;
    let receiptIssued = false;
    let sourceHistoryReadsAfterReceipt = 0;
    mutablePieces.syncPattern = () => {
      if (!receiptIssued) {
        throw new Error("post-commit refresh started before the receipt");
      }
      throw new Error("injected post-commit refresh failure");
    };
    runtime.runSyncedWithCommit = (async (...args) => {
      const result = await runSyncedWithCommit(...args);
      receiptIssued = true;
      return result;
    }) as typeof runtime.runSyncedWithCommit;
    cellPrototype.getMetaRaw = function (field, options) {
      if (receiptIssued && field === "pieceSourceHistory") {
        sourceHistoryReadsAfterReceipt++;
        throw new Error(
          "the commit receipt must not be verified by rereading source history",
        );
      }
      return getMetaRaw.call(this, field, options);
    };
    try {
      const result = await piece.changeSource({
        kind: "restore",
        revisionId: baseline.revisionId,
      });

      expect(receiptIssued).toBe(true);
      expect(sourceHistoryReadsAfterReceipt).toBe(0);
      expect(result).toEqual({
        status: "applied",
        executionWarning: "injected post-commit refresh failure",
      });
    } finally {
      mutablePieces.syncPattern = syncPattern;
      runtime.runSyncedWithCommit = runSyncedWithCommit;
      cellPrototype.getMetaRaw = getMetaRaw;
    }

    // Read after the guard has proved the restore itself did not.
    expect(getPatternIdentityRef(piece.getCell())).toEqual(baseline.pattern);
    expect(
      (await readPieceSourceState(runtime, piece.getCell())).history.at(-1)
        ?.operation,
    ).toBe("revert");
  });

  it("reports a committed detach after a concurrent refresh fails", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, "system:detach-refresh.tsx");
    const cell = piece.getCell();
    const mutableCell = cell as unknown as { sync: typeof cell.sync };
    const originalSync = cell.sync.bind(cell);
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const heldSyncEntered = defer<void>();
    const releaseHeldSync = defer<void>();
    let interceptDetach = true;
    // Only awaited, never read: this test is about what the newer edit does
    // to the detach beside it, not about what it returns.
    let newerEdit: Promise<unknown> | undefined;
    const cellPrototype = Object.getPrototypeOf(cell) as {
      getMetaRaw: (field: string, options?: unknown) => unknown;
    };
    const getMetaRaw = cellPrototype.getMetaRaw;
    // Armed at the refresh failure: from there to the verdict is exactly
    // where a read-back would run.
    let refreshFailed = false;
    let sourceHistoryReadsAfterFailure = 0;
    cellPrototype.getMetaRaw = function (field, options) {
      if (refreshFailed && field === "pieceSourceHistory") {
        sourceHistoryReadsAfterFailure++;
        throw new Error(
          "a committed detach must not be verified by rereading source history",
        );
      }
      return getMetaRaw.call(this, field, options);
    };

    runtime.editWithRetry = (async (action, maxRetries) => {
      const result = await originalEditWithRetry(action, maxRetries);
      if (!interceptDetach) return result;
      interceptDetach = false;
      let holdNextSync = true;
      mutableCell.sync = (() => {
        if (holdNextSync) {
          holdNextSync = false;
          heldSyncEntered.resolve();
          return releaseHeldSync.promise.then(() => originalSync());
        }
        refreshFailed = true;
        return Promise.reject(
          new Error("detach post-commit refresh failed"),
        );
      }) as typeof cell.sync;
      newerEdit = piece.setPattern(versionProgram("v2"));
      await heldSyncEntered.promise;
      return result;
    }) as typeof runtime.editWithRetry;

    try {
      expect(await piece.changeSource({ kind: "detach" })).toEqual({
        status: "applied",
        executionWarning: "detach post-commit refresh failed",
      });
      expect(sourceHistoryReadsAfterFailure).toBe(0);
    } finally {
      mutableCell.sync = originalSync;
      runtime.editWithRetry = originalEditWithRetry;
      refreshFailed = false;
      cellPrototype.getMetaRaw = getMetaRaw;
      releaseHeldSync.resolve();
    }
    await newerEdit;

    const history = (await readPieceSourceState(runtime, cell)).history;
    expect(
      history.filter((revision) => revision.operation === "detach"),
    ).toHaveLength(1);
    expect(history.at(-1)?.operation).toBe("edit");
  });

  it("does not report a direct edit as unsaved after its refresh fails", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    // Injected at the post-commit work `setPattern` actually performs:
    // `runPatternUpdate` synchronizes the pattern AFTER its setup transaction
    // is accepted, so a failure here is the refresh failing over a committed
    // edit. Stubbing anything the update path does not call would leave this
    // case asserting the clean path under a failure's name — which is why the
    // receipt's `refresh` status is asserted below rather than only the
    // history operation.
    const mutablePieces = pieces as unknown as {
      syncPattern: typeof pieces.syncPattern;
    };
    const syncPattern = pieces.syncPattern.bind(pieces);
    mutablePieces.syncPattern = async (...args) => {
      await syncPattern(...args);
      throw new Error("direct edit refresh failed");
    };
    let receipt: Awaited<ReturnType<typeof piece.setPattern>>;
    try {
      receipt = await piece.setPattern(versionProgram("v2"));
    } finally {
      mutablePieces.syncPattern = syncPattern;
    }

    expect(receipt.refresh).toEqual({
      status: "failed",
      warning: "direct edit refresh failed",
    });
    expect(
      (await readPieceSourceState(runtime, piece.getCell())).history.at(-1)
        ?.operation,
    ).toBe("edit");
    expect(await piece.result.get(["version"])).toBe("v2");
  });

  it("recognizes a saved transition even after a newer source change", async () => {
    // The newer edit lands between this restore's accepted setup transaction
    // and its failed refresh, so by the time the verdict is classified the
    // piece is no longer on the restored revision. The transaction's own
    // receipt is what keeps that verdict `applied`.

    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    const origin = "system:concurrent-post-commit.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history[0];
    await piece.setPattern(versionProgram("v2"));

    const mutablePieces = pieces as unknown as {
      syncPattern: typeof pieces.syncPattern;
    };
    const syncPattern = pieces.syncPattern.bind(pieces);
    let changedAgain = false;
    mutablePieces.syncPattern = async (...args) => {
      await syncPattern(...args);
      if (!changedAgain) {
        changedAgain = true;
        mutablePieces.syncPattern = syncPattern;
        await piece.setPattern(versionProgram("v3"));
      }
      throw new Error("older post-commit refresh failed");
    };
    try {
      expect(
        await piece.changeSource({
          kind: "restore",
          revisionId: baseline.revisionId,
        }),
      ).toEqual({
        status: "applied",
        executionWarning: "older post-commit refresh failed",
      });
    } finally {
      mutablePieces.syncPattern = syncPattern;
    }

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(
      state.history.filter((revision) => revision.operation === "revert"),
    ).toHaveLength(1);
    expect(state.history.at(-1)?.operation).toBe("edit");
    expect(await piece.result.get(["version"])).toBe("v3");
  });
});
