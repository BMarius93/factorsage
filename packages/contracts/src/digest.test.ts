import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./digest.js";

const reference = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256Hex", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with node:crypto at every length around the block boundaries", () => {
    // 55, 56, 63, 64 and 65 bytes are where the padding changes shape; the loop covers them and
    // everything between, plus enough length to span several blocks.
    for (let length = 0; length <= 200; length += 1) {
      const text = "a".repeat(length);
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });

  it("agrees with node:crypto on a selection of 250 identifiers", () => {
    const ids = Array.from(
      { length: 250 },
      (_, index) =>
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const text = ids.join("+");
    expect(sha256Hex(text)).toBe(reference(text));
  });

  it("hashes the UTF-8 encoding, including characters outside the basic plane", () => {
    for (const text of ["é", "Ünïcödé — ok", "漢字", "😀 mixed 😀"]) {
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });
});
