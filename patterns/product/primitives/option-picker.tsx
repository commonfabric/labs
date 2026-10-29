/**
 * Picks one string out of a supplied list of options, through a dropdown
 * two-way bound to the caller's cell, with the empty string standing for
 * nothing picked.
 *
 * Embed it as `<OptionPicker options={categories} selected={category} />` and
 * the host's cell holds whatever is picked; the host reads one field rather
 * than a value and a flag.
 *
 * The `select` stream is there for a host or an agent that sets the choice
 * without a click, and it refuses a value that is not on offer.
 *
 * @hashtags picker, select, options, category, status, dropdown
 * @keywords choose, pick one, select an option, dropdown, category, status,
 * type, kind, single choice, enum, classification, tag one
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface OptionPickerInput {
  /** The values on offer. */
  options?: Writable<string[] | Default<[]>>;

  /** The value picked; the empty string while nothing is. */
  selected?: Writable<string | Default<"">>;

  /** Heading shown above the dropdown. */
  label?: Writable<string | Default<"Choose">>;

  /** Text for the entry that stands for "nothing picked". */
  placeholder?: Writable<string | Default<"None">>;
}

export interface OptionPickerOutput {
  [NAME]: string;
  [UI]: VNode;
  selected: string;
  hasSelection: boolean;
  options: string[];
  select: Stream<{ option: string }>;
  clear: Stream<void>;
}

export const OptionPicker = pattern<OptionPickerInput, OptionPickerOutput>(
  ({ options, selected, label, placeholder }) => {
    // A choice that is not on offer would leave the dropdown showing the
    // placeholder while `selected` said otherwise, so it is refused.
    const select = action(({ option }: { option: string }) => {
      if (!options.get().includes(option)) return;
      selected.set(option);
    });

    const clear = action(() => {
      selected.set("");
    });

    const hasSelection = computed(() => (selected.get() ?? "") !== "");
    const items = computed(() => [
      { label: placeholder.get(), value: "" },
      ...options.get().map((option) => ({ label: option, value: option })),
    ]);

    return {
      [NAME]: computed(() =>
        `${label.get()}: ${hasSelection ? selected.get() : "none"}`
      ),
      [UI]: (
        <cf-vstack gap="2" padding="3">
          <cf-text tone="muted">{label}</cf-text>
          <cf-select
            $value={selected}
            items={items}
            style="width: 100%;"
          />
        </cf-vstack>
      ),
      selected,
      hasSelection,
      options,
      select,
      clear,
    };
  },
);

export default OptionPicker;
