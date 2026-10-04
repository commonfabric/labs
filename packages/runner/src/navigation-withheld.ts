/**
 * A navigation a host's display ceiling withheld: the host is not told where
 * the run that asked meant to go. A navigate callback throws it rather than
 * returning, so that the navigation is not recorded as made.
 *
 * `definitive` says whether the same viewer would be refused again: the
 * labels were read and refused, and none of them depends on what the worker
 * may yet learn, such as a space's access list or a module policy's
 * manifest. A server's intent withheld this way is done for this session.
 * Otherwise the decision can still change: there were no labels to decide
 * on, they could not be read, or they were refused on what the worker has
 * not yet learned, and the intent waits for a delivery that can be decided.
 */
export class NavigationWithheldError extends Error {
  constructor(readonly definitive: boolean) {
    super(
      definitive
        ? "The display ceiling withheld a navigation: what chose its target " +
          "is not shown to this host."
        : "The display ceiling withheld a navigation, for now: what chose " +
          "its target cannot yet be shown to this host.",
    );
    this.name = "NavigationWithheldError";
  }
}
