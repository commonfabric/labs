import {
  compileAndRun,
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

/**
 * Test pattern for fetchProgram builtin.
 * Fetches a program from a URL and compiles it.
 */
type FetchProgramTestOutput = {
  [NAME]: string;
  [UI]: VNode;
  url: unknown;
  program: FetchProgramResult | undefined;
  result: unknown;
};

export default pattern<void, FetchProgramTestOutput>(() => {
  // URL to a simple pattern file
  const url = new Writable(
    "https://raw.githubusercontent.com/commonfabric/labs/main/packages/patterns/counter.tsx",
  );

  // Step 1: Fetch the program from URL
  const fetchRequest = fetchProgram({ url });
  const fetchedProgram = resultOf(fetchRequest);
  // Preserve the legacy optional output while the direct path below uses
  // availability to suspend until the program is ready.
  const program = computed((): FetchProgramResult | undefined =>
    isPending(fetchRequest) || hasError(fetchRequest)
      ? undefined
      : fetchedProgram
  );
  const fetchPending = computed(() => isPending(fetchRequest));
  const fetchError = computed(() =>
    hasError(fetchRequest) ? fetchRequest.errorMessage : undefined
  );

  // Step 2: Compile and run the fetched program
  // Explicitly map program fields to compileAndRun params
  const compileParams = computed(() => ({
    files: fetchedProgram.files,
    main: fetchedProgram.main,
    input: { value: 10 },
  }));
  const compileRequest = compileAndRun(compileParams);
  const result = resultOf(compileRequest);
  const compilePending = computed(() => isPending(compileRequest));
  const compileError = computed(() =>
    hasError(compileRequest) ? compileRequest.errorMessage : undefined
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
        {compileError && (
          <div style="color: red">Compile error: {compileError}</div>
        )}
        {result && (
          <div style="color: green">
            Successfully compiled pattern! Piece ID: {result}
            <pre>{computed(() => toIndentedDebugString(result))}</pre>
          </div>
        )}
      </div>
    ),
    url,
    program,
    result,
  };
});
