import { expect } from "@std/expect";
import { PHASE_MARKERS, phaseOf } from "./ci-step-phases.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("ci-step-phases", () => {
  describe("phaseOf", () => {
    it("reads the phase from the marker a step name starts with", () => {
      expect(phaseOf("📥 Checkout repository")).toBe("setup");
      expect(phaseOf("🧪 Run parallel workspace tests")).toBe("work");
      expect(phaseOf("📤 Upload coverage report")).toBe("shutdown");
    });

    it("reads a marker whether or not it carries a variation selector", () => {
      expect(phaseOf("🏗️ Build toolshed binary")).toBe("work");
      expect(phaseOf("🏗 Build toolshed binary")).toBe("work");
    });

    it("gives every marker exactly one phase", () => {
      const phases = new Map<string, string>();
      for (const [marker, phase] of PHASE_MARKERS) {
        expect(phases.get(marker) ?? phase).toBe(phase);
        phases.set(marker, phase);
      }
      expect(phases.size).toBe(PHASE_MARKERS.length);
    });

    it("counts the runner's own set-up steps as setup", () => {
      expect(phaseOf("Set up job")).toBe("setup");
      expect(phaseOf("Set up runner")).toBe("setup");
    });

    it("counts the runner's own closing steps as shutdown", () => {
      expect(phaseOf("Complete job")).toBe("shutdown");
      expect(phaseOf("Complete runner")).toBe("shutdown");
      expect(phaseOf("Post 📥 Checkout repository")).toBe("shutdown");
    });

    it("prefers a leading marker to the wording after it", () => {
      // "Post " decides a step the runner injected, and a step of ours that
      // begins with a marker is read by that marker instead.
      expect(phaseOf("💬 Post coverage comment")).toBe("work");
    });

    it("returns other for a name carrying no marker it knows", () => {
      expect(phaseOf("Build and push dashboard image")).toBe("other");
      expect(phaseOf("🦖 Feed the wrong dinosaur")).toBe("other");
      expect(phaseOf("")).toBe("other");
    });

    it("reads a marker through the whitespace around a name", () => {
      expect(phaseOf("  🧹 Lint codebase  ")).toBe("work");
    });
  });
});
