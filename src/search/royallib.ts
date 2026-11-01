import type { ParsedQuery } from "./llm.js";
import type { FlibustaBook } from "./flibusta.js";

type Deps = { base: string };

// Timeout for a single royallib network call. The site has no API — search = POST /search/
// + up to MAX_CARDS card GETs in parallel. A single page is ~30-50 KB, normally
// ~1s; 6s is the cap, longer is a stall (like flibusta: we cut the caller's wait).
const CALL_TIMEOUT_MS = 6_000;

// How many book cards to fetch for formats/annotation extraction. Royallib is
// the secondary source (flibusta takes priority), so a modest pool is enough:
// more cards = more parallel GETs without a proportional gain.
const MAX_CARDS = 8;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// royallib returns protocol-relative links ("//royallib.com/...") — we normalize to https.
function abs(u: string): string {
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  return u;
}

// Minimal HTML entity decoding: titles/annotations may contain
// &nbsp;, &mdash; and the like. A full parser is unnecessary — we cover the common cases.
function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`royallib ${res.status} for ${url}`);
  return res.text();
}

type SearchHit = { href: string; title: string; author: string };

// We parse the «Книги» (Books) section of the search results page. Each book row:
//   <tr><td><a href="//royallib.com/book/<author>/<title>.html">Title</a></td>
//       <td>&nbsp;</td><td><a href="//royallib.com/author/<author>.html">
//       <font size="-2">Author</font></a></td></tr>
// The «Авторы» (Authors) and «Серии» (Series) sections are cut off: we only search after the ">Книги</h2>" header.
// The (book → author) pair is taken from one row: a lazy [\s\S]*? from the book link
// to the first author link (it is in the same row).
function parseSearchResults(html: string): SearchHit[] {
  const idx = html.indexOf(">Книги</h2>");
  if (idx < 0) return [];
  const section = html.slice(idx);
  const out: SearchHit[] = [];
  const rowRe =
    /<a href="([^"]*\/book\/[^"]+\.html)"[^>]*>([^<]+)<\/a>[\s\S]*?<a href="[^"]*\/author\/[^"]+\.html"[^>]*>(?:<font[^>]*>)?([^<]*?)(?:<\/font>)?<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section))) {
    const title = decodeHtml(m[2]).trim();
    const author = decodeHtml(m[3]).trim();
    if (title) out.push({ href: abs(m[1]), title, author: author || "" });
  }
  return out;
}

type Card = {
  coverUrl?: string;
  category?: string;
  description?: string;
  downloads: { link: string; format: string; size?: string }[];
  formats: string[];
};

// Book card /book/<author>/<title>.html: cover, genre, annotation, formats.
// Formats are the only part critical for downloading; cover/genre/annotation
// enrich the result. Download links: /get/<fmt>/<author>/<title>.zip.
function parseCard(html: string): Card {
  const cover = html.match(/src="([^"]*\/data\/images\/[^"]*)"/i);
  const coverUrl = cover ? abs(cover[1]) : undefined;

  const genre = html.match(/<b>Жанр:<\/b>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
  const category = genre ? decodeHtml(genre[1]).trim() : undefined;

  const ann = html.match(/<b>Аннотация:<\/b>([\s\S]*?)<\/td>/i);
  const description = ann ? stripTags(decodeHtml(ann[1])).slice(0, 2000) : undefined;

  const downloads: Card["downloads"] = [];
  const dlRe =
    /<a href="([^"]*\/get\/([a-z0-9]+)\/[^"]*\.zip)"[^>]*>Скачать[^<]*<\/a>(?:\s*\(Размер:\s*([^)]*)\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = dlRe.exec(html))) {
    downloads.push({
      link: abs(m[1]),
      format: m[2].toLowerCase(),
      size: m[3] ? m[3].trim() : undefined,
    });
  }
  const formats = Array.from(new Set(downloads.map((d) => d.format)));
  return { coverUrl, category, description, downloads, formats };
}

function toBook(h: SearchHit, card: Card | null): FlibustaBook {
  // Size is shown for fb2 (the primary format) or the first available —
  // in the list, "103 KB" is most useful for the first format.
  const size =
    card?.downloads.find((d) => d.format === "fb2")?.size ?? card?.downloads[0]?.size;
  return {
    title: h.title,
    author: h.author || undefined,
    category: card?.category,
    description: card?.description,
    coverUrl: card?.coverUrl,
    downloads: card?.downloads ?? [],
    formats: card?.formats ?? [],
    size,
    provider: "royallib",
  };
}

export function createRoyallib(deps: Deps) {
  return {
    // Search: one POST /search/ + parallel card parsing. No LLM and no
    // pagination — royallib is secondary, flibusta stays the primary source.
    async searchBooks(q: ParsedQuery): Promise<FlibustaBook[]> {
      // "Title + author", not title alone: royallib searches with OR, and title-only
      // finds a namesake title instead of the wanted book (live case: the query "fregat pallada" →
      // Dobrolyubov's review "Frigate 'Pallada'" instead of Goncharov's novel "Frigate Pallada").
      // The author disciplines the search — it also pulls in biographies/articles about the author (noise),
      // but that noise is cut in the orchestrator by the wrong-author penalty. Without a title
      // (author-only) — by author.
      const query = (q.title ? [q.title, ...(q.authors ?? [])] : q.authors ?? []).join(" ").trim();
      if (!query) return [];
      const html = await fetchText(`${deps.base}/search/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ to: "result", q: query }).toString(),
      });
      const hits = parseSearchResults(html).slice(0, MAX_CARDS);
      const books = await Promise.all(
        hits.map(async (h) => {
          try {
            const card = parseCard(await fetchText(h.href));
            return toBook(h, card);
          } catch {
            // A card fetch failed — the book is still useful (title + author), but without
            // formats it can't be downloaded. Kept without formats.
            return toBook(h, null);
          }
        }),
      );
      return books;
    },

    // The download link is already absolute (filled when parsing the card) — just
    // take the requested format from downloads.
    downloadUrl(book: FlibustaBook, format: string): string {
      const d = book.downloads.find((x) => x.format === format) ?? book.downloads[0];
      if (!d) throw new Error(`нет ссылки скачивания для ${book.title}`);
      return d.link;
    },
  };
}

export type Royallib = ReturnType<typeof createRoyallib>;
