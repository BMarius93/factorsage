import type { Request } from "express";

/**
 * The client address a rate-limit counter may be keyed by.
 *
 * `X-Forwarded-For` is caller-supplied text. Anything the application does not know was written by
 * its own infrastructure is an attacker-controlled identity, and treating it as one would let a
 * single origin mint an unlimited number of distinct rate-limit buckets — which is worse than
 * having no IP limiting at all, because it looks like it works.
 *
 * So the rule is positional and explicit. `trustedProxyHops` is how many proxies this deployment
 * really runs in front of the API, configured by an operator who knows
 * (`RATE_LIMIT_TRUSTED_PROXY_HOPS`, default `0`). Each proxy appends the address of the peer *it*
 * received the request from, so with N trusted hops the entry at `length - N` is the address the
 * outermost trusted proxy actually observed, and everything to its left is text the caller wrote.
 *
 * That indexing is what makes the rule safe rather than merely plausible. A caller who prepends
 * `X-Forwarded-For: 198.51.100.1, 198.51.100.2` to fabricate two hops only pushes their own real
 * address further right — the trusted proxy still appends it, and counting from the right still
 * lands on it. Counting from the left, or trusting the left-most entry as "the original client"
 * the way many examples do, is what hands every caller a free identity.
 *
 * A header **shorter** than the configured hop count means configuration and reality disagree.
 * That resolves to the peer address rather than to the left-most entry: an address this process
 * observed itself is the one thing a caller cannot choose, and being too coarse only ever makes a
 * counter stricter.
 *
 * With `0` — this repository's own deployment, where `docker-compose.yml` publishes the API port
 * directly and nothing terminates in front of it — the header is not read at all and the TCP peer
 * address is used. Express's own `trust proxy` setting is deliberately left off for the same
 * reason; it would also change `req.protocol` and `req.secure` across the whole application, which
 * is a much wider decision than this one.
 */
export function clientIp(request: Request, trustedProxyHops: number): string {
  const direct = normalizeIp(request.socket.remoteAddress ?? "");

  if (trustedProxyHops <= 0) {
    return direct;
  }

  const forwarded = forwardedFor(request);
  if (forwarded.length === 0) {
    return direct;
  }

  const index = forwarded.length - trustedProxyHops;
  const candidate = index >= 0 ? forwarded[index] : undefined;
  return candidate ? normalizeIp(candidate) : direct;
}

function forwardedFor(request: Request): string[] {
  const raw = request.headers["x-forwarded-for"];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Normalizes an address into the identity a counter is keyed by.
 *
 * Two adjustments, both about making the key mean "one caller":
 *
 * - IPv4-mapped IPv6 (`::ffff:203.0.113.7`) collapses to its IPv4 form, so the same client reaching
 *   a dual-stack socket is one identity rather than two.
 * - IPv6 is truncated to its `/64` prefix. A residential IPv6 allocation is a whole `/64` or wider,
 *   so a per-address counter is bypassed by picking a new address — which costs the caller nothing
 *   — while a `/64` is the smallest block that is actually one subscriber.
 */
export function normalizeIp(value: string): string {
  const address = value.trim().toLowerCase();
  if (address === "") {
    // No peer address at all: a socket that closed, or a non-TCP transport under test. One shared
    // bucket is the conservative answer — it can only ever be stricter, never a free identity.
    return "unknown";
  }

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1]) {
    return mapped[1];
  }

  if (!address.includes(":")) {
    return address;
  }
  return ipv6Prefix(address);
}

/** The `/64` prefix of an IPv6 address, written as its first four groups. */
function ipv6Prefix(address: string): string {
  const [head = "", tail = ""] = address.split("::", 2);
  const headGroups = head.split(":").filter(Boolean);
  if (!address.includes("::")) {
    return `${headGroups.slice(0, 4).join(":")}::/64`;
  }

  const tailGroups = tail.split(":").filter(Boolean);
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const expanded = [
    ...headGroups,
    ...Array.from({ length: missing }, () => "0"),
    ...tailGroups,
  ];
  return `${expanded.slice(0, 4).join(":")}::/64`;
}
