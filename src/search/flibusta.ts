import * as FlibustaNS from "flibusta";
import type { ParsedQuery } from "./llm.js";

// The flibusta package is webpack-bundled as CommonJS/UMD. On ESM import its default
// gets wrapped in a namespace object, and the constructor sits at .default.default.
// Under a vitest mock (vi.mock → { default: mock }) — at .default. Handle both variants.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FlibustaAPI: any = (FlibustaNS as any).default?.default ?? (FlibustaNS as any).default;

export type FlibustaBook = {
  id?: number;
  title: string;
  author?: string;
  category?: string;
  description?: string;
  coverUrl?: string;
  downloads: { link: string; format: string }[];
  formats: string[];
  // Parsed from the description tail (the "label: value" block, see META_LABELS below).
  size?: string;
  downloadsCount?: string;
  series?: string;
  translator?: string;
  language?: string;
  // Book source ("flibusta" | "royallib"): bot.ts uses it to pick the client
  // for downloadUrl. flibusta always sets it; other providers set their own value.
  provider?: string;
};

type Deps = { base: string; fallbackBase?: string; httpAgent?: unknown };

const FORMAT_RE = /\/b\/\d+\/([a-z0-9]+)/i;
// /b/ID/... — numeric book id in flibusta. Used for dedup by id
// (not by title: different editions of one book, or same-name books by different
// authors, must not collapse) and for cross-check between the LLM and split pools.
const BOOK_ID_RE = /\/b\/(\d+)/i;

// Flibusta description-tail labels. Capitalized and fixed —
// so we match case-sensitively to avoid catching annotation words.
const META_LABELS = ["Перевод", "Формат", "Язык", "Размер", "Скачиваний", "Серия", "Год издания"];
type BookMeta = Pick<FlibustaBook, "size" | "downloadsCount" | "series" | "translator" | "language">;

// Description = annotation + a "Label: value Label: value …" block.
// We split at the first label: left — annotation to show, right — metadata.
function parseDescription(desc: string | undefined): { annotation?: string; meta: BookMeta } {
  if (!desc) return { meta: {} };
  const text = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const start = text.search(new RegExp(`(?:${META_LABELS.join("|")}):`));
  const metaText = start >= 0 ? text.slice(start) : "";
  const annotation = start >= 0 ? text.slice(0, start).trim() : text;
  const labelAlt = META_LABELS.join("|");
  const take = (label: string): string | undefined => {
    const m = metaText.match(new RegExp(`${label}:\\s*(.+?)(?=\\s+(?:${labelAlt}):|$)`));
    return m ? m[1].trim() : undefined;
  };
  return {
    annotation: annotation || undefined,
    meta: {
      size: take("Размер"),
      downloadsCount: take("Скачиваний"),
      series: take("Серия"),
      translator: take("Перевод"),
      language: take("Язык"),
    },
  };
}

// Some books have a /b/ID/download link with no format in the path — the format
// is then only visible in the MIME type (diafilm: /b/361093/download with application/pdf+zip).
// Such links used to be blindly tagged fb2, and a pdf ended up behind the fb2 button.
const MIME_TO_FORMAT: [RegExp, string][] = [
  [/fb2/, "fb2"],
  [/epub/, "epub"],
  [/mobipocket/, "mobi"],
  [/pdf/, "pdf"],
  [/djvu/, "djvu"],
  [/txt/, "txt"],
  [/rtf/, "rtf"],
  [/html/, "html"],
  [/msword/, "doc"],
];

function formatFromMime(mime: unknown): string {
  if (typeof mime !== "string") return "fb2"; // /b/ID/download with no MIME — historically fb2 in zip
  const hit = MIME_TO_FORMAT.find(([re]) => re.test(mime));
  return hit ? hit[1] : "fb2";
}

function normalize(raw: any, base: string): FlibustaBook {
  const downloads: { link: string; format: string }[] = (raw.downloads ?? [])
    .filter((d: any) => d?.link)
    .map((d: any) => {
      const m = String(d.link).match(FORMAT_RE);
      const fromPath = m ? m[1] : "";
      const fmt = !fromPath || fromPath === "download" ? formatFromMime(d.type) : fromPath;
      return { link: String(d.link), format: fmt };
    });
  const formats = Array.from(new Set(downloads.map((d) => d.format)))
    .filter((f) => f && f !== "unknown");
  const { annotation, meta } = parseDescription(raw.description);
  // book id — from the first download link of the form /b/<id>/...
  const idLink = downloads[0]?.link;
  const idMatch = idLink ? String(idLink).match(BOOK_ID_RE) : null;
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    title: raw.title ?? "Без названия",
    author: raw.author?.[0]?.name,
    category: raw.categories?.[0],
    description: annotation,
    coverUrl: raw.cover ? base + raw.cover : undefined,
    downloads,
    formats,
    provider: "flibusta",
    ...meta,
  };
}

// Local name normalization for comparison: lowercase, strip punctuation,
// collapse spaces. Same as norm in orchestrator.ts, but there is no norm here,
// and pulling shared utils for one function would be overkill.
function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'!.,?;:()\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

// Prepositions and conjunctions often missing from catalog book titles: the query
// "Ne strelyayte v belykh lebedey" is stored there without the "v", and strict
// opensearch on the full string returns zero. The particle "ne" is NOT dropped:
// it is part of the titles themselves ("Ne strelyayte", "Ne naveki").
export const TITLE_STOP_WORDS = new Set([
  "в", "во", "на", "по", "о", "об", "от", "до", "для", "у", "за", "с", "со",
  "к", "ко", "при", "и", "а", "но", "да", "или", "же", "бы", "под", "над",
  "без", "через", "про", "из", "между", "перед", "после",
]);

// Title without prepositions/conjunctions — for a second pass when the strict
// full-string search returned nothing. Normalized the same way as normName.
export function stripTitleStopWords(title: string): string {
  return normName(title).split(" ").filter((w) => w && !TITLE_STOP_WORDS.has(w)).join(" ");
}

// Timeout for a single Flibusta call. The package drives axios without
// per-request timeouts: under rate-limit a single request hangs at the TCP level
// for minutes, and the user sees an eternal "Searching…". Promise.race cuts the
// caller's wait (the axios request itself dies in the background and gets GC'd).
// 5s is the cap per page/search: a normal page is ~1s, slower than 4s is already an outlier.
// 5s (not 6s) leaves room for a retry within the orchestrator deadline (16s).
const CALL_TIMEOUT_MS = 5_000;
function withTimeout<T>(p: Promise<T>, ms: number = CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`flibusta call timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, bomb]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Retry on failure (timeout/network error). flibusta.is is unstable: ~3 of 5
// single requests hang until timeout, but the next attempt often completes
// in a fraction of a second. One retry gives a solid coverage boost at +5s worst-case.
// onRetry fires before the retry — a progress signal for the chat status
// (the user sees "trying again" instead of an eternal "Searching…").
async function withRetry<T = any>(fn: () => Promise<T>, onRetry?: () => void, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) onRetry?.();
    }
  }
  throw lastErr;
}

// Choosing an author from Flibusta's match list. getAuthors returns several
// (namesakes, different translations of a name). Algorithm: exact match → inclusion
// → token overlap. On a TIE (namesakes with the same
// surname length: "dostoevsky" → Andrey/Dmitry/Mikhail/Fyodor) the most
// prolific author wins (the books field from getAuthors). We used to take the
// first hit — that caught a random namesake instead of the known author.
export function chooseAuthorId(
  requested: string,
  authors: { id: number; name: string; books?: number }[],
): number | undefined {
  if (!authors.length) return undefined;
  const req = normName(requested);
  // No query or nothing matched — the most prolific one, not "first in the list".
  const byPopularity = () =>
    [...authors].sort((a, b) => (b.books ?? 0) - (a.books ?? 0))[0].id;
  if (!req) return byPopularity();

  const exact = authors.find((a) => normName(a.name) === req);
  // A bare surname as an exact match is usually a catalog technical stub
  // (a "Vasilev" entry with books=1) that pushes full names of real authors out
  // of the getAuthors results. If any candidate has a fuller name containing
  // the word — don't let the stub win: fall through below, where equal match
  // lengths are decided by prolificness (books).
  const hasFullerName =
    !req.includes(" ") &&
    authors.some((a) => {
      const n = normName(a.name);
      return n !== req && n.split(" ").includes(req);
    });
  if (exact && !hasFullerName) return exact.id;

  let bestInc: { id: number; len: number; books: number } | null = null;
  for (const a of authors) {
    const n = normName(a.name);
    if (n && (n.includes(req) || req.includes(n))) {
      const len = Math.min(n.length, req.length);
      const bk = a.books ?? 0;
      if (!bestInc || len > bestInc.len || (len === bestInc.len && bk > bestInc.books)) {
        bestInc = { id: a.id, len, books: bk };
      }
    }
  }
  if (bestInc) return bestInc.id;

  const reqTokens = req.split(" ").filter(Boolean);
  let bestTok: { id: number; score: number; books: number } | null = null;
  for (const a of authors) {
    const n = normName(a.name);
    if (!n) continue;
    const nameTokens = n.split(" ").filter(Boolean);
    const hit = reqTokens.filter((t) => nameTokens.includes(t)).length;
    const bk = a.books ?? 0;
    if (hit > 0 && (!bestTok || hit > bestTok.score || (hit === bestTok.score && bk > bestTok.books))) {
      bestTok = { id: a.id, score: hit, books: bk };
    }
  }
  if (bestTok) return bestTok.id;

  return byPopularity();
}

// Full author bibliography, page by page. getBooksByAuthorOpds returns only
// OPDS page 1 (20 books); for prolific authors (Efremov 189, the Strugatskys)
// the main novels sit on pages 2-10 and were unreachable — an author search
// silently lost most books. We walk pages while a next-link exists.
//
// The budget caps load and latency: a page limit and a time limit
// per author. 12 pages × 20 = up to 240 entries — covers Efremov (10
// pages). Timeout 6s: an OPDS page is ~1s, 6s ≈ 6 pages — enough to reach page 6,
// where prolific authors keep their main novels (Efremov's "Tais Afinskaya" is on
// page 6). Less — we lose books; more — the user waits.
// Repeat requests are served from the orchestrator cache (6h).
// Search progress for streaming into the chat. author-found — an author was picked
// from the namesakes, we know the size of his bibliography; paging — walking pages with the
// accumulated book count and a "found" signal when the target shows up on a page.
export type FlibustaProgress =
  | { kind: "author-found"; author: string; books: number }
  | { kind: "paging"; page: number; totalPages: number; booksSoFar: number; found?: string }
  | { kind: "title-search" }
  | { kind: "retry"; what: "title" | "author" };

async function searchBooksByAuthor(
  client: any,
  id: number,
  base: string,
  budget: { maxPages: number; maxTimeMs: number },
  opts?: { booksCount?: number; targetTitle?: string; onProgress?: (p: FlibustaProgress) => void },
): Promise<FlibustaBook[]> {
  const out: FlibustaBook[] = [];
  const start = Date.now();
  let page = 0;
  // Target for the "found" signal: the normalized title from the query. On each
  // page we check whether a book with this title has appeared — a hit is
  // reported once, so the user sees the wanted book is in the bag.
  const target = opts?.targetTitle ? normName(opts.targetTitle) : "";
  let foundReported = false;
  let booksSoFar = 0;
  let pageSize = 20; // default; refined from the first page
  let totalPages = opts?.booksCount ? Math.ceil(opts.booksCount / pageSize) : 0;
  while (page < budget.maxPages) {
    if (Date.now() - start > budget.maxTimeMs) break;
    let res: { items?: any[]; hasNextPage?: boolean };
    try {
      res = await client.getBooksByAuthorOpdsPaginated(id, page, 50);
    } catch {
      break; // page failed — keep what we have, don't fail the whole search
    }
    if (!res) break;
    const items = Array.isArray(res.items) ? res.items : [];
    if (page === 0 && items.length) {
      pageSize = items.length;
      if (opts?.booksCount) totalPages = Math.ceil(opts.booksCount / pageSize);
    }
    booksSoFar += items.length;
    let found: string | undefined;
    if (target && !foundReported) {
      const hit = items.find((r: any) => normName(r.title ?? "").includes(target));
      if (hit) { found = hit.title; foundReported = true; }
    }
    opts?.onProgress?.({ kind: "paging", page: page + 1, totalPages, booksSoFar, found });
    for (const r of items) out.push(normalize(r, base));
    if (!res.hasNextPage) break;
    page++;
  }
  // RC1 diagnostics: if we got past page 1 — pagination worked.
  // Logged for visibility in docker logs (prolific author: these books used to
  // be silently lost on the first page). The orchestrator cache (6h) dampens repeats.
  if (page > 0) console.warn(`pagination author id=${id}: ${out.length} books across ${page + 1} pages`);
  return out;
}

export function createFlibusta(deps: Deps) {
  // Client with a timeout on every network call. axios inside the package does not
  // break stalls itself, so we wrap 4 methods in withTimeout: the call gives up
  // after CALL_TIMEOUT_MS, gets caught in searchBooks/split and moves on.
  const makeClient = (base: string): any => {
    const c: any = new FlibustaAPI(base, deps.httpAgent ? { httpAgent: deps.httpAgent } : undefined);
    const timed = (name: string) => {
      const fn = c?.[name];
      if (typeof fn !== "function") return undefined;
      return (...args: unknown[]) => withTimeout(fn.apply(c, args));
    };
    return {
      getAuthors: timed("getAuthors"),
      getBooksByAuthorOpdsPaginated: timed("getBooksByAuthorOpdsPaginated"),
      getBooksByNameFromOpds: timed("getBooksByNameFromOpds"),
      getBooksByAuthorOpds: timed("getBooksByAuthorOpds"),
    };
  };

  return {
    async searchBooks(
      q: ParsedQuery,
      onProgress?: (p: FlibustaProgress) => void,
      opts?: { targetTitle?: string },
    ): Promise<FlibustaBook[]> {
      const client = makeClient(deps.base);
      const out: FlibustaBook[] = [];

      // By title — first: one fast call and the most precise result for
      // a "title + author" query. Retry dampens flibusta.is flakiness: a single
      // timeout must not produce an empty result if the next attempt would succeed.
      if (q.title) {
        // Stream a separate status: otherwise a title-only search stays silent from "Searching…"
        // to "Comparing…" while it waits for the single getBooksByNameFromOpds call.
        onProgress?.({ kind: "title-search" });
        try {
          const list = await withRetry(
            () => (client as any).getBooksByNameFromOpds(q.title),
            () => onProgress?.({ kind: "retry", what: "title" }),
          );
          if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, deps.base)));
        } catch { /* mirror failed — fallback below */ }
        // A stop word in the query that the catalog title lacks zeroes out
        // the strict opensearch ("Ne strelyayte v belykh lebedey" is stored
        // without the "v"). First pass empty — retry without prepositions/conjunctions.
        if (!out.length) {
          const stripped = stripTitleStopWords(q.title);
          if (stripped && stripped !== normName(q.title)) {
            try {
              const list = await withRetry(
                () => (client as any).getBooksByNameFromOpds(stripped),
                () => onProgress?.({ kind: "retry", what: "title" }),
              );
              if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, deps.base)));
            } catch { /* empty without stop words too — author/fallback below */ }
          }
        }
      }

      // By author: first find the id, then pull the full bibliography
      // (OPDS pagination, otherwise only page 1 is available for prolific authors)
      if (q.authors?.length) {
        for (const a of q.authors) {
          try {
            const authors = await withRetry(
              () => (client as any).getAuthors(a),
              () => onProgress?.({ kind: "retry", what: "author" }),
            );
            const list = authors ?? [];
            const id = chooseAuthorId(a, list);
            if (id) {
              const authorObj = list.find((x: any) => x.id === id);
              const booksCount = authorObj?.books;
              if (booksCount != null) {
                onProgress?.({ kind: "author-found", author: authorObj?.name ?? a, books: booksCount });
              }
              const found = await searchBooksByAuthor(client as any, id, deps.base, {
                maxPages: 12,
                maxTimeMs: 6000,
              }, { booksCount, targetTitle: opts?.targetTitle, onProgress });
              out.push(...found);
            }
          } catch { /* author not found — skip */ }
        }
      }

      // Dedup by book id: different editions (same /b/id) collapse, but
      // same-name books by different authors and separate volumes are kept. Fallback to
      // title+author when no id was extracted (entry without a download link).
      const seen = new Set<string>();
      const dedupKey = (b: FlibustaBook): string =>
        b.id != null ? `id:${b.id}` : `${normName(b.title)}|${normName(b.author ?? "")}`;
      const deduped = out.filter((b) => {
        const k = dedupKey(b);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (deduped.length) return deduped;

      // Fallback to the backup mirror when the primary returns nothing
      if (deps.fallbackBase) {
        return this.searchBooksOn(q, deps.fallbackBase);
      }
      return [];
    },

    async searchBooksOn(q: ParsedQuery, base: string): Promise<FlibustaBook[]> {
      const client = makeClient(base);
      const out: FlibustaBook[] = [];
      if (q.title) {
        const list = await (client as any).getBooksByNameFromOpds(q.title);
        if (Array.isArray(list)) out.push(...list.map((r) => normalize(r, base)));
      }
      return out;
    },

    // Deterministic parse by trying all splits (no LLM). The query is cut into
    // (author-prefix, title-rest) and vice versa; for each split —
    // an author search + a title search. For each book we keep its best
    // split (longest author = more specific). Returns a pool with
    // (pt, authors) for the max-relevance merge in orchestrator. Covers cases
    // where the LLM misses (author-only, messy real queries) and backs up
    // an LLM outage. lim=4 caps the enumeration → load on Flibusta.
    async splitSearchBooks(
      query: string,
    ): Promise<Array<{ book: FlibustaBook; pt: string; authors: string[] }>> {
      const tokens = normName(query).split(" ").filter(Boolean);
      if (tokens.length < 2) return []; // split makes sense from 2 tokens
      const lim = Math.min(tokens.length, 4);
      type Split = { authors: string; title: string };
      const seen = new Set<string>();
      const splits: Split[] = [];
      for (let k = 1; k < tokens.length; k++) {
        if (k > lim && tokens.length - k > lim) continue;
        const cands: Split[] = [
          { authors: tokens.slice(0, k).join(" "), title: tokens.slice(k).join(" ") },
          { authors: tokens.slice(k).join(" "), title: tokens.slice(0, k).join(" ") },
        ];
        for (const s of cands) {
          const kk = s.authors + "|" + s.title;
          if (!s.authors || !s.title || seen.has(kk)) continue;
          seen.add(kk);
          splits.push(s);
        }
      }
      const client = makeClient(deps.base);
      const results = await Promise.all(
        splits.map(async (sp) => {
          try {
            const books: FlibustaBook[] = [];
            const list = await (client as any).getAuthors(sp.authors);
            const id = chooseAuthorId(
              sp.authors,
              (list ?? []).map((x: any) => ({ id: x.id, name: x.name, books: x.books })),
            );
            if (id) {
              const bl = await (client as any).getBooksByAuthorOpds(id);
              if (Array.isArray(bl)) books.push(...bl.map((r: any) => normalize(r, deps.base)));
            }
            const tl = await (client as any).getBooksByNameFromOpds(sp.title);
            if (Array.isArray(tl)) books.push(...tl.map((r: any) => normalize(r, deps.base)));
            return { sp, books };
          } catch {
            return { sp, books: [] as FlibustaBook[] };
          }
        }),
      );
      // For each book — the best split (longer author = more specific).
      // Filter: a book is valid for a split only if the author part matches
      // the book's author (≥1 token). Otherwise the split is meaningless for it: e.g.
      // a "Conan Doyle / Chertanov" biography under the split "sherlock holmes"+"conan
      // doyle" — the title matches exactly, but the author is wrong, the book is irrelevant.
      const best = new Map<string, { book: FlibustaBook; pt: string; authors: string[]; authorLen: number }>();
      for (const { sp, books } of results) {
        const pt = normName(sp.title);
        const authorLen = normName(sp.authors).length;
        const authorTokens = normName(sp.authors).split(" ").filter(Boolean);
        const titleTokens = pt.split(" ").filter(Boolean);
        for (const book of books) {
          const ba = normName(book.author ?? "").split(" ").filter(Boolean);
          // The author part of the split must match the book's author.
          if (authorTokens.length && !authorTokens.some((t) => ba.includes(t))) continue;
          // The title part must be explained — appear in the title or in the author.
          // Otherwise the book matched only via the author part (a first/last-name namesake),
          // and the rest of the query has nothing to do with it: "yuri"→Nikitin under
          // the query "yuri lotman" — "lotman" is in neither Nikitin's titles nor his name.
          if (titleTokens.length) {
            const tn = normName(book.title);
            if (!titleTokens.every((t) => tn.includes(t) || ba.includes(t))) continue;
          }
          const k = normName(book.title) + "|" + normName(book.author ?? "");
          const ex = best.get(k);
          if (!ex || authorLen > ex.authorLen) best.set(k, { book, pt, authors: [sp.authors], authorLen });
        }
      }
      return [...best.values()].map(({ book, pt, authors }) => ({ book, pt, authors }));
    },

    downloadUrl(book: FlibustaBook, format: string): string {
      const d = book.downloads.find((x) => x.format === format);
      const link = d?.link ?? book.downloads[0]?.link;
      if (!link) throw new Error(`нет ссылки скачивания для ${book.title}`);
      return link.startsWith("http") ? link : deps.base + link;
    },
  };
}

export type Flibusta = ReturnType<typeof createFlibusta>;