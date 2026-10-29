/**
 * A child branch inherits every entity its parent held at the fork, and the
 * surfaces that DESCRIBE entities have to see the same set a read does — or
 * they answer "no history", "no contention", "not here" about entities the same
 * branch reads fine, which is indistinguishable from those things being true.
 *
 * Ownership is the other half, and it cuts the other way: an entity the child
 * OVERRODE has a parent log that produced nothing the child can see, so
 * describing it with the parent's writes would credit revisions no read from
 * here can reach. Every case below pins both directions.
 *
 * Surfaces that describe a branch's ACTIVITY rather than its entities —
 * `spaceTimeline`, `churn` — stay branch-local on purpose, and the last case
 * here holds that line so it reads as a decision rather than an oversight.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import { entityHistory, hotEntities } from "../queries.ts";
import { contendedEntities, entityConflicts } from "../conflicts.ts";
import { entityTimeline, spaceTimeline } from "../timetravel.ts";
import { analyzeSpaceSignals } from "../grouping.ts";
import { spaceParticipants, valueAsIdentity } from "../scopes.ts";
import { convergenceExact, convergenceScanExact } from "../multispace.ts";
import { owningLink, reconstructDocument } from "../reconstruct.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq) VALUES ('', 999);
`;

const ALICE = "session:did%3Akey%3AzAlice:s1";
const BOB = "session:did%3Akey%3AzBob:s2";

interface Write {
  branch?: string;
  id: string;
  scope?: string;
  session?: string;
  value: unknown;
}

/**
 * Seed a space, forking `kid` after the parent's writes so everything written
 * on the parent is inherited and everything on `kid` is the child's own.
 */
async function withFork(
  parent: Write[],
  child: Write[],
  run: (space: SpaceDb) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "branch-visible-" });
  const path = `${dir}/space.sqlite`;
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, ?, '{}', '{"seq":0}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  const write = (w: Write) => {
    seq++;
    const branch = w.branch ?? "";
    commit.run(seq, branch, w.session ?? ALICE, seq);
    rev.run(
      branch,
      w.id,
      w.scope ?? "space",
      seq,
      JSON.stringify({ value: w.value }),
      seq,
    );
  };
  parent.forEach(write);
  const forkSeq = seq;
  db.prepare(
    `INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
     VALUES ('kid', '', ?, 999)`,
  ).run(forkSeq);
  child.forEach((w) => write({ ...w, branch: "kid" }));
  db.close();

  const space = openSpace(path);
  try {
    run(space);
  } finally {
    space.close();
    await Deno.remove(dir, { recursive: true });
  }
}

/** Two writers on `of:shared`, two on `of:quiet`, both inherited by `kid`. */
const CONTENDED_PARENT: Write[] = [
  { id: "of:shared", session: ALICE, value: "p1" },
  { id: "of:shared", session: BOB, value: "p2" },
  { id: "of:shared", session: ALICE, value: "p3" },
  { id: "of:quiet", session: ALICE, value: "q1" },
  { id: "of:quiet", session: BOB, value: "q2" },
];

describe("branch-visible", () => {
  describe("entityHistory()", () => {
    it("returns the parent's writes for an entity the child inherited", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        // The entity reads fine from `kid`, so an empty log would be a false
        // statement about it rather than a gap the caller could notice.
        expect(reconstructDocument(space, { id: "of:shared", branch: "kid" }))
          .toEqual({ value: "p3" });
        expect(
          entityHistory(space, { id: "of:shared", branch: "kid" })
            .map((w) => w.seq),
        ).toEqual([1, 2, 3]);
      });
    });

    it("returns only the child's writes for an entity the child overrode", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        // The child's write is the visible row, and the value came from it
        // alone — `reconstructWithinBranch` never composes across the fork — so
        // the parent's two writes are not this entity's history from here.
        expect(reconstructDocument(space, { id: "of:quiet", branch: "kid" }))
          .toEqual({ value: "child" });
        expect(
          entityHistory(space, { id: "of:quiet", branch: "kid" })
            .map((w) => w.seq),
        ).toEqual([6]);
      });
    });

    it("returns nothing for an entity the branch cannot see", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(entityHistory(space, { id: "of:absent", branch: "kid" }))
          .toEqual([]);
      });
    });
  });

  describe("entityTimeline()", () => {
    it("replays the writes of the branch that owns the visible row", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(
          entityTimeline(space, { id: "of:shared", branch: "kid" })
            .map((s) => s.seq),
        ).toEqual([1, 2, 3]);
      });
    });

    it("replays only the child's writes for an entity it overrode", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        expect(
          entityTimeline(space, { id: "of:quiet", branch: "kid" })
            .map((s) => s.seq),
        ).toEqual([6]);
      });
    });
  });

  describe("hotEntities()", () => {
    it("ranks the entities a child inherited alongside its own", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:kidonly", value: "k" },
      ], (space) => {
        expect(
          hotEntities(space, { branch: "kid" }).map((e) =>
            `${e.id}:${e.writes}`
          ),
        ).toEqual(["of:shared:3", "of:quiet:2", "of:kidonly:1"]);
      });
    });

    it("counts an overridden entity on the branch that overrode it", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        const quiet = hotEntities(space, { branch: "kid" })
          .find((e) => e.id === "of:quiet");
        expect(quiet?.writes).toBe(1);
      });
    });
  });

  describe("contendedEntities()", () => {
    it("reports contention inherited from the parent", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        // Local rows only would report NO contention on this branch, over two
        // entities it can read that each carry two writers.
        expect(
          contendedEntities(space, { branch: "kid" }).map((e) =>
            `${e.id}:${e.sessions}`
          ),
        ).toEqual(["of:shared:2", "of:quiet:2"]);
      });
    });

    it("drops an entity whose override left it with one writer", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        expect(
          contendedEntities(space, { branch: "kid" }).map((e) => e.id),
        ).toEqual(["of:shared"]);
      });
    });
  });

  describe("analyzeSpaceSignals()", () => {
    it("detects a home the child branch inherited", async () => {
      const home = {
        $NAME: "Home",
        createProfile: { "/": { id: "of:cp" } },
        profiles: [],
      };
      await withFork([{ id: "of:home", value: home }], [], (space) => {
        // Assert the parent detects it FIRST: without that, "the branches
        // agree" is satisfied by both saying false, and the test could not
        // fail.
        expect(analyzeSpaceSignals(space).isHome).toBe(true);
        expect(analyzeSpaceSignals(space, { branch: "kid" }).isHome).toBe(true);
      });
    });
  });

  describe("hotEntities() ties", () => {
    it("orders equal-write rows sharing an id by scope, against the walk order", async () => {
      const MINE = "user:did:key:zAlice";
      // The tie-break only bites where walk order and scope order DISAGREE, and
      // one link cannot produce that: a single `GROUP BY id, scope_key` already
      // emits scopes ascending. Across a chain it can — the walk takes the
      // CHILD's link first, so the child's scope arrives before the parent's
      // whatever the names are. Here the child holds the per-user scope and the
      // parent the shared one, so the walk yields `user:…` first and the sort
      // has to put `space` back in front.
      await withFork(
        [{ id: "of:x", value: 1 }],
        [{ id: "of:x", scope: MINE, value: 2 }],
        (space) => {
          const hot = hotEntities(space, { branch: "kid" });
          expect(hot.map((e) => e.scope)).toEqual(["space", MINE]);
          // And a cap takes the same one every run rather than whichever the
          // walk happened to reach first.
          expect(hotEntities(space, { branch: "kid", limit: 1 })[0].scope)
            .toBe("space");
        },
      );
    });
  });

  describe("contendedEntities() limits", () => {
    it("treats a negative limit as unlimited, as the SQL it replaced did", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        const all = contendedEntities(space).map((e) => e.id);
        expect(all.length).toBe(2);
        // `slice(0, -1)` would drop the last, reporting one fewer contended
        // entity than there are — and the conflicts CLI accepts a negative.
        expect(contendedEntities(space, { limit: -1 }).map((e) => e.id))
          .toEqual(all);
      });
    });

    it("applies a positive limit", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(contendedEntities(space, { limit: 1 }).length).toBe(1);
      });
    });
  });

  describe("cross-space convergence on a child branch", () => {
    /** Two spaces, each holding `of:shared` on the parent, values differing. */
    async function twoForkedSpaces(
      run: (spaces: { label: string; space: SpaceDb }[]) => void,
    ): Promise<void> {
      const dir = await Deno.makeTempDir({ prefix: "branch-visible-conv-" });
      const opened: { label: string; space: SpaceDb }[] = [];
      try {
        for (const [label, value] of [["a", "A-value"], ["b", "B-value"]]) {
          const path = `${dir}/${label}.sqlite`;
          const db = new Database(path, { create: true });
          db.exec(SCHEMA);
          db.prepare(
            `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
             VALUES (1, ?, 1, '{}', '{"seq":0}')`,
          ).run(ALICE);
          db.prepare(
            `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
             VALUES ('of:shared', 1, 0, 'set', ?, 1)`,
          ).run(JSON.stringify({ value }));
          db.prepare(
            `INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
             VALUES ('kid', '', 1, 999)`,
          ).run();
          db.close();
          opened.push({ label, space: openSpace(path) });
        }
        run(opened);
      } finally {
        for (const { space } of opened) space.close();
        await Deno.remove(dir, { recursive: true });
      }
    }

    it("finds the divergence in an entity both spaces inherited", async () => {
      await twoForkedSpaces((spaces) => {
        // On the parent the scan sees it diverge. The child inherits the same
        // entity in both spaces and reads the same two values, so the same
        // divergence has to be found there — enumerating the id and then
        // reporting it held by nobody would suppress the finding this scan
        // exists for.
        expect(convergenceScanExact(spaces).findings.map((f) => f.id))
          .toEqual(["of:shared"]);
        expect(
          convergenceScanExact(spaces, { branch: "kid" }).findings.map((f) =>
            f.id
          ),
        ).toEqual(["of:shared"]);
      });
    });

    it("classifies an inherited cross-space link, not just the entity it points at", async () => {
      const A = "did:key:zSpaceAAAA";
      const B = "did:key:zSpaceBBBB";
      const dir = await Deno.makeTempDir({ prefix: "branch-visible-link-" });
      const opened: { label: string; space: SpaceDb }[] = [];
      try {
        for (const [did, target] of [[A, "A-value"], [B, "B-value"]]) {
          const path = `${dir}/${did}.sqlite`;
          const db = new Database(path, { create: true });
          db.exec(SCHEMA);
          const commit = db.prepare(
            `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
             VALUES (?, ?, ?, '{}', '{"seq":0}')`,
          );
          const rev = db.prepare(
            `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
             VALUES (?, ?, 0, 'set', ?, ?)`,
          );
          // The replica, diverging between the spaces...
          commit.run(1, ALICE, 1);
          rev.run("of:target", 1, JSON.stringify({ value: target }), 1);
          // ...and a holder linking at the OTHER space's copy of it.
          commit.run(2, ALICE, 2);
          rev.run(
            "of:holder",
            2,
            JSON.stringify({
              value: {
                ref: {
                  "/": {
                    "link@1": {
                      id: "of:target",
                      space: did === A ? B : A,
                      path: [],
                    },
                  },
                },
              },
            }),
            2,
          );
          db.prepare(
            `INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
             VALUES ('kid', '', 2, 999)`,
          ).run();
          db.close();
          opened.push({ label: `${did}.sqlite`, space: openSpace(path) });
        }

        // The holder is inherited on `kid`. An index built from local rows
        // would not see it, so the divergence in `of:target` would come back
        // classified as an independent instance rather than a replica.
        const onParent = convergenceScanExact(opened).findings
          .find((f) => f.id === "of:target");
        expect(onParent?.relationship).toBe("cross-space-linked");

        const onChild = convergenceScanExact(opened, { branch: "kid" })
          .findings.find((f) => f.id === "of:target");
        expect(onChild?.relationship).toBe("cross-space-linked");
      } finally {
        for (const { space } of opened) space.close();
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("reports each space as holding the inherited entity, not absent", async () => {
      await twoForkedSpaces((spaces) => {
        const result = convergenceExact(spaces, {
          id: "of:shared",
          branch: "kid",
        });
        expect(result.views.map((v) => v.present)).toEqual([true, true]);
        expect(result.verdict).toBe("diverged");
      });
    });
  });

  describe("entityConflicts()", () => {
    it("lists the writers of an entity the child inherited", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(
          entityConflicts(space, "of:shared", { branch: "kid" })
            .writers.map((w) => w.seq),
        ).toEqual([1, 2, 3]);
      });
    });

    it("lists only the child's writers for an entity it overrode", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:quiet", value: "child" },
      ], (space) => {
        expect(
          entityConflicts(space, "of:quiet", { branch: "kid" })
            .writers.map((w) => w.seq),
        ).toEqual([6]);
      });
    });
  });

  describe("spaceParticipants()", () => {
    it("counts the commits behind a branch's inherited entities", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        // `listScopes` reads through ancestry, and this pairs principals with
        // those same scoped-entity counts — so counting local commits only
        // would credit a child's inherited entities to nobody.
        const dids = spaceParticipants(space, { branch: "kid" })
          .map((p) => p.did).sort();
        expect(dids).toEqual(spaceParticipants(space).map((p) => p.did).sort());
        expect(dids.length).toBe(2);
      });
    });
  });

  describe("spaceParticipants() across a chain", () => {
    it("counts a session that wrote on both branches once, with its commits summed", async () => {
      await withFork(
        [{ id: "of:a", session: ALICE, value: 1 }, {
          id: "of:b",
          session: ALICE,
          value: 2,
        }],
        [{ id: "of:c", session: ALICE, value: 3 }],
        (space) => {
          // Commits add across the chain — parent and child commits are
          // different commits — while the session that made them is still one
          // session. Attributing per link counts it twice.
          const [alice] = spaceParticipants(space, { branch: "kid" });
          expect(alice.commits).toBe(3);
          expect(alice.sessions).toBe(1);
        },
      );
    });

    it("counts two sessions on one branch as two", async () => {
      await withFork(
        [{ id: "of:a", session: ALICE, value: 1 }, {
          id: "of:b",
          session: `session:did%3Akey%3AzAlice:s2`,
          value: 2,
        }],
        [],
        (space) => {
          const [alice] = spaceParticipants(space, { branch: "kid" });
          expect(alice.sessions).toBe(2);
        },
      );
    });
  });

  describe("valueAsIdentity()", () => {
    it("resolves through a scope the child inherited", async () => {
      // The STORED form, which is what `resolveScopeChain` builds and what the
      // engine writes — not the decoded spelling `parseScope` reports.
      const MINE = "user:did%3Akey%3AzAlice";
      await withFork(
        [
          { id: "of:x", value: "shared" },
          { id: "of:x", scope: MINE, value: "mine" },
        ],
        [],
        (space) => {
          // `scopeHasEntity` gates which scope this resolves from; branch-local,
          // it finds neither and reports the entity absent from a branch that
          // reads it.
          const seen = valueAsIdentity(space, {
            id: "of:x",
            identity: "did:key:zAlice",
            branch: "kid",
          });
          expect(seen.exists).toBe(true);
          expect(seen.resolvedScope).toBe(MINE);
          expect(seen.overrides).toBe(true);
        },
      );
    });
  });

  describe("owningLink() scope", () => {
    it("answers about the shared scope by default, not whichever row comes back first", async () => {
      const MINE = "user:did%3Akey%3AzAlice";
      await withFork(
        // Owned by the PARENT in `space`...
        [{ id: "of:x", value: "parent-space" }],
        // ...and by the CHILD in a user scope. Different owners for one id.
        [{ id: "of:x", scope: MINE, value: "child-user" }],
        (space) => {
          expect(
            owningLink(space, { branch: "kid", scope: "space", id: "of:x" })
              ?.branch,
          ).toBe("");
          expect(
            owningLink(space, { branch: "kid", scope: MINE, id: "of:x" })
              ?.branch,
          ).toBe("kid");
          // Omitting scope must mean `space`, the package's default — not the
          // first scoped row the enumeration happens to return.
          expect(owningLink(space, { branch: "kid", id: "of:x" })?.branch)
            .toBe("");
        },
      );
    });
  });

  describe("hotEntities() limits", () => {
    it("treats a negative limit as unlimited, as the SQL it replaced did", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        const all = hotEntities(space).map((e) => e.id);
        expect(all.length).toBe(2);
        // `slice(0, -1)` would drop the last, under-reporting the hot entities
        // an operator asked to see all of. Same trap as `contendedEntities`,
        // in its sibling in the same file.
        expect(hotEntities(space, { limit: -1 }).map((e) => e.id)).toEqual(all);
      });
    });

    it("applies a positive limit", async () => {
      await withFork(CONTENDED_PARENT, [], (space) => {
        expect(hotEntities(space, { limit: 1 }).length).toBe(1);
      });
    });
  });

  describe("spaceTimeline()", () => {
    it("stays local, because a branch's activity is not its inherited entities", async () => {
      await withFork(CONTENDED_PARENT, [
        { id: "of:kidonly", value: "k" },
      ], (space) => {
        // Deliberate, and the counterpart to everything above: this describes
        // the commits made ON the branch. Inherited entities were created by
        // commits that are not in this timeline, so folding them in would
        // attribute creations to commits it never lists.
        expect(
          spaceTimeline(space, { branch: "kid" }).map((t) => t.commitSeq),
        ).toEqual([6]);
      });
    });
  });
});
