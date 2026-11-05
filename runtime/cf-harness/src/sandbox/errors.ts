/**
 * A tool asked a sandbox to resolve a path that escapes its allowed roots.
 *
 * Why a dedicated type: this is the ONE `resolvePath` failure a tool may treat
 * as RECOVERABLE — the model passed a bad path and can retry with a valid one,
 * so the bash tool surfaces it as a failed result instead of letting it become
 * a run-fatal throw (see tools/bash.ts). `SandboxRuntime.resolvePath` is an
 * injected interface whose contract does not otherwise restrict its failures,
 * so tools must narrow by THIS TYPE — never by matching the message string, and
 * never by catching every `resolvePath` throw (a corrupt-runtime or invariant
 * failure must stay fatal).
 */
export class SandboxPathEscapeError extends Error {
  readonly attemptedPath: string;

  constructor(attemptedPath: string, message?: string) {
    super(message ?? `path escapes allowed sandbox roots: ${attemptedPath}`);
    this.name = "SandboxPathEscapeError";
    this.attemptedPath = attemptedPath;
  }
}
