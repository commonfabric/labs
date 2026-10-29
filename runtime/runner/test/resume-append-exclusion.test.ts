import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  makeServer,
  runResumeAppendScenario,
} from "./resume-append-scenario.ts";

const signer = await Identity.fromPassphrase("append during resume repro");
const space = signer.did();

// The pattern returns `items` too, so the test can grow the input list through
// the result cell and have the filter re-evaluate.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { items, kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const ITEMS = [
  { keep: true, label: "a" },
  { keep: true, label: "b" },
  { keep: true, label: "c" },
  { keep: true, label: "d" },
];

const labels = (
  rc: { key: (k: string) => { getAsQueryResult: () => unknown } },
): string[] =>
  ((rc.key("kept").getAsQueryResult() ?? []) as { label: string }[]).map((x) =>
    x.label
  );

describe("append to filter input during the resume await window", () => {
  let server: MemoryV2Server.Server;
  beforeEach(() => {
    server = makeServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("converges an element appended while predicates are still streaming in", async () => {
    const { output, heldCount } = await runResumeAppendScenario({
      signer,
      space,
      server,
      program: PROGRAM,
      cellId: "append-repro",
      resultKey: "kept",
      items: ITEMS,
      appended: { keep: true, label: "e" },
      read: labels,
      buildExpected: ["a", "b", "c", "d"],
    });

    // The window was genuinely open, and the appended keep:true element
    // converged into the filtered result.
    expect(heldCount).toBeGreaterThan(0);
    expect(output).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("applies removal while obsolete predicate syncs remain held", async () => {
    const { output, outputWhileHeld, heldCount } =
      await runResumeAppendScenario({
        signer,
        space,
        server,
        program: PROGRAM,
        cellId: "remove-during-resume",
        resultKey: "kept",
        items: ITEMS,
        appended: undefined,
        updateItems: () => [],
        read: labels,
        buildExpected: ["a", "b", "c", "d"],
      });

    expect(heldCount).toBeGreaterThan(0);
    // Nothing reconciles while the pre-sync still holds the predicate results,
    // so the durable aggregate stands intact inside the window; the removal
    // lands with the first reconcile after the release.
    expect(outputWhileHeld).toEqual(["a", "b", "c", "d"]);
    expect(output).toEqual([]);
  });
});
