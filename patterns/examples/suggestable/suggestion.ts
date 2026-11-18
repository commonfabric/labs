/**
 * The prompt a suggestion pattern sends its model: `request` with `topic`
 * after it, then `details`. With no topic it is the empty prompt, which holds
 * the model request back, since a suggestion with no subject has nothing to
 * work from.
 */
export function promptAbout(
  topic: string | undefined,
  request: string,
  details = "",
): string {
  return topic ? `${request}${topic}${details}` : "";
}

/** The sum of the budget items' amounts, counting a missing amount as zero. */
export function totalAmount(items: readonly { amount?: number }[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item.amount || 0;
  }
  return sum;
}
