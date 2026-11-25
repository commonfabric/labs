import { assertEquals } from "@std/assert";
import { getPatternEnvironment } from "@commonfabric/api";
import { test } from "@commonfabric/test-support/test";

function restoreLocation(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, "location", descriptor);
  } else {
    Reflect.deleteProperty(globalThis, "location");
  }
}

test("getPatternEnvironment uses the current global location origin", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: "https://tools.example.test/space/path?query=1#note",
      } as Location,
    });

    const environment = getPatternEnvironment();

    assertEquals(environment.apiUrl.href, "https://tools.example.test/");
  } finally {
    restoreLocation(originalLocation);
  }
});

test("getPatternEnvironment uses localhost when no global location exists", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: undefined,
    });

    const environment = getPatternEnvironment();

    assertEquals(environment.apiUrl.href, "http://localhost:8000/");
  } finally {
    restoreLocation(originalLocation);
  }
});
