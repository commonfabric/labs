import { expect } from "@std/expect";
import {
  type FabricPlainObject,
  type FabricValue,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import {
  compileCacheClosureHoldsStamp,
  COMPILED_INTEGRITY_ATOM,
  compiledDocKey,
  repairCompileCacheStamps,
  sourceDocKey,
  stageModuleDelegations,
  writeSourceAndCompiledDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { COMPILE_CACHE_REPAIR_WRITER } from "../src/compilation-cache/writer-identity.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
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
const CEILINGED_SINK = "fetchJson";

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

/** A program with a module its entry's imports do not reach. */
const PROGRAM_WITH_ROOT: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    ...PROGRAM.files,
    { name: "/aside.ts", contents: `export const aside = 3;` },
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

/** {@link rootPairStamp} as patched heads hold it: no integrity on either. */
const bareRootPairStamp = (atom: string): FabricValue[] =>
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
      label: { confidentiality: [atom] },
    },
  ] as unknown as FabricValue[];

/** A module two programs share: an entry in one, a dependency in the other. */
const SHARED_MODULE = {
  name: "/u.ts",
  contents: `export const u = 1;`,
};

/** A program whose entry imports {@link SHARED_MODULE}. */
const PROGRAM_IMPORTING_SHARED: RuntimeProgram = {
  main: "/main.ts",
  files: [
    {
      name: "/main.ts",
      contents: `import { u } from "./u.ts";\nexport const m = u;`,
    },
    SHARED_MODULE,
  ],
};

/**
 * A program whose entry is {@link SHARED_MODULE}, with a module it does not
 * import, so its entry record carries a cache-root edge to that module.
 */
const PROGRAM_ROOTED_AT_SHARED: RuntimeProgram = {
  main: "/u.ts",
  files: [SHARED_MODULE, { name: "/q.ts", contents: `export const q = 2;` }],
};

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
        // A ceiling on one sink, so that a transaction recording a request to
        // it is prepared when it commits.
        cfcSinkMaxConfidentiality: { [CEILINGED_SINK]: [] },
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

      const before = stored(id).value;

      expect(await repair(program.entryIdentity)).toBe("repaired");
      const after = stored(id);
      expect(after.value).toEqual(before);
      expect(after.cfc?.labelMap.entries).toEqual([{
        path: ["delegatedModuleIdentities"],
        label: { integrity: [COMPILED_INTEGRITY_ATOM] },
        origin: "minted",
      }]);
    });

    it("rewrites an entry stamped at its root to the value the cache writer stored, its cache-root edge included", async () => {
      const program = await writeProgram(PROGRAM_WITH_ROOT);
      const id = idOf(sourceDocKey(program.entryIdentity));
      const before = stored(id).value;
      expect(
        (before!.imports as FabricPlainObject[]).map((imp) => imp.specifier),
      ).toContain(
        `cf:cache-root/${
          program.modules.find((m) => m.filename === "/aside.ts")!.identity
        }`,
      );
      await plant(id, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).value).toEqual(before);
      expect(atomsOn(id)).toEqual([]);
    });

    it("drops a list its record's label does not attest", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await replaceStored(id, (current) => ({
        entries: [
          ...current.cfc!.labelMap.entries.filter((entry) =>
            (entry as { path: string[] }).path[0] !==
              "delegatedModuleIdentities"
          ),
          ...rootPairStamp(space),
        ],
      }));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).value).not.toHaveProperty("delegatedModuleIdentities");
      expect(atomsOn(id)).toEqual([]);
    });

    for (
      const [what, attestation, compiledStamped] of [
        ["also holds a clause", { confidentiality: [space] }, false],
        ["holds nothing else", {}, false],
        [
          "also holds a clause, beside a stamped compiled record",
          { confidentiality: [space] },
          true,
        ],
      ] as const
    ) {
      it(`refuses, and erases nothing, where a list's only attestation is in a stamp entry that ${what}`, async () => {
        // Removing the stamp would remove the attestation, and the grant with
        // it: on the source record, and on the compiled record erased beside.

        const program = await writeDelegatingProgram();
        const source = idOf(sourceDocKey(program.entryIdentity));
        const compiled = idOf(
          compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
        );
        await replaceStored(source, (current) => ({
          entries: [
            ...current.cfc!.labelMap.entries.filter((entry) =>
              (entry as { path: string[] }).path[0] !==
                "delegatedModuleIdentities"
            ),
            {
              path: ["delegatedModuleIdentities"],
              origin: "derived",
              observes: "value",
              label: {
                ...attestation,
                integrity: [COMPILED_INTEGRITY_ATOM],
              },
            } as unknown as FabricValue,
            ...rootPairStamp(space),
          ],
        }));
        if (compiledStamped) await plant(compiled, rootPairStamp(space));

        expect(await repair(program.entryIdentity)).toBe("refused");
        expect(stored(compiled).value).toBeDefined();
        expect(stored(source).value?.delegatedModuleIdentities).toEqual([
          "predecessor",
        ]);
      });
    }

    it("refuses, and leaves the stamp, where a stamped source record's code is not as its identity hashes it", async () => {
      const crlf: RuntimeProgram = {
        main: "/crlf.ts",
        files: [{ name: "/crlf.ts", contents: "export const a = 1;\r\n" }],
      };
      const program = await writeProgram(crlf);
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(id)).toEqual([space, space]);
    });

    it("refuses, and writes nothing, where the repair's transaction is CFC-relevant", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));

      const outcome = await repairCompileCacheStamps(
        runtime,
        space,
        program.entryIdentity,
        RUNTIME_VERSION,
        (tx) => tx.markCfcRelevant("cell-cache-stamp-repair test"),
      );

      expect(outcome).toBe("refused");
      expect(atomsOn(id)).toEqual([space, space]);
    });

    it("rewrites a record stamped by a root pair with no integrity, as patched heads hold it", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      const before = stored(id).value;
      await plant(id, bareRootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).value).toEqual(before);
      expect(atomsOn(id)).toEqual([]);
    });

    it("rewrites a record whose head is a later write to one of its fields", async () => {
      // The list is staged by a write of that field alone, after the record
      // was written whole.

      const program = await writeProgram(PROGRAM);
      const stage = runtime.edit();
      stageModuleDelegations(
        runtime,
        space,
        new Map([[program.entryIdentity, new Set(["staged"])]]),
        RUNTIME_VERSION,
        stage,
      );
      runtime.prepareTxForCommit(stage);
      expect((await stage.commit().settled).error).toBeUndefined();
      const id = idOf(sourceDocKey(program.entryIdentity));
      const before = stored(id).value;
      expect(before?.delegatedModuleIdentities).toEqual(["staged"]);
      await plant(id, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).value).toEqual(before);
      expect(atomsOn(id)).toEqual([]);
    });

    it("refuses, and erases nothing, where the source record that granted an erase changes after verification", async () => {
      const program = await writeDelegatingProgram();
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await plant(compiled, rootPairStamp(space));

      const outcome = await repairCompileCacheStamps(
        runtime,
        space,
        program.entryIdentity,
        RUNTIME_VERSION,
        () => {
          // Between the verification and the repair's own reads, the
          // source record whose list covered the erase loses it.
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
      expect(stored(compiled).value).toBeDefined();
    });

    it("refuses, and leaves the stamp, where a stamped record stores a label-metadata template its entries do not derive", async () => {
      const program = await writeProgram(PROGRAM);
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, [
        ...rootPairStamp(space),
        {
          path: ["cfc", "labels", "value", "filename", "~label"],
          origin: "label-metadata",
          observes: "labelMetadata",
          label: { confidentiality: [space] },
        } as unknown as FabricValue,
      ]);

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(id)).toContain(space);
    });

    for (
      const [what, alsoReached, outcome] of [
        ["reached through nothing else", false, "refused"],
        ["also reached from the entry", true, "repaired"],
      ] as const
    ) {
      it(`returns \`${outcome}\` for a stamped dependency whose cache-root edge leads to a module ${what}`, async () => {
        // The cache writer writes cache-root edges on a program's entry
        // only, so a dependency rewritten for this closure loses them, and
        // the closure the records it reached through them.

        const importing = await writeProgram(PROGRAM_IMPORTING_SHARED);
        const rooted = await writeProgram(PROGRAM_ROOTED_AT_SHARED);
        const shared = rooted.entryIdentity;
        const q = rooted.modules.find((m) => m.filename === "/q.ts")!;
        const entryId = idOf(sourceDocKey(importing.entryIdentity));
        if (alsoReached) {
          const qLink = runtime.getCell(space, sourceDocKey(q.identity))
            .getAsLink() as unknown as FabricValue;
          await replaceStored(entryId, (current) => ({
            value: {
              ...current.value!,
              imports: [
                ...(current.value!.imports as FabricValue[]),
                { specifier: `cf:cache-root/${q.identity}`, link: qLink },
              ],
            },
            entries: current.cfc?.labelMap.entries ?? [],
          }));
        }
        const sharedId = idOf(sourceDocKey(shared));
        expect(
          (stored(sharedId).value!.imports as FabricPlainObject[]).map((imp) =>
            imp.specifier
          ),
        ).toEqual([`cf:cache-root/${q.identity}`]);
        await plant(sharedId, rootPairStamp(space));

        expect(await repair(importing.entryIdentity)).toBe(outcome);
        if (outcome === "repaired") {
          expect(stored(sharedId).value!.imports).toEqual([]);
          expect(atomsOn(sharedId)).toEqual([]);
        } else {
          expect(atomsOn(sharedId)).toEqual([space, space]);
        }
      });
    }

    it("throws on a repair write to a document no compile-cache record's key names", () => {
      const tx = runtime.edit();
      try {
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: COMPILE_CACHE_REPAIR_WRITER,
        });
        expect(() =>
          tx.writeRepairedCompileCacheRecord(
            { space, key: "of:not-a-record" },
            undefined,
          )
        ).toThrow("not a compile-cache record key");
      } finally {
        tx.abort();
      }
    });

    it("writes no stamp placement on the record it rewrites", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      const tx = runtime.edit();
      const current = storedFields(tx, address(id)) as Stored;
      seedStoredEnvelope(tx, address(id), {
        ...current,
        cfc: {
          ...current.cfc!,
          labelMap: {
            ...current.cfc!.labelMap,
            entries: [
              ...current.cfc!.labelMap.entries,
              ...rootPairStamp(space),
            ],
          },
          stampPlacement: "committed",
        },
      } as unknown as FabricValue);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(stored(id).cfc?.stampPlacement).toBe("committed");

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).cfc).not.toHaveProperty("stampPlacement");
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

    it("erases a stamped compiled record that the repairing runtime has never loaded", async () => {
      // A cold runtime repairs straight from the store: nothing it did
      // before the repair loaded the compiled records.

      const server = newSharedServer();
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      const coldManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: coldManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        const modules = toModules(PROGRAM);
        const tx = writer.edit();
        writeSourceAndCompiledDocs(
          writer,
          space,
          modules.modules,
          modules.entryIdentity,
          { runtimeVersion: RUNTIME_VERSION },
          tx,
        );
        writer.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        const compiledId = writer.getCell(
          space,
          compiledDocKey(RUNTIME_VERSION, modules.entryIdentity),
        ).getAsNormalizedFullLink().id as URI;
        const seed = writer.edit();
        const current = storedFields(seed, address(compiledId)) as Stored;
        seedStoredEnvelope(seed, address(compiledId), {
          ...current,
          cfc: {
            ...current.cfc!,
            labelMap: {
              ...current.cfc!.labelMap,
              entries: [
                ...current.cfc!.labelMap.entries,
                ...rootPairStamp(space),
              ],
            },
          },
        } as unknown as FabricValue);
        expect((await seed.commit().settled).error).toBeUndefined();
        await writerManager.synced();

        expect(
          await repairCompileCacheStamps(
            cold,
            space,
            modules.entryIdentity,
            RUNTIME_VERSION,
          ),
        ).toBe("repaired");
        await coldManager.synced();
        const check = cold.edit();
        try {
          expect(storedFields(check, address(compiledId))).toEqual({});
        } finally {
          check.abort();
        }
      } finally {
        await cold.dispose();
        await writer.dispose();
        await coldManager.close();
        await writerManager.close();
      }
    });

    it("finds the stamp on a dependency's compiled record a cold runtime has not loaded, the entry's compiled record absent", async () => {
      const server = newSharedServer();
      const writerManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      const coldManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: coldManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        const modules = toModules(PROGRAM);
        const util = modules.modules.find((m) => m.filename === "/util.ts")!;
        const tx = writer.edit();
        writeSourceAndCompiledDocs(
          writer,
          space,
          modules.modules,
          modules.entryIdentity,
          { runtimeVersion: RUNTIME_VERSION },
          tx,
        );
        writer.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        const idIn = (key: string) =>
          writer.getCell(space, key).getAsNormalizedFullLink().id as URI;
        const seed = writer.edit();
        const utilId = idIn(compiledDocKey(RUNTIME_VERSION, util.identity));
        const current = storedFields(seed, address(utilId)) as Stored;
        seedStoredEnvelope(seed, address(utilId), {
          ...current,
          cfc: {
            ...current.cfc!,
            labelMap: {
              ...current.cfc!.labelMap,
              entries: [
                ...current.cfc!.labelMap.entries,
                ...rootPairStamp(space),
              ],
            },
          },
        } as unknown as FabricValue);
        seedStoredEnvelope(
          seed,
          address(idIn(compiledDocKey(RUNTIME_VERSION, modules.entryIdentity))),
          undefined as unknown as FabricValue,
          { delete: true },
        );
        expect((await seed.commit().settled).error).toBeUndefined();
        await writerManager.synced();

        const check = cold.edit();
        try {
          expect(
            await compileCacheClosureHoldsStamp(
              cold,
              space,
              modules.entryIdentity,
              RUNTIME_VERSION,
              check,
            ),
          ).toBe(true);
        } finally {
          check.abort();
        }
      } finally {
        await cold.dispose();
        await writer.dispose();
        await coldManager.close();
        await writerManager.close();
      }
    });

    for (const shape of ["label", "value"] as const) {
      it(`erases nothing where another session's commit changes the guarding source record's ${shape} after the repair read it`, async () => {
        // The racing commit goes to the server ahead of the repair's, and the
        // repairing session has not heard of it when its own commit goes out,
        // so only the server's check of the guard read can refuse it.

        const server = newSharedServer();
        const writerManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const writer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: writerManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
        const repairerManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const repairer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: repairerManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
        const read = (runtime: Runtime, id: URI) => {
          const tx = runtime.edit();
          try {
            return storedFields(tx, address(id)) as Stored;
          } finally {
            tx.abort();
          }
        };
        try {
          const modules = toModules(PROGRAM);
          const tx = writer.edit();
          writeSourceAndCompiledDocs(
            writer,
            space,
            modules.modules,
            modules.entryIdentity,
            {
              runtimeVersion: RUNTIME_VERSION,
              moduleDelegations: new Map([[
                modules.entryIdentity,
                new Set(["predecessor"]),
              ]]),
            },
            tx,
          );
          writer.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          const idIn = (key: string) =>
            writer.getCell(space, key).getAsNormalizedFullLink().id as URI;
          const source = idIn(sourceDocKey(modules.entryIdentity));
          const compiled = idIn(
            compiledDocKey(RUNTIME_VERSION, modules.entryIdentity),
          );
          const seed = writer.edit();
          const current = storedFields(seed, address(compiled)) as Stored;
          seedStoredEnvelope(seed, address(compiled), {
            ...current,
            cfc: {
              ...current.cfc!,
              labelMap: {
                ...current.cfc!.labelMap,
                entries: [
                  ...current.cfc!.labelMap.entries,
                  ...rootPairStamp(space),
                ],
              },
            },
          } as unknown as FabricValue);
          expect((await seed.commit().settled).error).toBeUndefined();
          await writerManager.synced();
          const before = read(writer, source);

          const race = async () => {
            const racing = writer.edit();
            const stored = storedFields(racing, address(source)) as Stored;
            seedStoredEnvelope(
              racing,
              address(source),
              (shape === "label"
                ? {
                  ...stored,
                  cfc: {
                    ...stored.cfc!,
                    labelMap: { ...stored.cfc!.labelMap, entries: [] },
                  },
                }
                : {
                  ...stored,
                  value: {
                    ...stored.value!,
                    delegatedModuleIdentities: ["predecessor", "raced"],
                  },
                }) as unknown as FabricValue,
            );
            expect((await racing.commit().settled).error).toBeUndefined();
          };
          let sawRace: boolean | undefined;
          const edit = repairer.edit.bind(repairer);
          (repairer as { edit: typeof repairer.edit }).edit = (...args) => {
            const tx = edit(...args);
            const commit = tx.commit.bind(tx);
            (tx as { commit: () => unknown }).commit = () => ({
              settled: (async () => {
                const racing = race();
                sawRace = JSON.stringify(read(repairer, source)) !==
                  JSON.stringify(before);
                const result = await commit().settled;
                await racing;
                return result;
              })(),
            });
            return tx;
          };

          const outcome = await repairCompileCacheStamps(
            repairer,
            space,
            modules.entryIdentity,
            RUNTIME_VERSION,
          );

          (repairer as { edit: typeof repairer.edit }).edit = edit;
          expect(sawRace).toBe(false);
          expect(outcome).toBe("conflicted");
          await writer.getCell(
            space,
            compiledDocKey(RUNTIME_VERSION, modules.entryIdentity),
          ).sync();
          expect(read(writer, compiled).value).toBeDefined();
        } finally {
          await repairer.dispose();
          await writer.dispose();
          await repairerManager.close();
          await writerManager.close();
        }
      });
    }

    it("repairs a closure holding two modules of one filename, each in a view of its own", async () => {
      // An entry's cache-root edges can reach two generations of one
      // ambient file, as two seals leave them; each is verified in its own
      // view, where its name is unique.

      const first: RuntimeProgram = {
        main: "/one.ts",
        files: [{ name: "/one.ts", contents: `export const one = 1;` }, {
          name: "/ambient.ts",
          contents: `export const generation = 1;`,
        }],
      };
      const second: RuntimeProgram = {
        main: "/two.ts",
        files: [{ name: "/two.ts", contents: `export const two = 2;` }, {
          name: "/ambient.ts",
          contents: `export const generation = 2;`,
        }],
      };
      const one = await writeProgram(first);
      const two = await writeProgram(second);
      const ambient2 = two.modules.find((m) => m.filename === "/ambient.ts")!;
      const entryId = idOf(sourceDocKey(one.entryIdentity));
      await replaceStored(entryId, (current) => ({
        value: {
          ...current.value!,
          imports: [
            ...(current.value!.imports as FabricValue[]),
            {
              specifier: `cf:cache-root/${ambient2.identity}`,
              link: runtime.getCell(space, sourceDocKey(ambient2.identity))
                .getAsLink() as unknown as FabricValue,
            },
          ],
        },
        entries: [
          ...(current.cfc?.labelMap.entries ?? []),
          ...rootPairStamp(space),
        ],
      }));

      expect(await repair(one.entryIdentity)).toBe("repaired");
      expect(atomsOn(entryId)).toEqual([]);
      expect(
        (stored(entryId).value!.imports as FabricPlainObject[]).map((imp) =>
          imp.specifier
        ).filter((specifier) =>
          (specifier as string).startsWith("cf:cache-root/")
        ),
      ).toHaveLength(2);
    });

    for (
      const [what, generations, outcome] of [
        ["two modules of one filename", 2, "unverified"],
        ["one module of that filename", 1, "refused"],
      ] as const
    ) {
      it(`returns \`${outcome}\`, and leaves the stamp, where a stamped entry's own view holds ${what}`, async () => {
        // Each generation of the ambient file linked by an edge of the entry's
        // own view is in that view, and two make it attributable to no
        // emission. With one, the closure verifies, and the rewrite, which
        // drops the edge the code does not import, is refused for leaving
        // that module unreached.

        const one = await writeProgram({
          main: "/one.ts",
          files: [{ name: "/one.ts", contents: `export const one = 1;` }, {
            name: "/ambient.ts",
            contents: `export const generation = 1;`,
          }],
        });
        const two = await writeProgram({
          main: "/two.ts",
          files: [{ name: "/two.ts", contents: `export const two = 2;` }, {
            name: "/ambient.ts",
            contents: `export const generation = 2;`,
          }],
        });
        const viewEdge = (identity: string, specifier: string) => ({
          specifier,
          link: runtime.getCell(space, sourceDocKey(identity))
            .getAsLink() as unknown as FabricValue,
        });
        const entryId = idOf(sourceDocKey(one.entryIdentity));
        await replaceStored(entryId, (current) => ({
          value: {
            ...current.value!,
            imports: [one, two].slice(0, generations).map((program, index) =>
              viewEdge(
                program.modules.find((m) => m.filename === "/ambient.ts")!
                  .identity,
                `./ambient-${index}.ts`,
              )
            ),
          },
          entries: [
            ...(current.cfc?.labelMap.entries ?? []),
            ...rootPairStamp(space),
          ],
        }));

        expect(await repair(one.entryIdentity)).toBe(outcome);
        expect(atomsOn(entryId)).toEqual([space, space]);
      });
    }

    it("rewrites one record and erases another's compiled record in one commit, keeping the rewritten record's attestation", async () => {
      // The erase is guarded by the unstamped source record beside it,
      // which the commit pins without consuming its label.

      const program = await writeDelegatingProgram();
      const util = program.modules.find((m) => m.filename === "/util.ts")!;
      const entrySource = idOf(sourceDocKey(program.entryIdentity));
      const utilCompiled = idOf(compiledDocKey(RUNTIME_VERSION, util.identity));
      await plant(entrySource, rootPairStamp(space));
      await plant(utilCompiled, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(utilCompiled)).toEqual({});
      expect(stored(entrySource).cfc?.labelMap.entries).toEqual([{
        path: ["delegatedModuleIdentities"],
        label: { integrity: [COMPILED_INTEGRITY_ATOM] },
        origin: "minted",
      }]);
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

    it("refuses, and erases nothing, where a stamped compiled record's attested list is stored as a link", async () => {
      // The loader follows such a link to the identities it grants, which
      // the repair does not, so it cannot judge the erase safe.

      const program = await writeProgram(PROGRAM);
      const listDoc = runtime.getCell<string[]>(space, "stamp-repair-list");
      const tx = runtime.edit();
      listDoc.withTx(tx).set(["predecessor"]);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await replaceStored(compiled, (current) => ({
        value: {
          ...current.value!,
          delegatedModuleIdentities: listDoc
            .getAsLink() as unknown as FabricValue,
        },
        entries: [
          ...(current.cfc?.labelMap.entries ?? []),
          ...rootPairStamp(space),
        ],
      }));

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(stored(compiled).value).toBeDefined();
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
        [
          "is of a kind other than a source record",
          (value: FabricPlainObject) => ({ ...value, kind: "compiled" }),
        ],
        [
          "stores no import list",
          ({ imports: _imports, ...value }: FabricPlainObject) => value,
        ],
        [
          "stores an import the loader cannot follow",
          (value: FabricPlainObject) => ({
            ...value,
            imports: [
              ...(value.imports as FabricValue[]),
              { specifier: "./absent.ts", link: "not a link" },
            ],
          }),
        ],
      ] as const
    ) {
      it(`refuses, and leaves the stamp, where a stamped source record ${what}`, async () => {
        const program = await writeProgram(PROGRAM_X);
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

    it("refuses, and leaves the stamp, where the attestation at a stamped source record's list also holds a clause", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, [
        ...rootPairStamp(space),
        {
          path: ["delegatedModuleIdentities"],
          origin: "declared",
          label: {
            confidentiality: [space],
            integrity: [COMPILED_INTEGRITY_ATOM],
          },
        } as unknown as FabricValue,
      ]);

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(id)).toContain(space);
    });

    it("refuses, and writes nothing, where the repair's transaction reads a record it does not write", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));
      const util = program.modules.find((m) => m.filename === "/util.ts")!;

      const outcome = await repairCompileCacheStamps(
        runtime,
        space,
        program.entryIdentity,
        RUNTIME_VERSION,
        (tx) => {
          tx.readOrThrow(address(idOf(sourceDocKey(util.identity))));
        },
      );

      expect(outcome).toBe("refused");
      expect(atomsOn(id)).toEqual([space, space]);
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

    it("returns `unverified`, and leaves the stamp, where a stamped record's code is not what its identity hashes", async () => {
      const program = await writeProgram(PROGRAM_X);
      const id = idOf(sourceDocKey(program.entryIdentity));
      await replaceStored(id, (current) => ({
        value: { ...current.value!, code: `export const x = 3;` },
        entries: [
          ...(current.cfc?.labelMap.entries ?? []),
          ...rootPairStamp(space),
        ],
      }));

      expect(await repair(program.entryIdentity)).toBe("unverified");
      expect(atomsOn(id)).toEqual([space, space]);
    });

    it("finds no stamp in the closure of an entry no source record holds, and the one planted on a record of a closure", async () => {
      const program = await writeProgram(PROGRAM_X);
      const holdsStamp = async (entryIdentity: string) => {
        const tx = runtime.edit();
        try {
          return await compileCacheClosureHoldsStamp(
            runtime,
            space,
            entryIdentity,
            undefined,
            tx,
          );
        } finally {
          tx.abort();
        }
      };
      await plant(idOf(sourceDocKey(program.entryIdentity)), [
        ...rootPairStamp(space),
      ]);

      expect(await holdsStamp(program.entryIdentity)).toBe(true);
      expect(await holdsStamp(toModules(PROGRAM).entryIdentity)).toBe(false);
    });

    it("refuses, and writes nothing, where committing the repair's transaction would prepare it", async () => {
      // A request to a sink with a ceiling makes the transaction CFC-relevant
      // only once it is committed, and the preparation that follows would
      // derive labels the repair did not compute.

      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));
      const repairRequesting = (sink: string) =>
        repairCompileCacheStamps(
          runtime,
          space,
          program.entryIdentity,
          RUNTIME_VERSION,
          (tx) =>
            tx.recordCfcWritePolicyInput({
              kind: "sink-request",
              effectId: `${sink}:effect`,
              sink,
              request: { url: "https://example.com" },
            }),
        );

      expect(await repairRequesting(CEILINGED_SINK)).toBe("refused");
      expect(atomsOn(id)).toEqual([space, space]);
      expect(await repairRequesting("unceilinged")).toBe("repaired");
      expect(atomsOn(id)).toEqual([]);
    });

    it("rethrows what its stamp throws, with its transaction aborted and nothing written", async () => {
      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));
      const failure = new Error("stamp failed");
      let stamped: IExtendedStorageTransaction | undefined;

      await expect(
        repairCompileCacheStamps(
          runtime,
          space,
          program.entryIdentity,
          RUNTIME_VERSION,
          (tx) => {
            stamped = tx;
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      expect(stamped?.status().status).not.toBe("ready");
      expect(atomsOn(id)).toEqual([space, space]);
    });

    it("rewrites a stamped record that stores its code inline to store it in the code document the repair writes", async () => {
      const contents = `export const inline = 4;`;
      const program = toModules({
        main: "/inline.ts",
        files: [{ name: "/inline.ts", contents }],
      });
      const id = idOf(sourceDocKey(program.entryIdentity));
      const codeId = `cid:${taggedHashStringOf(contents)}` as URI;
      await replaceStored(id, () => ({
        value: {
          kind: "source",
          identity: program.entryIdentity,
          code: contents,
          filename: "/inline.ts",
          imports: [],
        },
        entries: rootPairStamp(space),
      }));
      expect(stored(codeId)).toEqual({});

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(codeId).value).toBe(contents);
      expect(typeof stored(id).value?.code).not.toBe("string");
      expect(atomsOn(id)).toEqual([]);
    });

    for (
      const [what, atOwnKey] of [
        ["holds nothing", false],
        ["holds that module's record", true],
      ] as const
    ) {
      it(`refuses a closure whose entry's key holds the record of the module importing it, where that module's own key ${what}`, async () => {
        // The loader keys each record by the identity it states, so the
        // record at the entry's key enters the closure as the importing
        // module, and a copy of the entry's record it links to as the entry:
        // a closure that verifies, assembled from records off their keys.

        const program = await writeProgram(PROGRAM_IMPORTING_SHARED);
        const shared = program.modules.find((m) => m.filename === "/u.ts")!;
        const sharedId = idOf(sourceDocKey(shared.identity));
        const mainId = idOf(sourceDocKey(program.entryIdentity));
        expect(await repair(shared.identity)).toBe("clean");

        const elsewhere = runtime.getCell(space, "stamp-repair-elsewhere");
        const main = stored(mainId);
        const tx = runtime.edit();
        seedStoredEnvelope(
          tx,
          address(elsewhere.getAsNormalizedFullLink().id as URI),
          stored(sharedId),
        );
        seedStoredEnvelope(tx, address(sharedId), {
          ...main,
          value: {
            ...main.value!,
            imports: [{
              specifier: "./u.ts",
              link: elsewhere.getAsLink() as unknown as FabricValue,
            }],
          },
        });
        if (!atOwnKey) seedStoredEnvelope(tx, address(mainId), {});
        expect((await tx.commit().settled).error).toBeUndefined();

        expect(await repair(shared.identity)).toBe("refused");
      });
    }

    it("refuses, and erases nothing, where a stamped compiled record's label also holds a clause no stamp placed", async () => {
      const program = await writeDelegatingProgram();
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await plant(compiled, [
        ...rootPairStamp(space),
        {
          path: [],
          origin: "declared",
          label: { confidentiality: [space] },
        } as unknown as FabricValue,
      ]);

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(stored(compiled).value).toBeDefined();
      expect(atomsOn(compiled)).toEqual([space, space, space]);
    });

    it("repairs, where its stamp reads a content-addressed document", async () => {
      // Such a document cannot change, so a read of it conditions nothing.

      const program = await writeDelegatingProgram();
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, rootPairStamp(space));
      const entry = program.modules.find((m) =>
        m.identity === program.entryIdentity
      )!;
      const codeId = `cid:${taggedHashStringOf(entry.source)}` as URI;
      let read: unknown;

      const outcome = await repairCompileCacheStamps(
        runtime,
        space,
        program.entryIdentity,
        RUNTIME_VERSION,
        (tx) => {
          read = tx.readOrThrow(address(codeId));
        },
      );

      expect(read).toEqual({ value: entry.source });
      expect(outcome).toBe("repaired");
      expect(atomsOn(id)).toEqual([]);
    });

    it("rewrites a stamped entry whose imports reach one module along two paths", async () => {
      const program = await writeProgram({
        main: "/main.ts",
        files: [
          {
            name: "/main.ts",
            contents: [
              `import { a } from "./a.ts";`,
              `import { b } from "./b.ts";`,
              `export const m = a + b;`,
            ].join("\n"),
          },
          {
            name: "/a.ts",
            contents: `import { c } from "./c.ts";\nexport const a = c;`,
          },
          {
            name: "/b.ts",
            contents: `import { c } from "./c.ts";\nexport const b = c;`,
          },
          { name: "/c.ts", contents: `export const c = 1;` },
        ],
      });
      const id = idOf(sourceDocKey(program.entryIdentity));
      const before = stored(id).value;
      await plant(id, rootPairStamp(space));

      expect(await repair(program.entryIdentity)).toBe("repaired");
      expect(stored(id).value).toEqual(before);
      expect(atomsOn(id)).toEqual([]);
    });

    it("refuses, and leaves the stamp, where a stamped source record's label holds an attestation the repair does not keep", async () => {
      const program = await writeProgram(PROGRAM_X);
      const id = idOf(sourceDocKey(program.entryIdentity));
      await plant(id, [
        ...rootPairStamp(space),
        {
          path: ["filename"],
          origin: "declared",
          label: { integrity: [COMPILED_INTEGRITY_ATOM] },
        } as unknown as FabricValue,
      ]);

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(atomsOn(id)).toEqual([space, space]);
    });

    it("refuses, and erases nothing, where the list that would grant an erase holds something other than an identity", async () => {
      const program = await writeDelegatingProgram();
      const source = idOf(sourceDocKey(program.entryIdentity));
      const compiled = idOf(
        compiledDocKey(RUNTIME_VERSION, program.entryIdentity),
      );
      await plant(compiled, rootPairStamp(space));
      await replaceStored(source, (current) => ({
        value: {
          ...current.value!,
          delegatedModuleIdentities: ["predecessor", 7],
        },
        entries: current.cfc!.labelMap.entries,
      }));

      expect(await repair(program.entryIdentity)).toBe("refused");
      expect(stored(compiled).value).toBeDefined();
      expect(atomsOn(compiled)).toEqual([space, space]);
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
            { space, key: sourceDocKey("x") },
            undefined,
          )
        ).toThrow(COMPILE_CACHE_REPAIR_WRITER);
      } finally {
        tx.abort();
      }
    });
  });
});
