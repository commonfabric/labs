import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { writeSourceDocs } from "../src/compilation-cache/cell-cache.ts";
import { rewriteFabricPins } from "../src/fabric-pin-rewrite.ts";
import { resolveFabricRefToIdentity } from "../src/fabric-ref-resolution.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase(
  "fabric imports snapshot semantics test",
);
const space = signer.did();

describe("fabric import snapshot semantics", () => {
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
            `export default pattern<{ value: number }>(({ value }) => ({ result: value + x }));`,
          ].join("\n"),
        },
      ],
    };
  }

  async function publishDependency(value: number) {
    const compiled = await engine.compileToRecordGraph(
      dependencyProgram(value),
    );
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
    label: string,
    entryIdentity: string,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell(
      space,
      { space, random: `piece-${label}` },
    );
    await runtime.editWithRetry((tx) => {
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set({ name: "piece" });
      cellWithTx.setMetaRaw("patternIdentity", {
        identity: entryIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    return cell;
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

  async function pinProgram(program: RuntimeProgram): Promise<RuntimeProgram> {
    const files = [];
    for (const file of program.files) {
      const rewritten = await rewriteFabricPins(
        file.contents,
        async (ref) =>
          (await resolveFabricRefToIdentity(runtime, space, ref))
            .entryIdentity,
      );
      files.push({ ...file, contents: rewritten.contents });
    }
    return { ...program, files };
  }

  async function compileAndRun(
    program: RuntimeProgram,
    value: number,
  ): Promise<
    { entryIdentity: string; moduleIdentities: string[]; result: unknown }
  > {
    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      `snapshot-result-${value}-${compiled.entryIdentity}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(
      tx,
      evaluated.main?.default as any,
      { value },
      resultCell,
    );
    await tx.commit().settled;
    await result.pull();
    return {
      entryIdentity: compiled.entryIdentity,
      moduleIdentities: compiled.modules.map((module) => module.identity)
        .sort(),
      result: result.getAsQueryResult(),
    };
  }

  it("pins mutable refs into stable snapshots and updates only on re-pin", async () => {
    const depV1 = await publishDependency(10);
    const metaV1 = await writePieceWithIdentity("dep-v1", depV1.entryIdentity);
    await writeSlug("dep", metaV1);

    const unpinned = importerProgram("cf:dep");
    const pinnedV1 = await pinProgram(unpinned);
    expect(pinnedV1.files[0].contents).toContain(
      `from "cf:dep@${depV1.entryIdentity}"`,
    );

    const runV1 = await compileAndRun(pinnedV1, 1);
    expect(runV1.result).toEqual({ result: 11 });

    const depV2 = await publishDependency(20);
    const metaV2 = await writePieceWithIdentity("dep-v2", depV2.entryIdentity);
    await writeSlug("dep", metaV2);

    const rerunV1 = await compileAndRun(pinnedV1, 1);
    expect(rerunV1.entryIdentity).toBe(runV1.entryIdentity);
    expect(rerunV1.moduleIdentities).toEqual(runV1.moduleIdentities);
    expect(rerunV1.result).toEqual({ result: 11 });

    const pinnedV2 = await pinProgram(pinnedV1);
    const [beforeImport, , afterImport] = pinnedV1.files[0].contents.split(
      "\n",
    );
    const [nextBeforeImport, , nextAfterImport] = pinnedV2.files[0].contents
      .split("\n");
    expect(nextBeforeImport).toBe(beforeImport);
    expect(nextAfterImport).toBe(afterImport);
    expect(pinnedV2.files[0].contents).toContain(
      `from "cf:dep@${depV2.entryIdentity}"`,
    );

    const runV2 = await compileAndRun(pinnedV2, 1);
    expect(runV2.entryIdentity).not.toBe(runV1.entryIdentity);
    expect(runV2.result).toEqual({ result: 21 });

    const dataCell = runtime.getCell(space, {
      space,
      random: "not-a-pattern",
    });
    await runtime.editWithRetry((tx) => {
      dataCell.withTx(tx).set({ value: 1 });
    });
    await writeSlug("dep", dataCell);

    const pinnedAfterBadSlug = await compileAndRun(pinnedV2, 1);
    expect(pinnedAfterBadSlug.result).toEqual({ result: 21 });

    await expect(
      engine.compileToRecordGraph(unpinned, {
        fabricImports: { space, allowUnpinned: true },
      }),
    ).rejects.toThrow("cf:dep does not resolve to a pattern");
  });
});
