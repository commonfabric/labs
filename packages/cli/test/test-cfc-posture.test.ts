import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { cf } from "./utils.ts";

describe("test-cfc-posture", () => {
  const fixture = resolve(
    import.meta.dirname!,
    "fixtures/cfc-flow-labels/mapped-render.test.tsx",
  );
  const small = resolve(
    import.meta.dirname!,
    "fixtures/render-step/direct-array-render.test.tsx",
  );

  it("reports both postures and CFC spans over the same labeled mapped render", async () => {
    for (
      const [flags, posture] of [
        [
          "--cfc-enforcement-mode disabled --cfc-flow-labels off",
          "disabled flowLabels=off",
        ],
        ["--cfc-shell-posture", "enforce-explicit flowLabels=persist"],
      ]
    ) {
      const { code, stdout, stderr } = await cf(
        `test "${fixture}" ${flags} --verbose --stats-threshold 0 --no-idempotency-check`,
      );
      expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
      const report = stdout.join("\n");
      expect(report).toContain(`CFC posture: enforcement=${posture}`);
      for (const n of [11, 50, 150]) expect(report).toContain(`N=${n}`);
      for (const [index, size] of [11, 50, 150].entries()) {
        const step = index + 1;
        expect(report).toMatch(new RegExp(`render_${step} took`));
        // A render of a still-pending query touches only its envelope. Each
        // populated view must traverse at least its N distinct row documents.
        const reads = report.match(
          new RegExp(
            `Read cost \\(render_${step}\\):.*? (\\d+) documents/run summed`,
          ),
        );
        expect(reads).not.toBeNull();
        expect(Number(reads![1])).toBeGreaterThanOrEqual(size);
      }
      for (
        const span of [
          "prepareCfc",
          "deriveFlowJoin",
          "collectConsumedLabel",
          "preparedDigestFor",
        ]
      ) {
        expect(report).toContain(span);
      }
      if (flags === "--cfc-shell-posture") {
        expect(report).toMatch(/cfc\/deriveFlowJoin\s+Δn=\s*[1-9]/);
        expect(report).toMatch(/cfc\/preparedDigestFor\s+Δn=\s*[1-9]/);
        // Successful writes skip refusal-source collection, but its zero count
        // must remain visible beside the active preparation spans.
        expect(report).toMatch(/cfc\/collectConsumedLabel\s+Δn=\s*0/);
      } else {
        expect(report).not.toMatch(/cfc\/deriveFlowJoin\s+Δn=\s*[1-9]/);
      }
    }
  });

  it("resolves the derive alias to the runtime observe mode", async () => {
    const { code, stdout } = await cf(
      `test "${small}" --cfc-flow-labels derive`,
    );
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(
      "enforcement=enforce-strict flowLabels=observe",
    );
  });

  it("rejects invalid modes and conflicting shorthand in either order", async () => {
    for (
      const flags of [
        "--cfc-flow-labels typo",
        "--cfc-enforcement-mode typo",
        "--cfc-shell-posture --cfc-flow-labels off",
        "--cfc-flow-labels off --cfc-shell-posture",
        "--cfc-shell-posture --cfc-enforcement-mode disabled",
        "--cfc-enforcement-mode disabled --cfc-shell-posture",
      ]
    ) {
      const { code, stdout } = await cf(`test "${small}" ${flags}`);
      expect(code).not.toBe(0);
      expect(stdout.join("\n")).not.toContain("CFC posture:");
    }
  });
});
