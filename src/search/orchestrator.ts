import type { Llm } from "./llm.js";
import type { Flibusta, FlibustaBook } from "./flibusta.js";
import type { Royallib } from "./royallib.js";
import { TITLE_STOP_WORDS } from "./flibusta.js";

export type SearchResult = { books: FlibustaBook[]; degraded: boolean; lowRelevance?: boolean };

// Search progress for streaming into the chat. paging/author-found come from deep inside
// flibusta pagination (via the adapter); parsing/searching/ranking come from the
// orchestrator itself. bot.ts turns these into throttled status texts.
export type SearchProgress =
  | { kind: "parsing" }
  | { kind: "searching" }
  | { kind: "splitting" }
  | { kind: "title-search" }
  | { kind: "author-found"; author: string; books: number }
  | { kind: "paging"; page: number; totalPages: number; booksSoFar: number; found?: string }
  | { kind: "retry"; what: "title" | "author" }
  | { kind: "ranking"; count: number };

const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();

// Soft relevance threshold. If the best match is weaker (neither title nor
// author hit) — the result is flagged lowRelevance and the bot shows an "approximate match" note.
// The 50 boundary: an author match (+60) and title words (+15×N) step over it,
// so an author-only search stays a normal result, not an "approximate one".
const MIN_RELEVANCE = 50;

// Levenshtein (DP, two rows) + normalized similarity 1 - dist/maxLen.
// Needed for fuzzy title matching with a typo: gpt-4.1-nano does not fix "Tayas"→
// "Tais", and trigrams on 4-letter words give 0 ({tay,aas} and {tai,ais}
// don't intersect). Levenshtein catches a single substitution: 0.75 for 4-letter words.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 1;
}

// Overall deadline for the search pool. A slow/throttled Flibusta otherwise
// holds the union search for tens of seconds: per-call timeouts (5s) fire
// one after another, and split walks several calls sequentially in each
// candidate split. The cap drops a hung pool (catch → []) and doesn't block
// the other pool's result. 16s: a normal pool takes 1-7s + headroom for one flibusta flake retry
// (5s×2 on title); the tail is cut before an "eternal Searching…".
const SEARCH_DEADLINE_MS = 16_000;
function deadline<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("search deadline exceeded")), SEARCH_DEADLINE_MS);
  });
  return Promise.race([p, bomb]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Deterministic relevance. We score not against the raw query but against what
// the LLM already separated: the title and the authors. Otherwise author
// inflections ("dzhekom", "londonom") pulled in unrelated books level with an exact
// title match. An exact title match decides outright.
export function relevance(pt: string, authors: string[], series: string | undefined, book: FlibustaBook): number {
  const title = norm(book.title);
  const author = norm(book.author ?? "");
  let titleScore = 0;
  if (pt) {
    if (title === pt) titleScore += 1000;
    else if (title.includes(pt)) titleScore += 600;
    else if (pt.includes(title)) titleScore += 400;
    else titleScore += pt.split(" ").filter(Boolean).filter((t) => title.includes(t)).length * 15;
  }
  // Fuzzy title match with a typo (RC2): the LLM doesn't fix "Tayas"→"Tais", and the strict
  // word inclusion (+15) is not earned. We compare word by word with Levenshtein: a query
  // word absent from the title exactly but close to a title word (sim>0.7)
  // — count it as a typo and add a bonus. Weaker than exact inclusion (600), but lifts the
  // book above the author-only tail. Only when there is no strong match (<100):
  // otherwise exact/inclusion already decided it.
  if (pt && titleScore < 100) {
    const ptWords = pt.split(" ").filter(Boolean);
    const titleWords = title.split(" ").filter(Boolean);
    if (titleWords.length) {
      let fuzzyHits = 0;
      for (const w of ptWords) {
        if (titleWords.includes(w)) continue; // exact word already counted in titleScore
        let best = 0;
        for (const tw of titleWords) best = Math.max(best, similarity(w, tw));
        if (best > 0.7) fuzzyHits++;
      }
      if (fuzzyHits > 0) titleScore += 300 * Math.min(fuzzyHits, 2);
    }
  }
  // Author match — the main signal of author-only search: not weaker than a series
  // (+60) and above the lowRelevance threshold (50); otherwise an exact author search
  // would be flagged as an "approximate match".
  let authorScore = 0;
  let authorMatched = false;
  for (const a of authors) {
    const an = norm(a);
    if (!an) continue;
    if (author.includes(an)) { authorScore += 60; authorMatched = true; }
    else {
      const at = an.split(" ").filter(Boolean);
      const hit = at.filter((t) => author.includes(t));
      if (hit.length) {
        // Full token coverage — the same names in a different order/with a patronymic
        // (LLM "Lev Tolstoy" vs Flibusta "Tolstoy Lev Nikolaevich"). This is a reliable
        // author match, equal to an exact one. Partial coverage is a weak signal.
        authorScore += hit.length === at.length ? 60 : hit.length * 8;
        authorMatched = true;
      }
    }
  }
  // Wrong-author penalty: the query names an author, but the book is not theirs. Typical
  // case — books ABOUT the author (biographies, literary criticism: "Pushkinskaya epokha"
  // by Feduta under the query "Alexander Pushkin") that earn a title bonus for the
  // author's name in the title. We suppress the title signal — the book drops below any
  // book by the author themself. title-only queries (authors empty) get no penalty.
  if (authors.length && !authorMatched && titleScore > 15) titleScore = 15;
  let seriesScore = 0;
  // Series: a specific signal, weaker than a title match, stronger than author
  // tokens. Fires only when the LLM pulled a series from the query — otherwise the
  // branch is skipped with zero effect on rank (old tests, no series set).
  if (series) {
    const sn = norm(series);
    const bn = norm(book.series ?? "");
    if (sn && bn) {
      if (bn === sn) seriesScore += 60;
      else if (bn.includes(sn) || sn.includes(bn)) seriesScore += 30;
    }
  }
  return titleScore + authorScore + seriesScore;
}

export function createOrchestrator(
  llm: Llm,
  flibusta: Flibusta,
  opts: { cacheTtlSec?: number; cacheEmptyTtlSec?: number; cacheMax?: number } = {},
  royallib?: Royallib,
) {
  // In-memory search result cache. Identical queries from different users
  // ("pelevin", "harry potter") would otherwise hit flibusta and the LLM dozens of times.
  // The TTL cache serves a repeat without a single network call. Ranking is
  // deterministic and books don't change every minute — caching is safe.
  // Reset on restart; persistence is overkill for a search cache.
  const ttlMs = (opts.cacheTtlSec ?? 21600) * 1000;
  // Empty results ("nothing found") are cached briefly: a source outage
  // must not become a 6-hour refusal. 10 minutes dampens repeated junk
  // (typos, nonexistent books), while temporary Flibusta unavailability
  // is waited out in minutes, not hours.
  const emptyTtlMs = (opts.cacheEmptyTtlSec ?? 600) * 1000;
  const max = opts.cacheMax ?? 2000;
  type Entry = { result: SearchResult; expiresAt: number };
  const cache = new Map<string, Entry>();

  const cacheGet = (key: string): SearchResult | undefined => {
    const e = cache.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { cache.delete(key); return undefined; }
    return e.result;
  };
  const cachePut = (key: string, result: SearchResult, ttlOverride?: number): void => {
    if (cache.size >= max) {
      const now = Date.now();
      for (const [k, v] of cache) if (now > v.expiresAt) cache.delete(k);
      // No expired entries — drop the oldest by insertion order
      if (cache.size >= max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    cache.set(key, { result, expiresAt: Date.now() + (ttlOverride ?? ttlMs) });
  };

  return {
    async search(
      rawQuery: string,
      topN: number,
      onProgress?: (p: SearchProgress) => void,
    ): Promise<SearchResult> {
      const key = norm(rawQuery);
      const hit = cacheGet(key);
      if (hit) return hit; // cache hit — onProgress not called, fast path without status

      let parsed;
      let degraded = false;
      try {
        onProgress?.({ kind: "parsing" });
        parsed = await llm.parseQuery(rawQuery);
      } catch (e) {
        // Degradation: the whole query as title, no parsing. LLM timeouts
        // land here too — logged to see how often we go degraded.
        console.warn("llm parse failed, degraded:", (e as Error).message);
        parsed = { title: rawQuery };
        degraded = true;
      }

      // pt is computed before the search: it is the targetTitle for the "found" signal in
      // pagination (the user sees the wanted book appear on a page) and
      // it feeds ranking. If the LLM gave no title (author-only search), pt is empty:
      // substituting the raw query is not allowed — it contains the author's name, and other
      // people's books with that name in the title (biographies, criticism) would get +600 and
      // outrank the author's own books.
      const pt = norm(parsed.title ?? "");
      // RC3: the LLM put the title into authors (entity confusion on a title-only
      // query: "Tais Afinskaya" → authors:["Tais Afinskaya"]). The author
      // search then runs in vain + the wrong-author penalty fires and sinks
      // the wanted book from #1 to #3. If the single "author" equals the title —
      // drop it: it's a title, not an author. The "Pushkin" biography (author!=title) and
      // multiple authors are not affected.
      let authors = parsed.authors ?? [];
      if (authors.length === 1 && pt && norm(authors[0]) === pt) authors = [];

      // Query words left unexplained by the parse. The LLM often loses the author's first
      // name ("Vasilev Boris" → authors:["Vasilev"]), and for the bare surname the catalog
      // returns a duplicate stub instead of the real author. If there is one author and the
      // rest of the query is 1-2 words, we put them back into the SEARCH author string
      // (flibusta and royallib); ranking stays on the original authors — the surname
      // from the query is enough to match the full name in the bibliography. Prepositions are
      // dropped from the rest ("Arkady i Boris Strugatsky" → "Strugatsky Arkady
      // Boris"). More than two words is not taken: that's not a name, that's query noise.
      const used = new Set(
        [parsed.title, parsed.series, parsed.genre, ...authors]
          .flatMap((s) => (s ? norm(s).split(" ") : []))
          .filter(Boolean),
      );
      const restWords = rawQuery
        .split(/[\s«»"'!.,?;:()\[\]]+/)
        .filter((w) => {
          const n = norm(w);
          return n && !used.has(n) && !TITLE_STOP_WORDS.has(n);
        });
      const searchParsed =
        authors.length === 1 && restWords.length >= 1 && restWords.length <= 2
          ? { ...parsed, authors: [`${authors[0]} ${restWords.join(" ")}`] }
          : parsed;

      onProgress?.({ kind: "searching" });
      // split starts from 2 tokens and runs in parallel as a safety net; we stream
      // a separate status so the title-only path doesn't stay silent from "Searching…" to "Comparing…".
      if (key.split(" ").filter(Boolean).length >= 2) onProgress?.({ kind: "splitting" });
      // UNION: LLM parse and deterministic split-search — in parallel.
      // split covers cases where the LLM misses (author-only, messy
      // real queries) and backs up an LLM outage. Each pool is
      // scored by its own parse; a book enters the shared pool with the max of its scores
      // — the "best scenario" of finding it. ~80% rel@3 vs 69% for LLM-solo.
      // The adapter forwards flibusta pagination progress into the shared callback.
      // royallib — a secondary source in parallel with flibusta. Books missing
      // from flibusta (by title|author) are picked up below. If it fails/hangs — just [].
      const [llmRaw, splitRaw, royRaw] = await Promise.all([
        deadline(flibusta
          .searchBooks(searchParsed, (fp) => onProgress?.(fp), { targetTitle: pt }))
          .catch(() => [] as FlibustaBook[]),
        deadline(flibusta
          .splitSearchBooks(rawQuery))
          .catch(() => [] as Array<{ book: FlibustaBook; pt: string; authors: string[] }>),
        royallib
          ? deadline(royallib.searchBooks(searchParsed)).catch(() => [] as FlibustaBook[])
          : Promise.resolve([] as FlibustaBook[]),
      ]);

      // On equal relevance — the more popular edition (more downloads) goes higher.
      const dl = (b: FlibustaBook): number =>
        parseInt(String(b.downloadsCount ?? "").replace(/\D/g, "")) || 0;
      const pool = new Map<string, { b: FlibustaBook; s: number }>();
      const merge = (b: FlibustaBook, s: number): void => {
        // Dedup by book id: the same edition from the LLM and split pools is taken with the
        // max of its scores. Fallback to title|author when no id was extracted.
        const k = b.id != null ? `id:${b.id}` : norm(b.title) + "|" + norm(b.author ?? "");
        const ex = pool.get(k);
        if (!ex || s > ex.s) pool.set(k, { b, s });
      };
      // Keys of flibusta books (title|author surname) — for royallib dedup: the same
      // book must not be shown twice (from flibusta and from royallib). flibusta
      // takes priority (more precise id dedup and fuller metadata). Surname, not full
      // name: flibusta writes "Goncharov Ivan Aleksandrovich", royallib — "Goncharov Ivan",
      // so exact full-name comparison would miss the duplicate, while the surname (first token) matches.
      const flKeyOf = (b: FlibustaBook): string => {
        const fam = norm(b.author ?? "").split(" ").find(Boolean) ?? "";
        return norm(b.title) + "|" + fam;
      };
      const flKey = new Set<string>();
      for (const b of llmRaw) {
        flKey.add(flKeyOf(b));
        merge(b, relevance(pt, authors, parsed.series, b));
      }
      // split books are ranked by the LLM authors when the LLM gave them: that's the single
      // truth about the query's author. Otherwise a split ("alexandr") matches wrong
      // authors by first name and lets through books about Pushkin by authors named Aleksandr.
      // Without LLM authors (title-only, degraded) — by the split, as before.
      for (const r of splitRaw) {
        flKey.add(flKeyOf(r.book));
        const ra = authors.length ? authors : r.authors;
        merge(r.book, relevance(r.pt, ra, undefined, r.book));
      }
      // royallib adds what flibusta lacks: same title|author — skip.
      for (const b of royRaw) {
        if (flKey.has(flKeyOf(b))) continue;
        merge(b, relevance(pt, authors, parsed.series, b));
      }

      if (!pool.size) {
        // Empty results are cached briefly (emptyTtlMs): "nothing found" can be
        // legitimate (typo, nonexistent book) or a source outage — we don't
        // distinguish them. The short TTL dampens repeated junk but doesn't turn
        // temporary Flibusta unavailability into a 6-hour refusal.
        cachePut(key, { books: [], degraded }, emptyTtlMs);
        return { books: [], degraded };
      }

      onProgress?.({ kind: "ranking", count: pool.size });
      const scored = [...pool.values()].sort((a, z) => z.s - a.s || dl(z.b) - dl(a.b));
      const books = scored.slice(0, topN).map((x) => x.b);
      // Soft threshold: the best match is weak — flag the result, but don't cut books.
      // Not applied in degraded mode: there title = raw query, score is always low.
      const bestScore = scored[0]?.s ?? 0;
      const lowRelevance = !degraded && bestScore < MIN_RELEVANCE;
      const result: SearchResult = lowRelevance
        ? { books, degraded, lowRelevance: true }
        : { books, degraded };
      // Diagnostics: weak results (neither title nor author hit) show up in
      // docker logs to track the "barely found anything" class after the fix.
      if (lowRelevance) {
        console.warn(`lowRelevance query="${key}" bestScore=${bestScore} candidates=${scored.length}`);
      }
      // Degraded results are NOT cached: the LLM may be down temporarily;
      // a retry a minute later should parse properly.
      if (!degraded) cachePut(key, result);
      return result;
    },
  };
}
