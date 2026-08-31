/**
 * Give the edge a route to the control plane — RFC-001 §1, spec task 5.1c part two.
 *
 * ⭐ WHY THIS EXISTS AT ALL. RFC-001 §1 deletes the control-plane account and has the web UI
 * authenticate against the edge "the same as Portainer or Open WebUI". That is only sound once
 * the edge is the ONLY route in, and today it is not a route in at all: the server publishes
 * port 3000 itself and Caddy has never had a site block for it. This is that site block.
 *
 * 🚨 THIS DOES NOT MAKE THE CUTOVER SAFE ON ITS OWN. It gives the edge a route; the published
 * port is still open, so the web UI must keep checking its own password until `APPBAY_BIND` is
 * flipped to loopback. Adding the route and deleting the password check in one step would be
 * the bypass this task exists to avoid — see the spec's 5.1c.
 *
 * ⭐ EVERY FRAGMENT COMES FROM THE TRAIT RENDERERS, not from a copy of them. The control plane
 * is "a stack like any other" in the RFC's words, so its site block, its authorization policy
 * and its portal route are produced by exactly the functions every other app's are. A second
 * emitter would be a second thing to keep in sync with Caddy's syntax, and the two edge
 * syntaxes this sprint already got wrong (probe-84) are the argument against having one.
 */

import { buildCaddySnippet, caddyAuxPath } from "../traits/definitions/ingress.js";
import { caddySecurityPolicy, caddySecurityRoute } from "../traits/definitions/auth.js";

/**
 * App name the control plane is known by at the edge.
 *
 * It is not deployed through the app pipeline, so nothing else establishes this name — but it
 * must not collide with a real app directory, because both would emit a site block and two
 * files declaring the same address is Caddy's `ambiguous site definition`.
 */
export const CONTROL_PLANE_APP = "appbay-server";

/**
 * Network alias the edge dials.
 *
 * 🚨 NOT the container name. `appbay.server` contains dots, which read as label separators
 * wherever a name reaches DNS — the same hazard §4 folds dots for. The server compose declares
 * `appbay_server` as an explicit alias on `appbay_shared` so this matches the `<app>_<service>`
 * shape every other upstream uses.
 */
export const CONTROL_PLANE_ALIAS = "appbay_server";

/** Port the control plane listens on inside its container. */
export const CONTROL_PLANE_PORT = 3000;

/** One generated file: a path relative to `$APPBAY_HOME`, and its content. */
export interface EdgeFragment {
  path: string;
  content: string;
}

/**
 * Resolve the hostname the control plane is served at.
 *
 * Returns `null` when the installation has no domain, which is the normal state for a local
 * install and NOT an error — there is simply no name to serve it at, so no route is written
 * and the published port remains the way in.
 */
export function controlPlaneHost(
  domain: string | undefined,
  explicitHost?: string,
): string | null {
  const explicit = explicitHost?.trim();
  if (explicit) return explicit;
  const base = domain?.trim();
  if (!base) return null;
  return `appbay.${base}`;
}

/**
 * The three files the edge needs to serve the control plane behind the auth portal.
 *
 * ⚠️ The policy is `authp/admin` only — deliberately narrower than an app's default, which
 * also allows `authp/user`. Every other app grants what its manifest asks for; the control
 * plane deploys and destroys all of them, so "any authenticated user" is the wrong default
 * for the one stack that can reach the container runtime socket.
 */
export function controlPlaneEdgeFragments(host: string): EdgeFragment[] {
  return [
    {
      path: caddyAuxPath(CONTROL_PLANE_APP),
      // The alias is passed rather than derived: the control plane is not compiled through
      // the pipeline, so the <app>_<service> convention does not describe it.
      content: buildCaddySnippet(
        CONTROL_PLANE_APP,
        "server",
        { host, port: CONTROL_PLANE_PORT } as Parameters<typeof buildCaddySnippet>[2],
        undefined,
        CONTROL_PLANE_ALIAS,
      ),
    },
    {
      path: `etc/apps/caddy/config/dynamic/auth/${CONTROL_PLANE_APP}-security.caddy`,
      content: caddySecurityRoute(CONTROL_PLANE_APP),
    },
    {
      path: `etc/apps/caddy/config/security/policies/${CONTROL_PLANE_APP}.caddy`,
      content: caddySecurityPolicy(CONTROL_PLANE_APP, host, "authenticated", "authp/admin"),
    },
  ];
}
