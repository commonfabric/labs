import { cell, pattern, handler } from "commonfabric";

// 1. Top-level
const _topLevel = cell(10);

// 2. Inside function
function regularFunction() {
  const _inFunction = cell(20);
  return _inFunction;
}

// 3. Inside arrow function
const arrowFunction = () => {
  const _inArrow = cell(30);
  return _inArrow;
};

// 4. Inside class method
class TestClass {
  method() {
    const _inMethod = cell(40);
    return _inMethod;
  }
}

// 5. Inside pattern
const testPattern = pattern(() => {
  const _inPattern = cell(50);
  return _inPattern;
});

// 6. Inside handler
const testHandler = handler(() => {
  const _inHandler = cell(60);
  return _inHandler;
});

// FIXTURE: context-variations
// Verifies: schema injection works in all code contexts and pattern/handler get their own schemas
//   cell(N) → cell(N, { type: "number" }) in top-level, function, arrow, class method, pattern, handler
//   pattern(() => ...) → pattern(() => ..., inputSchema, outputSchema)
//   handler(() => ...) → handler(inputSchema, outputSchema, () => ...)
export default function TestContextVariations() {
  return {
    topLevel: _topLevel,
    regularFunction,
    arrowFunction,
    TestClass,
    testPattern,
    testHandler,
  };
}
