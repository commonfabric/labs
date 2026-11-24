import { pattern, UI } from "commonfabric";

function format(value: string): string {
  return value.toUpperCase();
}

interface State {
  maybeText?: string;
  suffix: string;
  items: Array<string | undefined>;
}

// FIXTURE: optional-method-calls
// Verifies: receiver and invocation optionality lower as whole computations
//   state.maybeText?.trim()                     → lift preserving receiver ?.
//   state.maybeText?.replace?.("x", state.suffix) → lift preserving both ?.
//   item?.trim?.()                              → callback lift preserving both ?.
//   format?.(state.maybeText ?? "")              → lift preserving lazy args
// Context: Optionality modifies an otherwise supported call;
//          the underlying call's provenance and lowering route stay unchanged.
export default pattern<State>((state) => ({
  normalized: state.maybeText?.trim(),
  selected: format?.(state.maybeText ?? ""),
  [UI]: (
    <div>
      <p>{state.maybeText?.replace?.("x", state.suffix)}</p>
      {state.items.map((item) => <span>{item?.trim?.()}</span>)}
    </div>
  ),
}));
