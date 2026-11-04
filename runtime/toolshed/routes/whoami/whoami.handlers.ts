import type { AppRouteHandler } from "@/lib/types.ts";
import type { whoami } from "./whoami.routes.ts";

export const whoamiHandler: AppRouteHandler<typeof whoami> = (c) => {
  const requesterProfile = {
    name: c.req.header("tailscale-user-name") || null,
    email: c.req.header("tailscale-user-login") || null,
    shortName: c.req.header("tailscale-user-login")?.split("@")[0] || "system",
    avatar: c.req.header("tailscale-user-profile-pic") || null,
  };

  return c.json(requesterProfile);
};
