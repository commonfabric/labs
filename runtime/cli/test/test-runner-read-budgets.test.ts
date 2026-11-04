import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { resolve } from "@std/path";
import { stub } from "@std/testing/mock";
import { Runtime, RuntimeTelemetryEvent } from "@commonfabric/runner";

import { runTests } from "../lib/test-runner.ts";

const root = resolve(import.meta.dirname!, "fixtures/read-budgets");

describe("test-runner read budgets", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it("passes functional assertions with generous limits and a zero-work override", async () => {
    const output: string[] = [];
    using _log = stub(console, "log", (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const result = await runTests(resolve(root, "passing.test.tsx"), {
      root,
      verbose: true,
      statsThreshold: 0,
    });
    expect(result.results.map((r) => r.error)).toEqual([undefined]);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    expect(output.some((line) => line.includes("Read budget (initialization)")))
      .toBe(true);
    expect(
      output.some((line) =>
        line.includes(
          "Read budget (step 3): 0 attempt accesses, 0 maximum body accesses",
        )
      ),
    ).toBe(true);
  });

  it("accounts for compiled handler input materialization separately from its body", async () => {
    const run = Runtime.prototype.run;
    const presyncReads: { proxyAccesses: number; linkResolutions: number }[] =
      [];
    using _run = stub(Runtime.prototype, "run", function (...args) {
      this.telemetry.addEventListener("telemetry", (event) => {
        if (
          event instanceof RuntimeTelemetryEvent &&
          event.marker.type === "scheduler.read-attempt" &&
          event.marker.kind === "presync"
        ) presyncReads.push(event.marker.reads);
      });
      return run.apply(this, args);
    });
    const result = await runTests(resolve(root, "presync.test.tsx"), { root });
    expect(result.failed).toBe(0);
    expect(presyncReads).toHaveLength(1);
    expect(presyncReads[0].linkResolutions).toBeGreaterThan(0);
  });

  it("preserves skipped results and action numbering with read budgets enabled", async () => {
    const output: string[] = [];
    using _log = stub(console, "log", (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const result = await runTests(resolve(root, "skipped-steps.test.tsx"), {
      root,
      verbose: true,
    });
    expect(result.failed).toBe(0);
    const steps = result.results.flatMap((r) => r.results);
    expect(steps.map(({ name, passed, skipped, afterAction }) => ({
      name,
      passed,
      skipped,
      afterAction,
    }))).toEqual([
      { name: "assertion_1", passed: true, skipped: true, afterAction: null },
      {
        name: "assertion_2",
        passed: true,
        skipped: undefined,
        afterAction: null,
      },
      {
        name: "assertion_3",
        passed: true,
        skipped: true,
        afterAction: "action_2",
      },
      {
        name: "assertion_4",
        passed: true,
        skipped: undefined,
        afterAction: "action_2",
      },
    ]);
    expect(output.some((line) => line.includes("action_1 (skipped)"))).toBe(
      true,
    );
    expect(output.some((line) => line.includes("Read budget (skipped step 2)")))
      .toBe(true);
  });

  it("fails a zero total budget even when the functional assertion passes", async () => {
    const output: string[] = [];
    using _log = stub(console, "log", (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const result = await runTests(resolve(root, "failing-step.test.tsx"), {
      root,
      verbose: true,
      statsThreshold: 0,
    });
    expect(result.failed).toBeGreaterThan(0);
    const steps = result.results.flatMap((r) => r.results);
    expect(
      steps.some((s) =>
        s.error?.includes("step 2: read budget total exceeded")
      ),
    ).toBe(true);
    expect(steps.find((s) => s.name === "assertion_1")?.passed).toBe(true);
    expect(
      output.some((line) =>
        line.includes("Read budget (step 2)") && line.includes("FAIL")
      ),
    ).toBe(true);
  });

  it("enforces render budgets before advancing through the render branch", async () => {
    const result = await runTests(resolve(root, "failing-render.test.tsx"), {
      root,
    });
    const steps = result.results.flatMap((r) => r.results);
    expect(
      steps.some((s) =>
        s.error?.includes("step 1: read budget total exceeded")
      ),
    )
      .toBe(true);
    expect(
      steps.some((s) =>
        s.error?.includes("step 1: read budget perRun exceeded")
      ),
    )
      .toBe(true);
  });

  it("enforces initialization separately from subsequent steps", async () => {
    const result = await runTests(
      resolve(root, "failing-initialization.test.tsx"),
      { root, continuousUI: true },
    );
    expect(result.failed).toBeGreaterThan(0);
    const steps = result.results.flatMap((r) => r.results);
    expect(
      steps.some((s) =>
        s.error?.includes("initialization: read budget total exceeded")
      ),
    ).toBe(true);
    expect(steps.find((s) => s.name === "assertion_1")?.passed).toBe(true);
  });

  it("enforces the maximum reactive body independently of the total ceiling", async () => {
    const result = await runTests(resolve(root, "failing-per-run.test.tsx"), {
      root,
    });
    const steps = result.results.flatMap((r) => r.results);
    expect(steps.some((s) => s.error?.includes("read budget perRun exceeded")))
      .toBe(true);
    expect(steps.some((s) => s.error?.includes("read budget total exceeded")))
      .toBe(false);
  });

  it("rejects step limits without a module opt-in", async () => {
    const result = await runTests(resolve(root, "missing-opt-in.test.tsx"), {
      root,
    });
    expect(result.results[0].error).toContain(
      "without a module-level `readBudgets` export",
    );
  });

  it("rejects invalid module limits before executing assertions", async () => {
    const result = await runTests(
      resolve(root, "invalid-declaration.test.tsx"),
      { root },
    );
    expect(result.results[0].error).toContain("nonnegative safe integer");
    expect(result.results[0].results).toEqual([]);
  });

  it("rejects multi-user budgets instead of claiming incomplete enforcement", async () => {
    const result = await runTests(resolve(root, "multi-user.test.tsx"), {
      root,
    });
    expect(result.results[0].error).toContain(
      "Read budgets are not supported in multi-user tests",
    );
  });

  it("preserves render errors alongside an initialization budget failure", async () => {
    const result = await runTests(resolve(root, "invalid-render.test.tsx"), {
      root,
      continuousUI: true,
    });
    expect(result.results[0].error).toContain(
      "initialization: read budget total exceeded",
    );
    expect(result.results[0].error).toContain("VDOM");
  });

  it("rejects multi-user step overrides even without a module declaration", async () => {
    const result = await runTests(resolve(root, "multi-user-step.test.tsx"), {
      root,
    });
    expect(result.results[0].error).toContain(
      "read budgets are not supported in multi-user tests",
    );
  });

  it("reports incomplete initialization without restarting a rejected budget settlement", async () => {
    const settled = Runtime.prototype.settled;
    let budgetBarriers = 0;
    using _settled = stub(Runtime.prototype, "settled", function (maxRounds) {
      if (maxRounds === Infinity) {
        budgetBarriers++;
        return Promise.reject(new Error("initialization settlement failed"));
      }
      return settled.call(this, maxRounds);
    });
    const result = await runTests(resolve(root, "passing.test.tsx"), { root });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.results[0].error).toContain(
      "initialization settlement failed",
    );
    expect(result.results[0].error).toContain(
      "initialization: read budget measurement incomplete",
    );
    expect(budgetBarriers).toBe(1);
  });

  it("does not restart settlement after the initial idle phase fails", async () => {
    const run = Runtime.prototype.run;
    const idle = Runtime.prototype.idle;
    const settled = Runtime.prototype.settled;
    let initializationCommitted = false;
    let rejected = false;
    let budgetBarriers = 0;
    using _run = stub(Runtime.prototype, "run", function (...args) {
      this.telemetry.addEventListener("telemetry", (event) => {
        if (
          event instanceof RuntimeTelemetryEvent &&
          event.marker.type === "scheduler.read-attempt" &&
          event.marker.kind === "initialization"
        ) initializationCommitted = true;
      });
      return run.apply(this, args);
    });
    using _idle = stub(Runtime.prototype, "idle", function (...args) {
      if (initializationCommitted && !rejected) {
        rejected = true;
        return Promise.reject(new Error("initial idle failed"));
      }
      return idle.apply(this, args);
    });
    using _settled = stub(Runtime.prototype, "settled", function (maxRounds) {
      if (maxRounds === Infinity) budgetBarriers++;
      return settled.call(this, maxRounds);
    });
    const result = await runTests(resolve(root, "passing.test.tsx"), { root });
    expect(result.failed).toBeGreaterThan(0);
    expect(rejected).toBe(true);
    expect(result.results[0].error).toContain("initial idle failed");
    expect(result.results[0].error).toContain(
      "initialization: read budget measurement incomplete",
    );
    expect(budgetBarriers).toBe(0);
  });

  it("does not restart settlement after an action settlement failure", async () => {
    const settled = Runtime.prototype.settled;
    const idle = Runtime.prototype.idle;
    let initialized = false;
    let budgetBarriers = 0;
    using _settled = stub(
      Runtime.prototype,
      "settled",
      async function (maxRounds) {
        if (maxRounds === Infinity) budgetBarriers++;
        await settled.call(this, maxRounds);
        if (maxRounds === Infinity) initialized = true;
      },
    );
    using _idle = stub(Runtime.prototype, "idle", function (...args) {
      if (initialized) {
        return Promise.reject(new Error("action settlement failed"));
      }
      return idle.apply(this, args);
    });
    const result = await runTests(resolve(root, "passing.test.tsx"), { root });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.results[0].error).toContain("action settlement failed");
    expect(result.results[0].error).toContain("measurement incomplete");
    expect(budgetBarriers).toBe(1);
  });

  it("retains an assertion failure when the final budget settlement rejects", async () => {
    const settled = Runtime.prototype.settled;
    let boundaries = 0;
    using _settled = stub(
      Runtime.prototype,
      "settled",
      async function (maxRounds) {
        if (maxRounds === Infinity && ++boundaries === 2) {
          throw new Error("budget settlement failed");
        }
        await settled.call(this, maxRounds);
      },
    );
    const result = await runTests(resolve(root, "failing-assertion.test.tsx"), {
      root,
    });
    expect(boundaries).toBeGreaterThanOrEqual(2);
    expect(result.results[0].error).toContain("budget settlement failed");
    expect(result.results[0].error).toContain("assertion_1");
    expect(
      result.results[0].results.find((r) => r.name === "assertion_1")?.passed,
    ).toBe(false);
  });

  for (
    const [file, exceeded, within] of [
      ["many-cheap.test.tsx", "total", "perRun"],
      ["one-expensive.test.tsx", "perRun", "total"],
    ]
  ) {
    it(`distinguishes ${exceeded} from ${within} limits in ${file}`, async () => {
      const result = await runTests(resolve(root, file), {
        root,
        continuousUI: true,
      });
      const steps = result.results.flatMap((r) => r.results);
      expect(
        steps.some((r) =>
          r.error?.includes(`read budget ${exceeded} exceeded`)
        ),
      ).toBe(true);
      expect(
        steps.some((r) => r.error?.includes(`read budget ${within} exceeded`)),
      ).toBe(false);
      expect(steps.find((r) => r.name === "assertion_1")?.passed).toBe(true);
    });
  }
});
