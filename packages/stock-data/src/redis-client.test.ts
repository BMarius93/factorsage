import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createStockDataRedisClient } from "./redis-client.js";

/** A port nothing listens on yet: taken from the OS, then released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (address === null || typeof address === "string") {
    throw new Error("no TCP port");
  }
  return address.port;
}

/**
 * The few replies a client needs to become ready and answer a PING: `INFO` (the ready check, not
 * loading), `PING`, and `+OK` to anything else a client sends on connect.
 */
function fakeRedis(port: number): Promise<Server> {
  const server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const parsed = /^\*(\d+)\r\n/.exec(pending);
        if (!parsed) {
          return;
        }
        let offset = parsed[0].length;
        const parts: string[] = [];
        for (let index = 0; index < Number(parsed[1]); index += 1) {
          const header = /^\$(\d+)\r\n/.exec(pending.slice(offset));
          if (
            !header ||
            pending.length < offset + header[0].length + Number(header[1]) + 2
          ) {
            return;
          }
          offset += header[0].length;
          parts.push(pending.slice(offset, offset + Number(header[1])));
          offset += Number(header[1]) + 2;
        }
        pending = pending.slice(offset);
        const command = (parts[0] ?? "").toUpperCase();
        if (command === "INFO") {
          const info = "# Server\r\nredis_version:7.0.0\r\nloading:0\r\n";
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (command === "PING") {
          socket.write("+PONG\r\n");
        } else {
          socket.write("+OK\r\n");
        }
      }
    });
  });
  return new Promise((resolveListen) =>
    server.listen(port, "127.0.0.1", () => resolveListen(server)),
  );
}

describe("createStockDataRedisClient", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("fails a pending command within a moment of an outage by default", async () => {
    const port = await freePort();
    const redis = createStockDataRedisClient(
      `redis://127.0.0.1:${port}/0`,
      () => {},
    );
    cleanups.push(() => redis.disconnect());
    const startedAt = Date.now();

    await expect(redis.ping()).rejects.toMatchObject({
      name: "MaxRetriesPerRequestError",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("lets a command wait through refused connections until Redis is back", async () => {
    const port = await freePort();
    const redis = createStockDataRedisClient(
      `redis://127.0.0.1:${port}/0`,
      () => {},
      {
        maxRetriesPerRequest: 30,
      },
    );
    cleanups.push(() => redis.disconnect());

    const reply = redis.ping();
    // Nothing listens for the first second: every connection is refused, and the command waits.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const server = await fakeRedis(port);
    cleanups.push(
      () =>
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    );

    await expect(reply).resolves.toBe("PONG");
  });
});
