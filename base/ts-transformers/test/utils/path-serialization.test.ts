import { assertEquals, assertThrows } from "@std/assert";
import { decodePath, encodePath } from "../../src/utils/path-serialization.ts";
import { test } from "@commonfabric/test-support/test";

test("encodePath/decodePath round-trips a path", () => {
  const path = ["users", "0", "name"];
  assertEquals(decodePath(encodePath(path)), path);
  assertEquals(decodePath(encodePath([])), []);
});

test("decodePath rejects an empty encoded path", () => {
  assertThrows(
    () => decodePath(""),
    Error,
    "non-empty encoded path",
  );
});

test("decodePath returns an empty path for a non-string-array encoding", () => {
  assertEquals(decodePath("[1,2]"), []);
  assertEquals(decodePath('{"not":"a path"}'), []);
});
