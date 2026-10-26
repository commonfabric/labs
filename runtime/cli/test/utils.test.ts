import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { MemorySpace } from "@commonfabric/runner";
import { absPath, throwOnSpaceAuthorizationError } from "../lib/utils.ts";

const SPACE = "did:key:z6Mk-cli-utils-authz-space" as MemorySpace;

Deno.test("absPath resolves a relative path against the supplied directory", () => {
  assertEquals(absPath("nested/file.ts", "/work"), "/work/nested/file.ts");
});

Deno.test("throwOnSpaceAuthorizationError rethrows the recorded denial", () => {
  const denial = Object.assign(new Error("Principal lacks READ on space"), {
    name: "AuthorizationError",
  });
  let asked: MemorySpace | undefined;
  const error = assertThrows(
    () =>
      throwOnSpaceAuthorizationError({
        authorizationError: (space) => {
          asked = space;
          return denial;
        },
      }, SPACE),
    Error,
    "lacks READ",
  );
  // The real error object is rethrown unchanged, scoped to the queried space.
  assertStrictEquals(error, denial);
  assertEquals((error as Error).name, "AuthorizationError");
  assertEquals(asked, SPACE);
});

Deno.test("throwOnSpaceAuthorizationError is a no-op when the space is authorized", () => {
  let asked: MemorySpace | undefined;
  throwOnSpaceAuthorizationError({
    authorizationError: (space) => {
      asked = space;
      return undefined;
    },
  }, SPACE);
  assertEquals(asked, SPACE);
});

Deno.test("throwOnSpaceAuthorizationError is a no-op when the status is unavailable", () => {
  // An emulated or older storage manager may not expose the per-space status;
  // the optional call resolves to undefined and nothing is thrown.
  throwOnSpaceAuthorizationError({}, SPACE);
});
