/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// An instance a handler makes whose body reads the acting principal's
// profile through `wish`, as a Topics topic does, and a handler bound to a
// stream of that instance: `make` adds a card, and `touch` of a card counts
// the touches of the space.

interface CardResult {
  [UI]: VNode;
  title: string;
  viewer: string;
  touches: number;
  touch: Stream<void>;
}

const touch = handler<void, { touches: Writable<number> }>(
  (_, { touches }) => {
    touches.set(touches.get() + 1);
  },
);

const Card = pattern<{ title: string }, CardResult>(({ title }) => {
  const profile = wish<{ name: string }>({ query: "#profile" });
  const viewer = computed(() => profile.result?.name ?? "");
  const touches = new Writable(0);
  return {
    [UI]: <div>{title} for {viewer}</div>,
    title,
    viewer,
    touches,
    touch: touch({ touches }),
  };
});

const make = handler<{ title: string }, { cards: Writable<CardResult[]> }>(
  (event, { cards }) => {
    cards.push(Card({ title: event.title }));
  },
);

interface Output {
  cards: CardResult[];
  make: Stream<{ title: string }>;
}

export default pattern<{ cards: Writable<CardResult[]> }, Output>(
  ({ cards }) => ({ cards, make: make({ cards }) }),
);
