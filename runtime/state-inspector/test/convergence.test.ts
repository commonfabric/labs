// Hermetic test for cross-space convergence. Builds several tiny space DBs in a
// temp dir holding the SAME entity id with converged / diverged / partial state,
// then checks the verdicts. Side-effect free.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/api";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";

import {
  convergence,
  convergenceExact,
  type ConvergenceResult,
  convergenceScan,
  convergenceScanExact,
  type ConvergenceVerdict,
  type ExactConvergenceResult,
  type ExactScanResult,
  openSpaces,
  type ScanResult,
} from "../multispace.ts";

function describeLegacyVerdict(verdict: ConvergenceVerdict): string {
  switch (verdict) {
    case "converged":
    case "diverged":
    case "partial":
    case "absent":
      return verdict;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

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

// Write a single set of an entity's value into a fresh space DB.
function makeSpace(
  path: string,
  entries: { id: string; value: FabricValue }[],
) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  entries.forEach((e, i) => {
    const seq = i + 1;
    commit.run(seq, `session-${i}`, 1, JSON.stringify({ seq }));
    rev.run(e.id, seq, jsonFromFabricValue({ value: e.value }), seq);
  });
  db.close();
}

function corruptEntity(path: string, id: string): void {
  const db = new Database(path);
  db.prepare("UPDATE revision SET data = ? WHERE id = ?").run("{", id);
  db.close();
}

Deno.test("cross-space convergence", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-converge-" });
  try {
    await t.step("base scan results omit the exact unknown count", () => {
      const legacyFinding: ConvergenceResult = {
        id: "of:legacy",
        scope: "space",
        branch: "",
        path: [],
        verdict: "converged",
        views: [],
        clusters: [],
        caveat: "",
      };
      const baseResult: ScanResult = {
        sharedEntities: 0,
        examined: 0,
        examineCapped: false,
        crossSpaceLinkEdges: 0,
        linkedFindings: 0,
        unlinkedFindings: 0,
        findings: [legacyFinding],
      };
      assertEquals(
        describeLegacyVerdict(baseResult.findings[0].verdict),
        "converged",
      );
    });

    // X agrees in A & B, disagrees in C; Y is present only in A & B (partial); Z only in A.
    makeSpace(`${dir}/A.sqlite`, [
      { id: "of:X", value: { n: 1 } },
      { id: "of:Y", value: { ok: true } },
      { id: "of:Z", value: { solo: 1 } },
    ]);
    makeSpace(`${dir}/B.sqlite`, [
      { id: "of:X", value: { n: 1 } },
      { id: "of:Y", value: { ok: true } },
    ]);
    makeSpace(`${dir}/C.sqlite`, [
      { id: "of:X", value: { n: 999 } },
    ]);
    makeSpace(`${dir}/U1.sqlite`, [
      { id: "of:U", value: { maybe: undefined } },
    ]);
    makeSpace(`${dir}/U2.sqlite`, [
      { id: "of:U", value: {} },
    ]);
    makeSpace(`${dir}/Error1.sqlite`, [
      { id: "of:Error", value: { n: 1 } },
    ]);
    makeSpace(`${dir}/Error2.sqlite`, [
      { id: "of:Error", value: { n: 1 } },
    ]);
    makeSpace(`${dir}/ErrorGood.sqlite`, [
      { id: "of:Error", value: { n: 1 } },
    ]);
    corruptEntity(`${dir}/Error1.sqlite`, "of:Error");
    corruptEntity(`${dir}/Error2.sqlite`, "of:Error");

    const refs = openSpaces([
      `${dir}/A.sqlite`,
      `${dir}/B.sqlite`,
      `${dir}/C.sqlite`,
    ]);
    try {
      await t.step("diverged: X differs in C", () => {
        const r: ConvergenceResult = convergence(refs, { id: "of:X" });
        assertEquals(r.verdict, "diverged");
        assertEquals(r.clusters.length, 2);
        // the {n:1} cluster holds A and B
        const big = r.clusters.find((c) => c.labels.length === 2);
        assertEquals(big?.labels.sort(), ["A.sqlite", "B.sqlite"]);
      });

      await t.step("partial: Y present in A,B but absent in C", () => {
        const r = convergence(refs, { id: "of:Y" });
        assertEquals(r.verdict, "partial");
        assertEquals(r.views.filter((v) => v.present).length, 2);
        assertEquals(
          r.views.find((v) => v.label === "C.sqlite")?.present,
          false,
        );
      });

      await t.step("absent: unknown entity", () => {
        assertEquals(convergence(refs, { id: "of:nope" }).verdict, "absent");
      });

      await t.step("path-scoped convergence", () => {
        // X.n converges to 1 across A,B; C diverges at 999
        const r = convergence(refs, { id: "of:X", path: ["n"] });
        assertEquals(r.verdict, "diverged");
        const c = r.views.find((v) => v.label === "C.sqlite");
        assertEquals(c?.value, 999);
      });

      await t.step("missing paths differ visibly from stored undefined", () => {
        const presenceRefs = openSpaces([
          `${dir}/U1.sqlite`,
          `${dir}/U2.sqlite`,
        ]);
        try {
          const result = convergence(presenceRefs, {
            id: "of:U",
            path: ["maybe"],
          });
          assertEquals(result.verdict, "diverged");
          assertEquals(
            result.views.map((view) => view.pathExists),
            [true, false],
          );
          assertEquals(
            result.clusters.map((cluster) => cluster.value),
            [{ $undefined: true }, { $missing: true }],
          );
          assertEquals(
            result.clusters.map((cluster) => cluster.pathExists),
            [true, false],
          );
          assert(Object.isFrozen(result.views[1].value));
        } finally {
          for (const ref of presenceRefs) ref.space.close();
        }
      });

      await t.step("decode failures make convergence unknown", () => {
        const allErrored = openSpaces([
          `${dir}/Error1.sqlite`,
          `${dir}/Error2.sqlite`,
        ]);
        const partlyErrored = openSpaces([
          `${dir}/Error1.sqlite`,
          `${dir}/ErrorGood.sqlite`,
        ]);
        try {
          const failed: ExactConvergenceResult = convergenceExact(allErrored, {
            id: "of:Error",
          });
          assertEquals(failed.verdict, "unknown");
          assertEquals(failed.clusters, []);
          assert(failed.views.every((view) => view.error !== undefined));

          const mixed = convergenceExact(partlyErrored, { id: "of:Error" });
          assertEquals(mixed.verdict, "unknown");
          assertEquals(mixed.clusters.length, 1);

          const legacy: ConvergenceResult = convergence(allErrored, {
            id: "of:Error",
          });
          assertEquals(legacy.verdict, "converged");
          assertEquals(legacy.clusters.length, 1);
          assertEquals(
            legacy.views.map((view) => view.valueKey),
            ["«decode-error»", "«decode-error»"],
          );

          const scan: ExactScanResult = convergenceScanExact(allErrored, {
            linkIndex: false,
          });
          assertEquals(scan.findings.map((finding) => finding.verdict), [
            "unknown",
          ]);
          assertEquals(scan.linkedFindings, 0);
          assertEquals(scan.unlinkedFindings, 0);
          assertEquals(scan.unknownFindings, 1);
        } finally {
          for (const ref of [...allErrored, ...partlyErrored]) {
            ref.space.close();
          }
        }
      });

      await t.step("scan surfaces X (diverged) and Y (partial), not Z", () => {
        const scan: ScanResult = convergenceScan(refs);
        const ids = scan.findings.map((f) => f.id).sort();
        assertEquals(ids, ["of:X", "of:Y"]);
        // Z is solo (present in only one space) → not a shared entity
        assert(!ids.includes("of:Z"));
      });
    } finally {
      for (const r of refs) r.space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
