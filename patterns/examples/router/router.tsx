import {
  action,
  computed,
  NAME,
  pattern,
  Stream,
  type UIRenderable,
  type VNode,
  Writable,
} from "commonfabric";

export interface RouteContext {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

interface Route {
  path: string;
  pattern: UIRenderable;
}

interface RouterInput {
  routes: Route[];
  routeContext: Writable<RouteContext>;
}

export interface RouterOutput {
  [NAME]: string;
  path: string;
  Pattern: VNode;
  navigate: Stream<string>;
}

function matchRoute(
  routePath: string,
  currentPath: string,
): Record<string, string> | null {
  const routeParts = routePath.split("/");
  const currentParts = currentPath.split("/");
  if (routeParts.length !== currentParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    const routePart = routeParts[i];
    const currentPart = currentParts[i];
    if (routePart.startsWith("{") && routePart.endsWith("}")) {
      params[routePart.slice(1, -1)] = currentPart;
    } else if (routePart !== currentPart) {
      return null;
    }
  }
  return params;
}

function parseQuery(queryString: string): Record<string, string> {
  if (!queryString) return {};
  const query: Record<string, string> = {};
  for (const pair of queryString.split("&")) {
    const eqIndex = pair.indexOf("=");
    const key = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const value = eqIndex === -1 ? "" : pair.slice(eqIndex + 1);
    if (key) query[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return query;
}

export const Router = pattern<RouterInput, RouterOutput>(
  ({ routes, routeContext }) => {
    const path = new Writable("/");
    const navigate = action((to: string) => path.set(to));

    const Route = computed(() => {
      const fullPath = path.get();
      const [pathname, queryString] = fullPath.split("?");
      const query = parseQuery(queryString ?? "");

      for (const r of routes) {
        const params = matchRoute(r.path, pathname);
        if (params !== null) {
          routeContext.set({ path: pathname, params, query });
          return r.pattern;
        }
      }
      routeContext.set({ path: pathname, params: {}, query });
      return null;
    });

    const Pattern = (
      <cf-router $path={path}>
        {Route}
      </cf-router>
    );

    return {
      [NAME]: "Router",
      path: computed(() => path.get()),
      Pattern,
      navigate,
    };
  },
);
