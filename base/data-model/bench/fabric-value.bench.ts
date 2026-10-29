/**
 * isArrayIndexPropertyName() Performance Benchmarks
 *
 * Tests performance of array index validation for:
 * 1. Typical mix of property names and array indices
 * 2. Large numbers that require the numeric comparison path
 */

import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

// Pre-generate test data to avoid allocation during benchmarks

// Typical mix: property names (1-20 chars) and index strings (1-10 chars)
const typicalMix: string[] = [];
// Property-like names
for (let i = 0; i < 50; i++) {
  const len = 1 + (i % 20);
  typicalMix.push("a".repeat(len) + i);
}
// Valid array indices (1-10 digit numbers, no leading zeros)
for (let i = 0; i < 50; i++) {
  typicalMix.push(String(i * 12345).slice(0, 1 + (i % 10)));
}
// Some edge cases
typicalMix.push("0", "1", "9", "10", "99", "100", "999", "length", "toString");
// Invalid indices that look numeric
typicalMix.push("01", "007", "+1", "-1", "1.5", "1e5", "0x10");

// Large numbers, which should exercise the longest possible code paths.
const largeNumbers: string[] = [];
// Valid large indices (under 2**31 = 2147483648)
for (let i = 0; i < 50; i++) {
  largeNumbers.push(String(1000000000 + i * 20000000)); // 1B to ~2B range
}
// Invalid large indices (over 2**31)
for (let i = 0; i < 50; i++) {
  largeNumbers.push(String(2200000000 + i * 10000000)); // 2.2B+ range
}

Deno.bench({
  name: "isArrayIndexPropertyName - typical mix (names + indices)",
  group: "isArrayIndexPropertyName",
  baseline: true,
  fn() {
    for (const str of typicalMix) {
      isArrayIndexPropertyName(str);
    }
  },
});

Deno.bench({
  name: "isArrayIndexPropertyName - large numbers (10-digit, numeric compare)",
  group: "isArrayIndexPropertyName",
  fn() {
    for (const str of largeNumbers) {
      isArrayIndexPropertyName(str);
    }
  },
});
