import { expect } from "@std/expect";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { decode } from "@commonfabric/utils/encoding";
import {
  listPiecesFromCommand,
  piece,
  renderPieceSummaries,
  searchPiecesFromCommand,
} from "../commands/piece.ts";

const referenceFor = (id: string) =>
  createLLMFriendlyLink({
    space: "did:key:z6MkjchhfUsD6JcKaEBBHXC8mYtTBhQtTBFbGHqCRJRaqF6J",
    id: id as `${string}:${string}`,
    scope: "space",
    path: [],
  });

function captureStdout(fn: () => void): string {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

Deno.test("piece summaries render human and JSON output", () => {
  const reference = createLLMFriendlyLink({
    space: "did:key:z6MkjchhfUsD6JcKaEBBHXC8mYtTBhQtTBFbGHqCRJRaqF6J",
    id: "of:notes",
    scope: "user",
    path: ["embedded"],
  });
  const identity = "R".repeat(43);
  const patternRef = {
    identity,
    symbol: "default",
    source: {
      ref: `cf:pattern:${identity}`,
      repository: "https://github.com/commonfabric/labs",
      entry: "/packages/patterns/notes.tsx",
    },
  };

  const json = captureStdout(() =>
    renderPieceSummaries([
      { id: "of:notes", reference, name: "Notes", patternRef },
      { id: "of:unnamed", reference: referenceFor("of:unnamed") },
    ], true)
  );
  expect(JSON.parse(json)).toEqual([
    { id: "of:notes", reference, name: "Notes", patternRef },
    {
      id: "of:unnamed",
      reference: referenceFor("of:unnamed"),
      name: null,
      patternRef: null,
    },
  ]);

  const table = captureStdout(() =>
    renderPieceSummaries([
      { id: "of:notes", reference, name: "Notes", patternRef },
      {
        id: "of:unreadable",
        reference: referenceFor("of:unreadable"),
        error: "stored data is unavailable",
      },
      { id: "of:unnamed", reference: referenceFor("of:unnamed") },
    ], false)
  );
  expect(table).toContain("ID");
  expect(table).toContain("REFERENCE");
  expect(table).toContain(reference);
  expect(table).toContain("of:notes");
  expect(table).toContain("Notes");
  expect(table).toContain(
    "https://github.com/commonfabric/labs#/packages/patterns/notes.tsx",
  );
  expect(table).toContain("<error: stored data is unavailable>");
  expect(table).toContain("<unnamed>");
  expect(table).toContain("<unknown>");

  expect(captureStdout(() => renderPieceSummaries([], false))).toBe("");
});

Deno.test("piece registers its list and search command handlers", () => {
  const actionHandler = (name: string): unknown =>
    (piece.getCommand(name) as unknown as
      | { actionHandler?: unknown }
      | undefined)?.actionHandler;

  expect(actionHandler("ls")).toBe(listPiecesFromCommand);
  expect(actionHandler("search")).toBe(
    searchPiecesFromCommand,
  );
});

Deno.test("piece search command parses options and renders matches", async () => {
  const matches = [{
    id: "of:notes",
    reference: referenceFor("of:notes"),
    name: "Notes",
  }];
  let searched:
    | {
      config: {
        apiUrl: string;
        space: string;
        identity: string;
        jsonOutput?: boolean;
      };
      query: string;
    }
    | undefined;
  let rendered:
    | {
      pieces: Parameters<typeof renderPieceSummaries>[0];
      json: boolean;
    }
    | undefined;

  await searchPiecesFromCommand(
    {
      apiUrl: "https://cf.dev/",
      space: "common-knowledge",
      identity: "/tmp/estuary.key",
      json: true,
    },
    "Hixie",
    {
      searchPieces: (config, query) => {
        searched = { config, query };
        return Promise.resolve(matches);
      },
      renderPieceSummaries: (pieces, json) => {
        rendered = { pieces, json };
      },
    },
  );

  expect(searched).toEqual({
    config: {
      apiUrl: "https://cf.dev",
      space: "common-knowledge",
      identity: "/tmp/estuary.key",
      jsonOutput: true,
    },
    query: "Hixie",
  });
  expect(rendered).toEqual({ pieces: matches, json: true });

  let humanConfig:
    | {
      apiUrl: string;
      space: string;
      identity: string;
      jsonOutput?: boolean;
    }
    | undefined;
  await searchPiecesFromCommand(
    {
      apiUrl: "https://cf.dev/",
      space: "common-knowledge",
      identity: "/tmp/estuary.key",
    },
    "Hixie",
    {
      searchPieces: (config) => {
        humanConfig = config;
        return Promise.resolve(matches);
      },
      renderPieceSummaries: () => {},
    },
  );
  expect(humanConfig).toEqual({
    apiUrl: "https://cf.dev",
    space: "common-knowledge",
    identity: "/tmp/estuary.key",
  });
});

Deno.test("piece list command parses options and renders pieces", async () => {
  const pieces = [{
    id: "of:tasks",
    reference: referenceFor("of:tasks"),
    name: "Tasks",
  }];
  let listedConfig: {
    apiUrl: string;
    space: string;
    identity: string;
  } | undefined;
  let rendered:
    | {
      pieces: Parameters<typeof renderPieceSummaries>[0];
      json: boolean;
    }
    | undefined;

  await listPiecesFromCommand(
    {
      url: "https://cf.dev/common-knowledge",
      identity: "/tmp/estuary.key",
    },
    {
      listPieces: (config) => {
        listedConfig = config;
        return Promise.resolve(pieces);
      },
      renderPieceSummaries: (summaries, json) => {
        rendered = { pieces: summaries, json };
      },
    },
  );

  expect(listedConfig).toEqual({
    apiUrl: "https://cf.dev",
    space: "common-knowledge",
    identity: "/tmp/estuary.key",
  });
  expect(rendered).toEqual({ pieces, json: false });
});
