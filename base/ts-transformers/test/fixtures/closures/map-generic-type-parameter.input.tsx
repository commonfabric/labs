import { pattern, Reactive } from "commonfabric";

interface Email {
  id: string;
  content: string;
}

interface State {
  emails: Reactive<Email[]>;
  prompt: string;
}

/**
 * Test that generic type parameters (like T) are NOT captured as closed-over
 * variables. Type parameters are compile-time only and don't exist at runtime.
 *
 * The bug was: when a generic function used T inside a .map() callback,
 * the closure transformer would try to capture T as: { T: T, prompt: prompt }
 * This caused "ReferenceError: T is not defined" at runtime.
 */
function processWithType<T>(emails: Reactive<Email[]>, _prompt: string) {
  // T is used here but should NOT be captured - it's a type, not a value
  return emails.map((email: Email) => {
    // The type annotation <T> should not cause T to be captured
    const result = { id: email.id, type: "processed" as T };
    return result;
  });
}

export default pattern<State>((state) => {
  const results = processWithType<string>(state.emails, state.prompt);
  return { results };
});
