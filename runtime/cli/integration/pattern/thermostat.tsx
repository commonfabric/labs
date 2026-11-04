/**
 * Fixture for the CLI read/write tour
 * (`docs/common/workflows/reading-and-writing.md`).
 *
 * It exists so the tour owns its subject: the shipped patterns are used
 * elsewhere, and a change to one of them should never break a demonstration
 * of what reading and writing a piece's cells through `cf` looks like.
 * Nothing else deploys this file.
 *
 * A thermostat, chosen because it is the smallest thing with the shape the
 * tour needs: a target a caller writes, readings a caller shapes a query
 * over, and two fields derived from both. A derived field is what makes the
 * difference between writing a cell and running a program visible — write
 * the target and nothing recomputes, so `targetFahrenheit` and `belowTarget`
 * keep reporting the old target until something observes the piece.
 */

import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

/** One zone, and the last reading taken in it. */
export interface Zone {
  /** Where the reading was taken. */
  name: string;

  /** The reading, in celsius. */
  celsius: number;
}

interface SetTargetEvent {
  /** The target to hold, in celsius. */
  celsius: number;
}

interface SetTargetResult {
  /** The target as persisted. */
  target: number;

  /** Zones reading below the new target, counted after the write. */
  belowTarget: number;
}

interface ThermostatInput {
  /** The target to hold, in celsius. */
  target?: Writable<number | Default<20>>;

  /** The zones this thermostat watches, and the last reading from each. */
  zones?: Writable<
    | Zone[]
    | Default<[
      { name: "hall"; celsius: 18 },
      { name: "loft"; celsius: 22 },
      { name: "shed"; celsius: 11 },
    ]>
  >;
}

/** A thermostat: a target to hold, the zones it watches, and two figures
 * derived from both. `setTarget` is the verb that moves the target. The
 * derived fields are the pattern's to compute — they take their next value
 * whenever the piece runs, and nothing outside the pattern produces one. */
interface ThermostatOutput {
  [NAME]: string;

  /** The target to hold, in celsius. */
  target: number;

  /** The zones this thermostat watches, and the last reading from each. */
  zones: Zone[];

  /** The target in fahrenheit. Derived from `target`. */
  targetFahrenheit: number;

  /** How many zones read below the target. Derived from `target` and
   * `zones`, so it moves when either does. */
  belowTarget: number;

  /** Move the target, and report what the zones look like against it. */
  setTarget: Stream<SetTargetEvent, SetTargetResult>;
}

function belowCount(zones: readonly Zone[], target: number): number {
  return zones.filter((zone) => zone.celsius < target).length;
}

export default pattern<ThermostatInput, ThermostatOutput>(
  ({ target, zones }) => {
    const targetFahrenheit = computed(() => target.get() * 9 / 5 + 32);
    const belowTarget = computed(() =>
      belowCount(zones.get() ?? [], target.get())
    );

    const setTarget = action<SetTargetEvent, SetTargetResult>((event) => {
      const celsius = event.celsius;
      if (!Number.isFinite(celsius)) {
        throw new Error("setTarget: celsius must be a number");
      }
      target.set(celsius);
      return {
        target: celsius,
        belowTarget: belowCount(zones.get() ?? [], celsius),
      };
    });

    return {
      [NAME]: "Thermostat",
      target,
      zones,
      targetFahrenheit,
      belowTarget,
      setTarget,
    };
  },
);
