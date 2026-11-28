import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  inspectLinkedValueCommand,
  inspectMaterializedValueCommand,
  inspectValueCommand,
  readableCellLink,
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

test("a cell's link keeps its scope and gets a path of its own", () => {
  const path = ["value", 0];
  const scoped = readableCellLink({
    getAsNormalizedFullLink: () => ({ ...baseLink, path, scope: "user" }),
  });
  assertEquals(scoped, { ...baseLink, path: ["value", 0], scope: "user" });
  scoped.path.push("appended");
  assertEquals(path, ["value", 0]);

  const unscoped = readableCellLink({
    getAsNormalizedFullLink: () => baseLink,
  });
  assertEquals(unscoped, baseLink);
  assert(!("scope" in unscoped));
});

test("a value that is not a cell has no link", () => {
  for (const value of [undefined, null, "of:session", baseLink]) {
    assertThrows(
      () => readableCellLink(value),
      Error,
      "Raw data source does not expose a Fabric cell",
    );
  }
});

test("a cell whose link lacks an id, a space, or a path has no link", () => {
  const incomplete = [
    undefined,
    { ...baseLink, id: undefined },
    { ...baseLink, space: 7 },
    { ...baseLink, path: "value/details" },
  ];
  for (const link of incomplete) {
    assertThrows(
      () => readableCellLink({ getAsNormalizedFullLink: () => link }),
      Error,
      "Raw data source has an incomplete Fabric cell link",
    );
  }
});
