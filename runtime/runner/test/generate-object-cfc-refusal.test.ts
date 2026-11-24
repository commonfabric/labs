/**
 * A generateObject request whose staging commit CFC refuses.
 *
 * The builtin stages its request state — the pending flag, the request hash a
 * later run recognizes — in the transaction that schedules the work, and sends
 * the request once that transaction commits. Under the strict dials a refusal
 * of that commit is an ordinary runtime event, and these tests pin what the
 * builtin does with one: it settles, once, with the refusal as its error, and
 * the request it could not send is staged once rather than once per retry.
 */

import { expect } from "@std/expect";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { BuiltInLLMTool } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  enableMockMode,
  setMockResponseGate,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
} from "../src/runtime-presets.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

// A caveat the generateObject sink is not cleared for. The builtin reads the
// messages carrying it, so the request it stages carries it too, and the
// ceiling declared for that sink below admits none — the sink-request refusal
// of §8.12.4, which rejects at `enforce-strict`.
const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

const RESULT_SCHEMA: JSONSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

describe("generateObject under a refused commit", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];
  let requestsSent: number;

  beforeEach(() => {
    clearMockResponses();
    requestsSent = 0;
    setMockResponseGate(() => {
      requestsSent += 1;
      return Promise.resolve();
    });
    storageManager = StorageManager.emulate({ as: signer });
    // The max-enforcement posture, raised to strict — the posture the
    // writer-fit rule rejects under.
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      // The bundle pins every staged dial; the enforcement mode is the
      // per-session raise on top of it, and the bundle's persisted flow labels
      // are what make that raise conform.
      cfcEnforcementMode: "enforce-strict",
      // The bundle declares a ceiling for the fetch and streamData sinks and
      // none for the LLM ones, so an LLM request is ungated on
      // confidentiality there. These cases are about the ENDING a refused
      // request leaves behind, so they declare the ceiling the refusal comes
      // from. Before the runtime's own stores declared what flowed into them,
      // the refusal arrived by accident instead: the builtin's result store
      // could not hold the caveat, so the transaction staging the request was
      // refused for a reason about the store rather than about the request.
      cfcSinkMaxConfidentiality: {
        ...MAX_ENFORCEMENT_SINK_CEILINGS,
        llm: [],
        llmDialog: [],
        generateText: [],
        generateObject: [],
      },
    });
    tx = runtime.edit();
    ({ commonfabric } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    setMockResponseGate(undefined);
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Run a generateObject with one pattern tool over messages carrying
   * {@link PROMPT_INFLUENCE}, and hand back the cell the pattern exposes.
   */
  // deno-lint-ignore no-explicit-any
  function runRefusedRequest(cause: string): Cell<any> {
    const { pattern, generateObject, patternTool, Cell: BuilderCell } =
      commonfabric;
    const helperPattern = pattern(
      () => ({ ok: true }),
      { type: "object", additionalProperties: false },
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    );
    const testPattern = pattern<Record<string, never>>(() => {
      const briefing = BuilderCell.of([{
        role: "user",
        content: "a briefing the result store does not declare",
      }], {
        type: "array",
        items: { type: "object", additionalProperties: true },
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      return generateObject({
        messages: briefing,
        schema: RESULT_SCHEMA,
        tools: {
          helper: {
            description: "A tool the model never gets to call.",
            ...(patternTool(helperPattern) as unknown as BuiltInLLMTool),
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
    });

    const resultCell = runtime.getCell(
      space,
      cause,
      testPattern.resultSchema,
      tx,
    );
    return runtime.run(tx, testPattern, {}, resultCell);
  }

  it("settles with a refusal error that withholds the rule's detail", async () => {
    const result = runRefusedRequest("generateObject-cfc-refusal-settles");
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;

    await waitForLlmSettled(runtime, result);
    // The settle writeback is tracked async builtin work, which `idle()` — and
    // so the wait above — deliberately does not span. Reading after it lands
    // asserts the durable state rather than an optimistic local write whose
    // commit is still racing the teardown.
    await runtime.settled();
    const settled = result.withTx().get() as {
      pending?: boolean;
      error?: string;
      result?: unknown;
      messages?: unknown;
    };

    expect(settled.pending).toBe(false);
    expect(settled.error).toBe(
      "generateObject request was refused before it started",
    );
    // The rule's own reason names the sink, the confidentiality that exceeded
    // its ceiling, and the `source` of each caveat — the principal that
    // introduced it, which the pattern-facing surface withholds (inv-12 /
    // audit 28b). The refusal reaches the operator through the log instead.
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.kind);
    // A refused request produces no answer and no record of a conversation:
    // the post-commit outbox is cleared by the refusal, so nothing was sent and
    // no receipt stands for a request that never ran.
    expect(settled.result).toBeUndefined();
    expect(settled.messages).toBeUndefined();
    expect(requestsSent).toBe(0);
  });

  it("reports the abandoned request once however many attempts are made", async () => {
    runtime.scheduler.setActionRunTraceEnabled(true);
    const abandoned: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes("was abandoned before it started")) {
        abandoned.push(String(args[0]));
        return;
      }
      // Everything else still reaches the console, including the two reports
      // this path adds, so a real failure here is not swallowed by the capture.
      realConsoleError(...args);
    };
    try {
      const result = runRefusedRequest("generateObject-cfc-refusal-run-count");
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;

      await waitForLlmSettled(runtime, result);
      await runtime.settled();

      const builtinRuns = runtime.scheduler.getActionRunTrace().filter((
        entry,
      ) => entry.actionId.includes("generateObject"));
      // The scheduler keeps attempting a refused commit, because a refusal
      // does not say whether the next attempt would fare better: CFC
      // enforcement refuses one both for a verdict on the data and for
      // metadata this replica has not read yet. So the action runs more than
      // once here, and the bound on how many times is the scheduler's retry
      // budget rather than anything this builtin decides.
      expect(builtinRuns.length).toBeGreaterThan(1);
      expect(builtinRuns.length).toBeLessThanOrEqual(
        MAX_RETRIES_FOR_REACTIVE + 2,
      );
      // The request is one request across all of those attempts, so it is
      // abandoned once, not once per attempt.
      expect(abandoned.length).toBe(1);
    } finally {
      console.error = realConsoleError;
    }
  });
});
