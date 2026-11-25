import { assert, assertEquals } from "@std/assert";
import {
  inspectLinkedValueCommand,
  inspectMaterializedValueCommand,
  inspectValueCommand,
} from "./provenance.ts";
import { test } from "@commonfabric/test-support/test";

const baseLink = {
  id: "of:session",
  space: "did:key:space",
  path: ["value", "details"],
};

test("space-scoped retrieval uses the default SQLite scope", () => {
  const command = inspectValueCommand({ ...baseLink, scope: "space" });

  assert(!command.includes("inspect overlay"));
  assert(!command.includes("--scope"));
  assert(command.includes(`--path-json '["value","details"]'`));
});

test("retrieval preserves every link path segment", () => {
  const command = inspectValueCommand({
    ...baseLink,
    path: ["a/b", "", 0],
  });
  assert(command.includes(`--path-json '["a/b","","0"]'`));

  const rootCommand = inspectValueCommand({ ...baseLink, path: [] });
  assert(!rootCommand.includes("--path-json"));
});

test("user-scoped retrieval discovers and uses the raw scope key", () => {
  const command = inspectValueCommand({ ...baseLink, scope: "user" });

  assert(command.includes("cf inspect overlay"));
  assert(command.includes("variants[]"));
  assert(command.includes("every candidate"));
  assert(command.includes("latest value"));
  assert(command.includes("user:${encodeURIComponent(PRINCIPAL_DID)}"));
  assertEquals(
    command.match(/--scope 'RAW_SCOPE_KEY'/g)?.length,
    2,
  );
  assert(!command.includes("--scope 'user'"));
});

test("session-scoped linked retrieval uses the raw scope key", () => {
  const command = inspectLinkedValueCommand(
    { ...baseLink, scope: "session" },
    "RECEIPT_REVISION_SEQ",
    "matches the raw page",
  );

  assert(command.includes("cf inspect overlay"));
  assert(
    command.includes(
      "session:${encodeURIComponent(PRINCIPAL_DID)}:${encodeURIComponent(SESSION_ID)}",
    ),
  );
  assert(command.includes("--scope 'RAW_SCOPE_KEY'"));
  assert(!command.includes("--scope 'session'"));
});

test("recursive retrieval distinguishes declared and raw scopes", () => {
  const command = inspectMaterializedValueCommand({
    ...baseLink,
    scope: "space",
  });

  assert(command.includes("containing declared scope"));
  assert(command.includes("variants[]"));
  assert(command.includes("latest"));
  assert(command.includes("--scope 'LINK_SCOPE_KEY'"));
  assert(!command.includes("--scope '<resolved $link.scope>'"));
});
