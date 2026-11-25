// Poker sanitization demo — idiomatic CFC, reducer + relabel-policy model.
//
// Companion to docs/proposals/cfc-game-sanitization-memo.md.
//
// CFC access is BINARY per (value, principal); "graded reveal" is NOT a new label dimension.
// "Bob sees the COUNT of Alice's hand, not the cards" is a REDUCER (a trusted transform,
// count = hand.length) whose output is its own Confidential cell, RELABELLED to a lower audience
// by a policy keyed to the reducer's identity. This demo shows three things, each labelled:
//
//   ENFORCED (real, idiomatic CFC):
//     - Each hand is a Confidential<Card[], [PokerHoleCards]> cell; a cf-cfc-render-boundary with
//       maxConfidentiality={[]} genuinely blocks it (the one mechanism the runtime enforces).
//     - The Showdown is a trusted-action declassification (the "identity reducer" relabel):
//       data-ui-* + TrustedActionWrite; folded hands are never declassified.
//     - The COUNT is its own Confidential cell behind its OWN boundary, released to the table by
//       its own trusted action — demonstrating "the reduced value is its own binary-access cell".
//     - cf-cfc-label shows the live labels.
//
//   SIMULATED (no runtime primitive exists; labelled as such in-UI):
//     - The reducer MINTING a `ReducedBy{count}` integrity atom and the relabel being GATED on it
//       (we drive the relabel from a trusted action instead).
//     - Label-gated PER-RECIPIENT SYNC (a planned memory-engine step): delivering Alice the cards
//       but Bob the count. Assumed here — one trusted host shows both on one screen.
//
//   OUT OF SCOPE: recombination (multiple reducers on one secret, §14.3.2) and unlinkability
//   (shuffles). Stated in-UI.

import {
  Cell,
  computed,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";

// ===========================================================================
// Domain types + confidential cells
// ===========================================================================

type Suit = "♠" | "♥" | "♦" | "♣";
type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";
type Card = { suit: Suit; rank: Rank };

// The atom on a hole-card hand. One shared atom is fine: each hand has its own render boundary,
// so we declassify per-hand by toggling each boundary's declassify list.
const POKER_HAND = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "PokerHoleCards",
  subject: "poker:hole-cards",
} as const;

// A SEPARATE atom for the DERIVED count value. This is the point: the reducer's output is its own
// labelled, binary-access cell — not a "lower level" of the hand's label.
const POKER_HAND_COUNT = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "PokerHandCount",
  subject: "poker:hand-count",
} as const;

type ConfHand = Confidential<Card[], readonly [typeof POKER_HAND]>;
type ConfCount = Confidential<number, readonly [typeof POKER_HAND_COUNT]>;

// Idiomatic confidential-cell creation (mirrors cfc-render-policy-demo): a lift whose RETURN type
// is the Confidential cell, built with Cell.for(id).set(...). This attaches the ifc.confidentiality
// label the render boundary reads.
const makeHand = lift<{ id: string; cards: Card[] }, Writable<ConfHand>>((input) =>
  Cell.for<ConfHand>(input.id).set(input.cards as ConfHand)
);
const makeCount = lift<{ id: string; n: number }, Writable<ConfCount>>((input) =>
  Cell.for<ConfCount>(input.id).set(input.n as ConfCount)
);

// ===========================================================================
// Module-scope helpers
// ===========================================================================

const PHASES = ["predeal", "preflop", "flop", "turn", "river", "showdown"];

// Two preset deals so "New game" visibly changes the table. The hands' SECRECY comes from the CFC
// render boundary, not from how cards are chosen, so fixed presets are fine.
const DEALS: { hands: Card[][]; community: Card[] }[] = [
  {
    hands: [
      [{ suit: "♠", rank: "A" }, { suit: "♥", rank: "A" }],
      [{ suit: "♦", rank: "K" }, { suit: "♣", rank: "K" }],
      [{ suit: "♥", rank: "7" }, { suit: "♦", rank: "2" }],
    ],
    community: [
      { suit: "♠", rank: "Q" }, { suit: "♦", rank: "J" }, { suit: "♣", rank: "10" },
      { suit: "♥", rank: "9" }, { suit: "♠", rank: "3" },
    ],
  },
  {
    hands: [
      [{ suit: "♥", rank: "10" }, { suit: "♥", rank: "6" }],
      [{ suit: "♠", rank: "6" }, { suit: "♥", rank: "9" }],
      [{ suit: "♣", rank: "Q" }, { suit: "♦", rank: "Q" }],
    ],
    community: [
      { suit: "♣", rank: "8" }, { suit: "♥", rank: "2" }, { suit: "♣", rank: "J" },
      { suit: "♦", rank: "4" }, { suit: "♣", rank: "A" },
    ],
  },
];

function suitColor(suit: Suit): string {
  return suit === "♥" || suit === "♦" ? "#dc2626" : "#0f172a";
}

// ---------------------------------------------------------------------------
// Visual styles
// ---------------------------------------------------------------------------

const CARD_BASE = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "40px",
  height: "56px",
  borderRadius: "7px",
  fontSize: "20px",
  fontWeight: "700",
  margin: "0 4px 0 0",
  padding: "0 4px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
};
const FACE_UP = { ...CARD_BASE, background: "#ffffff", border: "1px solid #cbd5e1" };
const LOCK_BOX = {
  display: "inline-flex",
  alignItems: "center",
  height: "56px",
  padding: "0 14px",
  borderRadius: "7px",
  background: "#fff7ed",
  color: "#9a3412",
  border: "1px dashed #fdba74",
  fontSize: "13px",
  fontWeight: "600",
};
const FOLDED_BOX = {
  ...LOCK_BOX,
  background: "#f1f5f9",
  color: "#64748b",
  border: "1px dashed #94a3b8",
  fontStyle: "italic",
};
const YOU_BOX = {
  ...LOCK_BOX,
  background: "#dcfce7",
  color: "#166534",
  border: "1px solid #86efac",
};
const ROW = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px" };
const HAND_ROW = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #e2e8f0",
  marginBottom: "8px",
  flexWrap: "wrap",
};
const NAME_COL = { minWidth: "90px", fontWeight: "700", fontSize: "15px" };
const LABEL_BOX = {
  fontSize: "11px",
  maxHeight: "110px",
  overflow: "auto",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "8px",
  marginTop: "6px",
  color: "#334155",
};

// Typed as Record so it satisfies the style prop via `as never` at the use site.
const OUTER_STYLE: Record<string, string> = {
  padding: "1rem",
  maxWidth: "920px",
};

// cf-button writes the whole theme token set onto its own host inline style, so style/var
// overrides lose. The one lever that wins is ::part from a light-DOM <style> — scope it to the
// two primary CTAs so they're high-contrast (saturated blue + white) in both light and dark mode
// without changing every button in the app.
const CTA_CSS =
  "cf-button.cta::part(button){background:#1d4ed8 !important;color:#ffffff !important;" +
  "border-color:#1d4ed8 !important;}";

// ENFORCED / SIMULATED / OUT OF SCOPE badge — replaces the retired reveal-level "pill".
type Badge = "ENFORCED" | "SIMULATED" | "OUT OF SCOPE";
const BADGE_STYLE: Record<Badge, { bg: string; fg: string }> = {
  "ENFORCED": { bg: "#dcfce7", fg: "#166534" },
  "SIMULATED": { bg: "#fef3c7", fg: "#92400e" },
  "OUT OF SCOPE": { bg: "#e5e7eb", fg: "#374151" },
};

function badge(kind: Badge) {
  const s = BADGE_STYLE[kind];
  return (
    <span
      style={{
        display: "inline-block",
        alignSelf: "center", // don't stretch when placed in a flex row next to a tall button
        flexShrink: "0",
        background: s.bg,
        color: s.fg,
        borderRadius: "6px",
        padding: "0 8px",
        fontSize: "10px",
        lineHeight: "18px",
        height: "18px",
        boxSizing: "border-box",
        fontWeight: "700",
        letterSpacing: "0.3px",
        whiteSpace: "nowrap",
      }}
    >
      {kind}
    </span>
  );
}

function cardChip(c: Card) {
  if (!c || !c.suit) return <span />; // guard transient undefined during reactive updates
  return (
    <span style={{ ...FACE_UP, color: suitColor(c.suit) }}>
      {c.rank}{c.suit}
    </span>
  );
}

// The ENFORCED hand: cards rendered INSIDE a render boundary. When `declassified` is false the
// boundary blocks the subtree (the runtime refuses to render a labelled cell); when true it
// permits it. `$value` is the confidential cell whose live label the boundary checks.
function handBoundary(
  confCell: Writable<ConfHand>,
  cardsCell: Writable<Card[]>,
  declassified: boolean,
) {
  return (
    <cf-cfc-render-boundary
      maxConfidentiality={[]}
      declassifyConfidentiality={declassified ? [POKER_HAND] : []}
      $value={confCell}
    >
      <div style={ROW}>{cardsCell.get().map(cardChip)}</div>
    </cf-cfc-render-boundary>
  );
}

// The DERIVED count value behind its OWN boundary, with its OWN atom. Blocked until the relabel
// (trusted "Release count" action) fires.
function countBoundary(
  confCell: Writable<ConfCount>,
  countVal: number,
  released: boolean,
) {
  return (
    <cf-cfc-render-boundary
      maxConfidentiality={[]}
      declassifyConfidentiality={released ? [POKER_HAND_COUNT] : []}
      $value={confCell}
    >
      <span style={{ fontWeight: "700", fontSize: "16px" }}>{countVal} cards</span>
    </cf-cfc-render-boundary>
  );
}

const STAGE = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  padding: "10px",
  minWidth: "150px",
  background: "#ffffff",
  color: "#0f172a", // explicit so light-bg boxes stay readable in dark mode
};
const STAGE_TITLE = { fontSize: "12px", fontWeight: "700", marginBottom: "6px" };
const STAGE_BODY = { marginBottom: "6px", minHeight: "30px" };

// A labelled stage box for STATIC pipeline stages (dynamic boundaries are rendered inline so their
// computeds are direct children — see the pattern body).
function stageBox(title: string, body: unknown, kind: Badge) {
  return (
    <div style={STAGE}>
      <div style={STAGE_TITLE}>{title}</div>
      <div style={STAGE_BODY}>{body}</div>
      {badge(kind)}
    </div>
  );
}

function pipelineArrow(label: string) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        color: "#64748b",
        fontSize: "10px",
        padding: "0 2px",
        maxWidth: "90px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "22px", lineHeight: "1" }}>→</div>
      <div>{label}</div>
    </div>
  );
}

// Plain headline + muted CFC term + optional badge — teaches the term without leading with jargon.
function dualHeading(plain: string, cfcTerm: string, badgeKind?: Badge) {
  return (
    <cf-hstack gap="2" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
      <cf-heading level={3}>{plain}</cf-heading>
      <span style={{ fontSize: "12px", color: "#94a3b8", fontWeight: "500" }}>{cfcTerm}</span>
      {badgeKind ? badge(badgeKind) : ""}
    </cf-hstack>
  );
}

const STEP_NUM = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "20px",
  height: "20px",
  borderRadius: "999px",
  background: "#2563eb",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: "700",
  flexShrink: "0",
};

function tryThis() {
  const step = (n: string, text: string) => (
    <div style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
      <span style={STEP_NUM}>{n}</span>
      <span style={{ fontSize: "13px", color: "#334155" }}>{text}</span>
    </div>
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        background: "#f1f5f9",
        color: "#334155",
        borderRadius: "10px",
        padding: "10px 12px",
      }}
    >
      {step("1", "The hands below are hidden — the system itself refuses to show them.")}
      {step("2", "Click “Showdown” to let the one trusted action reveal them.")}
      {step("3", "Or release just the count — a summary the table can see, without the cards.")}
    </div>
  );
}

const BANNER_HIDDEN = {
  borderRadius: "10px",
  padding: "10px 14px",
  fontWeight: "700",
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fcd34d",
};
const BANNER_SHOWN = {
  ...BANNER_HIDDEN,
  background: "#dcfce7",
  color: "#166534",
  border: "1px solid #86efac",
};

// Per-row left border: amber while hidden, green once revealed (folded stays amber).
function rowStyle(folded: boolean, shown: boolean) {
  return {
    ...HAND_ROW,
    borderLeft: shown && !folded ? "4px solid #16a34a" : "4px solid #f59e0b",
  };
}

// Status breadcrumb (NOT buttons): "PHASE  predeal › preflop › flop › ...", current highlighted.
function phaseStepper(current: string) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", fontSize: "12px" }}>
      <span style={{ color: "#94a3b8", fontWeight: "700", letterSpacing: "0.5px" }}>PHASE</span>
      {PHASES.map((p, i) => (
        <span
          style={{
            fontWeight: p === current ? "700" : "500",
            color: p === current ? "#2563eb" : "#94a3b8",
          }}
        >
          {i > 0 ? "›  " : ""}{p}
        </span>
      ))}
    </div>
  );
}

// ===========================================================================
// Handlers
// ===========================================================================

const SHOWDOWN_SURFACE = "TrustedShowdownSurface";
const SHOWDOWN_ACTION = "TrustedShowdownReveal";
const COUNT_SURFACE = "TrustedCountReducerSurface";
const COUNT_ACTION = "TrustedReleaseCount";

type GameState = {
  dealIndex: Writable<number>;
  alice: Writable<Card[]>;
  bob: Writable<Card[]>;
  charlie: Writable<Card[]>;
  community: Writable<Card[]>;
  board: Writable<Card[]>;
  aliceFolded: Writable<boolean>;
  bobFolded: Writable<boolean>;
  charlieFolded: Writable<boolean>;
  revealed: Writable<boolean>;
  countReleased: Writable<boolean>;
  phase: Writable<string>;
};

const newGame = handler<unknown, GameState>((_, s) => {
  const next = (s.dealIndex.get() + 1) % DEALS.length;
  const deal = DEALS[next];
  s.dealIndex.set(next);
  s.alice.set(deal.hands[0]);
  s.bob.set(deal.hands[1]);
  s.charlie.set(deal.hands[2]);
  s.community.set(deal.community);
  s.board.set([]);
  s.aliceFolded.set(false);
  s.bobFolded.set(false);
  s.charlieFolded.set(false);
  s.revealed.set(false); // re-conceal: hands go back behind the render boundary
  s.countReleased.set(false);
  s.phase.set("preflop");
});

type BoardState = {
  community: Writable<Card[]>;
  board: Writable<Card[]>;
  phase: Writable<string>;
  count: number;
  nextPhase: string;
};

const dealStreet = handler<unknown, BoardState>((_, s) => {
  s.board.set(s.community.get().slice(0, s.count));
  s.phase.set(s.nextPhase);
});

const foldPlayer = handler<unknown, { folded: Writable<boolean> }>((_, s) => {
  s.folded.set(true);
});

// Generic trusted relabel: flips the boolean that drives a render boundary's declassify list.
// Used for BOTH the showdown (hands) and the count release — each from its own trusted surface.
const setBool = handler<unknown, { cell: Writable<boolean>; next: boolean }>(
  (_, s) => {
    s.cell.set(s.next);
  },
);

// Simulated per-recipient sync: which player's runtime are we acting as? (Not real authenticated
// identity — stands in for the planned label-gated sync that delivers each field per reader.)
const setViewer = handler<unknown, { viewer: Writable<string>; next: string }>(
  (_, s) => {
    s.viewer.set(s.next);
  },
);

// What a given hand projects FOR THE CURRENT VIEWER: you always see your own hand; the showdown
// reveals everyone's non-folded hands to all. (declassify the render boundary accordingly.)
function seesHand(viewer: string, owner: string, folded: boolean, shown: boolean): boolean {
  if (viewer === owner) return true; // your own cards
  return shown && !folded; // showdown reveals others' live hands
}

function handNoteFor(
  viewer: string,
  owner: string,
  folded: boolean,
  shown: boolean,
) {
  if (viewer === owner) {
    return <div style={YOU_BOX}>👁 your hand</div>;
  }
  if (folded) return <div style={FOLDED_BOX}>folded — stays secret</div>;
  return shown ? "" : <div style={LOCK_BOX}>🔒 secret from you</div>;
}

// ===========================================================================
// Pattern
// ===========================================================================

type PokerOutput = {
  [NAME]: string;
  [UI]: unknown;
  revealed: TrustedActionWrite<
    boolean,
    typeof setBool,
    typeof SHOWDOWN_ACTION,
    typeof SHOWDOWN_SURFACE
  >;
  countReleased: TrustedActionWrite<
    boolean,
    typeof setBool,
    typeof COUNT_ACTION,
    typeof COUNT_SURFACE
  >;
  reveal: Stream<unknown>;
  releaseCount: Stream<unknown>;
};

export default pattern<unknown, PokerOutput>(() => {
  const dealIndex = new Writable<number>(0);
  const alice = new Writable<Card[]>(DEALS[0].hands[0]);
  const bob = new Writable<Card[]>(DEALS[0].hands[1]);
  const charlie = new Writable<Card[]>(DEALS[0].hands[2]);
  const community = new Writable<Card[]>(DEALS[0].community);
  const board = new Writable<Card[]>([]);
  const aliceFolded = new Writable<boolean>(false);
  const bobFolded = new Writable<boolean>(false);
  const charlieFolded = new Writable<boolean>(false);
  const revealed = new Writable<boolean>(false);
  const countReleased = new Writable<boolean>(false);
  const phase = new Writable<string>("predeal");
  const viewer = new Writable<string>("Spectator"); // simulated per-recipient sync

  // Confidential views of the three hands (real ifc.confidentiality labels).
  const aliceConf: Writable<ConfHand> = makeHand({ id: "poker-hand-alice", cards: alice }) as never;
  const bobConf: Writable<ConfHand> = makeHand({ id: "poker-hand-bob", cards: bob }) as never;
  const charlieConf: Writable<ConfHand> = makeHand({ id: "poker-hand-charlie", cards: charlie }) as never;

  // THE REDUCER: count = hand.length. A plain transform. In the CFC model its output inherits the
  // hand's confidentiality and mints a resolution-reduction integrity atom (ReducedBy{count});
  // here we model the count as its own Confidential cell with its own atom. The integrity-minting
  // and integrity-GATING are simulated; the second confidential cell + its boundary are real.
  const aliceCount = computed(() => alice.get().length);
  const aliceCountConf: Writable<ConfCount> = makeCount({ id: "poker-count-alice", n: aliceCount }) as never;

  const game: GameState = {
    dealIndex, alice, bob, charlie, community, board,
    aliceFolded, bobFolded, charlieFolded, revealed, countReleased, phase,
  };

  const start = newGame(game);
  const flop = dealStreet({ community, board, phase, count: 3, nextPhase: "flop" });
  const turn = dealStreet({ community, board, phase, count: 4, nextPhase: "turn" });
  const river = dealStreet({ community, board, phase, count: 5, nextPhase: "river" });
  const foldAlice = foldPlayer({ folded: aliceFolded });
  const foldBob = foldPlayer({ folded: bobFolded });
  const foldCharlie = foldPlayer({ folded: charlieFolded });
  const reveal = setBool({ cell: revealed, next: true });
  const conceal = setBool({ cell: revealed, next: false });
  const releaseCount = setBool({ cell: countReleased, next: true });
  const hideCount = setBool({ cell: countReleased, next: false });
  const viewAlice = setViewer({ viewer, next: "Alice" });
  const viewBob = setViewer({ viewer, next: "Bob" });
  const viewCharlie = setViewer({ viewer, next: "Charlie" });
  const viewSpectator = setViewer({ viewer, next: "Spectator" });
  const lblAlice = computed(() => (viewer.get() === "Alice" ? "✓ Alice" : "Alice"));
  const lblBob = computed(() => (viewer.get() === "Bob" ? "✓ Bob" : "Bob"));
  const lblCharlie = computed(() => (viewer.get() === "Charlie" ? "✓ Charlie" : "Charlie"));
  const lblSpectator = computed(() => (viewer.get() === "Spectator" ? "✓ Spectator (anyone at the table)" : "Spectator (anyone at the table)"));

  // Each hand's render boundary, rebuilt when the deal/viewer/showdown change. You see your own
  // hand; the showdown reveals everyone's non-folded hands to all.
  const aliceCell = computed(() => {
    dealIndex.get();
    return handBoundary(aliceConf, alice, seesHand(viewer.get(), "Alice", aliceFolded.get(), revealed.get()));
  });
  const bobCell = computed(() => {
    dealIndex.get();
    return handBoundary(bobConf, bob, seesHand(viewer.get(), "Bob", bobFolded.get(), revealed.get()));
  });
  const charlieCell = computed(() => {
    dealIndex.get();
    return handBoundary(charlieConf, charlie, seesHand(viewer.get(), "Charlie", charlieFolded.get(), revealed.get()));
  });

  const aliceNote = computed(() => handNoteFor(viewer.get(), "Alice", aliceFolded.get(), revealed.get()));
  const bobNote = computed(() => handNoteFor(viewer.get(), "Bob", bobFolded.get(), revealed.get()));
  const charlieNote = computed(() => handNoteFor(viewer.get(), "Charlie", charlieFolded.get(), revealed.get()));

  const aliceRowStyle = computed(() => rowStyle(aliceFolded.get(), seesHand(viewer.get(), "Alice", aliceFolded.get(), revealed.get())));
  const bobRowStyle = computed(() => rowStyle(bobFolded.get(), seesHand(viewer.get(), "Bob", bobFolded.get(), revealed.get())));
  const charlieRowStyle = computed(() => rowStyle(charlieFolded.get(), seesHand(viewer.get(), "Charlie", charlieFolded.get(), revealed.get())));

  // Hero status banner — reflects the current viewer and showdown state.
  const heroBanner = computed(() => {
    if (revealed.get()) {
      return <div style={BANNER_SHOWN}>✅ Showdown! A trusted action revealed every hand to everyone.</div>;
    }
    const v = viewer.get();
    if (v === "Spectator") {
      return <div style={BANNER_HIDDEN}>🔒 Viewing as a spectator — every hand is secret. Pick a player to see their view, or run Showdown.</div>;
    }
    return <div style={BANNER_SHOWN}>👁 Viewing as {v}: you see your own cards; opponents stay secret.</div>;
  });
  const clickCue = computed(() =>
    revealed.get()
      ? ""
      : <div style={{ fontSize: "13px", color: "#2563eb", fontWeight: "600" }}>👇 Pick a player above to see their view, or click “Showdown” to reveal to all</div>
  );

  // The two DYNAMIC boundaries are their own top-level computeds rendered as direct children
  // (the pattern that works for the hand rows) — not nested inside a bigger computed/stageBox.
  const aliceSecretCell = computed(() => {
    dealIndex.get();
    return handBoundary(aliceConf, alice, false); // always blocked: the secret-hand stage
  });
  const countCellComputed = computed(() => {
    dealIndex.get();
    return countBoundary(aliceCountConf, alice.get().length, countReleased.get());
  });
  const countStatus = computed(() =>
    countReleased.get()
      ? "Released: the table now sees the count (a separate labelled value)."
      : "The count cell is confidential until the trusted relabel fires."
  );

  const stepper = computed(() => phaseStepper(phase.get()));
  // Phase-gating: streets must be dealt in order; folds only while a hand is in play.
  const flopDisabled = computed(() => phase.get() !== "preflop");
  const turnDisabled = computed(() => phase.get() !== "flop");
  const riverDisabled = computed(() => phase.get() !== "turn");
  const foldDisabled = computed(() => {
    const p = phase.get();
    return !(p === "preflop" || p === "flop" || p === "turn" || p === "river");
  });
  const boardDisplay = computed(() => {
    const b = (board.get() || []).filter((c) => c && c.rank);
    return b.length ? "" : "(no community cards yet — deal the flop)";
  });

  return {
    [NAME]: "Poker sanitization demo (idiomatic CFC)",
    [UI]: (
      <cf-screen title="Poker sanitization demo">
        <cf-vstack gap="3" style={OUTER_STYLE as never}>
          <style>{CTA_CSS}</style>
          {/* HERO — secret hands + the one trusted reveal (also the showdown trusted surface) */}
          <cf-card
            id="trusted-showdown-surface"
            data-ui-surface={SHOWDOWN_SURFACE}
            data-ui-pattern={SHOWDOWN_SURFACE}
            data-ui-event-integrity={SHOWDOWN_SURFACE}
          >
            <cf-vstack slot="content" gap="3">
              <cf-vstack gap="1">
                <cf-heading level={2}>🃏 These poker hands are secret — the system itself won't show them</cf-heading>
                <cf-label style={{ color: "#64748b" }}>
                  The cards are hidden by the runtime, not a CSS trick: it refuses to render a value
                  labelled secret (a <b>Confidential</b> cell behind a <b>CFC render boundary</b>).
                  Only a trusted “Showdown” action can change that.
                </cf-label>
              </cf-vstack>

              {tryThis()}

              {/* Simulated per-recipient sync: act as a specific player */}
              <cf-vstack gap="1">
                <cf-hstack gap="2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "13px", fontWeight: "700" }}>View as:</span>
                  <cf-button onClick={viewAlice} color="neutral" variant="outline" size="sm">{lblAlice}</cf-button>
                  <cf-button onClick={viewBob} color="neutral" variant="outline" size="sm">{lblBob}</cf-button>
                  <cf-button onClick={viewCharlie} color="neutral" variant="outline" size="sm">{lblCharlie}</cf-button>
                  <cf-button onClick={viewSpectator} color="neutral" variant="outline" size="sm">{lblSpectator}</cf-button>
                  {badge("SIMULATED")}
                </cf-hstack>
                <cf-label style={{ fontSize: "12px", color: "#94a3b8" }}>
                  Switching reader stands in for <b>label-gated per-recipient sync</b> (a planned
                  memory-engine step) — simulated here on one host, not real authenticated identity.
                </cf-label>
              </cf-vstack>

              {heroBanner}

              <div style={aliceRowStyle}>
                <div style={NAME_COL}>Alice</div>
                {aliceCell}
                {aliceNote}
              </div>
              <div style={bobRowStyle}>
                <div style={NAME_COL}>Bob</div>
                {bobCell}
                {bobNote}
              </div>
              <div style={charlieRowStyle}>
                <div style={NAME_COL}>Charlie</div>
                {charlieCell}
                {charlieNote}
              </div>

              {clickCue}
              <cf-hstack gap="2" style={{ alignItems: "center" }}>
                <cf-button
                  data-ui-action={SHOWDOWN_ACTION}
                  onClick={reveal}
                  className="cta"
                  color="primary"
                  variant="solid"
                  size="lg"
                >
                  🏆 Showdown — reveal the hands
                </cf-button>
                <cf-button onClick={conceal} color="neutral" variant="ghost" size="sm">
                  Re-hide
                </cf-button>
                {badge("ENFORCED")}
              </cf-hstack>
              <cf-label style={{ fontSize: "12px", color: "#94a3b8" }}>
                The reveal is the one <b>trusted action</b> (data-ui-action + TrustedActionWrite)
                allowed to declassify the hands. Folded hands stay secret even at showdown.
              </cf-label>
            </cf-vstack>
          </cf-card>

          {/* RELEASE A SUMMARY — reducer + relabel (count), the count trusted surface */}
          <cf-card
            id="trusted-count-surface"
            data-ui-surface={COUNT_SURFACE}
            data-ui-pattern={COUNT_SURFACE}
            data-ui-event-integrity={COUNT_SURFACE}
          >
            <cf-vstack slot="content" gap="2">
              {dualHeading(
                "🔢 Show how many cards someone holds — without showing the cards",
                "reducer → its own Confidential cell → trusted relabel",
              )}
              <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                “The table sees you hold 2 cards, but not which 2” isn’t a half-secret. It’s a
                brand-new, separate value (just the number) that a trusted step may publish — the
                real cards stay locked.
              </cf-label>
              <div style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap", gap: "4px" }}>
                <div style={STAGE}>
                  <div style={STAGE_TITLE}>1. Secret hand</div>
                  <div style={STAGE_BODY}>{aliceSecretCell}</div>
                  {badge("ENFORCED")}
                </div>
                {pipelineArrow("reduce → count")}
                {stageBox(
                  "2. Reducer output",
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                    just the number; <code>ReducedBy&#123;count&#125;</code>
                  </span>,
                  "SIMULATED",
                )}
                {pipelineArrow("trusted relabel → table")}
                <div style={STAGE}>
                  <div style={STAGE_TITLE}>3. Count (own value)</div>
                  <div style={STAGE_BODY}>{countCellComputed}</div>
                  {badge("ENFORCED")}
                </div>
              </div>
              <cf-label style={{ fontSize: "12px", color: "#64748b" }}>{countStatus}</cf-label>
              <cf-hstack gap="2">
                <cf-button
                  data-ui-action={COUNT_ACTION}
                  onClick={releaseCount}
                  className="cta"
                  color="primary"
                  variant="solid"
                >
                  Release the count to the table
                </cf-button>
                <cf-button onClick={hideCount} color="neutral" variant="ghost" size="sm">
                  Re-conceal
                </cf-button>
              </cf-hstack>
              <details>
                <summary style={{ cursor: "pointer", fontSize: "12px", color: "#64748b" }}>
                  Inspect the count’s live CFC label
                </summary>
                <div style={LABEL_BOX}>
                  <cf-cfc-label data-cfc-label-surface="alice-count" $value={aliceCountConf} />
                </div>
              </details>
            </cf-vstack>
          </cf-card>

          {/* PLAY THE HAND — community cards + dealer controls */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              {dualHeading("🃏 Play the hand", "community cards are public; hole cards stay confidential")}
              {/* status (not clickable) */}
              {stepper}
              <div style={ROW}>
                {board.map(cardChip)}
                <span style={{ color: "#64748b", fontSize: "13px" }}>{boardDisplay}</span>
              </div>
              {/* controls (clickable) — streets must be dealt in order, so out-of-phase ones disable */}
              <cf-label style={{ fontSize: "11px", fontWeight: "700", color: "#94a3b8", letterSpacing: "0.5px" }}>
                DEAL (in order)
              </cf-label>
              <cf-hstack gap="2">
                <cf-button onClick={start} color="primary" variant="solid" size="sm">🆕 New game</cf-button>
                <cf-button onClick={flop} color="neutral" variant="solid" size="sm" disabled={flopDisabled}>Flop</cf-button>
                <cf-button onClick={turn} color="neutral" variant="solid" size="sm" disabled={turnDisabled}>Turn</cf-button>
                <cf-button onClick={river} color="neutral" variant="solid" size="sm" disabled={riverDisabled}>River</cf-button>
              </cf-hstack>
              <cf-label style={{ fontSize: "11px", fontWeight: "700", color: "#94a3b8", letterSpacing: "0.5px" }}>
                PLAYERS — fold mucks a hand (it stays secret even at showdown)
              </cf-label>
              <cf-hstack gap="2">
                <cf-button onClick={foldAlice} color="neutral" variant="outline" size="sm" disabled={foldDisabled}>Alice folds</cf-button>
                <cf-button onClick={foldBob} color="neutral" variant="outline" size="sm" disabled={foldDisabled}>Bob folds</cf-button>
                <cf-button onClick={foldCharlie} color="neutral" variant="outline" size="sm" disabled={foldDisabled}>Charlie folds</cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {/* UNDER THE HOOD (collapsed) */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <details>
                <summary style={{ cursor: "pointer", fontWeight: "600", fontSize: "15px" }}>
                  🏷️ Under the hood: the real CFC label & badge key
                </summary>
                <cf-vstack gap="2" style={{ marginTop: "8px" }}>
                  <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                    The actual <code>ifc.confidentiality</code> the runtime attached to Alice’s hand
                    — exactly what the render boundary reads to decide whether to show it.
                  </cf-label>
                  <div style={LABEL_BOX}>
                    <cf-cfc-label data-cfc-label-surface="alice" $value={aliceConf} />
                  </div>
                  <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                    {badge("ENFORCED")} = real, runtime-enforced CFC. {badge("SIMULATED")} = the
                    concept is real but no runtime primitive exists yet (we drive it from a trusted
                    action instead).
                  </cf-label>
                </cf-vstack>
              </details>
            </cf-vstack>
          </cf-card>

          {/* HONEST LIMITS (collapsed) */}
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <details>
                <summary style={{ cursor: "pointer", fontWeight: "600", fontSize: "15px" }}>
                  ⚠️ What this demo fakes, and what’s out of scope
                </summary>
                <cf-vstack gap="2" style={{ marginTop: "8px" }}>
                  <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                    {badge("SIMULATED")} <b>Per-recipient sync.</b> Delivering each field only to
                    clients that can read it is label-gated sync — a <i>planned</i> memory-engine
                    step. Assumed here; one screen stands in for it:
                  </cf-label>
                  <div style={{ border: "1px dashed #fdba74", borderRadius: "10px", padding: "10px", background: "#fffbeb", color: "#334155", fontSize: "13px" }}>
                    <div>reader <b>Alice</b> → her cards</div>
                    <div>reader <b>Bob</b> → only the count</div>
                  </div>
                  <cf-label style={{ fontSize: "13px", color: "#64748b" }}>
                    {badge("OUT OF SCOPE")} <b>Recombination</b> (many summaries of one secret can
                    leak more than any one — §14.3.2) and <b>unlinkability</b> (a shuffle you can’t
                    trace) — relational properties CFC’s lattice doesn’t model. (The render boundary
                    here is a trusted-host stand-in for the sync layer.)
                  </cf-label>
                </cf-vstack>
              </details>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    revealed,
    countReleased,
    reveal,
    releaseCount,
  };
});
