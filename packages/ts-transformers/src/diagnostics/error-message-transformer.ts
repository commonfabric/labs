/**
 * Diagnostic Message Transformer
 *
 * Transforms TypeScript diagnostic messages into more user-friendly messages.
 * This allows ts-transformers to own the domain-specific error message logic
 * while js-compiler remains generic.
 */

/**
 * Builds a transform for confusing Reactive-related TypeScript errors, turning
 * them into clear, actionable messages.
 *
 * For example, transforms:
 *   "Property 'get' does not exist on type 'OpaqueCell<number> & number'"
 * Into:
 *   "Unnecessary .get() call on a reactive value. This value can be accessed directly..."
 *
 * The returned transform yields null for a message it does not rewrite. Under
 * `verbose` a rewritten message also carries the original TypeScript error,
 * which helps when debugging.
 */
export function createReactiveErrorTransformer(
  verbose = false,
): (message: string) => string | null {
  return (message: string) => {
    // Detect .get() called on OpaqueCell/Reactive types
    // TypeScript error: "Property 'get' does not exist on type 'OpaqueCell<...> & ...'"
    const match = message.match(
      /^Property 'get' does not exist on type '(OpaqueCell<[^']*>)/,
    );

    if (match) {
      const clarification = `Unnecessary .get() call on a reactive value. ` +
        `This value can be accessed directly - remove .get(). ` +
        `Reactive values passed to pattern (except Writable<T> and Stream<T>) ` +
        `and results from computed() and lift() don't need .get(). ` +
        `Only Writable<T> requires .get() to read values.`;

      if (verbose) {
        return `${clarification}\n\nOriginal TypeScript error: ${message}`;
      }
      return clarification;
    }

    const asyncResultProperty = message.match(
      /^Property '(result|pending|error|partial)' does not exist on type 'AsyncResult<.*>'/,
    );
    if (asyncResultProperty) {
      const clarification =
        "Async built-ins now return AsyncResult<T> directly. Use " +
        "resultOf(request) for usable data, isPending(request) and " +
        "hasError(request) to branch on state, and partialResultOf(request) " +
        "for intermediate output from generateTextStream() or streamData().";
      return verbose
        ? `${clarification}\n\nOriginal TypeScript error: ${message}`
        : clarification;
    }

    return null; // No transformation applies
  };
}
