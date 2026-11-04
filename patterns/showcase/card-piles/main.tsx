import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;
type Suit = (typeof SUITS)[number];
type Rank = (typeof RANKS)[number];

export interface Card {
  suit: Suit;
  rank: Rank;
}

export const defaultPile1: Card[] = [
  { suit: "hearts", rank: "A" },
  { suit: "spades", rank: "K" },
  { suit: "diamonds", rank: "7" },
];

export const defaultPile2: Card[] = [
  { suit: "clubs", rank: "Q" },
  { suit: "hearts", rank: "10" },
  { suit: "spades", rank: "3" },
];

interface CardPilesInput {
  pile1: Writable<Card[] | Default<typeof defaultPile1>>;
  pile2: Writable<Card[] | Default<typeof defaultPile2>>;
}

export interface CardPilesOutput {
  [NAME]: string;
  [UI]: VNode;
  pile1: Card[];
  pile2: Card[];
  shuffle: Stream<void>;
  moveToPile1: Stream<{ detail: { sourceCell: Writable<Card> } }>;
  moveToPile2: Stream<{ detail: { sourceCell: Writable<Card> } }>;
}

function getSuitSymbol(suit: Suit): string {
  switch (suit) {
    case "hearts":
      return "\u2665";
    case "diamonds":
      return "\u2666";
    case "clubs":
      return "\u2663";
    case "spades":
      return "\u2660";
  }
}

function getSuitColor(suit: Suit): string {
  return suit === "hearts" || suit === "diamonds" ? "#dc2626" : "#1e293b";
}

const moveToPile = handler<
  { detail: { sourceCell: Writable<Card> } },
  { source: Writable<Card[]>; target: Writable<Card[]> }
>((event, { source, target }) => {
  const sourceCard = event.detail?.sourceCell;
  if (!sourceCard) return;
  source.remove(sourceCard);
  target.push(sourceCard);
});

const cardStyle = {
  width: "70px",
  height: "100px",
  background: "white",
  border: "2px solid var(--cf-theme-color-border, #e2e8f0)",
  borderRadius: "8px",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  padding: "6px",
  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
  cursor: "grab",
  userSelect: "none",
} as const;

const pileStyle = {
  minWidth: "120px",
  minHeight: "180px",
  border: "2px dashed var(--cf-theme-color-border, #cbd5e1)",
  borderRadius: "12px",
  padding: "1rem",
  background: "var(--cf-theme-color-surface, #f8fafc)",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
} as const;

const pileLabelStyle = {
  fontSize: "12px",
  color: "var(--cf-theme-color-text-secondary, #64748b)",
  fontWeight: "600",
  marginBottom: "0.5rem",
} as const;

const cardListStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  alignItems: "center",
} as const;

const emptyPileStyle = {
  color: "var(--cf-theme-color-text-secondary, #94a3b8)",
  fontSize: "13px",
  fontStyle: "italic",
  textAlign: "center",
  padding: "2rem 0.5rem",
} as const;

export default pattern<CardPilesInput, CardPilesOutput>(({ pile1, pile2 }) => {
  const shuffle = action(() => {
    const all = [...pile1.get(), ...pile2.get()];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    const mid = Math.ceil(all.length / 2);
    pile1.set(all.slice(0, mid));
    pile2.set(all.slice(mid));
  });

  const moveToPile1 = moveToPile({ source: pile2, target: pile1 });
  const moveToPile2 = moveToPile({ source: pile1, target: pile2 });

  const pile1Label = computed(() => {
    const count = pile1.get().length;
    return `Pile 1 (${count} ${count === 1 ? "card" : "cards"})`;
  });

  const pile2Label = computed(() => {
    const count = pile2.get().length;
    return `Pile 2 (${count} ${count === 1 ? "card" : "cards"})`;
  });

  return {
    [NAME]: "Card Piles",
    [UI]: (
      <cf-screen>
        <div style={{ padding: "1rem" }}>
          <cf-button onClick={shuffle}>Shuffle</cf-button>
        </div>
        <div
          style={{
            display: "flex",
            gap: "2rem",
            padding: "1.5rem",
            flexWrap: "wrap",
            minHeight: "200px",
          }}
        >
          <cf-drop-zone
            accept="card,cell-link"
            oncf-drop={moveToPile1}
          >
            <div style={pileStyle}>
              <div style={pileLabelStyle}>{pile1Label}</div>
              <div style={cardListStyle}>
                {pile1.map((card) => (
                  <cf-drag-source $cell={card} type="card">
                    <div style={cardStyle}>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "14px",
                          fontWeight: "bold",
                        }}
                      >
                        {card.rank}
                        <span style={{ marginLeft: "2px" }}>
                          {getSuitSymbol(card.suit)}
                        </span>
                      </div>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "28px",
                          textAlign: "center",
                          lineHeight: "1",
                        }}
                      >
                        {getSuitSymbol(card.suit)}
                      </div>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "14px",
                          fontWeight: "bold",
                          textAlign: "right",
                          transform: "rotate(180deg)",
                        }}
                      >
                        {card.rank}
                        <span style={{ marginLeft: "2px" }}>
                          {getSuitSymbol(card.suit)}
                        </span>
                      </div>
                    </div>
                  </cf-drag-source>
                ))}
                {computed(() =>
                  pile1.get().length === 0
                    ? <div style={emptyPileStyle}>Drop cards here</div>
                    : null
                )}
              </div>
            </div>
          </cf-drop-zone>

          <cf-drop-zone
            accept="card,cell-link"
            oncf-drop={moveToPile2}
          >
            <div style={pileStyle}>
              <div style={pileLabelStyle}>{pile2Label}</div>
              <div style={cardListStyle}>
                {pile2.map((card) => (
                  <cf-drag-source $cell={card} type="card">
                    <div style={cardStyle}>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "14px",
                          fontWeight: "bold",
                        }}
                      >
                        {card.rank}
                        <span style={{ marginLeft: "2px" }}>
                          {getSuitSymbol(card.suit)}
                        </span>
                      </div>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "28px",
                          textAlign: "center",
                          lineHeight: "1",
                        }}
                      >
                        {getSuitSymbol(card.suit)}
                      </div>
                      <div
                        style={{
                          color: getSuitColor(card.suit),
                          fontSize: "14px",
                          fontWeight: "bold",
                          textAlign: "right",
                          transform: "rotate(180deg)",
                        }}
                      >
                        {card.rank}
                        <span style={{ marginLeft: "2px" }}>
                          {getSuitSymbol(card.suit)}
                        </span>
                      </div>
                    </div>
                  </cf-drag-source>
                ))}
                {computed(() =>
                  pile2.get().length === 0
                    ? <div style={emptyPileStyle}>Drop cards here</div>
                    : null
                )}
              </div>
            </div>
          </cf-drop-zone>
        </div>
      </cf-screen>
    ),
    pile1,
    pile2,
    shuffle,
    moveToPile1,
    moveToPile2,
  };
});
