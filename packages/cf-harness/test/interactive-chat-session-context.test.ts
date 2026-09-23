/**
 * What an interactive turn opens with.
 *
 * A turn is its own run with its own handle table, so the references that run
 * holds — the well-known grants of its space, the input cells and published
 * patterns the request attached — have to be established and announced per
 * turn. Without that a
 * console session had a fabric session it could not explore and no way to be
 * handed a cell at all, which is what these tests are about.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import type { HarnessInputCellSpec } from "../src/contracts/input-cells.ts";
import type {
  HarnessPatternRef,
  HarnessPatternRefSpec,
} from "../src/contracts/pattern-refs.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import type { CfHarnessEngine } from "../src/engine.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "../src/revision-verification.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";

/**
 * An engine that reports what a fabric-configured run establishes, without
 * building a runtime or a sandbox to establish it against. What the service
 * does with the answers is the subject here; that the real engine mints those
 * tokens is `engine.test.ts`'s.
 */
const stubEngine = (
  established: {
    inputCells: readonly HarnessInputCellSpec[];
    patternRefs?: readonly HarnessPatternRef[];
    unknownPatternId?: string;
  },
): CfHarnessEngine =>
  ({
    config: { fabricSession: { space: "context-space" } },
    fabricSessionAvailable: true,
    startRun: () => undefined,
    failRun: () => Promise.resolve(),
    establishWellKnownGrants: () =>
      Promise.resolve([{ name: "piece-registry", token: "cfh:a:grant" }]),
    establishInputCells: () =>
      Promise.resolve(
        established.inputCells.map((cell, index) => ({
          name: cell.name,
          ref: cell.ref,
          token: `cfh:a:cell${index}`,
        })),
      ),
    establishPatternRefs: () =>
      established.unknownPatternId === undefined
        ? Promise.resolve(established.patternRefs ?? [])
        : Promise.reject(
          new Error(
            `patternRefs \`${established.unknownPatternId}\` is not in the pattern index`,
          ),
        ),
  }) as unknown as CfHarnessEngine;

const recordingLoop = (
  seen: HarnessTranscriptMessage[][],
): HarnessInteractivePromptLoopFactory =>
() => ({
  runTranscript: (options: RunHarnessTranscriptOptions) => {
    seen.push([...options.transcript]);
    return Promise.resolve(
      {
        model: options.model ?? "gpt-test",
        finalAssistantText: "done",
        transcript: [
          ...options.transcript,
          { role: "assistant", content: "done" },
        ],
        modelTurns: 1,
      } as HarnessPromptLoopResult,
    );
  },
});

const runTurn = async (
  service: HarnessInteractiveChatService,
  turnId: string,
  text: string,
  inputCells?: readonly HarnessInputCellSpec[],
  patternRefs?: readonly HarnessPatternRefSpec[],
): Promise<void> => {
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: `req-${turnId}`,
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId,
      input: { text },
      ...(inputCells !== undefined ? { inputCells } : {}),
      ...(patternRefs !== undefined ? { patternRefs } : {}),
    },
  });
  await service.waitForTurn("session-1", turnId);
};

const startedService = async (
  seen: HarnessTranscriptMessage[][],
  established?: {
    inputCells: readonly HarnessInputCellSpec[];
    patternRefs?: readonly HarnessPatternRef[];
    unknownPatternId?: string;
  },
): Promise<HarnessInteractiveChatService> => {
  const service = new HarnessInteractiveChatService({
    ...(established === undefined ? {} : {
      basePromptLoopOptions: { engine: stubEngine(established) },
    }),
    createPromptLoop: recordingLoop(seen),
  });
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-session",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
    },
  });
  return service;
};

describe("interactive chat session context", () => {
  it("supplies target-selection context to an unconfigured interactive turn", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen);
    await runTurn(
      service,
      "turn-unconfigured",
      "add a total to this bills pane",
    );

    expect(seen[0].map((message) => message.content)).toContain(
      REVISION_VERIFICATION_GUIDANCE,
    );

    const context = seen[0].map((message) => message.content).join("\n");
    expect(context).toContain("No input cells are attached for this run");
    expect(context).toContain("make zero registry reads and ask the user");
    expect(context).toContain("at most one registry read");
    expect(seen[0].at(-1)?.content).toBe("add a total to this bills pane");
  });

  it("supplies target-selection guidance without a seeded system prompt", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, { inputCells: [] });

    await runTurn(service, "turn-1", "add a total to this bills pane");

    const context = seen[0].map((message) => message.content).join("\n");
    expect(context).toContain("No input cells are attached for this run");
    expect(context).toContain("make zero registry reads and ask the user");
    expect(context).toContain("at most one registry read");
    expect(context).toContain(
      "released evidence identifies exactly one matching piece",
    );
    expect(context).toContain("Do not delegate discovery of an unnamed target");
    expect(seen[0].at(-1)?.content).toBe("add a total to this bills pane");
  });

  it("supplies revision verification guidance before an attached task", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, {
      inputCells: [{ name: "bills", ref: "/of:fid1:bills" }],
    });
    await runTurn(
      service,
      "turn-verify",
      "Stop treating alert emails as bills.",
    );

    expect(seen[0].map((message) => message.content)).toContain(
      REVISION_VERIFICATION_GUIDANCE,
    );
    const context = seen[0].map((message) => message.content).join("\n");
    expect(context).toContain(
      "For both creation and revision, distinguish applying source from inspecting its result.",
    );
    expect(context).toContain(
      "Unavailable verification alone is not a failure branch or a reason to leave a revision unapplied.",
    );
    expect(context).toContain(
      "The parent states the limitation in the final text",
    );
    expect(context).toContain(
      "It must not assert unseen rows, counts, matches, unread status, or relevance scores.",
    );
    expect(context).toContain(
      "Its resultSchema must expose pending, error, ready, sampleSize, beforeCount, afterCount, and changedCount.",
    );
    expect(context).toContain(
      "never default a missing pending or error field, missing readiness to true, or missing counts to zero",
    );
    expect(context).toContain(
      "Reread the same verificationRef once through that reader before interpreting its counts; do not author a replacement probe.",
    );
    expect(context).toContain(
      "A policy refusal is final for that read and does not call for a reread.",
    );
    expect(context).not.toContain(
      "A zero changedCount, empty sample, or unavailable verification is not completion",
    );
    expect(seen[0].at(-1)?.content).toBe(
      "Stop treating alert emails as bills.",
    );
  });

  it("opens a turn with the granted references of its own space", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, { inputCells: [] });

    await runTurn(service, "turn-1", "what is in this space?");

    const context = seen[0].filter((message) =>
      message.role === "user" && message.content.includes("cfh:a:grant")
    );
    expect(context).toHaveLength(1);
    // Before the request it was established for, and after nothing.
    expect(seen[0].at(-1)?.content).toBe("what is in this space?");
  });

  it("announces the input cells the request attached, by the caller's names", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, {
      inputCells: [{ name: "itinerary", ref: "/of:fid1:x/days" }],
    });

    await runTurn(service, "turn-1", "summarize the trip", [
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);

    const announced = seen[0].find((message) =>
      message.content.includes("cfh:a:cell0")
    );
    expect(announced?.content).toContain("itinerary");
    // The token stands for the address; the address itself never crosses.
    expect(announced?.content).not.toContain("/of:fid1:x/days");
  });

  it("runs the turn when its space will not hand over its grants", async () => {
    // A grant is an entitlement the run did not ask for, so a session that
    // will not connect still answers the request — its tools surface the same
    // failure if the turn reaches for one.
    const seen: HarnessTranscriptMessage[][] = [];
    const engine = stubEngine({ inputCells: [] });
    const refusing = {
      ...engine,
      config: engine.config,
      fabricSessionAvailable: true,
      establishWellKnownGrants: () =>
        Promise.reject(new Error("no route to the fabric")),
      establishInputCells: () => Promise.resolve([]),
    } as unknown as CfHarnessEngine;
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: { engine: refusing },
      createPromptLoop: recordingLoop(seen),
    });
    await service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-session",
      method: "start_session",
      params: {
        sessionId: "session-1",
        workspace: { hostPath: "/workspace" },
        model: "gpt-test",
      },
    });

    await runTurn(service, "turn-1", "what is in this space?");

    expect(seen).toHaveLength(1);
    expect(seen[0].at(-1)?.content).toBe("what is in this space?");
    expect(
      seen[0].some((message) => message.content.includes("cfh:a:grant")),
    ).toBe(false);
  });

  it("names cells per turn, so a following turn carries only its own", async () => {
    const options: (readonly HarnessInputCellSpec[] | undefined)[] = [];
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: { engine: stubEngine({ inputCells: [] }) },
      createPromptLoop: (loopOptions) => {
        options.push(loopOptions.inputCells);
        return recordingLoop([])(loopOptions);
      },
    });
    await service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-session",
      method: "start_session",
      params: {
        sessionId: "session-1",
        workspace: { hostPath: "/workspace" },
        model: "gpt-test",
      },
    });

    await runTurn(service, "turn-1", "summarize the trip", [
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);
    await runTurn(service, "turn-2", "and the cost?");

    expect(options[0]).toEqual([
      { name: "itinerary", ref: "/of:fid1:x/days" },
    ]);
    expect(options[1]).toBeUndefined();
  });

  it("announces the patterns the request attached, with the specifier that composes each", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, {
      inputCells: [],
      patternRefs: [{
        patternId: "pat-expenses",
        record: {
          patternId: "pat-expenses",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          importHint: 'import X from "cf:pattern:pat-expenses"',
        },
      }],
    });

    await runTurn(service, "turn-1", "total my spending", undefined, [
      { patternId: "pat-expenses" },
    ]);

    const announced = seen[0].find((message) =>
      message.content.includes("pat-expenses")
    );
    expect(announced?.content).toContain("Totals an expense list");
    expect(announced?.content).toContain(
      'import X from "cf:pattern:pat-expenses"',
    );
  });

  it("fails a turn whose attached pattern the index does not hold, before a model turn", async () => {
    const seen: HarnessTranscriptMessage[][] = [];
    const service = await startedService(seen, {
      inputCells: [],
      unknownPatternId: "pat-nothing",
    });

    await runTurn(service, "turn-1", "total my spending", undefined, [
      { patternId: "pat-nothing" },
    ]);

    const failure = service.events("session-1").map((envelope) =>
      envelope.event
    )
      .find((event) => event.kind === "turn_failed");
    expect(JSON.stringify(failure)).toContain("pat-nothing");
    // The reference is what the caller attached, so a turn that cannot have
    // it does not run without it.
    expect(seen).toEqual([]);
  });
});
