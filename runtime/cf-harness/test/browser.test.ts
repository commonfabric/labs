/**
 * Unit tests for the browser tool: the action planning — the vocabulary, each
 * action's argument grammar, and the refusal of fields outside their action —
 * and the invocation path where a bound handle becomes a value trusted-side
 * and stays out of everything the model reads afterwards.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { CfHarnessEngine } from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  browserTool,
  type BrowserToolErrorOutput,
  type BrowserToolInput,
  type BrowserToolSuccessOutput,
  type LeaseActionPlan,
  parseBrowserCall,
  planLeaseAction,
} from "../src/tools/browser.ts";

const signer = await Identity.fromPassphrase("cf-harness browser tool");

const BROWSER_LEASE = {
  type: "cf-harness.chat.browser-access-lease",
  leaseId: "lease-1",
  cdpUrl: "http://localhost:9362",
} as const;

const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForBrowserToolTest/of:fid1:${
  "A".repeat(43)
}/`;

/** The one origin these runs allow a handle's value to reach. */
const ALLOWED_ORIGIN = "https://example.com";

/** What the destination probe prints: the page the leased browser shows. */
const pageAt = (url: string) => ({
  stdout: `${url}\n`,
  stderr: "",
  exitCode: 0,
});

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

class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];

  readonly #results: (ProcessRunResult | Error)[];

  constructor(
    results: (ProcessRunResult | Error)[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {
    this.#results = results;
  }

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    const next = this.#results.shift() ??
      { stdout: "", stderr: "", exitCode: 0 };
    // An `Error` in the script stands for a run that never produced a result
    // at all — no binary on the host, a spawn the OS refused.
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

/** The lease's plan for `input`, or the refusal of the input. */
const planOf = (input: BrowserToolInput): LeaseActionPlan => {
  const parsed = parseBrowserCall(input);
  return parsed.error !== undefined
    ? { error: parsed.error }
    : planLeaseAction(parsed.call);
};

const argvOf = (input: BrowserToolInput): readonly string[] => {
  const plan = planOf(input);
  if (plan.argv === undefined) {
    throw new Error(`expected an argument list, got ${JSON.stringify(plan)}`);
  }
  return plan.argv;
};

const errorOf = (input: BrowserToolInput): string => {
  const plan = planOf(input);
  if (plan.error === undefined) {
    throw new Error(`expected an error, got ${JSON.stringify(plan)}`);
  }
  return plan.error;
};

describe("browser", () => {
  describe("parseBrowserCall and planLeaseAction", () => {
    it("refuses an action outside the vocabulary", () => {
      expect(errorOf({ action: "eval" })).toContain("action must be one of");
      expect(errorOf({})).toContain("action must be one of");
    });

    it("refuses a field that does not belong to the action", () => {
      expect(errorOf({ action: "snapshot", url: "https://example.com/" }))
        .toBe("url does not apply to the snapshot action");
      expect(errorOf({ action: "open", url: "https://a.example/", ref: "@e1" }))
        .toBe("ref does not apply to the open action");
      expect(errorOf({ action: "press", key: "Enter", value: "x" }))
        .toBe("value does not apply to the press action");
    });

    it("refuses what only a browser host offers, naming the lease", () => {
      const lease =
        "needs a browser host, such as the Weaver; this run's browser is a Browser Access lease";

      for (const action of ["back", "forward", "reload", "screenshot"]) {
        expect(errorOf({ action })).toBe(`the ${action} action ${lease}`);
      }
      expect(errorOf({ action: "handoff", reason: "sign-in" })).toBe(
        `the handoff action ${lease}`,
      );
      expect(errorOf({ action: "click", x: 10, y: 20 })).toBe(
        `a click at a point ${lease}`,
      );
    });

    it("offers a lease run the lease's actions and a host run the host's", () => {
      const run = { cfcEnforcementMode: "observe" as const };
      const actionsOf = (browserHost: boolean): unknown =>
        browserTool.descriptorForRuntime?.(
          new FakeSandboxRuntime().describe(),
          { ...run, browserHost },
        ).inputSchema;
      const lease = JSON.stringify(actionsOf(false));
      const host = JSON.stringify(actionsOf(true));

      expect(lease).not.toContain('"handoff"');
      expect(lease).not.toContain('"reason"');
      expect(lease).toContain("cfh:a:");
      expect(host).toContain('"handoff"');
      expect(host).toContain('"reason"');
      expect(host).toContain("cfh:v:");
      expect(host).not.toContain('"ms"');
    });

    it("plans open for an http(s) URL only", () => {
      expect(argvOf({ action: "open", url: "https://example.com/a?b=c" }))
        .toEqual(["open", "https://example.com/a?b=c"]);
      expect(argvOf({ action: "open", url: "HTTP://example.com/" }))
        .toEqual(["open", "HTTP://example.com/"]);
      expect(errorOf({ action: "open" })).toBe("open requires a url");
      expect(errorOf({ action: "open", url: "file:///etc/passwd" }))
        .toBe("open only allows http(s) URLs");
      expect(errorOf({ action: "open", url: "javascript:alert(1)" }))
        .toBe("open only allows http(s) URLs");
      // A URL parser drops these characters, so the URL it would judge is
      // not the string agent-browser would be handed.
      for (
        const url of [
          " https://example.com/",
          "https://example.com/ ",
          "https://exa\tmple.com/",
          "https://example.com/\npath",
          "https://example.com/\x00",
          "https:example.com/",
        ]
      ) {
        expect(errorOf({ action: "open", url })).toBe(
          "open only allows http(s) URLs",
        );
      }
    });

    it("plans snapshot with and without interactive refs", () => {
      expect(argvOf({ action: "snapshot" })).toEqual(["snapshot"]);
      expect(argvOf({ action: "snapshot", interactive: true }))
        .toEqual(["snapshot", "-i"]);
      expect(argvOf({ action: "snapshot", interactive: false }))
        .toEqual(["snapshot"]);
      expect(
        errorOf({
          action: "snapshot",
          interactive: "yes" as unknown as boolean,
        }),
      )
        .toBe("snapshot interactive must be true or false");
    });

    it("plans get for title, url, and targeted text", () => {
      expect(argvOf({ action: "get", kind: "title" })).toEqual([
        "get",
        "title",
      ]);
      expect(argvOf({ action: "get", kind: "url" })).toEqual(["get", "url"]);
      expect(argvOf({ action: "get", kind: "text", target: "h1" }))
        .toEqual(["get", "text", "h1"]);
      expect(errorOf({ action: "get", kind: "title", target: "h1" }))
        .toBe("get title does not take a target");
      expect(errorOf({ action: "get", kind: "text" }))
        .toBe(
          "get text requires a target: a CSS selector such as body, or an @ref from a snapshot",
        );
      expect(errorOf({ action: "get" }))
        .toBe("get requires kind title, url, or text");
      expect(errorOf({ action: "get", kind: "html" }))
        .toBe("get requires kind title, url, or text");
    });

    it("plans console and errors with no arguments", () => {
      expect(argvOf({ action: "console" })).toEqual(["console"]);
      expect(argvOf({ action: "errors" })).toEqual(["errors"]);
    });

    it("plans wait for exactly one of its four forms", () => {
      expect(argvOf({ action: "wait", ms: 500 })).toEqual(["wait", "500"]);
      expect(argvOf({ action: "wait", ref: "@e3" })).toEqual(["wait", "@e3"]);
      expect(argvOf({ action: "wait", loadState: "networkidle" }))
        .toEqual(["wait", "--load", "networkidle"]);
      expect(argvOf({ action: "wait", urlPattern: "**/checkout" }))
        .toEqual(["wait", "--url", "**/checkout"]);
      expect(errorOf({ action: "wait" }))
        .toBe("wait requires exactly one of ms, ref, loadState, or urlPattern");
      expect(errorOf({ action: "wait", ms: 500, ref: "@e3" }))
        .toBe("wait requires exactly one of ms, ref, loadState, or urlPattern");
    });

    it("bounds wait milliseconds and rejects non-integers", () => {
      expect(argvOf({ action: "wait", ms: 0 })).toEqual(["wait", "0"]);
      expect(argvOf({ action: "wait", ms: 30_000 })).toEqual([
        "wait",
        "30000",
      ]);
      expect(errorOf({ action: "wait", ms: 30_001 }))
        .toContain("between 0 and 30000");
      expect(errorOf({ action: "wait", ms: -1 }))
        .toContain("between 0 and 30000");
      expect(errorOf({ action: "wait", ms: 1.5 }))
        .toContain("between 0 and 30000");
    });

    it("rejects wait forms outside their own grammar", () => {
      expect(errorOf({ action: "wait", ref: "e3" }))
        .toContain("requires a ref starting with @");
      expect(errorOf({ action: "wait", loadState: "idle" }))
        .toBe("wait loadState must be domcontentloaded, load, or networkidle");
      expect(errorOf({ action: "wait", urlPattern: "" }))
        .toBe("wait urlPattern requires a non-file pattern");
      expect(errorOf({ action: "wait", urlPattern: "file:///tmp/x" }))
        .toBe("wait urlPattern requires a non-file pattern");
    });

    it("plans ref interactions and refuses targets that are not refs", () => {
      expect(argvOf({ action: "click", ref: "@e5" })).toEqual(["click", "@e5"]);
      expect(argvOf({ action: "check", ref: "@e6" })).toEqual(["check", "@e6"]);
      expect(errorOf({ action: "click", ref: "#submit" }))
        .toBe("click requires a ref starting with @, taken from a snapshot");
      expect(errorOf({ action: "check" }))
        .toBe("check requires a ref starting with @, taken from a snapshot");
    });

    it("plans fill, type, and select with a ref and a string value", () => {
      expect(argvOf({ action: "fill", ref: "@e2", value: "hello world" }))
        .toEqual(["fill", "@e2", "hello world"]);
      expect(argvOf({ action: "type", ref: "@e2", value: "" }))
        .toEqual(["type", "@e2", ""]);
      expect(argvOf({ action: "select", ref: "@e4", value: "option-2" }))
        .toEqual(["select", "@e4", "option-2"]);
      expect(errorOf({ action: "fill", ref: "@e2" }))
        .toBe("fill requires a value or a valueHandle");
      expect(
        errorOf({ action: "type", ref: "@e2", value: 7 as unknown as string }),
      )
        .toBe("type requires a value or a valueHandle");
      expect(errorOf({ action: "select", value: "option-2" }))
        .toBe("select requires a ref starting with @, taken from a snapshot");
    });

    it("plans press for one plain key and refuses anything else", () => {
      expect(argvOf({ action: "press", key: "Enter" })).toEqual([
        "press",
        "Enter",
      ]);
      expect(argvOf({ action: "press", key: "Control+a" })).toEqual([
        "press",
        "Control+a",
      ]);
      expect(errorOf({ action: "press" })).toBe("press requires a key");
      expect(errorOf({ action: "press", key: "Enter; rm -rf /" }))
        .toBe("press requires one key of letters, digits, _, +, ., or -");
    });

    it("refuses a value-bearing field set alongside its handle sibling", () => {
      expect(errorOf({
        action: "fill",
        ref: "@e1",
        value: "hunter2",
        valueHandle: "cfh:a:22222",
      })).toBe(
        "value and valueHandle cannot both be set: give the value itself or a handle to it",
      );
      expect(errorOf({
        action: "open",
        url: "https://example.com/",
        urlHandle: "cfh:a:22222",
      })).toBe(
        "url and urlHandle cannot both be set: give the URL itself or a handle to it",
      );
    });

    it("refuses a handle field that is not a non-empty string", () => {
      // Nothing between the model and the tool checks a call against the
      // input schema, so a null or a number arrives as written.
      const nonStrings: readonly unknown[] = [null, 7, true, {}, ["x"], "  "];
      for (const handle of nonStrings) {
        expect(errorOf({
          action: "fill",
          ref: "@e1",
          valueHandle: handle as string,
        })).toBe("valueHandle must be a handle token naming a value");
        expect(errorOf({ action: "open", urlHandle: handle as string }))
          .toBe("urlHandle must be a handle token naming a value");
      }
    });

    it("refuses a wait urlPattern that is not a string", () => {
      expect(errorOf({ action: "wait", urlPattern: 7 as unknown as string }))
        .toBe("wait urlPattern requires a non-file pattern");
    });

    it("plans a call that gives a handle as a binding its value completes", () => {
      const fill = planOf({
        action: "fill",
        ref: "@e1",
        valueHandle: " cfh:a:22222 ",
      });
      const open = planOf({ action: "open", urlHandle: "cfh:a:33333" });

      expect(fill).toMatchObject({
        binding: { field: "value", handle: "cfh:a:22222" },
      });
      expect(fill.binding?.complete("Ada")).toEqual(["fill", "@e1", "Ada"]);
      expect(open).toMatchObject({
        binding: { field: "url", handle: "cfh:a:33333" },
      });
      expect(open.binding?.complete("https://example.com/")).toEqual([
        "open",
        "https://example.com/",
      ]);
      expect(planOf({ action: "fill", ref: "@e1", value: "Ada" }).binding)
        .toBeUndefined();
    });

    it("refuses a handle field outside its action's row", () => {
      expect(errorOf({ action: "snapshot", valueHandle: "cfh:a:22222" }))
        .toBe("valueHandle does not apply to the snapshot action");
      expect(errorOf({ action: "fill", ref: "@e1", urlHandle: "cfh:a:22222" }))
        .toBe("urlHandle does not apply to the fill action");
      expect(errorOf({ action: "open", valueHandle: "cfh:a:22222" }))
        .toBe("valueHandle does not apply to the open action");
    });
  });

  describe("browserTool", () => {
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
          spaceDid: (await Identity.generate()).did(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    const createEngine = (
      processRunner: ProcessRunner,
      options: {
        fabricSession?: boolean;
        handleValueOrigins?: readonly string[];
        onFabricSession?: () => void;
      } = {},
    ) =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `browser-tool-test-${crypto.randomUUID()}`,
        processRunner,
        workspaceHostPath: "/tmp/cf-harness-workspace",
        browserAccess: BROWSER_LEASE,
        handleValueOrigins: options.handleValueOrigins ?? [ALLOWED_ORIGIN],
        ...(options.fabricSession === false ? {} : {
          fabricSessionFactory: () => {
            options.onFabricSession?.();
            return Promise.resolve({ pieces });
          },
        }),
      });

    /**
     * Gives `engine` a handle to each reference, which is what makes one a
     * reference the run may resolve at all.
     */
    const holdHandles = async (
      engine: CfHarnessEngine,
      ...refs: readonly string[]
    ): Promise<void> => {
      let table = createHarnessHandleTable(engine.getRunState().runId);
      for (const ref of refs) {
        table = (await mintAddressHandle(table, ref)).table;
      }
      await engine.recordHandleTable(table);
    };

    /** An address in the run's space holding `value`. */
    const seedRef = async (cause: string, value: unknown): Promise<string> => {
      const space = pieces.getSpace();
      const cell = runtime.getCell(space, cause, {} as const);
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set(value);
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      return createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);
    };

    it("passes the value behind a valueHandle to agent-browser", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner([
        pageAt(`${ALLOWED_ORIGIN}/login`),
        { stdout: 'filled @e1 with "hunter2"\n', stderr: "", exitCode: 0 },
      ]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      // The destination is established first, trusted-side.
      expect(runner.calls[0]?.args).toEqual([
        "--cdp",
        "http://localhost:9362",
        "get",
        "url",
      ]);
      // The value reached the page, so the action did what was asked.
      expect(runner.calls[1]?.args).toEqual([
        "--cdp",
        "http://localhost:9362",
        "fill",
        "@e1",
        "hunter2",
      ]);
      const output = result.output as BrowserToolSuccessOutput;
      expect(output.status).toBe("ok");
    });

    it("refuses a skill-context handle before browser materialization", async () => {
      const ref = await seedRef("external-skill", "secret instructions");
      const runner = new FakeProcessRunner([
        pageAt(`${ALLOWED_ORIGIN}/login`),
      ]);
      const engine = createEngine(runner);
      const minted = await mintAddressHandle(
        createHarnessHandleTable(engine.getRunState().runId),
        ref,
        { capability: "skill-context" },
      );
      await engine.recordHandleTable(minted.table);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: minted.token,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toBe(
        "browser valueHandle cannot consume a skill-context handle; only delegate_task skillHandle can",
      );
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.args).toEqual([
        "--cdp",
        "http://localhost:9362",
        "get",
        "url",
      ]);
    });

    it("navigates to the URL behind a urlHandle", async () => {
      const ref = await seedRef("target-url", "https://example.com/inbox");
      const runner = new FakeProcessRunner([{
        stdout: "opened\n",
        stderr: "",
        exitCode: 0,
      }]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: ref,
      });

      expect((result.output as BrowserToolSuccessOutput).status).toBe("ok");
      expect(runner.calls[0]?.args).toEqual([
        "--cdp",
        "http://localhost:9362",
        "open",
        "https://example.com/inbox",
      ]);
    });

    it("refuses a urlHandle whose value is not an http(s) URL, without quoting it", async () => {
      const ref = await seedRef("target-url", "file:///etc/passwd");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe("open only allows http(s) URLs");
      expect(output.message).not.toContain("passwd");
      expect(runner.calls).toEqual([]);
    });

    it("refuses a call that sets both value and valueHandle, running nothing", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        value: "typed-by-hand",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "value and valueHandle cannot both be set: give the value itself or a handle to it",
      );
      expect(runner.calls).toEqual([]);
    });

    it("refuses a non-string valueHandle without probing or running anything", async () => {
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: null as unknown as string,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "valueHandle must be a handle token naming a value",
      );
      expect(runner.calls).toEqual([]);
    });

    it("refuses a non-string urlHandle without running anything", async () => {
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: 7 as unknown as string,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "urlHandle must be a handle token naming a value",
      );
      expect(runner.calls).toEqual([]);
    });

    it("refuses a non-string wait urlPattern without running anything", async () => {
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "wait",
        urlPattern: 7 as unknown as string,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "wait urlPattern requires a non-file pattern",
      );
      expect(runner.calls).toEqual([]);
    });

    it("refuses what only a browser host offers without running anything", async () => {
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);

      const back = await engine.invokeBuiltinTool("browser", {
        action: "back",
      });
      const point = await engine.invokeBuiltinTool("browser", {
        action: "click",
        x: 10,
        y: 20,
      });

      expect(back.output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message:
          "the back action needs a browser host, such as the Weaver; this run's browser is a Browser Access lease",
      });
      expect(point.output).toMatchObject({
        status: "error",
        code: "invalid_input",
        message:
          "a click at a point needs a browser host, such as the Weaver; this run's browser is a Browser Access lease",
      });
      expect(runner.calls).toEqual([]);
    });

    it("refuses a valueHandle when the run has no fabric session", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner([pageAt(`${ALLOWED_ORIGIN}/login`)]);
      const engine = createEngine(runner, { fabricSession: false });
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "browser valueHandle requires a fabric session to resolve a handle, and this run has none",
      );
      // Reading the destination is all that ran; nothing was filled.
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses a valueHandle that does not parse as an address", async () => {
      const runner = new FakeProcessRunner([pageAt(`${ALLOWED_ORIGIN}/login`)]);
      const engine = createEngine(runner);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: "the traveller's passphrase",
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.message).toBe(
        "browser valueHandle does not name a reference this run holds",
      );
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses a valueHandle naming a same-space address this run does not hold", async () => {
      const held = await seedRef("held-passphrase", "hunter2");
      const unheld = await seedRef("someone-elses-passphrase", "hunter3");
      const runner = new FakeProcessRunner([pageAt(`${ALLOWED_ORIGIN}/login`)]);
      const engine = createEngine(runner);
      await holdHandles(engine, held);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: unheld,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe(
        "browser valueHandle does not name a handle this run holds",
      );
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses a valueHandle naming another space", async () => {
      const runner = new FakeProcessRunner([pageAt(`${ALLOWED_ORIGIN}/login`)]);
      const engine = createEngine(runner);
      await holdHandles(engine, FOREIGN_REF);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: FOREIGN_REF,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.message).toBe(
        "browser valueHandle can only read a reference in this run's own space",
      );
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses to materialize a handle when the run allows no destination", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner, { handleValueOrigins: [] });
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toContain("--handle-value-origin");
      // Default-deny reaches the destination probe too: nothing ran at all.
      expect(runner.calls).toEqual([]);
    });

    it("refuses to materialize a handle into a page outside the allowlist", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner([
        pageAt("https://phish.example/login?next=/inbox"),
      ]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toContain("https://phish.example");
      // The origin is the whole of what a refusal says about the page.
      expect(output.message).not.toContain("/login");
      expect(output.message).not.toContain("hunter2");
      // Reading the destination is all that ran; nothing was filled.
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses to materialize a handle when the destination probe cannot be run", async () => {
      // Where the value would go is unknown, and an unknown destination is
      // not an allowed one.
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner([
        new Error("agent-browser: no such file or directory"),
      ]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toBe(
        "the current page could not be read, so where a handle's value would go is unknown",
      );
      // Reading the destination is all that was attempted; nothing was filled.
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses to materialize a handle when the destination probe exits nonzero", async () => {
      const ref = await seedRef("passphrase", "hunter2");
      const runner = new FakeProcessRunner([
        { stdout: "", stderr: "no page in view\n", exitCode: 1 },
      ]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toBe(
        "the current page could not be read, so where a handle's value would go is unknown",
      );
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });

    it("refuses to materialize a handle into a page that is not on an http(s) origin", async () => {
      // A page with no origin to compare against the allowlist — a blank tab,
      // a local file — is refused rather than compared.
      const ref = await seedRef("passphrase", "hunter2");
      for (const page of ["about:blank", "file:///tmp/x.html"]) {
        const runner = new FakeProcessRunner([pageAt(page)]);
        const engine = createEngine(runner);
        await holdHandles(engine, ref);

        const result = await engine.invokeBuiltinTool("browser", {
          action: "fill",
          ref: "@e1",
          valueHandle: ref,
        });

        const output = result.output as BrowserToolErrorOutput;
        expect(output.code).toBe("destination_not_allowed");
        expect(output.message).toBe(
          "the current page is not on an http(s) origin, so no handle can be materialized into it",
        );
        expect(output.message).not.toContain("hunter2");
        expect(runner.calls.map((call) => call.args)).toEqual([
          ["--cdp", "http://localhost:9362", "get", "url"],
        ]);
      }
    });

    it("refuses a resolved URL that is not an http(s) URL as written, even from an allowed origin", async () => {
      // A URL parser drops the leading space, so the origin is one the
      // operator allowed; agent-browser would be handed the string as written.
      const ref = await seedRef("target-url", " https://example.com/inbox");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.code).toBe("invalid_input");
      expect(output.message).toBe("open only allows http(s) URLs");
      expect(output.message).not.toContain("/inbox");
      expect(runner.calls).toEqual([]);
    });

    it("refuses a urlHandle whose resolved origin is outside the allowlist", async () => {
      const ref = await seedRef("target-url", "https://phish.example/inbox");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toContain("https://phish.example");
      expect(output.message).not.toContain("/inbox");
      expect(runner.calls).toEqual([]);
    });

    it("refuses a malformed handle action before reading the fabric", async () => {
      // A fill carrying a valid handle but no ref cannot execute, and a call
      // that cannot execute has no business reading a value out of the run's
      // space. The whole shape is checked before anything is read, so the
      // fabric session is never even opened.
      const ref = await seedRef("secret-name", "Ada Lovelace");
      const runner = new FakeProcessRunner();
      let fabricSessions = 0;
      const engine = createEngine(runner, {
        onFabricSession: () => {
          fabricSessions += 1;
        },
      });
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("invalid_input");
      expect(fabricSessions).toBe(0);
      expect(runner.calls).toEqual([]);
    });

    it("names a bare disallowed origin a urlHandle resolved to", async () => {
      // The refusal names the origin the value would have gone to, which is
      // the one fact the operator needs to decide whether to allow it, and
      // the browser is never driven at all.
      const ref = await seedRef("target-url", "https://phish.example");
      const runner = new FakeProcessRunner();
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "open",
        urlHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.code).toBe("destination_not_allowed");
      expect(output.message).toContain("https://phish.example");
      expect(runner.calls).toEqual([]);
    });

    it("refuses a valueHandle whose referent is not a string, naming the type only", async () => {
      const ref = await seedRef("structured", { account: "12345678" });
      const runner = new FakeProcessRunner([pageAt(`${ALLOWED_ORIGIN}/login`)]);
      const engine = createEngine(runner);
      await holdHandles(engine, ref);

      const result = await engine.invokeBuiltinTool("browser", {
        action: "fill",
        ref: "@e1",
        valueHandle: ref,
      });

      const output = result.output as BrowserToolErrorOutput;
      expect(output.message).toBe(
        "browser valueHandle must name a string value; the reference holds a value of type object",
      );
      expect(output.message).not.toContain("12345678");
      expect(runner.calls.map((call) => call.args)).toEqual([
        ["--cdp", "http://localhost:9362", "get", "url"],
      ]);
    });
  });
});
