import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { type RouteContext, Router } from "./router.tsx";

// deno-lint-ignore no-empty-interface
interface HomeInput {}

export interface HomeOutput {
  [NAME]: string;
  [UI]: VNode;
}

// deno-lint-ignore no-empty-interface
interface BooksInput {}

export interface BooksOutput {
  [NAME]: string;
  [UI]: VNode;
}

interface BookInput {
  route: RouteContext;
}

export interface BookOutput {
  [NAME]: string;
  [UI]: VNode;
}

// deno-lint-ignore no-empty-interface
interface MainInput {}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
}

const Home = pattern<HomeInput, HomeOutput>(() => {
  return {
    [NAME]: "Home",
    [UI]: (
      <div>
        <p>The Home pattern</p>
        <div>
          <cf-link to="/books">
            <a href="/books">Books</a>
          </cf-link>
        </div>
      </div>
    ),
  };
});

const Books = pattern<BooksInput, BooksOutput>(() => {
  return {
    [NAME]: "Books",
    [UI]: (
      <div>
        <p>The Books pattern</p>
        <div>
          <cf-link to="/books/1">
            <button type="button">Book 1</button>
          </cf-link>
        </div>
        <div>
          <cf-link to="/books/2?edition=hardcover">
            <button type="button">Book 2 (Hardcover)</button>
          </cf-link>
        </div>
      </div>
    ),
  };
});

const Book = pattern<BookInput, BookOutput>(({ route }) => {
  const bookId = computed(() => route.params.id);
  const edition = computed(() => route.query.edition || "unknown");
  return {
    [NAME]: computed(() => `Book ${bookId}`),
    [UI]: (
      <div>
        <p>Book ID: {bookId}</p>
        <p>Edition: {edition}</p>
        <div>
          <cf-link to="/books">
            <button type="button">Back to Books</button>
          </cf-link>
        </div>
        <div>
          <cf-link to="/">
            <button type="button">Home</button>
          </cf-link>
        </div>
      </div>
    ),
  };
});

export default pattern<MainInput, MainOutput>(() => {
  const routeContext = new Writable<RouteContext>({
    path: "/",
    params: {},
    query: {},
  });

  const { path, Pattern } = Router({
    routeContext,
    routes: [
      { path: "/", pattern: Home({}) },
      { path: "/books", pattern: Books({}) },
      { path: "/books/{id}", pattern: Book({ route: routeContext }) },
    ],
  });

  return {
    [NAME]: "Main",
    [UI]: (
      <cf-screen>
        <div>Current path: {path}</div>
        <main>
          {Pattern}
        </main>
      </cf-screen>
    ),
  };
});
