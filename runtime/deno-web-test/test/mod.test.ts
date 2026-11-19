import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import * as mod from "../mod.ts";
import { Manifest } from "../manifest.ts";
import { Runner } from "../runner.ts";
import { TestServer } from "../server.ts";
import { buildTestDir, summarize } from "../utils.ts";

describe("mod", () => {
  it("exports the server, manifest, runner and build helpers", () => {
    expect(mod.TestServer).toBe(TestServer);
    expect(mod.Manifest).toBe(Manifest);
    expect(mod.Runner).toBe(Runner);
    expect(mod.buildTestDir).toBe(buildTestDir);
    expect(mod.summarize).toBe(summarize);
  });
});
