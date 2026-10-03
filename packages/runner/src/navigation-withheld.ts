/**
 * A navigation a host's display ceiling withheld: the host is not told where
 * the run that asked meant to go. A navigate callback throws it rather than
 * returning, so that the navigation is not recorded as made.
 *
 * `definitive` says whether the decision was made on labels, which the
 * ceiling refused: the same viewer would be refused again, so a server's
 * intent withheld this way is done for this session. Otherwise there were no
 * labels to decide on, or they could not be read, and the intent waits for a
 * delivery that can be decided.
 */
export class NavigationWithheldError extends Error {
  constructor(readonly definitive: boolean) {
    super(
      definitive
        ? "The display ceiling withheld a navigation: what chose its target " +
          "is not shown to this host."
        : "The display ceiling withheld a navigation: nothing says what chose " +
          "its target.",
    );
    this.name = "NavigationWithheldError";
  }
}
