// Test wrapper type aliases - both direct and aliased wrapper types
// Using proper interface definitions that match actual Common Fabric wrappers
type Default<T, V = T> = T;

// Define wrapper aliases
type RecursiveItemArray = RecursiveItem[];
type DefaultRecursiveArray<
  T extends RecursiveItem[] = RecursiveItem[],
  V extends T = T,
> = Default<T, V>;
type CellRecursiveArray<T extends RecursiveItem[] = RecursiveItem[]> = Cell<T>;
type StreamRecursiveArray<T extends RecursiveItem[] = RecursiveItem[]> = Stream<
  T
>;

type RecursiveItem = {
  name: string;
  children?: RecursiveItem[];
};

interface SchemaRoot {
  // Direct wrapper usage
  directDefault: Default<RecursiveItem[], []>;
  directCell: Cell<RecursiveItem[]>;
  directStream: Stream<RecursiveItem[]>;

  // Aliased wrapper usage
  aliasedDefault: DefaultRecursiveArray<RecursiveItem[], []>;
  aliasedCell: CellRecursiveArray;
  aliasedStream: StreamRecursiveArray;
}
