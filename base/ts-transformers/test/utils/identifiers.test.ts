import { assertEquals } from "@std/assert";

import {
  isSafeIdentifierText,
  sanitizeIdentifierCandidate,
} from "../../src/utils/identifiers.ts";
import { test } from "@commonfabric/test-support/test";

test("sanitizeIdentifierCandidate normalizes invalid fallback prefixes", () => {
  const result = sanitizeIdentifierCandidate("", { fallback: "-ref" });
  assertEquals(result, "_ref");
});

test("isSafeIdentifierText recognizes astral plane characters", () => {
  assertEquals(isSafeIdentifierText("𠮷"), true);
});
