import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

/** Runs a helper with `--expose-gc` and returns the report it prints last. */
async function runGcHelper(helper: string): Promise<unknown> {
  const output = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../../../", import.meta.url)),
    args: (
      lock,
    ) => [
      "run",
      "-A",
      "--frozen",
      `--lock=${lock}`,
      "--v8-flags=--expose-gc",
      fromFileUrl(new URL(helper, import.meta.url)),
    ],
  });
  const stdout = new TextDecoder().decode(output.stdout);
  expect(output.success, new TextDecoder().decode(output.stderr)).toBe(true);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("immutable-cell-retention", () => {
  it("releases discarded element versions while retaining live sources, handles, and explicit snapshots", async () => {
    const report = await runGcHelper("./immutable-cell-retention-helper.ts");
    expect(report).toEqual({
      retainedBefore: 100,
      distinctIds: 100,
      equalSnapshots: 1,
      discardedAlive: 0,
      source: true,
      cell: { held: "cell" },
      link: { held: "link" },
      explicit: { held: "explicit" },
      droppedStoreReleased: true,
      queued: { held: "queued" },
      parsed: { held: "parsed" },
      relative: { held: "relative" },
      failedSchemaRetained: false,
      immutableCell: {
        dropped: true,
        droppedPrimitive: true,
        held: { owned: "held" },
        portable: { owned: "portable" },
      },
    });
  });

  it("refuses a snapshot whose origin was collected until equal content mints it again", async () => {
    const report = await runGcHelper(
      "./immutable-cell-expired-origin-helper.ts",
    );
    const child = {
      child: { "/": { "link@1": { path: ["originDocument"] } } },
    };
    expect(report).toEqual({
      collected: {
        origin: "Unknown or expired immutable cell",
        child,
        linkToChild: "Unknown or expired immutable cell",
      },
      waiting: { child, origin: "Unknown immutable cell" },
      recreatedSameId: true,
      recovered: {
        origin: { originDocument: "reclaimed" },
        linkToChild: "created",
      },
    });
  });
});
