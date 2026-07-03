import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitSecret, verifyCommitment } from "../../src/core/commitReveal.js";

describe("commitSecret", () => {
  it("is deterministic and equals an independent SHA-256 of the secret", () => {
    const expected = createHash("sha256").update("abc", "utf8").digest("hex");
    expect(commitSecret("abc")).toBe(expected);
    expect(commitSecret("abc")).toBe(commitSecret("abc"));
    expect(commitSecret("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("differs for different secrets", () => {
    expect(commitSecret("abc")).not.toBe(commitSecret("abd"));
  });
});

describe("verifyCommitment", () => {
  it("accepts the matching secret and rejects any other", () => {
    const commitment = commitSecret("s3cr3t");
    expect(verifyCommitment("s3cr3t", commitment)).toBe(true);
    expect(verifyCommitment("wrong", commitment)).toBe(false);
  });
});
