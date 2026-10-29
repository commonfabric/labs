export type TestResultError = {
  message: string;
  name: string;
  stack?: string;
};

export type TestResult = {
  name: string;
  error: TestResultError | null;
  duration: number;
};

export type TestFileResults = {
  fileName: string;
  tests: TestResult[];
};

export type Summary = {
  passed: number;
  duration: number;
  failed: TestResult[];
};
