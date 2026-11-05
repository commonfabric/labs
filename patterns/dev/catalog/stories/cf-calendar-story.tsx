import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface CalendarStoryInput {}
export interface CalendarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CalendarStoryInput, CalendarStoryOutput>(() => {
  const selectedDate = new Writable("2026-03-13");
  const disabled = new Writable(false);
  const minDate = new Writable("");
  const maxDate = new Writable("");
  const weekStart = new Writable<"sunday" | "monday">("sunday");

  return {
    [NAME]: "cf-calendar Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            maxWidth: "320px",
            margin: "0 auto",
            padding: "1rem",
          }}
        >
          <cf-calendar
            $value={selectedDate}
            markedDates={[
              "2026-03-10",
              "2026-03-15",
              "2026-03-20",
              "2026-03-25",
            ]}
            disabled={disabled}
            min={minDate}
            max={maxDate}
            weekStart={weekStart}
          />
          <div
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              marginTop: "8px",
              textAlign: "center",
            }}
          >
            Selected: {selectedDate}
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="disabled"
            description="Disables date selection"
            defaultValue="false"
            checked={disabled}
          />
          <TextControl
            label="min"
            description="Minimum selectable date (YYYY-MM-DD)"
            defaultValue=""
            value={minDate}
          />
          <TextControl
            label="max"
            description="Maximum selectable date (YYYY-MM-DD)"
            defaultValue=""
            value={maxDate}
          />
          <SelectControl
            label="week-start"
            description="First day of the week"
            defaultValue="sunday"
            value={weekStart}
            items={[
              { label: "Sunday", value: "sunday" },
              { label: "Monday", value: "monday" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
