import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { PatternInstantiation } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  brandTrustedPattern,
  getPatternSourcePath,
  noteDerivedCopy,
  setPatternSourcePath,
} from "../src/builder/pattern-metadata.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * Every instantiated pattern must name the file it was DEFINED in — including a
 * nested sub-pattern, which is the population that cannot get this from
 * anywhere else.
 *
 * A pattern reloaded by identity carries no program (`patternFromMain` is the
 * source-free path on purpose), so `getPatternProgram().main` is undefined for
 * sub-patterns. The source path is stamped instead, at module-index time, and
 * the vintage gate uses it to map a recorded instantiation back to a file.
 *
 * The failure this guards is subtle: stamping the module export is not enough,
 * because a sub-pattern reaches the runner as a derivation COPY (instantiation
 * binds on mutable copies, never the frozen export). A lookup that probes only
 * the exact object misses every nested pattern while the entry pattern still
 * resolves — so the gate looks healthy and silently validates nothing nested.
 */
describe("pattern source path", () => {
  const patternShape = () => ({
    argumentSchema: { type: "object" as const },
    resultSchema: { type: "object" as const },
    nodes: [],
    result: {},
  });

  it("resolves through a derivation copy to the root original", () => {
    const original = brandTrustedPattern(patternShape());
    setPatternSourcePath(original, "/patterns/child.tsx");
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    // The stamp lands post-evaluation, on the export; the copy was made during
    // instantiation. Only the derivation walk connects them.
    expect(getPatternSourcePath(copy)).toBe("/patterns/child.tsx");
  });

  it("resolves through a chain of copies", () => {
    const original = brandTrustedPattern(patternShape());
    setPatternSourcePath(original, "/patterns/deep.tsx");
    const copy1 = patternShape();
    noteDerivedCopy(copy1, original);
    const copy2 = patternShape();
    noteDerivedCopy(copy2, copy1);
    expect(getPatternSourcePath(copy2)).toBe("/patterns/deep.tsx");
  });

  it("an unstamped value has no source path", () => {
    expect(getPatternSourcePath(patternShape())).toBeUndefined();
    expect(getPatternSourcePath(undefined)).toBeUndefined();
    expect(getPatternSourcePath("not-an-object")).toBeUndefined();
  });

  it("refuses to stamp a value with no trusted-builder provenance", () => {
    // The same gate `indexArtifact` and `recordModuleProvenance` apply, so this
    // table's population matches the artifact index's rather than holding an
    // entry for every plain exported constant. Without the gate this passes
    // silently, which is why it is asserted rather than assumed.
    const plain = { notAnArtifact: true };
    setPatternSourcePath(plain, "/patterns/should-not-stick.tsx");
    expect(getPatternSourcePath(plain)).toBeUndefined();

    // And a pattern-SHAPED object with no brand — `__cf_data`-forged data is
    // structurally `isPattern` but carries no provenance.
    const forged = patternShape();
    setPatternSourcePath(forged, "/patterns/forged.tsx");
    expect(getPatternSourcePath(forged)).toBeUndefined();
  });

  describe("end to end", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;
    let seen: PatternInstantiation[];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      seen = [];
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        onPatternInstantiated: (instantiation) => seen.push(instantiation),
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit().settled;
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("a nested sub-pattern reports its OWN file, not the parent's", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/sub.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "const inc = lift((x:number)=>x+1);",
              "export const sub = pattern<{ n: number }>(({ n }) => {",
              "  return { out: inc(n) };",
              "});",
            ].join("\n"),
          },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { sub } from './sub.tsx';",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  const child = sub({ n: value });",
              "  return { result: child.out };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "nested source path",
        undefined,
        tx,
      );
      const result = runtime.run(tx, compiled, { value: 4 }, resultCell);
      await tx.commit().settled;
      tx = runtime.edit();
      await result.pull();
      // The run really composed, so the instantiations below are real.
      expect(result.getAsQueryResult()).toEqual({ result: 5 });

      const sources = seen.map((i) => i.main);
      // No instantiation may arrive sourceless — that is the regression.
      // `not.toContain` rather than `toEqual([])`: `@std/expect`'s loose
      // equality treats `[undefined]` as equal to `[]`, so the obvious spelling
      // of this assertion cannot fail.
      expect(sources).not.toContain(undefined);
      // Each names its own definition site. Asserting the sub-pattern's file
      // specifically is the point: a lookup that resolved only the exact object
      // would still report the parent correctly and drop this one.
      expect(new Set(sources)).toEqual(new Set(["/main.tsx", "/sub.tsx"]));
    });

    it("names the DEFINING module, not a re-export barrel", async () => {
      // A re-export barrel puts the SAME artifact object in two namespaces, so
      // the stamp is written twice for it — once naming the barrel, once naming
      // the module that defines it. The defining module is the useful answer:
      // it is the file a reader edits, and the only one whose default export is
      // this pattern. Resolving to the barrel would hand the vintage gate a
      // path whose default export is something else entirely.

      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/sub.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "const inc = lift((x:number)=>x+1);",
              "export const sub = pattern<{ n: number }>(({ n }) => {",
              "  return { out: inc(n) };",
              "});",
            ].join("\n"),
          },
          {
            name: "/barrel.ts",
            contents: "export { sub } from './sub.tsx';",
          },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { sub } from './barrel.ts';",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  const child = sub({ n: value });",
              "  return { result: child.out };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "barrel source path",
        undefined,
        tx,
      );
      const result = runtime.run(tx, compiled, { value: 4 }, resultCell);
      await tx.commit().settled;
      tx = runtime.edit();
      await result.pull();
      expect(result.getAsQueryResult()).toEqual({ result: 5 });

      const sources = seen.map((i) => i.main);
      expect(sources).not.toContain(undefined);
      expect(sources).toContain("/sub.tsx");
      expect(sources).not.toContain("/barrel.ts");
    });

    it("the cached-module path records authored filenames, not identities", async () => {
      // The by-identity/warm-cache path is the one this table exists for: it
      // evaluates from cached bodies with NO source, so a pattern loaded
      // through it has no program at all. Its `fileNameForPath` is identity, so
      // what it records is whatever the cached graph keys its paths by — pin
      // that this is the AUTHORED filename and not a `cf:module/<identity>`
      // specifier, which would be worse than sourceless (a confident, unusable
      // answer).

      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/util.ts",
            contents: "export const double = (x:number)=>x*2;",
          },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "import { double } from './util.ts';",
              "const dbl = lift((x:number)=>double(x));",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  return { result: dbl(value) };",
              "});",
            ].join("\n"),
          },
        ],
      };
      const engine = runtime.harness as Engine;
      const { modules, entryIdentity } = await engine.compileToRecordGraph(
        program,
      );
      const result = await engine.evaluateCachedModules(
        modules.map((m) => ({
          identity: m.identity,
          filename: m.filename,
          code: m.js,
          // deno-lint-ignore no-explicit-any
          imports: m.imports as any,
        })),
        entryIdentity,
      );
      const recorded = result.sourcePathByIdentity;
      expect(recorded).toBeDefined();
      expect(recorded!.get(entryIdentity)).toBe("/main.tsx");
      // Both authored modules are named. (The set also holds the injected
      // runtime modules the graph folds in, e.g. `cfc.ts`, so this is a subset
      // check rather than an equality one.)
      const recordedPaths = new Set(recorded!.values());
      expect(recordedPaths.has("/main.tsx")).toBe(true);
      expect(recordedPaths.has("/util.ts")).toBe(true);
      // Nothing recorded a module SPECIFIER or a bare content identity in place
      // of a filename — a path the gate would resolve against the repo root and
      // fail on, having been told confidently where to look.
      for (const path of recordedPaths) {
        expect(path.startsWith("cf:module/")).toBe(false);
        expect(recorded!.has(path)).toBe(false);
      }
    });
  });
});
