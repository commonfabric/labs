/**
 * A user-facing error from `cf view` — bad input, no input, no TTY. The command
 * action prints its message plainly (no stack trace) and exits non-zero, so an
 * expected condition like empty input does not look like a crash.
 */
export class ViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewError";
  }
}
