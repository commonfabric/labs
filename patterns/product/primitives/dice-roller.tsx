/**
 * Rolls a die of a configurable number of sides and holds the most recent
 * result, exposing both that value and a roll stream a host can fire itself.
 *
 * Embed several as `<DiceRoller value={strength} sides={20} label="STR" />`
 * and each writes its own roll back to the host's cell, so the host can total
 * them or read them independently.
 *
 * @hashtags dice, random, roll, d20, generator
 * @keywords roll dice, random number, die, d6, d20, randomize, chance,
 * generate a number, pick a number, random integer, shuffle
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

export interface DiceRollerInput {
  /** The most recent roll. A host passes its own cell to read it back. */
  value?: Writable<number | Default<1>>;

  /** How many faces the die has; a roll lands between 1 and this. */
  sides?: Writable<number | Default<6>>;

  /** Caption shown under the rolled number. */
  label?: Writable<string | Default<"Roll">>;
}

export interface DiceRollerOutput {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  sides: number;
  roll: Stream<{ sides?: number }>;
}

/** `sides` reduced to a usable face count, whatever the caller supplied. */
const faceCount = (sides: number | undefined): number => {
  const floored = Math.floor(Number(sides));
  return Number.isFinite(floored) && floored > 0 ? floored : 6;
};

export const DiceRoller = pattern<DiceRollerInput, DiceRollerOutput>(
  ({ value, sides, label }) => {
    const roll = action((event: { sides?: number }) => {
      const faces = faceCount(event?.sides ?? sides.get());
      value.set(Math.floor(Math.random() * faces) + 1);
    });

    const caption = computed(() =>
      `${label.get()} (d${faceCount(sides.get())})`
    );

    return {
      [NAME]: computed(() => `${label.get()}: ${value.get() ?? 1}`),
      [UI]: (
        <cf-vstack gap="2" align="center" padding="3">
          <div
            style={{
              fontSize: "2.5rem",
              fontWeight: "bold",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>
          <cf-text tone="muted">{caption}</cf-text>
          <cf-button variant="primary" onClick={roll}>
            Roll
          </cf-button>
        </cf-vstack>
      ),
      value,
      sides,
      roll,
    };
  },
);

export default DiceRoller;
