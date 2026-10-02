import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import {
  checkHarnessClientProtocol,
  effectiveHarnessCommandApproval,
  HARNESS_COMMAND_ARGS_MAX_BYTES,
  HARNESS_COMMAND_BODY_MAX_BYTES,
  harnessCommandActorFor,
  legacyOutcomeOfHarnessCommandSettlement,
  readHarnessClientProtocolDeclaration,
  readHarnessCommandCatalog,
  readHarnessCommandInvocation,
  readHarnessCommandOutcome,
  readHarnessCommandResolveBody,
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
  "resolve-declined",
  "resolve-failed-to-deliver",
  "resolve-failed-to-deliver-unsent",
];

const RESOLVED_EVENT_FIXTURES = [
  "resolved-event-executed",
  "resolved-event-catalog",
  "resolved-event-interrupted",
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

    it("answers a missing feature with the HTTP mismatch body", () => {
      const declaration = readHarnessClientProtocolDeclaration(
        fixture("protocol-task-request").protocol,
      )!;
      const check = checkHarnessClientProtocol(declaration);
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
      });
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

    it("refuses a lost answer that names nobody who sent it", () => {
      const lost = fixture("resolve-failed-to-deliver").settlement as Record<
        string,
        unknown
      >;
      const { attribution: _attribution, ...rest } = lost;
      expect(readHarnessCommandSettlement(rest)).toBeUndefined();
    });
  });
});
