import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import {
  checkHarnessClientProtocol,
  effectiveHarnessCommandApproval,
  HARNESS_COMMAND_ARGS_MAX_BYTES,
  HARNESS_COMMAND_BODY_MAX_BYTES,
  harnessClientProtocolEcho,
  harnessCommandActorFor,
  legacyOutcomeOfHarnessCommandSettlement,
  readHarnessClientProtocolDeclaration,
  readHarnessCommandCatalog,
  readHarnessCommandCatalogRequest,
  readHarnessCommandInvocation,
  readHarnessCommandOutcome,
  readHarnessCommandResolveBody,
  readHarnessCommandResultProvenance,
  readHarnessCommandSettlement,
  readHarnessCommandSettlementRecord,
  readHarnessTypedClientAction,
} from "../../src/contracts/client-command.ts";
import {
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  type HarnessChatEventEnvelope,
  type HarnessChatStructuredEvent,
} from "../../src/contracts/interactive-chat.ts";
import { readHarnessClientAction } from "../../src/contracts/client-action.ts";

const FIXTURES = fromFileUrl(
  new URL("../fixtures/client-command-wire/", import.meta.url),
);

/** A fixture's bytes, as the Weaver's Swift tests read the same file. */
const fixtureText = (name: string): string =>
  Deno.readTextFileSync(`${FIXTURES}${name}.json`);

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(fixtureText(name));

/** The text a fixture holds for `value`: two-space JSON and a final newline. */
const encoded = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/**
 * Rebuilds an event envelope from its read parts, so an envelope fixture is
 * pinned field for field rather than copied through.
 */
const rebuiltEnvelope = (
  file: Record<string, unknown>,
  event: HarnessChatStructuredEvent,
): HarnessChatEventEnvelope =>
  createHarnessChatEventEnvelope({
    sessionId: file.sessionId as string,
    turnId: file.turnId as string,
    sequence: file.sequence as number,
    emittedAt: file.emittedAt as string,
    event,
  });

const REQUEST_FIXTURES = [
  "request-invoke-query",
  "request-invoke-mutation",
  "request-list-commands",
];

const RESOLVE_FIXTURES = [
  "resolve-executed-success",
  "resolve-executed-refusal",
  "resolve-executed-partial",
  "resolve-executed-may-have-landed",
  "resolve-executed-version-conflict",
  "resolve-executed-body-omitted",
  "resolve-executed-weaver-local",
  "resolve-executed-catalog",
  "resolve-executed-catalog-mixed-ids",
  "resolve-declined",
  "resolve-failed-to-deliver",
  "resolve-failed-to-deliver-unsent",
];

const RESOLVED_EVENT_FIXTURES = [
  "resolved-event-executed",
  "resolved-event-catalog",
  "resolved-event-interrupted",
  "resolved-event-interrupted-delivery-failed",
];

describe("client command contract", () => {
  describe("wire fixtures", () => {
    for (const name of REQUEST_FIXTURES) {
      it(`reads and re-encodes ${name} exactly`, () => {
        const file = fixture(name);
        const event = file.event as Record<string, unknown>;
        const action = readHarnessTypedClientAction(event.action);
        expect(action).toBeDefined();
        const rebuilt = rebuiltEnvelope(file, {
          kind: "client_action_requested",
          turnId: event.turnId as string,
          actionId: event.actionId as string,
          action: action!,
        });
        expect(encoded(rebuilt)).toBe(fixtureText(name));
      });
    }

    for (const name of RESOLVE_FIXTURES) {
      it(`reads and re-encodes ${name} exactly`, () => {
        const body = readHarnessCommandResolveBody(fixture(name));
        expect(body).toBeDefined();
        expect(encoded(body)).toBe(fixtureText(name));
      });
    }

    for (const name of RESOLVED_EVENT_FIXTURES) {
      it(`reads and re-encodes ${name} exactly`, () => {
        const file = fixture(name);
        const event = file.event as Record<string, unknown>;
        const settlement = readHarnessCommandSettlementRecord(
          event.settlement,
        );
        expect(settlement).toBeDefined();
        const rebuilt = rebuiltEnvelope(file, {
          kind: "client_action_resolved",
          turnId: event.turnId as string,
          actionId: event.actionId as string,
          outcome: legacyOutcomeOfHarnessCommandSettlement(settlement!),
          ...(event.result !== undefined
            ? { result: event.result as string }
            : {}),
          settlement: settlement!,
        });
        expect(encoded(rebuilt)).toBe(fixtureText(name));
      });
    }

    it("reads the protocol declaration a task carries", () => {
      const task = fixture("protocol-task-request");
      const declaration = readHarnessClientProtocolDeclaration(task.protocol);
      expect(encoded(declaration)).toBe(
        encoded((task as { protocol: unknown }).protocol),
      );
    });

    it("echoes the accepted protocol when every required feature is served", () => {
      const declaration = readHarnessClientProtocolDeclaration(
        fixture("protocol-task-request").protocol,
      )!;
      const check = checkHarnessClientProtocol(declaration, [
        "client_actions",
        "typed_commands",
      ]);
      expect(check.ok).toBe(true);
      const accepted = fixture("protocol-task-accepted");
      expect(check.ok && check.protocol).toEqual(accepted.protocol);
    });

    // The mismatch fixtures are the answers of a console serving
    // `client_actions` alone, the one a host requiring typed commands meets.
    it("answers a missing feature with the HTTP mismatch body", () => {
      const declaration = readHarnessClientProtocolDeclaration(
        fixture("protocol-task-request").protocol,
      )!;
      const check = checkHarnessClientProtocol(declaration, [
        "client_actions",
      ]);
      expect(check.ok).toBe(false);
      if (check.ok) return;
      const { message, ...mismatch } = check.mismatch;
      expect(encoded({ error: message, ...mismatch })).toBe(
        fixtureText("protocol-mismatch-http"),
      );
    });

    it("answers another protocol version with the stdio mismatch error", () => {
      const check = checkHarnessClientProtocol({
        protocolVersion: 2,
        requires: ["client_actions"],
      }, ["client_actions"]);
      expect(check.ok).toBe(false);
      if (check.ok) return;
      const { message, ...details } = check.mismatch;
      const response = createHarnessChatErrorResponse("request-1", {
        code: "protocol_mismatch",
        message,
        details: { ...details },
      });
      expect(encoded(response)).toBe(fixtureText("protocol-mismatch-stdio"));
    });
  });

  describe("invocation", () => {
    const query = {
      command: "loom.inspect",
      args: {},
      approval: "automatic",
    };

    it("refuses args larger than the request limit before delivery", () => {
      const args = { text: "x".repeat(HARNESS_COMMAND_ARGS_MAX_BYTES) };
      expect(readHarnessCommandInvocation({ ...query, args })).toBeUndefined();
    });

    it("refuses an unknown field, a bad target, and a malformed command id", () => {
      expect(readHarnessCommandInvocation({ ...query, actor: "user" }))
        .toBeUndefined();
      expect(
        readHarnessCommandInvocation({
          ...query,
          target: { loomId: "loom-1" },
        }),
      ).toBeUndefined();
      expect(readHarnessCommandInvocation({ ...query, command: "/inspect" }))
        .toBeUndefined();
    });

    it("reads the service's frozen command ids, camel case and underscores included", () => {
      for (
        const command of [
          "connector.connectDevice",
          "connector.msgvaultRetireLegacy",
          "wish.choose_facet",
          "wish.delivery_retry",
        ]
      ) {
        expect(readHarnessCommandInvocation({ ...query, command })?.command)
          .toBe(command);
      }
    });

    it("refuses a command id with a space, an empty segment, or a leading dot", () => {
      for (
        const command of [
          "loom inspect",
          ".loom.inspect",
          "loom..inspect",
          "loom.",
          "_loom.inspect",
          `a${"b".repeat(128)}`,
        ]
      ) {
        expect(readHarnessCommandInvocation({ ...query, command }))
          .toBeUndefined();
      }
    });

    it("keeps the typed kinds out of the final-action reader", () => {
      const action = fixture("request-invoke-query").event as {
        action: unknown;
      };
      expect(readHarnessClientAction(action.action)).toBeUndefined();
    });
  });

  describe("approval and actor", () => {
    it("runs a command automatically only when both sides admit it", () => {
      expect(effectiveHarnessCommandApproval("automatic", true)).toBe(
        "automatic",
      );
      expect(effectiveHarnessCommandApproval("automatic", false)).toBe(
        "person",
      );
      expect(effectiveHarnessCommandApproval("person", true)).toBe("person");
    });

    it("attributes an automatic read to the agent and an approval to the user", () => {
      expect(harnessCommandActorFor("automatic")).toBe("agent");
      expect(harnessCommandActorFor("person")).toBe("user");
    });

    it("refuses an attribution whose actor disagrees with its approval", () => {
      const body = fixture("resolve-executed-success");
      const settlement = body.settlement as Record<string, unknown>;
      const attribution = settlement.attribution as Record<string, unknown>;
      expect(
        readHarnessCommandSettlement({
          ...settlement,
          attribution: { ...attribution, actor: "user" },
        }),
      ).toBeUndefined();
      expect(
        readHarnessCommandSettlement({
          ...settlement,
          attribution: { ...attribution, loomActor: "user" },
        }),
      ).toBeUndefined();
    });

    it("refuses a decline that is not the person's", () => {
      const declined = fixture("resolve-declined").settlement as Record<
        string,
        unknown
      >;
      const agent = (fixture("resolve-executed-success").settlement as Record<
        string,
        unknown
      >).attribution;
      expect(readHarnessCommandSettlement({ ...declined, attribution: agent }))
        .toBeUndefined();
    });

    it("refuses a catalog entry that runs a mutation automatically", () => {
      const catalog = (fixture("resolve-executed-catalog").settlement as {
        catalog: { entries: Record<string, unknown>[] };
      }).catalog;
      const [, , move] = catalog.entries;
      expect(
        readHarnessCommandCatalog({
          entries: [{ ...move, approval: "automatic" }],
        }),
      ).toBeUndefined();
    });
  });

  describe("outcome", () => {
    const success = (fixture("resolve-executed-success").settlement as {
      outcome: Record<string, unknown>;
    }).outcome;

    it("refuses a retained body over the body limit", () => {
      expect(
        readHarnessCommandOutcome({
          ...success,
          bodyBytes: HARNESS_COMMAND_BODY_MAX_BYTES + 1,
        }),
      ).toBeUndefined();
    });

    it("refuses a retained body over the body limit whatever size it claims", () => {
      expect(
        readHarnessCommandOutcome({
          ...success,
          body: { text: "x".repeat(HARNESS_COMMAND_BODY_MAX_BYTES) },
        }),
      ).toBeUndefined();
    });

    it("refuses an omitted body that would have fit", () => {
      const { body: _body, ...rest } = success;
      expect(readHarnessCommandOutcome({ ...rest, bodyOmitted: true }))
        .toBeUndefined();
    });

    it("keeps whether an oversized answer landed", () => {
      const omitted = readHarnessCommandResolveBody(
        fixture("resolve-executed-body-omitted"),
      );
      const settlement = omitted?.settlement;
      expect(settlement?.status === "executed" && "outcome" in settlement)
        .toBe(true);
      if (settlement?.status !== "executed" || !("outcome" in settlement)) {
        return;
      }
      expect(settlement.outcome.ok).toBe(true);
      expect(settlement.outcome.body).toBeUndefined();
      expect(settlement.outcome.bodyOmitted).toBe(true);
    });

    it("requires a transport status from the service and none from the Weaver", () => {
      const { transportStatus: _status, ...loomWithout } = success;
      expect(readHarnessCommandOutcome(loomWithout)).toBeUndefined();
      expect(readHarnessCommandOutcome({ ...success, executor: "weaver" }))
        .toBeUndefined();
    });

    it("refuses displaced components larger than the summary bound", () => {
      expect(
        readHarnessCommandOutcome({
          ...success,
          displaced: ["x".repeat(HARNESS_COMMAND_BODY_MAX_BYTES)],
        }),
      ).toBeUndefined();
    });

    it("refuses a summary that contradicts the body it was lifted from", () => {
      const conflict = (fixture("resolve-executed-version-conflict")
        .settlement as { outcome: Record<string, unknown> }).outcome;
      const { code: _code, error: _error, ...rest } = conflict;
      expect(readHarnessCommandOutcome({ ...rest, ok: true }))
        .toBeUndefined();
      expect(readHarnessCommandOutcome({ ...conflict, code: "store-error" }))
        .toBeUndefined();
      expect(readHarnessCommandOutcome({ ...conflict, id: "loom.add" }))
        .toBeUndefined();
      const landed = (fixture("resolve-executed-may-have-landed")
        .settlement as { outcome: Record<string, unknown> }).outcome;
      const { mayHaveLanded: _landed, ...unsure } = landed;
      expect(readHarnessCommandOutcome(unsure)).toBeUndefined();
    });

    it("reads a version conflict as an executed command", () => {
      const settlement = readHarnessCommandResolveBody(
        fixture("resolve-executed-version-conflict"),
      )?.settlement;
      expect(settlement?.status).toBe("executed");
      expect(legacyOutcomeOfHarnessCommandSettlement(settlement!)).toBe(
        "done",
      );
    });
  });

  describe("settlement", () => {
    it("refuses an interruption posted by a host", () => {
      expect(
        readHarnessCommandResolveBody({
          sessionId: "session-1",
          actionId: "action-2",
          settlement: { status: "interrupted", reason: "restart" },
        }),
      ).toBeUndefined();
    });

    it("keeps a delivered action whose batch failed to deliver as the console's own interruption", () => {
      const interrupted = {
        status: "interrupted",
        reason: "delivery_failed",
      } as const;
      expect(readHarnessCommandSettlement(interrupted)).toEqual(interrupted);
      expect(legacyOutcomeOfHarnessCommandSettlement(interrupted)).toBe(
        "failed",
      );
      expect(
        readHarnessCommandResolveBody({
          sessionId: "session-1",
          actionId: "action-3",
          settlement: interrupted,
        }),
      ).toBeUndefined();
      const attribution = (fixture("resolve-declined").settlement as {
        attribution: unknown;
      }).attribution;
      expect(readHarnessCommandSettlement({ ...interrupted, attribution }))
        .toBeUndefined();
    });

    it("refuses a lost answer that names nobody who sent it", () => {
      const lost = fixture("resolve-failed-to-deliver").settlement as Record<
        string,
        unknown
      >;
      const { attribution: _attribution, ...rest } = lost;
      expect(readHarnessCommandSettlement(rest)).toBeUndefined();
    });
  });
  describe("malformed input", () => {
    type Json = Record<string, unknown>;
    const settlementOf = (name: string): Json =>
      fixture(name).settlement as Json;
    const executed = settlementOf("resolve-executed-success");
    const attribution = executed.attribution as Json;
    const outcome = executed.outcome as Json;
    const catalog = settlementOf("resolve-executed-catalog").catalog as {
      entries: Json[];
    };
    const [entry] = catalog.entries;
    const lost = settlementOf("resolve-failed-to-deliver");
    const declined = settlementOf("resolve-declined");
    const resolve = fixture("resolve-executed-success");
    const record = (fixture("resolved-event-executed").event as Json)
      .settlement as Json;
    const query = { command: "loom.inspect", args: {}, approval: "automatic" };
    let deep: unknown = {};
    for (let depth = 0; depth < 70; depth += 1) deep = { deep };

    const refusals: Record<string, [(value: unknown) => unknown, unknown[]]> = {
      "protocol declaration": [readHarnessClientProtocolDeclaration, [
        null,
        [],
        { protocolVersion: 1 },
        { protocolVersion: 1, requires: [], extra: true },
        { protocolVersion: 1.5, requires: [] },
        { protocolVersion: 1, requires: "client_actions" },
        { protocolVersion: 1, requires: [""] },
        { protocolVersion: 1, requires: [7] },
        { protocolVersion: 1, requires: ["x".repeat(65)] },
        { protocolVersion: 1, requires: Array(17).fill("client_actions") },
      ]],
      "typed action": [readHarnessTypedClientAction, [
        "invoke_command",
        { kind: "command", line: "/inspect" },
        { kind: "invoke_command", invocation: query, extra: true },
        { kind: "invoke_command", invocation: { ...query, approval: "any" } },
        { kind: "list_commands" },
        { kind: "list_commands", request: { detail: "loom.inspect" } },
      ]],
      "invocation": [readHarnessCommandInvocation, [
        [],
        { command: "loom.inspect", args: {} },
        { ...query, args: [] },
        { ...query, args: { at: () => 0 } },
        { ...query, args: { n: Number.NaN } },
        { ...query, args: deep },
        { ...query, target: [] },
        { ...query, target: { loomId: "loom-0123456789abcdef", extra: 1 } },
        {
          ...query,
          target: { loomId: "loom-0123456789abcdef", expectedVersion: -1 },
        },
        { ...query, command: `a${".b".repeat(64)}` },
      ]],
      "catalog request": [readHarnessCommandCatalogRequest, [
        null,
        { detail: [], extra: true },
        { detail: ["loom inspect"] },
        { detail: Array(17).fill("loom.inspect") },
      ]],
      "catalog": [readHarnessCommandCatalog, [
        null,
        { entries: [], extra: true },
        { entries: {} },
        { entries: Array(257).fill(entry) },
        { entries: [null] },
        { entries: [{ ...entry, extra: true }] },
        { entries: [{ ...entry, scope: "page" }] },
        { entries: [{ ...entry, effect: "write" }] },
        { entries: [{ ...entry, summary: "x".repeat(501) }] },
        { entries: [{ ...entry, inputSchema: [] }] },
        { entries: [{ ...entry, description: "x".repeat(8001) }] },
      ]],
      "outcome": [readHarnessCommandOutcome, [
        null,
        { ...outcome, extra: true },
        { ...outcome, executor: "cli" },
        { ...outcome, ok: "yes" },
        { ...outcome, bodyBytes: -1 },
        { ...outcome, transportStatus: 99 },
        { ...outcome, code: 409 },
        { ...outcome, error: "x".repeat(2001) },
        { ...outcome, quiet: "yes" },
        { ...outcome, mayHaveLanded: 1 },
        { ...outcome, outputs: [] },
        { ...outcome, outputs: { text: "x".repeat(8 * 1024) } },
        { ...outcome, completed: "op-1" },
        { ...outcome, completed: [1] },
        { ...outcome, completed: Array(257).fill("op-1") },
        { ...outcome, displaced: {} },
        { ...outcome, displaced: [undefined] },
        { ...outcome, bodyOmitted: true },
        { ...outcome, body: [] },
        { ...outcome, body: undefined, bodyOmitted: false },
      ]],
      "settlement": [readHarnessCommandSettlement, [
        null,
        { status: "done" },
        { status: "executed", catalog, extra: true },
        { status: "executed", catalog: { entries: {} } },
        { ...executed, extra: true },
        { status: "executed", attribution },
        { ...executed, attribution: { ...attribution, extra: true } },
        { ...executed, attribution: { ...attribution, service: "" } },
        { ...executed, attribution: { ...attribution, loomActor: "agent" } },
        { ...executed, attribution: { ...attribution, originLoomId: "x" } },
        { ...executed, attribution: [] },
        { ...executed, outcome: { ...outcome, ok: 1 } },
        { ...executed, receipt: "x".repeat(2001) },
        { ...declined, extra: true },
        { ...declined, reason: 7 },
        { status: "declined" },
        { ...lost, extra: true },
        { ...lost, reason: 7 },
        { ...lost, landed: "yes" },
        { ...lost, attribution: { ...attribution, actor: "user" } },
        { status: "interrupted", reason: "lost" },
        { status: "interrupted", reason: "restart", extra: true },
      ]],
      "resolve body": [readHarnessCommandResolveBody, [
        null,
        { ...resolve, extra: true },
        { ...resolve, sessionId: "" },
        { ...resolve, actionId: "x".repeat(257) },
        { ...resolve, settlement: { status: "done" } },
      ]],
      "settlement record": [readHarnessCommandSettlementRecord, [
        null,
        { status: "executed", catalogEntries: 257 },
        { status: "executed", catalogEntries: 3, extra: true },
        { ...record, extra: true },
        { status: "executed", outcome: record.outcome },
        { ...record, handle: "cfh:k7m2q" },
        { ...record, receipt: "x".repeat(2001) },
        { ...record, outcome: null },
        { ...record, outcome: { ...(record.outcome as Json), body: {} } },
        { ...record, outcome: { ...(record.outcome as Json), ok: "yes" } },
        { ...record, attribution: { ...attribution, actor: "user" } },
        { status: "declined" },
      ]],
      "result provenance": [readHarnessCommandResultProvenance, [
        null,
        { command: "loom.inspect" },
        { command: "loom.inspect", actor: "agent", extra: true },
        { command: "loom.inspect", actor: "person" },
        { command: "loom.inspect", actor: "agent", loomId: "loom-1" },
        { command: "loom.inspect", actor: "agent", version: 1.5 },
        { command: "loom.inspect", actor: "agent", originLoomId: 7 },
      ]],
    };

    for (const [reader, [read, values]] of Object.entries(refusals)) {
      it(`refuses every malformed ${reader}`, () => {
        for (const value of values) {
          expect({ value, read: read(value) }).toEqual({
            value,
            read: undefined,
          });
        }
      });
    }

    it("reads an omitted body's record, a bare catalog request, and a bare declaration", () => {
      const omitted = (fixture("resolve-executed-body-omitted")
        .settlement as Json).outcome as Json;
      const { body: _body, ...rest } = omitted;
      expect(
        readHarnessCommandSettlementRecord({
          ...record,
          outcome: {
            executor: rest.executor,
            transportStatus: rest.transportStatus,
            ok: rest.ok,
            bodyBytes: rest.bodyBytes,
            bodyOmitted: true,
          },
        }),
      ).toBeDefined();
      expect(readHarnessCommandCatalogRequest({})).toEqual({});
      expect(
        readHarnessClientProtocolDeclaration({
          protocolVersion: 1,
          requires: [],
        }),
      ).toEqual({ protocolVersion: 1, requires: [] });
      expect(checkHarnessClientProtocol({ protocolVersion: 1, requires: [] }))
        .toEqual({ ok: true, protocol: harnessClientProtocolEcho() });
    });

    it("shows a reader that knows three words each settlement's word", () => {
      expect(legacyOutcomeOfHarnessCommandSettlement({ status: "declined" }))
        .toBe("declined");
      expect(
        legacyOutcomeOfHarnessCommandSettlement({
          status: "failed_to_deliver",
        }),
      ).toBe("failed");
      expect(
        legacyOutcomeOfHarnessCommandSettlement({ status: "interrupted" }),
      ).toBe("failed");
    });
  });
});
