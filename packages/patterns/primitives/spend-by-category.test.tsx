import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";

import { textContent } from "../test/vnode-helpers.ts";
import SpendByCategory, {
  type SpendTransaction,
} from "./spend-by-category.tsx";

export default pattern(() => {
  const rows = new Writable<SpendTransaction[]>([
    { category_primary: "FOOD", amount: 20, iso_currency_code: "USD" },
    { category_primary: "TRAVEL", amount: 10, iso_currency_code: "USD" },
    { category_primary: "INCOME", amount: 100, iso_currency_code: "USD" },
  ]);
  const includeIncome = new Writable(false);
  const spending = SpendByCategory({ rows, includeIncome });
  const mixed = SpendByCategory({
    rows: [
      { category_primary: "FOOD", amount: 10, iso_currency_code: "USD" },
      { category_primary: "FOOD", amount: 20, iso_currency_code: "EUR" },
    ],
  });
  const excludedIncome = SpendByCategory({
    rows: [
      { category_primary: "FOOD", amount: 10, iso_currency_code: "USD" },
      { category_primary: "INCOME", amount: 20, iso_currency_code: "EUR" },
    ],
  });

  return {
    [TESTS]: [
      {
        assertion: assert(() => spending[NAME] === "Spending by category (2)"),
      },
      { assertion: assert(() => spending.grandTotal === 30) },
      { assertion: assert(() => spending.categoryCount === 2) },
      { assertion: assert(() => spending.currency === "USD") },
      {
        assertion: assert(() =>
          textContent(spending[UI]).includes("FOOD") &&
          textContent(spending[UI]).includes("TRAVEL") &&
          textContent(spending[UI]).indexOf("FOOD") <
            textContent(spending[UI]).indexOf("TRAVEL")
        ),
      },
      { action: action(() => includeIncome.set(true)) },
      { assertion: assert(() => spending.grandTotal === 130) },
      { assertion: assert(() => spending.categoryCount === 3) },
      {
        action: action(() =>
          rows.set([
            { category_primary: "FOOD", amount: 5, iso_currency_code: "USD" },
            {
              category_primary: "TRAVEL",
              amount: 40,
              iso_currency_code: "USD",
            },
          ])
        ),
      },
      { assertion: assert(() => spending.grandTotal === 45) },
      { assertion: assert(() => spending.categories[0].category === "TRAVEL") },
      {
        assertion: assert(() =>
          textContent(spending[UI]).includes("FOOD") &&
          textContent(spending[UI]).includes("TRAVEL") &&
          textContent(spending[UI]).indexOf("TRAVEL") <
            textContent(spending[UI]).indexOf("FOOD")
        ),
      },
      { assertion: assert(() => mixed.categories.length === 0) },
      { assertion: assert(() => mixed.grandTotal === 0) },
      { assertion: assert(() => mixed.currency === "") },
      {
        assertion: assert(() =>
          mixed.errorMessage ===
            "Cannot total multiple currencies. Supply rows in one currency."
        ),
      },
      {
        assertion: assert(() =>
          textContent(mixed[UI]).includes("multiple currencies")
        ),
      },
      { assertion: assert(() => excludedIncome.grandTotal === 10) },
      { assertion: assert(() => excludedIncome.currency === "USD") },
      { assertion: assert(() => excludedIncome.errorMessage === "") },
    ],
  };
});
