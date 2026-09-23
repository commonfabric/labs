import { assert, NAME, pattern, TESTS, UI } from "commonfabric";

import { findElement, propValue, textContent } from "../test/vnode-helpers.ts";
import BillsThisMonth from "./bills-this-month.tsx";

export default pattern(() => {
  const unrelated = BillsThisMonth({
    headers: [{ subject: "Your current statement", sender: "Figma" }],
    transactions: [{ merchant_name: "Rent", amount: 1200 }],
  });
  const ordinary = BillsThisMonth({
    headers: [],
    transactions: [{ merchant_name: "Current", amount: 12 }],
  });
  const gas = BillsThisMonth({
    headers: [{ subject: "Gas bill", sender: "billing@example.com" }],
    transactions: [{ merchant_name: "Gas Company", amount: 45 }],
  });
  const category = BillsThisMonth({
    headers: [],
    transactions: [{
      merchant_name: "Aster",
      amount: 42,
      category_primary: "RENT_AND_UTILITIES",
    }],
  });
  const name = BillsThisMonth({
    headers: [],
    transactions: [{
      merchant_name: "Aster",
      name: "Electric payment",
      amount: 8,
    }],
  });
  const sharedBrand = BillsThisMonth({
    headers: [
      {
        subject: "Your Sim Internet bill is ready",
        sender: "billing@example.com",
      },
      {
        subject: "Your Sim Enterprise Internet bill is ready",
        sender: "billing@example.com",
      },
      { subject: "Your Sim Gas bill is ready", sender: "billing@example.com" },
      { subject: "Your Sim statement", sender: "billing@example.com" },
    ],
    transactions: [
      { merchant_name: "Sim Enterprise Internet", amount: 80 },
      { merchant_name: "Sim Internet", amount: 60 },
      { merchant_name: "Sim Gas", amount: 45 },
      {
        merchant_name: "Sim",
        category_primary: "RENT_AND_UTILITIES",
        amount: 100,
      },
    ],
  });
  const shortNames = BillsThisMonth({
    headers: [{ subject: "Your Sim statement", sender: "billing@example.com" }],
    transactions: [
      {
        merchant_name: "Sim A",
        amount: 10,
        category_primary: "RENT_AND_UTILITIES",
      },
      {
        merchant_name: "Sim B",
        amount: 20,
        category_primary: "RENT_AND_UTILITIES",
      },
    ],
  });
  const tokenless = BillsThisMonth({
    headers: [{ subject: "Your Sim statement", sender: "billing@example.com" }],
    transactions: [
      { merchant_name: "Sim Gas", amount: 10 },
      { merchant_name: "Sim Internet", amount: 20 },
      {
        merchant_name: "A",
        amount: 30,
        category_primary: "RENT_AND_UTILITIES",
      },
    ],
  });

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          sharedBrand[NAME] === "Bills this month (1 unpaid, 3 paid)"
        ),
      },
      {
        assertion: assert(() =>
          textContent(sharedBrand[UI]).includes("Unpaid (1)") &&
          textContent(sharedBrand[UI]).includes("Paid (3)") &&
          textContent(sharedBrand[UI]).includes("Payments with no email (1)")
        ),
      },
      {
        assertion: assert(() => textContent(gas[UI]).includes("45.00")),
      },
      {
        assertion: assert(() => textContent(category[UI]).includes("42.00")),
      },
      {
        assertion: assert(() =>
          propValue(findElement(ordinary[UI], "cf-empty-state"), "message") ===
            "Nothing this month reads as a bill."
        ),
      },
      { assertion: assert(() => unrelated.paidCount === 0) },
      { assertion: assert(() => unrelated.unpaidCount === 1) },
      { assertion: assert(() => unrelated.unmatchedCount === 1) },
      { assertion: assert(() => ordinary.unmatchedCount === 0) },
      { assertion: assert(() => gas.paidCount === 1) },
      { assertion: assert(() => gas.paid[0].matchedOn === "gas") },
      { assertion: assert(() => gas.unpaidCount === 0) },
      { assertion: assert(() => gas.unmatchedCount === 0) },
      { assertion: assert(() => category.unmatchedCount === 1) },
      { assertion: assert(() => name.unmatchedCount === 1) },
      { assertion: assert(() => sharedBrand.paidCount === 3) },
      { assertion: assert(() => sharedBrand.unpaidCount === 1) },
      { assertion: assert(() => sharedBrand.unmatchedCount === 1) },
      { assertion: assert(() => shortNames.paidCount === 0) },
      { assertion: assert(() => shortNames.unpaidCount === 1) },
      { assertion: assert(() => shortNames.unmatchedCount === 2) },
      { assertion: assert(() => tokenless.paidCount === 0) },
      { assertion: assert(() => tokenless.unpaidCount === 1) },
      { assertion: assert(() => tokenless.unmatchedCount === 3) },
      {
        assertion: assert(() =>
          sharedBrand.paid.some((bill) =>
            bill.subject === "Your Sim Internet bill is ready" &&
            bill.merchant === "Sim Internet" && bill.amount === 60
          )
        ),
      },
      {
        assertion: assert(() =>
          sharedBrand.paid.some((bill) =>
            bill.subject === "Your Sim Enterprise Internet bill is ready" &&
            bill.merchant === "Sim Enterprise Internet" && bill.amount === 80
          )
        ),
      },
    ],
  };
});
