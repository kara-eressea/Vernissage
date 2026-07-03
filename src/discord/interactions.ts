/**
 * Component and modal-submit interaction routing.
 *
 * Chat-input commands are dispatched by router.ts; buttons, select menus, and
 * modal submissions are dispatched here. Handlers register under a custom-id
 * namespace (the segment before the first ":"), so each feature owns its own
 * prefix — the wizard uses "wiz", later issues add their own (the Enter button,
 * draw controls). Errors are contained so one bad interaction never crashes the
 * process, mirroring router.ts.
 */

import { MessageFlags } from "discord.js";
import type { Interaction } from "discord.js";

/** An interaction that carries a custom id (button, select menu, modal submit). */
export interface CustomIdInteraction {
  customId: string;
  replied: boolean;
  deferred: boolean;
  reply(options: unknown): Promise<unknown>;
  followUp(options: unknown): Promise<unknown>;
}

export type InteractionHandler = (interaction: CustomIdInteraction) => Promise<void>;

/** The custom-id namespace of an interaction: the segment before the first ":". */
export function customIdNamespace(customId: string): string {
  return customId.split(":", 1)[0] ?? "";
}

export interface InteractionRouter {
  /** Register a handler for all custom ids in a namespace. */
  register(namespace: string, handler: InteractionHandler): void;
  /** Dispatch an interaction to its handler; returns whether one handled it. */
  route(interaction: CustomIdInteraction): Promise<boolean>;
}

/** Create an empty interaction router. */
export function createInteractionRouter(): InteractionRouter {
  const handlers = new Map<string, InteractionHandler>();

  return {
    register(namespace, handler) {
      handlers.set(namespace, handler);
    },
    async route(interaction) {
      const handler = handlers.get(customIdNamespace(interaction.customId));
      if (!handler) {
        return false;
      }
      try {
        await handler(interaction);
      } catch (err) {
        console.error(`Error handling interaction ${interaction.customId}:`, err);
        const message = {
          content: "Something went wrong handling that.",
          flags: MessageFlags.Ephemeral,
        };
        // The fallback reply can itself fail: the handler may have already
        // acknowledged via showModal (which leaves replied/deferred false), or
        // the interaction token may have expired (>3s). Never let the error
        // path throw — that would escape as an unhandled rejection.
        try {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(message);
          } else {
            await interaction.reply(message);
          }
        } catch (replyErr) {
          console.error(`Could not report interaction error to the user:`, replyErr);
        }
      }
      return true;
    },
  };
}

/** Whether an interaction is one this router can dispatch (has a custom id). */
export function isRoutableComponent(interaction: Interaction): boolean {
  return (
    interaction.isButton() ||
    interaction.isAnySelectMenu() ||
    interaction.isModalSubmit()
  );
}
