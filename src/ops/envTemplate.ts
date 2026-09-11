/**
 * The `env.template` written into a backup archive.
 *
 * A backup records how the old host was configured without ever carrying its
 * secrets: the token, the OAuth client secret, the session secret, and the
 * handoff secret are always left blank, and the operator copies those across
 * from the old host's .env themselves. Everything else — the app id, the guild
 * allowlist, the dashboard URL and port — is written out with its real value, so
 * the archive alone is enough to reconstruct the settings.
 *
 * The key list is derived from the ENV and WEB_ENV maps rather than written out
 * again here, so a variable added to the config surface cannot be silently
 * missed by a backup.
 */

import { ENV } from "../config.js";
import { WEB_ENV } from "../web/config.js";

/**
 * The variables whose values are secrets. Named off the ENV and WEB_ENV maps so
 * renaming one cannot quietly turn it into a value that gets written out.
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  ENV.token,
  ENV.handoffSecret,
  WEB_ENV.clientSecret,
  WEB_ENV.sessionSecret,
]);

/**
 * Variables that are deliberately safe to write out in full. Every known key
 * must be in either this set or SECRET_ENV_KEYS — a test enforces it — so
 * adding one to the config surface forces a decision about it here rather than
 * defaulting it into the archive.
 */
export const NON_SECRET_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  ENV.appId,
  ENV.guildIds,
  ENV.homeGuildId,
  ENV.databasePath,
  ENV.handoffHost,
  ENV.handoffPort,
  WEB_ENV.clientId,
  WEB_ENV.baseUrl,
  WEB_ENV.port,
  WEB_ENV.trustProxy,
  WEB_ENV.revalidateAccess,
  // A list of Discord user ids: public identifiers, and part of how the host is
  // configured, so it belongs in the archive in full.
  WEB_ENV.supportUserIds,
  WEB_ENV.handoffUrl,
]);

/**
 * Names that read as secret-bearing whatever the lists say. A backstop for the
 * window between someone adding a secret to ENV and remembering this file: the
 * value stays out of the archive even if the classification was missed.
 */
const SECRET_NAME_PATTERN = /SECRET|TOKEN|PASSWORD/;

/** Whether a variable's value must be withheld from the archive. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEYS.has(key) || SECRET_NAME_PATTERN.test(key);
}

/** Every environment variable the bot or the dashboard reads, in declaration order. */
export function knownEnvKeys(): string[] {
  return [...new Set([...Object.values(ENV), ...Object.values(WEB_ENV)])];
}

/**
 * Render the template from an environment map. A variable that was set on the
 * old host is written as a live line (blank, if it is a secret); one that was
 * not set is written commented out, so the template mirrors what was actually
 * configured.
 */
export function renderEnvTemplate(env: NodeJS.ProcessEnv, createdAt: string): string {
  const lines = [
    `# Configuration recorded from the old host at ${createdAt}.`,
    `#`,
    `# Secrets are deliberately NOT included in backups. The blank ones below were`,
    `# set on the old host and must be filled in here before starting the bot —`,
    `# copy them from that host's .env, or reissue them in the Discord Developer`,
    `# Portal. Commented-out lines were not set on the old host.`,
    `#`,
    `# Rename this file to .env once it is filled in.`,
    ``,
  ];

  for (const key of knownEnvKeys()) {
    const value = env[key]?.trim();
    const isSecret = isSecretEnvKey(key);

    if (!value) {
      lines.push(`# ${key}=`);
    } else if (isSecret) {
      lines.push(`# ${key} was set on the old host — fill it in.`);
      lines.push(`${key}=`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  lines.push(``);
  return lines.join("\n");
}
