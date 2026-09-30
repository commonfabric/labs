import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("cfc constructor reference", () => {
  for (const covering of [false, true]) {
    it(
      covering
        ? "retains covering confidentiality when initialization observes private existence"
        : "preserves a public constructor reference when initialization only checks public object existence",
      async () => {
        const signer = await Identity.fromPassphrase("constructor-reference");
        const storage = StorageManager.emulate({ as: signer });
        const runtimes: Runtime[] = [];
        const createRuntime = () => {
          const runtime = new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager: storage,
            cfcFlowLabels: "persist",
          });
          runtimes.push(runtime);
          return runtime;
        };
        try {
          const initialRuntime = createRuntime();
          const setup = initialRuntime.edit();
          const schema = covering
            ? {
              type: "string",
              default: "initial private content",
              ifc: { confidentiality: ["private"] },
            } as const
            : {
              type: "object",
              default: { content: "initial private content" },
              properties: {
                content: {
                  type: "string",
                  ifc: { confidentiality: ["private"] },
                },
              },
            } as const;
          const target = initialRuntime.getCell(
            signer.did(),
            "target",
            schema,
            setup,
          );
          initialRuntime.getCell(
            signer.did(),
            "initial output",
            covering ? { ifc: { confidentiality: ["private"] } } : undefined,
            setup,
          )
            .set(target);
          expect((await setup.commit()).error).toBeUndefined();

          const edit = initialRuntime.edit();
          const contentTarget = covering
            ? target.withTx(edit)
            : target.withTx(edit).key("content");
          contentTarget.set("edited private content");
          expect((await edit.commit()).error).toBeUndefined();

          const runtime = createRuntime();
          const repeat = runtime.edit();
          const repeatedTarget = runtime.getCell(
            signer.did(),
            "target",
            schema,
            repeat,
          );
          const repeatedOutput = runtime.getCell(
            signer.did(),
            "repeated output",
            covering ? { ifc: { confidentiality: ["private"] } } : undefined,
            repeat,
          );
          repeatedOutput.set(repeatedTarget);
          expect(deriveFlowJoin(repeat).confidentiality).toEqual(
            covering ? ["private"] : [],
          );
          expect((await repeat.commit()).error).toBeUndefined();

          const readReference = runtime.edit();
          repeatedOutput.withTx(readReference).resolveAsCell().getAsLink();
          expect(deriveFlowJoin(readReference).confidentiality).toEqual(
            covering ? ["private"] : [],
          );
          readReference.abort();

          const readContent = runtime.edit();
          const content = covering
            ? repeatedOutput.withTx(readContent)
            : repeatedOutput.withTx(readContent).key("content");
          expect(content.get()).toBe("edited private content");
          expect(deriveFlowJoin(readContent).confidentiality).toContain(
            "private",
          );
          runtime.getCell(
            signer.did(),
            "selected after read",
            { ifc: { confidentiality: ["private"] } },
            readContent,
          ).set(repeatedTarget.withTx(readContent));
          expect((await readContent.commit()).error).toBeUndefined();
          const readSelected = runtime.edit();
          runtime.getCell(
            signer.did(),
            "selected after read",
            undefined,
            readSelected,
          ).resolveAsCell().getAsLink();
          expect(deriveFlowJoin(readSelected).confidentiality).toContain(
            "private",
          );
          readSelected.abort();
        } finally {
          await storage.synced();
          for (const runtime of runtimes.reverse()) await runtime.dispose();
          await storage.close();
        }
      },
    );
  }
});
