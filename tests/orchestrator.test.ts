import { describe, it, expect, vi } from "vitest";
import { createOrchestrator, relevance } from "../src/search/orchestrator.js";

const makeMocks = (books: any[]) => ({
  llm: {
    parseQuery: vi.fn().mockResolvedValue({ authors: ["джек лондон"], title: "белый клык" }),
    rankBooks: vi.fn(),
  },
  flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
});

describe("orchestrator", () => {
  it("ранжирует точное совпадение названия выше остальных (детерминированно, без LLM-rank)", async () => {
    const books = [
      { title: "Быки", author: "Лондон Джек", formats: ["fb2"] },
      { title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] },
    ];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("белый клык джек лондон", 5);
    expect(m.llm.parseQuery).toHaveBeenCalledWith("белый клык джек лондон");
    expect(m.flibusta.searchBooks).toHaveBeenCalled();
    // Ranking is deterministic, no second LLM call needed
    expect(m.llm.rankBooks).not.toHaveBeenCalled();
    expect(r.books[0].title).toBe("Белый Клык");
    expect(r.degraded).toBe(false);
  });

  it("деградирует к raw-поиску при ошибке LLM-разбора (результаты всё равно сортируются)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("просто текст", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledWith(
      { title: "просто текст" },
      expect.any(Function),
      { targetTitle: "просто текст" },
    );
    expect(m.llm.rankBooks).not.toHaveBeenCalled();
    expect(r.degraded).toBe(true);
    expect(r.books[0].title).toBe("X");
  });

  it("возвращает пусто (без throw), если flibusta ничего не нашёл", async () => {
    const m = makeMocks([]);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("несуществующее", 5);
    expect(r.books).toHaveLength(0);
  });

  it("кэширует повторный запрос: flibusta и LLM дёргаются по одному разу", async () => {
    const books = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("белый клык", 5);
    await o.search("белый клык", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
    expect(m.llm.parseQuery).toHaveBeenCalledTimes(1);
  });

  it("ключ кэша нормализован: регистр/пунктуация/пробелы не дают промах", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Белый, Клык!", 5);
    await o.search("  белый клык  ", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
  });

  it("разные запросы бьют мимо кэша — два обращения к flibusta", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("пелевин", 5);
    await o.search("акунин", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(2);
  });

  it("деградированный результат не кэшируется: повтор идёт в flibusta заново", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("просто текст", 5);
    await o.search("просто текст", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(2);
  });

  it("промах кэша: onProgress звони parsing → searching → splitting → ranking", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const kinds: string[] = [];
    await o.search("белый клык", 5, (p) => kinds.push(p.kind));
    // The flibusta mock doesn't call paging/author-found/title-search (that's real flibusta,
    // a separate test); the orchestrator generates parsing, searching, splitting
    // (2-token query) and ranking on its own.
    expect(kinds).toEqual(["parsing", "searching", "splitting", "ranking"]);
  });

  it("однословный запрос: splitting не звони (split работает от 2 токенов)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const kinds: string[] = [];
    await o.search("пелевин", 5, (p) => kinds.push(p.kind));
    expect(kinds).toEqual(["parsing", "searching", "ranking"]);
  });

  it("ranking несёт размер пула кандидатов", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    let rankingCount: number | undefined;
    await o.search("белый клык", 5, (p) => { if (p.kind === "ranking") rankingCount = p.count; });
    expect(rankingCount).toBe(1);
  });

  it("кэш-хит: onProgress не звони ни разу", async () => {
    const books = [{ title: "Белый Клык", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("белый клык", 5); // warm up the cache
    const kinds: string[] = [];
    await o.search("белый клык", 5, (p) => kinds.push(p.kind));
    expect(kinds).toEqual([]);
  });
});

describe("relevance: серия", () => {
  it("бонус +60 за точное совпадение серии", () => {
    const base = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    const scored = relevance("белый клык", [], "детство", { title: "Белый Клык", series: "Детство" } as any);
    expect(scored - base).toBe(60);
  });

  it("бонус +30 за частичное совпадение серии (включение)", () => {
    const base = relevance("белый клык", [], "песнь льда", { title: "Белый Клык" } as any);
    const scored = relevance("белый клык", [], "песнь льда", { title: "Белый Клык", series: "Песнь льда и пламени" } as any);
    expect(scored - base).toBe(30);
  });

  it("точное совпадение названия доминирует над серией конкурента", () => {
    const series = "песнь льда и пламени";
    // A: exact title, wrong series
    const a = relevance("игра престолов", [], series, { title: "Игра престолов", series: "Другая" } as any);
    // B: inexact title, but the right series
    const b = relevance("игра престолов", [], series, { title: "Игра", series: "Песнь льда и пламени" } as any);
    expect(a).toBeGreaterThan(b);
  });

  it("серия не учитывается, если в запросе её не задали", () => {
    const withSeries = relevance("белый клык", [], undefined, { title: "Белый Клык", series: "Детство" } as any);
    const noSeries = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    expect(withSeries).toBe(noSeries);
  });
});

describe("relevance: нормализация ё/е", () => {
  // Flibusta stores names without the "yo" letter ("Fedor"), users type it ("Fyodor").
  // Without the yo→e fold the author match breaks, and the namesake filter in split cuts
  // the author's own books: the title token "fyodor" didn't match "fedor" in the book's author.
  it("«Фёдор» в запросе матчит «Федор» в авторе книги", () => {
    const score = relevance("", ["Достоевский Фёдор"], undefined, {
      title: "Бесы",
      author: "Достоевский Федор Михайлович",
    } as any);
    expect(score).toBeGreaterThanOrEqual(60);
  });
});

describe("relevance: автор, обратный порядок слов", () => {
  // Defect D: the LLM returns the author as "First Last" (Lev Tolstoy), Flibusta stores
  // "Last First Patronymic" (Tolstoy Lev Nikolaevich). No exact inclusion
  // (the substring doesn't match because of the order), leaving a token match — 2 tokens × 8 =
  // 16 < the lowRelevance threshold (50). An exact author search was labeled an
  // "approximate match". Full token coverage = the same names in a different order; that is
  // a reliable author match — treat it as exact (60).
  it("полное покрытие токенов автора = 60 даже при обратном порядке слов", () => {
    const score = relevance("", ["Лев Толстой"], undefined, {
      title: "Анна Каренина",
      author: "Толстой Лев Николаевич",
    } as any);
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("частичное покрытие (один из двух токенов) — слабый сигнал, ниже точного", () => {
    const full = relevance("", ["Лев Толстой"], undefined, {
      title: "X",
      author: "Толстой Лев Николаевич",
    } as any);
    const partial = relevance("", ["Лев Толстой"], undefined, {
      title: "X",
      author: "Толстой Алексей Николаевич",
    } as any);
    expect(full).toBeGreaterThan(partial);
  });
});

describe("порог lowRelevance", () => {
  it("слабое совпадение (не degraded) → lowRelevance: true, книги не пусты", async () => {
    const books = [{ title: "abc", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ title: "xyz" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("запрос", 5);
    expect(r.lowRelevance).toBe(true);
    expect(r.books.length).toBeGreaterThan(0);
  });

  it("сильное совпадение → lowRelevance falsy", async () => {
    const books = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const m = makeMocks(books);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("белый клык", 5);
    expect(r.lowRelevance).toBeFalsy();
  });

  it("degraded → порог не применяется (lowRelevance falsy)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = makeMocks(books);
    m.llm.parseQuery.mockRejectedValue(new Error("llm down"));
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("просто текст", 5);
    expect(r.degraded).toBe(true);
    expect(r.lowRelevance).toBeFalsy();
    expect(r.books.length).toBeGreaterThan(0);
  });

  it("lowRelevance-результат кэшируется (повтор не бьёт в flibusta)", async () => {
    const books = [{ title: "abc", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ title: "xyz" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("запрос", 5);
    await o.search("запрос", 5);
    expect(m.flibusta.searchBooks).toHaveBeenCalledTimes(1);
  });
});

describe("author-only поиск (без названия)", () => {
  // Reproduces defect B: for an author-only query parsed.title is absent, and pt
  // was set to the raw query. Then books where the author's name is part of
  // the title (biographies, literary criticism of other authors) got +600 for the
  // inclusion and outranked the author's own books.
  it("книга с именем автора в названии (чужая) не обгоняет книги самого автора", async () => {
    const books = [
      { title: "Беседы о русской культуре", author: "Лотман Юрий Михайлович", formats: ["fb2"] },
      { title: "Юрий Лотман жизнь", author: "Иванов Иван", formats: ["fb2"] },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Лотман"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Юрий Лотман", 5);
    expect(r.books[0].author).toBe("Лотман Юрий Михайлович");
  });

  // Reproduces defect C: an author-only match (+30) is below the
  // MIN_RELEVANCE threshold (50), so an exact author search was flagged lowRelevance
  // ("approximate match"). This is a valid search — there should be no flag.
  it("точный поиск по автору не помечается lowRelevance", async () => {
    const books = [
      { title: "Беседы о русской культуре", author: "Лотман Юрий Михайлович", formats: ["fb2"], downloadsCount: "1000" },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Лотман"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Лотман", 5);
    expect(r.lowRelevance).toBeFalsy();
  });

  // Reproduces "Alexander Pushkin": the split {authors:"alexandr",
  // title:"pushkin"} finds books ABOUT Pushkin by authors named "Alexander"
  // (Feduta, Gurevich) — the title "pushkin" is indeed in their titles. Without the
  // wrong-author penalty they earn +600 for title and outrank Pushkin's own books.
  it("split-книга о авторе (чужой автор, имя автора в названии) не обгоняет книги автора", async () => {
    const llmBooks = [
      { title: "Барышня-крестьянка", author: "Пушкин Александр Сергеевич", formats: ["fb2"], downloadsCount: "35000" },
    ];
    const splitBooks = [
      { book: { title: "Пушкинская эпоха", author: "Федута Александр Иосифович", formats: ["fb2"], downloadsCount: "500" }, pt: "пушкин", authors: ["александр"] },
    ];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Пушкин"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(llmBooks), splitSearchBooks: vi.fn().mockResolvedValue(splitBooks) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Александр Пушкин", 5);
    expect(r.books[0].author).toBe("Пушкин Александр Сергеевич");
  });
});

describe("relevance: fuzzy-матч названия с опечаткой (RC2)", () => {
  // gpt-4.1-nano doesn't fix "Tayas"→"Tais"; the strict word inclusion (+15) is not
  // earned, the book sinks. Word-level Levenshtein catches the typo and adds a bonus.
  it("«Таяс Афинская» fuzzy-матчит «Таис Афинская» (≥300)", () => {
    const s = relevance("таяс афинская", ["ефремов"], undefined, {
      title: "Таис Афинская", author: "Ефремов Иван",
    } as any);
    expect(s).toBeGreaterThanOrEqual(300);
  });

  it("«афинскаф» fuzzy-матчит «афинская» в составе названия (≥300)", () => {
    const s = relevance("афинскаф", ["ефремов"], undefined, {
      title: "Таис Афинская", author: "Ефремов Иван",
    } as any);
    expect(s).toBeGreaterThanOrEqual(300);
  });

  it("чужое название не получает fuzzy-бонус (0)", () => {
    const s = relevance("тараканы", [], undefined, { title: "Чапаев и Пустота" } as any);
    expect(s).toBe(0);
  });

  it("точное совпадение не уходит в fuzzy-ветку (1000)", () => {
    const s = relevance("белый клык", [], undefined, { title: "Белый Клык" } as any);
    expect(s).toBe(1000);
  });
});

describe("royallib как вторичный источник", () => {
  // royallib adds books missing from flibusta (by title|author) but doesn't
  // duplicate what's already found: flibusta takes priority. Both cases are tested.
  const mkRoyallib = (books: any[]) => ({
    searchBooks: vi.fn().mockResolvedValue(books),
  });

  it("добирает royallib-книгу, которой нет во flibusta", async () => {
    const flibustaBooks = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const royBooks = [{ title: "Чужой роман", author: "Неизвестный", formats: ["epub"] }];
    const m = makeMocks(flibustaBooks);
    const roy = mkRoyallib(royBooks);
    const o = createOrchestrator(m.llm as any, m.flibusta as any, {}, roy as any);
    const r = await o.search("белый клык джек лондон", 5);
    const titles = r.books.map((b) => b.title);
    expect(titles).toContain("Белый Клык");
    expect(titles).toContain("Чужой роман");
  });

  it("не дублирует книгу, найденную и во flibusta, и в royallib (flibusta приоритетна)", async () => {
    const flibustaBooks = [{ id: 1, title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }];
    const royBooks = [{ title: "Белый Клык", author: "Лондон Джек", formats: ["epub"], provider: "royallib" }];
    const m = makeMocks(flibustaBooks);
    const roy = mkRoyallib(royBooks);
    const o = createOrchestrator(m.llm as any, m.flibusta as any, {}, roy as any);
    const r = await o.search("белый клык джек лондон", 5);
    // One book left, the flibusta variant (without provider="royallib")
    expect(r.books).toHaveLength(1);
    expect(r.books[0].provider).toBeUndefined();
    expect(r.books[0].formats).toEqual(["fb2"]);
  });

  it("не дублирует при разном написании имени автора (дедуп по фамилии)", async () => {
    const flibustaBooks = [{ id: 1, title: "Фрегат Паллада", author: "Гончаров Иван Александрович", formats: ["fb2"] }];
    const royBooks = [{ title: "Фрегат Паллада", author: "Гончаров Иван", formats: ["epub"], provider: "royallib" }];
    const m = makeMocks(flibustaBooks);
    const roy = mkRoyallib(royBooks);
    const o = createOrchestrator(m.llm as any, m.flibusta as any, {}, roy as any);
    const r = await o.search("фрегат паллада гончаров", 5);
    // The surname "goncharov" matches — the duplicate collapsed, the flibusta variant stays.
    expect(r.books).toHaveLength(1);
    expect(r.books[0].provider).toBeUndefined();
  });

  it("без royallib (undefined) поиск работает как раньше", async () => {
    const m = makeMocks([{ title: "Белый Клык", author: "Лондон Джек", formats: ["fb2"] }]);
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("белый клык джек лондон", 5);
    expect(r.books).toHaveLength(1);
  });
});

describe("RC3: путаница author/title", () => {
  // The LLM put a title-only query's title into authors → a false
  // author search + penalty. If the single "author" equals the title — drop it.
  it("LLM занёс название в authors → author убран, книга top-1 без lowRelevance", async () => {
    const books = [{ title: "Таис Афинская", author: "Ефремов Иван", formats: ["fb2"], downloadsCount: "5000" }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Таис Афинская"], title: "Таис Афинская" }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Таис Афинская", 5);
    expect(r.books[0].title).toBe("Таис Афинская");
    expect(r.lowRelevance).toBeFalsy();
  });

  it("биография «Пушкин» (author-only, author!=title) не затрагивается", async () => {
    const books = [{ title: "Пушкинская эпоха", author: "Федута", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Пушкин"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    const r = await o.search("Пушкин", 5);
    expect(r.books[0].title).toBe("Пушкинская эпоха"); // author search preserved
  });
});

describe("автор-строка поиска: слова, потерянные LLM", () => {
  // Complaint case: "Vasilev Boris" → the LLM returned authors:["Vasilev"], losing
  // the first name. In the catalog, the bare surname matches a technical stub. Query words
  // not taken by title/series/genre/authors are returned to the author string.
  it("LLM отдала только фамилию: flibusta получает полную пару из запроса", async () => {
    const books = [{ title: "Не стреляйте белых лебедей", author: "Васильев Борис Львович", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Васильев"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Васильев Борис", 5);
    expect(m.flibusta.searchBooks.mock.calls[0][0]).toEqual({ authors: ["Васильев Борис"] });
  });

  it("свободных слов нет: автор не расширяется", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Лотман"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Лотман", 5);
    expect(m.flibusta.searchBooks.mock.calls[0][0]).toEqual({ authors: ["Лотман"] });
  });

  it("остальных слов больше двух: расширения нет (защита от мусора в автор-строке)", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Мартин"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Мартин игра престолов песнь льда", 5);
    expect(m.flibusta.searchBooks.mock.calls[0][0].authors).toEqual(["Мартин"]);
  });

  it("предлоги из остатка в автор-строку не попадают", async () => {
    const books = [{ title: "Пикник на обочине", author: "Стругацкие", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockResolvedValue({ authors: ["Стругацкие"] }), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Аркадий и Борис Стругацкие", 5);
    expect(m.flibusta.searchBooks.mock.calls[0][0].authors).toEqual(["Стругацкие Аркадий Борис"]);
  });

  it("деградация (LLM упала): расширения нет, title = сырой запрос", async () => {
    const books = [{ title: "X", formats: ["fb2"] }];
    const m = {
      llm: { parseQuery: vi.fn().mockRejectedValue(new Error("llm down")), rankBooks: vi.fn() },
      flibusta: { searchBooks: vi.fn().mockResolvedValue(books), splitSearchBooks: vi.fn().mockResolvedValue([]) },
    };
    const o = createOrchestrator(m.llm as any, m.flibusta as any);
    await o.search("Васильев Борис", 5);
    expect(m.flibusta.searchBooks.mock.calls[0][0]).toEqual({ title: "Васильев Борис" });
  });
});
