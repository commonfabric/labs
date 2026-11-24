/**
 * Budget Tracker with a confidential note field.
 *
 * The same tracker as `main.tsx`, under a contract whose `description` carries
 * an `ifc` confidentiality label. It is a separate pattern rather than a
 * change to the tracker's own schema because an `ifc` change is not backward
 * compatible: data existing pieces wrote under the public contract cannot be
 * retroactively relabelled, so the labelled contract needs its own baseline
 * history. A space seeded through this pattern persists a declared label on
 * every record's `description` while `amount`, `category`, and `date` stay
 * inert — which is what lets a flow-label-persisting runtime refuse a
 * description-derived write while admitting aggregates over the inert fields.
 */
import {
  type Confidential,
  Default,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import { type CategoryBudget } from "./schemas.tsx";
import DataView from "./data-view.tsx";
import ExpenseForm from "./expense-form.tsx";

export interface ConfidentialExpense {
  description: Confidential<string, readonly ["expense-note"]>;
  amount: number;
  category: string | Default<"Other">;
  date: string; // YYYY-MM-DD
}

// Single type parameter, matching `main.tsx`.
interface State {
  expenses: Writable<ConfidentialExpense[] | Default<[]>>;
  budgets: Writable<CategoryBudget[] | Default<[]>>;
}

export default pattern<State>(({ expenses, budgets }) => {
  const dataView = DataView({ expenses, budgets });
  const expenseForm = ExpenseForm({ expenses, budgets });

  return {
    [NAME]: "Budget Tracker (confidential notes)",
    [UI]: (
      <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
        <div style={{ flex: 1 }}>{expenseForm}</div>
        <div style={{ flex: 1 }}>{dataView}</div>
      </div>
    ),
    expenses,
    budgets,
  };
});
