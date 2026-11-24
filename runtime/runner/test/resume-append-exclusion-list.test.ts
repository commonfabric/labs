import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  makeServer,
  runResumeAppendScenario,
} from "./resume-append-scenario.ts";

// Companion to resume-append-exclusion.test.ts (the filter case): flatMap shares
// the same per-element run machinery, so an element appended to its input during
// the resume-await window — while the per-element op result documents are held
// back by the transport — must converge into the aggregate. The op projects a
// numeric field (`item.n`), whose per-element result document carries the same
// `["element", ...]` link path the shared gate matches, so the window is held
// deterministically (no timers). flatMap pushes the per-element result VALUE into
// its aggregate, so a value lost to a reverted resume reconcile freezes the
// appended element out unless the element run is set up again. Marking a
// reverted setup as owed is what makes the next reconcile issue it.
//
// map is deliberately not covered here. Its aggregate holds element-cell
// REFERENCES that resolve through the projection rather than copied values —
// which is exactly why a reverted per-element write does not freeze it (the same
// reason map does not use the resume-republish machinery) and why it is immune to
// this bug. That reference-shaped output is also why it cannot run under this
// gate: resolving the container reads through to the per-element result cells, so
// startup itself would block on the held documents.

const signer = await Identity.fromPassphrase("append during resume repro list");
const space = signer.did();

const ITEMS = [
  { n: 1, label: "a" },
  { n: 2, label: "b" },
  { n: 3, label: "c" },
  { n: 4, label: "d" },
];

const values = (
  rc: { key: (k: string) => { getAsQueryResult: () => unknown } },
): number[] => [...((rc.key("values").getAsQueryResult() ?? []) as number[])];

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number; label: string }[] }>(({ items }) => {",
      "  return { items, values: items.flatMap((item) => item.n) };",
      "});",
    ].join("\n"),
  }],
};

describe("append to a flatMap input during the resume await window", () => {
  let server: MemoryV2Server.Server;
  beforeEach(() => {
    server = makeServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("converges an element appended while results are held", async () => {
    const { output, heldCount } = await runResumeAppendScenario({
      signer,
      space,
      server,
      program: PROGRAM,
      cellId: "append-repro-flatmap",
      resultKey: "values",
      items: ITEMS,
      appended: { n: 5, label: "e" },
      read: values,
      buildExpected: [1, 2, 3, 4],
    });

    expect(heldCount).toBeGreaterThan(0);
    expect(output).toEqual([1, 2, 3, 4, 5]);
  });
});
