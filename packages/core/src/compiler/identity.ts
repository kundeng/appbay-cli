/**
 * Names appbay gives to the things it creates — containers, networks, DNS aliases and
 * generated edge fragments. RFC-001 §4.4 and §4.5.
 *
 * ⚠️ These six strings are a CONTRACT, not formatting. The shared-network alias a service
 * publishes is the exact hostname the edge dials, and those were built independently in
 * three files (`upstream-transform.ts`, and twice in `ingress.ts`). Two copies of one
 * format string is a fork waiting to happen: change one and the edge points at a name
 * nothing answers to, which surfaces as a connection failure with no error naming the cause.
 * One module, one definition, imported by everyone.
 */

/** The namespace value that means "unset" — see `isNamespaced`. */
const DEFAULT_NAMESPACE = "default";

/**
 * Fold a namespace into something usable as a single DNS label.
 *
 * 🚨 A dot is the LABEL SEPARATOR in DNS, so `uom.sim` inside a hostname is two labels, not
 * a name. `uom.sim_litellm_litellm` does not resolve to anything — it parses as host
 * `uom` in domain `sim_litellm_litellm`. Namespaces are dot-delimited by design (RFC-001
 * §4), so every place a namespace reaches a hostname has to fold first.
 *
 * Folding to `-` rather than `_`: hyphens are legal in DNS labels, underscores are not
 * (RFC 1123), and `_` is already the separator between app and service here.
 */
export function dnsSafe(namespace: string): string {
  return namespace.replace(/\./g, "-");
}

/**
 * Whether this namespace should appear in generated identity at all.
 *
 * ⚠️ `default` is omitted DELIBERATELY, and this is the decision that keeps §4.4 from being
 * a migration. Every one of the 155 manifests in both catalogs declares no namespace, so
 * including it unconditionally would rename every container and network on every existing
 * host — `appbay.litellm.litellm` becoming `appbay.default.litellm.litellm` — orphaning
 * whatever is running for no gain, since a single-namespace host has nothing to disambiguate.
 *
 * The point of §4.4 is that two instances of one app can coexist in one home. That needs the
 * namespace present when there IS one, and needs nothing when there is not.
 */
function isNamespaced(namespace: string | undefined): namespace is string {
  return namespace !== undefined && namespace !== DEFAULT_NAMESPACE && namespace !== "";
}

/** `appbay.<app>.<service>`, or `appbay.<ns>.<app>.<service>` when namespaced. */
export function containerName(
  namespace: string | undefined,
  appName: string,
  serviceName: string,
): string {
  return isNamespaced(namespace)
    ? `appbay.${dnsSafe(namespace)}.${appName}.${serviceName}`
    : `appbay.${appName}.${serviceName}`;
}

/**
 * The alias a service publishes on a shared network — i.e. the hostname other apps and the
 * edge dial. Must be DNS-safe, hence `dnsSafe` on the namespace.
 */
export function sharedNetworkAlias(
  namespace: string | undefined,
  appName: string,
  serviceName: string,
): string {
  return isNamespaced(namespace)
    ? `${dnsSafe(namespace)}_${appName}_${serviceName}`
    : `${appName}_${serviceName}`;
}

/** The app's private network. */
export function internalNetworkName(
  namespace: string | undefined,
  appName: string,
): string {
  return isNamespaced(namespace)
    ? `${dnsSafe(namespace)}_${appName}_internal`
    : `${appName}_internal`;
}

/** Stem for an app's generated edge fragment (`<stem>.caddy`, `<stem>.yml`). */
export function auxFileStem(
  namespace: string | undefined,
  appName: string,
): string {
  return isNamespaced(namespace) ? `${dnsSafe(namespace)}.${appName}` : appName;
}

/**
 * Docker label carrying the app name, so consumers do not have to parse container names.
 *
 * 🚨 THIS EXISTS BECAUSE NAME-PARSING BREAKS UNDER NAMESPACES. `apps/web`'s running-app
 * discovery matched `/^appbay\.([^.]+)/` and took the first segment — correct for
 * `appbay.litellm.litellm`, and wrong for `appbay.uom-sim.litellm.litellm`, which reports
 * the app as `uom-sim`. Segment counting cannot fix it either: `appbay.<app>.<service>` and
 * `appbay.<ns>.<app>` have the same shape. A label answers the question directly.
 */
export const APP_LABEL = "com.appbay.app";

/** Docker label carrying the namespace, `default` when unset. */
export const NAMESPACE_LABEL = "com.appbay.namespace";
