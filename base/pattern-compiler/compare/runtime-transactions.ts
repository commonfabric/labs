/**
 * The store that keeps the documents of an executor in the runtime's
 * storage. It is part of the runner
 * (`runtime/runner/src/compiled/transactions.ts`); the harnesses of this
 * directory reach it here.
 */
export {
  type RecordedPlanWrite,
  type RuntimeCounts,
  RuntimeTransactions,
} from "../../../runtime/runner/src/compiled/transactions.ts";
