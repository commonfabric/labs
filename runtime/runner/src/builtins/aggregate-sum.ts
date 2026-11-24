/**
 * Combines binary64 sums without intermediate rounding. Finite values are
 * represented in units of the smallest positive subnormal, so tree shape and
 * edit history cannot change the rounded result;
 * `docs/features/collection-aggregates.md` explains why.
 */

/** Exact finite total and non-finite contributions of an aggregate subtree. */
export interface AggregateSum {
  /** Signed total in units of 2^-1074. */
  finite: bigint;

  /** Whether this subtree contains NaN. */
  nan: boolean;

  /** Whether this subtree contains positive infinity. */
  positiveInfinity: boolean;

  /** Whether this subtree contains negative infinity. */
  negativeInfinity: boolean;
}

/** Encodes one number without rounding its finite contribution. */
export function aggregateSumLeaf(value: number): AggregateSum {
  let finite = 0n;
  if (Number.isFinite(value) && value !== 0) {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, value);
    const encoded = bits.getBigUint64(0);
    const exponent = Number((encoded >> 52n) & 0x7ffn);
    const fraction = encoded & ((1n << 52n) - 1n);
    const magnitude = exponent === 0
      ? fraction
      : (fraction | (1n << 52n)) << BigInt(exponent - 1);
    finite = value < 0 ? -magnitude : magnitude;
  }
  return {
    finite,
    nan: Number.isNaN(value),
    positiveInfinity: value === Infinity,
    negativeInfinity: value === -Infinity,
  };
}

/** Combines exact subtree totals without subtracting removed contributions. */
export function combineAggregateSums(
  left: AggregateSum,
  right: AggregateSum,
): AggregateSum {
  return {
    finite: left.finite + right.finite,
    nan: left.nan || right.nan,
    positiveInfinity: left.positiveInfinity || right.positiveInfinity,
    negativeInfinity: left.negativeInfinity || right.negativeInfinity,
  };
}

/** Rounds an exact sum to binary64, with ties to even and positive zero. */
export function aggregateSumValue(sum: AggregateSum): number {
  if (sum.nan || (sum.positiveInfinity && sum.negativeInfinity)) return NaN;
  if (sum.positiveInfinity) return Infinity;
  if (sum.negativeInfinity) return -Infinity;
  const negative = sum.finite < 0n;
  const magnitude = negative ? -sum.finite : sum.finite;
  if (magnitude === 0n) return 0;
  const shift = Math.max(0, magnitude.toString(2).length - 53);
  let significand = magnitude >> BigInt(shift);
  if (shift > 0) {
    const remainder = magnitude - (significand << BigInt(shift));
    const halfway = 1n << BigInt(shift - 1);
    if (
      remainder > halfway ||
      (remainder === halfway && (significand & 1n) !== 0n)
    ) {
      significand++;
    }
  }
  const value = Number(significand) * 2 ** (shift - 1074);
  return negative ? -value : value;
}
