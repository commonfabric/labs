import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  compileAndSavePattern,
  computeEntryIdentity,
  ensureCompilerStack,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type {
  FirstPartyHttpSigner,
} from "@commonfabric/runner/toolshed-http-auth";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import type { HarnessResearchRunSummary } from "../src/contracts/research.ts";
import { REUSE_RESEARCH_RUNS } from "./fixtures/research-reuse.ts";
import { PATTERN_COMPOSITION_EXAMPLE } from "../src/pattern-authoring.ts";
import type { FabricPatternInstantiations } from "../src/fabric-instantiations.ts";
import { comparableEntityHash } from "../src/fabric-observations.ts";
import {
  createFabricInstantiationRecorder,
  type FabricInstantiationRecord,
} from "../src/fabric-instantiations.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import {
  MAX_COMPOSED_PATTERNS,
  patternIndexDependencies,
  runtimeProgramFromIndex,
} from "../src/pattern-index/composition.ts";
import { OUTPUT_CONCERN_MESSAGES } from "../src/run-pattern-output-concerns.ts";
import type {
  RunPatternToolErrorOutput,
  RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness run-pattern index");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/**
 * Text a start failure carries out of the pattern's own source and into what
 * it throws — the thing the model must not be shown for a pattern it did not
 * author.
 */
const SOURCE_MARKER = "unreadableSourceMarker";

/**
 * Text carried only by the source of a published pattern a composed run
 * imports. Finding it anywhere in a tool output is source having escaped the
 * host side.
 */
const DEPENDENCY_SOURCE_MARKER = "unreadableDependencySourceMarker";

/**
 * The innermost published pattern the composition tests draw in. It exports a
 * value alongside its pattern, so an importer can be shown to have bound both.
 */
const DOUBLER_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  `// ${DEPENDENCY_SOURCE_MARKER}`,
  "export const factor = 2;",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * factor),",
  "}));",
  "",
].join("\n");

/**
 * A published reader of the shape the index seeds: rows beside the two
 * outputs that say what became of the read. Its failure is its own output,
 * which is what a composing pattern is free never to pass on.
 */
const READER_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { rows: number[]; rowCount: number; errorMessage: string; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  rows: computed(() => []),",
  "  rowCount: computed(() => 0),",
  "  errorMessage: computed(() =>",
  "    n > 0 ? 'sqlite: param is undefined' : ''),",
  "}));",
  "",
].join("\n");

/** Composes the reader and passes on neither its failure nor its count. */
const digestSource = (readerId: string): string =>
  [
    "import { computed, pattern } from 'commonfabric';",
    `import reader from "cf:pattern:${readerId}";`,
    "interface Input { n: number; }",
    "interface Output { total: number; }",
    "export default pattern<Input, Output>(({ n }) => {",
    "  const read = reader({ n });",
    "  return { total: computed(() => (read.rows ?? []).length) };",
    "});",
    "",
  ].join("\n");

/** Composes the doubler, by pattern and by exported value. */
const quadruplerSource = (doublerId: string): string =>
  [
    "import { computed, pattern } from 'commonfabric';",
    `import doubler, { factor } from "cf:pattern:${doublerId}";`,
    "interface Input { n: number; }",
    "interface Output { half: { doubled: number }; quadrupled: number; }",
    "export default pattern<Input, Output>(({ n }) => ({",
    "  half: doubler({ n }),",
    "  quadrupled: computed(() => n * factor * factor),",
    "}));",
    "",
  ].join("\n");

/** Composes the quadrupler, which composes the doubler in turn. */
const octuplerSource = (quadruplerId: string): string =>
  [
    "import { computed, pattern } from 'commonfabric';",
    `import quadrupler from "cf:pattern:${quadruplerId}";`,
    "interface Input { n: number; }",
    "interface Inner { half: { doubled: number }; quadrupled: number; }",
    "interface Output { inner: Inner; octupled: number; }",
    "export default pattern<Input, Output>(({ n }) => ({",
    "  inner: quadrupler({ n }),",
    "  octupled: computed(() => n * 8),",
    "}));",
    "",
  ].join("\n");

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

const INDEXED_PATTERN = {
  patternId: "pat-doubler",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Doubles a number",
  hashtags: ["math"],
  dependencies: [],
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: DOUBLING_PATTERN_SOURCE }],
  },
};

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
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

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: { fn: string; body: Record<string, unknown> }[];

  /**
   * Resolves once the `count`-th call to index function `fn` has answered.
   * The publication and the events a run reports are deliberately not
   * awaited by the run, so watching the call itself finish is the only
   * event a test can hang on for one.
   */
  settled(fn: string, count: number): Promise<void>;
}

interface StubIndexOptions {
  /** What `publishPattern` answers. Absent means it answers a 500. */
  publish?: { created: boolean };
}

/**
 * An index answering `getPattern` with `patterns` and every event with `ok`.
 * A pattern absent from the map answers 404.
 */
const stubIndex = (
  patterns: Record<string, unknown>,
  options: StubIndexOptions = {},
): IndexStub => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const waiters: { fn: string; count: number; resolve: () => void }[] = [];
  const answered: Record<string, number> = {};
  const announce = (fn: string) => {
    answered[fn] = (answered[fn] ?? 0) + 1;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.fn === fn && answered[fn] >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    const answer = (response: Response): Promise<Response> => {
      announce(fn);
      return Promise.resolve(response);
    };
    if (fn === "recordEvent") {
      return answer(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    }
    if (fn === "publishPattern") {
      return answer(
        options.publish === undefined
          ? new Response(JSON.stringify({ error: "index is down" }), {
            status: 500,
          })
          : new Response(
            JSON.stringify({
              patternId: body.patternId,
              created: options.publish.created,
            }),
            { status: 200 },
          ),
      );
    }
    const pattern = patterns[body.patternId as string];
    return answer(
      pattern === undefined
        ? new Response(JSON.stringify({ error: "unknown pattern" }), {
          status: 404,
        })
        : new Response(JSON.stringify(pattern), { status: 200 }),
    );
  };
  return {
    fetchFn,
    calls,
    settled(fn, count) {
      if ((answered[fn] ?? 0) >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ fn, count, resolve });
      });
    },
  };
};

/**
 * The content identity `/main.tsx` carrying `source` compiles under — the
 * identity the index stores a published entry beneath, and the one a later
 * `run_pattern` by patternId resolves.
 */
const entryIdentityOf = async (source: string): Promise<string> => {
  await ensureCompilerStack();
  return computeEntryIdentity("/main.tsx", [
    { name: "/main.tsx", contents: source },
  ]);
};

const STRANDED_ENTITY =
  "of:fid1:Lu5lEvAZXeeCOI6SprXO9EG6gDFeZbLWP-MexaaM_qc" as const;

const STRANDED_RECORDS: readonly FabricInstantiationRecord[] = [{
  sequence: 1,
  identity: "keyless:zStranded",
  symbol: "default",
  cell: comparableEntityHash(STRANDED_ENTITY)!,
  link: {
    id: STRANDED_ENTITY,
    space: signer.did(),
    scope: "space",
    path: [],
  },
}];

describe("run-pattern over the pattern index", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  /** Runtimes a single test built for itself, disposed alongside the shared one. */
  let extraRuntimes: Runtime[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    extraRuntimes = [];
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-index-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    for (const extra of extraRuntimes ?? []) {
      await extra.dispose();
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A session in a space of its own whose runtime enforces CFC as `mode`. The
   * content-addressed source cache a composed import resolves from is only
   * written under an enforcing mode, so the mode is what decides whether a
   * `cf:pattern:` import can resolve at all.
   */
  const sessionWithCfcMode = async (
    mode: "disabled" | "enforce-explicit",
  ): Promise<PiecesController> => {
    const own = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: mode,
    });
    extraRuntimes.push(own);
    const controller = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-index-${mode}-${crypto.randomUUID()}`,
      }),
      own,
    );
    await controller.synced();
    return controller;
  };

  /**
   * A session whose runtime reports what it materializes, paired with the read
   * side `run_pattern` queries. The recorder is a runtime construction option,
   * so a session that answers what a run composed has to be built with one.
   */
  const sessionRecordingInstantiations = async (): Promise<{
    pieces: PiecesController;
    instantiations: FabricPatternInstantiations;
  }> => {
    const recorder = createFabricInstantiationRecorder();
    const own = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      onPatternInstantiated: recorder.observe,
    });
    extraRuntimes.push(own);
    const controller = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-index-recorded-${crypto.randomUUID()}`,
      }),
      own,
    );
    await controller.synced();
    return { pieces: controller, instantiations: recorder.instantiations };
  };

  /**
   * The identity a composed source compiles to. The light identity path
   * refuses a source carrying a fabric import — folding each imported
   * pattern's identity into the entry's is what compiling does — so the id is
   * taken from a real compile, in a space of its own so the space under test
   * is left holding nothing.
   */
  const composedIdentityOf = async (
    source: string,
    imported: readonly string[],
  ): Promise<string> => {
    const scratch = await sessionWithCfcMode("enforce-explicit");
    const space = scratch.getSpace();
    const programOf = (contents: string) => ({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents }],
    });
    for (const dependency of imported) {
      await compileAndSavePattern(
        scratch.runtime,
        programOf(dependency),
        { space },
      );
    }
    await scratch.runtime.patternManager.flushCompileCacheWrites();
    const compiled = await compileAndSavePattern(
      scratch.runtime,
      programOf(source),
      { space },
    );
    const identity = scratch.runtime.patternManager
      .getArtifactEntryRef(compiled)?.identity;
    if (identity === undefined) {
      throw new Error("composed source compiled without a durable identity");
    }
    return identity;
  };

  /**
   * The session's pieces controller with `runPersistent` replaced by a throw
   * carrying `marker`. A pattern's own body runs inside that call, so a start
   * failure is where source-derived text reaches the tool — staging one is
   * how the branch that withholds it is measured.
   */
  const piecesFailingToStart = (marker: string): PiecesController =>
    new Proxy(pieces, {
      get(target, property) {
        if (property === "runPersistent") {
          return () => Promise.reject(new Error(marker));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const createEngine = (
    index?: IndexStub,
    options: {
      publish?: false;
      publishDiscoverable?: true;
      taskText?: string;
      researchRuns?: readonly HarnessResearchRunSummary[];
      startFailure?: string;
      pieces?: PiecesController;
      instantiations?: FabricPatternInstantiations;
      patternIndexSigner?: FirstPartyHttpSigner;
    } = {},
  ): CfHarnessEngine =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-index-test-${crypto.randomUUID()}`,
      inheritedResearchRuns: options.researchRuns,
      fabricSessionFactory: () =>
        Promise.resolve({
          pieces: options.startFailure === undefined
            ? options.pieces ?? pieces
            : piecesFailingToStart(options.startFailure),
          ...(options.instantiations === undefined
            ? {}
            : { instantiations: options.instantiations }),
          identity: signer,
        }),
      ...(options.taskText === undefined ? {} : { taskText: options.taskText }),
      // Opting out is connection configuration rather than an injection
      // seam, so a run that does not publish is built from a config that
      // says so — the session config beside it is what a pattern index is
      // admitted with.
      ...(options.publish === false || options.publishDiscoverable === true
        ? {
          fabricSession: {
            apiUrl: "https://toolshed.test/",
            identityKeyPath: "/keys/agent.pkcs8",
            space: "run-pattern-index",
          },
          patternIndex: {
            baseUrl: "https://index.test",
            ...(options.publish === false ? { publish: false } : {}),
            ...(options.publishDiscoverable === true
              ? { publishDiscoverable: true }
              : {}),
          },
        }
        : {}),
      ...(index === undefined ? {} : {
        patternIndexClientFactory: () =>
          Promise.resolve(
            new PatternIndexClient({
              baseUrl: "https://index.test",
              fetchFn: index.fetchFn,
              signer: options.patternIndexSigner ?? signer,
            }),
          ),
      }),
    });

  /**
   * Runs the tool and then sends what the session owes the index, which is
   * what the prompt loop does when a session ends. A publication is held until
   * then so a session that iterates retains one candidate per capability
   * rather than one per successful run, and a run's events are waited for
   * there because a run does not wait for them itself.
   */
  const runAndFlush = async (
    engine: CfHarnessEngine,
    input: Record<string, unknown>,
  ) => {
    const result = await engine.invokeBuiltinTool("run_pattern", input);
    await engine.flushPatternIndexLedger();
    return result;
  };

  describe("runtimeProgramFromIndex()", () => {
    it("carries every field a published program declares", () => {
      expect(runtimeProgramFromIndex({
        main: "/main.tsx",
        mainExport: "doubler",
        files: [
          { name: "/main.tsx", contents: "source" },
          { name: "/rows.csv", contents: "a,b" },
        ],
        sourceRoots: ["/extra.tsx"],
        dataFiles: ["/rows.csv"],
      })).toEqual({
        main: "/main.tsx",
        mainExport: "doubler",
        files: [
          { name: "/main.tsx", contents: "source" },
          { name: "/rows.csv", contents: "a,b" },
        ],
        sourceRoots: ["/extra.tsx"],
        dataFiles: ["/rows.csv"],
      });
    });

    it("omits the optional fields a published program leaves out", () => {
      expect(runtimeProgramFromIndex({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "source" }],
      })).toEqual({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "source" }],
      });
    });
  });

  describe("patternIndexDependencies()", () => {
    it("names every published pattern the program's files import", () => {
      expect(patternIndexDependencies([
        {
          contents: [
            'import a from "cf:pattern:pat-one";',
            'import b from "cf:pattern:pat-two";',
          ].join("\n"),
        },
        { contents: 'import c from "cf:pattern:pat-one";' },
      ])).toEqual(["pat-one", "pat-two"]);
    });

    it("returns nothing for a program composing no published pattern", () => {
      expect(patternIndexDependencies([
        { contents: DOUBLING_PATTERN_SOURCE },
      ])).toEqual([]);
    });
  });

  describe("runPatternTool", () => {
    it("refuses the rehearsal task's unexplained rewrite before accessing the index", async () => {
      const index = stubIndex({});
      const result = await createEngine(index, {
        taskText: REUSE_RESEARCH_RUNS[0].kit.task,
        researchRuns: REUSE_RESEARCH_RUNS,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "cf:pattern:-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w",
      );
      expect(output.message).toContain(
        "import as cf:pattern:<id>, or supply reuseReasons[<id>] as one nonblank line",
      );
      expect(output).not.toHaveProperty("resultRef");
      expect(index.calls).toEqual([]);
    });

    it("runs a narrower atom when the author states why the selected mailbox does not fit", async () => {
      const result = await createEngine(undefined, {
        taskText: REUSE_RESEARCH_RUNS[0].kit.task,
        researchRuns: REUSE_RESEARCH_RUNS,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        reuseReasons: {
          "-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w":
            "This atom doubles a count already supplied as input and does not read mail.",
        },
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
    });

    it("returns an error for a malformed Fabric import during the reuse check", async () => {
      const result = await createEngine(undefined, {
        researchRuns: REUSE_RESEARCH_RUNS,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: 'import Mailbox from "cf:pattern:invalid";',
      });
      expect(result.output).toMatchObject({ status: "error" });
    });

    it("runs an indexed pattern and returns its result", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index, {
        researchRuns: REUSE_RESEARCH_RUNS,
      }).invokeBuiltinTool(
        "run_pattern",
        {
          patternId: "pat-doubler",
          inputs: { n: 21 },
          resultSchema: DOUBLED_RESULT_SCHEMA,
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);
    });

    it("fetches the program with its source and never echoes it back", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-doubler", inputs: { n: 1 } },
      );
      const lookup = index.calls.find((call) => call.fn === "getPattern");
      expect(lookup?.body).toEqual({
        patternId: "pat-doubler",
        includeSource: true,
      });
      expect(JSON.stringify(result.output)).not.toContain(
        "export default pattern",
      );
    });

    it("reports instantiation to the index", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      await createEngine(index).invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 1 },
      });
      await index.settled("recordEvent", 1);
      const events = index.calls.filter((call) => call.fn === "recordEvent");
      expect(events.map((event) => event.body.eventType)).toContain(
        "instantiated",
      );
      expect(events[0].body.patternId).toBe("pat-doubler");
    });

    it("reports the outcome of an indexed run that landed a result", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      await createEngine(index).invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      await index.settled("recordEvent", 2);
      expect(
        index.calls.filter((call) => call.fn === "recordEvent")
          .map((call) => call.body.eventType),
      ).toEqual(["instantiated", "run_succeeded"]);
    });

    it("reports neither outcome when the caller's own resultSchema refused the result", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          patternId: "pat-doubler",
          inputs: { n: 21 },
          // The pattern answers a number here, so this is the caller's
          // contract failing rather than the pattern's.
          resultSchema: {
            type: "object",
            properties: { doubled: { type: "string" } },
            required: ["doubled"],
          },
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.valueError).toBeDefined();

      await index.settled("recordEvent", 1);
      expect(
        index.calls.filter((call) => call.fn === "recordEvent")
          .map((call) => call.body.eventType),
      ).toEqual(["instantiated"]);
    });

    it("refuses a call naming both sourceText and patternId", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: DOUBLING_PATTERN_SOURCE,
          patternId: "pat-doubler",
        },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("not both");
    });

    it("refuses a call naming neither sourceText nor patternId", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {},
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires sourceText or patternId");
    });

    it("refuses a patternId when the run has no pattern index", async () => {
      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("--pattern-index-url");
    });

    it("reports what the index answered for a pattern it does not hold", async () => {
      const index = stubIndex({});
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-missing" },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("pat-missing");
      expect(output.message).toContain("404");
    });

    it("withholds the failure text when an indexed pattern fails while starting", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index, {
        startFailure: SOURCE_MARKER,
      }).invokeBuiltinTool("run_pattern", { patternId: "pat-doubler" });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("pat-doubler");
      expect(output.message).not.toContain(SOURCE_MARKER);
      expect(output.rawCauseMessage).toContain(SOURCE_MARKER);

      await index.settled("recordEvent", 1);
      expect(
        index.calls.filter((call) => call.fn === "recordEvent")
          .map((call) => call.body.eventType),
      ).toEqual(["run_failed"]);
    });

    it("reports its own failure text when the source the model wrote fails while starting", async () => {
      const result = await createEngine(undefined, {
        startFailure: SOURCE_MARKER,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(SOURCE_MARKER);
    });

    it("withholds the diagnostic when an indexed pattern does not compile", async () => {
      const index = stubIndex({
        "pat-broken": {
          ...INDEXED_PATTERN,
          patternId: "pat-broken",
          program: {
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: "const secretConstantName = ;",
            }],
          },
        },
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-broken" },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("compile-error");
      expect(output.message).toContain("pat-broken");
      expect(output.message).not.toContain("secretConstantName");
      expect(output.rawCauseMessage).toBeDefined();
    });
  });

  describe("publishing what the model authored", () => {
    const publishInput = {
      sourceText: DOUBLING_PATTERN_SOURCE,
      inputs: { n: 21 },
      description: "Doubles a number",
      hashtags: ["math"],
    };

    it("publishes the program, meta and schemas of a pattern that ran", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      const result = await runAndFlush(
        createEngine(index, { taskText: "double the tally for me" }),
        publishInput,
      );
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");

      const publish = index.calls.find((call) => call.fn === "publishPattern");
      expect(publish?.body.program).toEqual({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: DOUBLING_PATTERN_SOURCE }],
      });
      expect(publish?.body.meta).toEqual({
        directQuery: "double the tally for me",
        description: "Doubles a number",
        hashtags: ["math"],
      });
      expect(publish?.body.schemas).toEqual({
        argumentSchema: {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        },
        resultSchema: {
          type: "object",
          properties: { doubled: { type: "number" } },
          required: ["doubled"],
        },
      });
      expect(publish?.body.dependencies).toEqual([]);
      expect(publish?.body.discoverable).toBe(false);
      expect(publish?.body.discoverabilityReason).toBe(
        "recorded automatically; discoverability is earned by evidence",
      );
    });

    it("publishes discoverably only when the run deliberately opts in", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      await runAndFlush(
        createEngine(index, { publishDiscoverable: true }),
        publishInput,
      );

      const publish = index.calls.find((call) => call.fn === "publishPattern");
      expect(publish?.body.discoverable).toBe(true);
      expect(publish?.body.discoverabilityReason).toBeUndefined();
    });

    it("publishes under the compiled pattern's content-addressed identity", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      const result = await runAndFlush(createEngine(index), publishInput);

      const publish = index.calls.find((call) => call.fn === "publishPattern");
      // The identity the compile itself recorded for the entry, which is what
      // a later `run_pattern` by patternId resolves against.
      expect(publish?.body.patternId).toBe(
        await entryIdentityOf(DOUBLING_PATTERN_SOURCE),
      );
      expect((result.output as RunPatternToolSuccessOutput).patternPublication)
        .toMatchObject({
          patternId: await entryIdentityOf(DOUBLING_PATTERN_SOURCE),
          status: "queued",
        });
    });

    it("describes the pattern to the index in its own words when the run has no task text", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      await runAndFlush(createEngine(index), publishInput);

      const publish = index.calls.find((call) => call.fn === "publishPattern");
      expect(publish?.body.meta).toEqual({
        directQuery: "Doubles a number",
        description: "Doubles a number",
        hashtags: ["math"],
      });
    });

    it("records a created event for an entry the index did not already hold", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      await runAndFlush(createEngine(index), publishInput);

      const events = index.calls.filter((call) => call.fn === "recordEvent");
      expect(events.map((event) => event.body.eventType)).toEqual(["created"]);
      expect(events[0].body.patternId).toBe(
        await entryIdentityOf(DOUBLING_PATTERN_SOURCE),
      );
    });

    it("records no created event for an entry the index already held", async () => {
      const index = stubIndex({}, { publish: { created: false } });
      await runAndFlush(createEngine(index), publishInput);

      expect(index.calls.filter((call) => call.fn === "recordEvent")).toEqual(
        [],
      );
    });

    it("returns the run's result when the publication fails", async () => {
      const index = stubIndex({});
      const result = await runAndFlush(
        createEngine(index),
        { ...publishInput, resultSchema: DOUBLED_RESULT_SCHEMA },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);

      expect(index.calls.filter((call) => call.fn === "recordEvent")).toEqual(
        [],
      );
    });

    it("publishes nothing when the created piece carries a session-only pattern pointer", async () => {
      // The index exists so a later run can load what an earlier one wrote.
      // A pattern that materializes its piece under a pointer only this
      // session can resolve would strand every one of those runs, so the
      // failure it is reported as is also a failure to publish.
      const index = stubIndex({}, { publish: { created: true } });
      const result = await createEngine(index, {
        instantiations: {
          sequence: () => 0,
          since: () => STRANDED_RECORDS,
          keylessSince: () => STRANDED_RECORDS,
        },
      }).invokeBuiltinTool("run_pattern", publishInput);

      expect((result.output as RunPatternToolErrorOutput).status).toBe("error");
      // Source the model wrote names no indexed pattern, so the run reports no
      // event either: nothing at all reaches the index.
      expect(index.calls).toEqual([]);
    });

    it("withholds the index's failure body from a failed lookup's message", async () => {
      // The service's own error text can quote indexed source — "unknown
      // pattern" stands in for it here. The model-facing message carries the
      // stable failure; the body reaches only the artifact.
      const index = stubIndex({});
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-missing" },
      );

      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("pat-missing");
      expect(output.message).not.toContain("unknown pattern");
      expect(output.rawCauseMessage).toContain("unknown pattern");
    });

    it("publishes nothing when eviction rolled the keyless record out of the general window", async () => {
      // The regression the keyless side-buffer exists for: a run that
      // materializes many durable roots after the session-only one leaves
      // `since` empty of keyless evidence, and the guard must read the
      // eviction-proof window instead of failing open into a publish.
      const index = stubIndex({}, { publish: { created: true } });
      const result = await createEngine(index, {
        instantiations: {
          sequence: () => 0,
          since: () => [],
          keylessSince: () => STRANDED_RECORDS,
        },
      }).invokeBuiltinTool("run_pattern", publishInput);

      expect((result.output as RunPatternToolErrorOutput).status).toBe("error");
      expect(index.calls).toEqual([]);
    });

    it("reports an indexed run whose piece carries a session-only pointer as failed", async () => {
      // Holding the first event signature makes instantiation slow while the
      // terminal event is queued, pinning their delivery order independently
      // of signature latency. Identify event requests from the proof itself so
      // changes to how the lookup is signed cannot silently bypass the gate.
      const firstEventSignature = Promise.withResolvers<void>();
      let recordEventSignatureCount = 0;
      const patternIndexSigner: FirstPartyHttpSigner = {
        did: () => signer.did(),
        async sign(payload) {
          const proof = new TextDecoder().decode(payload);
          if (!proof.includes("\npath: /recordEvent\n")) {
            return { ok: new Uint8Array(64) };
          }
          recordEventSignatureCount += 1;
          if (recordEventSignatureCount === 1) {
            await firstEventSignature.promise;
          } else if (recordEventSignatureCount === 2) {
            queueMicrotask(firstEventSignature.resolve);
          }
          return { ok: new Uint8Array(64) };
        },
      };
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      await createEngine(index, {
        instantiations: {
          sequence: () => 0,
          since: () => STRANDED_RECORDS,
          keylessSince: () => STRANDED_RECORDS,
        },
        patternIndexSigner,
      }).invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 21 },
      });

      firstEventSignature.resolve();
      await index.settled("recordEvent", 2);
      expect(recordEventSignatureCount).toBe(2);
      expect(
        index.calls.filter((call) => call.fn === "recordEvent")
          .map((call) => call.body.eventType),
      ).toEqual(["instantiated", "run_failed"]);
    });

    it("waits at the session's flush for the events a finished run reported", async () => {
      // Holding the first event signature keeps every event this run reports
      // queued behind it, so what has reached the index when the run is over
      // is a fact rather than a race. Identify event requests from the proof
      // itself so changes to how the lookup is signed cannot silently bypass
      // the gate.
      const firstEventSignature = Promise.withResolvers<void>();
      let recordEventSignatureCount = 0;
      const patternIndexSigner: FirstPartyHttpSigner = {
        did: () => signer.did(),
        async sign(payload) {
          const proof = new TextDecoder().decode(payload);
          if (!proof.includes("\npath: /recordEvent\n")) {
            return { ok: new Uint8Array(64) };
          }
          recordEventSignatureCount += 1;
          if (recordEventSignatureCount === 1) {
            await firstEventSignature.promise;
          }
          return { ok: new Uint8Array(64) };
        },
      };
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const engine = createEngine(index, { patternIndexSigner });
      await engine.invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });

      // The run is over and both of its events are still in flight: reporting
      // is not part of the run.
      expect(index.calls.filter((call) => call.fn === "recordEvent")).toEqual(
        [],
      );

      // The session's flush is what waits for them, and it is the last thing
      // that runs before the harness process exits.
      firstEventSignature.resolve();
      await engine.flushPatternIndexLedger();
      expect(
        index.calls.filter((call) => call.fn === "recordEvent")
          .map((call) => call.body.eventType),
      ).toEqual(["instantiated", "run_succeeded"]);
    });

    it("publishes nothing when the run opted out of publishing", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      const result = await createEngine(index, { publish: false })
        .invokeBuiltinTool("run_pattern", publishInput);
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      expect(index.calls).toEqual([]);
    });

    it("publishes nothing when the run named no description", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { sourceText: DOUBLING_PATTERN_SOURCE, inputs: { n: 21 } },
      );
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      expect(index.calls).toEqual([]);
    });

    it("publishes nothing when the source did not compile", async () => {
      const index = stubIndex({}, { publish: { created: true } });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { ...publishInput, sourceText: "const broken = ;" },
      );
      expect((result.output as RunPatternToolErrorOutput).status).toBe(
        "compile-error",
      );
      expect(index.calls).toEqual([]);
    });

    it("publishes nothing when the run runs an indexed pattern", async () => {
      const index = stubIndex(
        { "pat-doubler": INDEXED_PATTERN },
        { publish: { created: true } },
      );
      await createEngine(index).invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 21 },
        description: "Doubles a number",
      });
      await index.settled("recordEvent", 2);
      expect(index.calls.filter((call) => call.fn === "publishPattern"))
        .toEqual([]);
    });
  });

  describe("composing published patterns", () => {
    it("compiles the authoring template against the mailbox reader it describes", async () => {
      const reader = await Deno.readTextFile(
        new URL(
          "../../patterns/primitives/mailbox-month-headers.tsx",
          import.meta.url,
        ),
      );
      const readerId = await entryIdentityOf(reader);
      const source = PATTERN_COMPOSITION_EXAMPLE.replace(
        "INSPECTED_READER_ID",
        readerId,
      );
      expect(await composedIdentityOf(source, [reader])).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
    });

    /**
     * An index record for `source`, stored under the identity that source
     * compiles to — which is what a `cf:pattern:` import addresses, so a
     * record filed under anything else is one no importer can resolve.
     */
    const indexRecord = (
      patternId: string,
      source: string,
      dependencies: readonly string[] = [],
    ) => ({
      patternId,
      ownerDid: "did:key:zOwner",
      createdAt: "2026-08-01T00:00:00.000Z",
      description: "A published pattern",
      hashtags: ["math"],
      dependencies,
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      },
    });

    const HALF_SCHEMA = {
      type: "object",
      properties: { doubled: { type: "number" } },
      required: ["doubled"],
    } as const;

    const TOTAL_RESULT_SCHEMA = {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    } as const;

    const QUADRUPLED_RESULT_SCHEMA = {
      type: "object",
      properties: { half: HALF_SCHEMA, quadrupled: { type: "number" } },
      required: ["half", "quadrupled"],
    } as const;

    it("materializes an imported pattern and runs the source that composes it", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
      });
      const result = await createEngine(index, {
        researchRuns: [{
          ...REUSE_RESEARCH_RUNS[0],
          kit: {
            ...REUSE_RESEARCH_RUNS[0].kit,
            task: "Quadruple a number",
            summary: "Compose the indexed doubler.",
            patterns: [{
              patternId: doublerId,
              description: "Doubles a number",
              hashtags: ["math"],
              importHint: `import Doubler from "cf:pattern:${doublerId}"`,
              sourceIdentityVerified: true,
            }],
          },
        }],
      }).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: quadruplerSource(doublerId),
          inputs: { n: 3 },
          resultSchema: QUADRUPLED_RESULT_SCHEMA,
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ half: { doubled: 6 }, quadrupled: 12 });
    });

    it("keeps an imported pattern's source out of everything the run answers with", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: quadruplerSource(doublerId),
          inputs: { n: 3 },
          resultSchema: QUADRUPLED_RESULT_SCHEMA,
        },
      );
      expect(JSON.stringify(result.output)).not.toContain(
        DEPENDENCY_SOURCE_MARKER,
      );
    });

    it("materializes an imported pattern's own imports before it", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const quadrupler = quadruplerSource(doublerId);
      const quadruplerId = await composedIdentityOf(quadrupler, [
        DOUBLER_SOURCE,
      ]);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
        [quadruplerId]: indexRecord(quadruplerId, quadrupler, [doublerId]),
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: octuplerSource(quadruplerId),
          inputs: { n: 3 },
          resultSchema: {
            type: "object",
            properties: {
              inner: QUADRUPLED_RESULT_SCHEMA,
              octupled: { type: "number" },
            },
            required: ["inner", "octupled"],
          },
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({
        inner: { half: { doubled: 6 }, quadrupled: 12 },
        octupled: 24,
      });
      // Depth first, and each fetched once: the importer is read before the
      // pattern it imports, which is the only order that can discover it.
      expect(
        index.calls.filter((call) => call.fn === "getPattern")
          .map((call) => call.body.patternId),
      ).toEqual([quadruplerId, doublerId]);
    });

    it("materializes the dependencies recorded for a pattern it runs by id", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const quadrupler = quadruplerSource(doublerId);
      const quadruplerId = await composedIdentityOf(quadrupler, [
        DOUBLER_SOURCE,
      ]);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
        [quadruplerId]: indexRecord(quadruplerId, quadrupler, [doublerId]),
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          patternId: quadruplerId,
          inputs: { n: 3 },
          resultSchema: QUADRUPLED_RESULT_SCHEMA,
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ half: { doubled: 6 }, quadrupled: 12 });
      expect(JSON.stringify(result.output)).not.toContain(
        DEPENDENCY_SOURCE_MARKER,
      );
    });

    it("names the imported pattern the index does not hold", async () => {
      const index = stubIndex({});
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { sourceText: quadruplerSource("absentPatternIdentity"), inputs: {} },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("absentPatternIdentity");
      expect(output.message).toContain("404");
      expect(JSON.stringify(result.output)).not.toContain(
        "export default pattern",
      );
    });

    it("refuses a composed source when the run has no pattern index", async () => {
      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        sourceText: quadruplerSource("absentPatternIdentity"),
        inputs: {},
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("absentPatternIdentity");
      expect(output.message).toContain("--pattern-index-url");
    });

    it("refuses a composed source when the runtime has CFC enforcement disabled", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
      });
      const result = await createEngine(index, {
        pieces: await sessionWithCfcMode("disabled"),
      }).invokeBuiltinTool("run_pattern", {
        sourceText: quadruplerSource(doublerId),
        inputs: { n: 3 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("CFC-enabled runtime");
      // Nothing was fetched: the run cannot resolve a composed import however
      // the fetch turns out, so it does not make one.
      expect(index.calls).toEqual([]);
    });

    it("refuses published patterns whose recorded dependencies form a cycle", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const triplerSource = DOUBLER_SOURCE.replace("factor = 2", "factor = 3");
      const triplerId = await entryIdentityOf(triplerSource);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE, [triplerId]),
        [triplerId]: indexRecord(triplerId, triplerSource, [doublerId]),
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { sourceText: quadruplerSource(doublerId), inputs: { n: 3 } },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("cycle");
      expect(output.message).toContain(doublerId);
      expect(output.message).toContain(triplerId);
    });

    it("refuses a composition drawing in more published patterns than the cap", async () => {
      const chain = Array.from(
        { length: MAX_COMPOSED_PATTERNS + 4 },
        (_, position) => `chainedPatternIdentity${position}`,
      );
      const index = stubIndex(Object.fromEntries(
        chain.map((patternId, position) => [
          patternId,
          indexRecord(
            patternId,
            DOUBLER_SOURCE,
            chain.slice(position + 1, position + 2),
          ),
        ]),
      ));
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { sourceText: quadruplerSource(chain[0]), inputs: {} },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(String(MAX_COMPOSED_PATTERNS));
      // The cap counts what the composition began drawing in, not what it
      // finished: a chain would otherwise descend to any depth before the
      // first of them compiled and the count moved off zero.
      expect(
        index.calls.filter((call) => call.fn === "getPattern"),
      ).toHaveLength(MAX_COMPOSED_PATTERNS);
    });

    it("publishes a composed pattern under the identity its compile recorded", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      const index = stubIndex({
        [doublerId]: indexRecord(doublerId, DOUBLER_SOURCE),
      }, { publish: { created: true } });
      const result = await runAndFlush(createEngine(index), {
        sourceText: quadruplerSource(doublerId),
        inputs: { n: 3 },
        description: "Quadruples a number",
        hashtags: ["math"],
      });
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");

      const publish = index.calls.find((call) => call.fn === "publishPattern");
      expect(publish?.body.dependencies).toEqual([doublerId]);
      // The identity the compile recorded, which folds each imported
      // pattern's identity into the entry's — so it is neither the imported
      // pattern's id nor anything the source alone determines.
      expect(publish?.body.patternId).not.toBe(doublerId);
      expect(publish?.body.patternId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        (result.output as RunPatternToolSuccessOutput).patternPublication
          ?.patternId,
      ).toBe(publish?.body.patternId);
    });

    it("discloses a composed pattern's failure the composing source never passed on", async () => {
      const { pieces: recorded, instantiations } =
        await sessionRecordingInstantiations();
      const readerId = await entryIdentityOf(READER_SOURCE);
      const index = stubIndex({
        [readerId]: indexRecord(readerId, READER_SOURCE),
      });
      const result = await createEngine(index, {
        pieces: recorded,
        instantiations,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: digestSource(readerId),
        inputs: { n: 3 },
        resultSchema: TOTAL_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;

      // The run succeeded and the piece stands: this is a disclosure beside
      // the result, not a refusal of it.
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ total: 0 });
      expect(output.outputConcerns).toEqual([
        {
          concern: "error-branch",
          key: "errorMessage",
          patternId: readerId,
          message: OUTPUT_CONCERN_MESSAGES["error-branch"],
        },
        {
          concern: "no-rows",
          key: "rows",
          patternId: readerId,
          message: OUTPUT_CONCERN_MESSAGES["no-rows"],
        },
      ]);
    });

    it("keeps the composed failure's own text for the run's artifact", async () => {
      const { pieces: recorded, instantiations } =
        await sessionRecordingInstantiations();
      const readerId = await entryIdentityOf(READER_SOURCE);
      const index = stubIndex({
        [readerId]: indexRecord(readerId, READER_SOURCE),
      });
      const result = await createEngine(index, {
        pieces: recorded,
        instantiations,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: digestSource(readerId),
        inputs: { n: 3 },
        resultSchema: TOTAL_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;

      // The prompt loop strips `rawCauseMessage` from what the model is
      // shown, so this is the operator's copy and the only one there is.
      expect(output.rawCauseMessage).toContain(
        `${readerId} errorMessage (error-branch): sqlite: param is undefined`,
      );
      expect(output.rawCauseMessage).toContain(`${readerId} rows (no-rows)`);
    });

    it("keeps the composed failure's own text out of what it discloses", async () => {
      const { pieces: recorded, instantiations } =
        await sessionRecordingInstantiations();
      const readerId = await entryIdentityOf(READER_SOURCE);
      const index = stubIndex({
        [readerId]: indexRecord(readerId, READER_SOURCE),
      });
      const result = await createEngine(index, {
        pieces: recorded,
        instantiations,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: digestSource(readerId),
        inputs: { n: 3 },
        resultSchema: TOTAL_RESULT_SCHEMA,
      });

      const concerns =
        (result.output as RunPatternToolSuccessOutput).outputConcerns;

      expect(concerns?.length).toBeGreaterThan(0);
      expect(JSON.stringify(concerns)).not.toContain("param is undefined");
    });

    it("discloses only the empty read for a composed pattern that did not fail", async () => {
      const { pieces: recorded, instantiations } =
        await sessionRecordingInstantiations();
      const readerId = await entryIdentityOf(READER_SOURCE);
      const index = stubIndex({
        [readerId]: indexRecord(readerId, READER_SOURCE),
      });
      const result = await createEngine(index, {
        pieces: recorded,
        instantiations,
      }).invokeBuiltinTool("run_pattern", {
        sourceText: digestSource(readerId),
        // The reader reports a failure only for a positive input, so this is
        // the same composition over a read that did not fail.
        inputs: { n: 0 },
        resultSchema: TOTAL_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;

      expect(output.status).toBe("ok");
      expect(output.outputConcerns?.map((concern) => concern.concern))
        .toEqual(["no-rows"]);
    });

    it("has no light identity to publish a composed source under", async () => {
      const doublerId = await entryIdentityOf(DOUBLER_SOURCE);
      await ensureCompilerStack();
      // Why the publication reads the compiled artifact's entry ref rather
      // than recomputing an identity over the source it sent.
      expect(() =>
        computeEntryIdentity("/main.tsx", [
          { name: "/main.tsx", contents: quadruplerSource(doublerId) },
        ])
      ).toThrow();
    });
  });
});
