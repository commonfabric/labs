import { pattern, UI } from "commonfabric";

const COLUMN_INDICES = [0, 1, 2];

interface Input {
  weekDates: string[];
  todayDate: string;
}

// FIXTURE: map-plain-array-callback-local-comparison
// Verifies: a callback-local binding inside a plain-array .map() lowers like the
// same binding in the pattern body
//   COLUMN_INDICES.map(fn)                  -> plain .map() remains plain
//   const isToday = weekDates?.[colIdx] === todayDate
//                                           -> lift-applied binding capturing
//                                              weekDates, todayDate and colIdx
//   isToday as a JSX ternary condition      -> ifElse over the lifted binding
// Context: The fixed-column calendar shape — a plain index array mapped inside
// JSX, with the per-column comparison named before it is used as a condition
export default pattern<Input>(({ weekDates, todayDate }) => {
  return {
    [UI]: (
      <div>
        {COLUMN_INDICES.map((colIdx) => {
          const isToday = weekDates?.[colIdx] === todayDate;
          return <div>{isToday ? "Today" : "Other"}</div>;
        })}
      </div>
    ),
  };
});
