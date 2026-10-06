/** The book pattern stages live input handles without requiring a model host. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { NormalizedFullLink } from "@commonfabric/runner";
import {
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { AgentResultSchema } from "../../runner/src/builtins/agent-schemas.ts";
import { seedHomeAgentQueue } from "../../runner/test/support/agent-queue.ts";
import { runTestPattern } from "../../cli/lib/test-runner.ts";

type State = {
  run?: unknown;
  pending?: boolean;
  error?: string;
  requestHash?: string;
};

const PATTERNS = fromFileUrl(new URL("../", import.meta.url));

describe("book agent input handles", () => {
  it("queues the original book cells and replaces the request when the list changes", async () => {
    const identity = await Identity.fromPassphrase("book input handles");
    const storageManager = StorageManager.emulate({ as: identity });
    const previousAgent = Deno.env.get("EXPERIMENTAL_AGENT_BUILTIN");
    const previousServer = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
    let instance: NormalizedFullLink | undefined;
    try {
      Deno.env.set("EXPERIMENTAL_AGENT_BUILTIN", "true");
      Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", "false");
      const fixture = join(
        PATTERNS,
        "integration/fixtures/agent-book-inputs.tsx",
      );
      const result = await runTestPattern(fixture, {
        root: PATTERNS,
        patternCoverageDir: Deno.env.get("CF_PATTERN_COVERAGE_DIR"),
        storageHost: {
          identity,
          storageManager,
          onPatternInstantiated: (value) => {
            if (value.main?.endsWith("/book-recommendations/main.tsx")) {
              instance = value.cell;
            }
          },
          beforeAssertions: async (runtime) => {
            expect(instance).toBeDefined();
            const reader = runtime.getCellFromLink(instance!);
            const first = runtime.getCell(identity.did(), "first book", {
              type: "object",
              properties: {
                title: { type: "string" },
                author: { type: "string" },
              },
            });
            const second = runtime.getCell(
              identity.did(),
              "second book",
              first.schema,
            );
            await runtime.editWithRetry((tx) => {
              seedHomeAgentQueue(runtime, identity.did(), tx);
              first.withTx(tx).set({
                title: "Solaris",
                author: "Stanisław Lem",
              });
              second.withTx(tx).set({
                title: "Kindred",
                author: "Octavia E. Butler",
              });
              reader.key("finishedBooks").withTx(tx).set([first]);
              reader.key("favoriteAuthors").withTx(tx).set([
                "Octavia E. Butler",
              ]);
            });
            const state = reader.key("recommendation").asSchema(
              AgentResultSchema,
            );
            const initial = await waitForCellValue<State>(
              runtime,
              state,
              (value) => value?.run !== undefined,
              {
                stuckLabel:
                  "the book pattern stages its original input handles",
              },
            );
            expect(initial.error).toBeUndefined();
            const initialHash = initial.requestHash;
            expect(initialHash).toEqual(expect.any(String));
            const original = state.key("run").asSchema<AgentRunRecord>(
              AgentRunRecordSchema,
            ).get();
            expect(original.state).toBe("queued");
            expect(original.tools).toEqual(["loom_search", "loom_page_read"]);
            expect(Object.keys(original.inputs).sort()).toEqual([
              "book_0",
              "favoriteAuthors",
              "finishedBooks",
            ]);
            expect(original.inputs.book_0.equals(first)).toBe(true);
            expect(
              original.inputs.finishedBooks.equals(reader.key("finishedBooks")),
            ).toBe(true);
            expect(
              original.inputs.favoriteAuthors.equals(
                reader.key("favoriteAuthors"),
              ),
            ).toBe(true);
            await runtime.editWithRetry((tx) =>
              reader.key("finishedBooks").withTx(tx).set([second])
            );
            const updated = await waitForCellValue<State>(
              runtime,
              state,
              (value) =>
                value?.run !== undefined &&
                value.requestHash !== initialHash,
              {
                stuckLabel: "the book pattern stages its updated input handles",
              },
            );
            expect(updated.error).toBeUndefined();
            expect(updated.requestHash).not.toBe(initialHash);
            const replacement = state.key("run").asSchema<AgentRunRecord>(
              AgentRunRecordSchema,
            ).get();
            expect(replacement.state).toBe("queued");
            expect(replacement.inputs.book_0.equals(second)).toBe(true);
            expect(replacement.inputs.book_0.equals(first)).toBe(false);
            expect(original.inputs.book_0.get()).toEqual({
              title: "Solaris",
              author: "Stanisław Lem",
            });
          },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.results).toHaveLength(1);
      expect(result.results[0].passed).toBe(true);
      expect(result.consoleErrors).toEqual([]);
      expect(result.consoleWarnings).toEqual([]);
      expect(result.nonIdempotent).toEqual([]);
    } finally {
      if (previousAgent === undefined) {
        Deno.env.delete("EXPERIMENTAL_AGENT_BUILTIN");
      } else Deno.env.set("EXPERIMENTAL_AGENT_BUILTIN", previousAgent);
      if (previousServer === undefined) {
        Deno.env.delete("EXPERIMENTAL_SERVER_EXECUTION");
      } else Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", previousServer);
      await storageManager.close();
    }
  });
});
