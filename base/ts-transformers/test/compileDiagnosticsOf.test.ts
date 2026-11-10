import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StaticCache } from "@commonfabric/static";

import { transformSource, validateSource } from "./utils.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);
const options = { types: { "commonfabric.d.ts": commonfabricTypes } };

describe("compileDiagnosticsOf()", () => {
  it("captures the diagnostics alias as a reactive value", async () => {
    const source = `
      import { compileAndRun, compileDiagnosticsOf, computed, pattern } from "commonfabric";
      export default pattern(() => {
        const request = compileAndRun<unknown, number>({ files: [], main: "" });
        const alias = request;
        const diagnostics = compileDiagnosticsOf(alias);
        return { diagnostics, count: computed(() => diagnostics?.length ?? 0) };
      });
    `;
    const { diagnostics } = await validateSource(source, options);
    expect(diagnostics).toEqual([]);
    const output = await transformSource(source, {
      ...options,
      typeCheck: true,
    });
    expect(output).toContain("compileDiagnosticsOf(alias)");
    expect(output).toContain("diagnostics: diagnostics");
  });

  it("reports materialized and composed sources at compilation", async () => {
    const { diagnostics } = await validateSource(
      `
      import { compileAndRun, compileDiagnosticsOf, computed, pattern } from "commonfabric";
      const Child = pattern(() => ({ request: compileAndRun<unknown, number>({ files: [], main: "" }) }));
      export default pattern(() => {
        const request = compileAndRun<unknown, number>({ files: [], main: "" });
        const child = Child({});
        return {
          materialized: computed(() => compileDiagnosticsOf(request)),
          composed: compileDiagnosticsOf(child.request),
        };
      });
    `,
      options,
    );
    expect(
      diagnostics.filter((entry) =>
        entry.type === "availability:unsupported-compile-diagnostics-source"
      ),
    ).toHaveLength(2);
  });

  it("reports inline operations that would materialize the request", async () => {
    const { diagnostics } = await validateSource(
      `
      import { compileAndRun, compileDiagnosticsOf, pattern } from "commonfabric";
      export default pattern(() => {
        const request = compileAndRun<unknown, number>({ files: [], main: "" });
        return { count: compileDiagnosticsOf(request)?.length ?? 0 };
      });
    `,
      options,
    );
    const unsupported = diagnostics.filter((entry) =>
      entry.type === "availability:unsupported-compile-diagnostics-source"
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].message).toContain("standalone const");
  });
});
