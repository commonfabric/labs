import { assertEquals, assertThrows } from "@std/assert";
import {
  getArbitraryDIDs,
  wishTargetMayUseHomeSpace,
} from "../src/builtins/wish.ts";

Deno.test("wish target scope can be user before reactive query materializes", () => {
  assertEquals(wishTargetMayUseHomeSpace(undefined, [".", "~"]), true);
});

Deno.test("hashtag wish defaults to home-space search", () => {
  assertEquals(wishTargetMayUseHomeSpace("#googleAuth", undefined), true);
});

Deno.test("current-space-only hashtag wish does not use home space", () => {
  assertEquals(wishTargetMayUseHomeSpace("#googleAuth", ["."]), false);
});

Deno.test("scope keywords name no space to search", () => {
  assertEquals(getArbitraryDIDs(undefined), []);
  assertEquals(getArbitraryDIDs([]), []);
  assertEquals(getArbitraryDIDs(["~", ".", "profile"]), []);
});

Deno.test("a scope entry that is a DID names a space to search", () => {
  const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  assertEquals(getArbitraryDIDs([did]), [did]);
  assertEquals(getArbitraryDIDs(["~", did, "."]), [did]);
  // The rule is the prefix and nothing else, so a method-specific identifier
  // carrying a colon of its own names a space like any other DID.
  assertEquals(getArbitraryDIDs(["did:web:example.com:8080"]), [
    "did:web:example.com:8080",
  ]);
});

Deno.test("a scope entry that is neither a keyword nor a DID is refused", () => {
  // Read as a space id it would search a space nobody named, so it says so.
  assertThrows(
    () => getArbitraryDIDs(["favourites"]),
    Error,
    'Invalid scope "favourites"',
  );
  assertThrows(
    () => getArbitraryDIDs(["~", "DID:key:z6Mk"]),
    Error,
    'Invalid scope "DID:key:z6Mk"',
  );
});
