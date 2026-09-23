/**
 * Tests AmountLedger: that the total is the sum of the rows to the penny, and
 * that the budget reports both directions.
 *
 * Run: deno task cf test packages/patterns/primitives/amount-ledger.test.tsx
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findNode,
  fireClick,
  isButton,
  textContent,
} from "../test/vnode-helpers.ts";

import AmountLedger from "./amount-ledger.tsx";

export default pattern(() => {
  const ledger = AmountLedger({ budget: 500 });
  const free = AmountLedger({});
  const parentEntries = new Writable.perSpace([
    { label: "Bread", amount: 4 },
    { label: "Cheese", amount: 6 },
  ]);
  const seeded = AmountLedger({ entries: parentEntries });
  const external = AmountLedger({
    entries: new Writable.perSpace([
      { label: "Bread", amount: 4 },
      { label: "Cheese", amount: 6 },
    ]),
  });
  const firstDuplicate = new Writable.perSpace({ label: "Milk", amount: 3.5 });
  const secondDuplicate = new Writable.perSpace({ label: "Milk", amount: 3.5 });
  const duplicateEntries = new Writable.perSpace<
    { label: string; amount: number }[]
  >([]);
  const duplicates = AmountLedger({ entries: duplicateEntries });
  // A sub-cent amount a host passed directly rather than through `addEntry`,
  // which rounds on the way in. Rows and total are both formatted from the
  // same rounded cents, so 0.015 reads $0.02 in both — never the $0.01 that
  // formatting the raw amount would give, since `toFixed` and `Math.round`
  // split a half-cent differently.
  const subCent = AmountLedger({ entries: [{ label: "Odd", amount: 0.015 }] });

  const addHotel = action(() =>
    ledger.addEntry.send({ label: "Hotel", amount: 420 })
  );
  const addFood = action(() =>
    ledger.addEntry.send({ label: "Groceries", amount: 86.4 })
  );
  const addBlank = action(() =>
    ledger.addEntry.send({ label: "   ", amount: 10 })
  );
  const removeFirst = action(() =>
    ledger.removeEntry.send({ entry: ledger.entries[0] })
  );
  // Thirds are where a float total drifts away from the rows that produced it.
  const addThirds = action(() => {
    free.addEntry.send({ label: "a", amount: 0.1 });
    free.addEntry.send({ label: "b", amount: 0.2 });
  });

  return {
    [TESTS]: [
      { assertion: assert(() => ledger.total === 0) },
      { assertion: assert(() => ledger.entryCount === 0) },
      { assertion: assert(() => ledger.overBudget === false) },

      { action: addHotel },
      { assertion: assert(() => ledger.total === 420) },
      { assertion: assert(() => ledger.formattedTotal === "$420.00") },
      { assertion: assert(() => ledger.remaining === 80) },

      { action: addFood },
      { assertion: assert(() => ledger.total === 506.4) },
      { assertion: assert(() => ledger.formattedTotal === "$506.40") },
      // Past the budget, `remaining` goes negative and `overBudget` says so.
      { assertion: assert(() => ledger.remaining === -6.4) },
      { assertion: assert(() => ledger.overBudget === true) },

      // An entry with no label is not an expense anyone can read.
      { action: addBlank },
      { assertion: assert(() => ledger.entryCount === 2) },

      { action: removeFirst },
      { assertion: assert(() => ledger.entryCount === 1) },
      { assertion: assert(() => ledger.total === 86.4) },

      // Summed in cents, so the total equals the rows rather than 0.30000000000000004.
      { action: addThirds },
      { assertion: assert(() => free.total === 0.3) },
      { assertion: assert(() => free.formattedTotal === "$0.30") },
      // With no budget there is nothing to be over.
      { assertion: assert(() => free.overBudget === false) },
      { assertion: assert(() => free.remaining === 0) },

      // The rendered row and the total agree to the penny.
      { assertion: assert(() => subCent.formattedTotal === "$0.02") },
      { assertion: assert(() => textContent(subCent[UI]).includes("$0.02")) },
      { assertion: assert(() => !textContent(subCent[UI]).includes("$0.01")) },

      // Both budget arms are rendered text, not merely numbers on the output.
      // Only Groceries remains here, so the ledger is under its 500 budget.
      { assertion: assert(() => textContent(ledger[UI]).includes("Left")) },
      { assertion: assert(() => textContent(ledger[UI]).includes("$413.60")) },
      { assertion: assert(() => ledger[NAME] === "Expenses: $86.40") },
      // Push it over, and the other arm renders instead.
      {
        action: action(() =>
          ledger.addEntry.send({ label: "Flights", amount: 500 })
        ),
      },
      {
        assertion: assert(() =>
          textContent(ledger[UI]).includes("Over budget by")
        ),
      },
      // Removing through the row's own button rather than the exported stream.
      { action: action(() => clickButton(ledger[UI], "Remove")) },
      { assertion: assert(() => ledger.entryCount === 1) },

      // The Add button reads the label and amount drafts; with nothing typed
      // it adds no entry rather than a blank one at zero.
      { action: action(() => clickButton(ledger[UI], "Add")) },
      { assertion: assert(() => ledger.entryCount === 1) },

      // Constructor-seeded rows retain their parent's slot identity.
      { render: seeded[UI] },
      { assertion: assert(() => parentEntries.get().length === 2) },
      { assertion: assert(() => seeded.total === 10) },
      { action: action(() => clickButton(seeded[UI], "Remove")) },
      { assertion: assert(() => parentEntries.get().length === 1) },
      { assertion: assert(() => parentEntries.get()[0].label === "Cheese") },
      { assertion: assert(() => seeded.entryCount === 1) },
      { assertion: assert(() => seeded.total === 6) },
      {
        action: action(() =>
          external.removeEntry.send({ entry: external.entries[0] })
        ),
      },
      { assertion: assert(() => external.entries.length === 1) },
      { assertion: assert(() => external.entries[0].label === "Cheese") },
      { assertion: assert(() => external.total === 6) },

      {
        action: action(() =>
          duplicateEntries.push(firstDuplicate, secondDuplicate)
        ),
      },
      { render: duplicates[UI] },
      {
        action: action(() => {
          let index = 0;
          fireClick(findNode(
            duplicates[UI],
            (node) => isButton("Remove")(node) && index++ === 1,
          ));
        }),
      },
      { assertion: assert(() => duplicates.entries.length === 1) },
      { assertion: assert(() => duplicates.total === 3.5) },
      {
        assertion: assert(() =>
          Writable.equals(duplicates.entries[0], firstDuplicate)
        ),
      },
      {
        assertion: assert(() =>
          !Writable.equals(duplicates.entries[0], secondDuplicate)
        ),
      },
    ],
  };
});
