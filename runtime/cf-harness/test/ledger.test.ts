import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  deployedPieceRef,
  PatternIndexClient,
  type PatternIndexPublishRequest,
} from "@commonfabric/pattern-index/client";
import { Identity } from "@commonfabric/identity";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";

import {
  createPatternIndexLedger,
  patternCapabilityKey,
} from "../src/pattern-index/ledger.ts";

const signer = await Identity.fromPassphrase("cf-harness pattern index ledger");

interface RecordedCall {
  fn: string;
  body: Record<string, unknown>;
}

/**
 * A stub index whose `settled` resolves when a function has ANSWERED, not
 * when a wall-clock delay has passed. The ledger deliberately does not await
 * its own publications, so the call answering is the only event a test can
 * hang on for one — and it is a real event, which is what
 * `docs/development/waiting-in-tests.md` asks for in place of a sleep.
 */
const stubClient = (
  options: {
    fail?: boolean;
    created?: boolean;
    failFirstEvent?: boolean;
    /**
     * What `getPattern` answers per id: the caller's, someone else's, one
     * from a deployment that does not say whose, or an HTTP status for an id
     * it cannot answer for. An id not listed is one the index does not hold.
     */
    patterns?: Record<string, "mine" | "theirs" | "unsaid" | number>;
  } = {},
) => {
  const calls: RecordedCall[] = [];
  const waiters: { fn: string; count: number; resolve: () => void }[] = [];
  const answered: Record<string, number> = {};
  const announce = (fn: string) => {
    answered[fn] = (answered[fn] ?? 0) + 1;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.fn === fn && answered[fn] >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    const answer = (response: Response): Promise<Response> => {
      announce(fn);
      return Promise.resolve(response);
    };
    if (
      fn === "recordEvent" && options.failFirstEvent === true &&
      calls.filter((call) => call.fn === "recordEvent").length === 1
    ) {
      return answer(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    }
    if (fn === "getPattern") {
      const known = options.patterns?.[String(body.patternId)] ?? 404;
      return answer(
        typeof known === "number"
          ? new Response(JSON.stringify({ error: "no answer" }), {
            status: known,
          })
          : new Response(
            JSON.stringify({
              patternId: body.patternId,
              createdAt: "2026-11-17T00:00:00.000Z",
              description: "Sortable table",
              hashtags: ["table"],
              dependencies: [],
              // As the index answers: an author for every reader of a
              // deployment that keeps lineages, and `mine` for its owner only.
              ...(known === "unsaid"
                ? {}
                : { author: { pseudonym: "quiet-otter", tier: 0 } }),
              ...(known === "mine" ? { mine: true } : {}),
            }),
            { status: 200 },
          ),
      );
    }
    if (fn === "publishPattern" && options.fail === true) {
      return answer(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    }
    return answer(
      new Response(
        JSON.stringify(
          fn === "publishPattern"
            ? { patternId: body.patternId, created: options.created ?? true }
            : { ok: true },
        ),
        { status: 200 },
      ),
    );
  };
  const client = new PatternIndexClient({
    baseUrl: "https://index.test",
    fetchFn,
    signer,
  });
  return {
    calls,
    getClient: () => Promise.resolve(client),
    settled(fn: string, count: number): Promise<void> {
      if ((answered[fn] ?? 0) >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ fn, count, resolve });
      });
    },
  };
};

const request = (
  patternId: string,
  overrides: Partial<PatternIndexPublishRequest> = {},
): PatternIndexPublishRequest => ({
  patternId,
  description: "Sortable table",
  hashtags: ["table"],
  directQuery: "build me a sortable table",
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: `// ${patternId}` }],
  },
  discoverable: true,
  ...overrides,
});

const publishes = (calls: RecordedCall[]) =>
  calls.filter((call) => call.fn === "publishPattern");

const eventTypes = (calls: RecordedCall[]) =>
  calls.filter((call) => call.fn === "recordEvent").map((call) =>
    call.body.eventType
  );

describe("pattern index ledger", () => {
  describe("patternCapabilityKey()", () => {
    it("reads two spellings of one description as one capability", () => {
      expect(patternCapabilityKey(request("a"))).toBe(
        patternCapabilityKey(
          request("b", { description: "  Sortable   TABLE " }),
        ),
      );
    });

    it("does not care what order the hashtags arrived in", () => {
      expect(
        patternCapabilityKey(request("a", { hashtags: ["table", "sort"] })),
      ).toBe(
        patternCapabilityKey(request("b", { hashtags: ["Sort", "Table"] })),
      );
    });

    it("separates two capabilities described differently", () => {
      expect(patternCapabilityKey(request("a"))).not.toBe(
        patternCapabilityKey(request("b", { description: "Doubles a number" })),
      );
    });
  });

  describe("stage() and flush()", () => {
    it("publishes nothing until the session ends", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("one"));
      expect(publishes(calls)).toEqual([]);
      await ledger.flush();
      expect(publishes(calls)).toHaveLength(1);
    });

    it("offers search the last of a capability's iterations and records the rest", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(request("second"));
      ledger.stage(request("third"));
      await ledger.flush();

      const sent = publishes(calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "first",
        "second",
        "third",
      ]);
      // Every iteration is recorded; one of them is discoverable.
      expect(sent.map((call) => call.body.discoverable)).toEqual([
        false,
        false,
        true,
      ]);
      expect(sent[0].body.discoverabilityReason).toContain("superseded");
    });

    it("publishes a displaced iteration as soon as it is displaced", async () => {
      // Only the latest of each capability is at risk if the session dies, so
      // the displaced one has to be gone BEFORE the flush — measured before
      // it, since after it the two sends are indistinguishable.
      const { calls, getClient, settled } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(request("second"));
      // `stage` does not await, so the displaced send rides the ledger's own
      // chain. Waiting on that call ANSWERING is the event; a wall-clock
      // delay would be guessing at how long the chain takes, which is how
      // this test first failed in CI and passed here.
      await settled("publishPattern", 1);
      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "first",
      ]);
      await ledger.flush();
      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "first",
        "second",
      ]);
    });

    it("offers search each of a session's distinct capabilities", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("table"));
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      await ledger.flush();

      expect(publishes(calls).map((call) => call.body.discoverable)).toEqual([
        true,
        true,
      ]);
    });

    it("keeps a render gate's own reason on an entry that is also superseded", async () => {
      // What a person reads later should say what was found. Being displaced
      // is the less informative of the two facts.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(
        request("first", {
          nonDiscoverable: { reason: "render gate: broken" },
        }),
      );
      ledger.stage(request("second"));
      await ledger.flush();

      expect(publishes(calls)[0].body.discoverabilityReason).toBe(
        "render gate: broken",
      );
    });

    it("publishes a held dependency before the entry that composes it", async () => {
      // The index refuses a publication naming a dependency it does not
      // hold, so a session composing an atom it authored earlier has to send
      // that atom first.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      ledger.stage(
        request("quadrupler", {
          description: "Quadruples a number",
          dependencies: ["doubler"],
        }),
      );
      await ledger.flush();

      const sent = publishes(calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "doubler",
        "quadrupler",
      ]);
      // A dependency is not superseded — something composes it, so it is a
      // part of this session's output in its own right.
      expect(sent[0].body.discoverable).toBe(true);
    });

    it("names a dependency-published entry as the lineage of its next iteration", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("first"));
      ledger.stage(
        request("other", {
          description: "Something else",
          dependencies: ["first"],
        }),
      );
      ledger.stage(request("second"));
      await ledger.flush();

      const second = publishes(calls).find((call) =>
        call.body.patternId === "second"
      );
      expect(second?.body.priorPatternId).toBe("first");
    });

    it("publishes a request whose dependency it does not hold", async () => {
      // Nothing here produces a cycle — a dependency is the content-addressed
      // identity of something that already compiled — but a request naming a
      // dependency this session never staged must still be sent rather than
      // held forever waiting for its turn.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(
        request("composite", { dependencies: ["never-staged-here"] }),
      );
      await ledger.flush();
      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "composite",
      ]);
    });

    it("publishes requests that name each other rather than holding them forever", async () => {
      // Content-addressed identities cannot form a cycle — a dependency
      // compiled before the thing that imports it — so this shape does not
      // arise. The ordering does not assume that: what it cannot order it
      // still sends, because holding a contribution forever is worse than
      // sending it in an order the index may refuse.
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(
        request("one", { description: "One", dependencies: ["two"] }),
      );
      ledger.stage(
        request("two", { description: "Two", dependencies: ["one"] }),
      );
      await ledger.flush();
      expect(publishes(calls).map((call) => call.body.patternId).sort())
        .toEqual(["one", "two"]);
    });

    it("reports a failed publication without throwing it at the session", async () => {
      const errors: string[] = [];
      const { getClient } = stubClient({ fail: true });
      const ledger = createPatternIndexLedger(getClient, {
        onError: (message) => errors.push(message),
      });
      ledger.stage(request("one"));
      await ledger.flush();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("could not publish");
    });

    it("records a created event for an entry the index did not hold", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("one"));
      await ledger.flush();
      expect(
        calls.filter((call) => call.fn === "recordEvent").map((call) =>
          call.body.eventType
        ),
      ).toEqual(["created"]);
    });

    it("records no created event for an entry the index already held", async () => {
      const { calls, getClient } = stubClient({ created: false });
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(request("one"));
      await ledger.flush();
      expect(calls.filter((call) => call.fn === "recordEvent")).toEqual([]);
    });

    it("publishes a dependency first even when it was staged second", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.stage(
        request("composite", {
          description: "Composes the doubler",
          dependencies: ["doubler"],
        }),
      );
      ledger.stage(request("doubler", { description: "Doubles a number" }));
      await ledger.flush();

      expect(publishes(calls).map((call) => call.body.patternId)).toEqual([
        "doubler",
        "composite",
      ]);
    });
  });

  describe("record() and flush()", () => {
    it("sends an event without the caller waiting for it", async () => {
      const { calls, getClient } = stubClient();
      const ledger = createPatternIndexLedger(getClient);
      ledger.record("pat-doubler", "instantiated");
      expect(calls).toEqual([]);
      await ledger.flush();
      expect(eventTypes(calls)).toEqual(["instantiated"]);
    });

    it("reports a refused event without throwing it at the session", async () => {
      const errors: string[] = [];
      const { getClient } = stubClient({ failFirstEvent: true });
      const ledger = createPatternIndexLedger(getClient, {
        onError: (message) => errors.push(message),
      });
      ledger.record("pat-doubler", "run_succeeded");
      await ledger.flush();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("could not record the run_succeeded event");
      expect(errors[0]).toContain("pat-doubler");
    });

    it("sends the event written after one the index refused", async () => {
      const errors: string[] = [];
      const { calls, getClient } = stubClient({ failFirstEvent: true });
      const ledger = createPatternIndexLedger(getClient, {
        onError: (message) => errors.push(message),
      });
      ledger.record("pat-doubler", "instantiated");
      ledger.record("pat-doubler", "run_succeeded");
      await ledger.flush();
      expect(eventTypes(calls)).toEqual(["instantiated", "run_succeeded"]);
    });
  });

  describe("version history", () => {
    /**
     * Which history the index files each publication in, by the order it
     * applies for a client that sends an origin: a slot, then a
     * `priorPatternId` naming one of the caller's own versions, with a remix
     * always starting a new one, else a new history. `foreign` are versions
     * someone else wrote. The model binds the tests to that rule rather than
     * to the request fields that satisfy it, so a change to the rule changes
     * it here too.
     */
    const historiesOf = (
      sent: RecordedCall[],
      foreign: readonly string[] = [],
    ): Map<string, string> => {
      const bySlot = new Map<string, string>();
      const byPattern = new Map<string, string>();
      let next = 0;
      for (const { body } of sent) {
        const slot = typeof body.slot === "string" ? body.slot : undefined;
        const prior = typeof body.priorPatternId === "string"
          ? body.priorPatternId
          : undefined;
        let history: string;
        if (slot !== undefined) {
          history = bySlot.get(slot) ?? `history-${next++}`;
          bySlot.set(slot, history);
        } else if (
          body.remixedFrom === undefined && prior !== undefined &&
          !foreign.includes(prior) && byPattern.has(prior)
        ) {
          history = byPattern.get(prior)!;
        } else {
          history = `history-${next++}`;
        }
        byPattern.set(String(body.patternId), history);
      }
      return byPattern;
    };

    /** The key `run_pattern` sends for a piece, one per piece. */
    const piece = (name: string) =>
      deployedPieceRef("did:key:z6MkLedgerTestSpace", `fid1:${name}`);

    const agentRequest = (patternId: string, deployedTo: string) =>
      request(patternId, { origin: "agent", slot: deployedTo, deployedTo });

    it("files a later run's revision of the caller's own pattern in that pattern's history", async () => {
      const index = stubClient({ patterns: { "v1": "mine" } });
      const firstRun = createPatternIndexLedger(index.getClient);
      firstRun.stage(agentRequest("v1", piece("one")));
      await firstRun.flush();

      const laterRun = createPatternIndexLedger(index.getClient);
      laterRun.stage(agentRequest("v2", piece("two")), { revisedFrom: "v1" });
      await laterRun.flush();

      const sent = publishes(index.calls);
      const histories = historiesOf(sent);
      expect(histories.get("v2")).toBe(histories.get("v1"));
      const revision = sent[1].body;
      expect(revision.priorPatternId).toBe("v1");
      expect(revision.remixedFrom).toBeUndefined();
      // Still names the piece it was deployed to, which is how the person's
      // use of that piece finds this version.
      expect(revision.deployedTo).toBe(piece("two"));
    });

    it("credits a revision of someone else's pattern as a remix with a history of its own", async () => {
      const index = stubClient({ patterns: { "theirs": "theirs" } });
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("mine", piece("one")), {
        revisedFrom: "theirs",
      });
      await ledger.flush();

      const [remix] = publishes(index.calls);
      expect(remix.body.remixedFrom).toBe("theirs");
      expect(remix.body.priorPatternId).toBeUndefined();
      expect(remix.body.slot).toBe(piece("one"));
      expect(historiesOf([remix], ["theirs"]).get("mine")).toBeDefined();
    });

    it("starts a new history for a new pattern, beside an existing one", async () => {
      const index = stubClient({ patterns: { "v1": "mine" } });
      const firstRun = createPatternIndexLedger(index.getClient);
      firstRun.stage(agentRequest("v1", piece("one")));
      await firstRun.flush();

      const laterRun = createPatternIndexLedger(index.getClient);
      laterRun.stage(agentRequest("unrelated", piece("two")));
      await laterRun.flush();

      const sent = publishes(index.calls);
      const histories = historiesOf(sent);
      expect(histories.get("unrelated")).not.toBe(histories.get("v1"));
      expect(sent[1].body.priorPatternId).toBeUndefined();
      expect(sent[1].body.remixedFrom).toBeUndefined();
      // Nothing was revised, so nothing was asked about.
      expect(index.calls.some((call) => call.fn === "getPattern")).toBe(
        false,
      );
    });

    it("names no predecessor the index does not hold", async () => {
      const index = stubClient();
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("v2", piece("two")), {
        revisedFrom: "never-indexed",
      });
      await ledger.flush();

      const [sent] = publishes(index.calls);
      expect(sent.body.priorPatternId).toBeUndefined();
      expect(sent.body.remixedFrom).toBeUndefined();
      expect(sent.body.slot).toBe(piece("two"));
    });

    it("names no predecessor when the index does not say whose it is", async () => {
      const index = stubClient({ patterns: { "v1": "unsaid" } });
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("v2", piece("two")), { revisedFrom: "v1" });
      await ledger.flush();

      const [sent] = publishes(index.calls);
      expect(sent.body.priorPatternId).toBeUndefined();
      expect(sent.body.remixedFrom).toBeUndefined();
      expect(sent.body.slot).toBe(piece("two"));
    });

    it("files a revision in the history of what it revised, not of a capability described the same way", async () => {
      const index = stubClient({ patterns: { "older": "mine" } });
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("fresh", piece("one")));
      ledger.stage(agentRequest("revision", piece("two")), {
        revisedFrom: "older",
      });
      await ledger.flush();

      const sent = publishes(index.calls);
      const revision = sent.find((call) => call.body.patternId === "revision");
      expect(revision?.body.priorPatternId).toBe("older");
    });

    it("continues a pattern this session made without asking whose it is, sending it first", async () => {
      const index = stubClient();
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("made-here", piece("one")));
      // Described differently, so only `revisedFrom` links the two.
      ledger.stage(
        request("revision", {
          description: "Sortable table, revised",
          origin: "agent",
          slot: piece("two"),
          deployedTo: piece("two"),
        }),
        { revisedFrom: "made-here" },
      );
      await ledger.flush();

      const sent = publishes(index.calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "made-here",
        "revision",
      ]);
      expect(historiesOf(sent).get("revision")).toBe(
        historiesOf(sent).get("made-here"),
      );
      expect(index.calls.some((call) => call.fn === "getPattern")).toBe(
        false,
      );
    });

    it("supersedes an iteration it revised in place, rather than sending it as a part in its own right", async () => {
      const index = stubClient();
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("before", piece("one")));
      ledger.stage(agentRequest("after", piece("one")), {
        revisedFrom: "before",
      });
      await ledger.flush();

      const sent = publishes(index.calls);
      expect(sent.map((call) => call.body.patternId)).toEqual([
        "before",
        "after",
      ]);
      expect(sent[0].body.discoverabilityReason).toContain("superseded");
      expect(sent[1].body.priorPatternId).toBe("before");
    });

    it("describes a revision that brings no description as its predecessor was", async () => {
      const index = stubClient({ patterns: { "v1": "mine" } });
      const ledger = createPatternIndexLedger(index.getClient);
      const { description: _d, hashtags: _h, ...undescribed } = request("v2");
      ledger.stage(undescribed, { revisedFrom: "v1" });
      await ledger.flush();

      const [sent] = publishes(index.calls);
      expect(sent.body.meta).toMatchObject({ description: "Sortable table" });
      expect(sent.body.meta).toMatchObject({
        hashtags: [
          "table",
        ],
      });
      expect(sent.body.priorPatternId).toBe("v1");
    });

    it("describes a revision of this session's own entry from what it staged, without asking", async () => {
      const index = stubClient();
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(request("v1", { description: "Doubles a number" }));
      const { description: _d, hashtags: _h, ...undescribed } = request("v2");
      ledger.stage(undescribed, { revisedFrom: "v1" });
      await ledger.flush();

      const sent = publishes(index.calls);
      expect(sent[1].body.meta).toMatchObject({
        description: "Doubles a number",
      });
      expect(sent[1].body.priorPatternId).toBe("v1");
      expect(index.calls.some((call) => call.fn === "getPattern")).toBe(
        false,
      );
    });

    it("sends no revision nobody can describe, and says so", async () => {
      const index = stubClient();
      const errors: string[] = [];
      const ledger = createPatternIndexLedger(index.getClient, {
        onError: (message) => errors.push(message),
      });
      const { description: _d, hashtags: _h, ...undescribed } = request("v2");
      ledger.stage(undescribed, { revisedFrom: "never-indexed" });
      await ledger.flush();

      expect(publishes(index.calls)).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("v2");
    });

    it("refuses a request with no description and nothing to take one from", () => {
      const ledger = createPatternIndexLedger(stubClient().getClient);
      const { description: _d, hashtags: _h, ...undescribed } = request("v2");
      expect(() => ledger.stage(undescribed)).toThrow("no description");
    });

    it("asks the index about a predecessor this session sent but the index refused", async () => {
      const index = stubClient({ fail: true });
      const ledger = createPatternIndexLedger(index.getClient, {
        onError: () => {},
      });
      ledger.stage(agentRequest("refused", piece("one")));
      ledger.stage(
        request("revision", {
          description: "Sortable table, revised",
          origin: "agent",
          slot: piece("two"),
          deployedTo: piece("two"),
        }),
        { revisedFrom: "refused" },
      );
      await ledger.flush();

      const revision = publishes(index.calls).find((call) =>
        call.body.patternId === "revision"
      );
      // Not known to be stored, so not named as a predecessor on trust.
      expect(revision?.body.priorPatternId).toBeUndefined();
      expect(index.calls.some((call) => call.fn === "getPattern")).toBe(true);
    });

    it("publishes a described request that names no hashtags under none", async () => {
      const index = stubClient();
      const ledger = createPatternIndexLedger(index.getClient);
      const { hashtags: _h, ...untagged } = request("v1");
      ledger.stage(untagged);
      await ledger.flush();

      const [sent] = publishes(index.calls);
      expect(sent.body.meta).toMatchObject({ hashtags: [] });
    });

    it("names no predecessor whose owner it could not learn, and says so", async () => {
      const index = stubClient({ patterns: { "v1": 500 } });
      const errors: string[] = [];
      const ledger = createPatternIndexLedger(index.getClient, {
        onError: (message) => errors.push(message),
      });
      ledger.stage(agentRequest("v2", piece("two")), { revisedFrom: "v1" });
      await ledger.flush();

      const [sent] = publishes(index.calls);
      expect(sent.body.priorPatternId).toBeUndefined();
      expect(sent.body.remixedFrom).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("v1");
    });

    it("files every iteration of one session's capability in one history, each deployed to its own piece", async () => {
      const index = stubClient({ patterns: { "theirs": "theirs" } });
      const ledger = createPatternIndexLedger(index.getClient);
      ledger.stage(agentRequest("first", piece("one")), {
        revisedFrom: "theirs",
      });
      ledger.stage(agentRequest("second", piece("two")), {
        revisedFrom: "theirs",
      });
      ledger.stage(agentRequest("third", piece("three")));
      await ledger.flush();

      const sent = publishes(index.calls);
      const histories = historiesOf(sent, ["theirs"]);
      expect(histories.get("second")).toBe(histories.get("first"));
      expect(histories.get("third")).toBe(histories.get("first"));
      // The first iteration carries the remix credit; the rest continue it.
      expect(sent[0].body.remixedFrom).toBe("theirs");
      expect(sent.slice(1).map((call) => call.body.remixedFrom)).toEqual([
        undefined,
        undefined,
      ]);
      expect(sent.map((call) => call.body.deployedTo)).toEqual([
        piece("one"),
        piece("two"),
        piece("three"),
      ]);
      // Only the first was revised from something outside this session.
      expect(
        index.calls.filter((call) => call.fn === "getPattern"),
      ).toHaveLength(1);
    });
  });
});
