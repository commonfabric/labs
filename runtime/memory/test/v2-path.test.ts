import { assert, assertEquals } from "@std/assert";
import {
  encodePointer,
  parentPath,
  parsePointer,
  pathsOverlap,
} from "../v2/path.ts";

Deno.test("memory v2 path helpers round-trip JSON pointers", () => {
  const path = ["value", "nested/key", "tilde~value", "0"];
  const encoded = encodePointer(path);

  assertEquals(encoded, "/value/nested~1key/tilde~0value/0");
  assertEquals(parsePointer(encoded), path);
});

Deno.test("memory v2 path helpers compute parents and overlap", () => {
  assertEquals(parentPath([]), []);
  assertEquals(parentPath(["value", "items", "0"]), ["value", "items"]);
  assert(pathsOverlap(["value"], ["value", "items", "0"]));
  assert(pathsOverlap(["value", "items"], ["value", "items"]));
  assert(!pathsOverlap(["value", "items", "0"], ["value", "items", "1"]));
});
