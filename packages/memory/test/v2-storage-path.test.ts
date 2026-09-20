import { assertEquals, assertThrows } from "@std/assert";
import {
  configuredStorePath,
  resolveSpaceStoreUrl,
} from "../v2/storage-path.ts";

Deno.test("resolveSpaceStoreUrl uses a dedicated engine subdirectory in directory mode", () => {
  const root = new URL("file:///tmp/cf-memory/");
  const subject = "did:key:z6Mkk-test" as const;

  assertEquals(
    resolveSpaceStoreUrl(root, subject).href,
    new URL(`./engine-v3/${encodeURIComponent(subject)}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a sibling engine directory in single-file mode", () => {
  const file = new URL("file:///tmp/cf-memory/space.sqlite");
  const subject = "did:key:z6Mkk-test" as const;

  assertEquals(
    resolveSpaceStoreUrl(file, subject).href,
    new URL(
      `file:///tmp/cf-memory/space.engine-v3/${
        encodeURIComponent(encodeURIComponent(subject))
      }.sqlite`,
    ).href,
  );
});

Deno.test("resolveSpaceStoreUrl rejects traversal-like subjects", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, "../../evil" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, "nested/space" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, ".." as any),
    Error,
    "Invalid memory space identifier for store path",
  );
});

Deno.test("resolveSpaceStoreUrl rejects malformed unicode subjects with validation error", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, "\uD800" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
});

Deno.test("configuredStorePath reads a store location in either form", () => {
  // The form a server's own configuration uses. The path comes back as the URL
  // spells it, so the trailing separator the default carries survives.
  assertEquals(
    configuredStorePath("file:///srv/cache/memory/"),
    "/srv/cache/memory/",
  );
  assertEquals(
    configuredStorePath("file:///srv/cache/memory"),
    "/srv/cache/memory",
  );

  // A percent-escape in the URL is one character of the path it names.
  assertEquals(
    configuredStorePath("file:///srv/a%20b/memory"),
    "/srv/a b/memory",
  );

  // A path written by hand is already a path, and is handed back untouched.
  assertEquals(configuredStorePath("/srv/cache/memory"), "/srv/cache/memory");
  assertEquals(configuredStorePath("/srv/cache/memory/"), "/srv/cache/memory/");
  assertEquals(configuredStorePath("relative/memory/"), "relative/memory/");

  // A location this cannot read as a local path comes back as it stands, for the
  // caller to report as holding nothing rather than to throw over. Two shapes
  // reach that: another scheme, and a `file:` URL that does not parse.
  assertEquals(
    configuredStorePath("https://example.com/store"),
    "https://example.com/store",
  );
  assertEquals(configuredStorePath("file://[/store"), "file://[/store");
  assertEquals(configuredStorePath(""), "");
});
