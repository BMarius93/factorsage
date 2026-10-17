import type { Redis } from "ioredis";
import { stockCachePayloadCodecs } from "./cache.js";
import type { RedisPayloadCodec } from "./redis-payload-codec.js";

/**
 * Reads a cache payload the way the cache does — raw bytes through the payload codec — for tests and
 * tooling that inspect a stored chunk. `null` when the key is absent; throws when the payload does
 * not decode, because a test reading a chunk it expects to be sound should fail loudly.
 */
export async function cachePayloadText(
  redis: Pick<Redis, "getBuffer">,
  key: string,
  codec: RedisPayloadCodec = stockCachePayloadCodecs().dailyState,
): Promise<string | null> {
  const payload = await redis.getBuffer(key);
  if (payload === null) {
    return null;
  }
  const decoded = codec.decode(payload);
  if (!decoded.ok) {
    throw new Error(`${key} does not decode: ${decoded.reason}`);
  }
  return decoded.text;
}
