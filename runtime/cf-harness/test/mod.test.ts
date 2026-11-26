import { expect } from "@std/expect";

import * as packageRoot from "../mod.ts";
import * as index from "../src/index.ts";
import { runCfHarnessCli } from "../src/cli.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("mod", () => {
  it("exports every name the source index exports, and nothing else", () => {
    expect(Object.keys(packageRoot).sort()).toEqual(Object.keys(index).sort());
  });

  it("exports the CLI entry point itself rather than a copy", () => {
    expect(packageRoot.runCfHarnessCli).toBe(runCfHarnessCli);
  });
});
