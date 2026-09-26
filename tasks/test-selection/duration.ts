/**
 * A number of seconds as a person reads a duration: `2m1s` rather than
 * `121s`.
 *
 * Under ten seconds it keeps a tenth, since a test's own time is often
 * that short and rounding it away would print a cheap test as costing
 * nothing. From ten seconds on it counts whole seconds, minutes and
 * hours, leaving out the units at either end that are zero, so a lane's
 * budget reads `3m50s` and a bound reads `10m`.
 */
export function duration(seconds: number): string {
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
  const whole = Math.round(seconds);
  const parts: [number, string][] = [
    [Math.floor(whole / 3600), "h"],
    [Math.floor((whole % 3600) / 60), "m"],
    [whole % 60, "s"],
  ];
  const first = parts.findIndex(([count]) => count > 0);
  const last = parts.findLastIndex(([count]) => count > 0);
  return parts.slice(first, last + 1)
    .map(([count, unit]) => `${count}${unit}`)
    .join("");
}
