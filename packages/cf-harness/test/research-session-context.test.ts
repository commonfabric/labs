import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Database } from "@db/sqlite";

import type { HarnessCfcModelContext } from "../src/contracts/cfc-model-context.ts";
import type { HarnessResearchRunSummary } from "../src/contracts/research.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  annotateHarnessUserResultOmissions,
  createHarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type { CreateHarnessPromptLoopOptions } from "../src/prompt-loop.ts";
import { createHarnessRunState } from "../src/run-state.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";

const resultRecord: HarnessResearchRunSummary = {
  type: "cf-harness.research-run",
  researchRunId: "earlier-research",
  outputId: "earlier-research",
  completedAt: "2026-09-16T00:00:00Z",
  kit: {
    purpose: "answer",
    status: "complete",
    task: "Which data shape?",
    summary: "The input is a typed collection.",
    inputs: [{
      name: "mail",
      token: "cfh:a:earlier",
      purpose: "Earlier input",
    }],
    patterns: [],
    rules: [],
    sources: [],
    missing: [],
  },
  confirmedPatterns: [],
  describedHandles: [],
};
const cfc: HarnessCfcModelContext = {
  type: "cf-harness.cfc-model-context",
  version: 1,
  updatedAt: "2026-09-16T00:00:00Z",
  label: { confidentiality: ["retained-influence"] },
  observations: [],
};

describe("research session context", () => {
  it("commits findings with history, restores their CFC, and treats earlier bindings as historical", async () => {
    const root = await Deno.makeTempDir();
    let store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(join(root, "chat.sqlite")),
    });
    const optionsSeen: CreateHarnessPromptLoopOptions[] = [];
    const tasks: (string | undefined)[] = [];
    let fail = false;
    const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
      optionsSeen.push(options);
      return {
        runTranscript: (request) => {
          tasks.push(request.openingResearchTask);
          if (fail) {
            return Promise.reject(new Error("turn failed before commit"));
          }
          return Promise.resolve({
            model: "gpt-test",
            modelTurns: 1,
            finalAssistantText: "Done",
            transcript: [...request.transcript, {
              role: "assistant",
              content: "Done",
            }],
            runState: createHarnessRunState({
              runId: options.runId,
              currentDir: "/workspace",
              cfcEnforcementMode: "enforce-explicit",
              researchRuns: [resultRecord],
              cfcModelContext: cfc,
            }),
          });
        },
      };
    };
    try {
      let service = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop,
      });
      expect(
        (await service.startSession("start", {
          sessionId: "session",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        })).ok,
      ).toBe(true);
      expect(
        (await service.startTurn("first", {
          sessionId: "session",
          turnId: "first",
          input: { text: "Find the data contract" },
        })).ok,
      ).toBe(true);
      await service.waitForTurn("session", "first");
      const checkpoint = store.getSession("session");
      expect(checkpoint?.researchContext).toEqual({
        researchGoal: "Find the data contract",
        runs: [resultRecord],
        cfcModelContext: cfc,
      });
      expect(optionsSeen[0].inheritedResearchRuns).toBeUndefined();
      expect(optionsSeen[0].taskText).toBe("Find the data contract");
      expect(optionsSeen[0].researchGoal).toBe("Find the data contract");
      store.close();
      store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(join(root, "chat.sqlite")),
      });
      service = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop,
      });
      await service.initializeFromStore();
      fail = true;
      expect(
        (await service.startTurn("second", {
          sessionId: "session",
          turnId: "second",
          input: { text: "Does the same contract support a filter?" },
        })).ok,
      ).toBe(true);
      await service.waitForTurn("session", "second");
      expect(optionsSeen[1].inheritedResearchRuns).toEqual([{
        ...resultRecord,
        historical: true,
      }]);
      expect(optionsSeen[1].inheritedCfcModelContext).toEqual(cfc);
      expect(optionsSeen[1].taskText).toBe(
        "Does the same contract support a filter?",
      );
      expect(optionsSeen[1].researchGoal).toBe("Find the data contract");
      expect(tasks).toEqual([
        "Find the data contract",
        undefined,
      ]);
      expect(store.getSession("session")?.researchContext).toEqual(
        checkpoint?.researchContext,
      );
      expect(store.getSession("session")?.transcript).toEqual(
        checkpoint?.transcript,
      );
      fail = false;
      await service.startTurn("third", {
        sessionId: "session",
        turnId: "third",
        input: { text: "Which component can render it?" },
      });
      await service.waitForTurn("session", "third");
      expect(optionsSeen[2].taskText).toBe("Which component can render it?");
      expect(optionsSeen[2].researchGoal).toBe("Find the data contract");
      expect(store.getSession("session")?.researchContext?.researchGoal).toBe(
        "Find the data contract",
      );
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("requests orientation when a previous turn retained no research findings", async () => {
    const tasks: (string | undefined)[] = [];
    const service = new HarnessInteractiveChatService({
      createPromptLoop: (options) => ({
        runTranscript: (request) => {
          tasks.push(request.openingResearchTask);
          return Promise.resolve({
            model: "gpt-test",
            modelTurns: 1,
            finalAssistantText: "Done",
            transcript: [...request.transcript],
            runState: createHarnessRunState({
              runId: options.runId,
              currentDir: "/workspace",
              cfcEnforcementMode: "enforce-explicit",
            }),
          });
        },
      }),
    });
    await service.startSession("start", {
      sessionId: "empty",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
    });
    for (const turn of ["First", "Second"]) {
      await service.startTurn(turn, {
        sessionId: "empty",
        turnId: turn,
        input: { text: turn },
      });
      await service.waitForTurn("empty", turn);
    }
    expect(tasks).toEqual(["First", "Second"]);
  });

  it("retains omission joins through SQLite restart without putting private metadata into model messages", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    const message = annotateHarnessUserResultOmissions({
      role: "user",
      content: "Host research findings: the current input is available.",
      toolResultProvenance: {
        type: "cf-harness.tool-result-provenance",
        toolCallId: "opening-research:previous",
        toolId: "research",
        outputId: createToolOutputId("previous", "research", 1),
      },
    }, [{
      rule: "artifact-only",
      locations: [{
        artifactPath: "/artifacts/previous/research.json",
        jsonPointer: "/researchRecord",
      }],
    }]);
    const expected = createHarnessTranscriptOmissions([message]);
    try {
      const service = new HarnessInteractiveChatService({
        sessionStore: store,
      });
      await service.startSession("start", {
        sessionId: "omissions",
        workspace: { hostPath: "/workspace" },
        model: "gpt-test",
      });
      const snapshot = store.getSession("omissions")!;
      store.saveSession({ ...snapshot, transcript: [message] });
      store.close();
      store = await openSqliteHarnessChatSessionStore({ url });
      const restored = store.getSession("omissions")!;
      expect(createHarnessTranscriptOmissions(restored.transcript)).toEqual(
        expected,
      );
      expect(JSON.stringify(restored.transcript)).toBe(
        JSON.stringify([message]),
      );
      expect(JSON.stringify(restored.transcript)).not.toContain(
        "researchRecord",
      );
      store.saveSession(restored);
      expect(
        createHarnessTranscriptOmissions(store.listSessions()[0].transcript),
      ).toEqual(expected);
      store.database.prepare(
        "UPDATE chat_session SET transcript_omissions = ? WHERE session_id = ?",
      ).run(
        JSON.stringify({
          ...expected,
          results: [{ ...expected.results[0], outputId: "unrelated-result" }],
        }),
        "omissions",
      );
      expect(() => store.getSession("omissions")).toThrow(
        "Stored transcript omissions do not match their result",
      );
      store.database.exec(
        "UPDATE chat_session SET transcript_omissions = '{}'",
      );
      expect(() => store.listSessions()).toThrow(
        "Stored transcript omissions have an invalid format",
      );
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("opens a legacy SQLite checkpoint without replacing its transcript", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    try {
      const service = new HarnessInteractiveChatService({
        sessionStore: store,
      });
      await service.startSession("start", {
        sessionId: "legacy",
        workspace: { hostPath: "/workspace" },
        model: "gpt-test",
      });
      const before = store.getSession("legacy");
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN research_context",
      );
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN assigned_pieces",
      );
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN transcript_omissions",
      );
      store.close();
      store = await openSqliteHarnessChatSessionStore({ url });
      expect(store.getSession("legacy")).toEqual(before);
      expect(store.getSession("legacy")?.researchContext).toBeUndefined();
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rolls back session context columns when a later migration fails", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    const store = await openSqliteHarnessChatSessionStore({ url });
    try {
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN research_context",
      );
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN assigned_pieces",
      );
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN transcript_omissions",
      );
      store.close();
      const exec = Database.prototype.exec;
      {
        using _fault = stub(
          Database.prototype,
          "exec",
          function (this: Database, ...args: Parameters<Database["exec"]>) {
            if (
              args[0] ===
                "ALTER TABLE chat_session ADD COLUMN transcript_omissions TEXT"
            ) {
              throw new Error("migration refused");
            }
            return exec.apply(this, args);
          },
        );
        await expect(openSqliteHarnessChatSessionStore({ url })).rejects
          .toThrow("migration refused");
      }
      const database = await new Database(url);
      try {
        const columns = database.prepare("PRAGMA table_info(chat_session)")
          .all() as { name: string }[];
        expect(columns.map((column) => column.name)).toEqual([
          "session_id",
          "status",
          "transcript",
          "created_at",
          "updated_at",
          "closed_at",
        ]);
      } finally {
        database.close();
      }
      const reopened = await openSqliteHarnessChatSessionStore({ url });
      reopened.close();
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("holds the SQLite write lock while inspecting and migrating legacy columns", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    const contender = await new Database(url);
    contender.exec("PRAGMA busy_timeout = 0");
    try {
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN research_context",
      );
      store.database.exec(
        "ALTER TABLE chat_session DROP COLUMN transcript_omissions",
      );
      store.close();
      const prepare = Database.prototype.prepare;
      const lockResults: string[] = [];
      {
        using _probe = stub(
          Database.prototype,
          "prepare",
          function (this: Database, sql: string) {
            if (sql === "PRAGMA table_info(chat_session)") {
              try {
                contender.exec("BEGIN IMMEDIATE");
                contender.exec("ROLLBACK");
                lockResults.push("acquired");
              } catch (error) {
                lockResults.push(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
            return prepare.call(this, sql);
          },
        );
        store = await openSqliteHarnessChatSessionStore({ url });
        expect(lockResults).toEqual([
          expect.stringContaining("database is locked"),
        ]);
      }
      expect(store.database.prepare("PRAGMA table_info(chat_session)").all())
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "research_context" }),
            expect.objectContaining({ name: "transcript_omissions" }),
          ]),
        );
      expect(() => contender.exec("BEGIN IMMEDIATE; ROLLBACK;")).not.toThrow();
    } finally {
      contender.close();
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });
});
