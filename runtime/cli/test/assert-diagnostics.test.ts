/**
 * Contract tests for what `cf test` reports when an assertion fails.
 *
 * An `assert(...)` assertion carries the operands recorded while it ran, so a
 * failure names them and their values.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/assert-diagnostics");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/**
 * The failure messages, with runs of spaces collapsed. The runner pads operand
 * labels so they line up, which is cosmetic; collapsing keeps these tests from
 * depending on the widest label in the message.
 */
async function errorsFor(name: string): Promise<string[]> {
  const { results } = await runTests(fixture(name), { root: FIXTURES });
  return results
    .flatMap((file) => file.results)
    .map((test) => (test.error ?? "").replace(/ +/g, " "));
}

describe(
  "cf test assertion diagnostics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("names the operands of a failed comparison and their values", async () => {
      const [comparison] = await errorsFor("failing.test.tsx");

      // The whole point: `Expected true, got false` on its own cannot say why.
      expect(comparison).toContain("a.get() + b.get() <= c.get()");
      expect(comparison).toContain("a.get() + b.get() = 3");
      expect(comparison).toContain("c.get() = 2");
    });

    it("names the arguments of a failed call", async () => {
      const [, call] = await errorsFor("failing.test.tsx");

      expect(call).toContain("inRange(5, b.get(), c.get())");
      expect(call).toContain("b.get() = 2");
      expect(call).toContain("c.get() = 2");
      // A literal argument renders to its own source text, so it is not
      // recorded and does not earn a line.
      expect(call).not.toContain("5 = 5");
    });

    it("passes an assertion that holds, and reports no operands for it", async () => {
      const { passed, failed, results } = await runTests(
        fixture("failing.test.tsx"),
        { root: FIXTURES },
      );

      expect(passed).toBe(1);
      expect(failed).toBe(2);
      const holds = results.flatMap((file) => file.results)[2]!;
      expect(holds.passed).toBe(true);
      expect(holds.error ?? "").toBe("");
    });

    it("leads with the assertion's source, not a restatement of the verdict", async () => {
      const [comparison] = await errorsFor("failing.test.tsx");

      // The step is already marked failed and the operands say it was false,
      // so "Expected true, got false" in front of every one of these is noise.
      expect(comparison.split("\n")[0]).toBe("a.get() + b.get() <= c.get()");
      expect(comparison).not.toContain("Expected true, got false");
    });

    it("reports the verdict when there are no operands to explain it", async () => {
      // Nothing was recorded here — a spread cannot be, and the callee is not
      // a method — so the source on its own would not say what happened.
      const { results } = await runTests(fixture("call-shapes.test.tsx"), {
        root: FIXTURES,
      });
      const spread = results.flatMap((file) => file.results)[0]!;

      expect(spread.error ?? "").toBe(
        "Expected true, got false: allPositive(...nums.get())",
      );
    });

    it("names the failing conjunct and the values behind it", async () => {
      const [conjunction] = await errorsFor("control-flow.test.tsx");

      expect(conjunction).toContain("a.get() > 0 = false");
      expect(conjunction).toContain("a.get() = -1");
    });

    it("records nothing for an operand short-circuiting skipped", async () => {
      const [conjunction] = await errorsFor("control-flow.test.tsx");

      // `a.get() > 0` is false, so `&&` never evaluates the right conjunct.
      // Recording it anyway would report a value the assertion never read.
      // The header quotes the whole assertion, so look at the recorded lines.
      const recorded = conjunction.split("\n").slice(1);
      expect(recorded.some((line) => line.includes("b.get()"))).toBe(false);
      // The conjunct that did run is still there.
      expect(recorded.some((line) => line.includes("a.get()"))).toBe(true);
    });

    it("names both disjuncts when both evaluate", async () => {
      const [, disjunction] = await errorsFor("control-flow.test.tsx");

      expect(disjunction).toContain("a.get() > 0 = false");
      expect(disjunction).toContain("b.get() < 10 = false");
    });

    it("records only the branch a conditional took", async () => {
      const [, , conditional] = await errorsFor("control-flow.test.tsx");

      expect(conditional).toContain("a.get() > 0 ? b.get() : a.get() = -1");
    });

    it("does not change the arity of a call with a spread argument", async () => {
      // Recording a spread would pass only its first element where the whole
      // of it belongs, turning `allPositive(1, -2, 3)` into `allPositive(1)`
      // — which is true. The assertion has to still fail.
      const { results } = await runTests(fixture("call-shapes.test.tsx"), {
        root: FIXTURES,
      });
      const spread = results.flatMap((file) => file.results)[0]!;

      expect(spread.passed).toBe(false);
      expect(spread.error ?? "").toContain("allPositive(...nums.get())");
    });

    it("records the receiver when a call's arguments say nothing", async () => {
      const [, callback, literalArgument] = await errorsFor(
        "call-shapes.test.tsx",
      );

      // A callback renders as `(...) => {...}`, which says nothing; the value
      // worth reporting is what the method was called on.
      expect(callback).toContain("nums.get() = [1,-2,3]");
      expect(callback).not.toContain("=> {...}");
      expect(literalArgument).toContain("nums.get() = [1,-2,3]");
    });

    it("records operands read through reactive proxies", async () => {
      // The idiom a real pattern test uses: pattern output read directly,
      // where the operand is a lowered array-method call or an optional chain
      // rather than a `cell(...).get()`.
      const [count, name] = await errorsFor("proxy-idiom.test.tsx");

      expect(count).toContain("list.items.filter(() => true).length = 1");
      expect(name).toContain('list.items[0]?.name = "Coffee"');
    });
  },
);
