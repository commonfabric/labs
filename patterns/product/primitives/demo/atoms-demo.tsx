/**
 * Renders every atom in `patterns/product/primitives` at once, each embedded
 * as a JSX tag with real inputs passed from this pattern's own cells.
 *
 * This is the adopter the atoms are checked against. It is what a host doing
 * the same thing through a `cf:pattern:` import looks like with the import
 * resolved locally, so a cell that renders as `[object Object]` here would
 * render that way there too.
 */
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import AmountLedger from "../amount-ledger.tsx";
import CheckList from "../check-list.tsx";
import Counter from "../counter.tsx";
import DiceRoller from "../dice-roller.tsx";
import OptionPicker from "../option-picker.tsx";
import SortableTable from "../sortable-table.tsx";

interface AtomsDemoInput {
  score?: Writable<number | Default<3>>;
  strength?: Writable<number | Default<1>>;
  dexterity?: Writable<number | Default<1>>;
  category?: Writable<string | Default<"">>;
}

interface AtomsDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  score: number;
  statTotal: number;
}

export const AtomsDemo = pattern<AtomsDemoInput, AtomsDemoOutput>(
  ({
    score,
    strength,
    dexterity,
    category,
  }) => {
    const statTotal = computed(() =>
      (strength.get() ?? 1) + (dexterity.get() ?? 1)
    );

    return {
      [NAME]: "Primitive atoms",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>Primitive atoms</cf-heading>
          </cf-vstack>

          <cf-vscroll flex showScrollbar>
            <cf-vstack gap="4" padding="4">
              <cf-card>
                <cf-heading level={6}>SortableTable</cf-heading>
                <SortableTable
                  columns={[
                    { label: "Category", numeric: false },
                    { label: "Item", numeric: false },
                    { label: "Cost", numeric: true },
                  ]}
                  rows={[
                    { cells: ["Lodging", "Hotel Amaro", "420.00"] },
                    { cells: ["Food", "Groceries", "86.40"] },
                    { cells: ["Travel", "Train tickets", "132.10"] },
                    { cells: ["Food", "Dinner out", "54.00"] },
                    { cells: ["Travel", "Airport taxi", "39.75"] },
                  ]}
                />
              </cf-card>

              <cf-card>
                <cf-heading level={6}>AmountLedger</cf-heading>
                <AmountLedger
                  entries={[
                    { label: "Hotel Amaro", amount: 420 },
                    { label: "Groceries", amount: 86.4 },
                    { label: "Train tickets", amount: 132.1 },
                  ]}
                  budget={500}
                  label="Trip"
                />
              </cf-card>

              <cf-card>
                <cf-heading level={6}>CheckList</cf-heading>
                <CheckList
                  items={[
                    { title: "Passport", done: true, quantity: 1 },
                    { title: "Socks", done: false, quantity: 6 },
                    { title: "Charger", done: false, quantity: 2 },
                  ]}
                  showQuantity
                />
              </cf-card>

              <cf-card>
                <cf-heading level={6}>Counter</cf-heading>
                <Counter value={score} step={5} label="Score" min={0} />
              </cf-card>

              <cf-card>
                <cf-heading level={6}>DiceRoller</cf-heading>
                <cf-hstack gap="3">
                  <DiceRoller value={strength} sides={20} label="STR" />
                  <DiceRoller value={dexterity} sides={20} label="DEX" />
                </cf-hstack>
                <cf-text id="stat-total" tone="muted">
                  Stat total: {statTotal}
                </cf-text>
              </cf-card>

              <cf-card>
                <cf-heading level={6}>OptionPicker</cf-heading>
                <OptionPicker
                  options={["Food", "Travel", "Lodging"]}
                  selected={category}
                  label="Category"
                />
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      score,
      statTotal,
    };
  },
);

export default AtomsDemo;
