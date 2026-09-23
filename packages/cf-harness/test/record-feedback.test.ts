import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { Identity } from "@commonfabric/identity";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import type {
  RecordFeedbackToolErrorOutput,
  RecordFeedbackToolSuccessOutput,
} from "../src/tools/record-feedback.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness record-feedback tool");

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

/**
 * An index answering every call with `status`, recording what it was sent.
 * `body` replaces the answer, for the case a 2xx carries a refusal rather than
 * a confirmation.
 */
const stubIndex = (
  status = 200,
  body?: Record<string, unknown>,
): IndexStub => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    calls.push({
      fn,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify(
          body ??
            (status === 200 ? { ok: true } : { error: "no such pattern" }),
        ),
        { status },
      ),
    );
  };
  return { fetchFn, calls };
};

const createEngine = (index?: IndexStub): CfHarnessEngine =>
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `record-feedback-test-${crypto.randomUUID()}`,
    ...(index === undefined ? {} : {
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    }),
  });

describe("record-feedback", () => {
  it("records an up verdict as a thumbs_up event", async () => {
    const index = stubIndex();
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      { patternId: "pat-expenses", verdict: "up" },
    );
    const output = result.output as RecordFeedbackToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.patternId).toBe("pat-expenses");
    expect(output.verdict).toBe("up");
    expect(index.calls).toEqual([{
      fn: "recordEvent",
      body: {
        patternId: "pat-expenses",
        eventType: "thumbs_up",
        did: signer.did(),
      },
    }]);
  });

  it("records a down verdict as a thumbs_down event carrying the note", async () => {
    const index = stubIndex();
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      {
        patternId: "pat-expenses",
        verdict: "down",
        note: "totalled the wrong column",
      },
    );
    const output = result.output as RecordFeedbackToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.verdict).toBe("down");
    expect(index.calls[0].body).toEqual({
      patternId: "pat-expenses",
      eventType: "thumbs_down",
      did: signer.did(),
      note: "totalled the wrong column",
    });
  });

  it("answers the model with the verdict alone and no echo of the note", async () => {
    const index = stubIndex();
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      {
        patternId: "pat-expenses",
        verdict: "down",
        note: "totalled the wrong column",
      },
    );
    expect(JSON.stringify(result.output)).not.toContain("wrong column");
  });

  it("refuses the call when the run has no pattern index", async () => {
    const result = await createEngine().invokeBuiltinTool("record_feedback", {
      patternId: "pat-expenses",
      verdict: "up",
    });
    const output = result.output as RecordFeedbackToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("--pattern-index-url");
  });

  it("reports what the index answered for a pattern it does not hold", async () => {
    const index = stubIndex(404);
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      { patternId: "pat-missing", verdict: "up" },
    );
    const output = result.output as RecordFeedbackToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("404");
  });

  it("reports an index that answered without recording the event", async () => {
    const index = stubIndex(200, { ok: false });
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      { patternId: "pat-expenses", verdict: "up" },
    );
    const output = result.output as RecordFeedbackToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("did not record the thumbs_up event");
  });

  it("refuses a verdict the index has no event for", async () => {
    const index = stubIndex();
    const result = await createEngine(index).invokeBuiltinTool(
      "record_feedback",
      // A model can write anything into a tool argument, so the tool measures
      // the verdict itself rather than trusting the declared enum.
      { patternId: "pat-expenses", verdict: "sideways" } as never,
    );
    const output = result.output as RecordFeedbackToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain('"up" or "down"');
    expect(index.calls).toEqual([]);
  });
});
