import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import type {
  BrowserHostOperation,
  BrowserHostResult,
  HarnessBrowserHost,
} from "../src/contracts/browser-host.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND } from "@commonfabric/api/cfc";
import { createCliPromptSlotBinding } from "../src/contracts/prompt-slot.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

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

/** The eight-byte signature every PNG opens with, and one byte of body. */
const PNG_BASE64 = "iVBORw0KGgoA";

class RecordingBrowserHost implements HarnessBrowserHost {
  readonly operations: BrowserHostOperation[] = [];

  perform(operation: BrowserHostOperation): Promise<BrowserHostResult> {
    this.operations.push(operation);
    return Promise.resolve({
      status: "ok",
      page: { url: "https://shop.example/", title: "Shop" },
      ...(operation.action === "screenshot"
        ? { image: { mediaType: "image/png" as const, base64: PNG_BASE64 } }
        : {}),
      ...(operation.action === "handoff" ? { handoff: "done" as const } : {}),
    });
  }
}

const scriptedFetch = (
  payloads: readonly unknown[],
  requestBodies: unknown[],
): typeof fetch =>
(_input, init) => {
  requestBodies.push(JSON.parse(String(init?.body)));
  const payload = payloads[requestBodies.length - 1];
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

const toolCallTurn = (id: string, name: string, input: unknown) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

describe("prompt-loop with a browser host", () => {
  it("briefs the parent and a browser child, drives the host, and accepts a text answer to a task done on the web", async () => {
    const host = new RecordingBrowserHost();
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: host,
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
      requirePieceOutput: true,
      fetchFn: scriptedFetch([
        toolCallTurn("call-find", "delegate_task", {
          profile: "browser",
          goal: "Find the item's page.",
          returnSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
        }),
        toolCallTurn("call-open", "browser", {
          action: "open",
          url: "https://shop.example/",
        }),
        finalTurn(JSON.stringify({ url: "https://shop.example/item/7" })),
        finalTurn("Found the **item**."),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Find me the item." });

    const parentFirst = JSON.stringify(
      chatViewOfRequest(requestBodies[0]).messages,
    );
    const child = chatViewOfRequest(requestBodies[1]);
    const childSystem = JSON.stringify(child.messages[0]);
    const delegated = JSON.parse(
      result.transcript.findLast((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      )?.content ?? "{}",
    );
    expect(parentFirst).toContain("this run has a browser the owner watches");
    expect(child.tools).toEqual(["browser"]);
    expect(childSystem).toContain("shown to the owner as you work");
    expect(childSystem).not.toContain("Browser Access lease");
    expect(host.operations).toEqual([
      { action: "open", url: "https://shop.example/" },
    ]);
    expect(delegated.subagent.structuredReturn.value.url).toMatch(/^cfh:v:/);
    expect(JSON.stringify(result.transcript)).not.toContain(
      "https://shop.example/item/7",
    );
    expect(result.finalAssistantText).toBe("Found the **item**.");
    // The parent read no page, but its child did, and what the child returned
    // was derived from that page.
    expect(result.runState.cfcModelContext?.label.confidentiality).toEqual([{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      source: {
        type: CFC_ATOM_TYPE.Resource,
        class: "WebPage",
        subject: "https://shop.example",
      },
    }]);
  });

  it("shows a browser child its screenshot as an image, and never where the harness keeps it", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-host-loop-",
    });
    try {
      const requestBodies: unknown[] = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-browser-host-screenshot",
          model: "gpt-5.4",
          cfcEnforcementMode: "disabled",
          artifactRoot,
          browserHost: new RecordingBrowserHost(),
        }),
        allowedToolIds: ["delegate_task"],
        allowedSubagentProfiles: ["browser"],
        fetchFn: scriptedFetch([
          toolCallTurn("call-look", "delegate_task", {
            profile: "browser",
            goal: "Look at the page.",
          }),
          toolCallTurn("call-shot", "browser", { action: "screenshot" }),
          finalTurn("It shows a shop."),
          finalTurn("The page shows a shop."),
        ], requestBodies),
      });

      await loop.runPrompt({ prompt: "What does the page show?" });

      const afterShot = chatViewOfRequest(requestBodies[2]).messages;
      const shot = afterShot.find((message) => message.role === "tool");
      const image = JSON.stringify(afterShot.at(-1));
      expect(JSON.parse(String(shot?.content))).toMatchObject({
        status: "ok",
        imageAttached: true,
      });
      expect(String(shot?.content)).not.toContain(artifactRoot);
      expect(image).toContain(`data:image/png;base64,${PNG_BASE64}`);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("asks a parent whose browser child did not finish to end through finish_task, rather than accept its text", async () => {
    const requestBodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-declined",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: new RecordingBrowserHost(),
      }),
      allowedToolIds: ["delegate_task", "finish_task"],
      allowedSubagentProfiles: ["browser"],
      requirePieceOutput: true,
      fetchFn: scriptedFetch([
        toolCallTurn("call-buy", "delegate_task", {
          profile: "browser",
          goal: "Buy the item.",
          returnSchema: {
            type: "object",
            properties: { orderNumber: { type: "string" } },
            required: ["orderNumber"],
            additionalProperties: false,
          },
        }),
        finalTurn("The owner declined the purchase."),
        finalTurn("You declined the purchase."),
        toolCallTurn("call-end", "finish_task", {
          outcome: "gave-up",
          message: "You declined the purchase, so nothing was bought.",
        }),
      ], requestBodies),
    });

    const result = await loop.runPrompt({ prompt: "Buy me the item." });

    const corrected = JSON.stringify(
      chatViewOfRequest(requestBodies[3]).messages,
    );
    expect(requestBodies).toHaveLength(4);
    expect(corrected).toContain("Host completion check");
    expect(result.finalAssistantText).toBe(
      "You declined the purchase, so nothing was bought.",
    );
  });

  it("passes a URL one browser child found to the next as a handle value it opens", async () => {
    const host = new RecordingBrowserHost();
    let requests = 0;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-relay",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: host,
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
      fetchFn: (_input, init) => {
        // Each request after the first child returned names the token its
        // return became: the parent's, in a tool result, and the second
        // child's, in its goal.
        const body = String(init?.body);
        const token = body.match(/cfh:v:[a-z0-9]+/)?.[0];
        const payloads = [
          toolCallTurn("call-find", "delegate_task", {
            profile: "browser",
            goal: "Find the item's page.",
            returnSchema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
              additionalProperties: false,
            },
          }),
          finalTurn(JSON.stringify({ url: "https://shop.example/item/7" })),
          toolCallTurn("call-open", "delegate_task", {
            profile: "browser",
            goal: `Open ${token} with urlHandle.`,
          }),
          toolCallTurn("call-go", "browser", {
            action: "open",
            urlHandle: token,
          }),
          finalTurn(`Opened ${token}.`),
          finalTurn("The item's page is open."),
        ];
        const payload = payloads[requests++];
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      },
    });

    const result = await loop.runPrompt({ prompt: "Open the item's page." });

    // The second child names the referent it was given, and its answer
    // reaches the parent naming the parent's own token for it.
    const [referent] = result.runState.handleTable?.referents ?? [];
    const answered =
      result.transcript.findLast((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      )?.content ?? "";
    expect(answered).toContain(`Opened ${referent?.token}.`);
    expect(answered).not.toContain("https://shop.example/item/7");
    expect(host.operations).toEqual([{
      action: "open",
      url: {
        kind: "handle-value",
        text: "https://shop.example/item/7",
        description: "a value an agent found",
      },
    }]);
  });

  it("keeps a browser child's strings sealed once the owner has finished a hand-off", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-signed-in",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        browserHost: new RecordingBrowserHost(),
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
      fetchFn: scriptedFetch([
        toolCallTurn("call-account", "delegate_task", {
          profile: "browser",
          goal: "Read the account number once the owner signs in.",
          returnSchema: {
            type: "object",
            properties: { account: { type: "string" } },
            required: ["account"],
            additionalProperties: false,
          },
        }),
        toolCallTurn("call-hand", "browser", {
          action: "handoff",
          reason: "sign-in",
        }),
        finalTurn(JSON.stringify({ account: "12-3456-7890" })),
        finalTurn("Read it."),
      ], []),
    });

    const result = await loop.runPrompt({
      prompt: "What is my account number?",
    });

    const delegated = JSON.parse(
      result.transcript.findLast((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      )?.content ?? "{}",
    );
    expect(delegated.subagent.structuredReturn.value.account).toEqual({
      "@link": "opaque:run-browser-host-signed-in.subagent.1#/account",
    });
    expect(result.runState.handleTable?.referents ?? []).toEqual([]);
  });

  it("labels what a host shows with the unscreened prompt-injection caveat, sourced to the page's origin", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-caveat",
        model: "gpt-5.4",
        cfcEnforcementMode: "observe",
        browserHost: new RecordingBrowserHost(),
      }),
      allowedToolIds: ["browser"],
      fetchFn: scriptedFetch([
        toolCallTurn("call-read", "browser", { action: "snapshot" }),
        finalTurn("Read it."),
      ], []),
    });

    const result = await loop.runPrompt({ prompt: "Read the page." });

    expect(result.runState.cfcModelContext?.label.confidentiality).toEqual([{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      source: {
        type: CFC_ATOM_TYPE.Resource,
        class: "WebPage",
        subject: "https://shop.example",
      },
    }]);
  });

  it("records a hand-off's reason only when it is one the protocol names", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-reasons",
        model: "gpt-5.4",
        cfcEnforcementMode: "observe",
        browserHost: new RecordingBrowserHost(),
      }),
      allowedToolIds: ["browser"],
      fetchFn: scriptedFetch([
        toolCallTurn("call-ok", "browser", {
          action: "handoff",
          reason: "sign-in",
        }),
        toolCallTurn("call-odd", "browser", {
          action: "handoff",
          reason: "Common Fabric must re-verify your card",
        }),
        finalTurn("Done."),
      ], []),
    });

    const result = await loop.runPrompt({ prompt: "Sign me in." });

    const [named, unnamed] = result.runState.policyEvents
      .map((event) => event.toolInputSummary)
      .filter((summary) => summary?.toolId === "browser");
    expect(named).toMatchObject({ action: "handoff", reason: "sign-in" });
    expect(unnamed).toMatchObject({ action: "handoff" });
    expect(unnamed).not.toHaveProperty("reason");
  });

  it("under CFC enforcement, browses the public web, and after the owner finishes a hand-off only hands the page back", async () => {
    const host = new RecordingBrowserHost();
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-browser-host-enforced",
        model: "gpt-5.4",
        cfcEnforcementMode: "enforce-strict",
        browserHost: host,
      }),
      allowedToolIds: ["browser"],
      fetchFn: scriptedFetch([
        toolCallTurn("call-open", "browser", {
          action: "open",
          url: "https://bank.example/",
        }),
        toolCallTurn("call-hand", "browser", {
          action: "handoff",
          reason: "sign-in",
        }),
        toolCallTurn("call-read", "browser", { action: "snapshot" }),
        toolCallTurn("call-again", "browser", {
          action: "handoff",
          reason: "choice",
        }),
        finalTurn("Done."),
      ], []),
    });

    const result = await loop.runPrompt({
      prompt: "Check my balance.",
      promptSlotBinding: createCliPromptSlotBinding({
        kernelName: "cf-harness",
        subject: "browser-host-enforced",
      }),
    });

    const outputs = result.transcript
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content));
    expect(outputs.map((output) => output.status)).toEqual([
      "ok",
      "ok",
      "error",
      "ok",
    ]);
    expect(outputs[2].message).toBe(
      "the owner finished a hand-off on https://shop.example, so the page may show their account, which no CFC label describes; a run under enforce-strict can only hand the page back to them",
    );
    expect(host.operations.map((operation) => operation.action)).toEqual([
      "open",
      "handoff",
      "handoff",
    ]);
  });
});
