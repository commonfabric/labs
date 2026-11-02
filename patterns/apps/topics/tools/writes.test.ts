import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Saved, WriteOutcome, WriteRequest } from "./browser.ts";
import {
  describe as describeWrite,
  mergeSaved,
  type Told,
  Writes,
} from "./writes.ts";

const NOW = 1_000;

/** What the browser remembers, with `since` as given. */
function state(since: number): Saved {
  return {
    since,
    seen: { "1": 5 },
    drafts: {},
    pending: {},
    dropped: {},
    hideSettled: false,
  };
}
const COMMENT: WriteRequest = { verb: "comment", topic: "1", text: "Hi." };

describe("writes", () => {
  let saved: Saved;
  let told: Told[];
  let outcomes: (WriteOutcome | Error)[];
  let sent: { request: WriteRequest; agentName: string; invocation: string }[];
  let saves: number;
  let held: Promise<void> | undefined;
  let saving: Promise<void>;
  let writes: Writes;

  beforeEach(() => {
    saved = {
      since: 0,
      seen: {},
      drafts: {},
      pending: {},
      dropped: {},
      hideSettled: true,
    };
    told = [];
    outcomes = [];
    sent = [];
    saves = 0;
    held = undefined;
    saving = Promise.resolve();
    writes = new Writes({
      saved,
      async write(request, agentName, invocation) {
        sent.push({ request, agentName, invocation });
        await held;
        const outcome = outcomes.shift() ??
          { result: "written", report: "Done." };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      save: () => void saves++,
      persisted: () => saving,
      now: () => NOW,
      tell: (told_) => void told.push(told_),
    });
  });

  /** Waits for every write under way. */
  async function settled(): Promise<void> {
    await writes.finish(new Promise(() => {}));
  }

  describe("Writes", () => {
    it("forgets a write that landed, saying so, and the draft it saved", async () => {
      writes.keepDraft("comment:1", ["Hi."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");

      expect(Object.values(saved.pending)).toEqual([{
        request: COMMENT,
        agentName: "Sol (agent)",
        attempts: 1,
        at: NOW + 1,
        draft: { key: "comment:1", fields: ["Hi."], base: "" },
      }]);
      expect(saved.drafts).toEqual({});
      expect(writes.busy).toBe(1);

      await settled();

      expect(sent.map((s) => s.agentName)).toEqual(["Sol (agent)"]);
      expect(saved.pending).toEqual({});
      expect(writes.busy).toBe(0);
      expect(told.at(-1)).toEqual({
        kind: "note",
        text: "Done.",
        error: false,
      });
      expect(saved.dropped).toEqual({
        "comment:1": { at: NOW, when: NOW },
        // Stamped again as it was sent.
        [sent[0].invocation]: { at: NOW + 1, when: NOW },
      });
      expect(saves).toBeGreaterThan(0);
    });

    it("gives the draft back when the first attempt certainly failed", async () => {
      outcomes = [{ result: "failed", message: "No such Topic.\nMore." }];
      writes.keepDraft("comment:1", ["Hi."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");
      await settled();

      expect(saved.pending).toEqual({});
      expect(saved.drafts["comment:1"]?.fields).toEqual(["Hi."]);
      expect(told.at(-1)).toEqual({
        kind: "note",
        text: "Could not finish commenting on top/1: No such Topic. " +
          "Your draft is kept.",
        error: true,
      });
    });

    it("keeps a newer draft over the one a failed write gives back", async () => {
      outcomes = [{ result: "failed", message: "No." }];
      held = Promise.resolve();
      writes.keepDraft("comment:1", ["Old."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");
      writes.keepDraft("comment:1", ["Newer."], "");
      await settled();

      expect(saved.drafts["comment:1"]?.fields).toEqual(["Newer."]);
    });

    it("keeps a write that may have landed, and settles it under the same invocation", async () => {
      outcomes = [{ result: "unsettled", message: "Lost the answer." }];
      writes.write(COMMENT, "Sol (agent)");
      await settled();
      const [[invocation, pending]] = writes.pending();

      expect(pending.failure).toBe("Lost the answer.");
      expect(told.at(-1)).toEqual({
        kind: "unsettled",
        invocation,
        text: "Commenting on top/1 may not have finished; " +
          "File ▸ Unfinished writes settles it.",
      });

      writes.send(invocation);
      await settled();

      expect(sent.map((s) => s.invocation)).toEqual([invocation, invocation]);
      expect(saved.pending).toEqual({});
    });

    it("keeps a write whose later attempt failed, since an earlier one may have landed", async () => {
      outcomes = [
        { result: "unsettled", message: "Lost." },
        { result: "failed", message: "Offline." },
      ];
      writes.write(COMMENT, "Sol (agent)");
      await settled();
      const [[invocation]] = writes.pending();
      writes.send(invocation);
      await settled();

      expect(saved.pending[invocation]).toMatchObject({
        attempts: 2,
        failure: "Offline.",
      });
    });

    it("takes a host that throws as a write that may have landed", async () => {
      outcomes = [new Error("The host went away.")];
      writes.write(COMMENT, "Sol (agent)");
      await settled();

      expect(writes.pending().map(([, p]) => p.failure)).toEqual([
        "The host went away.",
      ]);
    });

    it("forgets a write that landed and reads back otherwise, saying so as an error", async () => {
      outcomes = [{ result: "unconfirmed", message: "It reads back.\nAs X." }];
      writes.write(COMMENT, "Sol (agent)");
      await settled();

      expect(saved.pending).toEqual({});
      expect(told.at(-1)).toEqual({
        kind: "note",
        text: "Commenting on top/1 landed, but It reads back.",
        error: true,
      });
    });

    it("makes a write only once it is saved, giving the draft back when it cannot be", async () => {
      saving = Promise.reject(new Error("Disk full."));
      writes.keepDraft("comment:1", ["Hi."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");
      await settled();

      expect(sent).toEqual([]);
      expect(saved.pending).toEqual({});
      expect(saved.drafts["comment:1"]?.fields).toEqual(["Hi."]);
      expect(told.at(-1)).toMatchObject({
        text: expect.stringContaining(
          "It could not be saved first: Disk full.",
        ),
        error: true,
      });
    });

    it("says only how a write went that another browser settled meanwhile", async () => {
      outcomes = [{ result: "failed", message: "Offline." }];
      const release = Promise.withResolvers<void>();
      held = release.promise;
      writes.keepDraft("comment:1", ["Hi."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");
      saved.pending = {};
      release.resolve();
      await settled();

      expect(saved.drafts).toEqual({});
    });

    it("keeps a write whose first attempt failed when another browser has made one since", async () => {
      outcomes = [{ result: "failed", message: "Offline." }];
      const release = Promise.withResolvers<void>();
      held = release.promise;
      writes.keepDraft("comment:1", ["Hi."], "");
      writes.write(COMMENT, "Sol (agent)", "comment:1");
      const [[invocation, pending]] = writes.pending();
      // Another browser's copy, settled once more, comes in meanwhile.
      saved.pending[invocation] = {
        ...pending,
        attempts: 2,
        at: pending.at + 1,
      };
      release.resolve();
      await settled();

      expect(saved.drafts).toEqual({});
      expect(saved.pending[invocation]?.failure).toBe("Offline.");
    });

    it("does not send a write already under way again", async () => {
      const release = Promise.withResolvers<void>();
      held = release.promise;
      writes.write(COMMENT, "Sol (agent)");
      const [[invocation]] = writes.pending();

      expect(writes.inFlight(invocation)).toBe(true);

      writes.send(invocation);
      release.resolve();
      await settled();

      expect(sent.length).toBe(1);
    });

    it("stamps a draft later than a version of it thrown away at the same moment", () => {
      writes.keepDraft("comment:1", ["One."], "");
      writes.dropDraft("comment:1");
      writes.keepDraft("comment:1", ["Two."], "");

      expect(saved.dropped).toEqual({ "comment:1": { at: NOW, when: NOW } });
      expect(saved.drafts["comment:1"]?.at).toBe(NOW + 1);
    });

    it("finds the pending write saving a draft, and forgets one by its invocation", async () => {
      outcomes = [{ result: "unsettled", message: "Lost." }];
      writes.keepDraft("body:1", ["B"], "A");
      writes.write(
        { verb: "body", topic: "1", text: "B" },
        "Sol (agent)",
        "body:1",
      );
      await settled();
      const [invocation, { at }] = writes.pendingFor("body:1")!;

      expect(writes.pendingFor("comment:1")).toBeUndefined();

      writes.forget(invocation);

      expect(writes.pendingFor("body:1")).toBeUndefined();
      expect(saved.dropped[invocation]).toEqual({ at, when: NOW });
    });

    it("stops waiting once abandoned, returning what is still pending", async () => {
      held = new Promise(() => {});
      writes.write(COMMENT, "Sol (agent)");

      expect(await writes.finish(Promise.resolve())).toEqual([
        "commenting on top/1",
      ]);
    });
  });

  describe("mergeSaved()", () => {
    it("keeps the newest of each draft and the latest reading of each Topic, and our settings", () => {
      const theirs: Saved = {
        ...state(1),
        seen: { "1": 9, "2": 4 },
        drafts: {
          "comment:1": { fields: ["Theirs."], base: "", at: 20 },
          "comment:2": { fields: ["Only theirs."], base: "", at: 5 },
        },
        agentName: "Them",
        hideSettled: true,
      };
      const ours: Saved = {
        ...state(3),
        seen: { "1": 5 },
        drafts: { "comment:1": { fields: ["Ours."], base: "", at: 10 } },
        agentName: "Us",
      };

      expect(mergeSaved(theirs, ours)).toEqual({
        since: 1,
        seen: { "1": 9, "2": 4 },
        drafts: {
          "comment:1": { fields: ["Theirs."], base: "", at: 20 },
          "comment:2": { fields: ["Only theirs."], base: "", at: 5 },
        },
        pending: {},
        dropped: {},
        agentName: "Us",
        hideSettled: false,
      });
    });

    it("does not bring back what either threw away since", () => {
      const theirs: Saved = {
        ...state(1),
        drafts: { "comment:1": { fields: ["Old."], base: "", at: 5 } },
        pending: {
          "topics-1": {
            request: { verb: "mention", topic: "1", other: "2" },
            agentName: "Ian (person)",
            attempts: 1,
            at: 5,
          },
        },
      };
      const ours: Saved = {
        ...state(1),
        dropped: {
          "comment:1": { at: 5, when: 6 },
          "topics-1": { at: 5, when: 6 },
        },
      };
      const merged = mergeSaved(theirs, ours);

      expect(merged.drafts).toEqual({});
      expect(merged.pending).toEqual({});

      const newer = mergeSaved({
        ...theirs,
        drafts: { "comment:1": { fields: ["New."], base: "", at: 7 } },
      }, ours);

      expect(newer.drafts["comment:1"]?.fields).toEqual(["New."]);
    });

    it("keeps ours of two versions stamped alike", () => {
      const draft = (text: string) => ({ fields: [text], base: "", at: 4 });
      const merged = mergeSaved(
        { ...state(1), drafts: { "comment:1": draft("Theirs.") } },
        { ...state(1), drafts: { "comment:1": draft("Ours.") } },
      );

      expect(merged.drafts["comment:1"]?.fields).toEqual(["Ours."]);
    });

    it("keeps a draft changed since another version of it was thrown away", () => {
      const merged = mergeSaved({
        ...state(1),
        drafts: { "comment:1": { fields: ["Newer."], base: "", at: 9 } },
      }, { ...state(1), dropped: { "comment:1": { at: 5, when: 6 } } });

      expect(merged.drafts["comment:1"]?.fields).toEqual(["Newer."]);
    });
  });

  describe("describe()", () => {
    it("returns each kind of write in a few words", () => {
      expect([
        describeWrite({ verb: "new", title: "T", body: "B" }),
        describeWrite({ verb: "title", topic: "1", text: "T" }),
        describeWrite({
          verb: "link",
          topic: "1",
          url: "u",
          label: "l",
          kind: "k",
        }),
        describeWrite({ verb: "unlink", topic: "1", url: "u" }),
        describeWrite({ verb: "mention", topic: "1", other: "2" }),
        describeWrite({ verb: "unmention", topic: "1", other: "2" }),
      ]).toEqual([
        "filing a new Topic",
        "renaming top/1",
        "linking from top/1",
        "taking back a link of top/1",
        "top/1 mentioning top/2",
        "top/1 no longer mentioning top/2",
      ]);
    });
  });
});
