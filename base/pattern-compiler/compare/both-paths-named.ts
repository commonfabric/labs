/**
 * The named scenarios of the two-principal gate (`both-paths.ts`): one for
 * each construct that reads a value of a scope narrower than the space
 * (section 2 of `docs/plans/compiled-pattern-language-ship-criteria.md`),
 * the case of the owner's concept Z100, and the real Topics board.
 *
 * Text a principal's own scope holds is listed in `scoped`, so that the
 * derived check (b) looks for it where the other principal reads. A step
 * whose handler writes such text into a document of the space on purpose
 * says so in `shares`.
 */
import { type GateScenario, PROFILE_NAMES } from "./both-paths-serving.ts";

const FIXTURES = "base/pattern-compiler/compare/fixtures";

const NICKNAMES = {
  alice: "Nickname of alice, 4410",
  bob: "Nickname of bob, 3307",
};

/** A step by `as` that writes its nickname, a value of the scope `user`. */
const nickname = (as: "alice" | "bob") => ({
  write: { path: ["nickname"], value: NICKNAMES[as] },
  as,
});

export const NAMED_SCENARIOS: GateScenario[] = [
  {
    // A pattern that reads `wish("#profile")` in its view.
    name: "named/profile in a view",
    pieces: [{
      name: "view",
      module: `${FIXTURES}/gate-profile-view.tsx`,
      as: "alice",
    }],
    steps: [],
  },
  {
    // A cell of the scope `user` and one of the scope `session` that a
    // client writes and a handler reads; the handler appends both to a
    // list of the space, which shares them.
    name: "named/per-user and per-session cells",
    pieces: [{
      name: "draft",
      module: `${FIXTURES}/session-draft.tsx`,
      argument: { notes: [] },
      as: "alice",
    }],
    scoped: {
      alice: [NICKNAMES.alice, "Draft of alice, 9921"],
      bob: [NICKNAMES.bob, "Draft of bob, 5518"],
    },
    steps: [
      nickname("alice"),
      {
        write: { path: ["draft"], value: "Draft of alice, 9921" },
        as: "alice",
      },
      nickname("bob"),
      { write: { path: ["draft"], value: "Draft of bob, 5518" }, as: "bob" },
      {
        stream: "submit",
        as: "alice",
        shares: [NICKNAMES.alice, "Draft of alice, 9921"],
      },
    ],
  },
  {
    // A `map` over an array of references whose body reads a value of the
    // scope `user`.
    name: "named/map over an array of references",
    pieces: [{
      name: "rows",
      module: `${FIXTURES}/gate-map-references.tsx`,
      argument: ({ make }) => ({
        items: [make({ title: "first" }), make({ title: "second" })],
      }),
      as: "alice",
    }],
    scoped: { alice: [NICKNAMES.alice], bob: [NICKNAMES.bob] },
    steps: [nickname("alice"), nickname("bob")],
  },
  {
    // A `map` over an array of plain values in place whose body reads a
    // value of the scope `user`.
    name: "named/map over an array of plain values in place",
    pieces: [{
      name: "rows",
      module: `${FIXTURES}/gate-map-in-place.tsx`,
      argument: { titles: ["first", "second"] },
      as: "alice",
    }],
    scoped: { alice: [NICKNAMES.alice], bob: [NICKNAMES.bob] },
    steps: [nickname("alice"), nickname("bob")],
  },
  {
    // A `map` over the result of a `filter` over an array of references,
    // whose body reads a value of the scope `user`.
    name: "named/map over the result of a filter",
    pieces: [{
      name: "rows",
      module: `${FIXTURES}/gate-map-filter.tsx`,
      argument: ({ make }) => ({
        items: [
          make({ title: "first", hidden: false }),
          make({ title: "second", hidden: true }),
          make({ title: "third", hidden: false }),
        ],
      }),
      as: "alice",
    }],
    scoped: { alice: [NICKNAMES.alice], bob: [NICKNAMES.bob] },
    steps: [nickname("alice"), nickname("bob")],
  },
  {
    // A collection of a scope key inside a row of another collection
    // (P474): each row of a `map` over an array of references holds a `map`
    // over marks that hold the acting user's nickname, which a handler of
    // the acting principal writes.
    name: "named/scoped collection in a row",
    pieces: [{
      name: "rows",
      module: `${FIXTURES}/scoped-nested-rows.tsx`,
      argument: ({ make }) => ({
        items: [make({ title: "first" }), make({ title: "second" })],
      }),
      as: "alice",
    }],
    scoped: { alice: [NICKNAMES.alice], bob: [NICKNAMES.bob] },
    steps: [
      { stream: "call", event: { name: NICKNAMES.alice }, as: "alice" },
      { stream: "call", event: { name: NICKNAMES.bob }, as: "bob" },
      { stream: "add", event: { title: "third" }, as: "alice" },
    ],
  },
  {
    // An instance a handler makes whose body reads `wish("#profile")`, as a
    // Topics topic does, and a handler bound to a stream of such an
    // instance, whose marker has no element key (P476).
    name: "named/instance a handler makes",
    pieces: [{
      name: "cards",
      module: `${FIXTURES}/gate-made-profile.tsx`,
      argument: { cards: [] },
      as: "alice",
    }],
    steps: [
      { stream: "make", event: { title: "Card of alice" }, as: "alice" },
      { stream: ["cards", 0, "touch"], as: "bob" },
      { stream: ["cards", 0, "touch"], as: "alice" },
    ],
  },
  {
    // Z100: a payload a user typed, sent by alice and consumed by a handler
    // that writes it into a list of the space. What each path stores for
    // the value is compared as any label is; the scenario accepts nothing.
    name: "named/typed event payload (Z100)",
    pieces: [{
      name: "notes",
      module: `${FIXTURES}/gate-typed-event.tsx`,
      argument: { notes: [] },
      as: "alice",
    }],
    steps: [
      { stream: "post", event: { text: "Typed by alice" }, as: "alice" },
      { stream: "post", event: { text: "Typed by bob" }, as: "bob" },
    ],
  },
  {
    // The real Topics board: alice creates a topic from the composer as a
    // browser does (the draft of the scope `session`, then `submitTopic`,
    // which reads her profile), both read it, bob edits its title, and
    // alice mentions it from a second topic.
    name: "named/Topics board",
    pieces: [{
      name: "board",
      module: "patterns/apps/topics/main.tsx",
      as: "alice",
    }],
    scoped: {
      alice: ["Topic draft of alice, 6620"],
      bob: [],
    },
    steps: [
      {
        write: { path: ["newTitle"], value: "Topic draft of alice, 6620" },
        as: "alice",
      },
      {
        stream: "submitTopic",
        as: "alice",
        // The handler files the topic under alice's profile name, which the
        // board and the topic show every member.
        shares: ["Topic draft of alice, 6620", PROFILE_NAMES.A],
      },
      {
        stream: ["topics", 0, "setTitle"],
        event: { title: "Renamed by bob", agentName: "bob" },
        as: "bob",
      },
      {
        write: { path: ["newTitle"], value: "Second topic of alice" },
        as: "alice",
      },
      { stream: "submitTopic", as: "alice" },
      {
        stream: ["topics", 1, "mention"],
        event: ({ at }) => ({ topic: at("board", ["topics", 0]) }),
        as: "alice",
      },
    ],
  },
];
