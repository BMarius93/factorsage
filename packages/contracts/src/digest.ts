/**
 * SHA-256 of a string, as lowercase hex, computed synchronously in plain TypeScript.
 *
 * `@intrinsic/contracts` is bundled for the browser, where `node:crypto` does not exist and
 * `crypto.subtle` is asynchronous, and the one caller here needs a digest inside a synchronous,
 * pure serialization: a strategy fingerprint that must read the same in the Builder, the API and the
 * worker (`alternativeDataMetricFingerprint`). A cryptographic digest rather than a short checksum,
 * because a collision between two different selections would make an edit look like no change at
 * all — no version appended, no Monitor level reset — and that is not a risk worth a shorter string.
 *
 * `digest.test.ts` holds it to `node:crypto` on the standard vectors and on multi-block inputs.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The UTF-8 encoding of a string, without `TextEncoder`, which this package's `lib` does not type. */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  // The message length in bits, as a 64-bit big-endian integer. The high word is taken by division
  // because a bitwise shift would truncate a length past 2^32 bits to its low word.
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) {
    bytes.push(
      (word >>> 24) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 8) & 0xff,
      word & 0xff,
    );
  }

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  // Every index below is inside its array by construction, so the reads are asserted rather than
  // defaulted: a silent `?? 0` would turn an indexing mistake into a wrong digest.
  const at = (words: Uint32Array, index: number): number =>
    words[index] as number;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      schedule[index] =
        (((bytes[start] as number) << 24) |
          ((bytes[start + 1] as number) << 16) |
          ((bytes[start + 2] as number) << 8) |
          (bytes[start + 3] as number)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = at(schedule, index - 15);
      const recent = at(schedule, index - 2);
      const small0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const small1 =
        rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[index] =
        at(schedule, index - 16) + small0 + at(schedule, index - 7) + small1;
    }

    let a = at(state, 0);
    let b = at(state, 1);
    let c = at(state, 2);
    let d = at(state, 3);
    let e = at(state, 4);
    let f = at(state, 5);
    let g = at(state, 6);
    let h = at(state, 7);
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first =
        (h +
          big1 +
          choice +
          at(ROUND_CONSTANTS, index) +
          at(schedule, index)) >>>
        0;
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = at(state, 0) + a;
    state[1] = at(state, 1) + b;
    state[2] = at(state, 2) + c;
    state[3] = at(state, 3) + d;
    state[4] = at(state, 4) + e;
    state[5] = at(state, 5) + f;
    state[6] = at(state, 6) + g;
    state[7] = at(state, 7) + h;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}
