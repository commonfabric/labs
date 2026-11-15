## `apps/reward-spinner/reward-spinner.tsx`

A slot-machine prize spinner for kids: tap the reel and it whirs through prizes
for six seconds before landing on three jelly beans, one jelly bean or a big
hug, with a burst of stars. A parent sets the odds with a quiet generosity
control (0 = mostly hugs, 10 = mostly candy) that briefly shows the resulting
odds, and every spin is recorded with its time and generosity. The prize and the
reel strip are decided once in the spin action; the reel is a CSS animation to
that strip's last cell, played only for spins made in the current session.

**Keywords:** kids, rewards, random, weighted-odds, animation, css-keyframes

### Input Schema

```ts
type PrizeId = "three-beans" | "one-bean" | "hug";

interface SpinRecord {
  timestamp: number; // ms since epoch
  generosity: number; // 0-10, at the time of the spin
  prize: PrizeId;
}

interface RewardSpinnerInput {
  generosity?: PerSpace<Writable<number | Default<10>>>;
  spinHistory?: PerSpace<Writable<SpinRecord[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface RewardSpinnerOutput {
  generosity: number;
  spinHistory: SpinRecord[];
  lastPrize: string; // emoji the reel rests on; 🎁 before any spin
  odds: { emoji: string; dots: string; percent: number }[];
  reel: string[]; // this session's latest reel strip; empty before one
  spin: Stream<void>;
  moreGenerous: Stream<void>;
  lessGenerous: Stream<void>;
}
```

<!-- demo-list: `apps/reward-spinner/` (a kids' prize spinner with parent-set odds) -->
