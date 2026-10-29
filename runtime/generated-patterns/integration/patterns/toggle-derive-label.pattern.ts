import { Cell, Default, handler, pattern } from "commonfabric";

interface ToggleArgs {
  active: Default<boolean, false>;
}

const toggleState = handler(
  (_event: unknown, context: { active: Cell<boolean> }) => {
    const current = context.active.get() ?? false;
    context.active.set(!current);
  },
);

export const toggleWithLabel = pattern<ToggleArgs>(
  ({ active }) => {
    const status = active ? "enabled" : "disabled";

    return {
      active,
      status,
      toggle: toggleState({ active }),
    };
  },
);

export default toggleWithLabel;
