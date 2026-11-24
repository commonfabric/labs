import { assertEquals } from "@std/assert";
import {
  decodeFuseComponent,
  decodeFusePathSegments,
  encodeFuseComponent,
  encodeFusePathSegments,
} from "./path-codec.ts";

Deno.test("path codec leaves ordinary components stable", () => {
  assertEquals(encodeFuseComponent("title"), "title");
  assertEquals(encodeFuseComponent("item-01"), "item-01");
  assertEquals(decodeFuseComponent("item-01"), "item-01");
});

Deno.test("path codec escapes unsafe and macOS-special components", () => {
  assertEquals(encodeFuseComponent("has/slash"), "has%2Fslash");
  assertEquals(encodeFuseComponent("of:entity"), "of%3Aentity");
  assertEquals(encodeFuseComponent("literal%"), "literal%25");
  assertEquals(encodeFuseComponent(".hidden"), "%2Ehidden");
  assertEquals(encodeFuseComponent("."), "%2E");
  assertEquals(encodeFuseComponent(".."), "%2E%2E");
  assertEquals(
    encodeFuseComponent("value.json", { reserveJsonSuffix: true }),
    "value%2Ejson",
  );
});

Deno.test("path codec decodes escaped components and paths", () => {
  assertEquals(decodeFuseComponent("has%2Fslash"), "has/slash");
  assertEquals(decodeFuseComponent("of%3Aentity"), "of:entity");
  assertEquals(decodeFuseComponent("literal%25"), "literal%");
  assertEquals(decodeFuseComponent("%2Ehidden"), ".hidden");
  assertEquals(
    decodeFusePathSegments(["src", "has%3Acolon.tsx"]),
    ["src", "has:colon.tsx"],
  );
  assertEquals(
    encodeFusePathSegments(["src", "has:colon.tsx"]),
    ["src", "has%3Acolon.tsx"],
  );
});
