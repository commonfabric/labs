/**
 * The two tools that revise a piece someone already has: the handle-addressed
 * read of its current source, the direct edit that replaces it, and the
 * contract that keeps what the reading child saw out of its parent.
 */

import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import {
  PieceController,
  PiecesController,
  readPieceSourceMetadata,
  readPieceSourceState,
} from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { validateStructuredResultValue } from "@commonfabric/runner/cfc";
import { decodeDataFile } from "@commonfabric/text/data-file";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  PATTERN_AUTHOR_RETURN_SCHEMA,
  PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS,
  PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG,
} from "../src/contracts/subagent.ts";
import {
  DEFAULT_PARENT_TOOL_IDS,
  isSubagentOnlyToolId,
  parentToolIdsForBacking,
  SUBAGENT_ONLY_TOOL_IDS,
} from "../src/contracts/tool-descriptor.ts";
import { SUPPORTED_POLICY_TOOL_IDS } from "../src/interactive-chat-stdio.ts";
import type {
  PieceSourceToolErrorOutput,
  ReadPieceSourceToolSuccessOutput,
  RevisePieceToolSuccessOutput,
} from "../src/tools/piece-source.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness piece-source tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** The same contract, computing something else: a compatible revision. */
const TRIPLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 3),",
  "}));",
  "",
].join("\n");

/** A different result contract: what the compatibility check refuses. */
const INCOMPATIBLE_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { tripled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  tripled: computed(() => n * 3),",
  "}));",
  "",
].join("\n");

/** The bytes of a picture a pattern ships beside its source. */
const GLAZE_BYTES = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);

/** `GLAZE_BYTES` as a source package stores them: a base64 `data:` URL. */
const GLAZE_DATA_URL = decodeDataFile(GLAZE_BYTES, "glaze.png");

/**
 * A pattern that reads `./glaze.png`, the picture beside it, and multiplies
 * its input by `factor`.
 */
const glazePatternSource = (factor: number) =>
  [
    "import { computed, dataFile, pattern } from 'commonfabric';",
    "const GLAZE = dataFile.url('./glaze.png');",
    "interface Input { n: number; }",
    "interface Output { doubled: number; glaze: string; }",
    "export default pattern<Input, Output>(({ n }) => ({",
    `  doubled: computed(() => n * ${factor}),`,
    "  glaze: GLAZE,",
    "}));",
    "",
  ].join("\n");

const DEFAULT_PATTERN_SOURCE = [
  "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
  "  true,",
  "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  ");",
  "export default pattern<",
  "  { pieceRegistry: unknown[] },",
  "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
  ">(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }
  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }
  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }
  defaultWorkingDirectory(): string {
    return "/workspace";
  }
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("piece-source", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const patternFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(DEFAULT_PATTERN_SOURCE, {
          headers: { "content-type": "text/typescript-jsx" },
        }),
      );
    globalThis.fetch = patternFetch;
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: patternFetch,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    globalThis.fetch = originalFetch;
  });

  function createSessionlessEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `piece-source-nosession-${crypto.randomUUID()}`,
    });
  }

  function createEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `piece-source-test-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  async function createPiece(
    engine: CfHarnessEngine,
    source = DOUBLING_PATTERN_SOURCE,
    n = 21,
  ): Promise<RunPatternToolSuccessOutput> {
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: source,
      inputs: { n },
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    return output;
  }

  /**
   * Creates a piece running `glazePatternSource(2)` as `entry`, with the
   * picture beside it and the data files in `extra`, and returns its cell
   * and the handle token naming it.
   */
  async function createGlazePiece(
    entry = "/main.tsx",
    extra: { name: string; contents: string }[] = [],
  ) {
    const directory = entry.slice(0, entry.lastIndexOf("/"));
    const data = [
      { name: `${directory}/glaze.png`, contents: GLAZE_DATA_URL },
      ...extra,
    ];
    const controller = await pieces.create({
      main: entry,
      files: [{ name: entry, contents: glazePatternSource(2) }, ...data],
      dataFiles: data.map((file) => file.name),
    }, { input: { n: 21 } });
    const cell = controller.getCell();
    return {
      cell,
      token: createLLMFriendlyLink(
        cell.getAsNormalizedFullLink(),
        pieces.getSpace(),
      ),
    };
  }

  describe("readPieceSourceTool", () => {
    it("returns the piece's authored source, its revision, and where it came from", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      });
      const output = result.output as ReadPieceSourceToolSuccessOutput;
      expect(output.status).toBe("ok");
      // The bytes the piece runs, not a re-render of them: the authored file
      // is what a revision has to be written against.
      expect(output.files.map((file) => file.contents)).toContain(
        DOUBLING_PATTERN_SOURCE,
      );
      expect(output.entry).toBe(output.files[0]?.name);
      // A piece the harness authored follows nothing, which is the state an
      // in-place edit leaves behind and the one this reports for it.
      expect(output.provenance).toBe("authored-in-place");
      expect(typeof output.sourceRevisionId).toBe("string");
      // An unlabeled piece reports an empty list, which is a different answer
      // from a run that could not read labels at all.
      expect(Array.isArray(output.labels)).toBe(true);
    });

    it("verifies through the piece's bound arguments without exposing their values in the source read", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      });
      const source = result.output as ReadPieceSourceToolSuccessOutput;
      const piece = await pieces.getPieceCell(created.pieceId);
      expect(source.inputRef).toBe(createLLMFriendlyLink(
        pieces.getArgument(piece).getAsNormalizedFullLink(),
        pieces.getSpace(),
      ));
      expect(source).not.toHaveProperty("inputs");

      const verification = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { original: { n: number }; }",
          "interface Output { before: number; after: number; }",
          "export default pattern<Input, Output>(({ original }) => ({",
          "  before: computed(() => original.n * 2),",
          "  after: computed(() => original.n * 3),",
          "}));",
        ].join("\n"),
        inputs: { original: source.inputRef },
        resultSchema: {
          type: "object",
          properties: {
            before: { type: "number" },
            after: { type: "number" },
          },
          required: ["before", "after"],
        },
      });
      const output = verification.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ before: 42, after: 63 });
      expect(output.resultRef).not.toBe(created.resultRef);
    });

    it("refuses a reference to another space without naming what it found", async () => {
      // Source reads are bounded to the session's own space.
      const engine = createEngine();
      const created = await createPiece(engine);
      const foreign =
        `//did:key:z6MkfuESkj8uKUJv7J7sqzPGSUeea3Exh1c2MjWrGdQp1h2z${
          created.resultRef.startsWith("/")
            ? created.resultRef
            : `/${created.resultRef}`
        }`;

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: foreign,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("this run's own space");
    });

    it("reports an origin nothing can follow as its own state rather than as in-place authorship", async () => {
      // A piece carrying a recorded origin string no resolver can follow is
      // neither following nor detached: it holds something a person can read
      // and repair. Folding it into `authored-in-place` would assert an
      // authorship the piece never recorded.
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = await pieces.getPieceCell(created.pieceId);
      await runtime.editWithRetry((tx) => {
        cell.withTx(tx).setMetaRaw(
          "patternSource",
          "not-a-followable-origin",
          rawMetaWriteAuthorization,
        );
      });
      await runtime.idle();

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      });
      const output = result.output as ReadPieceSourceToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.provenance).toBe("unreadable-origin");
    });

    it("refuses a token that names a position inside a piece rather than a piece", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: `${created.resultRef}/doubled`,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("not a position inside one");
    });

    it("lists a binary media file by name, media type, and size in place of returning it, and returns a text data file", async () => {
      const engine = createEngine();
      const { token } = await createGlazePiece("/main.tsx", [
        { name: "/note.txt", contents: "glaze before frying" },
      ]);

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token,
      });
      const output = result.output as ReadPieceSourceToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.files).toEqual([
        { name: "/main.tsx", contents: glazePatternSource(2) },
        { name: "/note.txt", contents: "glaze before frying" },
      ]);
      expect(output.dataFiles).toEqual(["/note.txt"]);
      expect(output.omittedFiles?.files).toEqual([
        { name: "/glaze.png", mediaType: "image/png", bytes: 300 },
      ]);
      expect(output.omittedFiles?.reason).toContain("revise_piece");
      // Nowhere in the output, not only not under `files`.
      expect(JSON.stringify(output)).not.toContain(
        GLAZE_DATA_URL.slice(GLAZE_DATA_URL.indexOf(",") + 1),
      );
    });

    it("lists no omitted files for a source holding no binary media", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      });
      const output = result.output as ReadPieceSourceToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output).not.toHaveProperty("omittedFiles");
    });
  });

  describe("revisePieceTool", () => {
    it("replaces the source in place and appends a revision the piece can be read back at", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const before = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: TRIPLING_PATTERN_SOURCE,
        expectedRevisionId: before.sourceRevisionId,
      });
      const output = result.output as RevisePieceToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(typeof output.revisionId).toBe("string");
      expect(output.revisionId).not.toBe(before.sourceRevisionId);
      expect(output.refreshWarning).toBeUndefined();

      // Reading the piece back is what proves the update landed on the piece
      // rather than only in the receipt.
      const after = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      expect(after.files.map((file) => file.contents)).toContain(
        TRIPLING_PATTERN_SOURCE,
      );
      expect(after.sourceRevisionId).toBe(output.revisionId);
    });

    it("refuses an expectedRevisionId the piece has moved past, leaving the source where it was", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const before = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      // One revision lands, so the id the second call carries is stale in
      // exactly the way a concurrent writer would have made it.
      await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: TRIPLING_PATTERN_SOURCE,
      });

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: DOUBLING_PATTERN_SOURCE,
        expectedRevisionId: before.sourceRevisionId,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("revised since");
      // The refusal protected the source rather than merely reporting on it.
      const after = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      expect(after.files.map((file) => file.contents)).toContain(
        TRIPLING_PATTERN_SOURCE,
      );
    });

    it("refuses a candidate whose contract the piece cannot run, and says so before applying anything", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: INCOMPATIBLE_PATTERN_SOURCE,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("refused the candidate");
      // The piece still runs what it ran: an incompatible candidate is
      // refused rather than applied and left broken, and this tool exposes no
      // override that would take it anyway.
      const after = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      expect(after.files.map((file) => file.contents)).toContain(
        DOUBLING_PATTERN_SOURCE,
      );
    });

    it("carries the piece's binary media files over unchanged into a revision that sends only its source", async () => {
      const engine = createEngine();
      const { cell, token } = await createGlazePiece();

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token,
        sourceText: glazePatternSource(3),
      });
      const output = result.output as RevisePieceToolSuccessOutput;
      expect(output.status).toBe("ok");

      // The stored program, which is what `cf piece getsrc` writes back as
      // bytes: the picture is the one the piece held before.
      const after = await readPieceSourceState(runtime, cell);
      expect(after.currentRevisionId).toBe(output.revisionId);
      expect(after.files).toEqual([
        { name: "/main.tsx", contents: glazePatternSource(3) },
        { name: "/glaze.png", contents: GLAZE_DATA_URL },
      ]);
      expect(after.dataFiles).toEqual(["/glaze.png"]);
    });

    it("carries the piece's text data files over unchanged too, since a revision sends only its source", async () => {
      const engine = createEngine();
      const { cell, token } = await createGlazePiece("/main.tsx", [
        { name: "/note.txt", contents: "glaze before frying" },
      ]);

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token,
        sourceText: glazePatternSource(3),
      });
      const output = result.output as RevisePieceToolSuccessOutput;
      expect(output.status).toBe("ok");

      const after = await readPieceSourceState(runtime, cell);
      expect(after.files).toEqual([
        { name: "/main.tsx", contents: glazePatternSource(3) },
        { name: "/glaze.png", contents: GLAZE_DATA_URL },
        { name: "/note.txt", contents: "glaze before frying" },
      ]);
      expect(after.dataFiles).toEqual(["/glaze.png", "/note.txt"]);
    });

    it("writes the revision in the directory of the entry it replaces, where the paths the source reads resolve as they did", async () => {
      const engine = createEngine();
      const { cell, token } = await createGlazePiece("/donuts/main.tsx");

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token,
        sourceText: glazePatternSource(3),
      });
      const output = result.output as RevisePieceToolSuccessOutput;
      expect(output.status).toBe("ok");

      const after = await readPieceSourceState(runtime, cell);
      expect(after.entry).toBe("/donuts/main.tsx");
      expect(after.files).toEqual([
        { name: "/donuts/main.tsx", contents: glazePatternSource(3) },
        { name: "/donuts/glaze.png", contents: GLAZE_DATA_URL },
      ]);
    });
  });

  describe("refusals", () => {
    // Every one of these is a refusal a caller can reach, and each says which
    // of the mistakes it was rather than failing the call: a run with nothing
    // to reach a piece through, a missing argument, and a token that names
    // nothing are three different answers.

    it("refuses both tools in a run with no fabric session", async () => {
      const engine = createSessionlessEngine();

      for (const toolId of ["read_piece_source", "revise_piece"] as const) {
        const result = await engine.invokeBuiltinTool(toolId, {
          token: "cfh:a:whatever",
          sourceText: "export default 1;",
        });
        const output = result.output as PieceSourceToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain("requires a fabric session");
      }
    });

    it("refuses an empty token, naming the argument it wanted", async () => {
      const engine = createEngine();

      for (const toolId of ["read_piece_source", "revise_piece"] as const) {
        const result = await engine.invokeBuiltinTool(toolId, {
          token: "   ",
          sourceText: DOUBLING_PATTERN_SOURCE,
        });
        const output = result.output as PieceSourceToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain("requires a token naming a piece");
      }
    });

    it("refuses revise_piece with no sourceText", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: "",
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires the revised sourceText");
    });

    it("refuses a token that parses as no reference at all", async () => {
      const engine = createEngine();

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: "not a reference",
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not name a reference this run");
    });

    it("refuses a token naming a cell that is not a piece", async () => {
      // A document with no pattern identity is not a piece, and reading its
      // "source" would be reading a cell that has none.
      const engine = createEngine();
      const plain = runtime.getCell(
        pieces.getSpace(),
        `piece-source-plain-${crypto.randomUUID()}`,
        undefined,
      );
      await runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ note: "not a piece" });
      });
      await runtime.idle();
      const ref = createLLMFriendlyLink(
        plain.getAsNormalizedFullLink(),
        pieces.getSpace(),
      );

      const result = await engine.invokeBuiltinTool("read_piece_source", {
        token: ref,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not refer to a piece");
    });

    it("refuses revise_piece a token that names no piece, before compiling anything", async () => {
      // The resolution refusal comes first, so a caller that named the wrong
      // thing is told that rather than being told its source did not compile.
      const engine = createEngine();

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: "not a reference",
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not name a reference this run");
    });

    it("says so when the fabric session cannot be established", async () => {
      // A session that refuses to build is a different answer from a run
      // configured without one, and the caller is told which.
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `piece-source-badsession-${crypto.randomUUID()}`,
        fabricSessionFactory: () =>
          Promise.reject(new Error("the deployment refused this identity")),
      });

      for (const toolId of ["read_piece_source", "revise_piece"] as const) {
        const result = await engine.invokeBuiltinTool(toolId, {
          token: "/of:fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          sourceText: DOUBLING_PATTERN_SOURCE,
        });
        const output = result.output as PieceSourceToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain(
          "could not establish the fabric session",
        );
      }
    });

    it("refuses a candidate that does not compile, keeping the piece on its source", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: "this is not TypeScript at all (((",
      });
      const output = result.output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("revise_piece could not compile");
      const after = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      expect(after.files.map((file) => file.contents)).toContain(
        DOUBLING_PATTERN_SOURCE,
      );
    });
  });

  describe("collaborator faults", () => {
    // Each of these is a failure of something the tools call rather than of
    // the call itself: the replica, the pattern store, the piece registry,
    // the piece's controller. Each is said in the tool's own words, with the
    // cause beside it.

    /** Replaces `pieces.get` with one that hands back the real controller
     * with `patch` applied over it. */
    const patchControllers = (
      patch: (controller: PieceController) => Partial<PieceController>,
    ) => {
      const get = pieces.get.bind(pieces);
      Object.assign(pieces, {
        get: async (id: string) => {
          const controller = await get(id);
          return Object.assign(controller, patch(controller));
        },
      });
    };

    const revise = (engine: CfHarnessEngine, token: string, source: string) =>
      engine.invokeBuiltinTool("revise_piece", { token, sourceText: source });

    it("returns the load failure when the piece cannot be loaded", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      Object.assign(storageManager, {
        syncCell: () =>
          Promise.reject(new Error("the replica dropped the connection")),
      });

      const output = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as PieceSourceToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toBe(
        "read_piece_source could not load the referenced piece: the replica dropped the connection",
      );
    });

    it("returns the store's failure when the piece's source cannot be read, and refuses a revision it cannot check against", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const before = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as ReadPieceSourceToolSuccessOutput;
      Object.assign(runtime.patternManager, {
        getPatternSourceProgramByIdentity: () =>
          Promise.reject(new Error("the source store is unreachable")),
      });

      const read = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as PieceSourceToolErrorOutput;
      expect(read.message).toBe(
        "read_piece_source could not read the piece's source: the source store is unreachable",
      );
      const revised = (await engine.invokeBuiltinTool("revise_piece", {
        token: created.resultRef,
        sourceText: TRIPLING_PATTERN_SOURCE,
        expectedRevisionId: before.sourceRevisionId,
      })).output as PieceSourceToolErrorOutput;
      expect(revised.message).toBe(
        "revise_piece could not read the piece's current source: the source store is unreachable",
      );
    });

    it("returns an error rather than an empty file list for a piece whose source the space does not hold", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      Object.assign(runtime.patternManager, {
        getPatternSourceProgramByIdentity: () => Promise.resolve(undefined),
      });

      const output = (await engine.invokeBuiltinTool("read_piece_source", {
        token: created.resultRef,
      })).output as PieceSourceToolErrorOutput;
      expect(output).toMatchObject({
        status: "error",
        message:
          "read_piece_source found no authored source retained for this piece",
      });
    });

    it("refuses a revision of a piece whose source the space does not hold, which would write it without the files it carries over", async () => {
      const engine = createEngine();
      const { cell, token } = await createGlazePiece();
      const before = await readPieceSourceState(runtime, cell);
      Object.assign(runtime.patternManager, {
        getPatternSourceProgramByIdentity: () => Promise.resolve(undefined),
      });

      const output = (await revise(engine, token, glazePatternSource(3)))
        .output as PieceSourceToolErrorOutput;
      expect(output).toMatchObject({
        status: "error",
        message:
          "revise_piece refused: the space holds no authored source for this " +
          "piece, so the files a revision carries over from it cannot be read",
      });
      expect(readPieceSourceMetadata(runtime, cell).currentRevisionId).toBe(
        before.currentRevisionId,
      );
    });

    it("refuses to read a source whose binary media file does not hold a data: URL of its media type, naming the file", async () => {
      const engine = createEngine();
      const { token } = await createGlazePiece("/main.tsx", [
        { name: "/spare.png", contents: "a picture saved as text" },
      ]);

      const output = (await engine.invokeBuiltinTool("read_piece_source", {
        token,
      })).output as PieceSourceToolErrorOutput;
      expect(output).toMatchObject({
        status: "error",
        message: "read_piece_source could not read the piece's source: " +
          "Data file `/spare.png` does not hold an `image/png` `data:` URL.",
      });
    });

    it("returns the failure when the piece cannot be opened for revision", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      Object.assign(pieces, {
        get: () => Promise.reject(new Error("the piece is locked")),
      });

      const output = (await revise(
        engine,
        created.resultRef,
        TRIPLING_PATTERN_SOURCE,
      )).output as PieceSourceToolErrorOutput;
      expect(output.message).toBe(
        "revise_piece could not open the piece: the piece is locked",
      );
    });

    it("sends an incompatible candidate to rehearsal when the piece registry cannot be read", async () => {
      // A registry that cannot be read may be hiding data the candidate
      // would strand, so the refusal is the one a populated space gets.
      const engine = createEngine();
      const created = await createPiece(engine);
      Object.assign(pieces, {
        getRegisteredPieces: () =>
          Promise.reject(new Error("the registry is unreadable")),
      });

      const output = (await revise(
        engine,
        created.resultRef,
        INCOMPATIBLE_PATTERN_SOURCE,
      )).output as PieceSourceToolErrorOutput;
      expect(output.message).toContain("refused the candidate");
      expect(output.message).toContain("space-clone-rehearsal.md");
      expect(output.message).not.toContain("the registry is unreadable");
    });

    it("returns a refusal naming the race when the piece moves between the check and the write", async () => {
      // A concurrent writer lands its own revision after this call's
      // preflight, so the pin the write re-checks no longer holds.
      const engine = createEngine();
      const created = await createPiece(engine);
      const get = pieces.get.bind(pieces);
      patchControllers((controller) => {
        const checkPattern = controller.checkPattern.bind(controller);
        return {
          checkPattern: async (program) => {
            const report = await checkPattern(program);
            await (await get(created.pieceId)).setPattern({
              main: "/main.tsx",
              files: [{
                name: "/main.tsx",
                contents: TRIPLING_PATTERN_SOURCE,
              }],
            });
            return report;
          },
        };
      });

      const output = (await revise(
        engine,
        created.resultRef,
        DOUBLING_PATTERN_SOURCE.replace("n * 2", "n * 4"),
      )).output as PieceSourceToolErrorOutput;
      expect(output.message).toContain(
        "the piece moved onto different source between the check and the write",
      );
    });

    it("returns the failure of a write the controller could not apply", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      patchControllers(() => ({
        setPattern: () => Promise.reject(new Error("the commit was refused")),
      }));

      const output = (await revise(
        engine,
        created.resultRef,
        TRIPLING_PATTERN_SOURCE,
      )).output as PieceSourceToolErrorOutput;
      expect(output.message).toBe(
        "revise_piece could not apply the revision: the commit was refused",
      );
    });

    it("returns a saved revision with the refresh failure as a warning, its identifiers scrubbed", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const bare = `of:${"A".repeat(43)}`;
      patchControllers((controller) => {
        const setPattern = controller.setPattern.bind(controller);
        return {
          setPattern: async (program, options) => ({
            ...await setPattern(program, options),
            refresh: {
              status: "failed",
              warning: `the running piece ${bare} did not restart`,
            },
          }),
        };
      });

      const output = (await revise(
        engine,
        created.resultRef,
        TRIPLING_PATTERN_SOURCE,
      )).output as RevisePieceToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.refreshWarning).toBe(
        "the running piece [fabric-id] did not restart",
      );
    });
  });

  describe("the parent never sees what the reading child read", () => {
    it("admits no piece-source tool into the interactive policy's tool set", () => {
      // A chat policy configures a PARENT, and its tool set is derived from
      // the registry, so leaving the two out of the default parent list is not
      // on its own enough: a client could name one and be granted it wherever
      // a fabric session backs it. This is the check that makes the omission
      // binding.
      for (const toolId of SUBAGENT_ONLY_TOOL_IDS) {
        expect(SUPPORTED_POLICY_TOOL_IDS.has(toolId)).toBe(false);
      }
      // An ordinary parent tool is still in it, so the exclusion is about
      // these two rather than about the set being empty.
      expect(SUPPORTED_POLICY_TOOL_IDS.has("read_file")).toBe(true);
    });

    it("keeps both tools off every parent surface a backing can produce", () => {
      // `parentToolIdsForBacking` is the one derivation of "which tools does a
      // parent have", so it is the surface to assert rather than the constant
      // list it starts from — a tool added to a gated set would reach a parent
      // through it without touching DEFAULT_PARENT_TOOL_IDS at all.
      for (const fabricSessionAvailable of [true, false]) {
        const parent = parentToolIdsForBacking({
          fabricSessionAvailable,
          patternIndexAvailable: true,
          skillsShSearchAvailable: true,
          skillsShAcquisitionAvailable: true,
          skillRegistryAvailable: true,
          docsCorpusAvailable: true,
          loomAuthoringAvailable: true,
        });
        expect(parent.filter(isSubagentOnlyToolId)).toEqual([]);
      }
    });

    it("keeps both tools off the parent surface and on the pattern-author profile's", () => {
      // The read is the whole of how source enters a context, so a surface
      // that holds it is a surface that can hold source. The parent holds
      // neither tool; the child that authors holds both.
      expect(DEFAULT_PARENT_TOOL_IDS).not.toContain("read_piece_source");
      expect(DEFAULT_PARENT_TOOL_IDS).not.toContain("revise_piece");
      expect(PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS).toContain(
        "read_piece_source",
      );
      expect(PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS).toContain(
        "revise_piece",
      );
    });

    it("refuses a pattern-author return that carries the source the child read", () => {
      // The channel, not the surface: a child that read a piece's source has
      // no field to put it in, and the profile owns the schema so a
      // delegation cannot add one. Planting the source in each branch is what
      // makes this able to fail.
      expect(PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG.returnContractAuthority)
        .toBe("profile");
      expect(() =>
        validateStructuredResultValue({
          schema: PATTERN_AUTHOR_RETURN_SCHEMA,
          value: {
            ok: true,
            resultRef: "cfh:a:token",
            describes: "doubles a number",
            source: DOUBLING_PATTERN_SOURCE,
          },
        })
      ).toThrow();
      expect(() =>
        validateStructuredResultValue({
          schema: PATTERN_AUTHOR_RETURN_SCHEMA,
          value: {
            ok: false,
            code: "unsupported-request",
            source: DOUBLING_PATTERN_SOURCE,
          },
        })
      ).toThrow();
    });
  });
});
