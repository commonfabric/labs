/**
 * Keeps a list of labeled amounts, sums them in integer cents, and shows the
 * formatted running total — optionally against a budget, reporting what is
 * left or how far over it the total has gone.
 *
 * Embed it as `<AmountLedger entries={myExpenses} budget={1200} />` and read
 * the total off the host's own cell.
 *
 * Summing in cents and formatting once at the edge is what keeps the displayed
 * total equal to the sum of the displayed rows, rather than a float that
 * drifts a penny away from them.
 *
 * @hashtags expenses, budget, total, money, ledger, spending
 * @keywords running total, sum, expense tracker, budget tracker, spending,
 * cost, price, amount, currency, dollars, USD, subtotal, add expense,
 * remaining budget, over budget
 */
import {
  action,
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface AmountEntry {
  label: string;
  amount: number;
}

export interface AmountLedgerInput {
  /** The entries being totalled. A host passes its own cell to share them. */
  entries?: Writable<AmountEntry[] | Default<[]>>;

  /** Prefixed to every formatted amount. */
  currencySymbol?: Writable<string | Default<"$">>;

  /** Total to measure spending against. Zero means no budget is shown. */
  budget?: Writable<number | Default<0>>;

  /** Heading shown above the entries. */
  label?: Writable<string | Default<"Expenses">>;
}

export interface AmountLedgerOutput {
  [NAME]: string;
  [UI]: VNode;
  entries: AmountEntry[];
  total: number;
  formattedTotal: string;
  remaining: number;
  overBudget: boolean;
  entryCount: number;
  addEntry: Stream<{ label: string; amount: number }>;
  removeEntry: Stream<{ entry: AmountEntry }>;
}

/** Cents for an amount given in whole currency units. */
const cents = (amount: number): number => Math.round((amount || 0) * 100);

/** `amount` rendered under `symbol`, to the penny. */
const money = (symbol: string, amount: number): string =>
  `${symbol}${(amount || 0).toFixed(2)}`;

export const AmountLedger = pattern<AmountLedgerInput, AmountLedgerOutput>(
  ({ entries, currencySymbol, budget, label }) => {
    const draftLabel = new Writable("");
    const draftAmount = new Writable("");

    const addEntry = action(
      ({ label: entryLabel, amount }: { label: string; amount: number }) => {
        const trimmed = entryLabel.trim();
        if (!trimmed) return;
        entries.push({ label: trimmed, amount: cents(amount) / 100 });
      },
    );

    const removeEntry = action(({ entry }: { entry: AmountEntry }) => {
      // Plain reads of inline rows carry value references; mapped UI rows
      // carry the live slot reference.
      const index = entries.get().findIndex((candidate, index) =>
        Writable.equals(entries.key(index), entry) ||
        Writable.equals(candidate, entry)
      );
      if (index < 0) return;
      entries.set(entries.get().filter((_, position) => position !== index));
    });

    const total = computed(() =>
      entries.get().reduce((sum, entry) => sum + cents(entry.amount), 0) / 100
    );
    const formattedTotal = computed(() => money(currencySymbol.get(), total));
    const remaining = computed(() => {
      const limit = budget.get() ?? 0;
      return limit === 0 ? 0 : (cents(limit) - cents(total)) / 100;
    });
    const hasBudget = computed(() => (budget.get() ?? 0) !== 0);
    const overBudget = computed(() => hasBudget && remaining < 0);
    const entryCount = computed(() => entries.get().length);
    const isEmpty = computed(() => entryCount === 0);

    const rows = entries.map((entry: AmountEntry) => (
      <cf-hstack gap="2" align="center" justify="between">
        <cf-text style="flex: 1;">{entry.label}</cf-text>
        <cf-text style="font-variant-numeric: tabular-nums;">
          {computed(() =>
            money(currencySymbol.get(), cents(entry.amount) / 100)
          )}
        </cf-text>
        <cf-button
          variant="ghost"
          color="neutral"
          onClick={() =>
            removeEntry.send({ entry })}
        >
          Remove
        </cf-button>
      </cf-hstack>
    ));

    return {
      [NAME]: computed(() => `${label.get()}: ${formattedTotal}`),
      [UI]: (
        <cf-vstack gap="3" padding="3">
          <cf-heading level={5}>{label}</cf-heading>

          <cf-vstack gap="2">
            {rows}
          </cf-vstack>

          {ifElse(isEmpty, <cf-empty-state message="No entries yet." />, null)}

          <cf-separator />

          <cf-hstack justify="between" align="center">
            <cf-text style="font-weight: 600;">Total</cf-text>
            <cf-text style="font-weight: 600; font-variant-numeric: tabular-nums;">
              {formattedTotal}
            </cf-text>
          </cf-hstack>

          {ifElse(
            hasBudget,
            <cf-hstack justify="between" align="center">
              <cf-text tone="muted">
                {computed(() => overBudget ? "Over budget by" : "Left")}
              </cf-text>
              <cf-text tone={ifElse(overBudget, "error", "muted")}>
                {computed(() =>
                  money(currencySymbol.get(), Math.abs(remaining))
                )}
              </cf-text>
            </cf-hstack>,
            null,
          )}

          <cf-hstack gap="2">
            <cf-input
              $value={draftLabel}
              placeholder="What was it for?"
              style="flex: 1;"
            />
            <cf-input
              type="number"
              $value={draftAmount}
              placeholder="0.00"
              style="width: 7rem;"
            />
            <cf-button
              variant="primary"
              onClick={() => {
                addEntry.send({
                  label: draftLabel.get(),
                  amount: Number(draftAmount.get()) || 0,
                });
                draftLabel.set("");
                draftAmount.set("");
              }}
            >
              Add
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      ),
      entries,
      total,
      formattedTotal,
      remaining,
      overBudget,
      entryCount,
      addEntry,
      removeEntry,
    };
  },
);

export default AmountLedger;
