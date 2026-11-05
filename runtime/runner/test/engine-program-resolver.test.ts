import { assert, assertEquals } from "@std/assert";
import { StaticCache } from "@commonfabric/static";

import {
  EngineProgramResolver,
  mergeResolvedProgramBatches,
  validateTrustedCommonFabricTypeSources,
} from "../src/harness/engine.ts";

Deno.test("EngineProgramResolver records exact compiler-owned Common Fabric type sources", async () => {
  const authoredSourceName = "/authored-commonfabric.d.ts";
  const resolver = new EngineProgramResolver({
    main: "/main.ts",
    files: [
      { name: "/main.ts", contents: "export default 1;" },
      {
        name: authoredSourceName,
        contents: "export declare function pattern(): unknown;",
      },
    ],
  }, StaticCache.fromFileSystem());

  assert(await resolver.resolveSource("commonfabric/cfc.d.ts"));
  assert(await resolver.resolveSource("commontools"));
  assert(await resolver.resolveSource("@commontools/builder"));
  assert(await resolver.resolveSource("cfc.ts"));
  assert(await resolver.resolveSource("turndown.d.ts"));
  assert(await resolver.resolveSource(authoredSourceName));

  assertEquals(
    new Set(
      resolver.trustedCommonFabricTypeSources().map((source) => source.name),
    ),
    new Set([
      "commonfabric/cfc.d.ts",
      "commontools",
      "@commontools/builder",
      "cfc.ts",
    ]),
  );
});

Deno.test("trusted Common Fabric source names stay bound to resolver-supplied bytes", async () => {
  const resolver = new EngineProgramResolver({
    main: "/main.ts",
    files: [{ name: "/main.ts", contents: "export default 1;" }],
  }, StaticCache.fromFileSystem());
  const trusted = await resolver.resolveSource("commonfabric.d.ts");
  assert(trusted);

  const attacker = {
    name: trusted.name,
    contents: "export declare function pattern(): 'attacker';",
  };
  let error: unknown;
  try {
    validateTrustedCommonFabricTypeSources([attacker], [trusted]);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  assert(error.message.includes("trusted Common Fabric type source"));
});

for (const order of ["authored-first", "trusted-first"] as const) {
  Deno.test(`batch merge rejects a trusted Common Fabric name collision (${order})`, () => {
    const trusted = {
      name: "commonfabric.d.ts",
      contents: "export declare function pattern(): 'trusted';",
    };
    const authored = {
      name: trusted.name,
      contents: "export declare function pattern(): 'attacker';",
    };
    const trustedBatch = { files: [trusted], trustedSources: [trusted] };
    const authoredBatch = { files: [authored], trustedSources: [] };
    const batches = order === "authored-first"
      ? [authoredBatch, trustedBatch]
      : [trustedBatch, authoredBatch];

    let error: unknown;
    try {
      mergeResolvedProgramBatches(batches);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error);
    assert(error.message.includes("trusted Common Fabric type source"));
  });
}
