import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { compactStore } from "@commonfabric/memory/v2/compact";
import {
  applyCommit,
  type ApplyCommitOptions,
  close,
  open,
} from "@commonfabric/memory/v2/engine";

import { verifyCompaction } from "../compaction.ts";

/** Runs a verification case against a compacted, multi-scope fixture. */
async function withCompacted(
  run: (files: { result: string; against: string }) => void,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "compaction-reuse-" });
  const store = `${dir}/store.sqlite`;
  const against = `${dir}/backup.sqlite`;
  const result = `${dir}/result.sqlite`;
  try {
    const engine = await open({ url: toFileUrl(store), snapshotInterval: 1 });
    try {
      let seq = 0;
      const apply = (
        operations: ApplyCommitOptions["commit"]["operations"],
      ) => {
        const applied = applyCommit(engine, {
          sessionId: "session:fixture",
          principal: "did:key:zFixture",
          commit: {
            localSeq: ++seq,
            reads: { confirmed: [], pending: [] },
            operations,
          },
        });
        expect(applied.revisions).toHaveLength(operations.length);
      };
      for (const id of ["computed:cut", "of:patched"] as const) {
        apply([{ op: "set", id, value: { value: { n: 0 } } }]);
        for (let n = 1; n <= 4; n++) {
          apply([{
            op: "patch",
            id,
            patches: [{ op: "replace", path: "/value/n", value: n }],
          }]);
        }
      }
      for (const scope of ["space", "user", "session"] as const) {
        apply([{
          op: "set",
          id: "computed:generated",
          scope,
          value: { value: 1 },
        }]);
      }
      apply([{
        op: "set",
        id: "of:owner",
        scope: "user",
        value: {
          value: "owner",
          patternIdentity: {},
          internal: [{
            partialCause: { $generated: 1 },
            link: { "/": { "link@1": { id: "computed:generated", path: [] } } },
          }],
        },
      }]);
      for (
        const id of [
          "of:orphan",
          "of:missing",
          "of:z",
          "of:a",
          "of:b",
          "of:c",
          "of:d",
          "of:e",
        ] as const
      ) {
        apply([{
          op: "set",
          id,
          scope: id === "of:a" ? "user" : "space",
          value: { value: 1 },
        }]);
      }
    } finally {
      close(engine);
    }
    Deno.copyFileSync(store, against);
    await compactStore({
      store,
      out: result,
      selection: { prefixes: ["computed:cut"] },
      keepPayloadsMs: 0,
      cut: { keepLast: 3 },
      runId: "reuse",
    });
    run({ result, against });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** Alters only a disposable fixture, closing it before read-only verification. */
function change(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("compaction", () => {
  it("passes a full scan and the explicitly sampled scan", async () => {
    await withCompacted((files) => {
      const full = verifyCompaction(files);
      expect(full.ok).toBe(true);
      expect(full.checks).toHaveLength(24);
      expect(verifyCompaction({ ...files, sample: 2 }).ok).toBe(true);
    });
  });

  it("compares generated session documents even when fingerprints exclude them", async () => {
    await withCompacted((files) => {
      change(
        files.result,
        `UPDATE revision SET data='{"value":99}'
        WHERE id='computed:generated' AND scope_key LIKE 'session:%'`,
      );
      const report = verifyCompaction(files);
      expect(report.checks.find((c) => c.name === "fingerprint")?.passed).toBe(
        true,
      );
      expect(
        report.checks.find((c) =>
          c.name === "every document reads back identical"
        )?.passed,
      ).toBe(false);
      expect(report.checks).toHaveLength(24);
    });
  });

  it("reports identical corruption on both sides as unreadable", async () => {
    await withCompacted((files) => {
      for (const path of [files.result, files.against]) {
        change(
          path,
          "UPDATE revision SET data='malformed' WHERE id='computed:generated'",
        );
      }
      const report = verifyCompaction(files);
      expect(
        report.checks.find((c) =>
          c.name === "every document reads back identical"
        )?.passed,
      ).toBe(false);
      expect(report.checks.find((c) => c.name === "fingerprint")?.passed).toBe(
        true,
      );
      expect(report.checks).toHaveLength(24);
    });
  });

  it("decodes a corrupt older set base even when a newer snapshot exists", async () => {
    await withCompacted((files) => {
      for (const path of [files.result, files.against]) {
        change(
          path,
          "UPDATE revision SET data='malformed' WHERE id='of:patched' AND op='set'",
        );
      }
      const report = verifyCompaction(files);
      expect(
        report.checks.find((c) =>
          c.name === "every document reads back identical"
        )?.passed,
      ).toBe(false);
      expect(report.checks.find((c) => c.name === "fingerprint")?.passed).toBe(
        false,
      );
      expect(report.checks).toHaveLength(24);
    });
  });

  it("fingerprints revisions that have no head row", async () => {
    await withCompacted((files) => {
      for (const path of [files.result, files.against]) {
        change(path, "DELETE FROM head WHERE id='of:orphan'");
      }
      change(
        files.result,
        "UPDATE revision SET data='{\"value\":99}' WHERE id='of:orphan'",
      );
      const report = verifyCompaction(files);
      expect(
        report.checks.find((c) =>
          c.name === "every document reads back identical"
        )?.passed,
      ).toBe(true);
      expect(report.checks.find((c) => c.name === "fingerprint")?.passed).toBe(
        false,
      );
      expect(report.checks).toHaveLength(24);
    });
  });

  it("compares heads the backup fingerprint cannot enumerate", async () => {
    await withCompacted((files) => {
      change(files.against, "DELETE FROM revision WHERE id='of:missing'");
      const report = verifyCompaction(files);
      expect(
        report.checks.find((c) =>
          c.name === "every document reads back identical"
        )?.detail,
      )
        .toContain("of:missing (space)");
      expect(report.checks).toHaveLength(24);
    });
  });

  it("compares remaining heads after a fingerprint classification fails", async () => {
    await withCompacted((files) => {
      for (const path of [files.result, files.against]) {
        change(
          path,
          `UPDATE revision SET data='{"value":{"code":"","identity":"module","filename":1}}'
           WHERE id='of:b'`,
        );
      }
      change(
        files.result,
        `UPDATE revision SET data='{"value":99}' WHERE id IN ('of:a','of:z')`,
      );
      const report = verifyCompaction(files);
      const comparison = report.checks.find((c) =>
        c.name === "every document reads back identical"
      );
      expect(comparison?.passed).toBe(false);
      expect(comparison?.detail).toMatch(
        /differ or unreadable: of:a \(user:[^)]*\), of:z \(space\)$/,
      );
      expect(report.checks.find((c) => c.name === "fingerprint")?.passed)
        .toBe(false);
      expect(report.checks).toHaveLength(24);
    });
  });

  it("orders mismatch examples by head address across scopes", async () => {
    await withCompacted((files) => {
      change(
        files.result,
        `UPDATE revision SET data='{"value":99}'
        WHERE id IN ('of:a','of:b','of:c','of:d','of:e','of:z')`,
      );
      const report = verifyCompaction(files);
      const detail = report.checks.find((c) =>
        c.name === "every document reads back identical"
      )?.detail;
      expect(detail).toMatch(
        /differ or unreadable: of:a \(user:[^)]*\), of:b \(space\), of:c \(space\), of:d \(space\), of:e \(space\)$/,
      );
    });
  });
});
