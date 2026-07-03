/**
 * Moderator permission gate (pure).
 *
 * Decides whether an invoking member may run a moderator-only command, given
 * the guild's configured mod role and the member's Discord standing. Kept as a
 * pure function with no discord.js import so it is trivially testable; the
 * Discord layer is responsible for extracting the inputs from an interaction.
 *
 * Bootstrap problem: a freshly-installed bot has no mod_role set yet, so no
 * role could authorize the first `/raffle config` call. Until a mod_role
 * exists, the guild owner or anyone with the Manage Server permission may act;
 * both remain valid escape hatches even after a mod_role is configured. See
 * design.md "Moderator (permission-gated by role)".
 */

export interface ModeratorInput {
  /** The guild's configured mod role id, or null if none is set yet. */
  modRole: string | null;
  /** Role ids the invoking member currently holds. */
  memberRoleIds: readonly string[];
  /** Whether the invoking member owns the guild. */
  isGuildOwner: boolean;
  /** Whether the invoking member has the Manage Server permission. */
  hasManageGuild: boolean;
}

/**
 * Whether `input` describes a member allowed to run moderator commands.
 *
 *   - Guild owner or Manage-Server permission always passes (and is the only
 *     way to pass before a mod role is configured — the bootstrap path).
 *   - Once a mod role is set, holding that role also passes.
 */
export function isModerator(input: ModeratorInput): boolean {
  if (input.isGuildOwner || input.hasManageGuild) {
    return true;
  }
  if (input.modRole === null) {
    return false;
  }
  return input.memberRoleIds.includes(input.modRole);
}
