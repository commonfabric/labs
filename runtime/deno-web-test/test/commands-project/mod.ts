/** Two buttons in the page, the first focused. */
export function focusedPair(): { first: HTMLElement; second: HTMLElement } {
  const first = document.createElement("button");
  const second = document.createElement("button");
  document.body.append(first, second);
  first.focus();
  return { first, second };
}
