/**
 * The adopter's own invariant: an adopt the tool accepts must be a replay the
 * gate accepts, and an adopt the gate would refuse must refuse HERE, with
 * nothing written. `captureVintage` holds the same invariant for native
 * captures; these cases hold it for the adopted route, where the operator
 * supplies by hand what a capture derives mechanically — so every argument is
 * a chance to pin a fixture whose every replay fails.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  materializeOnCell,
  openFileBackedRuntime,
} from "../runtime/piece/test/state-continuity-harness.ts";
import { type AdoptRoots, adoptVintage } from "./vintage-adopt.ts";
import { collectVintages } from "./pattern-vintage-lib.ts";
import { replayAll } from "./pattern-vintage-run.ts";

const signer = await Identity.fromPassphrase("pattern vintage fixture");

const KEY = "adopt-subject.tsx";
const CAUSE = "adopt-test-root";

/** Minimal but real: a durable `.for()` cell, so the replay's before/after
 * comparison has state to protect. */
const SUBJECT = [
  "import { Writable, pattern } from 'commonfabric';",
  "export interface Output { items: Writable<string[]> }",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const items = new Writable<string[]>(['kept']).for('items');",
  "  return { items };",
  "});",
  "",
].join("\n");

/**
 * A compatible evolution of SUBJECT — a new defaulted field — so today's
 * identity differs from the captured one and the replay actually
 * materializes and compares state instead of short-circuiting on an
 * unchanged identity. This is the shape a real adoption always has: the
 * whole point of an old-toolchain capture is that today's source moved on.
 */
const SUBJECT_CHANGED = SUBJECT
  .replace(
    "import { Writable, pattern }",
    "import { Default, Writable, pattern }",
  )
  .replace(
    "export interface Output { items: Writable<string[]> }",
    "export interface Output { items: Writable<string[]>; " +
      "later: Writable<string[] | Default<[]>> }",
  )
  .replace(
    "  return { items };",
    "  const later = new Writable<string[]>([]).for('later');\n" +
      "  return { items, later };",
  );

const CHILD_KEY = "adopt-child.tsx";
const CHILD_CAUSE = "adopt-child-root";

/** A second, independent pattern standing in for a sub-pattern root: the
 * adopter addresses children by entity id, so where the id came from does not
 * matter to what is under test. */
const CHILD = SUBJECT.replace("['kept']", "['child-kept']");

const NAMED_KEY = "adopt-named.tsx";
const NAMED_CAUSE = "adopt-named-root";

/** A module contributing TWO artifacts, whose named one a capture can record
 * — the shape a real stored root takes when it names a non-entry artifact. */
const NAMED = [
  "import { Writable, pattern } from 'commonfabric';",
  "export const Extra = pattern<Record<string, never>, { items: Writable<string[]> }>(() => {",
  "  const items = new Writable<string[]>(['extra']).for('items');",
  "  return { items };",
  "});",
  "export default pattern<Record<string, never>, { items: Writable<string[]> }>(() => {",
  "  const items = new Writable<string[]>(['main']).for('items');",
  "  return { items };",
  "});",
  "",
].join("\n");

/** The same module after today dropped the named export. */
const NAMED_WITHOUT_EXTRA = [
  "import { Writable, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { items: Writable<string[]> }>(() => {",
  "  const items = new Writable<string[]>(['main']).for('items');",
  "  return { items };",
  "});",
  "",
].join("\n");

describe("vintage adopt", () => {
  let dir = "";
  let roots: AdoptRoots;
  let snapshotPath = "";
  let identity = "";
  let childCellId = "";
  let namedCellId = "";

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "vintage-adopt-test-" });
    await Deno.mkdir(`${dir}/patterns`, { recursive: true });
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT);
    await Deno.writeTextFile(`${dir}/patterns/${CHILD_KEY}`, CHILD);
    await Deno.writeTextFile(`${dir}/patterns/${NAMED_KEY}`, NAMED);
    roots = {
      repoRoot: dir,
      patternsRoot: `${dir}/patterns`,
      vintagesRoot: `${dir}/vintages`,
      signer,
    };

    // Stand in for an external capture: a store holding the subject
    // materialized at a known cause. The adopter must not care who wrote the
    // store — only that the root at the cause carries a pattern identity.
    const storeDir = await Deno.makeTempDir({ prefix: "adopt-capture-" });
    const capture = await openFileBackedRuntime(signer, storeDir);
    try {
      const program = await resolveLocalProgram(
        (resolver) => capture.runtime.harness.resolve(resolver),
        { main: `${dir}/patterns/${KEY}`, root: dir },
      );
      const outcome = await materializeOnCell(
        capture,
        program as never,
        (v, resultSchema) =>
          v.runtime.getCell(
            v.space as never,
            CAUSE,
            resultSchema as never,
          ),
      );
      expect(outcome.error).toBeUndefined();
      identity = capture.runtime.patternManager.getArtifactEntryRef(
        await capture.runtime.patternManager.compilePattern(program as never, {
          space: capture.space as never,
        }),
      )!.identity;

      const childProgram = await resolveLocalProgram(
        (resolver) => capture.runtime.harness.resolve(resolver),
        { main: `${dir}/patterns/${CHILD_KEY}`, root: dir },
      );
      const childOutcome = await materializeOnCell(
        capture,
        childProgram as never,
        (v, resultSchema) =>
          v.runtime.getCell(
            v.space as never,
            CHILD_CAUSE,
            resultSchema as never,
          ),
      );
      expect(childOutcome.error).toBeUndefined();
      childCellId = String(
        (capture.runtime.getCell(
          capture.space as never,
          CHILD_CAUSE,
          undefined as never,
        ) as { getAsNormalizedFullLink(): { id: string } })
          .getAsNormalizedFullLink().id,
      );

      // A root recorded under a NAMED artifact, for the dropped-symbol case.
      const namedProgram = await resolveLocalProgram(
        (resolver) => capture.runtime.harness.resolve(resolver),
        { main: `${dir}/patterns/${NAMED_KEY}`, root: dir },
      );
      const namedOutcome = await materializeOnCell(
        capture,
        namedProgram as never,
        (v, resultSchema) =>
          v.runtime.getCell(
            v.space as never,
            NAMED_CAUSE,
            resultSchema as never,
          ),
        { symbol: "Extra" },
      );
      expect(namedOutcome.error).toBeUndefined();
      namedCellId = String(
        (capture.runtime.getCell(
          capture.space as never,
          NAMED_CAUSE,
          undefined as never,
        ) as { getAsNormalizedFullLink(): { id: string } })
          .getAsNormalizedFullLink().id,
      );

      snapshotPath = `${dir}/external-capture.sqlite`;
      await capture.snapshot(snapshotPath);
    } finally {
      await capture.dispose();
      await Deno.remove(storeDir, { recursive: true }).catch(() => {});
    }
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  const adopt = (overrides: Record<string, unknown> = {}) =>
    adoptVintage({
      snapshotPath,
      expectedIdentity: identity,
      testKey: "adopt-subject.test.tsx",
      main: `/patterns/${KEY}`,
      cause: CAUSE,
      roots,
      now: new Date("2026-08-04T12:00:00.000Z"),
      ...overrides,
    });

  it("adopts a snapshot the replay then accepts and MIGRATES", async () => {
    // The invariant itself, end to end — and through the path adoption
    // exists for. The source moves on after the capture, so today's identity
    // differs from the recorded one and the replay must actually materialize
    // today's source over the adopted root and compare state, not
    // short-circuit on an unchanged identity.
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT_CHANGED);
    const dest = await adopt();
    expect((await Deno.stat(dest)).size).toBeGreaterThan(0);
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);

    const { replayed, failures, changed, updated, stranded } = await replayAll(
      roots,
    );
    expect(failures).toEqual([]);
    expect(replayed).toBe(1);
    expect(changed).toBe(1);
    expect(updated).toBe(1);
    expect(stranded).toBe(0);
  });

  it("records children the replay then materializes as targets", async () => {
    // The reason `children` exists: a manifest holding only the root leaves
    // every sub-pattern root outside the gate's presence and state controls.
    // Each child's identity and symbol must come from its own stored
    // patternIdentity, and the child must replay as a full target.
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT_CHANGED);
    await Deno.writeTextFile(
      `${dir}/patterns/${CHILD_KEY}`,
      CHILD.replace("['child-kept']", "['child-kept', 'evolved']"),
    );
    await adopt({
      children: [{ cellId: childCellId, main: `/patterns/${CHILD_KEY}` }],
    });

    const report = await replayAll(roots);
    expect(report.failures).toEqual([]);
    expect(report.targets).toBe(2);
    expect(report.changed).toBe(2);
    expect(report.updated).toBe(2);
    expect(report.stranded).toBe(0);
  });

  it("refuses a child id that carries no patternIdentity", async () => {
    await expect(
      adopt({
        children: [{
          cellId: "of:fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          main: `/patterns/${CHILD_KEY}`,
        }],
      }),
    ).rejects.toThrow("carries no patternIdentity");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a stored symbol today's module dropped", async () => {
    // A stored root can legitimately name a non-entry artifact. If today's
    // module no longer defines that symbol, the replay refuses the entry
    // (materializeOnCell fails closed) — so the adopt must refuse it first,
    // by the same selection rule.
    await Deno.writeTextFile(
      `${dir}/patterns/${NAMED_KEY}`,
      NAMED_WITHOUT_EXTRA,
    );
    await expect(
      adopt({
        children: [{ cellId: namedCellId, main: `/patterns/${NAMED_KEY}` }],
      }),
    ).rejects.toThrow('defines no "Extra"');
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("adopts a stored NAMED symbol today's module still defines", async () => {
    // The positive half of the symbol rule: a recorded non-entry artifact
    // that still resolves adopts and replays as a target.
    await adopt({
      children: [{ cellId: namedCellId, main: `/patterns/${NAMED_KEY}` }],
    });
    const report = await replayAll(roots);
    expect(report.failures).toEqual([]);
    expect(report.targets).toBe(2);
  });

  it("refuses a duplicated child cell, writing nothing", async () => {
    // The replay's materialize/accounting loop iterates every manifest entry,
    // so a duplicated cell would inflate targets/changed/updated — and with
    // two different mains would apply two programs to one root.
    const child = { cellId: childCellId, main: `/patterns/${CHILD_KEY}` };
    await expect(adopt({ children: [child, { ...child }] })).rejects.toThrow(
      "duplicate child cell id",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses the entry root listed as a child", async () => {
    // Derive the root's id the same way the adopter does, then hand it back
    // as a child: one cell must never be two manifest entries.
    const probe = await openFileBackedRuntime(
      signer,
      await Deno.makeTempDir({ prefix: "adopt-root-id-" }),
      snapshotPath,
    );
    let rootId = "";
    try {
      const root = probe.runtime.getCell(
        probe.space as never,
        CAUSE,
        undefined as never,
      ) as {
        sync(): Promise<unknown>;
        getAsNormalizedFullLink(): { id: string };
      };
      await root.sync();
      rootId = String(root.getAsNormalizedFullLink().id);
    } finally {
      await probe.dispose();
    }
    await expect(
      adopt({ children: [{ cellId: rootId, main: `/patterns/${CHILD_KEY}` }] }),
    ).rejects.toThrow("is also listed as a child");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a main the replay could not map, writing nothing", async () => {
    await expect(adopt({ main: "not-a-repo-path" })).rejects.toThrow(
      "does not map to a pattern key",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a test entry, which is never an upgrade target", async () => {
    await expect(adopt({ main: "/patterns/adopt-subject.test.tsx" })).rejects
      .toThrow("not an upgrade target");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a served route, which is not identity-compared", async () => {
    // `patternKeyFromMain` maps `/api/patterns/...` too, but the replay
    // accounts served routes apart from identity comparison — the opposite of
    // what an adopted fixture is for.
    await expect(adopt({ main: `/api/patterns/${KEY}` })).rejects.toThrow(
      "served route",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses when today's source for main is missing", async () => {
    await expect(adopt({ main: "/patterns/no-such-file.tsx" })).rejects
      .toThrow("does not resolve");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses when today's source no longer compiles", async () => {
    // The drift class itself, pointed the WRONG way: the fixture must hold an
    // old source today cannot compile, but a pin against a broken CURRENT
    // source would fail every replay from the moment it lands.
    await Deno.writeTextFile(
      `${dir}/patterns/${KEY}`,
      SUBJECT.replace("['kept']", "(no_such_symbol)"),
    );
    await expect(adopt()).rejects.toThrow("does not compile");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses an identity the stored root does not carry", async () => {
    await expect(adopt({ expectedIdentity: "someOtherIdentity" })).rejects
      .toThrow("!= expected");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a cause that derives no captured root", async () => {
    await expect(adopt({ cause: "nothing-was-minted-here" })).rejects.toThrow(
      "carries no patternIdentity",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("never overwrites an existing fixture", async () => {
    // Same `now`, same identity → same destination path. The second adopt
    // must refuse rather than replace the fixture the first one pinned.
    await adopt();
    await expect(adopt()).rejects.toThrow("refusing to overwrite");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });
});
