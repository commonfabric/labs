/**
 * Describes an arbitrary failure without letting a failed conversion replace
 * the original error handling and its retained evidence.
 */
export const errorMessage = (error: unknown): string => {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "error could not be converted to text";
  }
};
