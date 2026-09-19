"use strict";

/**
 * E2E egress guard: preloaded into every process of the deterministic E2E stack
 * (`NODE_OPTIONS=--require=…/egress-guard.cjs`, set by `e2eStackEnvironment`).
 *
 * The stack is meant to be hermetic — PostgreSQL, Redis, the fixture FMP server and the
 * applications themselves, all on this machine. Configuration is what points each integration at
 * its local stand-in; this is what *proves* it worked. Every outbound TCP/TLS connection is checked
 * before it is opened: a loopback destination proceeds, anything else is refused with
 * `E2E_EGRESS_BLOCKED` before a DNS lookup or a SYN leaves the machine, and the attempt is recorded
 * in the egress log the Playwright teardown fails on. A provider nobody remembered to fake
 * therefore shows up as a failed request and a failed run, never as a quiet live call.
 *
 * Every socket in Node — `http`, `https`, `fetch`/undici, `tls`, `http2`, database and Redis
 * drivers — opens through `net.Socket.prototype.connect`, which is the one place this patches.
 * Unix-domain sockets (`path`) are local IPC and always allowed.
 *
 * Plain CommonJS so it can be preloaded before any TypeScript tooling exists in the process.
 * Test-only: nothing in an application imports it, and production never sets NODE_OPTIONS to it.
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const LOG = process.env.E2E_EGRESS_LOG;
const ROLE = process.env.E2E_STACK_ROLE || "unknown";
const COMMAND = process.argv.slice(1, 3).join(" ");

function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") {
    // Node's own default for a missing host is localhost.
    return true;
  }
  const value = String(host)
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(value) ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(value)
  );
}

function record(entry) {
  if (!LOG) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, role: ROLE, command: COMMAND, ...entry })}\n`,
    );
  } catch {
    // The refusal itself is what protects the network; a log that cannot be written must not
    // turn a blocked connection into a crashed process.
  }
}

/** The destination of a `connect(...)` call, in any of the argument shapes Node accepts. */
function destination(args) {
  const first = args[0];
  if (Array.isArray(first)) {
    // Node's internal normalized form: [options, callback].
    return destination(first);
  }
  if (first !== null && typeof first === "object") {
    return { host: first.host, port: first.port, path: first.path };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) {
    return { path: first };
  }
  return {
    port: first,
    host: typeof args[1] === "string" ? args[1] : undefined,
  };
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = destination(args);
  if (target.path !== undefined || isLoopbackHost(target.host)) {
    return originalConnect.apply(this, args);
  }
  const host = String(target.host);
  const port = target.port === undefined ? "" : String(target.port);
  record({ kind: "blocked", host, port });
  process.stderr.write(
    `[e2e-egress-guard] BLOCKED outbound connection to ${host}:${port} from ${ROLE} (pid ${process.pid})\n`,
  );
  const error = new Error(
    `E2E egress guard blocked an outbound connection to ${host}:${port}. The E2E stack is ` +
      "hermetic: add a local fixture for this dependency instead (ai/workflows/auth-testing.md §7).",
  );
  error.code = "E2E_EGRESS_BLOCKED";
  process.nextTick(() => this.destroy(error));
  return this;
};

record({ kind: "armed" });

module.exports = { isLoopbackHost };
