import {
  compileAndRun,
  compileDiagnosticsOf,
  computed,
  fetchProgram,
  type FetchProgramResult,
  hasError,
  isPending,
  NAME,
  pattern,
  resultOf,
  toIndentedDebugString,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { compileFailure } from "../compiler/compile-failure.ts";

/**
 * Test pattern for fetchProgram builtin.
 * Fetches a program from a URL and compiles it.
 */
type FetchProgramTestOutput = {
  [NAME]: string;
  [UI]: VNode;
  url: string;
  program: FetchProgramResult | undefined;
  result: unknown;
};

export default pattern<void, FetchProgramTestOutput>(() => {
  // URL to a simple pattern file
  const url = new Writable(
    "https://raw.githubusercontent.com/commonfabric/labs/main/patterns/examples/counter/counter.tsx",
  );

  // Step 1: Fetch the program from URL
  const fetchRequest = fetchProgram({ url });
  const program = resultOf(fetchRequest);
  const fetchPending = computed(() =>
    hasError(fetchRequest) ? false : isPending(fetchRequest)
  );
  const fetchError = computed(() =>
    hasError(fetchRequest) ? fetchRequest.message : undefined
  );

  // Step 2: Compile and run the fetched program
  // Explicitly map program fields to compileAndRun params
  const compileParams = computed(() => ({
    files: program.files,
    main: program.main,
    input: { value: 10 },
  }));
  const compileRequest = compileAndRun<
    { value: number },
    Record<string, unknown>
  >(compileParams);
  const result = resultOf(compileRequest);
  const shownResult = computed(() =>
    isPending(compileRequest) || hasError(compileRequest)
      ? undefined
      : resultOf(compileRequest)
  );
  const compilePending = computed(() =>
    hasError(compileRequest) ? false : isPending(compileRequest)
  );
  const compileErrors = compileDiagnosticsOf(compileRequest);
  const compileProblem = computed(() =>
    compileFailure(
      hasError(compileRequest) ? compileRequest.message : undefined,
      compileErrors,
    )
  );

  return {
    [NAME]: "Fetch Program Test",
    [UI]: (
      <div>
        <h1>Fetch Program Test</h1>
        <div>
          <label>URL:</label>
          <cf-input type="text" $value={url} />
        </div>
        {fetchPending && <div>Fetching program...</div>}
        {compilePending && <div>Compiling...</div>}
        {fetchError && <div style="color: red">Fetch error: {fetchError}</div>}
        {compileProblem && (
          <div style="color: red">Compile error: {compileProblem}</div>
        )}
        {shownResult && (
          <div style="color: green">
            Successfully compiled pattern! <cf-cell-link $cell={shownResult} />
            <pre>{computed(() => toIndentedDebugString(shownResult))}</pre>
          </div>
        )}
      </div>
    ),
    url,
    program,
    result,
  };
});
