// Unit coverage for the unified closure-capture diagnostic message. Both
// construction-time throw sites (builder/node-utils.ts and builder/pattern.ts)
// route through `closureCaptureErrorMessage`, so this pins the shared wording:
// it names the offending cell, surfaces a source location when one is
// available, and recommends the actual escape hatches (mapWithPattern /
// computed).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { closureCaptureErrorMessage } from "../src/builder/closure-capture-diagnostic.ts";

describe("closureCaptureErrorMessage()", () => {
  it("describes the captured cell's name, path, and scope", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: {
        name: "setAssign",
        path: ["params", "setAssign"],
        scope: "space",
      },
    });
    expect(message).toContain("'setAssign'");
    expect(message).toContain("at path [params, setAssign]");
    expect(message).toContain("space-scoped");
    expect(message).toContain("captured by a closure");
  });

  it("includes a source location when one is resolved", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: { name: "x" },
      sourceLocation: "/main.tsx:23:7",
    });
    expect(message).toContain("at /main.tsx:23:7");
  });

  it("omits the location line when none is available", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: { name: "x" },
      sourceLocation: null,
    });
    expect(message).not.toContain("\n  at ");
  });

  it("names the callback by its body preview when no location resolved", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: { name: "x" },
      sourceLocation: null,
      implementationPreview: "(item) => item.total + subtotal.get()",
    });
    expect(message).toContain("in (item) => item.total + subtotal.get()");
  });

  it("prefers a resolved location over the body preview", () => {
    const message = closureCaptureErrorMessage({
      sourceLocation: "/main.tsx:23:7",
      implementationPreview: "(item) => item.total",
    });
    expect(message).toContain("at /main.tsx:23:7");
    expect(message).not.toContain("\n  in ");
  });

  it("collapses and truncates a long body preview to one line", () => {
    const message = closureCaptureErrorMessage({
      implementationPreview: `(item) => {\n  return ${"y".repeat(80)};\n}`,
    });
    const line = message.split("\n").find((l) => l.startsWith("  in "))!;
    expect(line.length).toBeLessThanOrEqual(70);
    expect(line).toContain("\u2026");
  });

  it("recommends the real escape hatches (mapWithPattern / computed)", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("mapWithPattern");
    expect(message).toContain("computed()");
    // The misleading "wrap the access in a derive" recipe is gone.
    expect(message).not.toContain("derive that passes the variable through");
  });

  it("degrades gracefully with no cell info", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("Reactive cell from an outer scope");
  });
});
