// Churn is the storm-and-settle view: `hot` ranks entities by all-time writes
// and therefore cannot distinguish "1,000 writes spread over a week" from
// "1,000 writes in one minute". These tests pin that distinction, the shape of
// a storm that starts and then settles, and the honesty properties — zero-fill
// so a quiet gap reads as quiet, untimed rows surfaced rather than dropped, and
// a refusal instead of a silently truncated curve.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { commitChurn, commitsPerMinute } from "../churn.ts";
import { hotEntities } from "../queries.ts";

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
`;

const SESSION = "session:did%3Akey%3AzAlice:s1";

/** A fixture store whose commits carry explicit UTC times. */
function build(
  path: string,
  seed: (
    commit: (at: string, entities: string[], session?: string) => void,
  ) => void,
): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let seq = 0;
  const insertCommit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution, created_at)
     VALUES (?, ?, ?, '{}', '{"seq":0}', ?)`,
  );
  const insertRevision = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 'set', '{}', ?)`,
  );
  seed((at, entities, session = SESSION) => {
    const s = ++seq;
    insertCommit.run(s, session, s, at);
    entities.forEach((id, i) => insertRevision.run(id, s, i, s));
  });
  db.close();
}

function withStore(
  seed: Parameters<typeof build>[1],
  run: (space: ReturnType<typeof openSpace>) => void,
): void {
  const dir = Deno.makeTempDirSync({ prefix: "churn-test-" });
  const path = `${dir}/space.sqlite`;
  try {
    build(path, seed);
    const space = openSpace(path);
    try {
      run(space);
    } finally {
      space.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("churn separates a burst from the same writes spread out", () => {
  // Identical totals, opposite shapes. `hot` cannot tell these apart; that is
  // the whole reason churn exists.
  const burst: Parameters<typeof build>[1] = (commit) => {
    for (let i = 0; i < 30; i++) commit("2026-07-22 10:00:00", ["of:X"]);
  };
  const spread: Parameters<typeof build>[1] = (commit) => {
    for (let i = 0; i < 30; i++) {
      commit(`2026-07-22 10:${String(i).padStart(2, "0")}:00`, ["of:X"]);
    }
  };

  withStore(burst, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(r.totals.commits, 30);
    assertEquals(r.buckets.length, 1);
    assertEquals(r.peak?.commits, 30);
    assertEquals(commitsPerMinute(r.peak!, 60), 30);
    assertEquals(hotEntities(space)[0].writes, 30);
  });

  withStore(spread, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    // Guard the fixture itself: a malformed timestamp would land here as a
    // missing commit rather than an error, quietly weakening the comparison.
    assertEquals(r.untimedCommits, 0);
    assertEquals(r.totals.commits, 30);
    // Same total writes as the burst...
    assertEquals(hotEntities(space)[0].writes, 30);
    // ...but the peak minute holds exactly one of them.
    assertEquals(r.peak?.commits, 1);
    assertEquals(commitsPerMinute(r.peak!, 60), 1);
  });
});

Deno.test("a storm that starts and settles is visible as a curve", () => {
  // Shaped like the July Topics incident: quiet, then a generated cell storms,
  // then it settles. The settle is the part a total can never show.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:topic-1"]);
    // The storm is driven by the generated cell; the board takes collateral
    // writes, so the ranking has a real winner rather than a tie.
    for (let i = 0; i < 200; i++) {
      const entities = i % 10 === 0
        ? ["of:generated-cell", "of:board"]
        : ["of:generated-cell"];
      commit("2026-07-22 10:02:00", entities);
    }
    commit("2026-07-22 10:05:00", ["of:topic-2"]);
  }, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60, top: 2 });

    // Zero-fill makes the quiet minutes explicit rather than absent.
    assertEquals(r.buckets.length, 6);
    assertEquals(r.buckets.map((b) => b.commits), [1, 0, 200, 0, 0, 1]);

    assertEquals(r.peak?.start, "2026-07-22 10:02:00");
    assertEquals(commitsPerMinute(r.peak!, 60), 200);

    // The peak is attributed to its actual drivers, ranked by writes.
    assertEquals(r.peakEntities[0].id, "of:generated-cell");
    assertEquals(r.peakEntities[0].writes, 200);
    assertEquals(r.peakEntities[0].sessions, 1);
    assertEquals(r.peakEntities[1].id, "of:board");
    assertEquals(r.peakEntities[1].writes, 20);

    // Settled: activity returns to baseline and stays there.
    assert(r.buckets.slice(3).every((b) => b.commits <= 1));
  });
});

Deno.test("bucket width changes resolution, not totals", () => {
  withStore((commit) => {
    for (let i = 0; i < 10; i++) commit("2026-07-22 10:00:00", ["of:X"]);
    for (let i = 0; i < 10; i++) commit("2026-07-22 10:01:00", ["of:X"]);
  }, (space) => {
    const fine = commitChurn(space, { bucketSeconds: 60 });
    const coarse = commitChurn(space, { bucketSeconds: 300 });
    assertEquals(fine.totals, coarse.totals);
    assertEquals(fine.buckets.length, 2);
    assertEquals(coarse.buckets.length, 1);
    assertEquals(coarse.peak?.commits, 20);
  });
});

Deno.test("--since / --until bound the window, inclusive/exclusive", () => {
  withStore((commit) => {
    commit("2026-07-22 09:59:00", ["of:early"]);
    commit("2026-07-22 10:00:00", ["of:inside"]);
    commit("2026-07-22 10:01:00", ["of:late"]);
  }, (space) => {
    const r = commitChurn(space, {
      bucketSeconds: 60,
      since: "2026-07-22 10:00:00",
      until: "2026-07-22 10:01:00",
    });
    assertEquals(r.totals.commits, 1);
    assertEquals(r.peakEntities[0].id, "of:inside");
  });
});

Deno.test("the curve covers the window asked for, not just its writes", () => {
  // "The rate returns to baseline AND STAYS THERE" is the runbook's settle
  // condition, and a curve that stops at its own last write can never show it:
  // a storm that has just stopped ends on its busiest bucket by construction.
  // `until` is the observation boundary — pass the moment you stopped watching
  // and the trailing quiet is reported rather than left to be assumed.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:topic"]);
    for (let i = 0; i < 50; i++) commit("2026-07-22 10:01:00", ["of:storm"]);
  }, (space) => {
    const bare = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(
      bare.buckets.map((b) => b.commits),
      [1, 50],
      "unbounded, the curve ends on the storm and proves nothing about after",
    );

    const observed = commitChurn(space, {
      bucketSeconds: 60,
      until: "2026-07-22 10:05:00",
    });
    assertEquals(
      observed.buckets.map((b) => b.commits),
      [1, 50, 0, 0, 0],
      "the quiet minutes through the boundary are reported, not implied",
    );
    // `until` is exclusive, so 10:05 itself is not materialized — a zero there
    // would be an artifact of the bound rather than an observation.
    assertEquals(observed.to, "2026-07-22 10:04:00");
    // ...and the settle is legible: writes stopped well before we stopped
    // watching. That comparison is impossible without both numbers.
    assertEquals(observed.lastCommit, "2026-07-22 10:01:00");
    assertEquals(observed.totals, bare.totals, "widening adds no writes");

    // `since` widens the leading edge the same way, so a baseline observation
    // shows the quiet it is claiming.
    const before = commitChurn(space, {
      bucketSeconds: 60,
      since: "2026-07-22 09:58:00",
    });
    assertEquals(before.buckets.map((b) => b.commits), [0, 0, 1, 50]);
    assertEquals(before.from, "2026-07-22 09:58:00");
  });
});

Deno.test("a window bound SQLite cannot read is refused, not treated as quiet", () => {
  // An unreadable bound compares as NULL and therefore matches NO commits, so
  // the report would say "no timed commits in window" — indistinguishable from
  // a genuinely quiet space. That is a false all-clear on the one check this
  // command exists to support, and the runbook has operators typing these
  // bounds by hand.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:topic"]);
  }, (space) => {
    for (const bound of ["since", "until"] as const) {
      const error = assertThrows(
        () => commitChurn(space, { bucketSeconds: 60, [bound]: "yesterday" }),
        Error,
        `--${bound}`,
      );
      assert(
        /report the window as quiet/.test(error.message),
        `the message must say what silently goes wrong, got: ${error.message}`,
      );
    }
    // A readable bound still works, so the check is not just refusing anything
    // unusual: an ISO timestamp is accepted alongside the store's own format.
    assertEquals(
      commitChurn(space, {
        bucketSeconds: 60,
        since: "2026-07-22T09:00:00Z",
      }).totals.commits,
      1,
    );
  });
});

Deno.test("an empty or backwards window is refused, not reported as quiet", () => {
  // Two perfectly readable bounds in the wrong order match no commits and hit
  // the same false all-clear as an unparseable one. `until` is exclusive, so
  // equal bounds are empty too.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:topic"]);
  }, (space) => {
    for (
      const [since, until] of [
        ["2026-07-22 11:00:00", "2026-07-22 10:00:00"], // backwards
        ["2026-07-22 10:00:00", "2026-07-22 10:00:00"], // empty
      ]
    ) {
      assertThrows(
        () => commitChurn(space, { bucketSeconds: 60, since, until }),
        Error,
        "is not before",
      );
    }
    // A window that IS ordered still works, including one holding no commits —
    // that is a real observation, not a mistake.
    assertEquals(
      commitChurn(space, {
        bucketSeconds: 60,
        since: "2026-07-22 12:00:00",
        until: "2026-07-22 13:00:00",
      }).totals.commits,
      0,
    );
  });
});

Deno.test("a commit with no revisions still counts as a commit", () => {
  // LEFT JOIN, not JOIN: an empty commit is real activity and a fan-out over
  // revisions must not inflate the commit count either.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", []);
    commit("2026-07-22 10:00:00", ["of:A", "of:B", "of:C"]);
  }, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(r.totals.commits, 2);
    assertEquals(r.totals.revisions, 3);
  });
});

Deno.test("multiple writer sessions are counted per entity", () => {
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:X"], "session:did%3Akey%3AzAlice:s1");
    commit("2026-07-22 10:00:00", ["of:X"], "session:did%3Akey%3AzBob:s2");
  }, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(r.peakEntities[0].sessions, 2);
  });
});

Deno.test("an empty window reports nothing rather than failing", () => {
  withStore(() => {}, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(r.totals.commits, 0);
    assertEquals(r.buckets, []);
    assertEquals(r.peak, null);
    assertEquals(r.from, null);
    assertEquals(r.peakEntities, []);
  });
});

Deno.test("untimed commits are surfaced, not silently dropped", () => {
  // A curve missing rows must say so — otherwise it reads as a quiet period.
  withStore((commit) => {
    commit("2026-07-22 10:00:00", ["of:X"]);
    commit("not-a-timestamp", ["of:Y"]);
  }, (space) => {
    const r = commitChurn(space, { bucketSeconds: 60 });
    assertEquals(r.totals.commits, 1);
    assertEquals(r.untimedCommits, 1);
  });
});

Deno.test("an over-wide span refuses instead of truncating the curve", () => {
  withStore((commit) => {
    commit("2020-01-01 00:00:00", ["of:X"]);
    commit("2026-07-22 10:00:00", ["of:X"]);
  }, (space) => {
    const err = assertThrows(
      () => commitChurn(space, { bucketSeconds: 1 }),
      Error,
    );
    assert(err.message.includes("--bucket"), "names the way out");
  });
});

Deno.test("a non-positive bucket width is rejected", () => {
  withStore(() => {}, (space) => {
    assertThrows(() => commitChurn(space, { bucketSeconds: 0 }), Error);
    assertThrows(() => commitChurn(space, { bucketSeconds: 1.5 }), Error);
  });
});
