import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { encodeStoredCommit } from "@commonfabric/memory/v2/stored-commit";
import type { ClientCommit } from "@commonfabric/memory/v2";

import {
  ALICE,
  ALICE_S1,
  BOB,
  BOB_S2,
  LONG_TEXT,
  MODULE_CODE,
  runInspect,
  runInspectJson,
  seedDeletedSpace,
  seedFanInSpace,
  seedOddSpace,
  seedRichSpace,
  seedSpace,
  seedTimelineSpace,
  sessionOf,
} from "./inspect-fixtures.ts";
import { stripAnsi } from "./utils.ts";

const DELETED_SPACE = "did:key:z6MkInspectCmdDeletedDDDDDDDDDDDDDDDDDDDDDDDD";

/** What a command printed to stdout, one line per element, right-trimmed. */
async function lines(argv: string[]): Promise<string[]> {
  const { stdout } = await runInspect(argv);
  return stdout.join("\n").split("\n").map((line) => line.trimEnd());
}

describe("inspect-space", () => {
  let dir: string;
  // Named for its DID, so the space reads as `ALICE`'s home.
  let rich: string;
  let deleted: string;
  let empty: string;
  let odd: string;
  let timeline: string;
  let fanIn: string;

  beforeAll(async () => {
    dir = await Deno.makeTempDir({ prefix: "inspect-space-" });
    rich = `${dir}/${ALICE}.sqlite`;
    deleted = `${dir}/deleted.sqlite`;
    empty = `${dir}/empty.sqlite`;
    odd = `${dir}/odd.sqlite`;
    timeline = `${dir}/timeline.sqlite`;
    fanIn = `${dir}/fan-in.sqlite`;
    seedRichSpace(rich);
    seedDeletedSpace(deleted, DELETED_SPACE);
    seedSpace(empty, []);
    seedOddSpace(odd);
    seedTimelineSpace(timeline);
    seedFanInSpace(fanIn, 41);
  });

  afterAll(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  it("prints its help when given no subcommand", async () => {
    const help = stripAnsi((await runInspect([])).stdout.join("\n"));
    expect(help).toContain("Offline autopsy of local memory v2 space DBs");
    expect(help).toContain("converge-scan");
  });

  it("throws given `--json` and no subcommand", async () => {
    await expect(runInspect(["--json"])).rejects.toThrow(
      'Option "--json" requires an inspect data subcommand.',
    );
  });

  describe("summary", () => {
    it("prints the counts, branches, and scheduler basis rows of a space", async () => {
      expect(await lines(["summary", rich])).toEqual([
        `space: ${rich}`,
        "commits: 9 (seq 1–9)",
        "sessions: 4",
        "entities: 12  revisions: 22",
        "ops: delete=1 set=21",
        "branches: (default)@9",
        "scheduler basis: 2 rows",
      ]);
    });

    it("prints who deleted a deleted space, and an empty scheduler basis table", async () => {
      const output = await lines(["summary", deleted]);
      expect(output).toContain(
        `deleted: by ${ALICE}, in the commit at seq 2`,
      );
      expect(output).toContain("scheduler basis: table present, empty");
      expect(
        await runInspectJson(["summary", deleted]),
      ).toMatchObject({ deletion: { by: ALICE, seq: 2 } });
    });

    it("prints no seq range or deletion for an empty store without a scheduler basis table", async () => {
      expect(await lines(["summary", empty])).toEqual([
        `space: ${empty}`,
        "commits: 0",
        "sessions: 0",
        "entities: 0  revisions: 0",
        "ops:",
        "branches: (default)@0",
        "scheduler basis: absent (pre-migration store)",
      ]);
    });
  });

  describe("scopes", () => {
    it("lists the shared, per-user, per-session, and unrecognized scopes with a tip", async () => {
      expect(await lines(["scopes", rich])).toEqual([
        "4 scope(s)  ·  shared 'space' has 11 entities",
        "  space                              entities=11\trevs=19",
        "  user z6MkInsp…BBBB                 entities=1\trevs=1",
        "  session z6MkInsp…AAAA/aaaaaaaa     entities=1\trevs=1",
        "  custom:weird                       entities=1\trevs=1",
        "",
        "tip: `inspect value-at <space> <id> --as <DID>` reads as that identity;",
        "     `inspect overlay <space> <id>` shows a cell across all scopes.",
      ]);
    });

    it("prints no shared-scope count where the space scope holds nothing", async () => {
      const output = await lines(["scopes", odd]);
      expect(output[0]).toBe("1 scope(s)");
      expect(output[1]).toBe(
        "  custom:weird                       entities=1\trevs=1",
      );
    });

    it("prints no tip where only the shared scope could exist", async () => {
      expect(await lines(["scopes", empty])).toEqual(["0 scope(s)"]);
    });
  });

  describe("users", () => {
    it("lists each identity, marking the owner of a home space", async () => {
      expect(await lines(["users", rich])).toEqual([
        "2 identities:",
        "  ★ z6MkInsp…AAAA\tcommits=6 sessions=2  session-cells=1  (owner — this is their home)",
        "  · z6MkInsp…BBBB\tcommits=2 sessions=1  user-cells=1",
        "",
        "tip: `inspect identity <DID>` opens a user's whole world (home + profiles + the spaces they act in).",
      ]);
    });

    it("prints that no participant is identifiable where no session names one", async () => {
      expect(await lines(["users", odd])).toEqual([
        "(no identifiable participants — bare/empty sessions)",
      ]);
    });
  });

  describe("commits", () => {
    it("lists commits newest first, with readable sessions", async () => {
      const output = await lines(["commits", rich, "--limit", "3"]);
      expect(output).toEqual([
        "#9\tbare-session-without-…\tlocal=9\tops=1\treads=0\t2026-01-01 00:08:00",
        "#8\tz6MkIn…AAAA/aaaaaaaa\tlocal=8\tops=1\treads=1\t2026-01-01 00:07:00",
        "#7\tz6MkIn…AAAA/cccccccc\tlocal=7\tops=4\treads=0\t2026-01-01 00:06:00",
      ]);
    });
  });

  describe("hot", () => {
    it("lists entities by write count", async () => {
      expect(await lines(["hot", rich, "--limit", "2"])).toEqual([
        "4\twrites\t2 sessions\tof:shared\t(space)",
        "3\twrites\t2 sessions\tof:solo\t(space)",
      ]);
    });
  });

  describe("conflicts", () => {
    it("lists contested entities, marking multi-user and interleaved ones", async () => {
      expect(await lines(["conflicts", rich])).toEqual([
        "5 contested entities (written by ≥2 sessions)  ·  1 MULTI-USER (≥2 identities):",
        "  ★ of:shared\t2 users / 2 sessions\t4 writes  MULTI-USER",
        "  ⇄ of:solo\t1 users / 2 sessions\t3 writes",
        "  · of:doomed\t1 users / 2 sessions\t2 writes",
        "  · of:pair\t1 users / 2 sessions\t2 writes",
        "  · of:shape\t1 users / 2 sessions\t2 writes",
        "",
        "tip: `inspect conflicts <space> <entity>` for the writer timeline + stale reads.",
      ]);
    });

    it("prints that nothing is contested in a space no two sessions wrote", async () => {
      expect(await lines(["conflicts", empty])).toEqual([
        "(no contested entities — no cell written by ≥2 sessions)",
      ]);
    });

    it("prints an entity's writers and its anomalous stale reads", async () => {
      expect(await lines(["conflicts", rich, "of:shared"])).toEqual([
        "of:shared",
        "4 writes by 2 identities / 2 sessions  · MULTI-USER  · INTERLEAVED",
        "  seq=3\tset\tz6MkIn…BBBB/bbbbbbbb\t2026-01-01 00:02:00",
        "  seq=4\tset\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:03:00",
        "  seq=5\tset\tz6MkIn…BBBB/bbbbbbbb\t2026-01-01 00:04:00",
        "  seq=6\tset\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:05:00",
        "",
        "⚠ ANOMALOUS stale reads — the engine validates confirmed reads before committing, so a healthy store has none. Each here is a committed read the engine's own check would reject:",
        "  commit #6 by z6MkIn…AAAA/aaaaaaaa read @seq 4 but missed set @seq 5 by z6MkIn…BBBB/bbbbbbbb  ⚠ then wrote (lost-update risk)",
        "  commit #8 by z6MkIn…AAAA/aaaaaaaa read @seq 4 but missed set @seq 5 by z6MkIn…BBBB/bbbbbbbb",
      ]);
    });

    it("prints a single-user entity with no stale reads as consistent", async () => {
      expect(await lines(["conflicts", rich, "of:solo"])).toEqual([
        "of:solo",
        "3 writes by 1 identity / 2 sessions  · single-user (multi-session)  · INTERLEAVED",
        "  seq=1\tset\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:00:00",
        "  seq=7\tset\tz6MkIn…AAAA/cccccccc\t2026-01-01 00:06:00",
        "  seq=8\tset\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:07:00",
        "",
        "(no anomalous stale reads — store is consistent)",
      ]);
    });

    it("does not call an entity consistent when a later commit keeps only a digest of its reads", async () => {
      // Alice and Bob each write of:x; Alice's third commit reads it and is
      // stored with a digest in place of its reads.
      const space = `${dir}/digested.sqlite`;
      const alice = sessionOf(ALICE, ALICE_S1);
      const reader = encodeStoredCommit(
        {
          localSeq: 3,
          reads: { confirmed: [{ id: "of:x", path: [], seq: 2 }], pending: [] },
          operations: [{ op: "set", id: "of:y", value: { value: 1 } }],
        } as unknown as ClientCommit,
        false,
      );
      seedSpace(
        space,
        [
          { session: alice, revisions: [{ id: "of:x", document: { n: 1 } }] },
          {
            session: sessionOf(BOB, BOB_S2),
            revisions: [{ id: "of:x", document: { n: 2 } }],
          },
          { session: alice, revisions: [{ id: "of:y", document: 1 }] },
        ],
        `UPDATE "commit" SET original = '${
          reader.replaceAll("'", "''")
        }' WHERE seq = 3;`,
      );

      expect((await lines(["conflicts", space, "of:x"])).slice(-3)).toEqual([
        "(no anomalous stale reads among the reads kept)",
        "",
        "? 1 later commit(s) hold reads this check cannot replay (a digest, compacted history, or an unreadable payload), so whether they read this entity stale was not checked.",
      ]);
    });

    it("prints neither marker for a non-interleaved single-user entity", async () => {
      expect((await lines(["conflicts", rich, "of:pair"]))[1]).toBe(
        "2 writes by 1 identity / 2 sessions  · single-user (multi-session)",
      );
    });
  });

  describe("entities", () => {
    it("prints a count by kind and a table, shortening long labels", async () => {
      const output = await lines(["entities", rich]);
      expect(output[0]).toBe(
        "piece=2  module=1  owned-cell=1  free-cell=6  deleted=1",
      );
      expect(output[1].split(/\s+/)).toEqual([
        "KIND",
        "LABEL",
        "OWN",
        "REVS",
        "LINKS",
        "ID",
      ]);
      const child = output.find((line) => line.endsWith("of:child"));
      expect(child).toContain("{alpha, bravo, charlie, delta, ec…");
      expect(child).toContain("↳");
      const long = output.find((line) => line.endsWith("of:long"));
      expect(long).toContain(`${JSON.stringify(LONG_TEXT).slice(0, 33)}…`);
      expect(long).not.toContain("↳");
      expect(output.find((line) => line.endsWith("of:piece"))?.split(/\s+/))
        .toEqual(["piece", "Counter", "1", "2", "of:piece"]);
    });

    it("prints that there are no entities in an empty space", async () => {
      expect(await lines(["entities", empty])).toEqual(["(no entities)"]);
    });
  });

  describe("piece", () => {
    it("prints a piece's pattern, input, result, schema, owned cells, and code", async () => {
      expect(await lines(["piece", rich, "of:piece", "--code"])).toEqual([
        "piece:   Counter  [modern]",
        "id:      of:piece",
        "pattern: /api/patterns/demo/counter.tsx · default · 4 lines  of:module",
        "input:   {count}  of:input",
        "result:  {$NAME, count, elsewhere}",
        "schema:  {type, properties}",
        "owned cells (1):",
        "  owned-cell {alpha, bravo, charlie, delta, echo, fo…\tof:child",
        "",
        "--- /api/patterns/demo/counter.tsx ---",
        ...MODULE_CODE.split("\n"),
      ]);
    });

    it("prints only what a piece with an unresolved pattern holds", async () => {
      expect(await lines(["piece", rich, "of:bare-piece"])).toEqual([
        "piece:   (unnamed)  [modern]",
        "id:      of:bare-piece",
        "pattern: (unresolved)",
        "result:  {}",
      ]);
    });

    it("prints why an entity is not a piece", async () => {
      expect(await lines(["piece", rich, "of:input"])).toEqual([
        "(not a piece (kind=free-cell))",
      ]);
    });
  });

  describe("graph", () => {
    it("prints nodes and edges by kind, then each source's edges", async () => {
      const output = await lines(["graph", rich]);
      expect(output.slice(0, 3)).toEqual([
        `space: ${ALICE}`,
        "nodes: 11  {free-cell=6 piece=2 owned-cell=1 module=1 unknown=1}",
        "edges: 5  {pattern=1 argument=1 owns=1 link=2}  (1 cross-space)",
      ]);
      expect(output.slice(3)).toEqual([
        "",
        "piece of:piece  Counter",
        "  ⟶pattern  module module:counter.tsx  (default)",
        "  ⟶arg      free-cell {count}",
        "  ⟶owns     owned-cell {alpha, bravo, charlie, delta, echo, foxtrot}",
        "  ·link     free-cell {count}",
        "  ·link     of:far (external) @z6MkInsp…OOOO [cross-space]",
      ]);
    });

    it("restricts the graph to the neighborhood of `--root`", async () => {
      const output = await lines([
        "graph",
        rich,
        "--root",
        "of:input",
        "--depth",
        "1",
      ]);
      expect(output[1]).toBe("nodes: 2  {free-cell=1 piece=1}");
      expect(output[2]).toBe("edges: 2  {argument=1 link=1}");
    });

    it("lists the first 40 sources and counts the rest", async () => {
      const output = await lines(["graph", fanIn]);
      const sources = output.filter((line) => line.startsWith("free-cell "));
      expect(sources).toHaveLength(40);
      expect(sources[39]).toBe("free-cell of:spoke-39  {to}");
      expect(output).not.toContain("free-cell of:spoke-40  {to}");
      expect(output.at(-1)).toBe("… 1 more sources (use --root or --json)");
    });

    it("lists every source under `--root`", async () => {
      const output = await lines(["graph", fanIn, "--root", "of:hub"]);
      expect(output.filter((line) => line.startsWith("free-cell ")))
        .toHaveLength(41);
      expect(output.at(-1)).toBe('  ·link     free-cell "hub"');
    });
  });

  describe("html", () => {
    it("writes the page to `--out` and reports what it holds on stderr", async () => {
      const out = `${dir}/inspector.html`;
      const { stdout, stderr } = await runInspect(["html", rich, "--out", out]);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `wrote ${out}  (10 entities, 2 pieces)`,
      ]);
      const html = await Deno.readTextFile(out);
      expect(html).toContain("<html");
      expect(html).toContain("of:piece");
    });

    it("throws, writing nothing, given `--json`", async () => {
      const out = `${dir}/refused.html`;
      await expect(runInspect(["html", rich, "--out", out, "--json"])).rejects
        .toThrow(
          'Option "--json" and the "html" command are mutually exclusive.',
        );
      await expect(Deno.stat(out)).rejects.toThrow(Deno.errors.NotFound);
    });
  });

  describe("history", () => {
    it("lists every write to an entity", async () => {
      expect(await lines(["history", rich, "of:shared"])).toEqual([
        "seq=3\tcommit=3\tset\tz6MkIn…BBBB/bbbbbbbb\tlocal=3\t2026-01-01 00:02:00",
        "seq=4\tcommit=4\tset\tz6MkIn…AAAA/aaaaaaaa\tlocal=4\t2026-01-01 00:03:00",
        "seq=5\tcommit=5\tset\tz6MkIn…BBBB/bbbbbbbb\tlocal=5\t2026-01-01 00:04:00",
        "seq=6\tcommit=6\tset\tz6MkIn…AAAA/aaaaaaaa\tlocal=6\t2026-01-01 00:05:00",
      ]);
    });
  });

  describe("value-at", () => {
    it("prints the latest value", async () => {
      expect(await lines(["value-at", rich, "of:shared"])).toEqual([
        "{",
        '  "n": 4',
        "}",
      ]);
    });

    it("prints that an entity is absent at a seq before its birth", async () => {
      expect(await lines(["value-at", rich, "of:shared", "--seq", "2"]))
        .toEqual(["(absent at this seq)"]);
    });

    it("prints that nothing is at a path the value lacks", async () => {
      expect(await lines(["value-at", rich, "of:shared", "--path", "zzz"]))
        .toEqual(["(entity present, but nothing at that path)"]);
    });

    it("prints a session's view, marking that it overrides a broader scope", async () => {
      expect(
        await lines([
          "value-at",
          rich,
          "of:shared",
          "--as",
          ALICE,
          "--session",
          ALICE_S1,
        ]),
      ).toEqual([
        "≈ approx. from scope: session (most-specific stored; NOT a runtime read — see `overlay`)  (overrides a more-general scope)",
        "{",
        `  "n": "alice's session"`,
        "}",
      ]);
    });

    it("prints the space view for an identity with nothing more specific", async () => {
      expect(
        (await lines(["value-at", rich, "of:shared", "--as", ALICE]))[0],
      ).toBe(
        "≈ approx. from scope: space (most-specific stored; NOT a runtime read — see `overlay`)",
      );
    });

    it("prints that an entity is absent for an identity", async () => {
      expect(await lines(["value-at", rich, "of:nothing", "--as", BOB]))
        .toEqual(["(absent for this identity)"]);
    });

    it("prints that nothing is at a path an identity's view lacks", async () => {
      expect(
        await lines([
          "value-at",
          rich,
          "of:shared",
          "--as",
          BOB,
          "--path",
          "zzz",
        ]),
      ).toEqual(["(entity present, but nothing at that path)"]);
    });
  });

  describe("overlay", () => {
    it("prints each scope's value and whether they diverge", async () => {
      expect(await lines(["overlay", rich, "of:shared"])).toEqual([
        "of:shared  —  3 scopes, DIVERGENT",
        "  space                              {n}",
        "  user z6MkInsp…BBBB                 {n}",
        "  session z6MkInsp…AAAA/aaaaaaaa     {n}",
      ]);
    });

    it("prints an entity held in one scope as a single scope", async () => {
      expect(await lines(["overlay", rich, "of:input"])).toEqual([
        "of:input  —  single scope",
        "  space                              {count}",
      ]);
    });

    it("prints an entity stored in an unrecognized scope under its raw key", async () => {
      expect(await lines(["overlay", odd, "of:odd"])).toEqual([
        "of:odd  —  single scope",
        '  custom%3Aweird                     "odd scope"',
      ]);
    });

    it("prints that an entity no scope holds is absent", async () => {
      expect(await lines(["overlay", rich, "of:missing"])).toEqual([
        "(entity absent)",
      ]);
    });
  });

  describe("diff", () => {
    it("prints added, removed, and changed keys", async () => {
      expect(
        await lines(["diff", rich, "of:shape", "--from", "1", "--to", "7"]),
      ).toEqual([
        "diff of:shape  (1 → 7)",
        "  - gone: 1",
        "  + fresh: 2",
      ]);
      expect(
        await lines(["diff", rich, "of:shared", "--from", "3", "--to", "6"]),
      ).toEqual(["diff of:shared  (3 → 6)", "  ~ n: 1 → 4"]);
    });

    it("prints an entity created in the range as added at the root", async () => {
      expect(await lines(["diff", rich, "of:shape"])).toEqual([
        "diff of:shape  (birth → latest)",
        "  (created in range)",
        "  + (root): {kept, fresh}",
      ]);
    });

    it("prints an entity deleted in the range as removed at the root", async () => {
      expect(
        await lines(["diff", rich, "of:doomed", "--from", "1", "--to", "7"]),
      ).toEqual([
        "diff of:doomed  (1 → 7)",
        "  (deleted in range)",
        '  - (root): "short-lived"',
      ]);
    });

    it("prints a change at the focused path as at the root", async () => {
      expect(
        await lines([
          "diff",
          rich,
          "of:shared",
          "--path",
          "n",
          "--from",
          "3",
          "--to",
          "4",
        ]),
      ).toEqual(["diff of:shared  (3 → 4)", "  ~ (root): 1 → 2"]);
    });

    it("prints that nothing changed between equal states", async () => {
      expect(
        await lines(["diff", rich, "of:input", "--from", "1", "--to", "9"]),
      ).toEqual(["diff of:input  (1 → 9)", "  (no changes)"]);
    });
  });

  describe("timeline", () => {
    it("prints how a space grew, commit by commit", async () => {
      const output = await lines(["timeline", rich]);
      expect(output[0]).toBe("space growth  (9 commits)");
      expect(output[1]).toBe(
        "  #1\t+6 new\t6 touched\tΣ6\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:00:00",
      );
      expect(output.at(-1)).toBe(
        "  #9\t+0 new\t0 touched\tΣ11\tbare-session-without-…\t2026-01-01 00:08:00",
      );
    });

    it("prints how an entity evolved, including unchanged and unreadable writes", async () => {
      // The unreadable write's stored text is `{not json`, and the line names
      // the error parsing it raises.
      let parseError: unknown;
      try {
        JSON.parse("{not json");
      } catch (error) {
        parseError = error;
      }
      if (!(parseError instanceof SyntaxError)) {
        throw new Error("`JSON.parse()` did not raise a `SyntaxError`.");
      }

      expect(await lines(["timeline", timeline, "of:steady"])).toEqual([
        "timeline of of:steady  (4 writes)",
        "  seq=1\tset\t1 changes\t1\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:00:00",
        "  seq=2\tset\t—\t1\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:01:00",
        `  seq=3\tset\t? changes\t«unknown: ${parseError.message}»\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:02:00`,
        "  seq=4\tset\t? changes\t2\tz6MkIn…AAAA/aaaaaaaa\t2026-01-01 00:03:00",
      ]);
    });
  });
});
