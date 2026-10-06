import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Program } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { PatternCoverageCollector } from "../src/pattern-coverage.ts";
import { writeSourceDocs } from "../src/compilation-cache/cell-cache.ts";
import { FABRIC_MOUNT_ROOT } from "../src/sandbox/module-record-compiler.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("fabric imports engine test");
const space = signer.did();

describe("Engine fabric imports", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let engine: Engine;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function dependencyProgram(value: number): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `export const x = ${value};`,
        },
      ],
    };
  }

  function importerProgram(specifier: string): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `import { x } from "${specifier}";`,
            `export function y() { return x + 1; }`,
            `export default pattern<{ value: number }>(({ value }) => ({ result: value + x }));`,
          ].join("\n"),
        },
      ],
    };
  }

  async function publish(
    program: RuntimeProgram,
    options: Parameters<Engine["compileToRecordGraph"]>[1] = {},
  ) {
    const compiled = await engine.compileToRecordGraph(program, options);
    const tx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      tx,
    );
    await tx.commit().settled;
    return compiled;
  }

  // Write a piece cell carrying the content-addressed `patternIdentity` pointer
  // so a slug → piece chase resolves to its entry identity.
  async function writePieceWithIdentity(
    entryIdentity: string,
  ): Promise<{ cell: Cell<unknown> }> {
    const cell = runtime.getCell(
      space,
      { space, random: `piece-${entryIdentity}` },
    );
    await runtime.editWithRetry((tx) => {
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set({ name: "piece" });
      cellWithTx.setMetaRaw("patternIdentity", {
        identity: entryIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    return { cell };
  }

  async function writeSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  async function poisonSlug(slug: string): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });
  }

  async function runPattern(pattern: unknown, value: number): Promise<unknown> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      `fabric import result ${value}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit().settled;
    await result.pull();
    return result.getAsQueryResult();
  }

  it("compiles, type-checks, evaluates, and describes pinned same-space imports", async () => {
    const dependency = await publish(dependencyProgram(41));
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program = importerProgram(specifier);

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });

    const mountedPath =
      `${FABRIC_MOUNT_ROOT}${dependency.entryIdentity}/main.tsx`;
    const mountedSpecifier = compiled.graph.specifierByPath.get(mountedPath);
    expect(mountedSpecifier).toBe(`cf:module/${dependency.entryIdentity}`);
    expect(compiled.graph.records.has(`cf:module/${dependency.entryIdentity}`))
      .toBe(true);

    const importerRecord = compiled.graph.records.get(compiled.mainSpecifier)!;
    expect(importerRecord.resolutions?.[specifier]).toBe(
      `cf:module/${dependency.entryIdentity}`,
    );

    const importedModule = compiled.modules.find((module) =>
      module.identity === dependency.entryIdentity
    );
    expect(importedModule?.filename).toBe("/main.tsx");
    expect(importedModule?.source).toBe(dependency.modules[0].source);

    const importerModule = compiled.modules.find((module) =>
      module.identity === compiled.entryIdentity
    );
    expect(importerModule?.imports).toContainEqual({
      specifier,
      targetIdentity: dependency.entryIdentity,
    });

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    expect(evaluated.main?.y()).toBe(42);
    expect(await runPattern(evaluated.main?.default, 1)).toEqual({
      result: 42,
    });
  });

  it("binds PolicyOf to the defining identity of a pinned cf import", async () => {
    const dependency = await publish({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
        `,
      }],
    });
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { Confidential, toSchema } from "commonfabric";
          import type { PolicyOf } from "commonfabric/cfc";
          import { rules } from "${specifier}";
          export const schema = toSchema<
            Confidential<string, [PolicyOf<typeof rules>]>
          >();
        `,
      }],
    };

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });
    const definingModule = compiled.modules.find((module) =>
      module.identity === dependency.entryIdentity
    );
    expect(definingModule?.policyManifests).toHaveLength(1);
    const artifact = definingModule?.policyManifests?.[0] as
      | { policyDigest: string }
      | undefined;

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const reference = (evaluated.main?.schema as {
      ifc?: { confidentiality?: Record<string, unknown>[] };
    }).ifc?.confidentiality?.[0];
    expect(reference).toMatchObject({
      policyRefKind: "module",
      moduleIdentity: dependency.entryIdentity,
      symbol: "rules",
      policyDigest: artifact?.policyDigest,
      subject: { __ctOwningSpace: true },
    });
    expect(reference?.moduleIdentity).not.toBe(compiled.entryIdentity);
  });

  it("binds nested writer claims to a pinned import's defining identity", async () => {
    const dependency = await publish({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { handler, Writable, WriteAuthorizedBy } from "commonfabric";
          export const commitMessage = handler<string, { message: Writable<string> }>(
            (value, { message }) => message.set(value),
          );
          export type ProtectedMessage = WriteAuthorizedBy<
            string,
            typeof commitMessage
          >;
        `,
      }],
    });
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { toSchema } from "commonfabric";
          import type { ProtectedMessage } from "${specifier}";
          interface Output { message: ProtectedMessage; }
          export const schema = toSchema<Output>();
        `,
      }],
    };

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const findWriterIdentity = (
      value: unknown,
    ): Record<string, unknown> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      const marker = record.__ctWriterIdentityOf;
      if (marker && typeof marker === "object") {
        return marker as Record<string, unknown>;
      }
      for (const child of Object.values(record)) {
        const found = findWriterIdentity(child);
        if (found) return found;
      }
      return undefined;
    };

    expect(findWriterIdentity(evaluated.main?.schema)).toEqual({
      // The mounted dependency and importer intentionally share this authored
      // spelling; the content identity is what keeps the claim unambiguous.
      file: "/main.tsx",
      path: ["commitMessage"],
      moduleIdentity: dependency.entryIdentity,
    });
    expect(dependency.entryIdentity).not.toBe(compiled.entryIdentity);
  });

  it("uses the mounted source for TypeScript diagnostics", async () => {
    const dependency = await publish(dependencyProgram(1));
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { missing } from "${specifier}";\nexport const y = missing;`,
        },
      ],
    };

    await expect(
      engine.compileToRecordGraph(program, { fabricImports: { space } }),
    ).rejects.toThrow("has no exported member 'missing'");
  });

  it("rejects fabric imports without a space context before generic resolution errors", async () => {
    const dependency = await publish(dependencyProgram(1));
    await expect(
      engine.compileToRecordGraph(
        importerProgram(`cf:pattern:${dependency.entryIdentity}`),
      ),
    ).rejects.toThrow(
      "fabric imports require a space context (options.fabricImports)",
    );
  });

  it("rejects unpinned fabric imports unless explicitly allowed", async () => {
    await expect(
      engine.compileToRecordGraph(importerProgram("cf:dep"), {
        fabricImports: { space },
      }),
    ).rejects.toThrow(
      "unpinned fabric import 'cf:dep'; pin it (cf deps update) or deploy to pin",
    );
  });

  it("resolves unpinned fabric imports in dev mode and surfaces resolved pins", async () => {
    const dependency = await publish(dependencyProgram(9));
    const { cell } = await writePieceWithIdentity(
      dependency.entryIdentity,
    );
    await writeSlug("dep", cell);

    const compiled = await engine.compileToRecordGraph(
      importerProgram("cf:dep"),
      {
        fabricImports: { space, allowUnpinned: true },
      },
    );

    expect(compiled.resolvedPins).toEqual([
      {
        specifier: "cf:dep",
        resolvedIdentity: dependency.entryIdentity,
        chain: [
          "slug:dep",
          `piece:${cell.getAsNormalizedFullLink().id}`,
          `patternIdentity:${dependency.entryIdentity}`,
          `entryIdentity:${dependency.entryIdentity}`,
        ],
      },
    ]);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      importerProgram("cf:dep"),
    );
    expect(evaluated.main?.y()).toBe(10);
  });

  it("does not chase the slug for already-pinned mutable refs", async () => {
    const dependency = await publish(dependencyProgram(11));
    const { cell } = await writePieceWithIdentity(dependency.entryIdentity);
    await writeSlug("dep", cell);
    await poisonSlug("dep");

    const compiled = await engine.compileToRecordGraph(
      importerProgram(`cf:dep@${dependency.entryIdentity}`),
      { fabricImports: { space } },
    );

    expect(compiled.resolvedPins).toEqual([]);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      importerProgram(`cf:dep@${dependency.entryIdentity}`),
    );
    expect(evaluated.main?.y()).toBe(12);
  });

  it("dedupes mounted files when different specifier texts pin the same identity", async () => {
    const dependency = await publish(dependencyProgram(2));
    const direct = `cf:pattern:${dependency.entryIdentity}`;
    const pinnedSlug = `cf:dep@${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { x as a } from "${direct}";`,
            `import { x as b } from "${pinnedSlug}";`,
            `export function total() { return a + b; }`,
          ].join("\n"),
        },
      ],
    };

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });

    expect(
      compiled.modules.filter((module) =>
        module.identity === dependency.entryIdentity
      ),
    ).toHaveLength(1);
    expect(compiled.graph.records.has(`cf:module/${dependency.entryIdentity}`))
      .toBe(true);

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    expect(evaluated.main?.total()).toBe(4);
  });

  it("keeps mounted pattern coverage keys separate for matching stored filenames", async () => {
    const first = await publish({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          `export const label = "first";`,
          `export function value() {`,
          `  return 10;`,
          `}`,
        ].join("\n"),
      }],
    });
    const second = await publish({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          `export const label = "second";`,
          `export function value() {`,
          `  return 20;`,
          `}`,
        ].join("\n"),
      }],
    });
    const firstPath = `${FABRIC_MOUNT_ROOT}${first.entryIdentity}/main.tsx`;
    const secondPath = `${FABRIC_MOUNT_ROOT}${second.entryIdentity}/main.tsx`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          `import { value as firstValue } from "cf:pattern:${first.entryIdentity}";`,
          `import { value as secondValue } from "cf:pattern:${second.entryIdentity}";`,
          `export function total() {`,
          `  return firstValue() + secondValue();`,
          `}`,
        ].join("\n"),
      }],
    };
    const coverage = new PatternCoverageCollector();

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
      patternCoverage: coverage,
    });
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    expect(evaluated.main?.total()).toBe(30);

    const filesByPath = new Map(
      coverage.report().files.map((file) => [file.path, file]),
    );
    expect(filesByPath.has(firstPath)).toBe(true);
    expect(filesByPath.has(secondPath)).toBe(true);
    expect(filesByPath.get(firstPath)?.lines.runtime).toContain(3);
    expect(filesByPath.get(secondPath)?.lines.runtime).toContain(3);
  });

  it("keeps old pins stable and changes importer identity when the pin text changes", async () => {
    const oldDependency = await publish(dependencyProgram(3));
    const oldSpecifier = `cf:pattern:${oldDependency.entryIdentity}`;
    const oldImporter = await engine.compileToRecordGraph(
      importerProgram(oldSpecifier),
      { fabricImports: { space } },
    );

    const newDependency = await publish(dependencyProgram(4));
    const oldImporterAgain = await engine.compileToRecordGraph(
      importerProgram(oldSpecifier),
      { fabricImports: { space } },
    );
    const newImporter = await engine.compileToRecordGraph(
      importerProgram(`cf:pattern:${newDependency.entryIdentity}`),
      { fabricImports: { space } },
    );

    expect(oldImporterAgain.entryIdentity).toBe(oldImporter.entryIdentity);
    expect(newImporter.entryIdentity).not.toBe(oldImporter.entryIdentity);
    expect(
      oldImporterAgain.modules.some((module) =>
        module.identity === oldDependency.entryIdentity
      ),
    ).toBe(true);
    expect(
      newImporter.modules.some((module) =>
        module.identity === newDependency.entryIdentity
      ),
    ).toBe(true);
  });

  it("surfaces mounted files in getTransformedProgram", async () => {
    const dependency = await publish(dependencyProgram(5));
    let transformed: Program | undefined;

    await engine.compileToRecordGraph(
      importerProgram(`cf:pattern:${dependency.entryIdentity}`),
      {
        fabricImports: { space },
        getTransformedProgram: (program) => {
          transformed = program;
        },
      },
    );

    expect(
      transformed?.files.some((file) =>
        file.name === `${FABRIC_MOUNT_ROOT}${dependency.entryIdentity}/main.tsx`
      ),
    ).toBe(true);
  });

  it("compiles transitive fabric imports and mounts each subtree once", async () => {
    const base = await publish(dependencyProgram(100));
    const midProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { x } from "cf:pattern:${base.entryIdentity}";`,
            `export function p() { return x + 1; }`,
          ].join("\n"),
        },
      ],
    };
    const mid = await publish(midProgram, { fabricImports: { space } });
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { p } from "cf:pattern:${mid.entryIdentity}";`,
            `export function y() { return p() + 1; }`,
          ].join("\n"),
        },
      ],
    };

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });

    // Both subtrees are mounted under their PUBLISHED identities, once each.
    expect(compiled.graph.records.has(`cf:module/${mid.entryIdentity}`))
      .toBe(true);
    expect(compiled.graph.records.has(`cf:module/${base.entryIdentity}`))
      .toBe(true);
    expect(
      compiled.modules.filter((m) => m.identity === base.entryIdentity),
    ).toHaveLength(1);
    expect(
      compiled.modules.filter((m) => m.identity === mid.entryIdentity),
    ).toHaveLength(1);

    // The mounted middle module's own fabric edge resolves in records AND in
    // write-back form (matching what its own publish produced).
    const midRecord = compiled.graph.records.get(
      `cf:module/${mid.entryIdentity}`,
    )!;
    expect(midRecord.resolutions?.[`cf:pattern:${base.entryIdentity}`]).toBe(
      `cf:module/${base.entryIdentity}`,
    );
    const midModule = compiled.modules.find((m) =>
      m.identity === mid.entryIdentity
    );
    expect(midModule?.imports).toContainEqual({
      specifier: `cf:pattern:${base.entryIdentity}`,
      targetIdentity: base.entryIdentity,
    });

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    expect(evaluated.main?.y()).toBe(102);
  });

  it("skips the TypeScript compile when every module, including mounts, is cached", async () => {
    const dependency = await publish(dependencyProgram(6));
    const program = importerProgram(`cf:pattern:${dependency.entryIdentity}`);

    let firstTransformed = 0;
    const first = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
      getTransformedProgram: () => {
        firstTransformed++;
      },
    });
    expect(firstTransformed).toBe(1);

    const artifacts = new Map(
      first.modules.map((m) => [m.identity, {
        js: m.js,
        ...(m.sourceMap === undefined ? {} : { sourceMap: m.sourceMap }),
      }]),
    );
    let requested: string[] | undefined;
    let secondTransformed = 0;
    const second = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
      getTransformedProgram: () => {
        secondTransformed++;
      },
      precompiledModulesFor: ({ identities }) => {
        requested = identities;
        return Promise.resolve(artifacts);
      },
    });

    // The cache was queried for the mounted identity too, and the full hit
    // skipped the TypeScript compile entirely (the transform callback only
    // fires inside compileToModules).
    expect(requested).toContain(dependency.entryIdentity);
    expect(secondTransformed).toBe(0);
    expect(second.entryIdentity).toBe(first.entryIdentity);

    const evaluated = engine.evaluateRecordGraph(
      second.id,
      second.graph,
      second.mainSpecifier,
      program,
    );
    expect(evaluated.main?.y()).toBe(7);
  });

  it("refuses to write back modules from an unpinned (dev) compile", async () => {
    const dependency = await publish(dependencyProgram(8));
    const { cell } = await writePieceWithIdentity(dependency.entryIdentity);
    await writeSlug("dep", cell);

    const compiled = await engine.compileToRecordGraph(
      importerProgram("cf:dep"),
      { fabricImports: { space, allowUnpinned: true } },
    );

    const tx = runtime.edit();
    try {
      expect(() =>
        writeSourceDocs(
          runtime,
          space,
          compiled.modules,
          compiled.entryIdentity,
          tx,
        )
      ).toThrow("unpinned fabric import 'cf:dep'");
    } finally {
      tx.abort?.();
    }
  });

  it("compiles already-resolved stored sources with fabric imports", async () => {
    const dependency = await publish(dependencyProgram(7));
    const modules = await engine.compileResolvedToRecordGraph(
      [
        {
          name: "/main.tsx",
          contents:
            `import { x } from "cf:pattern:${dependency.entryIdentity}";\nexport function y() { return x + 1; }`,
        },
      ],
      "/main.tsx",
      { fabricImports: { space } },
    );

    expect(
      modules.modules.some((module) =>
        module.identity === dependency.entryIdentity
      ),
    ).toBe(true);
  });
});
