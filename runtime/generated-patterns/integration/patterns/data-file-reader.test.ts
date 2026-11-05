import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

/**
 * A scenario naming `dataFiles` gets them attached to the program the harness
 * compiles, so a pattern reading one runs here as it would once deployed.
 * Without the attachment the pattern still compiles, and fails on the read.
 */
const dataFileReaderScenario: PatternIntegrationScenario = {
  name: "pattern reads an attached data file",
  module: new URL("./data-file-reader.pattern.ts", import.meta.url),
  exportName: "dataFileReader",
  dataFiles: [
    fromFileUrl(new URL("./data/cities.json", import.meta.url)),
  ],
  dataRoot: fromFileUrl(new URL(".", import.meta.url)),
  steps: [
    {
      expect: [
        { path: "cities", value: ["Oslo", "Lima"] },
        { path: "count", value: 2 },
      ],
    },
  ],
};

describe("data-file-reader", () => {
  it(dataFileReaderScenario.name, async () => {
    await runPatternScenario(dataFileReaderScenario);
  });
});
