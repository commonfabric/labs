/**
 * Test Pattern: Fair Share — the ledger as a viewer drives it
 *
 * Instantiates the whole pattern and works it through its rendered view:
 * typing into the form fields, pressing its buttons and chips, and reading
 * back both what the view shows and the `balances`, `settlements` and `total`
 * it reports.
 *
 * - An empty ledger shows every empty state.
 * - People are added by name, blank and duplicate names are refused.
 * - An expense is refused without a description, a positive amount, or a
 *   payer from the ledger; a valid one is split among everyone by default,
 *   or among the people the split chips leave selected, to the cent.
 * - Balances, the settle-up plan and the viewer's own summary follow.
 * - Removing an expense or a person keeps the ledger zero-sum.
 *
 * The viewer's `#profile` does not resolve in a pattern test, so joining with
 * a profile is covered by main.test.tsx against the exported handler.
 *
 * Run: deno task cf test patterns/examples/fair-share/ledger.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  propValue,
  setBound,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import FairShare from "./main.tsx";

const field = (ui: unknown, placeholder: string) =>
  findNodeByProp(ui, "placeholder", placeholder);

/** The `cf-select` in the smallest part of the view that shows `label`. */
const selectBy = (ui: unknown, label: string) =>
  findElement(
    innermostNode(
      ui,
      (node) =>
        hasText(node, label) && findElement(node, "cf-select") !== undefined,
    ),
    "cf-select",
  );

/** Types `name` into the new-person field and presses Add. */
const addPerson = (ui: unknown, name: string) => {
  setBound(field(ui, "Add a person…"), "$value", name);
  clickButton(ui, "Add");
};

/** Fills in the new-expense form and presses Add expense. */
const addExpense = (
  ui: unknown,
  description: string,
  amount: string,
  paidBy: string,
) => {
  setBound(field(ui, "Dinner, taxi, …"), "$value", description);
  setBound(field(ui, "0.00"), "$value", amount);
  setBound(selectBy(ui, "Paid by"), "$value", paidBy);
  clickButton(ui, "Add expense");
};

/** The person chip in the People card, which can be removed. */
const personChip = (ui: unknown, name: string) =>
  findNode(
    ui,
    (node) =>
      propValue(node, "label") === name &&
      propValue(node, "removable") === true,
  );

/** The chip that toggles `name` in the new expense's split. */
const splitChip = (ui: unknown, name: string) =>
  findNode(
    ui,
    (node) =>
      propValue(node, "label") === name &&
      propValue(node, "interactive") === true,
  );

const balanceOf = (
  balances: readonly { name: string; net: number }[],
  name: string,
) => balances.find((b) => b.name === name)?.net;

const settlementsAre = (
  settlements: readonly { from: string; to: string; amount: number }[],
  expected: string,
) =>
  settlements.map((s) => `${s.from}>${s.to}:${s.amount}`).join() === expected;

export default pattern(() => {
  // ==========================================================================
  // A ledger built up through the view
  // ==========================================================================

  const ledger = FairShare({ people: [], expenses: [], myName: "" });

  const action_add_ann = action(() => addPerson(ledger[UI], "Ann"));
  const action_add_blank = action(() => addPerson(ledger[UI], "   "));
  const action_add_bob = action(() => addPerson(ledger[UI], "Bob"));
  const action_add_cy = action(() => addPerson(ledger[UI], "Cy"));

  const action_add_without_description = action(() =>
    addExpense(ledger[UI], "  ", "30", "Ann")
  );
  const action_add_unparseable_amount = action(() =>
    addExpense(ledger[UI], "Dinner", "lots", "Ann")
  );
  const action_add_zero_amount = action(() =>
    addExpense(ledger[UI], "Dinner", "0", "Ann")
  );
  const action_add_unknown_payer = action(() =>
    addExpense(ledger[UI], "Dinner", "30", "Zed")
  );
  const action_add_dinner = action(() =>
    addExpense(ledger[UI], "Dinner", "30", "Ann")
  );

  // The first toggle starts from everyone, so it leaves Cy out; the second
  // brings Cy back, and the third leaves Cy out again.
  const action_toggle_cy = action(() => fireClick(splitChip(ledger[UI], "Cy")));
  const action_add_taxi = action(() =>
    addExpense(ledger[UI], "Taxi", "10.01", "Bob")
  );

  const action_pick_bob = action(() =>
    setBound(selectBy(ledger[UI], "or pick"), "$value", "Bob")
  );
  const action_pick_ann = action(() =>
    setBound(selectBy(ledger[UI], "or pick"), "$value", "Ann")
  );
  // Dee joins after both expenses, whose splits were fixed when they were
  // added, so Dee owes nothing and is owed nothing.
  const action_add_and_pick_dee = action(() => {
    addPerson(ledger[UI], "Dee");
    setBound(selectBy(ledger[UI], "or pick"), "$value", "Dee");
  });
  const action_remove_taxi = action(() => clickInRow(ledger[UI], "Taxi", "×"));

  const assert_names_itself = assert(() => ledger[NAME] === "Fair Share");
  const assert_empty_states = assert(() =>
    hasText(ledger[UI], "Add people to get started.") &&
    hasText(ledger[UI], "No expenses yet.") &&
    hasText(ledger[UI], "No balances to show.") &&
    hasText(ledger[UI], "Everyone is settled up. 🎉") &&
    hasText(ledger[UI], "Pick who you are to see your balance.") &&
    hasText(ledger[UI], "Total $0.00")
  );
  const assert_ann_only = assert(() =>
    ledger.people.get().map((p) => p.name).join() === "Ann" &&
    personChip(ledger[UI], "Ann") !== undefined &&
    !hasText(ledger[UI], "Add people to get started.")
  );
  // The draft clears after an add, so the field is ready for the next name.
  const assert_draft_cleared = assert(() =>
    propValue(field(ledger[UI], "Add a person…"), "$value") === ""
  );
  const assert_three_people = assert(() =>
    ledger.people.get().map((p) => p.name).join() === "Ann,Bob,Cy" &&
    ledger.balances.length === 3 &&
    hasText(ledger[UI], "Annsettled") &&
    !hasText(ledger[UI], "No balances to show.")
  );
  const assert_no_expenses = assert(() =>
    ledger.expenses.get().length === 0 && ledger.total === 0
  );
  const assert_dinner_split_three_ways = assert(() =>
    ledger.expenses.get().length === 1 &&
    ledger.expenses.get()[0].sharedBy.join() === "Ann,Bob,Cy" &&
    ledger.total === 30 &&
    balanceOf(ledger.balances, "Ann") === 20 &&
    balanceOf(ledger.balances, "Bob") === -10 &&
    balanceOf(ledger.balances, "Cy") === -10 &&
    settlementsAre(ledger.settlements, "Bob>Ann:10,Cy>Ann:10")
  );
  const assert_dinner_rendered = assert(() =>
    hasText(ledger[UI], "Ann paid · split 3 ways") &&
    hasText(ledger[UI], "Total $30.00") &&
    hasText(ledger[UI], "Annis owed $20.00") &&
    hasText(ledger[UI], "Bobowes $10.00") &&
    hasText(ledger[UI], "Cy→Ann$10.00") &&
    !hasText(ledger[UI], "No expenses yet.") &&
    !hasText(ledger[UI], "Everyone is settled up.")
  );
  // A successful add clears the description and amount for the next one.
  const assert_expense_form_cleared = assert(() =>
    propValue(field(ledger[UI], "Dinner, taxi, …"), "$value") === "" &&
    propValue(field(ledger[UI], "0.00"), "$value") === ""
  );
  const assert_cy_left_out = assert(() =>
    styleOf(splitChip(ledger[UI], "Cy"), "opacity") === "0.4" &&
    styleOf(splitChip(ledger[UI], "Ann"), "opacity") === "1"
  );
  const assert_cy_in_split = assert(() =>
    styleOf(splitChip(ledger[UI], "Cy"), "opacity") === "1"
  );
  // $10.01 between two is $5.01 and $5.00: the parts sum back to the total.
  const assert_taxi_split_two_ways = assert(() =>
    ledger.expenses.get().length === 2 &&
    ledger.expenses.get()[1].sharedBy.join() === "Ann,Bob" &&
    ledger.total === 40.01 &&
    balanceOf(ledger.balances, "Ann") === 30 - 15.01 &&
    balanceOf(ledger.balances, "Bob") === 10.01 - 15 &&
    balanceOf(ledger.balances, "Cy") === -10 &&
    settlementsAre(ledger.settlements, "Cy>Ann:10,Bob>Ann:4.99") &&
    hasText(ledger[UI], "Bob paid · split 2 ways") &&
    hasText(ledger[UI], "Total $40.01")
  );
  const assert_bob_owes = assert(() =>
    hasText(ledger[UI], "You owe $4.99") &&
    hasText(ledger[UI], "Bob (you)owes $4.99") &&
    !hasText(ledger[UI], "Ann (you)")
  );
  const assert_ann_is_owed = assert(() =>
    hasText(ledger[UI], "You are owed $14.99") &&
    hasText(ledger[UI], "Ann (you)is owed $14.99")
  );
  const assert_dee_settled = assert(() =>
    hasText(ledger[UI], "You're settled up") &&
    hasText(ledger[UI], "Dee (you)settled") &&
    balanceOf(ledger.balances, "Dee") === 0
  );
  const assert_taxi_removed = assert(() =>
    ledger.expenses.get().map((e) => e.description).join() === "Dinner" &&
    ledger.total === 30 &&
    !hasText(ledger[UI], "Taxi")
  );

  // ==========================================================================
  // Removing a person from a seeded ledger
  // ==========================================================================

  const trip = FairShare({
    myName: "",
    people: [],
    expenses: [
      {
        description: "Hotel",
        amount: 60,
        paidBy: "Ann",
        sharedBy: ["Ann", "Bob"],
        date: "2026-01-01",
      },
      // An empty split is shared by everyone in the ledger.
      {
        description: "Fuel",
        amount: 30,
        paidBy: "Bob",
        sharedBy: [],
        date: "2026-01-02",
      },
      {
        description: "Snacks",
        amount: 5,
        paidBy: "Bob",
        sharedBy: ["Cy"],
        date: "2026-01-03",
      },
      {
        description: "Tickets",
        amount: 8,
        paidBy: "Bob",
        sharedBy: ["Bob", "Cy"],
        date: "2026-01-04",
      },
      {
        description: "Gift",
        amount: 12,
        paidBy: "Cy",
        sharedBy: ["Ann", "Bob", "Cy"],
        date: "2026-01-05",
      },
      // Someone no longer in the ledger: no one is charged or credited.
      {
        description: "Ghost",
        amount: 99,
        paidBy: "Zed",
        sharedBy: ["Zed"],
        date: "2026-01-06",
      },
    ],
  });

  // The trip's people join through the view, as people join a ledger.
  const action_add_trip_ann = action(() => addPerson(trip[UI], "Ann"));
  const action_add_trip_bob = action(() => addPerson(trip[UI], "Bob"));
  const action_add_trip_cy = action(() => addPerson(trip[UI], "Cy"));
  const action_remove_cy = action(() =>
    fireEvent(personChip(trip[UI], "Cy"), "oncf-remove", {}, "Cy's chip")
  );

  // Ann: paid 60, share 30 + 10 + 4 = 44. Bob: paid 43, share 30 + 10 + 4 +
  // 4 = 48. Cy: paid 12, share 10 + 5 + 4 + 4 = 23. Zed's 99 counts toward
  // the total but toward nobody's balance.
  const assert_trip_balances = assert(() =>
    trip.total === 214 &&
    balanceOf(trip.balances, "Ann") === 16 &&
    balanceOf(trip.balances, "Bob") === -5 &&
    balanceOf(trip.balances, "Cy") === -11 &&
    settlementsAre(trip.settlements, "Cy>Ann:11,Bob>Ann:5") &&
    hasText(trip[UI], "Bob paid · split 3 ways · 2026-01-02") &&
    hasText(trip[UI], "Cy paid · split 3 ways · 2026-01-05")
  );
  // Cy's own expense goes, as does the one only Cy shared; Cy leaves the
  // Tickets split; Fuel stays shared by everyone, now two people.
  const assert_cy_removed = assert(() =>
    trip.people.get().map((p) => p.name).join() === "Ann,Bob" &&
    trip.expenses.get().map((e) => e.description).join() ===
      "Hotel,Fuel,Tickets,Ghost" &&
    trip.expenses.get()[1].sharedBy.length === 0 &&
    trip.expenses.get()[2].sharedBy.join() === "Bob" &&
    personChip(trip[UI], "Cy") === undefined &&
    hasText(trip[UI], "Bob paid · split 2 ways · 2026-01-02") &&
    hasText(trip[UI], "Bob paid · split 1 way · 2026-01-04")
  );
  // Ann: paid 60, share 30 + 15 = 45. Bob: paid 38, share 30 + 15 + 8 = 53.
  const assert_trip_still_zero_sum = assert(() =>
    balanceOf(trip.balances, "Ann") === 15 &&
    balanceOf(trip.balances, "Bob") === -15 &&
    settlementsAre(trip.settlements, "Bob>Ann:15")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_empty_states },

      // People
      { action: action_add_ann },
      { assertion: assert_ann_only },
      { assertion: assert_draft_cleared },
      { action: action_add_blank },
      { action: action_add_ann },
      { assertion: assert_ann_only },
      { action: action_add_bob },
      { action: action_add_cy },
      { assertion: assert_three_people },

      // Refused expenses
      { action: action_add_without_description },
      { action: action_add_unparseable_amount },
      { action: action_add_zero_amount },
      { action: action_add_unknown_payer },
      { assertion: assert_no_expenses },

      // Split among everyone
      { action: action_add_dinner },
      { assertion: assert_dinner_split_three_ways },
      { assertion: assert_dinner_rendered },
      { assertion: assert_expense_form_cleared },

      // Split among a chosen few
      { action: action_toggle_cy },
      { assertion: assert_cy_left_out },
      { action: action_toggle_cy },
      { assertion: assert_cy_in_split },
      { action: action_toggle_cy },
      { assertion: assert_cy_left_out },
      { action: action_add_taxi },
      { assertion: assert_taxi_split_two_ways },
      // Adding resets the split to everyone.
      { assertion: assert_cy_in_split },

      // The viewer's own summary
      { action: action_pick_bob },
      { assertion: assert_bob_owes },
      { action: action_pick_ann },
      { assertion: assert_ann_is_owed },
      { action: action_add_and_pick_dee },
      { assertion: assert_dee_settled },

      // Removing an expense
      { action: action_remove_taxi },
      { assertion: assert_taxi_removed },

      // Removing a person
      { action: action_add_trip_ann },
      { action: action_add_trip_bob },
      { action: action_add_trip_cy },
      { assertion: assert_trip_balances },
      { action: action_remove_cy },
      { assertion: assert_cy_removed },
      { assertion: assert_trip_still_zero_sum },
    ],
    ledger,
    trip,
  };
});
