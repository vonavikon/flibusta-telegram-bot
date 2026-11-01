import { Bot, InputFile } from "grammy";
import type { Config } from "./config.js";
import type { Analytics } from "./analytics.js";
import { createAnalytics } from "./analytics.js";
import fs from "node:fs/promises";
import type { Db } from "./db.js";
import { createOrchestrator, type SearchProgress } from "./search/orchestrator.js";
import { createLlm } from "./search/llm.js";
import { createFlibusta, type Flibusta, type FlibustaBook } from "./search/flibusta.js";
import { createRoyallib, type Royallib } from "./search/royallib.js";
import { createDownloader } from "./download.js";
import { bookListKeyboard, formatsKeyboard, bookListText, bookCardText } from "./keyboards.js";
import { createStatusMessenger, type StatusMessenger, type MsgRef } from "./status.js";
import { aliasOf, logUsage } from "./usage-log.js";

export type HandlerCtx = {
  from?: { id: number };
  message?: { text?: string };
  callbackQuery?: { data?: string };
  reply(text: string, extra?: unknown): Promise<unknown>;
  replyWithPhoto(photo: InputFile | string, extra?: { caption?: string }): Promise<unknown>;
  replyWithDocument(document: InputFile): Promise<unknown>;
  replyWithChatAction?(action: string): Promise<unknown>;
  answerCallbackQuery(): Promise<unknown>;
  editMessageText(text: string, extra?: unknown): Promise<unknown>;
};

// Semaphore: caps the number of concurrent expensive operations. With
// non-blocking handlers and no cap, a spam queue turns into a dozen simultaneous
// flibusta/LLM calls — risk of upstream throttling and bans.
function makeSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (active < max) { active++; return; }
      await new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      const next = queue.shift();
      if (next) next(); // slot goes to the next waiter, active stays unchanged
      else active--;
    },
  };
}

export function createBotHandlers(
  cfg: Config,
  orchestrator: ReturnType<typeof createOrchestrator>,
  analytics: Analytics,
  downloader: ReturnType<typeof createDownloader>,
  flibusta: Flibusta,
  messenger?: StatusMessenger,
  royallib?: Royallib,
) {
  // Status messages (download progress, search phases). Optional: tests that
  // don't need status don't have to pass a fake — no-op by default.
  const msg: StatusMessenger = messenger ?? {
    async send() { return { chatId: 0, msgId: 0 }; },
    async edit() {},
    async delete() {},
  };
  // Cache of last search results per user_id (in memory, TTL via inactivity — good enough for MVP)
  const lastResults = new Map<number, FlibustaBook[]>();
  // User's last query — used to redraw the list from a book card.
  const lastQuery = new Map<number, string>();
  // Current list page (5 per page, up to 3 pages) — "Back to list"
  // returns the user to the page they were on, not the first one.
  const lastPage = new Map<number, number>();
  // Last request token per user. Search is background: if the user typed a new
  // query while the old one was pending, the old one must not overwrite
  // lastResults or edit the message on completion. We compare reqId — last one wins.
  const lastReqId = new Map<number, number>();
  // In-memory rate limit. Deviation from the spec (which said SQLite): for a 60s sliding window
  // persistence is redundant. Past 100 users, move to db.countEventsSince.
  const hits = new Map<number, number[]>();
  // Repeated "download" clicks while the file is still downloading: key `${userId}:${url}`.
  const inflight = new Set<string>();
  // Cooldown after a successful download of the same file by the same user. grammY awaits
  // each handler, so clicks from later batches arrive after the download has finished
  // and without the cooldown each would produce a duplicate file.
  const lastDownload = new Map<string, number>();
  const DOWNLOAD_COOLDOWN_MS = 10_000;
  // Concurrency limiters for expensive operations (upstream protection). Search — 2:
  // a burst of queries would otherwise flood flibusta with a hundred concurrent calls →
  // throttling and apparent hangs. Download — 5.
  const searchSem = makeSemaphore(2);
  const downloadSem = makeSemaphore(5);
  // Background task registry: the handler starts search/download in background and
  // returns at once; grammY does not await this work. idle() lets tests wait for
  // completion (and, if needed, shut down cleanly).
  const pending = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }
  async function idle(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  // Allowlist is off — the bot is public. "Unlimited" users bypass daily
  // limits (search/download): that is UNLIMITED_IDS plus admins.
  function unlimited(id: number): boolean {
    return cfg.unlimitedIds.includes(id) || cfg.adminIds.includes(id);
  }
  const dayAgo = () => Math.floor(Date.now() / 1000) - 86400;

  function rateLimited(id: number): boolean {
    const now = Date.now();
    const arr = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(id, arr);
    return arr.length > cfg.rateLimitPerMin;
  }

  async function onText(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id) return;
    if (rateLimited(id)) { await ctx.reply("Слишком много запросов, подожди минуту."); return; }

    const text = ctx.message?.text?.trim();
    if (!text) return;
    // Log the query for measurement on real traffic. Commands (/start etc.) are not logged.
    if (!text.startsWith("/")) logUsage({ event: "query", uh: aliasOf(id), q: text, len: text.length });
    // Guard against pasted long text: otherwise the whole chunk goes to the LLM
    // (expensive call, possible timeout). Real book queries are short.
    if (text.length > cfg.maxQueryLen) {
      await ctx.reply(`Слишком длинный запрос — ${text.length} символов. Пришли название или автора, до ${cfg.maxQueryLen} символов.`);
      return;
    }
    // Daily search limit — protects the LLM quota and against abuse on a public bot.
    // Raw searches are counted over a sliding 24h. Unlimited users pass.
    if (!unlimited(id) && analytics.countSince(id, "search", dayAgo()) >= cfg.searchDailyLimit) {
      await ctx.reply(`Лимит поисков исчерпан: ${cfg.searchDailyLimit} за 24 часа. Попробуй через несколько часов.`);
      return;
    }

    analytics.logSearch(id, text);
    // Search runs in background; the handler returns at once. Otherwise grammY holds
    // the update queue for the LLM+OPDS seconds and other users wait; the same
    // root cause was behind duplicate downloads and weak limiting under load.
    void track(runSearch(ctx, id, text));
  }

  async function runSearch(ctx: HandlerCtx, id: number, text: string) {
    const reqId = (lastReqId.get(id) ?? 0) + 1;
    lastReqId.set(id, reqId);
    // Lazy status: on the fast path (cache hit / fast miss < 700 ms) show
    // nothing — otherwise the status would flicker ("appears → list right away").
    // A single native typing action covers the lazy window up to 700 ms.
    void ctx.replyWithChatAction?.("typing").catch(() => {});
    let ref: MsgRef | null = null;
    let pendingSend: Promise<MsgRef> | null = null;
    let resolved = false;
    let currentPhase: SearchProgress = { kind: "parsing" };
    // Throttle editMessage: a prolific author means up to 10 pages of pagination, and
    // Telegram allows ~1 edit/sec. Frequent updates are skipped, but a
    // deferred flush guarantees the last state gets through.
    // skip-if-same in status.ts suppresses repeated identical texts.
    let lastEditAt = 0;
    let pendingFlush: ReturnType<typeof setTimeout> | null = null;
    const THROTTLE_MS = 900;
    const phaseText = (p: SearchProgress): string => {
      switch (p.kind) {
        case "parsing": return "Разбираю запрос…";
        case "splitting": return "Перебираю разбиения запроса…";
        case "title-search": return "Ищу по названию…";
        case "author-found": return `Автор ${p.author}: ${p.books} книг в библиотеке`;
        case "paging":
          return `Листаю: страница ${p.page}/${p.totalPages || "?"}` + (p.found ? `, нашёл «${p.found}»` : "");
        case "retry": return "Библиотека не ответила, пробую ещё раз…";
        case "ranking": return `Сравниваю ${p.count} книг по релевантности…`;
        default: return "Ищу у себя в библиотеке…"; // searching
      }
    };
    const editProgress = (p: SearchProgress): void => {
      currentPhase = p;
      if (!ref) return; // status not sent yet — lazy send will show currentPhase
      const now = Date.now();
      const elapsed = now - lastEditAt;
      const flush = (): void => { lastEditAt = Date.now(); void msg.edit(ref!, phaseText(currentPhase)); };
      if (elapsed >= THROTTLE_MS) {
        flush();
      } else if (!pendingFlush) {
        pendingFlush = setTimeout(() => {
          pendingFlush = null;
          if (resolved || !ref) return;
          flush();
        }, THROTTLE_MS - elapsed);
      }
    };

    const lazy = setTimeout(() => {
      if (resolved) return;
      pendingSend = msg.send(id, phaseText(currentPhase));
      pendingSend.then((r) => { if (!resolved) ref = r; }).catch(() => {});
    }, 700);

    // "Slow" timer: if the search is still running after 5s, the source is stalling and
    // the "Searching…" status reads as a hang to the user. We show explicitly that
    // the bot is alive and still working. One-shot: later events (retry, paging,
    // final list) overwrite it with their own, more specific text.
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    slowTimer = setTimeout(() => {
      if (resolved || !ref) return;
      lastEditAt = Date.now();
      void msg.edit(ref, "Библиотека отвечает медленно, но я продолжаю искать…").catch(() => {});
    }, 5_000);

    // If the status is already in flight (send started but not finished by the time we answer) —
    // await it and put the final text into the same message, not a separate
    // reply. Otherwise, in the 700–1000 ms transition window, status and list would be two
    // messages (flicker).
    const ensureRef = async (): Promise<MsgRef | null> => {
      if (ref) return ref;
      if (pendingSend) { ref = await pendingSend.catch(() => null); return ref; }
      return null;
    };

    try {
      let books: FlibustaBook[] = [];
      let degraded = false;
      let lowRelevance = false;
      await searchSem.acquire();
      try {
        const r = await orchestrator.search(text, 15, editProgress);
        // Race guard: while this request was pending, the user typed a new one — the old
        // result is discarded. Don't overwrite lastResults, don't touch the
        // new request's message; delete our own status message so it doesn't
        // "revive" later with the old list on top of the new one.
        if (lastReqId.get(id) !== reqId) {
          resolved = true;
          clearTimeout(lazy);
          if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
          if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }
          if (ref) await msg.delete(ref).catch(() => {});
          return;
        }
        books = r.books;
        degraded = r.degraded;
        lowRelevance = r.lowRelevance === true;
      } finally {
        searchSem.release();
      }
      resolved = true;
      clearTimeout(lazy);
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }

      if (!books.length) {
        const emptyText = "К сожалению ничего не нашёл. Попробуй написать запрос точнее, добавив автора или полное название книги.";
        const r = await ensureRef();
        if (r) await msg.edit(r, emptyText);
        else await ctx.reply(emptyText);
        return;
      }
      lastResults.set(id, books);
      lastQuery.set(id, text);
      lastPage.set(id, 0);
      const r = await ensureRef();
      // Weak match — a note so the user doesn't take an approximation for an exact answer.
      const hint = lowRelevance ? "Я не нашёл конкретно, что ты просил, но у меня есть похожие экземпляры.\n\n" : "";
      const listText = hint + bookListText(books, text, 0);
      const listExtra = { reply_markup: bookListKeyboard(books, 0), parse_mode: "HTML" };
      if (r) await msg.edit(r, listText, listExtra);
      else await ctx.reply(listText, listExtra);
    } catch (e) {
      resolved = true;
      clearTimeout(lazy);
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }
      console.error("search error:", (e as Error).message, "| query:", text);
      const r = await ensureRef();
      if (r) await msg.edit(r, "Поиск сломался. Извините.").catch(() => {});
      else await ctx.reply("Поиск сломался. Извините.").catch(() => {});
    }
  }

  async function onCallback(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id) return;
    const data = ctx.callbackQuery?.data ?? "";
    const results = lastResults.get(id) ?? [];

    if (data === "list") {
      const page = lastPage.get(id) ?? 0;
      await ctx.editMessageText(bookListText(results, lastQuery.get(id), page), { reply_markup: bookListKeyboard(results, page), parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("page:")) {
      const page = Number(data.slice(5));
      const pages = Math.min(3, Math.ceil(results.length / 5));
      await ctx.answerCallbackQuery();
      if (Number.isNaN(page) || page < 0 || page >= pages) return;
      lastPage.set(id, page);
      await ctx.editMessageText(bookListText(results, lastQuery.get(id), page), { reply_markup: bookListKeyboard(results, page), parse_mode: "HTML" });
      return;
    }

    if (data === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("book:")) {
      const idx = Number(data.slice(5));
      const book = results[idx];
      if (!book) return;
      await ctx.editMessageText(bookCardText(book), { reply_markup: formatsKeyboard(book, idx), parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith("fmt:")) {
      await ctx.answerCallbackQuery();
      if (rateLimited(id)) { await ctx.reply("Слишком много запросов, подожди минуту."); return; }
      const [, idxStr, fmt] = data.split(":");
      const idx = Number(idxStr);
      const book = results[idx];
      if (!book) return;
      // Download = strong implicit ground truth: the user picked a book for
      // this query. The {q, book_id} pair is a ready-made seed for measurement on real traffic.
      logUsage({ event: "choose", uh: aliasOf(id), q: lastQuery.get(id) ?? null, book_id: book.id ?? null, title: book.title, author: book.author ?? null });

      let url: string;
      try {
        // Routing by book source: a royallib book downloads through its own client,
        // otherwise flibusta. Royallib links are already absolute (filled when parsing
        // the card); flibusta links are relative, its client prepends the base.
        const source = book.provider === "royallib" && royallib ? royallib : flibusta;
        url = source.downloadUrl(book, fmt);
      } catch (e) {
        console.error("download url fail:", (e as Error).message, "| book:", book.title, "| fmt:", fmt);
        await ctx.reply("Нет ссылки на этот формат. Выбери другой.");
        return;
      }
      const filename = `${book.title}.${fmt}`.replace(/[\\/:*?"<>|]/g, "_");
      // Daily download limit (sliding 24h). Unlimited users pass.
      if (!unlimited(id) && analytics.countSince(id, "download", dayAgo()) >= cfg.downloadDailyLimit) {
        await ctx.reply(`Дневной лимит скачиваний исчерпан: ${cfg.downloadDailyLimit} за 24 часа. Попробуй через несколько часов.`);
        return;
      }
      // Guard against repeated "download" clicks. Two layers:
      // 1) inflight — the file is downloading right now. The key is set synchronously in
      //    the handler and lives until the background download finishes, so it catches
      //    repeats from any batch (before — only from one: the handler
      //    blocked and the key was cleared before the next click arrived).
      // 2) cooldown — the file was just downloaded (clicks after completion).
      const gkey = `${id}:${url}`;
      if (inflight.has(gkey)) {
        await ctx.reply("Эта книга уже скачивается, подожди немного.");
        return;
      }
      const done = lastDownload.get(gkey);
      if (done && Date.now() - done < DOWNLOAD_COOLDOWN_MS) {
        await ctx.reply("Эта книга уже была скачана. Подожди пару секунд, прежде чем повторить скачивание.");
        return;
      }
      inflight.add(gkey);
      // Download in background — the handler returns at once; the update queue keeps moving.
      void track(runDownload(ctx, id, book, url, filename, fmt, gkey));
      return;
    }
  }

  async function runDownload(ctx: HandlerCtx, id: number, book: FlibustaBook, url: string, filename: string, fmt: string, gkey: string) {
    let ref: MsgRef | null = null;
    try {
      await downloadSem.acquire();
      try {
        ref = await msg.send(id, `Скачиваю «${book.title}»…`);
        const meta = await downloader.fetchThen(url, filename, async (filePath) => {
          const { size } = await fs.stat(filePath);
          // Before sending the document, update the status so the user sees
          // the transition from downloading to sending.
          await msg.edit(ref!, "Отправляю…");
          // grammY requires an InputFile (or a string), not a "raw" object — otherwise
          // the file send silently fell into catch with no log.
          await ctx.replyWithDocument(new InputFile(filePath, filename));
          return { size };
        }, fmt, (p) => { void msg.edit(ref!, formatProgress(p)); });
        lastDownload.set(gkey, Date.now());
        analytics.logDownload(id, {
          book_title: book.title, book_id: extractBookId(book, url),
          author: book.author, genre: book.category, format: fmt, size_bytes: meta.size,
        });
        // Document sent — the status is no longer needed, remove it.
        await msg.delete(ref);
      } finally {
        downloadSem.release();
      }
    } catch (e) {
      // The error used to be swallowed without logging — hence empty logs. Now the cause is visible.
      console.error("download fail:", (e as Error).message, "| url:", url, "| fmt:", fmt, "| book:", book.title);
      // If the status was already sent — edit it to the error text; otherwise a plain reply.
      if (ref) await msg.edit(ref, "Не удалось скачать. Попробуй другой формат.").catch(() => {});
      else await ctx.reply("Не удалось скачать файл. Попробуй другой формат.").catch(() => {});
    } finally {
      inflight.delete(gkey);
    }
  }

  async function onStats(ctx: HandlerCtx) {
    const id = ctx.from?.id;
    if (!id || !cfg.adminIds.includes(id)) return;
    const days = Number(ctx.message?.text?.split(/\s+/)[1]) || 30;
    await ctx.reply(analytics.report(days));
  }

  return { onText, onCallback, onStats, lastResults, idle };
}

function extractBookId(book: FlibustaBook, url: string): number {
  const m = url.match(/\/b\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Bytes → MB (1024-based, 1 decimal place). For download progress.
function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
function formatProgress(p: { downloaded: number; total: number | null }): string {
  if (p.total && p.total > 0) {
    const pct = Math.min(100, Math.round((p.downloaded / p.total) * 100));
    return `Скачано ${pct}% · ${mb(p.downloaded)} / ${mb(p.total)} МБ`;
  }
  // Content-Length unknown (chunked/zip) — no percentages, just the amount.
  return `Скачано ${mb(p.downloaded)} МБ`;
}

// Welcome message for /start and /help. Allowlisted users only:
// the bot stays silent to strangers so it doesn't reveal its existence.
// The image is baked into the Docker image (assets/welcome.jpg).
const WELCOME_IMG = "/app/assets/welcome.jpg";
const WELCOME_TEXT = `Привет. Это бот для поиска и скачивания книг.

Работает он просто: пришли название книги, автора или то и другое. Например:
• белый клык лондон
• пелевин

Получишь список книг с форматами, размером, числом скачиваний и переводом. Нажми на нужный тебе номер, и откроется описание, там выберешь формат для скачивания (fb2, epub, mobi, pdf, txt и другие).

Поиск занимает 2-8 секунд: у плодовитых авторов бот листает страницы библиотеки, а не виснет — следи за статусом.

«Просвещение — это выход человека из состояния своего несовершеннолетия, в котором он находится по собственной вине».`;


// Entry point — assembles everything from the config and starts polling
export function buildApp(cfg: Config, db: Db) {
  const llm = createLlm({ llmBase: cfg.llmBase, llmApiKey: cfg.llmApiKey, model: cfg.model });
  const flibusta = createFlibusta({ base: cfg.flibustaBase, fallbackBase: cfg.flibustaFallbackBase });
  const royallib = createRoyallib({ base: cfg.royallibBase ?? "https://royallib.com" });
  const orchestrator = createOrchestrator(llm, flibusta, {
    cacheTtlSec: cfg.searchCacheTtlSec,
    cacheMax: cfg.searchCacheMax,
  }, royallib);
  const analytics = createAnalytics(db);
  const downloader = createDownloader("/tmp/book-search-downloads");
  const bot = new Bot(cfg.botToken);
  // messenger takes the already-built bot.api: status edits our own
  // messages by id via bot.api.editMessageText, not the incoming one via ctx.
  const messenger = createStatusMessenger(bot.api);
  const handlers = createBotHandlers(cfg, orchestrator, analytics, downloader, flibusta, messenger, royallib);
  // ctx in grammY contains the bot token. On error we log only the message and
  // update_id — not the whole ctx, otherwise the token ends up in permanent logs.
  bot.catch((err) => {
    console.error("bot error:", err.message, "| update_id:", err.ctx?.update?.update_id);
  });
  bot.command("stats", (ctx) => handlers.onStats(ctx as unknown as HandlerCtx));
  // /start and /help — photo with caption, for our users only. If the photo fails
  // (e.g. the file vanished from the image) — fall back to text so onboarding isn't lost.
  const welcome = async (c: HandlerCtx) => {
    const id = c.from?.id;
    if (!id) return;
    const text = `${WELCOME_TEXT}\n\nЛимиты: ${cfg.downloadDailyLimit} скачиваний и ${cfg.searchDailyLimit} поисков за 24 часа.`;
    try {
      await c.replyWithPhoto(new InputFile(WELCOME_IMG), { caption: text });
    } catch (e) {
      console.error("welcome photo fail:", (e as Error).message);
      await c.reply(text);
    }
  };
  bot.command("start", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.command("help", (ctx) => welcome(ctx as unknown as HandlerCtx));
  bot.on("message:text", (ctx) => handlers.onText(ctx as unknown as HandlerCtx));
  bot.on("callback_query:data", (ctx) => handlers.onCallback(ctx as unknown as HandlerCtx));
  return { bot, handlers, db };
}