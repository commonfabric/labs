import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isSlugAddress,
  slugCause,
  slugIdForSpace,
  validateSlug,
} from "../src/index.ts";

const SPACE = "did:key:z6Mk-slug-space";

describe("slug helpers", () => {
  it("distinguishes slug addresses from URI ids", () => {
    expect(isSlugAddress("demo")).toBe(true);
    expect(isSlugAddress("fid1:abc")).toBe(false);
    expect(isSlugAddress("of:fid1:abc")).toBe(false);
    expect(isSlugAddress("of:abc")).toBe(false);
  });

  it("derives stable ids from space and slug", () => {
    expect(slugCause(SPACE, "demo")).toEqual({ space: SPACE, slug: "demo" });
    expect(slugIdForSpace(SPACE, "demo")).toBe(slugIdForSpace(SPACE, "demo"));
    expect(slugIdForSpace(SPACE, "demo")).not.toBe(
      slugIdForSpace(SPACE, "other"),
    );
  });

  it("validates slug syntax", () => {
    expect(validateSlug("demo")).toBe("demo");
    expect(validateSlug("project-notes-2026")).toBe("project-notes-2026");
    expect(() => validateSlug("")).toThrow(/Slug must not be empty/);
    expect(() => validateSlug("has/slash")).toThrow(/must not contain/);
    expect(() => validateSlug("fid1:abc")).toThrow(/must not contain ':'/);
    expect(() => validateSlug("of:fid1:abc")).toThrow(/must not contain ':'/);
    expect(() => validateSlug("Project")).toThrow(/lowercase/);
    expect(() => validateSlug("has_underscore")).toThrow(/lowercase/);
    expect(() => validateSlug("-leading")).toThrow(/lowercase/);
    expect(() => validateSlug("trailing-")).toThrow(/lowercase/);
    expect(() => validateSlug("two--hyphens")).toThrow(/lowercase/);
    expect(() => validateSlug("x".repeat(81))).toThrow(/at most 80/);
  });
});
