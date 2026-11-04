type Default<T, V extends T = T> = T;

type RecursiveItem = {
  name: string;
  children?: RecursiveItem[];
};

interface SchemaRoot {
  items: Default<Array<RecursiveItem>, []>;
  moreItems: Default<Array<RecursiveItem>, []>;
}
