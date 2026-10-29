/**
 * Budget Tracker - Shared Schemas
 *
 * Type definitions used across all budget tracker sub-patterns.
 */
import { Default } from "commonfabric";

// ============ CORE TYPES ============

export interface Expense {
  description: string;
  amount: number;
  category: string | Default<"Other">;
  date: string; // YYYY-MM-DD
}

export interface CategoryBudget {
  category: string;
  limit: number;
}

export interface BudgetStatusItem {
  category: string;
  spent: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
}

// ============ HELPER FUNCTIONS ============

// `nowMs` is the current time in epoch milliseconds. Callers in a handler pass
// Date.now(); callers in a lift pass a reactive #now value.
export const getTodayDate = (nowMs: number): string => {
  return new Date(nowMs).toISOString().split("T")[0];
};
