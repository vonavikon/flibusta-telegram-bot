// Minimal Telegram API interface for status messages. We take three methods
// so tests can run on a simple stub without pulling in the whole grammy.Bot["api"] type.
// grammy's bot.api satisfies this structurally.
export type StatusApi = {
  sendMessage(chatId: number, text: string, extra?: object): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, extra?: object): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
};

export type MsgRef = { chatId: number; msgId: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createStatusMessenger(api: StatusApi) {
  // Last text per message — to avoid calling editMessageText with the same text
  // (Telegram replies 400 "message is not modified").
  const lastText = new Map<string, string>();

  return {
    async send(chatId: number, text: string): Promise<MsgRef> {
      const m = await api.sendMessage(chatId, text);
      lastText.set(`${chatId}:${m.message_id}`, text);
      return { chatId, msgId: m.message_id };
    },

    async edit(ref: MsgRef, text: string, extra?: object): Promise<void> {
      const key = `${ref.chatId}:${ref.msgId}`;
      if (lastText.get(key) === text) return; // skip-if-same
      lastText.set(key, text);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await api.editMessageText(ref.chatId, ref.msgId, text, extra);
          return;
        } catch (e) {
          const err = e as { error_code?: number; parameters?: { retry_after?: number } };
          if (
            err?.error_code === 429 &&
            typeof err.parameters?.retry_after === "number" &&
            attempt === 0
          ) {
            // RetryAfter: wait as long as Telegram asks, one retry.
            await sleep(err.parameters.retry_after * 1000);
            continue;
          }
          // 400 "message is not modified" and the like — status must not break the main flow.
          console.warn("status edit failed:", (e as Error).message ?? e);
          return;
        }
      }
    },

    async delete(ref: MsgRef): Promise<void> {
      lastText.delete(`${ref.chatId}:${ref.msgId}`);
      try {
        await api.deleteMessage(ref.chatId, ref.msgId);
      } catch (e) {
        console.warn("status delete failed:", (e as Error).message ?? e);
      }
    },
  };
}

export type StatusMessenger = ReturnType<typeof createStatusMessenger>;
