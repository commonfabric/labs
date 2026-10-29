import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { argv, cf, checkStderr } from "./utils.ts";

describe("test-read-cost-output", () => {
  it("reports initialization, render, and assertion costs with authored sites", async () => {
    const root = resolve(import.meta.dirname!, "fixtures/render-step");
    const path = resolve(root, "direct-array-render.test.tsx");
    const { code, stdout, stderr } = await cf(
      argv`test ${path} --root ${root} --verbose --stats-threshold 0 --stats-action-limit 20 --no-idempotency-check`,
      { env: { CF_LOG_LEVEL: "error" } },
    );
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    checkStderr(stderr);
    expect(stdout.join("\n")).toContain("Idempotency verification disabled");
    expect(stdout.join("\n")).toContain("Read cost (initialization)");
    expect(stdout.join("\n")).toContain("Read cost (render_1)");
    expect(stdout.join("\n")).toContain("Read cost (assertion_1)");
    expect(stdout.join("\n")).toMatch(/direct-array-render\.test\.tsx:\d+:\d+/);
    expect(stdout.join("\n")).toMatch(/[1-9]\d* accesses/);
  });

  it("keeps verification enabled when the measurement flag is absent", async () => {
    const root = resolve(
      import.meta.dirname!,
      "fixtures/expect-non-idempotent",
    );
    const path = resolve(root, "unexpected-violation.test.tsx");
    const { code, stdout } = await cf(argv`test ${path} --root ${root}`);
    expect(code).not.toBe(0);
    expect(stdout.join("\n")).toContain("non-idempotent");
    expect(stdout.join("\n")).not.toContain("Read cost (");
  });
});
