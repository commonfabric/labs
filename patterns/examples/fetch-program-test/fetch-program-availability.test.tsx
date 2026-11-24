/** Checks that a fetched source program becomes directly usable. */

import {
  assert,
  compileAndRun,
  fetchProgram,
  type FetchProgramResult,
  pattern,
  resultOf,
  TESTS,
  Writable,
} from "commonfabric";

export const fetchMocks = [{
  urlIncludes: "/patterns/examples/counter/counter.tsx",
  contentType: "text/plain",
  body:
    'import { NAME, pattern } from "commonfabric"; export default pattern<{ value: number }>(({ value }) => ({ [NAME]: "Fetched counter", value }));',
}];

const FetchAndCompile = pattern<void, {
  program: FetchProgramResult;
  compiled: { value: number };
}>(() => {
  const request = fetchProgram({
    url:
      "https://raw.githubusercontent.com/commonfabric/labs/main/patterns/examples/counter/counter.tsx",
  });
  const program = resultOf(request);
  const compileRequest = compileAndRun<{ value: number }, { value: number }>({
    files: program.files,
    main: program.main,
    input: { value: 9 },
  });
  return { program, compiled: resultOf(compileRequest) };
});

export default pattern(() => {
  const child = FetchAndCompile(undefined);
  const url = new Writable(
    "https://raw.githubusercontent.com/commonfabric/labs/main/patterns/examples/counter/counter.tsx",
  );
  const request = fetchProgram({ url });
  const program = resultOf(request);
  const compileRequest = compileAndRun<{ value: number }, { value: number }>({
    files: program.files,
    main: program.main,
    input: { value: 7 },
  });
  const compiled = resultOf(compileRequest);
  return {
    [TESTS]: [
      { settle: true },
      { assertion: assert(() => program.main.endsWith("counter.tsx")) },
      { assertion: assert(() => program.files.length === 1) },
      {
        assertion: assert(() =>
          program.files[0]?.contents.includes("pattern<{ value: number }>") ===
            true
        ),
      },
      { assertion: assert(() => compiled.value === 7) },
      { assertion: assert(() => child.program.files.length === 1) },
      { assertion: assert(() => child.compiled.value === 9) },
    ],
  };
});
