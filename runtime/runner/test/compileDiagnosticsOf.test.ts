import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { CompileDiagnostic } from "commonfabric";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

describe("compileDiagnosticsOf()", () => {
  for (
    const [scope, wrapper] of [["user", "PerUser"], ["session", "PerSession"]]
  ) {
    it(`drives compilation from diagnostics-only demand in ${scope} scope`, async () => {
      const identity = await Identity.fromPassphrase(
        `diagnostics-only-${scope}`,
      );
      const storage = StorageManager.emulate({ as: identity });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const Root = await runtime.patternManager.compilePattern(`
          import { pattern, compileAndRun, compileDiagnosticsOf, type ${wrapper} } from "commonfabric";
          export default pattern<{ contents: ${wrapper}<string> }>(({ contents }) => {
            const request = compileAndRun({ files: [{ name: "/main.tsx", contents }], main: "/main.tsx" });
            return { diagnostics: compileDiagnosticsOf(request) };
          });
        `);
        expect(Root.nodes).toHaveLength(1);
        const setup = runtime.edit();
        const argument = runtime.getCell<{ contents: string }>(
          identity.did(),
          `diagnostics-only-${scope}-input`,
          Root.argumentSchema,
          setup,
        );
        argument.set({
          contents: 'import { pattern } from "commonfabric";\n' +
            "export default pattern(() => ({ value: missingName }));",
        });
        const result = runtime.run(
          setup,
          Root,
          argument,
          runtime.getCell(
            identity.did(),
            `diagnostics-only-${scope}-output`,
            undefined,
            setup,
          ),
        );
        runtime.prepareTxForCommit(setup);
        await setup.commit().settled;
        const diagnostics = await waitForCellValue<
          CompileDiagnostic[] | undefined
        >(
          runtime,
          result.key("diagnostics"),
          (value) => Array.isArray(value) && value.length > 0,
        );
        expect(
          diagnostics?.some((entry) => entry.message.includes("missingName")),
        ).toBe(true);
        expect(
          result.key("diagnostics").resolveAsCell().getAsNormalizedFullLink()
            .scope,
        ).toBe(scope);
      } finally {
        await runtime.dispose();
        await storage.close();
      }
    });
  }

  it("exposes live diagnostics and clears them after a successful compilation", async () => {
    const identity = await Identity.fromPassphrase("compile diagnostics alias");
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const { compileAndRun, compileDiagnosticsOf, pattern } =
        createTrustedBuilder(runtime).commonfabric;
      const Root = pattern<{ contents: string }>(({ contents }) => {
        const request = compileAndRun<unknown, { value: number }>({
          files: [{ name: "/main.tsx", contents }],
          main: "/main.tsx",
        });
        return { request, diagnostics: compileDiagnosticsOf(request) };
      });
      expect(Root.nodes).toHaveLength(1);
      expect(Root.nodes[0].module).toMatchObject({
        type: "ref",
        implementation: "compileAndRun",
      });
      const space = identity.did();
      const setup = runtime.edit();
      const argument = runtime.getCell<{ contents: string }>(
        space,
        "diagnostics-source",
        undefined,
        setup,
      );
      argument.set({
        contents: 'import { pattern } from "commonfabric";\n' +
          "export default pattern(() => ({ value: missingName }));",
      });
      const result = runtime.run(
        setup,
        Root,
        argument,
        runtime.getCell<{
          request: unknown;
          diagnostics: CompileDiagnostic[] | undefined;
        }>(space, "diagnostics-result", undefined, setup),
      );
      runtime.prepareTxForCommit(setup);
      await setup.commit().settled;
      const diagnostics = await waitForCellValue<
        CompileDiagnostic[] | undefined
      >(
        runtime,
        result.key("diagnostics"),
        (value) => Array.isArray(value) && value.length > 0,
      );
      expect(
        diagnostics?.some((entry) => entry.message.includes("missingName")),
      ).toBe(true);
      expect(result.key("request").get()).toMatchObject({
        reason: "error",
        errorKind: "compile",
      });

      const update = runtime.edit();
      argument.withTx(update).set({
        contents: 'import { pattern } from "commonfabric";\n' +
          "export default pattern(() => ({ value: 42 }));",
      });
      await update.commit().settled;
      await waitForCellValue(
        runtime,
        result.key("request"),
        (value) => (value as { value?: number } | undefined)?.value === 42,
      );
      expect(result.key("diagnostics").get()).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
