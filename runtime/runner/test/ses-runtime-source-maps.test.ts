import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { identitySourceMap } from "@commonfabric/js-compiler/source-map";

import { SESRuntime } from "../src/sandbox/ses-runtime.ts";

describe("SESRuntime source-map registration", () => {
  // The runner-facing source-map surface of the SES runtime: the module-graph
  // boot path registers deferred providers (CT-1819), and both coordinate
  // lookup and stack parsing read what those providers materialize. The
  // provider semantics themselves belong to `SourceMapParser` and are covered
  // by its own tests.

  it("lazy providers materialize once, on first lookup", () => {
    const runtime = new SESRuntime();
    let providerCalls = 0;
    runtime.loadSourceMapLazy("lazy.js", () => {
      providerCalls++;
      return identitySourceMap(2, "/id/lazy.tsx");
    });
    expect(providerCalls).toBe(0);
    expect(runtime.mapPosition("lazy.js", 1, 0)?.source).toBe("/id/lazy.tsx");
    runtime.mapPosition("lazy.js", 2, 0);
    expect(providerCalls).toBe(1);
  });

  it("stack parsing rides the same registry as coordinate lookup", () => {
    const runtime = new SESRuntime();
    runtime.loadSourceMapLazy(
      "m.js",
      () => identitySourceMap(3, "/id/authored.tsx"),
    );

    expect(runtime.mapPosition("m.js", 2, 0)?.source).toBe("/id/authored.tsx");
    expect(runtime.parseStack("    at fn (m.js:3:0)")).toContain(
      "/id/authored.tsx:3:0",
    );
  });
});
