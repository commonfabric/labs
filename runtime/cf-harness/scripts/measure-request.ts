#!/usr/bin/env -S deno run --allow-read

/**
 * Measure the first model request a batch run sends, for each task tag.
 *
 * Renders the openai-codex request body through
 * `OpenAICodexResponsesClient.complete()` with a capturing fetch, so the bytes
 * are exactly what the provider serializes. The tools are the ones a recorded
 * run was granted, through `builtinToolDescriptorForRuntime`; the system
 * prompt is `buildCfHarnessBatchSystemPrompt` for each tag; the context
 * messages are what `establishHarnessSessionContext` opens a fabric-backed run
 * with that holds loom commands and retrieval, fitted to the tag by
 * `orientContextMessages`; a run with attached patterns or client actions opens
 * with more than this measures. The host's own parts (its additional instructions,
 * result schema and grants message) and the task are copied from the recorded
 * run, so every tag is measured against one ask and only the tag differs.
 *
 * `fallback` is a run with no tags, which gets all of the guidance.
 *
 * Usage:
 *   deno run --allow-read scripts/measure-request.ts <recorded-artifact-dir>
 */

import { buildCfHarnessBatchSystemPrompt } from "../src/cli.ts";
import type { HarnessSubagentProfile } from "../src/contracts/subagent.ts";
import type { BuiltinToolId } from "../src/contracts/tool-descriptor.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { pieceTargetingContextMessages } from "../src/piece-targeting.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "../src/revision-verification.ts";
import { orientContextMessages } from "../src/session-assembly.ts";
import type { HarnessTaskTag } from "../src/task-classification.ts";
import { toolGuidanceContextMessages } from "../src/tool-guidance.ts";
import {
  BUILTIN_TOOLS,
  builtinToolDescriptorForRuntime,
} from "../src/tools/registry.ts";

const TAGS: readonly (HarnessTaskTag | "fallback")[] = [
  "respond",
  "find",
  "act",
  "pieces",
  "author",
  "fallback",
];

const ADDITIONAL = "\nAdditional instructions:\n";
const SCHEMA = "Result schema (JSON):\n";

const bytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

const readJson = (path: string): unknown =>
  JSON.parse(Deno.readTextFileSync(path));

/** The request body `complete()` sends for `transcript` and `tools`. */
const captureBody = async (
  transcript: HarnessTranscriptMessage[],
  tools: Parameters<OpenAICodexResponsesClient["complete"]>[0]["tools"],
): Promise<string> => {
  let body = "";
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: {
      resolve: () =>
        Promise.resolve({
          type: "oauth",
          providerId: "openai-codex",
          accessToken: "x",
          refreshToken: "x",
          expiresAt: Date.now() + 60_000,
          accountId: "acct",
        }),
    },
    fetchFn: (_input, init) => {
      body = String(init?.body);
      const completed = {
        type: "response.completed",
        response: {
          id: "r",
          status: "completed",
          output: [{
            type: "message",
            id: "m",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          }],
        },
      };
      return Promise.resolve(
        new Response(`data: ${JSON.stringify(completed)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  });
  await client.complete({
    model: "gpt-6.1-sol",
    transcript,
    tools,
    nativeModelToolIds: [],
    runId: "run-fixed",
  });
  return body;
};

/** One tag's first-request size, in bytes, by part of the request. */
export interface RequestSizeRow {
  tag: HarnessTaskTag | "fallback";
  toolsBytes: number;
  instructionsBytes: number;
  inputBytes: number;
  totalBytes: number;
}

/**
 * The first request a batch run sends for each tag, measured against the run
 * recorded in `dir`.
 */
export const measureRequest = async (
  dir: string,
): Promise<{ toolCount: number; rows: RequestSizeRow[] }> => {
  const policy = readJson(`${dir}/policy-snapshot.json`) as {
    parentTools: { allowedToolIds: BuiltinToolId[] };
    subagents: { allowedProfiles: HarnessSubagentProfile[] };
  };
  const recorded = readJson(`${dir}/transcript.json`) as {
    role: string;
    content: string;
  }[];
  const system = recorded[0].content;
  const additionalAt = system.indexOf(ADDITIONAL);
  const additional = additionalAt === -1
    ? undefined
    : system.slice(additionalAt + ADDITIONAL.length);
  const schemaAt = system.indexOf(SCHEMA);
  const schema = schemaAt === -1
    ? undefined
    : JSON.parse(system.slice(schemaAt + SCHEMA.length).split("\n")[0]);
  const grants = recorded.find((message) =>
    message.role === "user" && message.content.startsWith("Granted references")
  )?.content;
  const task = recorded.findLast((message, index) =>
    message.role === "user" &&
    (recorded[index + 1]?.role ?? "assistant") === "assistant"
  )!.content;
  const allowedToolIds = policy.parentTools.allowedToolIds;
  const tools = BUILTIN_TOOLS.filter((tool) =>
    allowedToolIds.includes(tool.descriptor.toolId)
  ).map((tool) =>
    builtinToolDescriptorForRuntime(tool, {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
    }, {
      cfcEnforcementMode: "enforce-explicit",
      browserHost: false,
      subagentProfiles: policy.subagents.allowedProfiles,
    })
  );
  const opened = [
    ...(grants !== undefined ? [grants] : []),
    ...pieceTargetingContextMessages([]),
    REVISION_VERIFICATION_GUIDANCE,
    ...toolGuidanceContextMessages({
      fabricSessionAvailable: true,
      loomCommandsAvailable: true,
      loomRetrievalAvailable: true,
    }),
  ];
  const rows: RequestSizeRow[] = [];
  for (const tag of TAGS) {
    const tags = tag === "fallback" ? undefined : new Set([tag]);
    const transcript: HarnessTranscriptMessage[] = [
      {
        role: "system",
        content: buildCfHarnessBatchSystemPrompt({
          ...(additional !== undefined ? { systemPrompt: additional } : {}),
          ...(schema !== undefined
            ? {
              structuredResult: {
                path: "/unused/agent-result.json",
                sandboxPath: "/workspace/agent-result.json",
                schema,
              },
            }
            : {}),
          allowedToolIds,
          // The parent is told about a pattern index when it may search one.
          ...(allowedToolIds.includes("search_patterns")
            ? { patternIndex: {} as never }
            : {}),
          ...(tags !== undefined ? { taskTags: tags } : {}),
        }),
      },
      ...orientContextMessages(opened, {
        ...(tags !== undefined ? { tags } : {}),
        depth: "standard",
      }).map((content) => ({ role: "user" as const, content })),
      { role: "user", content: task },
    ];
    const body = await captureBody(transcript, tools);
    const parsed = JSON.parse(body);
    rows.push({
      tag,
      toolsBytes: bytes(JSON.stringify(parsed.tools)),
      instructionsBytes: bytes(parsed.instructions),
      inputBytes: bytes(JSON.stringify(parsed.input)),
      totalBytes: bytes(body),
    });
  }
  return { toolCount: tools.length, rows };
};

/**
 * The command line: measures the run recorded in the one directory `args`
 * names and logs the rows as JSON, or its usage as an error. Returns the exit
 * code.
 */
export const main = async (
  args: readonly string[],
  out: Pick<Console, "log" | "error">,
): Promise<number> => {
  if (args.length !== 1) {
    out.error("usage: measure-request.ts <recorded-artifact-dir>");
    return 2;
  }
  out.log(JSON.stringify(await measureRequest(args[0]), null, 1));
  return 0;
};

if (import.meta.main) Deno.exit(await main(Deno.args, console));
