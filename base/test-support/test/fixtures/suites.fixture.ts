// Run by `../registration.test.ts` as a test file of its own. Each line
// starting `LOG ` says what ran, in order.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  test,
} from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

beforeEach(() => log("file beforeEach"));
afterEach(() => log("file afterEach"));

describe("bakery", () => {
  beforeAll(() => log("bakery beforeAll"));
  afterAll(() => log("bakery afterAll"));
  beforeEach(() => log("bakery beforeEach"));
  afterEach(() => log("bakery afterEach"));

  it("bakes bread", () => log("bakes bread"));

  it("burns toast", () => {
    log("burns toast");
    throw new Error("the toast is burnt");
  });

  describe("glaze", () => {
    beforeAll(() => log("glaze beforeAll"));
    afterAll(() => log("glaze afterAll"));
    beforeEach(() => log("glaze beforeEach"));
    afterEach(() => log("glaze afterEach"));

    it("sets", () => log("sets"));
    it("runs", () => log("runs"));
  });

  describe("pantry", () => {
    beforeAll(() => log("pantry beforeAll"));
    afterAll(() => log("pantry afterAll"));
    it("stocks flour", () => log("stocks flour"));
    it.ignore("orders yeast", () => log("orders yeast"));
  });

  it.ignore("sells cake", () => log("sells cake"));
  it("weighs dough", { ignore: true }, () => log("weighs dough"));
});

describe("cellar", () => {
  afterAll(() => {
    throw new Error("the cellar flooded");
  });
  it("ages cheese", () => log("ages cheese"));
});

describe("closed shop", () => {
  beforeAll(() => log("closed shop beforeAll"));
  it("opens", () => log("opens"));
});

test("delivery", async (t) => {
  log("delivery");
  await t.step("loads the van", () => log("loads the van"));
  await t.step("drives", () => log("drives"));
});

test({ name: "invoice", fn: () => log("invoice") });
