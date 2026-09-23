import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  openFileBackedRuntime,
  readVintageManifest,
  strandedKeys,
  type VintageManifestEntry,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";
import { derivedCorrectionsFor } from "./pattern-vintage-derived-corrections.ts";
import type { VintageRef } from "./pattern-vintage-lib.ts";
import { replayVintage } from "./pattern-vintage-run.ts";

const repoRoot = fromFileUrl(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);
const fixture: VintageRef = {
  testKey: "lunch-poll/main.test.tsx",
  tier: "pinned",
  stamp: "2026-07-30T21-32-46.548Z",
  identity: "vKpn8ERxJNomhrTLevYIZ5cL3qg_QKk73pMRtnPKJwM",
  path: repoRoot +
    "/packages/piece/test/vintages/lunch-poll/main.test.tsx/pinned/2026-07-30T21-32-46.548Z-vKpn8ERxJNomhrTLevYIZ5cL3qg_QKk73pMRtnPKJwM.sqlite",
};
const entry: VintageManifestEntry = {
  cellId: "of:fid1:nBd8WTpSRoVy0BNB2CKnWShQAhJJOS8pqYFHL45hI1U",
  identity: "iJLndA3hnQHY1W_revxrP3ENer9VYf2tIFNCOjoPV6Y",
  main: "/packages/patterns/lunch-poll/poll-option-card.tsx",
  space: "did:key:z6MkiP8m4ES1oC1PwNdjNDut2nXWP6TY2EJceCHmSdYUmoEm",
  symbol: "default",
};
const secondRoot = "of:fid1:qLOvr9VSkYDzl-vOQ4t0ztIxXKSIhgPVwtBcD-fihXU";

describe("pattern-vintage-derived-corrections", () => {
  it("finds one recorded instantiation for each approved root", async () => {
    // `derivedCorrectionsFor` grades on an exact space, cell, source, symbol
    // and identity, so the entry every grading test below hands it is read
    // back from the fixture here rather than trusted: a literal that no longer
    // matches what the fixture holds is a policy that forgives nothing while
    // those tests still pass. Replaying the fixture under today's source
    // belongs to the `pattern-vintage` gate, which fails on every approval
    // `unused()` reports.

    const dir = await Deno.makeTempDir({ prefix: "derived-corrections-" });
    // The open is inside the try, because restoring the fixture is a way it
    // throws and the temp copy it made by then is 3.5 MiB.
    let vintage: Awaited<ReturnType<typeof openFileBackedRuntime>> | undefined;
    let entries: readonly VintageManifestEntry[];
    try {
      vintage = await openFileBackedRuntime(
        await Identity.fromPassphrase("pattern vintage fixture"),
        dir,
        fixture.path,
      );
      entries = (await readVintageManifest(vintage))?.entries ?? [];
    } finally {
      await vintage?.dispose().catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    expect(entries.filter((held) => held.cellId === entry.cellId))
      .toEqual([entry]);
    expect(entries.filter((held) => held.cellId === secondRoot))
      .toEqual([{ ...entry, cellId: secondRoot }]);
  });

  it("reports approved transitions as changes while retaining authored losses", async () => {
    const policy = await derivedCorrectionsFor(fixture, repoRoot);
    expect(policy).toBeDefined();
    const findings = strandedKeys(
      { artSyncState: "generated", title: "Lunch", votes: [{ by: "Ada" }] },
      { artSyncState: "", title: "", votes: [] },
    );
    expect(findings.every((finding) => finding.lost)).toBe(true);
    const graded = policy!.grade(entry, findings);
    expect(
      graded.filter((finding) => finding.lost).map((finding) => finding.key),
    ).toEqual(["title", "votes"]);
    expect(graded.find((finding) => finding.key === "artSyncState")).toEqual({
      key: "artSyncState",
      before: "generated",
      after: "",
      lost: false,
    });
    expect(policy!.unused()).toEqual([secondRoot]);
    policy!.grade({ ...entry, cellId: secondRoot }, findings);
    expect(policy!.unused()).toEqual([]);
    expect(findings.every((finding) => finding.lost)).toBe(true);
  });

  it("fails unused approvals when the recorded patterns cannot be replayed", async () => {
    const dir = await Deno.makeTempDir();
    const record =
      "docs/history/development/2026-09-14-derived-state-correction.md";
    try {
      await Deno.mkdir(dir + "/docs/history/development", { recursive: true });
      await Deno.copyFile(repoRoot + "/" + record, dir + "/" + record);
      const report = await replayVintage({
        repoRoot: dir,
        patternsRoot: dir + "/packages/patterns",
        vintagesRoot: dir + "/packages/piece/test/vintages",
        signer: await Identity.fromPassphrase("pattern vintage fixture"),
      }, fixture);
      expect(report.targets).toBeGreaterThan(0);
      expect(report.updated).toBe(0);
      expect(
        report.failures.filter((failure) =>
          failure.detail.startsWith("approved derived-state correction")
        ).map((failure) => failure.detail),
      ).toEqual(
        [entry.cellId, secondRoot].map((root) =>
          `approved derived-state correction for ${root} was unused; ` +
          "remove or re-evaluate its decision"
        ),
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("keeps losses on other roots, scopes, patterns, exports, and identities", async () => {
    const policy = (await derivedCorrectionsFor(fixture, repoRoot))!;
    const findings = strandedKeys({ artSyncState: "generated" }, {
      artSyncState: "",
    });
    for (
      const other of [
        { cellId: "of:another-root" },
        { space: "did:example:other" },
        { main: "/packages/patterns/other.tsx" },
        { symbol: "other" },
        { identity: "other" },
      ]
    ) expect(policy.grade({ ...entry, ...other }, findings)).toEqual(findings);
    expect(policy.unused()).toEqual([entry.cellId, secondRoot]);
  });

  it("keeps a missing field and different or nested value transitions as losses", async () => {
    const policy = (await derivedCorrectionsFor(fixture, repoRoot))!;
    for (
      const [before, after] of [
        [{ artSyncState: "generated" }, {}],
        [{ artSyncState: "stored" }, { artSyncState: "" }],
        [{ artSyncState: { value: "generated" } }, { artSyncState: {} }],
        [{ nested: { artSyncState: "generated" } }, {
          nested: { artSyncState: "" },
        }],
      ]
    ) {
      const findings = strandedKeys(before, after);
      expect(findings.some((finding) => finding.lost)).toBe(true);
      expect(policy.grade(entry, findings)).toEqual(findings);
    }
    expect(policy.unused()).toEqual([entry.cellId, secondRoot]);
  });

  it("returns no policy for another fixture provenance", async () => {
    for (
      const other of [
        { testKey: "other.test.tsx" },
        { tier: "auto" },
        { stamp: "2026-07-31T21-32-46.548Z" },
        { identity: "other" },
      ]
    ) {
      expect(await derivedCorrectionsFor({ ...fixture, ...other }, repoRoot))
        .toBeUndefined();
    }
  });

  it("returns no policy when fixture bytes change or a companion store is added", async () => {
    const dir = await Deno.makeTempDir();
    const copy = { ...fixture, path: dir + "/fixture.sqlite" };
    try {
      await Deno.copyFile(fixture.path, copy.path);
      expect(await derivedCorrectionsFor(copy, repoRoot)).toBeDefined();
      await Deno.mkdir(vintageCompanionDir(copy.path));
      expect(await derivedCorrectionsFor(copy, repoRoot)).toBeUndefined();
      await Deno.remove(vintageCompanionDir(copy.path));
      const bytes = await Deno.readFile(copy.path);
      bytes[bytes.length - 1] ^= 1;
      await Deno.writeFile(copy.path, bytes);
      expect(await derivedCorrectionsFor(copy, repoRoot)).toBeUndefined();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("refuses a verified fixture without its decision record", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await expect(derivedCorrectionsFor(fixture, dir)).rejects.toThrow(
        "Missing derived-state correction decision",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
