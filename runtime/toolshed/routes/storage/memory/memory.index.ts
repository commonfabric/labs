import { createRouter } from "@/lib/create-app.ts";
import * as routes from "./memory.routes.ts";
import * as handlers from "./memory.handlers.ts";

const router = createRouter();

const Router = router.openapi(routes.subscribe, handlers.subscribe);

export default Router;
