import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  computeEntryIdentity,
  ensureCompilerStack,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness publish gate");

/**
 * The content identity `/main.tsx` carrying `source` compiles under — what the
 * index stores a published entry beneath, and what a `cf:pattern:` import
 * resolves.
 */
const entryIdentityOf = async (source: string): Promise<string> => {
  await ensureCompilerStack();
  return computeEntryIdentity("/main.tsx", [
    { name: "/main.tsx", contents: source },
  ]);
};

/**
 * The sortable table that is live in the pattern index, byte for byte as
 * `getPattern` answers for entry `HOS6wWQmBMK8ewPc239FZc4VS6jMpCKGLMt4rFPTr2k`.
 *
 * It published clean, it ranks first for its own query, a later session
 * composed it, and every data cell it renders reads `[object Object]`:
 * `row[column]` indexes a reactive row by a reactive key, which yields a
 * proxy, and `String(proxy)` is the default `toString`. Its data result was
 * genuinely correct, so nothing on the publish path could tell.
 */
const LIVE_BROKEN_SORTABLE_TABLE =
  `import { pattern, Writable, computed } from "commonfabric";

type Row = Record<string, unknown>;
type Input = { rows?: Row[]; columns?: string[] };

export default pattern<Input, object>(({ rows = [], columns = [] }) => {
  const sortColumn = new Writable<string | null>(null);
  const ascending = new Writable(true);
  const sortedRows = computed(() => {
    const column = sortColumn.get();
    const direction = ascending.get() ? 1 : -1;
    if (!column) return rows;
    return [...rows].sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? ""), undefined, { numeric: true }) * direction);
  });
  return {
    $NAME: "Sortable Table",
    rows: sortedRows,
    columns,
    sortColumn,
    ascending,
    $UI: <table>
      <thead><tr>{columns.map((column) => <th><button onClick={() => {
        if (sortColumn.get() === column) ascending.set(!ascending.get());
        else { sortColumn.set(column); ascending.set(true); }
      }}>{column} {sortColumn.get() === column ? (ascending.get() ? "▲" : "▼") : ""}</button></th>)}</tr></thead>
      <tbody>{sortedRows.map((row) => <tr>{columns.map((column) => <td>{String(row[column] ?? "")}</td>)}</tr>)}</tbody>
    </table>,
  };
});
`;

/** The same table with the cell read done properly, as a fix would write it. */
const WORKING_SORTABLE_TABLE =
  `import { pattern, computed } from "commonfabric";

type Row = { name: string; score: number };
type Input = { rows?: Row[] };

export default pattern<Input, object>(({ rows = [] }) => ({
  $NAME: "Sortable Table",
  rows,
  $UI: <table>
    <thead><tr><th>Name</th><th>Score</th></tr></thead>
    <tbody>{rows.map((row) => <tr><td>{row.name}</td><td>{row.score}</td></tr>)}</tbody>
  </table>,
}));
`;

/**
 * A pattern that declares its result type, as every self-describing component
 * in `packages/patterns` does — `pattern<Io, Io>` rather than `pattern<In,
 * object>`.
 *
 * This is the shape that caught the gate skipping its own check. A declared
 * result type does not name `$UI`, and an unschema'd read of the result cell
 * returns only the declared fields, so the `$UI` is invisible to it. The gate
 * read the raw result, saw no `$UI`, and recorded `no-ui` — "nothing to
 * check" — on a pattern with a perfectly good one. It went the wrong way on
 * the patterns most worth checking: the better the pattern declares itself,
 * the more certainly the check was skipped. Reading through `uiSchema` asks
 * for `$UI` by name, which is what `piece-render.ts` has always done.
 */
const DECLARED_RESULT_UI =
  `import { pattern, UI, Writable } from "commonfabric";

interface Io { rating: Writable<number> }

export default pattern<Io, Io>(({ rating }) => ({
  rating,
  [UI]: <div><span>rated</span></div>,
}));
`;

/** A source that composes a published pattern and renders the result. */
const composedSource = (doublerId: string): string =>
  `import { pattern, UI, computed } from "commonfabric";
import doubler from "cf:pattern:${doublerId}";
interface Input { n: number; }
export default pattern<Input, object>(({ n }) => {
  const half = doubler({ n });
  return {
    half,
    [UI]: <div><span>{computed(() => String(half.doubled))}</span></div>,
  };
});
`;

/** A pure computation. Nothing to render, and nothing the gate applies to. */
const DOUBLER = `import { computed, pattern } from "commonfabric";
interface Input { n: number; }
interface Output { doubled: number; }
export default pattern<Input, Output>(({ n }) => ({
  doubled: computed(() => n * 2),
}));
`;

/** Declares a `$UI` and renders nothing at all under any input. */
const EMPTY_UI = `import { pattern } from "commonfabric";
export default pattern<Record<string, never>, object>(() => ({
  $UI: <></>,
}));
`;

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
}

/** An index that returns the chosen publication status and records events. */
const stubIndex = (
  served: Record<string, unknown> = {},
  publishStatus = 200,
): IndexStub => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    if (fn === "publishPattern") {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            publishStatus === 200
              ? { patternId: body.patternId, created: true }
              : { error: "DID is not allowlisted" },
          ),
          { status: publishStatus },
        ),
      );
    }
    if (fn === "getPattern") {
      const record = served[body.patternId as string];
      return Promise.resolve(
        record === undefined
          ? new Response(JSON.stringify({ error: "unknown pattern" }), {
            status: 404,
          })
          : new Response(JSON.stringify(record), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  };
  return { fetchFn, calls };
};

describe("run_pattern publish render gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  /**
   * Runtimes a single test stood up for itself, disposed alongside the shared
   * one. Inline disposal is skipped whenever an earlier await throws, which
   * leaks the runtime's schema-registry lease into every test after it — the
   * kind of cross-test noise that makes an unrelated failure look real.
   */
  let extraRuntimes: Runtime[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `publish-gate-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    extraRuntimes = [];
  });

  afterEach(async () => {
    // Each disposal is isolated: a rejecting one must not skip the rest of
    // the loop or the shared teardown below it. The inline disposal this
    // replaced always reached the shared cleanup, and the loop that fixed one
    // leak introduced another until it did too.
    for (const extra of extraRuntimes ?? []) {
      try {
        await extra.dispose();
      } catch {
        // Keep tearing down the remaining runtimes and the shared manager.
      }
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  const createEngine = (
    index: IndexStub,
    options: { publishDiscoverable?: true } = {},
  ): CfHarnessEngine =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, identity: signer }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
      ...(options.publishDiscoverable === true
        ? {
          fabricSession: {
            apiUrl: "https://toolshed.test/",
            identityKeyPath: "/keys/agent.pkcs8",
            space: "publish-gate",
          },
          patternIndex: {
            baseUrl: "https://index.test",
            publishDiscoverable: true,
          },
        }
        : {}),
    });

  /**
   * Runs `sourceText` and then sends what the session staged, which is what
   * the prompt loop does when a session ends.
   */
  const runAndFlush = async (
    index: IndexStub,
    input: Record<string, unknown>,
  ): Promise<RunPatternToolSuccessOutput> => {
    const engine = createEngine(index);
    const result = await engine.invokeBuiltinTool("run_pattern", input);
    await engine.flushPatternIndexLedger();
    return result.output as RunPatternToolSuccessOutput;
  };

  const published = (index: IndexStub) =>
    index.calls.filter((call) => call.fn === "publishPattern");

  for (const publishStatus of [200, 403]) {
    it(`returns a queued publication report when the index later returns ${publishStatus}`, async () => {
      const index = stubIndex({}, publishStatus);
      const engine = createEngine(index);
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLER,
        inputs: { n: 21 },
        resultSchema: {
          type: "object",
          properties: { doubled: { type: "number" } },
          required: ["doubled"],
        },
        description: "Doubles a number",
      });
      // Tool artifacts and model context retain the result at tool return,
      // before the session flush learns whether the index accepted it.
      const output = JSON.parse(
        JSON.stringify(result.output),
      ) as RunPatternToolSuccessOutput;
      const attemptsAtReturn = published(index).length;
      await engine.flushPatternIndexLedger();

      expect(attemptsAtReturn).toBe(0);
      expect(published(index)).toHaveLength(1);
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
      expect(output.patternPublication).toMatchObject({
        status: "queued",
        reason: "recorded-automatically",
      });
      expect(output.patternPublication?.message).toContain("not confirmed");
    });
  }

  it("has no publication ledger when the run has no index", async () => {
    // The engine hands the ledger over with the index client, so a run
    // without a client has neither — and `run_pattern` then records nothing
    // rather than reaching for a second publish path.
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, identity: signer }),
    });
    expect(engine.patternIndexLedger).toBeUndefined();
    await engine.flushPatternIndexLedger();

    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.patternPublication).toBeUndefined();
  });

  it("reports the run's outcome even when the index refuses the event", async () => {
    // Usage events are a contribution to a shared catalog, not part of the
    // tool's result: a rejected one is logged and the run stands.
    const calls: { fn: string }[] = [];
    const failingFetch: HarnessFetch = (input) => {
      const fn = String(input).split("/").pop() ?? "";
      calls.push({ fn });
      return Promise.resolve(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    };
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, identity: signer }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: failingFetch,
            signer,
          }),
        ),
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    await engine.flushPatternIndexLedger();
    expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
    expect(calls.some((call) => call.fn === "publishPattern")).toBe(true);
  });

  it("keeps the sortable table that is live in the index out of search", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
      hashtags: ["table", "sort"],
    });

    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("ui-default-tostring");
    // Recorded in full: `getPattern` answers for it and a `cf:pattern:`
    // import resolves it. Only search is denied it.
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
    // The index refuses a hidden entry with no reason, and a person reading
    // it later needs to know what was found rather than only that it was hid.
    expect(published(index)[0].body.discoverabilityReason).toContain(
      "[object Object]",
    );
    expect(published(index)[0].body.program).toEqual({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LIVE_BROKEN_SORTABLE_TABLE }],
    });
  });

  it("lets the run that authored it succeed anyway", async () => {
    // A publication has never been allowed to bear on the run that made it,
    // and a gate verdict must not start.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
    });
    expect(output.status).toBe("ok");
    expect(output.resultRef).toBeDefined();
    expect(output.pieceId).toBeDefined();
  });

  it("persists none of the rendered output, anywhere", async () => {
    // The artifact root is not a confidentiality boundary: `bash` does not
    // reserve it and its stdout is model-facing. The DOM is read, classified
    // and discarded — reproducible from the recorded program and a
    // deterministic synthetic instance, so keeping a copy buys nothing and
    // costs an exposure two reviewers have walked.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
    });

    // The gate saw the marker — that is what the verdict says.
    expect(output.patternPublication?.reason).toBe("ui-default-tostring");
    // And nothing it saw is anywhere in the output the artifact persists.
    // The constant message names the marker as a literal — the gate's own
    // vocabulary, not something it read — so the check covers the rest.
    const { patternPublication: _verdict, ...rest } = output;
    const persisted = JSON.stringify(rest);
    expect(persisted).not.toContain("[object Object]");
    expect(persisted).not.toContain("<td");
    expect(persisted).not.toContain("alpha");
    expect(output.rawCauseMessage).toBeUndefined();
  });

  it("records a table that renders its cells without offering it to search", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
      hashtags: ["table"],
    });

    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("recorded-automatically");
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
    expect(published(index)[0].body.discoverabilityReason).toBe(
      "recorded automatically; discoverability is earned by evidence",
    );
    // A pass keeps no DOM. There is no verdict to adjudicate, and the run
    // artifact is readable through `bash` (CT-2117), so a passing run writes
    // nothing there that it does not need.
    expect(output.rawCauseMessage).toBeUndefined();
  });

  it("offers a passing render to search only when the run deliberately opts in", async () => {
    const index = stubIndex();
    const engine = createEngine(index, { publishDiscoverable: true });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
      hashtags: ["table"],
    });
    await engine.flushPatternIndexLedger();
    const output = result.output as RunPatternToolSuccessOutput;

    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("ui-rendered");
    expect(published(index)[0].body.discoverable).toBe(true);
    expect(published(index)[0].body.discoverabilityReason).toBeUndefined();
  });

  it("records automatic and render-gated entries for distinguishable reasons", async () => {
    const index = stubIndex();
    await runAndFlush(index, {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    await runAndFlush(index, {
      sourceText: EMPTY_UI,
      inputs: {},
      description: "Renders nothing",
    });

    const [automatic, renderGated] = published(index);
    expect(renderGated.body.discoverabilityReason).not.toBe(
      automatic.body.discoverabilityReason,
    );
  });

  it("finds the $UI of a pattern that declares its result type", async () => {
    // Reading the raw result returns only the declared fields, so this
    // reported `no-ui` — a skipped check dressed as a clean run — for 20 of
    // the 24 seed components. Left as a raw read, this test fails.
    const index = stubIndex();
    const engine = createEngine(index, { publishDiscoverable: true });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DECLARED_RESULT_UI,
      inputs: {},
      description: "Renders a rating",
    });
    await engine.flushPatternIndexLedger();
    const output = result.output as RunPatternToolSuccessOutput;

    expect(output.patternPublication?.reason).toBe("ui-rendered");
    expect(output.patternPublication?.status).toBe("queued");
    expect(output.rawCauseMessage).toBeUndefined();
  });

  it("records a pure computation, which has no $UI to check", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });

    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("recorded-automatically");
    expect(output.patternPublication?.syntheticInputsComplete).toBe(true);
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
  });

  it("records a $UI that rendered no text without condemning it", async () => {
    // An absence of text is what an empty-state list looks like and what a
    // UI built from images looks like, so it is not read as a defect — but
    // it is not read as a pass either.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: EMPTY_UI,
      inputs: {},
      description: "Renders nothing",
    });

    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("ui-rendered-empty");
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
    expect(published(index)[0].body.discoverabilityReason).toContain(
      "no text and no attributes",
    );
  });

  /**
   * A session whose identity misbehaves when the gate reaches for it.
   *
   * The probe now runs in its own isolated runtime, so intercepting the
   * session's `runPersistent` no longer touches it. The identity is the one
   * thing the gate takes from the session, which makes it the seam a test can
   * drive — and driving it is deterministic, with no clock involved.
   */
  const identityThat = (onUse: () => void): typeof signer => {
    let fired = false;
    return new Proxy(signer, {
      get(target, property) {
        // Any reach for the identity, not a particular one: the gate is the
        // only thing that touches it, and which member it reads first is an
        // implementation detail a test should not encode.
        if (!fired) {
          fired = true;
          onUse();
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof signer;
  };

  const engineWith = (index: IndexStub, identity: typeof signer) =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, identity }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    });

  const runWith = async (
    index: IndexStub,
    identity: typeof signer,
    signal?: AbortSignal,
  ) => {
    const engine = engineWith(index, identity);
    const result = await engine.invokeBuiltinTool(
      "run_pattern",
      {
        sourceText: WORKING_SORTABLE_TABLE,
        inputs: { rows: [{ name: "Avery", score: 12 }] },
        description: "Sortable table that reads its cells",
      },
      ...(signal === undefined ? [] : [{ signal }]) as [
        { signal: AbortSignal },
      ],
    );
    await engine.flushPatternIndexLedger();
    return result.output as RunPatternToolSuccessOutput & { message?: string };
  };

  it("publishes nothing and reports cancelled when the run aborts during the gate", async () => {
    // An index entry is a claim about a run that finished. The abort fires
    // from inside the gate's own reach for the identity, so it lands while
    // the probe is running rather than at a moment a clock chose.
    const index = stubIndex();
    const controller = new AbortController();
    const output = await runWith(
      index,
      identityThat(() => controller.abort()),
      controller.signal,
    );
    expect(output.status).toBe("cancelled");
    expect(output.message).toContain("not undone");
    expect(published(index)).toEqual([]);
  });

  it("opens the render-gate probe under the session runtime's read ceiling", async () => {
    // The probe reads the same space the session does, so it reads under the
    // same ceiling; a probe opened unbounded against the live API would be
    // the leak the ceiling exists to close, through the render path.
    const boundedManager = StorageManager.emulate({ as: signer });
    const boundedRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: boundedManager,
      cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
      cfcReadOnExceed: "skip",
    });
    // Registered before anything can throw: afterEach disposes it, and
    // disposal closes the manager it owns.
    extraRuntimes.push(boundedRuntime);
    const boundedPieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `publish-gate-bounded-${crypto.randomUUID()}`,
      }),
      boundedRuntime,
    );
    await boundedPieces.synced();
    const index = stubIndex();
    let probeCeiling: unknown = "never opened";
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () =>
        Promise.resolve({ pieces: boundedPieces, identity: signer }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
      openProbeRuntime: (_identity, _apiUrl, _mode, ceiling) => {
        probeCeiling = ceiling;
        return Promise.resolve(undefined);
      },
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.patternPublication?.reason).toBe("probe-failed");
    expect(probeCeiling).toEqual({
      cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
      cfcReadOnExceed: "skip",
    });
  });

  it("records without a verdict when the probe fails for its own reasons", async () => {
    // No abort: the failure is the probe's, and it is no evidence about the
    // rendering either way. The run still succeeds and the entry is recorded.
    const index = stubIndex();
    const output = await runWith(
      index,
      identityThat(() => {
        throw new Error("probeExplodedForItsOwnReasons");
      }),
    );

    expect(output.status).toBe("ok");
    expect(output.patternPublication?.status).toBe("queued");
    expect(output.patternPublication?.reason).toBe("probe-failed");
    expect(output.rawCauseMessage).toContain("probeExplodedForItsOwnReasons");
    expect(JSON.stringify(output.patternPublication)).not.toContain(
      "probeExplodedForItsOwnReasons",
    );
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
  });

  it("abstains rather than probing in the live space when there is no identity", async () => {
    // A fallback to the session's space would re-enter, through the error
    // path, exactly the durable write the isolated runtime exists to prevent.
    const index = stubIndex();
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    await engine.flushPatternIndexLedger();
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.patternPublication?.reason).toBe("probe-failed");
    expect(output.patternPublication?.status).toBe("queued");
  });

  it("gives a composed pattern a verdict rather than no verdict", async () => {
    // The claim this exercises is one a reviewer had to correct me on: the
    // probe runs in its own runtime, so a `cf:pattern:` import has to be
    // materialized into THAT space, under the run's own CFC mode, or the
    // compile cannot resolve it and every composed pattern comes back
    // uncertified. Nothing tested that branch, which is why the mode was
    // missing from it in the first place.
    const doublerId = await entryIdentityOf(DOUBLER);
    const index = stubIndex({
      [doublerId]: {
        patternId: doublerId,
        ownerDid: "did:key:zOwner",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Doubles a number",
        hashtags: ["math"],
        dependencies: [],
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: DOUBLER }],
        },
      },
    });
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, identity: signer }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
      fabricSession: {
        apiUrl: "https://toolshed.test/",
        identityKeyPath: "/keys/agent.pkcs8",
        space: "publish-gate",
      },
      patternIndex: {
        baseUrl: "https://index.test",
        publishDiscoverable: true,
      },
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: composedSource(doublerId),
      inputs: { n: 3 },
      description: "Doubles a number and shows it",
    });
    await engine.flushPatternIndexLedger();
    const output = result.output as RunPatternToolSuccessOutput;

    // A verdict, not `probe-failed` — the composed import resolved inside the
    // isolated runtime.
    expect(output.patternPublication?.reason).toBe("ui-rendered");
    expect(output.patternPublication?.status).toBe("queued");
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.dependencies).toEqual([doublerId]);
  });

  it("records earlier iterations as superseded by the retained candidate", async () => {
    // The duplicate flood, fixed where it is made: a pattern-author that
    // iterates leaves one retained candidate and a record of every attempt.
    const index = stubIndex();
    const engine = createEngine(index);
    for (const label of ["Name", "Player"]) {
      await engine.invokeBuiltinTool("run_pattern", {
        sourceText: WORKING_SORTABLE_TABLE.replace("Name", label),
        inputs: { rows: [{ name: "Avery", score: 12 }] },
        description: "Sortable table that reads its cells",
        hashtags: ["table"],
      });
    }
    await engine.flushPatternIndexLedger();

    const calls = published(index);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.discoverable).toBe(false);
    expect(calls[0].body.discoverabilityReason).toContain("superseded");
    expect(calls[1].body.discoverable).toBe(false);
    expect(calls[1].body.discoverabilityReason).toBe(
      "recorded automatically; discoverability is earned by evidence",
    );
    // Distinct entries: each iteration is its own content identity, and both
    // are recorded.
    expect(calls[0].body.patternId).not.toBe(calls[1].body.patternId);
  });

  it("records both of two capabilities one session authored", async () => {
    const index = stubIndex();
    const engine = createEngine(index);
    await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    await engine.flushPatternIndexLedger();

    const calls = published(index);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.body.discoverable)).toEqual([false, false]);
  });
});
