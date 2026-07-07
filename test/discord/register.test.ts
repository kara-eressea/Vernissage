import { describe, expect, it } from "vitest";
import { partitionRegistrable } from "../../src/discord/register.js";

/**
 * The allowlist may be provisioned ahead of time with guilds the bot has not
 * joined yet; registration must target only current member guilds and report
 * the rest as skipped (they get their commands on join instead).
 */
describe("partitionRegistrable", () => {
  it("registers to member guilds and skips pre-provisioned ones", () => {
    const { registrable, skipped } = partitionRegistrable(
      ["g1", "g2", "g3"],
      new Set(["g2", "g3", "not-allowlisted"]),
    );
    expect(registrable).toEqual(["g2", "g3"]);
    expect(skipped).toEqual(["g1"]);
  });

  it("never registers to a member guild that is not on the allowlist", () => {
    const { registrable, skipped } = partitionRegistrable(["g1"], new Set(["g1", "foreign"]));
    expect(registrable).toEqual(["g1"]);
    expect(skipped).toEqual([]);
  });

  it("skips everything when the bot is in no guilds yet", () => {
    const { registrable, skipped } = partitionRegistrable(["g1", "g2"], new Set());
    expect(registrable).toEqual([]);
    expect(skipped).toEqual(["g1", "g2"]);
  });
});
