/**
 * Logs each promise rejection that nothing handles in this realm, and marks it
 * handled, so that the process or worker keeps running. A long-running host
 * that runs patterns installs it: a promise that a pattern rejects and never
 * awaits is a failure of that pattern, which the host logs rather than ends
 * on. It covers every rejection in the realm, the host's own included.
 */
export function logUnhandledRejections(
  target: Pick<typeof globalThis, "addEventListener"> = globalThis,
): void {
  target.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled promise rejection:", event.reason);
    event.preventDefault();
  });
}
