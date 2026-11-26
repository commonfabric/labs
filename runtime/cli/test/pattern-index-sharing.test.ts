import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { sharingChange, sharingLines } from "../commands/pattern-index.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SETTINGS = {
  enabled: true,
  selfBuilt: true,
  receivesAnonymous: true,
  updatedAt: null,
};

describe("pattern-index sharing", () => {
  describe("sharingChange()", () => {
    it("asks for no change when no switch is named, which reads the setting", () => {
      expect(sharingChange(undefined, undefined)).toEqual({});
    });

    it("sends only the switches named", () => {
      expect(sharingChange("off", undefined)).toEqual({ enabled: false });
      expect(sharingChange(undefined, "off")).toEqual({ selfBuilt: false });
      expect(sharingChange("on", "on")).toEqual({
        enabled: true,
        selfBuilt: true,
      });
    });

    it("throws for a value other than on or off", () => {
      expect(() => sharingChange("yes", undefined)).toThrow(ValidationError);
      expect(() => sharingChange(undefined, "true")).toThrow(ValidationError);
    });
  });

  describe("sharingLines()", () => {
    it("says what each switch means when both are on", () => {
      const lines = sharingLines(SETTINGS);

      expect(lines[0]).toMatch(/^Sharing: on\./);
      expect(lines[1]).toContain("shared the same way");
    });

    it("says what you build stays private when only --self-built is off", () => {
      const lines = sharingLines({ ...SETTINGS, selfBuilt: false });

      expect(lines[1]).toContain(
        "kept private unless you run cf pattern share",
      );
    });

    it("says search shows only named patterns, and opening by id still works, when sharing is off", () => {
      const lines = sharingLines({
        ...SETTINGS,
        enabled: false,
        receivesAnonymous: false,
      });

      expect(lines[0]).toContain("only patterns published under a name");
      expect(lines[0]).toContain("open by its id still works");
      expect(lines.join("\n")).not.toContain("build yourself");
    });
  });
});
