import type ts from "typescript";

export const AVAILABILITY_REASONS = [
  "pending",
  "error",
  "syncing",
  "schemaMismatch",
] as const;

export type AvailabilityReason = typeof AVAILABILITY_REASONS[number];

export interface AvailabilityObservation {
  readonly source: ts.Expression;
  readonly reasons: readonly AvailabilityReason[];
}

export function isAvailabilityReason(
  value: string,
): value is AvailabilityReason {
  return (AVAILABILITY_REASONS as readonly string[]).includes(value);
}
