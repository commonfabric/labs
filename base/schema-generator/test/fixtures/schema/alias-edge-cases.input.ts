// Test 1: Deep alias chains for Cell and Stream
type MyCell<T> = Cell<T>;
type DeepCell<T> = MyCell<T>;
type VeryDeepCell<T> = DeepCell<T>;

type MyStream<T> = Stream<T>;
type DeepStream<T> = MyStream<T>;

// Test 2: Stream-Cell nesting with aliases
type StringCell = Cell<string>;
type NumberCell = MyCell<number>;
type StringCellStream = Stream<StringCell>;
type DeepNestedStream = MyStream<NumberCell>;

// Test 3: Array aliasing scenarios
type StringArray = string[];
type MyStringArray = StringArray;
type IndirectCellArray = Cell<MyStringArray>;

type NumberList<T> = T[];
type CellOfNumberList = Cell<NumberList<number>>;

// Test 4: Multi-hop array aliases with objects
type ItemList<T> = T[];
type UserList = ItemList<{ name: string; id: number }>;
type CellOfUserList = Cell<UserList>;

// Test 5: Complex alias chain with different types
type ReactiveValue<T> = Cell<T>;
type DataStore<T> = ReactiveValue<T>;
type UserDataStore = DataStore<string>;

interface SchemaRoot {
  // Test deep alias chains
  veryDeepCell: VeryDeepCell<string>;
  deepStream: DeepStream<number>;

  // Test Stream-Cell nesting with aliases
  stringCellStream: StringCellStream;
  deepNestedStream: DeepNestedStream;

  // Test array aliasing scenarios
  indirectArray: IndirectCellArray;
  numberListCell: CellOfNumberList;

  // Test multi-hop array aliases
  users: CellOfUserList;

  // Test complex alias chains
  userStore: UserDataStore;
}
