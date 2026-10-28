import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("immutable-cell-retention", () => {
  it("releases discarded element versions while retaining live sources, handles, and explicit snapshots", async () => {
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
        fromFileUrl(
          new URL("./immutable-cell-retention-helper.ts", import.meta.url),
        ),
      ],
    });
    const stdout = new TextDecoder().decode(output.stdout);
    expect(output.success, new TextDecoder().decode(output.stderr)).toBe(true);
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(report).toEqual({
      retainedBefore: 100,
      distinctIds: 100,
      equalSnapshots: 1,
      discardedAlive: 0,
      source: true,
      cell: { held: "cell" },
      link: { held: "link" },
      explicit: { held: "explicit" },
      queued: { held: "queued" },
      parsed: { held: "parsed" },
      relative: { held: "relative" },
      failedSchemaRetained: false,
    });
  });
});
