import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { assignSlug, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { entityIdFrom, Runtime, slugIdForSpace } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { parseCfHarnessCliArgs } from "../../src/cli.ts";
import { PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS } from "../../src/contracts/subagent.ts";
import {
  parentToolIdsForBacking,
  withheldToolIds,
} from "../../src/contracts/tool-descriptor.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { resolveHandleToken } from "../../src/handle-table.ts";
import { PIECE_TARGETING_GUIDANCE } from "../../src/piece-targeting.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import { getBuiltinTool } from "../../src/tools/registry.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "../support/responses-fixture.ts";

const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

const backing = {
  fabricSessionAvailable: true,
  patternIndexAvailable: false,
  skillsShSearchAvailable: false,
  skillsShAcquisitionAvailable: false,
  skillRegistryAvailable: false,
  docsCorpusAvailable: false,
};

const source = `import { pattern } from "commonfabric";
export default pattern<Record<string, never>>(() => ({
  $NAME: "People mail 2026-09 (49)",
  privateNote: "source-and-values-stay-in-fabric",
  count: 49,
}));`;

describe("resolve-piece", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let pieceId: string;
  let engine: CfHarnessEngine;
  const spaceName = "resolve-piece-test";

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("resolve-piece-test");
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      runtime,
    );
    await pieces.synced();
    const piece = await pieces.create(source, { input: {} });
    pieceId = piece.id;
    await assignSlug(pieces, piece.getCell(), "recent-emails");
    await pieces.synced();
    engine = new CfHarnessEngine({
      runId: `resolve-piece-${crypto.randomUUID()}`,
      model: "gpt-5.4",
      sandboxRuntime: sandbox,
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
  });

  for (const slug of ["recent-emails", `pattern:${spaceName}/recent-emails`]) {
    it(`resolves ${slug} to the piece despite its different display name`, async () => {
      const { output } = await engine.invokeBuiltinTool("resolve_piece", {
        slug,
      });
      expect(output).toEqual({
        outputId: expect.any(String),
        status: "ok",
        resultRef: `/of:${pieceId}`,
      });
      expect(engine.getRunState().failureRecords).toEqual([]);
    });
  }

  it("refuses a foreign space even when the local space holds that slug", async () => {
    const { output } = await engine.invokeBuiltinTool("resolve_piece", {
      slug: "pattern:other-space/recent-emails",
    });
    expect(output).toMatchObject({ status: "error", code: "foreign-space" });
    expect(output).not.toHaveProperty("resultRef");
    expect(engine.getRunState().failureRecords).toEqual([]);
  });

  it("returns an actionable missing-slug result without failing the run", async () => {
    const { output } = await engine.invokeBuiltinTool("resolve_piece", {
      slug: "unheld-piece",
    });
    expect(output).toMatchObject({ status: "error", code: "not-found" });
    expect(output).not.toHaveProperty("resultRef");
    expect(engine.getRunState().failureRecords).toEqual([]);
    expect(engine.getRunState().status).not.toBe("failed");
  });

  for (const target of ["malformed", "not-piece", "inside-piece"]) {
    it(`returns an actionable not-found result for a readable ${target} target`, async () => {
      if (target === "malformed") {
        const slugCell = runtime.getCellFromEntityId(
          pieces.getSpace(),
          entityIdFrom(slugIdForSpace(pieces.getSpace(), target)),
        );
        await runtime.editWithRetry((tx) => {
          slugCell.withTx(tx).setRawUntyped("not a redirect");
        });
      } else if (target === "not-piece") {
        const plain = runtime.getCell(pieces.getSpace(), { target });
        await runtime.editWithRetry((tx) => {
          plain.withTx(tx).set({ value: 1 });
        });
        await setSlugLink(pieces, target, plain);
      } else {
        const piece = await pieces.get(pieceId);
        await setSlugLink(pieces, target, piece.getCell().key("count"));
      }
      const { output } = await engine.invokeBuiltinTool("resolve_piece", {
        slug: target,
      });
      expect(output).toMatchObject({ status: "error", code: "not-found" });
      expect(output).not.toHaveProperty("resultRef");
      expect(engine.getRunState().failureRecords).toEqual([]);
    });
  }

  for (
    const slug of [
      "Recent Emails",
      "pattern:other/",
      `/of:${"A".repeat(43)}`,
      "piece:test/recent-emails",
    ]
  ) {
    it(`refuses the non-slug address ${slug}`, async () => {
      const { output } = await engine.invokeBuiltinTool("resolve_piece", {
        slug,
      });
      expect(output).toMatchObject({
        status: "error",
        code: "invalid-address",
      });
    });
  }

  it("reports unavailable when the session cannot be opened without exposing its error", async () => {
    const unavailable = new CfHarnessEngine({
      sandboxRuntime: sandbox,
      fabricSessionFactory: () =>
        Promise.reject(new Error("private session failure")),
    });
    const { output } = await unavailable.invokeBuiltinTool("resolve_piece", {
      slug: "recent-emails",
    });
    expect(output).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(output)).not.toContain("private session failure");
  });

  it("keeps a failed address read distinct from an absent slug", async () => {
    using _read = stub(runtime, "getCellFromEntityId", () => {
      throw new Error("private storage failure");
    });
    const { output } = await engine.invokeBuiltinTool("resolve_piece", {
      slug: "recent-emails",
    });
    expect(output).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(output)).not.toContain("private storage failure");
  });

  it("refuses a qualified address when the session has no space name to check", async () => {
    using _name = stub(pieces, "getSpaceName", () => undefined);
    const { output } = await engine.invokeBuiltinTool("resolve_piece", {
      slug: `pattern:${spaceName}/recent-emails`,
    });
    expect(output).toMatchObject({ status: "error", code: "unavailable" });
    expect(output).not.toHaveProperty("resultRef");
    expect(
      (await engine.invokeBuiltinTool("resolve_piece", {
        slug: "recent-emails",
      })).output,
    )
      .toMatchObject({ status: "ok", resultRef: `/of:${pieceId}` });
  });

  it("refuses a non-string slug from an untyped caller", async () => {
    const { output } = await engine.invokeBuiltinTool(
      "resolve_piece",
      JSON.parse('{"slug":null}'),
    );
    expect(output).toMatchObject({ status: "error", code: "invalid-address" });
  });

  it("withholds resolution without a Fabric backing and keeps source tools child-only", async () => {
    const absent = { ...backing, fabricSessionAvailable: false };
    expect(parentToolIdsForBacking(backing)).toContain("resolve_piece");
    expect(parentToolIdsForBacking(absent)).not.toContain("resolve_piece");
    expect(withheldToolIds(absent).has("resolve_piece")).toBe(true);
    expect(parentToolIdsForBacking(backing)).not.toContain("read_piece_source");
    expect(PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS).not.toContain(
      "resolve_piece",
    );
    expect(getBuiltinTool("resolve_piece")?.descriptor.effectClass).toBe(
      "read",
    );
    const unbacked = new CfHarnessEngine({ sandboxRuntime: sandbox });
    expect(
      (await unbacked.invokeBuiltinTool("resolve_piece", {
        slug: "recent-emails",
      })).output,
    )
      .toMatchObject({ status: "error", code: "unavailable" });
  });

  it("requires the Fabric flags when explicitly allowed on the CLI", async () => {
    await expect(
      parseCfHarnessCliArgs([
        "--prompt",
        "revise recent-emails",
        "--allow-tool",
        "resolve_piece",
      ], {}),
    )
      .rejects.toThrow("requires a fabric session");
    const parsed = await parseCfHarnessCliArgs([
      "--prompt",
      "revise recent-emails",
      "--allow-tool",
      "resolve_piece",
      "--fabric-api-url",
      "http://toolshed.test",
      "--fabric-space",
      spaceName,
      "--fabric-identity",
      "/tmp/resolve-piece-test.key",
    ], {});
    if ("help" in parsed) throw new Error("expected a runnable CLI config");
    expect(parsed.allowedToolIds).toContain("resolve_piece");
  });

  for (const continued of [false, true]) {
    it(`returns only a usable handle to the parent in a ${continued ? "continued" : "fresh"} unattached conversation`, async () => {
      const requests: unknown[] = [];
      const loop = new CfHarnessPromptLoop({
        apiKey: "fixture-key",
        engine,
        fetchFn: (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          const payload = requests.length === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "resolve-target",
                    type: "function",
                    function: {
                      name: "resolve_piece",
                      arguments: JSON.stringify({ slug: "recent-emails" }),
                    },
                  }],
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: { role: "assistant", content: "Target resolved." },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload)),
              { status: 200 },
            ),
          );
        },
      });
      const transcript: HarnessTranscriptMessage[] = [
        { role: "system", content: PIECE_TARGETING_GUIDANCE },
        ...(continued
          ? [
            { role: "user" as const, content: "make that list shorter" },
            {
              role: "assistant" as const,
              content: "Which list? Please provide its exact name.",
            },
          ]
          : []),
        {
          role: "user",
          content: continued
            ? "the recent-emails one"
            : "change my recent-emails list so it only shows the last week",
        },
      ];
      const result = await loop.runTranscript({
        transcript,
        promptSlotBinding: directPromptSlotBindingFor("resolve-piece"),
      });
      const delivered = chatViewOfRequest(requests[1]).messages.find((
        message,
      ) => message.tool_call_id === "resolve-target");
      const output = JSON.parse(delivered!.content);
      expect(output).toEqual({
        outputId: expect.any(String),
        status: "ok",
        resultRef: expect.stringMatching(/^cfh:a:/),
      });
      expect(resolveHandleToken(engine.handleTable!, output.resultRef)?.ref)
        .toBe(`/of:${pieceId}`);
      expect(JSON.stringify(requests)).not.toContain(pieceId);
      expect(JSON.stringify(requests)).not.toContain(
        "source-and-values-stay-in-fabric",
      );
      expect(
        result.transcript.filter((message) => message.role === "tool").map((
          message,
        ) => message.toolName),
      )
        .toEqual(["resolve_piece"]);
      expect(result.runState.inputCells).toBeUndefined();
      expect(chatViewOfRequest(requests[0]).tools).toContain("resolve_piece");
      expect(chatViewOfRequest(requests[0]).tools).not.toContain(
        "read_piece_source",
      );
    });
  }
});
