import { describe, it, expect, vi } from "vitest";
import { createBotHandlers } from "../src/bot.js";

const mkOrchestrator = (books: any[]) => ({
  search: vi.fn().mockResolvedValue({ books, degraded: false }),
});
const mkAnalytics = () => ({
  logSearch: vi.fn(), logDownload: vi.fn(), report: vi.fn().mockReturnValue("REPORT"),
  countSince: vi.fn().mockReturnValue(0),
});
const mkDownloader = () => ({
  fetchThen: vi.fn().mockImplementation(async (url: string, filename: string, onf: any) => {
    // Create a fake file in a location that exists
    const fakeFile = "./tmp-fake-test-file.fb2";
    // Create the file if it doesn't exist
    const fs = await import("node:fs/promises");
    await fs.writeFile(fakeFile, "fake content");
    try {
      await onf(fakeFile);
      return { size: 1024 };
    } finally {
      // Clean up
      await fs.unlink(fakeFile).catch(() => {});
    }
  }),
});
const mkFlibusta = () => ({
  searchBooks: vi.fn(), downloadUrl: vi.fn().mockReturnValue("https://flibusta.is/b/1/fb2"),
});
const mkMessenger = () => ({
  send: vi.fn().mockResolvedValue({ chatId: 111, msgId: 500 }),
  edit: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
});

function mkCtx(extra: any = {}) {
  return {
    from: { id: 111 },
    message: { text: "конан дойл шерлок" },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    replyWithDocument: vi.fn().mockResolvedValue(undefined),
    callbackQuery: { data: "" },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

describe("bot handlers", () => {
  const cfg = {
    botToken: "t", allowedIds: [111], adminIds: [111],
    rateLimitPerMin: 20, flibustaBase: "https://flibusta.is", maxQueryLen: 200,
    unlimitedIds: [], downloadDailyLimit: 5, searchDailyLimit: 20,
  } as any;

  it("responds to any user (allowlist off)", async () => {
    const h = createBotHandlers(cfg as any, mkOrchestrator([]) as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx({ from: { id: 999 } });
    await h.onText(ctx);
    await h.idle();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("onText: блокирует поиск при дневном лимите", async () => {
    const o = mkOrchestrator([]);
    const a = mkAnalytics(); a.countSince.mockReturnValue(20);
    const h = createBotHandlers(cfg as any, o as any, a as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx({ from: { id: 222 } });
    await h.onText(ctx);
    await h.idle();
    expect(o.search).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("onText: безлимитный юзер обходит лимит поиска", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const o = mkOrchestrator(books);
    const a = mkAnalytics(); a.countSince.mockReturnValue(20);
    const cfgU = { ...cfg, unlimitedIds: [222] };
    const h = createBotHandlers(cfgU as any, o as any, a as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx({ from: { id: 222 } });
    await h.onText(ctx);
    await h.idle();
    expect(o.search).toHaveBeenCalledWith("конан дойл шерлок", expect.any(Number), expect.any(Function));
  });

  it("onFmtCallback: блокирует скачивание при дневном лимите", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const a = mkAnalytics(); a.countSince.mockReturnValue(5);
    const d = mkDownloader();
    const h = createBotHandlers(cfg as any, mkOrchestrator(books) as any, a as any, d as any, mkFlibusta() as any);
    (h as any).lastResults.set(222, books);
    const ctx = mkCtx({ from: { id: 222 }, callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx);
    await h.idle();
    expect(d.fetchThen).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("onText: searches and replies with book list", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const o = mkOrchestrator(books);
    const a = mkAnalytics();
    const h = createBotHandlers(cfg as any, o as any, a as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx();
    await h.onText(ctx);
    await h.idle();
    expect(o.search).toHaveBeenCalledWith("конан дойл шерлок", expect.any(Number), expect.any(Function));
    expect(a.logSearch).toHaveBeenCalledWith(111, "конан дойл шерлок");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("onBookCallback: shows formats", async () => {
    const books = [{ title: "Шерлок", formats: ["fb2", "epub"], downloads: [{ link: "/b/1/fb2", format: "fb2" }, { link: "/b/1/epub", format: "epub" }] }];
    const o = mkOrchestrator(books);
    const h = createBotHandlers(cfg as any, o as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx({ callbackQuery: { data: "book:0" } });
    // simulate a saved search result
    (h as any).lastResults.set(111, books);
    await h.onCallback(ctx);
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it("onFmtCallback: downloads and logs", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const o = mkOrchestrator(books);
    const a = mkAnalytics();
    const d = mkDownloader();
    const fl = mkFlibusta();
    const h = createBotHandlers(cfg as any, o as any, a as any, d as any, fl as any);
    (h as any).lastResults.set(111, books);
    const ctx = mkCtx({ callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx);
    await h.idle();
    expect(fl.downloadUrl).toHaveBeenCalled();
    expect(d.fetchThen).toHaveBeenCalled();
    expect(ctx.replyWithDocument).toHaveBeenCalled();
    expect(a.logDownload).toHaveBeenCalled();
  });

  it("onFmtCallback: отбрасывает повторный клик, пока файл качается", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const fl = mkFlibusta();
    let resolveFirst: () => void = () => {};
    const pending = new Promise<void>((r) => { resolveFirst = r; });
    let calls = 0;
    const d = {
      fetchThen: vi.fn().mockImplementation(async (_url: string, _filename: string, onf: any) => {
        calls++;
        if (calls === 1) await pending; // first click hangs until we resolve
        const fs = await import("node:fs/promises");
        const f = "./tmp-fake-test-file.fb2";
        await fs.writeFile(f, "x");
        try { await onf(f); } finally { await fs.unlink(f).catch(() => {}); }
        return { size: 1024 };
      }),
    };
    const h = createBotHandlers(cfg as any, mkOrchestrator(books) as any, mkAnalytics() as any, d as any, fl as any);
    (h as any).lastResults.set(111, books);

    h.onCallback(mkCtx({ callbackQuery: { data: "fmt:0:fb2" } }));
    await new Promise((r) => setImmediate(r)); // let the first click reach the hanging await

    const ctx2 = mkCtx({ callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx2);
    expect(d.fetchThen).toHaveBeenCalledTimes(1);
    expect(ctx2.reply).toHaveBeenCalled();
    expect(ctx2.replyWithDocument).not.toHaveBeenCalled();

    resolveFirst();
    await h.idle();
  });

  it("onFmtCallback: блокирует повторное скачивание сразу после успешного (кулдаун)", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const fl = mkFlibusta();
    const d = mkDownloader();
    const a = mkAnalytics();
    const h = createBotHandlers(cfg as any, mkOrchestrator(books) as any, a as any, d as any, fl as any);
    (h as any).lastResults.set(111, books);

    await h.onCallback(mkCtx({ callbackQuery: { data: "fmt:0:fb2" } })); // start the background download
    await h.idle(); // download finished, cooldown armed, inflight cleared
    const ctx2 = mkCtx({ callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx2); // within the cooldown -> rejected
    expect(d.fetchThen).toHaveBeenCalledTimes(1);
    expect(ctx2.reply).toHaveBeenCalled();
    expect(ctx2.replyWithDocument).not.toHaveBeenCalled();
  });

  it("onText: отвергает слишком длинный запрос без поиска", async () => {
    const o = mkOrchestrator([]);
    const a = mkAnalytics();
    const h = createBotHandlers(cfg as any, o as any, a as any, mkDownloader() as any, mkFlibusta() as any);
    const ctx = mkCtx({ message: { text: "а".repeat(300) } });
    await h.onText(ctx);
    expect(o.search).not.toHaveBeenCalled();
    expect(a.logSearch).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("runDownload: send → edit(прогресс) → edit(Отправляю) → delete на успехе", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const m = mkMessenger();
    // a downloader that actually drives onProgress with a growing downloaded.
    const d = {
      fetchThen: vi.fn().mockImplementation(async (_url: string, _filename: string, onf: any, _fmt: string, onProgress: any) => {
        onProgress?.({ downloaded: 3, total: 5 });
        onProgress?.({ downloaded: 5, total: 5 });
        const fs = await import("node:fs/promises");
        const f = "./tmp-fake-test-file.fb2";
        await fs.writeFile(f, "x");
        try { await onf(f); } finally { await fs.unlink(f).catch(() => {}); }
        return { size: 5 };
      }),
    };
    const h = createBotHandlers(cfg as any, mkOrchestrator(books) as any, mkAnalytics() as any, d as any, mkFlibusta() as any, m as any);
    (h as any).lastResults.set(111, books);
    const ctx = mkCtx({ callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx);
    await h.idle();
    expect(m.send).toHaveBeenCalledWith(111, expect.stringContaining("Шерлок"));
    // progress edits the status to "Downloaded …%"
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, expect.stringMatching(/^Скачано \d+% /));
    // before sending the document — "Sending…"
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, "Отправляю…");
    expect(ctx.replyWithDocument).toHaveBeenCalled();
    // success — status deleted
    expect(m.delete).toHaveBeenCalledWith({ chatId: 111, msgId: 500 });
  });

  it("runDownload: на ошибке правит статус на текст ошибки (без delete)", async () => {
    const books = [{ title: "Шерлок", book_id: 1, formats: ["fb2"], downloads: [{ link: "/b/1/fb2", format: "fb2" }] }];
    const m = mkMessenger();
    const d = { fetchThen: vi.fn().mockRejectedValue(new Error("upstream 500")) };
    const h = createBotHandlers(cfg as any, mkOrchestrator(books) as any, mkAnalytics() as any, d as any, mkFlibusta() as any, m as any);
    (h as any).lastResults.set(111, books);
    const ctx = mkCtx({ callbackQuery: { data: "fmt:0:fb2" } });
    await h.onCallback(ctx);
    await h.idle();
    expect(m.send).toHaveBeenCalled();
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, "Не удалось скачать. Попробуй другой формат.");
    expect(m.delete).not.toHaveBeenCalled();
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
  });

  it("runSearch: быстрый путь (кэш/быстрый промах) — без статус-сообщения, только reply", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", formats: ["fb2"], downloads: [] }];
    const m = mkMessenger();
    const o = mkOrchestrator(books); // resolves instantly — the lazy timer has no time to fire
    const h = createBotHandlers(cfg as any, o as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any, m as any);
    const ctx = mkCtx();
    await h.onText(ctx);
    await h.idle();
    expect(m.send).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("runSearch: медленный путь — send статуса, edit на смену фазы, финальный edit списком", async () => {
    const books = [{ title: "Шерлок", author: "Конан Дойль", formats: ["fb2"], downloads: [] }];
    const m = mkMessenger();
    const o = {
      search: vi.fn().mockImplementation(async (_q: string, _n: number, onProgress: any) => {
        onProgress?.({ kind: "parsing" });
        await new Promise((r) => setTimeout(r, 750)); // > 700 ms → the lazy status gets created
        onProgress?.({ kind: "searching" });
        return { books, degraded: false };
      }),
    };
    const h = createBotHandlers(cfg as any, o as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any, m as any);
    const ctx = mkCtx();
    await h.onText(ctx);
    await h.idle();
    // status created with the first phase
    expect(m.send).toHaveBeenCalledWith(111, "Разбираю запрос…");
    // a phase change edits the status
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, "Ищу у себя в библиотеке…");
    // the final edit replaces the status with the book list (with keyboard)
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, expect.any(String), expect.objectContaining({ parse_mode: "HTML" }));
    // no separate reply — the list went into the same message
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("runSearch: lowRelevance → пометка «по приближению» в выдаче", async () => {
    const books = [{ title: "Чужая Книга", author: "Неизвестный", formats: ["fb2"], downloads: [] }];
    const m = mkMessenger();
    const o = {
      search: vi.fn().mockImplementation(async (_q: string, _n: number, onProgress: any) => {
        onProgress?.({ kind: "parsing" });
        await new Promise((r) => setTimeout(r, 750));
        onProgress?.({ kind: "searching" });
        return { books, degraded: false, lowRelevance: true };
      }),
    };
    const h = createBotHandlers(cfg as any, o as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any, m as any);
    const ctx = mkCtx();
    await h.onText(ctx);
    await h.idle();
    expect(m.edit).toHaveBeenCalledWith({ chatId: 111, msgId: 500 }, expect.stringContaining("похожие"), expect.objectContaining({ parse_mode: "HTML" }));
  });

  it("runSearch: новый запрос обгоняет висящий старый — lastResults за новым, статус старого удалён", async () => {
    const booksA = [{ title: "Книга А", author: "Автор А", formats: ["fb2"], downloads: [] }];
    const booksB = [{ title: "Книга Б", author: "Автор Б", formats: ["fb2"], downloads: [] }];
    const m = mkMessenger();
    const o = {
      search: vi.fn().mockImplementation(async (q: string, _n: number, onProgress: any) => {
        onProgress?.({ kind: "parsing" });
        // A hangs longer than the lazy window (700 ms) — it manages to create a status message;
        // B finishes fast and overtakes it. Reproduces the "books replaced
        // with previous" bug: without the race guard A would clobber lastResults with its list.
        if (q.includes("медленный")) await new Promise((r) => setTimeout(r, 900));
        else await new Promise((r) => setTimeout(r, 50));
        onProgress?.({ kind: "searching" });
        return { books: q.includes("медленный") ? booksA : booksB, degraded: false };
      }),
    };
    const h = createBotHandlers(cfg as any, o as any, mkAnalytics() as any, mkDownloader() as any, mkFlibusta() as any, m as any);
    const ctxA = mkCtx({ message: { text: "медленный запрос" } });
    const ctxB = mkCtx({ message: { text: "быстрый запрос" } });
    h.onText(ctxA); // A in background
    await new Promise((r) => setTimeout(r, 120)); // B starts when A is already hanging
    h.onText(ctxB); // B will overtake
    await h.idle(); // wait for both
    // the last result belongs to the new query B; the old A was discarded by the race guard
    expect(h.lastResults.get(111)).toBe(booksB);
    // the hung old request's status message was deleted, not "revived" with the old list
    expect(m.delete).toHaveBeenCalledWith({ chatId: 111, msgId: 500 });
  });
});