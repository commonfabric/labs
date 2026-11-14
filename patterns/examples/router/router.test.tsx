import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import Main, { Book, Books, Home } from "./main.tsx";
import { type RouteContext, Router } from "./router.tsx";

export default pattern(() => {
  const routeContext = Writable.of<RouteContext>({
    path: "/",
    params: {},
    query: {},
  });
  const book = Book({ route: routeContext });
  const router = Router({
    routeContext,
    routes: [
      { path: "/", pattern: Home({}) },
      { path: "/books", pattern: Books({}) },
      { path: "/books/{id}", pattern: book },
    ],
  });
  const main = Main({});
  const plainBook = Book({
    route: { path: "/books/3", params: { id: "3" }, query: {} },
  });

  const action_open_books = action(() => router.navigate.send("/books"));
  const action_open_book = action(() =>
    router.navigate.send("/books/7?edition=hard%20cover&gift&=ignored")
  );
  const action_open_unknown = action(() => router.navigate.send("/nowhere"));

  const assert_main_starts_home = assert(() =>
    hasText(main[UI], "Current path: /") &&
    hasText(main[UI], "The Home pattern")
  );
  const assert_router_starts_home = assert(() =>
    router[NAME] === "Router" && router.path === "/" &&
    hasText(router.Pattern, "The Home pattern")
  );
  const assert_books_shown = assert(() =>
    hasText(router.Pattern, "The Books pattern") &&
    !hasText(router.Pattern, "The Home pattern") &&
    routeContext.get().path === "/books"
  );
  const assert_book_shown = assert(() =>
    hasText(router.Pattern, "Book ID: 7") &&
    hasText(router.Pattern, "Edition: hard cover") &&
    book[NAME] === "Book 7"
  );
  const assert_book_route_context = assert(() => {
    const { path, params, query } = routeContext.get();
    return path === "/books/7" && params.id === "7" &&
      query.edition === "hard cover" && query.gift === "" &&
      Object.keys(query).join(",") === "edition,gift";
  });
  const assert_unknown_shows_nothing = assert(() =>
    router.path === "/nowhere" &&
    !hasText(router.Pattern, "pattern") &&
    !hasText(router.Pattern, "Book ID")
  );
  const assert_unknown_route_context = assert(() => {
    const { path, params, query } = routeContext.get();
    return path === "/nowhere" && Object.keys(params).length === 0 &&
      Object.keys(query).length === 0;
  });
  const assert_book_without_edition = assert(() =>
    hasText(plainBook[UI], "Book ID: 3") &&
    hasText(plainBook[UI], "Edition: unknown")
  );

  return {
    [TESTS]: [
      { assertion: assert_main_starts_home },
      { assertion: assert_router_starts_home },
      { action: action_open_books },
      { assertion: assert_books_shown },
      { action: action_open_book },
      { assertion: assert_book_shown },
      { assertion: assert_book_route_context },
      { action: action_open_unknown },
      { assertion: assert_unknown_shows_nothing },
      { assertion: assert_unknown_route_context },
      { assertion: assert_book_without_edition },
    ],
    router,
    main,
  };
});
