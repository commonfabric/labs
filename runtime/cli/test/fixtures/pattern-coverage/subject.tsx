import { action, assert, pattern, TESTS, Writable } from "commonfabric";

function incrementCount(count: Writable<number>): void {
  count.set(count.get() + 1);
}

function countIsOne(count: Writable<number>): boolean {
  return count.get() === 1;
}

function isAliceName(name: Writable<string>): boolean {
  return name.get() === "alice";
}

function isBobName(name: Writable<string>): boolean {
  return name.get() === "bob";
}

export const singlePattern = pattern(() => {
  const count = new Writable(0);
  const increment = action(() => incrementCount(count));
  const isOne = assert(() => countIsOne(count));

  return {
    [TESTS]: [
      { action: increment },
      { assertion: isOne },
    ],
  };
});

export const alice = pattern(() => {
  const name = new Writable("alice");
  const isAlice = assert(() => isAliceName(name));

  return {
    [TESTS]: [{ assertion: isAlice }],
  };
});

export const bob = pattern(() => {
  const name = new Writable("bob");
  const isBob = assert(() => isBobName(name));

  return {
    [TESTS]: [{ assertion: isBob }],
  };
});
