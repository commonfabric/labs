import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StaticCache } from "@commonfabric/static";

import { transformSource, validateSource } from "./utils.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);
const options = { types: { "commonfabric.d.ts": commonfabricTypes } };

describe("partialResultOf()", () => {
  it("reports inline concatenation that would materialize the request", async () => {
    const { diagnostics } = await validateSource(
      `
      import { generateTextStream, partialResultOf, pattern } from "commonfabric";
      export default pattern(() => {
        const request = generateTextStream({ prompt: "hello" });
        return { text: "prefix:" + partialResultOf(request) };
      });
    `,
      options,
    );
    const unsupported = diagnostics.filter((entry) =>
      entry.type === "availability:unsupported-partial-result-source"
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].message).toContain("standalone const");
  });

  it("keeps a bound partial alias outside the derived computation", async () => {
    const source = `
      import { generateTextStream, partialResultOf, pattern } from "commonfabric";
      export default pattern(() => {
        const request = generateTextStream({ prompt: "hello" });
        const alias = request;
        const partial = (partialResultOf(alias));
        return { text: "prefix:" + partial };
      });
    `;
    const { diagnostics } = await validateSource(source, options);
    expect(diagnostics).toEqual([]);
    const output = await transformSource(source, {
      ...options,
      typeCheck: true,
    });
    expect(output).toContain("partialResultOf(alias)");
    expect(output).toContain('({ partial }) => "prefix:" + partial');
    expect(output).not.toContain('"prefix:" + partialResultOf');
  });

  it("accepts a transparently wrapped partial channel returned directly", async () => {
    const { diagnostics } = await validateSource(
      `
      import { generateTextStream, partialResultOf, pattern } from "commonfabric";
      export default pattern(() => {
        const request = generateTextStream({ prompt: "hello" });
        return { partial: (partialResultOf(request) as string) };
      });
    `,
      options,
    );
    expect(diagnostics).toEqual([]);
  });
});
