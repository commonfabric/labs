import { assertEquals, assertThrows } from "@std/assert";
import { decodePath, encodePath } from "../../src/utils/path-serialization.ts";

Deno.test("encodePath/decodePath round-trips a path", () => {
  const path = ["users", "0", "name"];
  assertEquals(decodePath(encodePath(path)), path);
  assertEquals(decodePath(encodePath([])), []);
});

Deno.test("decodePath rejects an empty encoded path", () => {
  assertThrows(
    () => decodePath(""),
    Error,
    "non-empty encoded path",
  );
});

Deno.test("decodePath returns an empty path for a non-string-array encoding", () => {
  assertEquals(decodePath("[1,2]"), []);
  assertEquals(decodePath('{"not":"a path"}'), []);
});
