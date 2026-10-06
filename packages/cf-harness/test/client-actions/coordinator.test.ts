import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { fromFileUrl, toFileUrl } from "@std/path";

import type { HarnessClientActionRequester } from "../../mod.ts";
import { HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES } from "../../src/client-actions/command-result.ts";
import {
  HarnessClientActionCoordinator,
  readHarnessClientActionAnswer,
  readHarnessMidTurnClientAction,
} from "../../src/client-actions/coordinator.ts";
import {
  HARNESS_COMMAND_ARGS_MAX_BYTES,
  HARNESS_COMMAND_CATALOG_LIMIT,
  HARNESS_COMMAND_ID_PATTERN,
  type HarnessCommandCatalogEntry,
  harnessCommandJsonBytes,
  type HarnessCommandResolveBody,
  readHarnessCommandCatalog,
} from "../../src/contracts/client-command.ts";
import type { HarnessDocumentReferentDraft } from "../../src/contracts/handle-table.ts";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatEventEnvelope,
  type HarnessChatRequestEnvelope,
} from "../../src/contracts/interactive-chat.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  mintReferentHandle,
  resolveReferentToken,
} from "../../src/handle-table.ts";
import { HarnessInteractiveChatService } from "../../src/interactive-chat-service.ts";
import type { HarnessChatSessionStore } from "../../src/session-store.ts";
import { openSqliteHarnessChatSessionStore } from "../../src/sqlite-session-store.ts";
import { weaverActionTool } from "../../src/tools/weaver-action.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";

const FIXTURES = fromFileUrl(
  new URL("../fixtures/client-command-wire/", import.meta.url),
);

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(Deno.readTextFileSync(`${FIXTURES}${name}.json`));

/** The action a request fixture's event carries. */
const requestedAction = (name: string): Record<string, unknown> =>
  ((fixture(name).event as Record<string, unknown>).action) as Record<
    string,
    unknown
  >;

/** The event a resolved-event fixture carries. */
const resolvedFixtureEvent = (name: string): Record<string, unknown> =>
  fixture(name).event as Record<string, unknown>;

/** A settle fixture's body, addressed to this test's session and action. */
const settle = (name: string, actionId: string): HarnessCommandResolveBody =>
  ({
    ...fixture(name),
    sessionId: "s",
    actionId,
  }) as unknown as HarnessCommandResolveBody;

const query = requestedAction("request-invoke-query");
const mutation = requestedAction("request-invoke-mutation");
const catalog = requestedAction("request-list-commands");

type Event = HarnessChatEventEnvelope["event"];

/**
 * A service whose model loop calls the real `weaver_action` tool through the
 * door the service hands it, with a holder that mints into a real handle
 * table.
 */
const harness = (
  options: {
    calls?: unknown[];
    idleMs?: number;
    /** Runs inside the service's event delivery, which waits for it. */
    deliver?: (event: Event) => void | Promise<void>;
    sessionStore?: HarnessChatSessionStore;
    /** Runs before each mint, which waits for it. */
    beforeMint?: () => Promise<void>;
  } = {},
) => {
  const events: HarnessChatEventEnvelope[] = [];
  const toolResults: unknown[] = [];
  const started = Promise.withResolvers<void>();
  const callsDone = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let table = createHarnessHandleTable("run-1");
  const waiters: { matches: (event: Event) => boolean; resolve: () => void }[] =
    [];
  const delivered = (matches: (event: Event) => boolean): Promise<void> => {
    if (events.some((e) => matches(e.event))) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    waiters.push({ matches, resolve: waiter.resolve });
    return waiter.promise;
  };
  let ids = 0;
  const service = new HarnessInteractiveChatService({
    randomUUID: () => `id-${++ids}`,
    createPromptLoop: (opts) => ({
      runTranscript: async (run) => {
        const context = {
          nextOutputId: () => "out-1",
          signal: run.signal,
          requestClientActions: (opts as {
            requestClientActions?: HarnessClientActionRequester;
          }).requestClientActions,
          mintReferentHandle: async (draft: HarnessDocumentReferentDraft) => {
            await options.beforeMint?.();
            const minted = await mintReferentHandle(table, {
              kind: "document",
              ...draft,
            });
            table = minted.table;
            return minted.token;
          },
        } as unknown as HarnessToolContext;
        started.resolve();
        for (const input of options.calls ?? [{ actions: [query] }]) {
          toolResults.push(
            await weaverActionTool.invoke(context, input as never),
          );
        }
        callsDone.resolve();
        await release.promise;
        return {
          model: "m",
          finalAssistantText: "done",
          transcript: [...run.transcript, {
            role: "assistant" as const,
            content: "done",
          }],
        } as never;
      },
    }),
    onEvent: async (event) => {
      events.push(event);
      for (const waiter of waiters) {
        if (waiter.matches(event.event)) waiter.resolve();
      }
      await options.deliver?.(event.event);
    },
    onEventDeliveryError: () => {},
    ...(options.sessionStore !== undefined
      ? { sessionStore: options.sessionStore }
      : {}),
    ...(options.idleMs !== undefined
      ? { clientActionIdleTimeoutMs: options.idleMs }
      : {}),
  });
  const request = <M extends HarnessChatRequestEnvelope["method"]>(
    method: M,
    params: unknown,
  ) =>
    service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "r",
      method,
      params,
    } as HarnessChatRequestEnvelope);
  const start = async () => {
    await request("start_session", {
      sessionId: "s",
      workspace: { hostPath: "/w" },
      model: "m",
      clientActions: true,
    });
    await request("start_turn", {
      sessionId: "s",
      turnId: "t",
      input: { text: "go" },
    });
    await started.promise;
  };
  const answer = (body: unknown) => request("resolve_client_action", body);
  const resolved = () =>
    events.map((e) => e.event).filter((e) =>
      e.kind === "client_action_resolved"
    );
  const finish = async () => {
    release.resolve();
    await service.waitForIdle();
  };
  return {
    service,
    start,
    answer,
    resolved,
    delivered,
    events,
    toolResults,
    callsDone: callsDone.promise,
    finish,
    table: () => table,
  };
};

/** Matches the `client_action_requested` event for one action id. */
const requestFor = (actionId: string) => (event: Event) =>
  event.kind === "client_action_requested" && event.actionId === actionId;

/** The one tool result's outcomes. */
const outcomesOf = (h: ReturnType<typeof harness>) =>
  (h.toolResults[0] as { outcomes: Record<string, unknown>[] }).outcomes;

describe("coordinator", () => {
  describe("a typed command", () => {
    it("keeps an in-process answer's body out of the model when its provenance cannot be derived", async () => {
      const requested = Promise.withResolvers<void>();
      const events: Event[] = [];
      const coordinator = new HarnessClientActionCoordinator({
        newActionId: () => "id-1",
        idleTimeoutMs: 300_000,
        emit: (_turnId, event, options) => {
          events.push(event);
          options?.onCommitted?.();
          if (event.kind === "client_action_requested") requested.resolve();
          return Promise.resolve();
        },
      });
      const action = readHarnessMidTurnClientAction(query);
      const answer = readHarnessClientActionAnswer(
        settle("resolve-executed-success", "id-1"),
      );
      if (
        action === undefined || answer === undefined ||
        answer.form !== "settlement" ||
        answer.params.settlement.status !== "executed" ||
        !("outcome" in answer.params.settlement)
      ) {
        throw new Error("Expected an executed command fixture");
      }
      // In-process callers can supply strings the wire reader would refuse.
      // Such provenance must never be handed to a document holder.
      answer.params.settlement.attribution.loomActor = "agent:InvalidSlug";
      let held = false;
      const result = coordinator.request("t", [action], undefined, () => {
        held = true;
        return Promise.resolve("unexpected-handle");
      });
      await requested.promise;
      expect(await coordinator.resolve(answer)).toEqual({ status: "accepted" });
      const outcomes = await result;
      expect(held).toBe(false);
      expect(outcomes[0]).toMatchObject({
        settlement: { status: "executed", outcome: { ok: true } },
      });
      expect(JSON.stringify(outcomes)).not.toContain("Reading list");
      expect(outcomes[0]).not.toHaveProperty("settlement.handle");
      expect(events).toHaveLength(2);
      expect(events[1]).not.toHaveProperty("settlement.handle");
    });

    for (
      const { title, action, fixtureName, loomActor } of [
        {
          title: "holds an automatic read under its named agent's provenance",
          action: query,
          fixtureName: "resolve-executed-success",
          loomActor: "agent:people-discovery",
        },
        {
          title: "holds a tapped mutation under the user's provenance",
          action: {
            ...mutation,
            invocation: {
              ...mutation.invocation as Record<string, unknown>,
              command: "loom.add",
            },
          },
          fixtureName: "resolve-executed-partial",
          loomActor: "user",
        },
      ]
    ) {
      it(title, async () => {
        const h = harness({ calls: [{ actions: [action] }] });
        await h.start();
        await h.delivered(requestFor("id-1"));
        const body = settle(fixtureName, "id-1");
        if (
          body.settlement.status !== "executed" ||
          !("attribution" in body.settlement)
        ) {
          throw new Error("Expected an executed command fixture");
        }
        body.settlement.attribution.loomActor = loomActor;
        expect((await h.answer(body)).ok).toBe(true);
        await h.callsDone;
        const settlement = outcomesOf(h)[0].settlement as { handle: string };
        const referent = resolveReferentToken(h.table(), settlement.handle);
        assertValidHarnessHandleTable(h.table());
        await h.finish();

        expect(referent?.kind).toBe("document");
        if (referent?.kind !== "document") {
          throw new Error("Expected a held command document");
        }
        expect(referent.labelSource).toBe("command");
        expect(referent.provenance?.loomActor).toBe(loomActor);
      });
    }

    it("holds the executed body as a command referent and hands the model its metadata and token", async () => {
      const h = harness();
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-executed-success", "id-1");
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;

      const [outcome] = outcomesOf(h);
      const settlement = outcome.settlement as Record<string, unknown>;
      const handle = settlement.handle as string;
      expect(handle).toMatch(/^cfh:v:/);
      const { body: retained, ...metadata } = (body.settlement as unknown as {
        outcome: Record<string, unknown>;
      }).outcome;
      expect(outcome).toEqual({
        action: query,
        settlement: {
          status: "executed",
          attribution: (body.settlement as { attribution: unknown })
            .attribution,
          outcome: metadata,
          handle,
        },
      });
      // The model reads neither the receipt nor the body.
      expect(JSON.stringify(outcome)).not.toContain("Read Reading");
      expect(JSON.stringify(outcome)).not.toContain("Reading list");

      const referent = resolveReferentToken(h.table(), handle);
      expect(referent).toEqual({
        token: handle,
        kind: "document",
        source: "weaver_action",
        value: retained,
        label: { confidentiality: [], integrity: [] },
        labelSource: "command",
        provenance: {
          command: "loom.inspect",
          actor: "agent",
          loomActor: "agent:cf-harness",
          loomId: "loom-0123456789abcdef",
          version: 12,
          originLoomId: "loom-fedcba9876543210",
        },
      });
      assertValidHarnessHandleTable(h.table());

      // The resolved event is the wire fixture's, with this run's token.
      const expected = resolvedFixtureEvent("resolved-event-executed");
      expect(h.resolved()).toEqual([{
        ...expected,
        turnId: "t",
        actionId: "id-1",
        settlement: {
          ...(expected.settlement as Record<string, unknown>),
          handle,
        },
      }]);
      await h.finish();
    });

    it("returns a catalog to the model and records only its size", async () => {
      const h = harness({ calls: [{ actions: [catalog] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-executed-catalog", "id-1");
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;

      expect(outcomesOf(h)).toEqual([{
        action: catalog,
        settlement: {
          status: "executed",
          catalog: (body.settlement as { catalog: unknown }).catalog,
        },
      }]);
      expect(h.resolved()).toEqual([{
        ...resolvedFixtureEvent("resolved-event-catalog"),
        turnId: "t",
        actionId: "id-1",
      }]);
      await h.finish();
    });

    it("takes the Weaver's real catalog whole", async () => {
      const posted = JSON.parse(
        Deno.readTextFileSync(
          fromFileUrl(
            new URL(
              "../fixtures/client-actions/weaver-catalog-settle.json",
              import.meta.url,
            ),
          ),
        ),
      );
      const h = harness({ calls: [{ actions: [catalog] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const answered = await h.answer({
        ...posted,
        sessionId: "s",
        actionId: "id-1",
      });
      expect(answered.ok).toBe(true);
      await h.callsDone;

      const settlement = outcomesOf(h)[0].settlement as {
        catalog: { entries: { command: string }[] };
        compacted?: number;
        droppedEntries?: number;
        droppedCommands?: string[];
      };
      // Every id the Weaver sends, mixed-case and underscored ones
      // included, is one the contract admits, so nothing is dropped.
      expect(settlement.catalog.entries).toHaveLength(15);
      expect(settlement.catalog.entries.map((entry) => entry.command)).toEqual([
        "looms.list",
        "loom.open",
        "artifact.fetch-image",
        "calendar.day",
        "connector.connectDevice",
        "connector.msgvaultRetireLegacy",
        "create.chat",
        "epic-fhir.refresh-endpoints",
        "loom.add",
        "loom.inspect",
        "loom.move",
        "person-entry.find",
        "revert",
        "wish.choose_facet",
        "wish.delivery_retry",
      ]);
      expect(settlement.catalog.entries).toEqual(
        posted.settlement.catalog.entries,
      );
      expect(settlement.droppedEntries ?? 0).toBe(0);
      expect(settlement.droppedCommands ?? []).toEqual([]);
      expect(settlement.compacted).toBeUndefined();
      const [event] = h.resolved() as {
        settlement: unknown;
        result?: string;
      }[];
      expect(event.settlement).toEqual({
        status: "executed",
        catalogEntries: 15,
      });
      expect(event.result).toBeUndefined();
      await h.finish();
    });

    it("drops a malformed catalog entry and keeps the rest, but refuses a malformed catalog", async () => {
      const h = harness({ calls: [{ actions: [catalog] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-executed-catalog", "id-1") as unknown as {
        settlement: { catalog: { entries: Record<string, unknown>[] } };
      };
      const entries = body.settlement.catalog.entries;
      const refused = [
        {
          reason: "invalid command id",
          entry: { ...entries[0], command: "loom invalid" },
        },
        {
          reason: "missing required fields",
          entry: { command: "page.broken" },
        },
      ];
      expect(HARNESS_COMMAND_ID_PATTERN.test(refused[0].entry.command)).toBe(
        false,
      );
      expect(Object.keys(refused[1].entry)).toEqual(["command"]);
      for (const { reason, entry } of refused) {
        expect(readHarnessCommandCatalog({ entries: [entry] }), reason)
          .toBeUndefined();
      }
      const broken = {
        ...body,
        settlement: {
          status: "executed",
          catalog: {
            entries: [...entries, ...refused.map(({ entry }) => entry)],
          },
        },
      };
      // The envelope is the contract's to refuse.
      const malformed = await h.answer({
        ...body,
        settlement: { status: "executed", catalog: { entries: "all" } },
      });
      expect(malformed.ok === false && malformed.error.code).toBe(
        "invalid_request",
      );
      expect((await h.answer(broken)).ok).toBe(true);
      await h.callsDone;
      const settlement = outcomesOf(h)[0].settlement as {
        catalog: { entries: unknown[] };
        droppedEntries?: number;
        droppedCommands?: string[];
      };
      expect(settlement.catalog.entries).toEqual(entries);
      expect(settlement.catalog.entries).toHaveLength(3);
      expect(settlement.droppedEntries).toBe(2);
      expect(settlement.droppedCommands).toEqual([
        "loom invalid",
        "page.broken",
      ]);
      expect(h.resolved()[0]).toMatchObject({
        settlement: { status: "executed", catalogEntries: 3 },
        result:
          "2 catalog entries were dropped as malformed: loom invalid, page.broken",
      });
      await h.finish();
    });

    it("compacts a generated maximum-size catalog while retaining requested details", async () => {
      const entries: HarnessCommandCatalogEntry[] = Array.from(
        { length: HARNESS_COMMAND_CATALOG_LIMIT },
        (_, index) => ({
          command: `generated.command-${index}`,
          summary: "Generated catalog entry",
          scope: "global",
          executes: "weaver",
          effect: "read",
          approval: "automatic",
          inputSchema: { type: "object", description: "x".repeat(256) },
        }),
      );
      expect(harnessCommandJsonBytes({ entries })).toBeGreaterThan(
        HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES,
      );
      const detail = entries.at(-1)!;
      const h = harness({
        calls: [{
          actions: [{
            kind: "list_commands",
            request: { detail: [detail.command] },
          }],
        }],
      });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = {
        sessionId: "s",
        actionId: "id-1",
        settlement: { status: "executed", catalog: { entries } },
      };
      const oversized = await h.answer({
        ...body,
        settlement: {
          status: "executed",
          catalog: {
            entries: [...entries, { ...detail, command: "generated.overflow" }],
          },
        },
      });
      expect(oversized.ok === false && oversized.error.code).toBe(
        "invalid_request",
      );
      expect(h.resolved()).toEqual([]);
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;
      const settlement = outcomesOf(h)[0].settlement as {
        catalog: { entries: HarnessCommandCatalogEntry[] };
        compacted: number;
      };
      expect(settlement.catalog.entries).toHaveLength(
        HARNESS_COMMAND_CATALOG_LIMIT,
      );
      expect(settlement.catalog.entries.map((entry) => entry.command)).toEqual(
        entries.map((entry) => entry.command),
      );
      expect(settlement.compacted).toBeGreaterThan(0);
      expect(settlement.catalog.entries.at(-1)).toEqual(detail);
      expect(
        settlement.catalog.entries.some((entry) => !("inputSchema" in entry)),
      )
        .toBe(true);
      const whole = settlement.catalog.entries.filter((entry) =>
        "inputSchema" in entry
      );
      expect(harnessCommandJsonBytes(whole)).toBeLessThanOrEqual(
        HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES,
      );
      expect(h.resolved()[0]).toMatchObject({
        settlement: {
          status: "executed",
          catalogEntries: HARNESS_COMMAND_CATALOG_LIMIT,
        },
      });
      await h.finish();
    });

    it("answers a version conflict as an executed command, not a broken channel", async () => {
      const h = harness({ calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      expect(
        (await h.answer(settle("resolve-executed-version-conflict", "id-1")))
          .ok,
      ).toBe(true);
      await h.callsDone;

      const settlement = outcomesOf(h)[0].settlement as {
        status: string;
        outcome: Record<string, unknown>;
        handle: string;
      };
      expect(settlement.status).toBe("executed");
      expect(settlement.outcome).toMatchObject({
        ok: false,
        transportStatus: 409,
        code: "version-conflict",
      });
      expect(
        (resolveReferentToken(h.table(), settlement.handle) as {
          provenance?: unknown;
        }).provenance,
      ).toEqual({
        command: "loom.move",
        actor: "user",
        loomActor: "user",
        loomId: "loom-0123456789abcdef",
        originLoomId: "loom-fedcba9876543210",
      });
      expect(
        h.resolved().map((e) =>
          e.kind === "client_action_resolved" && e.outcome
        ),
      )
        .toEqual(["done"]);
      await h.finish();
    });

    it("accepts an answer whose body was too large to keep, and holds nothing", async () => {
      const h = harness({ calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      // The fixture answers a person-approved write, as the mutation asks.
      expect(
        (await h.answer(settle("resolve-executed-body-omitted", "id-1"))).ok,
      ).toBe(true);
      await h.callsDone;

      const settlement = outcomesOf(h)[0].settlement as Record<
        string,
        unknown
      >;
      expect(settlement.handle).toBeUndefined();
      expect(settlement.outcome).toMatchObject({
        ok: true,
        bodyBytes: 400000,
        bodyOmitted: true,
      });
      expect(h.table().referents ?? []).toEqual([]);
      const [event] = h.resolved();
      expect(event.kind === "client_action_resolved" && event.settlement)
        .toMatchObject({
          status: "executed",
          outcome: { ok: true, bodyOmitted: true, bodyBytes: 400000 },
        });
      await h.finish();
    });

    it("keeps who sent a mutation whose answer was lost, and says it may have landed", async () => {
      const h = harness({ calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-failed-to-deliver", "id-1");
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;

      expect(outcomesOf(h)).toEqual([{
        action: mutation,
        settlement: body.settlement,
      }]);
      expect(h.resolved()).toEqual([{
        kind: "client_action_resolved",
        turnId: "t",
        actionId: "id-1",
        outcome: "failed",
        result: "the connection closed before the service answered",
        settlement: body.settlement,
      }]);
      await h.finish();
    });

    it("hands the model the person's decline with its attribution", async () => {
      const h = harness({ calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-declined", "id-1");
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;

      expect(outcomesOf(h)).toEqual([{
        action: mutation,
        settlement: body.settlement,
      }]);
      expect(h.resolved()).toEqual([{
        kind: "client_action_resolved",
        turnId: "t",
        actionId: "id-1",
        outcome: "declined",
        result: "not now",
        settlement: body.settlement,
      }]);
      await h.finish();
    });
  });

  describe("settlement", () => {
    it("shares one held result between concurrent identical answers", async () => {
      const minting = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      let mints = 0;
      const h = harness({
        beforeMint: () => {
          mints++;
          minting.resolve();
          return held.promise;
        },
      });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-executed-success", "id-1");
      const first = h.answer(body);
      await minting.promise;
      const second = h.answer(body);
      held.resolve();
      const answers = await Promise.all([first, second]);
      await h.callsDone;
      await h.finish();
      expect(answers.map((a) => a.ok)).toEqual([true, true]);
      expect(mints).toBe(1);
      expect(h.resolved()).toHaveLength(1);
    });

    it("applies an overdue timeout when holding a host's result fails", async () => {
      using time = new FakeTime();
      const minting = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const h = harness({
        idleMs: 10,
        beforeMint: () => {
          minting.resolve();
          return held.promise;
        },
      });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const answered = h.answer(settle("resolve-executed-success", "id-1"));
      const rejected = expect(answered).rejects.toThrow("holder failed");
      await minting.promise;
      await time.tickAsync(10);
      held.reject(new Error("holder failed"));
      await rejected;
      await h.callsDone;
      await h.finish();
      expect(h.resolved()).toMatchObject([{
        settlement: { status: "interrupted", reason: "timeout" },
      }]);
      const late = await h.answer(settle("resolve-executed-success", "id-1"));
      expect(late.ok === false && late.error.code).toBe("action_resolved");
    });

    for (const restart of [false, true]) {
      it(`refuses a changed catalog of the same size ${restart ? "after SQLite restart" : "on reconnect"}`, async () => {
        const path = await Deno.makeTempFile({ suffix: ".sqlite" });
        let store = await openSqliteHarnessChatSessionStore({
          url: toFileUrl(path),
        });
        try {
          const h = harness({
            sessionStore: store,
            calls: [{ actions: [catalog] }],
          });
          await h.start();
          await h.delivered(requestFor("id-1"));
          const body = settle("resolve-executed-catalog", "id-1");
          expect((await h.answer(body)).ok).toBe(true);
          await h.callsDone;
          await h.finish();
          let service = h.service;
          if (restart) {
            await store.close?.();
            store = await openSqliteHarnessChatSessionStore({
              url: toFileUrl(path),
            });
            service = new HarnessInteractiveChatService({
              sessionStore: store,
            });
            await service.initializeFromStore();
          }
          expect((await service.resolveClientAction("same", body)).ok).toBe(
            true,
          );
          const changed = structuredClone(body);
          if (
            changed.settlement.status !== "executed" ||
            !("catalog" in changed.settlement)
          ) {
            throw new Error("Expected a catalog fixture");
          }
          changed.settlement.catalog.entries[0].summary += " changed";
          const answer = await service.resolveClientAction(
            "different",
            changed,
          );
          expect(answer.ok === false && answer.error.code).toBe(
            "action_resolved",
          );
          expect(
            (await store.listEvents({ sessionId: "s" })).filter((e) =>
              e.event.kind === "client_action_resolved"
            ),
          ).toHaveLength(1);
        } finally {
          await store.close?.();
          await Deno.remove(path);
        }
      });
    }

    it("takes an answer given while its request is still being delivered, with one resolved event", async () => {
      const answered = Promise.withResolvers<{ ok: boolean }>();
      const h: ReturnType<typeof harness> = harness({
        deliver: async (event) => {
          if (requestFor("id-1")(event)) {
            answered.resolve(
              await h.answer(settle("resolve-executed-success", "id-1")),
            );
          }
        },
      });
      await h.start();
      await h.callsDone;
      expect((await answered.promise).ok).toBe(true);
      expect(h.resolved()).toHaveLength(1);
      expect(
        (outcomesOf(h)[0].settlement as { status: string }).status,
      ).toBe("executed");
      await h.finish();
    });

    it("accepts a resent settlement for an action the host already settled, without a second event", async () => {
      const h = harness();
      await h.start();
      await h.delivered(requestFor("id-1"));
      const body = settle("resolve-executed-success", "id-1");
      expect((await h.answer(body)).ok).toBe(true);
      expect((await h.answer(body)).ok).toBe(true);
      await h.callsDone;
      expect(h.resolved()).toHaveLength(1);
      // A final-action outcome for the same id is still a repeat.
      const word = await h.answer({
        sessionId: "s",
        actionId: "id-1",
        outcome: "done",
      });
      expect(word.ok === false && word.error.code).toBe("action_resolved");
      await h.finish();
    });

    it("refuses a different settlement for an action the host already settled", async () => {
      const h = harness();
      await h.start();
      await h.delivered(requestFor("id-1"));
      expect((await h.answer(settle("resolve-executed-success", "id-1"))).ok)
        .toBe(true);
      await h.callsDone;
      // A second answer that disagrees with the first is not a resend: the
      // host is told the action was settled, not that this answer was taken.
      const changed = await h.answer(settle("resolve-declined", "id-1"));
      expect(changed.ok === false && changed.error.code).toBe(
        "action_resolved",
      );
      const success = settle("resolve-executed-success", "id-1");
      const reordered = {
        ...success,
        settlement: Object.fromEntries(
          Object.entries(success.settlement).reverse(),
        ),
      };
      expect((await h.answer(reordered)).ok).toBe(true);
      expect(h.resolved()).toHaveLength(1);
      await h.finish();
    });

    it("does not take a resend as settled when the first answer's resolved event was never written", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(path),
      });
      let failNext = true;
      const failing = (
        event: HarnessChatEventEnvelope,
      ) => {
        if (failNext && event.event.kind === "client_action_resolved") {
          failNext = false;
          throw new Error("store down");
        }
      };
      const writes = new Set(["appendEvent", "saveSessionAndAppendEvent"]);
      const flaky = new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (writes.has(key as string)) {
              failing(args.at(-1) as HarnessChatEventEnvelope);
            }
            return value.apply(target, args);
          };
        },
      });
      try {
        const h = harness({ sessionStore: flaky });
        await h.start();
        await h.delivered(requestFor("id-1"));
        const body = settle("resolve-executed-success", "id-1");
        await expect(h.answer(body)).rejects.toThrow("store down");
        // Nothing records the settlement, so a resend is not told it was
        // taken; the action is settled in this process and stays so.
        const resend = await h.answer(body);
        expect(resend.ok === false && resend.error.code).toBe(
          "action_resolved",
        );
        expect(
          (await store.listEvents({ sessionId: "s" })).filter((e) =>
            e.event.kind === "client_action_resolved"
          ),
        ).toEqual([]);
        await h.finish();
      } finally {
        await store.close?.();
        await Deno.remove(path).catch(() => undefined);
      }
    });

    it("names an unknown action id", async () => {
      const h = harness();
      await h.start();
      await h.delivered(requestFor("id-1"));
      const unknown = await h.answer(
        settle("resolve-executed-success", "missing"),
      );
      expect(unknown.ok === false && unknown.error.code).toBe(
        "unknown_action",
      );
      expect((await h.answer(settle("resolve-executed-success", "id-1"))).ok)
        .toBe(true);
      await h.finish();
    });

    it("refuses an answer of the wrong form, or one that ran a person's command automatically", async () => {
      const h = harness({
        calls: [{
          actions: [mutation, catalog, {
            kind: "open_url",
            url: "https://example.com",
          }],
        }],
      });
      await h.start();
      await h.delivered(requestFor("id-2"));
      const refusals = [
        null,
        [],
        // A typed answer cannot settle a final-action kind.
        settle("resolve-executed-catalog", "id-3"),
        // A final-action outcome for a typed request.
        { sessionId: "s", actionId: "id-1", outcome: "done" },
        // An automatic read's answer for a command that asked for the person.
        settle("resolve-executed-success", "id-1"),
        // A catalog for a command request.
        settle("resolve-executed-catalog", "id-1"),
        // A command outcome for a catalog request.
        settle("resolve-executed-version-conflict", "id-2"),
        // A host never posts an interruption.
        {
          sessionId: "s",
          actionId: "id-1",
          settlement: { status: "interrupted", reason: "restart" },
        },
      ];
      for (const body of refusals) {
        const refused = await h.answer(body);
        expect(refused.ok === false && refused.error.code).toBe(
          "invalid_request",
        );
      }
      expect(h.resolved()).toEqual([]);
      expect((await h.answer(settle("resolve-declined", "id-1"))).ok).toBe(
        true,
      );
      expect((await h.answer(settle("resolve-executed-catalog", "id-2"))).ok)
        .toBe(true);
      expect(
        (await h.answer({ sessionId: "s", actionId: "id-3", outcome: "done" }))
          .ok,
      ).toBe(true);
      await h.callsDone;
      await h.finish();
    });

    it("settles a pending command as interrupted when the turn is canceled", async () => {
      const h = harness({ calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      // No event marks the call's switch from writing to waiting, so one
      // macrotask drain lets its own continuation finish before the cancel.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.service.handleRequest({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "c",
        method: "cancel_turn",
        params: { sessionId: "s", turnId: "t" },
      });
      await h.callsDone;
      expect(outcomesOf(h)).toEqual([{
        action: mutation,
        settlement: { status: "interrupted", reason: "canceled" },
      }]);
      expect(h.resolved()).toEqual([{
        kind: "client_action_resolved",
        turnId: "t",
        actionId: "id-1",
        outcome: "failed",
        result: "canceled",
        settlement: { status: "interrupted", reason: "canceled" },
      }]);
      const order = h.events.map((e) => e.event.kind);
      expect(order.lastIndexOf("client_action_resolved")).toBeLessThan(
        order.indexOf("turn_canceled"),
      );
      await h.finish();
    });

    it("keeps a host's answer that arrived before the idle timeout, even while its body is still being held", async () => {
      using time = new FakeTime();
      const minting = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const h = harness({
        idleMs: 10,
        beforeMint: () => {
          minting.resolve();
          return held.promise;
        },
      });
      await h.start();
      await h.delivered(requestFor("id-1"));
      const answered = h.answer(settle("resolve-executed-success", "id-1"));
      await minting.promise;
      // The clock runs out while the answer's body is being held.
      await time.tickAsync(10);
      held.resolve();
      expect((await answered).ok).toBe(true);
      await h.callsDone;
      const settlement = outcomesOf(h)[0].settlement as Record<string, unknown>;
      expect(settlement.status).toBe("executed");
      expect(settlement.handle).toMatch(/^cfh:v:/);
      expect(h.resolved()).toHaveLength(1);
      await h.finish();
    });

    it("leaves an action open when its body cannot be held, so a resend or the idle timeout settles it", async () => {
      using time = new FakeTime();
      let failures = 1;
      const h = harness({
        idleMs: 10,
        calls: [{ actions: [query, mutation] }],
        beforeMint: () =>
          failures-- > 0
            ? Promise.reject(new Error("handle table unavailable"))
            : Promise.resolve(),
      });
      await h.start();
      await h.delivered(requestFor("id-2"));
      const body = settle("resolve-executed-success", "id-1");
      await expect(h.answer(body)).rejects.toThrow("handle table unavailable");
      expect(h.resolved()).toEqual([]);
      expect((await h.answer(body)).ok).toBe(true);
      expect(h.resolved()).toHaveLength(1);
      // The other action, never answered, still times out.
      await time.tickAsync(10);
      await h.callsDone;
      expect(outcomesOf(h)[1].settlement).toEqual({
        status: "interrupted",
        reason: "timeout",
      });
      await h.finish();
    });

    it("settles a command nobody answered as interrupted by timeout", async () => {
      using time = new FakeTime();
      const h = harness({ idleMs: 10, calls: [{ actions: [mutation] }] });
      await h.start();
      await h.delivered(requestFor("id-1"));
      await time.tickAsync(10);
      await h.callsDone;
      expect(outcomesOf(h)).toEqual([{
        action: mutation,
        settlement: { status: "interrupted", reason: "timeout" },
      }]);
      // The host's late answer is not taken: the console settled it.
      const late = await h.answer(settle("resolve-declined", "id-1"));
      expect(late.ok === false && late.error.code).toBe("action_resolved");
      await h.finish();
    });
  });

  describe("request", () => {
    it("refuses non-object actions and invocations before delivery", async () => {
      let delivered = false;
      const context = {
        nextOutputId: () => "out",
        requestClientActions: () => {
          delivered = true;
          return Promise.resolve([]);
        },
      } as unknown as HarnessToolContext;
      for (
        const action of [null, 0, [], {
          kind: "invoke_command",
          invocation: null,
        }]
      ) {
        const result = await weaverActionTool.invoke(context, {
          actions: [action],
        } as never);
        expect(result).toMatchObject({
          status: "error",
          message: expect.stringContaining("weaver_action requires"),
        });
        expect(delivered).toBe(false);
      }
    });

    it("refuses a held answer when a later delivery already interrupted its command", async () => {
      const delivery = Promise.withResolvers<void>();
      const minting = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const h = harness({
        calls: [{ actions: [query, mutation] }],
        deliver: (event) =>
          requestFor("id-2")(event) ? delivery.promise : undefined,
        beforeMint: () => {
          minting.resolve();
          return held.promise;
        },
      });
      await h.start();
      await h.delivered(requestFor("id-2"));
      const answer = h.answer(settle("resolve-executed-success", "id-1"));
      await minting.promise;
      delivery.reject(new Error("sink down"));
      await h.delivered((event) =>
        event.kind === "client_action_resolved" && event.actionId === "id-1"
      );
      held.resolve();
      const refused = await answer;
      expect(refused.ok === false && refused.error.code).toBe(
        "action_resolved",
      );
      await h.delivered((event) =>
        event.kind === "client_action_resolved" && event.actionId === "id-2"
      );
      expect(h.resolved()).toHaveLength(2);
      expect(h.resolved()[0].settlement).toEqual({
        status: "interrupted",
        reason: "delivery_failed",
      });
      await h.finish();
    });

    it("refuses deeply nested and non-JSON args without throwing or delivering an action", async () => {
      let deep: Record<string, unknown> = {};
      for (let i = 0; i < 20000; i++) deep = { child: deep };
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      for (
        const args of [deep, cycle, { value: 1n }, { value: NaN }, {
          value: new Date(),
        }]
      ) {
        let delivered = false;
        const result = await weaverActionTool.invoke({
          nextOutputId: () => "out",
          requestClientActions: () => {
            delivered = true;
            return Promise.resolve([]);
          },
        } as unknown as HarnessToolContext, {
          actions: [{
            kind: "invoke_command",
            invocation: {
              command: "loom.inspect",
              args,
              approval: "automatic",
            },
          }],
        });
        expect(result.status).toBe("error");
        expect(result).toMatchObject({
          message: expect.stringContaining("weaver_action requires"),
        });
        expect(delivered).toBe(false);
      }
    });

    it("settles a delivered command as interrupted when a later delivery in its batch fails, and the failed one as not delivered", async () => {
      const h = harness({
        calls: [{ actions: [mutation, query, catalog] }],
        deliver: (event) => {
          if (requestFor("id-2")(event)) throw new Error("sink down");
        },
      });
      await h.start();
      await h.delivered((event) =>
        event.kind === "client_action_resolved" && event.actionId === "id-2"
      );
      expect(
        h.events.filter((e) => e.event.kind === "client_action_requested")
          .map((e) => (e.event as { actionId: string }).actionId),
      ).toEqual(["id-1", "id-2"]);
      expect(
        h.resolved().map((event) => [
          (event as { actionId: string }).actionId,
          (event as { settlement?: unknown }).settlement,
        ]),
      ).toEqual([
        // Delivered, and possibly already running: nothing says it did not
        // land.
        ["id-1", { status: "interrupted", reason: "delivery_failed" }],
        ["id-2", {
          status: "failed_to_deliver",
          reason: "not delivered",
          landed: "no",
        }],
      ]);
      await h.finish();
    });

    it("refuses args larger than the request limit before anything is delivered", async () => {
      const big = {
        kind: "invoke_command",
        invocation: {
          command: "page.write",
          args: { text: "x".repeat(HARNESS_COMMAND_ARGS_MAX_BYTES) },
          approval: "person",
        },
      };
      const h = harness({ calls: [{ actions: [query, big] }] });
      await h.start();
      await h.callsDone;
      expect(h.toolResults).toEqual([{
        outputId: "out-1",
        status: "error",
        message: expect.stringContaining(
          `larger than ${HARNESS_COMMAND_ARGS_MAX_BYTES} bytes`,
        ),
      }]);
      expect(h.events.some((e) => e.event.kind === "client_action_requested"))
        .toBe(false);
      await h.finish();
    });
  });

  describe("restart", () => {
    it("refuses to recognize a catalog resend from a legacy log without its identity", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(path),
      });
      try {
        const h = harness({
          sessionStore: store,
          calls: [{ actions: [catalog] }],
        });
        await h.start();
        await h.delivered(requestFor("id-1"));
        const body = settle("resolve-executed-catalog", "id-1");
        expect((await h.answer(body)).ok).toBe(true);
        await h.callsDone;
        await h.finish();
        const snapshot = await store.getSession("s");
        if (snapshot === undefined) {
          throw new Error("Expected a stored session");
        }
        const { clientActionCatalogAnswers: _answers, ...legacy } = snapshot;
        await store.saveSession(legacy);
        const restored = new HarnessInteractiveChatService({
          sessionStore: store,
        });
        await restored.initializeFromStore();
        const answer = await restored.resolveClientAction("legacy", body);
        expect(answer.ok === false && answer.error.code).toBe(
          "action_resolved",
        );
        expect(
          (await store.listEvents({ sessionId: "s" })).filter((e) =>
            e.event.kind === "client_action_resolved"
          ),
        ).toHaveLength(1);
      } finally {
        await store.close?.();
        await Deno.remove(path);
      }
    });

    it("settles a command left open as interrupted, never replaying it, and keeps a host's settlement resendable", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(path),
      });
      try {
        const h = harness({
          sessionStore: store,
          calls: [{ actions: [query, mutation] }],
        });
        await h.start();
        await h.delivered(requestFor("id-2"));
        expect((await h.answer(settle("resolve-executed-success", "id-1"))).ok)
          .toBe(true);
        // The process dies here, with the mutation unanswered.

        const never = Promise.withResolvers<never>();
        const restored = new HarnessInteractiveChatService({
          sessionStore: store,
          createPromptLoop: () => ({ runTranscript: () => never.promise }),
        });
        await restored.initializeFromStore();
        const resolved = (await store.listEvents({ sessionId: "s" }))
          .map((e) => e.event)
          .filter((e) => e.kind === "client_action_resolved");
        expect(resolved).toHaveLength(2);
        const expected = resolvedFixtureEvent("resolved-event-interrupted");
        expect(resolved[1]).toEqual({
          ...expected,
          turnId: "t",
          actionId: "id-2",
        });
        expect(
          (await store.listEvents({ sessionId: "s" })).filter((e) =>
            e.event.kind === "client_action_requested"
          ),
        ).toHaveLength(2);

        // A client that reconnects resends what it settled, which is taken
        // without effect; its answer to the interrupted command is not.
        const resend = await restored.resolveClientAction(
          "r1",
          settle("resolve-executed-success", "id-1"),
        );
        expect(resend.ok).toBe(true);
        const changed = await restored.resolveClientAction(
          "r3",
          settle("resolve-executed-version-conflict", "id-1"),
        );
        expect(changed.ok === false && changed.error.code).toBe(
          "action_resolved",
        );
        const late = await restored.resolveClientAction(
          "r2",
          settle("resolve-declined", "id-2"),
        );
        expect(late.ok === false && late.error.code).toBe("action_resolved");
        expect(
          (await store.listEvents({ sessionId: "s" })).filter((e) =>
            e.event.kind === "client_action_resolved"
          ),
        ).toHaveLength(2);
      } finally {
        await store.close?.();
        await Deno.remove(path).catch(() => undefined);
      }
    });
  });
});
