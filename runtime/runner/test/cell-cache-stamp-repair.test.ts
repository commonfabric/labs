import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricPlainObject, FabricValue } from "@commonfabric/data-model";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import {
  COMPILED_INTEGRITY_ATOM,
  compiledDocKey,
  repairCompileCacheStamps,
  sourceDocKey,
  writeSourceAndCompiledDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { COMPILE_CACHE_REPAIR_WRITER } from "../src/compilation-cache/writer-identity.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import type { URI } from "../src/sigil-types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase("cell-cache stamp repair");
const space = signer.did();
const RUNTIME_VERSION = "rt-stamp-repair";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        `import { helper } from "./util.ts";`,
        `export const run = (n: number) => helper(n);`,
      ].join("\n"),
    },
    {
      name: "/util.ts",
      contents: `export const helper = (n: number) => n + 1;`,
    },
  ],
};

const PROGRAM_X: RuntimeProgram = {
  main: "/x.ts",
  files: [{ name: "/x.ts", contents: `export const x = 2;` }],
};

/** `program`'s modules, as the compile-cache writer takes them. */
const toModules = (program: RuntimeProgram) => {
  const ids = computeModuleHashes(program);
  const edges = resolveModuleImports(program);
  const modules: CacheableModule[] = program.files.map((file) => ({
    identity: ids.get(file.name)!,
    filename: file.name,
    source: file.contents,
    js: `/* compiled */ ${file.name}`,
    imports: (edges.get(file.name)?.internalDeps ?? []).map((dep) => ({
      specifier: dep.specifier,
      targetIdentity: ids.get(dep.target)!,
    })),
  }));
  return { modules, entryIdentity: ids.get(program.main)! };
};

/**
 * The root pair a write-back left on a source record, as measured on a real
 * space: a shape entry and a value entry, each holding `atom`, the value
 * entry also naming the compile-cache writer's transformation.
 */
const rootPairStamp = (atom: string): FabricValue[] =>
  [
    {
      path: [],
      origin: "derived",
      observes: "shape",
      label: { confidentiality: [atom] },
    },
    {
      path: [],
      origin: "derived",
      observes: "value",
      label: {
        confidentiality: [atom],
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: { kind: "builtin", builtinId: "compile-cache" },
        }],
      },
    },
  ] as unknown as FabricValue[];

type Stored = FabricPlainObject & {
  value?: FabricPlainObject;
  cfc?: FabricPlainObject & {
    labelMap: FabricPlainObject & { entries: FabricValue[] };
  };
};

describe("cell-cache", () => {
  describe("repairCompileCacheStamps()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** The id of the document `key` names. */
    const idOf = (key: string) =>
      runtime.getCell(space, key).getAsNormalizedFullLink().id as URI;

    const address = (id: URI) => ({
      space,
      scope: "space" as const,
      id,
      path: [],
    });

    /** The document `id` names, as stored. */
    const stored = (id: URI): Stored => {
      const tx = runtime.edit();
      try {
        return storedFields(tx, address(id)) as Stored;
      } finally {
        tx.abort();
      }
    };

    /** The confidentiality atoms the label stored on `id` holds. */
    const atomsOn = (id: URI): unknown[] => {
      const tx = runtime.edit();
      try {
        return (readStoredCfcMetadata(tx, { space, id })?.labelMap.entries ??
          []).flatMap((entry) => entry.label.confidentiality ?? []);
      } finally {
        tx.abort();
      }
    };

    /** Writes `program`'s records as the cache writer does. */
    const writeProgram = async (
      program: RuntimeProgram,
      delegations: Map<string, Set<string>> = new Map(),
    ) => {
      const modules = toModules(program);
      const tx = runtime.edit();
      writeSourceAndCompiledDocs(
        runtime,
        space,
        modules.modules,
        modules.entryIdentity,
        { runtimeVersion: RUNTIME_VERSION, moduleDelegations: delegations },
        tx,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      return modules;
    };

    /**
     * Rewrites the document `id` with the runtime's authority, its value and
     * label entries as `edit` returns them from the stored ones.
     */
    const replaceStored = async (
      id: URI,
      edit: (stored: Stored) => {
        value?: FabricPlainObject;
        entries: FabricValue[];
      },
    ) => {
      const tx = runtime.edit();
      const current = storedFields(tx, address(id)) as Stored;
      if (current.cfc === undefined) writeSeedEnvelopeDoc(tx, space);
      const cfc = current.cfc ?? {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      };
      const { value, entries } = edit(current);
      seedStoredEnvelope(tx, address(id), {
        ...current,
        ...(value === undefined ? {} : { value }),
        cfc: { ...cfc, labelMap: { ...cfc.labelMap, entries } },
      } as unknown as FabricValue);
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    /** Adds `entries` to the label stored on `id`. */
    const plant = (id: URI, entries: FabricValue[]) =>
      replaceStored(id, (current) => ({
        entries: [...(current.cfc?.labelMap.entries ?? []), ...entries],
      }));

    const repair = (entryIdentity: string) =>
      repairCompileCacheStamps(runtime, space, entryIdentity, RUNTIME_VERSION);

    it("returns `clean`, and writes nothing, for a closure no stamp labels", async () => {
      const program = await writeProgram(PROGRAM);
      const before = stored(idOf(sourceDocKey(program.entryIdentity)));

      expect(await repair(program.entryIdentity)).toBe("clean");
      expect(stored(idOf(sourceDocKey(program.entryIdentity)))).toEqual(
        before,
      );
    });

    /** The program's records written with a delegation list on its entry. */
    const writeDelegatingProgram = () =>
      writeProgram(
        PROGRAM,
        new Map([[toModules(PROGRAM).entryIdentity, new Set(["predecessor"])]]),
      );

    it("rewrites a source record stamped at its root, and keeps the attestation at its list and nothing else", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));
      expect(atomsOn(id)).toEqual([space, space]);

      expect(await repair(program.entryIdentity)).toBe("repaired");
      const after = stored(id);
      expect(after.value?.identity).toBe(program.entryIdentity);
      expect(after.value?.delegatedModuleIdentities).toEqual(["predecessor"]);
      expect(after.cfc?.labelMap.entries).toEqual([{
        path: ["delegatedModuleIdentities"],
        label: { integrity: [COMPILED_INTEGRITY_ATOM] },
        origin: "minted",
      }]);
    });

    it("erases a stamped compiled record whose list the source record grants", async () => {
      const program = await writeDelegatingProgram();
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await plant(compiled, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(compiled)).toEqual({});
      expect(atomsOn(idOf(sourceDocKey(program.entryIdentity)))).toEqual([]);
    });

    it("refuses, and erases nothing, where a stamped compiled record's list is one the source record does not attest", async () => {
      const program = await writeDelegatingProgram();
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await plant(compiled, rootPairStamp(space));
      await replaceStored(
        idOf(sourceDocKey(program.entryIdentity)),
        (current) => ({
          entries: current.cfc!.labelMap.entries.filter((entry) =>
            (entry as { path: string[] }).path[0] !==
              "delegatedModuleIdentities"
          ),
        }),
      );

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(compiled)).toEqual([space, space]);
    });

    for (
      const [what, edit] of [
        [
          "holds annotations",
          (value: FabricPlainObject) => ({
            ...value,
            annotations: { note: "chosen" },
          }),
        ],
        [
          "holds a field the cache writer does not write",
          (value: FabricPlainObject) => ({ ...value, extra: "chosen" }),
        ],
      ] as const
    ) {
      it(`refuses, and leaves the stamp, where a stamped source record ${what}`, async () => {
        const program = await writeProgram(PROGRAM);
        const id = idOf(sourceDocKey(program.entryIdentity));
        await replaceStored(id, (current) => ({
          value: edit(current.value!) as FabricPlainObject,
          entries: [
            ...(current.cfc?.labelMap.entries ?? []),
            ...rootPairStamp(space),
          ],
        }));

        expect(await repair(program.entryIdentity)).toBe("refused");
        expect(atomsOn(id)).toEqual([space, space]);
      });
    }

    it("refuses, and leaves the stamp, where a stamped source record holds a declared clause", async () => {
      const program = await writeProgram(PROGRAM);
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, [
        ...rootPairStamp(space),
        {
          path: ["filename"],
          origin: "declared",
          label: { confidentiality: [space] },
        } as unknown as FabricValue,
      ]);

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(id)).toContain(space);
    });

    it("refuses a closure whose edge lands on a record that is not at its own key, and carries no list from it", async () => {
      // Another record, with an attested list, rewritten to hold the util
      // module's content, and the entry's edge to util relinked to it: the
      // loader verifies such a closure and takes that record's list for util.

      const program = await writeProgram(PROGRAM);
      const other = toModules(PROGRAM_X);
      await writeProgram(
        PROGRAM_X,
        new Map([[other.entryIdentity, new Set(["predecessor-of-x"])]]),
      );
      const util = program.modules.find((m) => m.filename === "/util.ts")!;
      const xId = idOf(sourceDocKey(other.entryIdentity));
      const utilStored = stored(idOf(sourceDocKey(util.identity))).value!;
      await replaceStored(xId, (current) => ({
        value: {
          ...current.value!,
          identity: utilStored.identity,
          code: utilStored.code,
          filename: utilStored.filename,
          imports: utilStored.imports,
        },
        entries: current.cfc!.labelMap.entries,
      }));
      const entryId = idOf(sourceDocKey(program.entryIdentity));
      const xLink = runtime.getCell(space, sourceDocKey(other.entryIdentity))
        .getAsLink() as unknown as FabricValue;
      await replaceStored(entryId, (current) => ({
        value: {
          ...current.value!,
          imports: (current.value!.imports as FabricPlainObject[]).map((
            imp,
          ) => imp.specifier === "./util.ts" ? { ...imp, link: xLink } : imp),
        },
        entries: [
          ...(current.cfc?.labelMap.entries ?? []),
          ...rootPairStamp(space),
        ],
      }));

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(entryId)).toEqual([space, space]);
    });

    it("returns `conflicted`, and writes nothing, where a record changes after verification", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));

      const outcome = await repairCompileCacheStamps(
        runtime,
        space,
        program.entryIdentity,
        RUNTIME_VERSION,
        () => {
          // Between the verification and the repair's own reads.
          const tx = runtime.edit();
          tx.writeValueOrThrow(
            runtime.getCell(space, sourceDocKey(program.entryIdentity))
              .key("delegatedModuleIdentities").getAsNormalizedFullLink(),
            ["chosen"],
          );
          tx.commit();
        },
      );

      expect(outcome).toBe("conflicted");
      expect(atomsOn(id)).toContain(space);
    });

    it("throws on a repair write made under any identity but the repair's", () => {
      const tx = runtime.edit();
      try {
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "compile-cache",
        });
        expect(() =>
          tx.writeRepairedCompileCacheRecord(
            { space, id: idOf(sourceDocKey("x")) },
            undefined,
          )
        ).toThrow(COMPILE_CACHE_REPAIR_WRITER);
      } finally {
        tx.abort();
      }
    });
  });
});
