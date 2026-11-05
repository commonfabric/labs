import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { MIME, URI } from "@commonfabric/memory/interface";
import { watchIdForEntry } from "../src/storage/v2.ts";
import { normalizeSyncSelector } from "../src/storage/v2-watch.ts";

Deno.test("memory v2 watch ids include branch in the stable key", () => {
  const address = {
    id: "of:watch-id-branch" as URI,
    type: "application/json" as MIME,
  };
  const selector: SchemaPathSelector = {
    path: [],
    schema: false,
  };

  assertEquals(
    watchIdForEntry(address, selector, "main"),
    watchIdForEntry(address, selector, "main"),
  );
  assertNotEquals(
    watchIdForEntry(address, selector, ""),
    watchIdForEntry(address, selector, "feature"),
  );
});

Deno.test("memory v2 selector normalization ignores unused definitions", () => {
  const selectorWith = (name: string): SchemaPathSelector => ({
    path: ["value", "title"],
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      $defs: {
        [name]: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    },
  });

  const left = normalizeSyncSelector(selectorWith("UnusedLeft"));
  const right = normalizeSyncSelector(selectorWith("UnusedRight"));

  assertEquals(left.schema, {
    type: "object",
    properties: { title: { type: "string" } },
  });
  assertStrictEquals(left, right);
});

Deno.test("memory v2 selector normalization drops nested definitions and unused root ones", () => {
  const selectorWith = (
    unusedName: string,
    usedType: "string" | "number" = "string",
  ): SchemaPathSelector => ({
    path: ["nested"],
    schema: {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Used",
          $defs: { [unusedName]: { type: "boolean" } },
        },
        plain: {
          type: "object",
          properties: { value: { type: "string" } },
          $defs: { [`${unusedName}Plain`]: { type: "null" } },
        },
      },
      $defs: {
        Used: { type: usedType },
        [`${unusedName}Root`]: { type: "boolean" },
      },
    },
  });

  const left = normalizeSyncSelector(selectorWith("UnusedLeft"));
  const right = normalizeSyncSelector(selectorWith("UnusedRight"));
  const different = normalizeSyncSelector(
    selectorWith("UnusedLeft", "number"),
  );

  assertEquals(left.schema, {
    type: "object",
    properties: {
      nested: { $ref: "#/$defs/Used" },
      plain: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
    $defs: { Used: { type: "string" } },
  });
  assertStrictEquals(left, right);
  assertNotStrictEquals(left, different);
  assertNotEquals(left.schema, different.schema);
});

Deno.test("memory v2 selector normalization ignores inherited definition names", () => {
  const normalized = normalizeSyncSelector({
    path: [],
    schema: {
      $ref: "#/$defs/toString",
      $defs: { Present: { type: "string" } },
    },
  });

  assertEquals(normalized.schema, { $ref: "#/$defs/toString" });
});

//
// The registry of reads a provider replays onto a replacement replica keys its
// entries by the normalized selector's identity. These two tests pin what that
// key relies on: normalization hands back one shared instance per distinct
// registration, so identity separates registrations exactly and the registry
// needs no content hash per `sync()` call to tell them apart.
//

Deno.test("memory v2 selector normalization collapses schemaless reads", () => {
  const first = normalizeSyncSelector({
    path: ["items", "0", "count"],
    schema: false,
  });
  const second = normalizeSyncSelector({
    path: ["items", "1", "count"],
    schema: false,
  });
  const absent = normalizeSyncSelector(undefined);

  // A schemaless read accepts nothing, so its path carries no information and
  // normalization drops it. Every such read on a document is one registration.
  assertStrictEquals(first, second);
  assertStrictEquals(first, absent);
  assertEquals(first.path, []);
  assertEquals(first.schema, false);
});

Deno.test("memory v2 selector normalization separates paths by identity", () => {
  const at = (path: string[]): SchemaPathSelector =>
    normalizeSyncSelector({
      path,
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
      },
    });

  assertStrictEquals(at(["items", "0", "count"]), at(["items", "0", "count"]));
  assertNotStrictEquals(
    at(["items", "0", "count"]),
    at(["items", "1", "count"]),
  );
});
