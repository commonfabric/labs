import {
  compileAndRun,
  computed,
  fetchProgram,
  NAME,
  pattern,
  toIndentedDebugString,
  UI,
  Writable,
} from "commonfabric";

/**
 * Test pattern for fetchProgram builtin.
 * Fetches a program from a URL and compiles it.
 */
export default pattern(() => {
  // URL to a simple pattern file
  const url = new Writable(
    "https://raw.githubusercontent.com/commonfabric/labs/main/packages/patterns/counter.tsx",
  );

  // Step 1: Fetch the program from URL
  const { pending: fetchPending, result: program, error: fetchError } =
    fetchProgram({ url });

  // Step 2: Compile and run the fetched program
  // Explicitly map program fields to compileAndRun params
  const compileParams = computed(() => ({
    files: program?.files ?? [],
    main: program?.main ?? "",
    input: { value: 10 },
  }));
  const { pending: compilePending, result, error: compileError } =
    compileAndRun(compileParams);

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
