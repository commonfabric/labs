import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("esm-verifier-benchmark", () => {
  it("reports graph measurements for the synthetic and parking programs", async () => {
    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lock) => [
        "bench",
        "--frozen",
        "--lock",
        lock,
        "--no-check",
        "--json",
        "-A",
        "--filter",
        "graph verify:",
        "runtime/runner/test/esm-verifier.bench.ts",
      ],
      env: { CF_LOG_LEVEL: "silent", EXPERIMENTAL_SERVER_EXECUTION: "false" },
    });
    const stderr = new TextDecoder().decode(output.stderr);
    expect(output.code, stderr).toBe(0);
    const report = JSON.parse(new TextDecoder().decode(output.stdout));
    expect(report.benches).toEqual([
      expect.objectContaining({
        group: "small",
        name: "graph verify: small",
        results: [expect.objectContaining({ ok: expect.any(Object) })],
      }),
      expect.objectContaining({
        group: "parking",
        name: "graph verify: parking",
        results: [expect.objectContaining({ ok: expect.any(Object) })],
      }),
    ]);
  });
});
