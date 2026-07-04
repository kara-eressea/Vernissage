import { vi } from "vitest";
import type { Notifier } from "../../src/discord/notifier.js";

/**
 * A fake Notifier whose every method is a resolved `vi.fn()`. Shared so that
 * adding a method to the Notifier interface is a one-line change here rather
 * than an edit across every command/handler test. Tests that need to assert on
 * a posted event read the mock directly, e.g.
 * `notifier.mirrorAudit.mock.calls`.
 *
 * Keep the concrete return type (not `Notifier`) so callers retain the `vi.fn`
 * mock handles; it `satisfies Notifier` to stay in sync with the interface.
 */
export function makeFakeNotifier() {
  return {
    resolveAuditChannel: vi.fn().mockResolvedValue(undefined),
    mirrorAudit: vi.fn().mockResolvedValue(undefined),
    postEntryMessage: vi.fn().mockResolvedValue(undefined),
    postAudit: vi.fn().mockResolvedValue(undefined),
    postAnnouncement: vi.fn().mockResolvedValue(undefined),
  } satisfies Notifier;
}
