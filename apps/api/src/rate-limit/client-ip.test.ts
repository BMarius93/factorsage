import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { clientIp, normalizeIp } from "./client-ip";

function req(
  remoteAddress: string,
  forwarded?: string | string[],
): Request {
  return {
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  } as unknown as Request;
}

describe("client IP derivation", () => {
  describe("with no trusted proxy (the default deployment)", () => {
    it("uses the TCP peer address", () => {
      expect(clientIp(req("203.0.113.5"), 0)).toBe("203.0.113.5");
    });

    it("ignores X-Forwarded-For entirely", () => {
      // The whole point of the default: a caller cannot mint identities by inventing a header.
      expect(clientIp(req("203.0.113.5", "198.51.100.1"), 0)).toBe(
        "203.0.113.5",
      );
      expect(clientIp(req("203.0.113.5", "198.51.100.1, 198.51.100.2"), 0)).toBe(
        "203.0.113.5",
      );
    });
  });

  describe("behind trusted proxies", () => {
    it("reads the address the outermost trusted proxy observed", () => {
      // client -> proxy1 -> app: proxy1 appended the client.
      expect(clientIp(req("10.0.0.1", "203.0.113.5"), 1)).toBe("203.0.113.5");
      // client -> proxy1 -> proxy2 -> app: proxy2 appended proxy1, proxy1 appended the client.
      expect(clientIp(req("10.0.0.2", "203.0.113.5, 10.0.0.1"), 2)).toBe(
        "203.0.113.5",
      );
    });

    it("cannot be escaped by prepending fabricated hops", () => {
      // The caller sent `198.51.100.1, 198.51.100.2`; the one trusted proxy then appended the
      // caller's real address. Counting from the right still lands on the real one, which is the
      // property that makes this safe rather than merely conventional.
      expect(
        clientIp(req("10.0.0.1", "198.51.100.1, 198.51.100.2, 203.0.113.5"), 1),
      ).toBe("203.0.113.5");
    });

    it("falls back to the peer address when the header is shorter than configured", () => {
      // Configuration and reality disagree. The peer address is the one value a caller cannot
      // choose, so it is the safe answer — never the left-most entry.
      expect(clientIp(req("10.0.0.1", "203.0.113.5"), 3)).toBe("10.0.0.1");
      expect(clientIp(req("10.0.0.1"), 2)).toBe("10.0.0.1");
    });

    it("accepts the header repeated across several header lines", () => {
      expect(
        clientIp(req("10.0.0.1", ["198.51.100.1", "203.0.113.5"]), 1),
      ).toBe("203.0.113.5");
    });
  });

  describe("identity normalization", () => {
    it("collapses IPv4-mapped IPv6 to its IPv4 form", () => {
      // One client reaching a dual-stack socket must be one bucket, not two.
      expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    });

    it("groups IPv6 by /64", () => {
      // A subscriber holds a whole /64, so a per-address counter costs nothing to evade.
      const a = normalizeIp("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
      const b = normalizeIp("2001:db8:1234:5678:1111:2222:3333:4444");
      expect(a).toBe("2001:db8:1234:5678::/64");
      expect(a).toBe(b);

      const other = normalizeIp("2001:db8:1234:9999::1");
      expect(other).toBe("2001:db8:1234:9999::/64");
      expect(other).not.toBe(a);
    });

    it("expands a compressed IPv6 address before taking its prefix", () => {
      expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
      expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    });

    it("is case-insensitive", () => {
      expect(normalizeIp("2001:DB8:1234:5678::1")).toBe(
        normalizeIp("2001:db8:1234:5678::1"),
      );
    });

    it("maps a missing peer address to one shared bucket, never to a free identity", () => {
      expect(normalizeIp("")).toBe("unknown");
      expect(clientIp(req(""), 0)).toBe("unknown");
    });
  });
});
