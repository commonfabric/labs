/**
 * The scenarios `both-paths.ts` runs: the patterns of
 * `patterns/dev/test/cfc-trusted-write/` and
 * `patterns/dev/test/writer-policy/` with the steps of their tests, and the
 * fixtures of `compare/fixtures/` that declare a write policy.
 */
import type { Scenario } from "./both-paths.ts";

const PIN = { surface: "PinnedNoteSurface", action: "PinNote" };

export const SCENARIOS: Scenario[] = [
  {
    // The steps of `patterns/dev/test/cfc-trusted-write/main.test.tsx`.
    name: "cfc-trusted-write/main",
    pieces: [
      {
        name: "note",
        module: "patterns/dev/test/cfc-trusted-write/main.tsx",
        as: "alice",
      },
      {
        name: "other",
        module: "patterns/dev/test/cfc-trusted-write/other-writer.tsx",
        argument: ({ note }) => ({ pinned: note.key("pinned" as never) }),
        as: "alice",
      },
    ],
    steps: [
      { stream: "pin", trustedUi: PIN, as: "alice" },
      { piece: "other", stream: "overwrite", as: "alice" },
      { stream: "overwrite", as: "alice" },
      { stream: "repin", trustedUi: PIN, as: "alice" },
      { stream: "pin", as: "alice" },
      { stream: "pin", trustedUi: PIN },
    ],
  },
  {
    // The steps of `patterns/dev/test/cfc-trusted-write/frozen.test.tsx`.
    name: "cfc-trusted-write/frozen",
    pieces: [{
      name: "subject",
      module: "patterns/dev/test/cfc-trusted-write/frozen.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "freeze", as: "alice" },
      { stream: "rewriteDigest", as: "alice" },
      { stream: "replaceWithText", as: "alice" },
      { stream: "replaceTags", as: "alice" },
    ],
  },
  {
    // The steps of `patterns/dev/test/writer-policy/main.test.tsx`, and
    // those of `multi-user.test.tsx` with its two principals and its
    // forging handlers, which `fixtures/room-forger.tsx` holds.
    name: "writer-policy/main",
    pieces: [
      {
        name: "room",
        module: "patterns/dev/test/writer-policy/main.tsx",
        as: "alice",
      },
      {
        name: "forger",
        module: "base/pattern-compiler/compare/fixtures/room-forger.tsx",
        argument: ({ room }) => ({
          entries: room.key("entries" as never),
          frozen: room.key("frozen" as never),
        }),
        as: "bob",
      },
    ],
    steps: [
      { stream: "submit", event: { seat: 1 }, as: "alice" },
      { stream: "submit", event: { seat: 2 }, as: "bob" },
      { stream: "freeze", event: { digest: "first" }, as: "bob" },
      { stream: "freeze", event: { digest: "second" }, as: "alice" },
      { piece: "forger", stream: "forgeEntry", as: "bob" },
      { piece: "forger", stream: "forgeFrozen", as: "bob" },
      { stream: "submit", event: { seat: 3 } },
    ],
  },
  {
    // The forging handlers before any handler of the room wrote: the
    // claims of the argument type are stored when the room starts.
    name: "writer-policy/main forged first",
    pieces: [
      {
        name: "room",
        module: "patterns/dev/test/writer-policy/main.tsx",
        as: "alice",
      },
      {
        name: "forger",
        module: "base/pattern-compiler/compare/fixtures/room-forger.tsx",
        argument: ({ room }) => ({
          entries: room.key("entries" as never),
          frozen: room.key("frozen" as never),
        }),
        as: "bob",
      },
    ],
    steps: [
      { piece: "forger", stream: "forgeEntry", as: "bob" },
      { piece: "forger", stream: "forgeFrozen", as: "bob" },
    ],
  },
  {
    // The room started with a value for a field its argument type names a
    // writer for: the value is the write of whoever starts the room.
    name: "writer-policy/main with a protected field supplied",
    pieces: [{
      name: "room",
      module: "patterns/dev/test/writer-policy/main.tsx",
      argument: () => ({ frozen: { seat: 7, digest: "supplied" } }),
      as: "alice",
    }],
    steps: [],
  },
  {
    // An argument field under a UI contract with a declared default, which
    // a handler of an instance the body makes writes: the write of the
    // default itself with no gesture, then the same as a gesture.
    name: "cfc-authorized-save/main",
    pieces: [{
      name: "save",
      module: "patterns/examples/cfc-authorized-save/main.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "save", as: "alice" },
      {
        stream: "save",
        trustedUi: {
          surface: "TrustedSaveSurface",
          action: "TrustedSaveTitle",
        },
        as: "bob",
      },
    ],
  },
  {
    name: "fixtures/made-write-policy",
    pieces: [{
      name: "outer",
      module: "base/pattern-compiler/compare/fixtures/made-write-policy.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "forge", event: { text: "forged first" }, as: "bob" },
      { stream: "record", event: { text: "recorded" }, as: "alice" },
      { stream: "forge", event: { text: "forged" }, as: "bob" },
    ],
  },
  {
    name: "fixtures/write-policy-unnamed",
    pieces: [{
      name: "notes",
      module: "base/pattern-compiler/compare/fixtures/write-policy-unnamed.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "record", event: { text: "recorded" }, as: "alice" },
      { stream: "stamp", event: { text: "stamped" }, as: "alice" },
      { stream: "plain", event: { text: "plain" }, as: "alice" },
      { stream: "act", as: "alice" },
      { stream: "stamp", event: { text: "mark" }, as: "alice" },
    ],
  },
  {
    name: "fixtures/write-policy",
    pieces: [{
      name: "notes",
      module: "base/pattern-compiler/compare/fixtures/write-policy.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "record", event: { text: "written" }, as: "alice" },
      { stream: "overwrite", event: { text: "overwritten" }, as: "alice" },
    ],
  },
  {
    name: "fixtures/principal-integrity",
    pieces: [{
      name: "signed",
      module: "base/pattern-compiler/compare/fixtures/principal-integrity.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "sign", event: { text: "from alice" }, as: "alice" },
      { stream: "sign", event: { text: "from bob" }, as: "bob" },
      { stream: "sign", event: { text: "from no one" } },
    ],
  },
  {
    name: "fixtures/authored",
    pieces: [{
      name: "notes",
      module: "base/pattern-compiler/compare/fixtures/authored.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "write", event: { text: "first" }, as: "alice" },
      { stream: "write", event: { text: "second" }, as: "bob" },
      { stream: "write", event: { text: "third" } },
    ],
  },
  {
    name: "fixtures/authored-by-writer",
    pieces: [{
      name: "notes",
      module: "base/pattern-compiler/compare/fixtures/authored-by-writer.tsx",
      as: "alice",
    }],
    steps: [
      { stream: "write", event: { text: "first" }, as: "alice" },
      { stream: "write", event: { text: "second" }, as: "bob" },
      { stream: "forge", event: { text: "forged" }, as: "bob" },
      { stream: "write", event: { text: "third" } },
    ],
  },
  {
    // The start alone, by no one: a first value whose type adds integrity
    // of the current principal.
    name: "fixtures/principal-integrity started by no one",
    pieces: [{
      name: "signed",
      module: "base/pattern-compiler/compare/fixtures/principal-integrity.tsx",
    }],
    // The step is not sent on either path: the piece does not exist.
    steps: [{ stream: "sign", event: { text: "from alice" }, as: "alice" }],
  },
  {
    // Three items, each a document whose title carries the clause its
    // type declares, and a pattern over the array of references to them,
    // whose type of an item declares none, that reads each title through
    // the elements `get()` gives and through the handle by position once
    // `show` is sent. The confidentiality stored at each member is
    // compared: a clause at an output came from the items' documents.
    name: "fixtures/get-iterated",
    labels: true,
    pieces: [
      ...["first", "second", "third"].map((name) => ({
        name,
        module: "base/pattern-compiler/compare/fixtures/labeled-item.tsx",
        as: "alice",
      })),
      {
        name: "titles",
        module: "base/pattern-compiler/compare/fixtures/get-iterated.tsx",
        argument: ({ first, second, third }) => ({
          items: [first, second, third],
        }),
        as: "alice",
      },
    ],
    steps: [
      ...["first", "second", "third"].map((piece) => ({
        piece,
        stream: "name",
        event: { title: `the ${piece}` },
        as: "alice",
      })),
      { piece: "titles", stream: "show", event: {}, as: "alice" },
    ],
  },
  {
    // The same, with the items held by a list piece whose `items` the
    // pattern is given: the array is reached through a link.
    name: "fixtures/get-iterated through a list",
    labels: true,
    pieces: [
      ...["first", "second", "third"].map((name) => ({
        name,
        module: "base/pattern-compiler/compare/fixtures/labeled-item-copy.tsx",
        as: "alice",
      })),
      {
        name: "list",
        module: "base/pattern-compiler/compare/fixtures/labeled-list.tsx",
        argument: ({ first, second, third }) => ({
          items: [first, second, third],
        }),
        as: "alice",
      },
      {
        name: "titles",
        module: "base/pattern-compiler/compare/fixtures/get-iterated.tsx",
        argument: ({ list }) => ({ items: list.key("items" as never) }),
        as: "alice",
      },
    ],
    steps: [
      ...["first", "second", "third"].map((piece) => ({
        piece,
        stream: "name",
        event: { title: `the ${piece}` },
        as: "alice",
      })),
      { piece: "titles", stream: "show", event: {}, as: "alice" },
    ],
  },
  {
    name: "fixtures/principal-derived",
    pieces: [{
      name: "derived",
      module: "base/pattern-compiler/compare/fixtures/principal-derived.tsx",
      as: "alice",
    }],
    steps: [],
  },
];
