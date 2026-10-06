/**
 * Test Pattern: Profile Create — defaultName prefill (CT-1831)
 *
 * Embedders (e.g. Loom) often already know the user's name at setup; without
 * a prefill, first-run re-asks a question the product already knows the
 * answer to. `defaultName` seeds the create field's *starting text only* — it
 * must not change the trusted-click create path.
 *
 * Covers the PREFILL CONTRACT only:
 * - `defaultName` reaches the rendered `cf-submit-input` as `initialValue`.
 * - omitting `defaultName` leaves the field with no prefill (unchanged
 *   behavior).
 * - the trusted surface wiring is identical in both cases: the same
 *   `data-ui-action` on the field and the same exported `createProfile`
 *   stream bound to the submit click — the prefill never adds an alternate
 *   create path, and nothing is created at render time (no auto-submit).
 *
 * NOT COVERED HERE: firing `createProfile`. The create pushes
 * `ProfileHome.inSpace()`, and the full create flow — the `inSpace()`
 * materialization and the owner-protected write included — is covered
 * end-to-end by packages/runner/test/profile-create-real-card-add.test.ts.
 *
 * Run: deno task cf test packages/patterns/system/profile-create.test.tsx --verbose
 */
import { assert, pattern, TESTS, UI, Writable } from "commonfabric";
import ProfileCreate, {
  TRUSTED_PROFILE_CREATE_ACTION,
} from "./profile-create.tsx";
import type { ProfileHomeOutput } from "./profile-home.tsx";

// Minimal VNode shape (see packages/html/src/h.ts `h()`): plain data holding
// the compiled tree. Attribute VALUES are compiled into cell/lift references
// (not raw literals, even for plain string props), so callers read them with
// `propValue()` below rather than comparing directly.
interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

// Depth-first search for the first descendant (or self) VNode with the given
// tag name.
function findByTag(node: unknown, tag: string): TestVNode | undefined {
  if (!isVNode(node)) return undefined;
  if (node.name === tag) return node;
  for (const child of node.children ?? []) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return undefined;
}

// Reads a compiled JSX prop's underlying value. The transformer wraps every
// attribute expression (even plain string literals like
// `data-ui-action="CreateProfile"`) in a lift/cell reference, so a prop reads
// as a `CellImpl` with a `.get()` rather than the raw value.
// deno-lint-ignore no-explicit-any
function propValue(value: any): unknown {
  return value && typeof value.get === "function" ? value.get() : value;
}

export default pattern(() => {
  // Instance WITHOUT defaultName — must render with no prefill, matching
  // pre-CT-1831 behavior exactly.
  const profilesNoDefault = new Writable<ProfileHomeOutput[]>([]);
  const withoutDefault = ProfileCreate({ profiles: profilesNoDefault });

  // Instance WITH defaultName — must prefill the field.
  const profilesWithDefault = new Writable<ProfileHomeOutput[]>([]);
  const withDefault = ProfileCreate({
    profiles: profilesWithDefault,
    defaultName: "Ada",
  });

  // === Assertions: no defaultName → no prefill, surface untouched ===
  const assert_no_default_has_no_initial_value = assert(() => {
    const input = findByTag(withoutDefault[UI], "cf-submit-input");
    if (!input) return false;
    const initialValue = propValue(input.props.initialValue);
    return initialValue === undefined || initialValue === "";
  });
  const assert_no_default_action_wired = assert(() => {
    const input = findByTag(withoutDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props["data-ui-action"]) ===
      TRUSTED_PROFILE_CREATE_ACTION;
  });

  // === Assertions: defaultName prefills, everything else unchanged ===
  const assert_default_seeds_initial_value = assert(() => {
    const input = findByTag(withDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props.initialValue) === "Ada";
  });
  const assert_default_action_still_wired = assert(() => {
    const input = findByTag(withDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props["data-ui-action"]) ===
      TRUSTED_PROFILE_CREATE_ACTION;
  });

  // === Assertions: create path wiring is identical in both cases ===
  // The submit click must reach the SAME handler path whether or not a
  // prefill was supplied: the exported `createProfile` stream exists and the
  // field's onClick is bound. (Firing the stream — the cross-space create —
  // is covered in the runner lane; see the header comment.)
  const assert_no_default_create_wiring = assert(() => {
    const input = findByTag(withoutDefault[UI], "cf-submit-input");
    return input !== undefined &&
      input.props.onClick !== undefined &&
      withoutDefault.createProfile !== undefined;
  });
  const assert_default_create_wiring = assert(() => {
    const input = findByTag(withDefault[UI], "cf-submit-input");
    return input !== undefined &&
      input.props.onClick !== undefined &&
      withDefault.createProfile !== undefined;
  });

  // Neither instance creates a profile at render time — the prefill is not
  // auto-submitted.
  const assert_no_default_no_autocreate = assert(() =>
    (profilesNoDefault.get()?.length ?? 0) === 0
  );
  const assert_default_no_autocreate = assert(() =>
    (profilesWithDefault.get()?.length ?? 0) === 0
  );

  return {
    [TESTS]: [
      // No defaultName → no prefill, wiring unchanged
      { assertion: assert_no_default_has_no_initial_value },
      { assertion: assert_no_default_action_wired },
      { assertion: assert_no_default_create_wiring },
      { assertion: assert_no_default_no_autocreate },

      // With defaultName → prefilled, wiring identical, no auto-submit
      { assertion: assert_default_seeds_initial_value },
      { assertion: assert_default_action_still_wired },
      { assertion: assert_default_create_wiring },
      { assertion: assert_default_no_autocreate },
    ],
  };
});
