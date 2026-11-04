// Stream nested inside a Reactive-wrapped value.
// This mimics BuiltInLLMState, where cancelGeneration: Stream<void> is
// returned inside Reactive<BuiltInLLMState>.

// Reactive<T> is an identity alias (= T): the reactive annotation erases to T,
// so the wrapper itself contributes no schema metadata (no asCell).
type Reactive<T> = T;

// This mimics BuiltInLLMState structure
interface LLMState {
  pending: boolean;
  result?: string;
  error: unknown;
  cancelGeneration: Stream<void>;
}

interface SchemaRoot {
  state: Reactive<LLMState>;
}
