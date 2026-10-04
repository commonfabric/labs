/**
 * The bash tool offers `session` only to a run that can use one: a run whose
 * sandbox has sessions, in a mode that allows them.
 *
 * The Docker runtime has none, and it is the default: a `session` input in
 * its tool manifest would change what every existing run sends the model and
 * invite a call that can only be refused. So on a runtime without sessions
 * the descriptor has to be the one main offers, byte for byte. The same holds
 * for a run in an enforcing mode on a runtime with sessions, which refuses
 * every session.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { normalize } from "@std/path/posix";
import {
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode,
} from "@commonfabric/runner/cfc";

import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import {
  SANDBOX_SESSION_NAME_PATTERN,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxRuntime,
  type SandboxRuntimeDescription,
  type SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  bashTool,
  bashToolDescriptor,
  bashToolDescriptorForRuntime,
} from "../src/tools/bash.ts";
import { builtinToolDescriptorForRuntime } from "../src/tools/registry.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

// The bash descriptor on origin/main (4a40f26c0), as `JSON.stringify` of
// what main's `src/tools/bash.ts` exports. A string and not an object, so
// that key order is part of what is compared.
const MAIN_BASH_DESCRIPTOR_JSON =
  '{"toolId":"bash","title":"Bash","description":"Run a shell command inside the target VM. Use this for navigation, search, and command-driven workflows.","effectClass":"side-effect","inputSchema":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"number","minimum":0}},"required":["command"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"outputId":{"type":"string"},"stdout":{"type":"string"},"stderr":{"type":"string"},"exitCode":{"type":"number"},"cwd":{"type":"string"},"cfcResult":{"type":"object"}},"required":["outputId","stdout","stderr","exitCode","cwd"],"additionalProperties":false},"tags":["shell","vm","command"]}';

// What main put on the wire for bash: `toResponsesTools` over the descriptor.
const MAIN_BASH_WIRE_TOOL_JSON =
  '{"type":"function","name":"bash","description":"Run a shell command inside the target VM. Use this for navigation, search, and command-driven workflows.","parameters":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"number","minimum":0}},"required":["command"],"additionalProperties":false},"strict":null}';

const dockerDescription: SandboxRuntimeDescription = {
  kind: "docker-runsc-cfc",
  defaultWorkingDirectory: "/workspace",
  cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
};

const runscDescription: SandboxRuntimeDescription = {
  kind: "runsc-cfc",
  defaultWorkingDirectory: "/workspace",
  sessions: true,
  cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
};

/**
 * Which modes let a run use a session, stated here rather than read from the
 * rule under test, so that the rule and this table are two different answers.
 */
const SESSIONS_USABLE: Readonly<Record<CfcEnforcementMode, boolean>> = {
  disabled: true,
  observe: true,
  "enforce-explicit": false,
  "enforce-strict": false,
};

Deno.test("the table covers every enforcement mode", () => {
  assertEquals(
    Object.keys(SESSIONS_USABLE).sort(),
    [...CFC_ENFORCEMENT_MODES].sort(),
  );
});

for (const mode of CFC_ENFORCEMENT_MODES) {
  const run = { cfcEnforcementMode: mode };

  Deno.test(`the bash descriptor for a runtime without sessions is main's, byte for byte, under ${mode}`, () => {
    assertEquals(
      JSON.stringify(bashToolDescriptorForRuntime(dockerDescription, run)),
      MAIN_BASH_DESCRIPTOR_JSON,
    );
    // `sessions: false` and `sessions` absent are the same answer.
    assertEquals(
      JSON.stringify(
        bashToolDescriptorForRuntime(
          { ...dockerDescription, sessions: false },
          run,
        ),
      ),
      MAIN_BASH_DESCRIPTOR_JSON,
    );
    assertEquals(
      JSON.stringify(
        builtinToolDescriptorForRuntime(bashTool, dockerDescription, run),
      ),
      MAIN_BASH_DESCRIPTOR_JSON,
    );
  });

  if (SESSIONS_USABLE[mode]) {
    Deno.test(`the bash descriptor for a runtime with sessions adds \`session\` and nothing else under ${mode}`, () => {
      const descriptor = bashToolDescriptorForRuntime(runscDescription, run);
      const schema = descriptor.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
      };
      assertEquals(Object.keys(schema.properties), [
        "command",
        "cwd",
        "timeoutMs",
        "session",
      ]);
      assertEquals(schema.properties.session.type, "string");
      // One pattern, the runtime's: the schema the model reads and the check
      // the runtime makes cannot drift apart.
      assertEquals(
        schema.properties.session.pattern,
        SANDBOX_SESSION_NAME_PATTERN.source,
      );
      assertEquals(typeof schema.properties.session.description, "string");

      // Take `session` back out and what is left is main's descriptor.
      const { session: _session, ...mainProperties } = schema.properties;
      assertEquals(
        JSON.stringify({
          ...descriptor,
          inputSchema: {
            ...(descriptor.inputSchema as object),
            properties: mainProperties,
          },
        }),
        MAIN_BASH_DESCRIPTOR_JSON,
      );
      assertEquals(
        builtinToolDescriptorForRuntime(bashTool, runscDescription, run),
        descriptor,
      );
    });
  } else {
    Deno.test(`the bash descriptor for a runtime with sessions is main's, byte for byte, under ${mode}, which refuses every session`, () => {
      assertEquals(
        JSON.stringify(bashToolDescriptorForRuntime(runscDescription, run)),
        MAIN_BASH_DESCRIPTOR_JSON,
      );
      assertEquals(
        JSON.stringify(
          builtinToolDescriptorForRuntime(bashTool, runscDescription, run),
        ),
        MAIN_BASH_DESCRIPTOR_JSON,
      );
    });
  }
}

Deno.test("the descriptor a caller reads off the tool with no run in hand is main's", () => {
  assertEquals(JSON.stringify(bashToolDescriptor), MAIN_BASH_DESCRIPTOR_JSON);
  assertEquals(JSON.stringify(bashTool.descriptor), MAIN_BASH_DESCRIPTOR_JSON);
});

// --- what reaches the model -------------------------------------------------

const promptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "bash-session-descriptor" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "bash-session-descriptor",
  eventId: "event-bash-session-descriptor",
};

class FakeSandboxRuntime implements SandboxRuntime {
  constructor(readonly description: SandboxRuntimeDescription) {}

  describe(): SandboxRuntimeDescription {
    return this.description;
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

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/**
 * The tools of the one model request a run over `description` makes, in
 * `cfcEnforcementMode` when one is named and in the engine's default when not.
 */
const toolsSentToTheModel = async (
  description: SandboxRuntimeDescription,
  cfcEnforcementMode?: CfcEnforcementMode,
): Promise<Array<{ name?: string }>> => {
  const bodies: Array<{ tools?: Array<{ name?: string }> }> = [];
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(description),
    runId: `run-bash-descriptor-${description.kind}`,
    model: "gpt-5.4",
    ...(cfcEnforcementMode !== undefined ? { cfcEnforcementMode } : {}),
  });
  assertEquals(
    engine.getRunState().cfcEnforcementMode,
    cfcEnforcementMode ?? "enforce-strict",
  );
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["bash", "read_file"],
    fetchFn: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        new Response(
          JSON.stringify(responsesBodyFromChatFixture({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "done" },
            }],
          })),
          { status: 200 },
        ),
      );
    },
  });
  const result = await loop.runPrompt({
    prompt: "Say done.",
    promptSlotBinding,
  });
  assertEquals(result.runState.status, "completed");
  assertEquals(bodies.length, 1);
  return bodies[0].tools ?? [];
};

Deno.test("a run on a runtime without sessions sends the model main's bash tool", async () => {
  const tools = await toolsSentToTheModel(dockerDescription);
  assertEquals(tools.map((tool) => tool.name), ["bash", "read_file"]);
  assertEquals(JSON.stringify(tools[0]), MAIN_BASH_WIRE_TOOL_JSON);
});

Deno.test("a run on a runtime with sessions sends the model a bash tool that takes `session`", async () => {
  const withSessions = await toolsSentToTheModel(runscDescription, "observe");
  const without = await toolsSentToTheModel(dockerDescription, "observe");
  assertEquals(withSessions.map((tool) => tool.name), ["bash", "read_file"]);
  const bash = withSessions[0] as {
    parameters?: { properties?: Record<string, unknown> };
  };
  assertEquals(Object.keys(bash.parameters?.properties ?? {}), [
    "command",
    "cwd",
    "timeoutMs",
    "session",
  ]);
  assertNotEquals(JSON.stringify(bash), MAIN_BASH_WIRE_TOOL_JSON);
  // Only bash depends on the runtime.
  assertEquals(JSON.stringify(withSessions[1]), JSON.stringify(without[1]));
});

Deno.test("a run in the default mode on a runtime with sessions sends the model main's bash tool", async () => {
  // The default mode enforces, and an enforcing run can use no session: a
  // `session` offered here would be refused on every call.
  const tools = await toolsSentToTheModel(runscDescription);
  assertEquals(tools.map((tool) => tool.name), ["bash", "read_file"]);
  assertEquals(JSON.stringify(tools[0]), MAIN_BASH_WIRE_TOOL_JSON);
});
