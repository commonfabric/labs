import { CFCalendar } from "./cf-calendar.ts";

if (!customElements.get("cf-calendar")) {
  customElements.define("cf-calendar", CFCalendar);
}

export type { CFCalendar as CFCalendarElement } from "./cf-calendar.ts";

export { CFCalendar };
