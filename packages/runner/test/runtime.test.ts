import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";
import { isExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { SESRuntime } from "../src/sandbox/mod.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("runtime", () => {
  describe("SESRuntime", () => {
    it("clears cached callback creators on runtime.clear", () => {
      const runtime = new SESRuntime({ lockdown: true });

      const next = runtime.evaluateCallback(
        "function next(x) { return x + 1; }",
      ) as (x: number) => number;

      expect(next(1)).toBe(2);
      expect(
        runtime.accessForTestingOnly.callbackEvaluator.accessForTestingOnly
          .callbackCreatorCache.size,
      ).toBe(1);

      runtime.clear();

      expect(
        runtime.accessForTestingOnly.callbackEvaluator.accessForTestingOnly
          .callbackCreatorCache.size,
      ).toBe(0);
    });
  });

  describe("runtime module exports", () => {
    it("freezes the public CFC authoring module", () => {
      const { runtimeExports } = getRuntimeModuleExports();
      const cfc = runtimeExports["commonfabric/cfc"];

      expect(Object.isFrozen(cfc)).toBe(true);
      expect(Object.isFrozen(cfc.CFC_ATOM_TYPE)).toBe(true);
      expect(Object.isFrozen(cfc.cfcAtom)).toBe(true);
    });
  });

  describe("Engine module evaluation", () => {
    // NOTE: arbitrary top-level call results (`export default add(10, 2)`) are
    // rejected by the SES module-scope policy under the ESM record loader, so
    // these execute imported functions via exported functions instead.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("Compiles and executes a set of typescript files", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { add } from './utils.ts';",
              "export default function compute(): number { return add(10, 2); }",
            ].join("\n"),
          },
          {
            name: "/utils.ts",
            contents: "export const add=(x:number,y:number):number =>x+y;",
          },
        ],
      };
      const { main } = await runtime.harness.compileAndEvaluateModules(program);
      expect((main!.default as () => number)()).toBe(12);
    });

    it("Exports all file exports", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { add } from './utils/foo.ts';",
              "export function compute(): number { return add(10, 2); }",
              "export const foo = 'bar';",
            ].join("\n"),
          },
          {
            name: "/utils/foo.ts",
            contents:
              "export const add = (x: number, y: number): number => x + y; export const sub = (x: number, y: number): number => x - y;",
          },
        ],
      };
      const { exportMap } = await runtime.harness.compileAndEvaluateModules(
        program,
      );
      expect(exportMap).toBeDefined();
      // The export map is keyed by normalized authored paths and includes every
      // authored module's full export namespace.
      expect((exportMap!["/main.tsx"]["compute"] as () => number)()).toBe(12);
      expect(exportMap!["/main.tsx"]["foo"]).toBe("bar");
      expect(exportMap!["/utils/foo.ts"]["add"]).toBeInstanceOf(Function);
      expect(exportMap!["/utils/foo.ts"]["sub"]).toBeInstanceOf(Function);
    });

    it("compiles and executes the public CFC authoring runtime module", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND, cfcAtom } from 'commonfabric/cfc';",
              "export function buildCfcEvidence() {",
              "  return {",
              "    concept: CFC_CONCEPT_KIND.PromptInfluence,",
              "    safeType: cfcAtom.injectionSafe().type,",
              "    certifiedType: CFC_ATOM_TYPE.PolicyCertified,",
              "  };",
              "}",
            ].join("\n"),
          },
        ],
      };

      const { main } = await runtime.harness.compileAndEvaluateModules(program);

      expect((main!.buildCfcEvidence as () => unknown)()).toEqual({
        concept: "https://commonfabric.org/cfc/concepts/prompt-influence",
        safeType: "https://commonfabric.org/cfc/atom/InjectionSafe",
        certifiedType: "https://commonfabric.org/cfc/atom/PolicyCertified",
      });
    });
  });

  describe("getImmutableCell", () => {
    // The flag-on writer emits a link's schema as a content-addressed
    // reference; these cases opt in so that a link carries one.
    beforeEach(() => {
      setContentAddressedSchemasConfig(true);
    });
    afterEach(() => {
      resetContentAddressedSchemasConfig();
    });

    const space = signer.did();
    const targetSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit().settled;
      await runtime.dispose();
      await storageManager.close();
    });

    it("carries a link's schema inline in the id", () => {
      // A `data:` document is its id, so nothing writes it and nothing
      // persists the closure a reference-form schema inside it would name;
      // the id carries each link's schema in its recomposed form instead.
      const target = runtime.getCell(
        space,
        "immutable-target",
        targetSchema,
        tx,
      );
      target.set({ name: "x" });
      const link = target.getAsLink({ includeSchema: true });
      const carried = parseLink(link)!.schema;
      expect(isExternalSchemaRef((carried as { $ref: string }).$ref)).toBe(
        true,
      );

      const immutable = runtime.getImmutableCell(
        space,
        { ref: link },
        undefined,
      );
      const stored = valueFromDataUri(immutable.getAsNormalizedFullLink().id);
      expect(parseLink(stored.ref)!.schema).toEqual(resolvedSchema(carried));
    });

    it("resolves a linked value through the reference on a read", () => {
      const target = runtime.getCell(
        space,
        "immutable-target",
        targetSchema,
        tx,
      );
      target.set({ name: "x" });
      const link = target.getAsLink({ includeSchema: true });

      const immutable = runtime.getImmutableCell(
        space,
        { ref: link },
        undefined,
      );
      expect(immutable.withTx(tx).key("ref").get()).toEqual({ name: "x" });
    });

    it("stores a value linking to such a document and reads it back", async () => {
      const target = runtime.getCell(
        space,
        "immutable-target",
        targetSchema,
        tx,
      );
      target.set({ name: "x" });
      const link = target.getAsLink({ includeSchema: true });
      const immutable = runtime.getImmutableCell(
        space,
        { ref: link },
        undefined,
      );

      const holder = runtime.getCell<{ item?: { ref?: { name: string } } }>(
        space,
        "immutable-holder",
        undefined,
        tx,
      );
      // The immutable cell's value holds the link as a sigil; the holder's
      // type describes what a read through it resolves to.
      holder.key("item").set(
        immutable.get() as unknown as { ref: { name: string } },
      );
      await tx.commit().settled;

      tx = runtime.edit();
      expect(holder.withTx(tx).key("item").key("ref").get()).toEqual({
        name: "x",
      });
    });
  });
});
