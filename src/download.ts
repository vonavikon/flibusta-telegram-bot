import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

export type DownloadMeta = { size: number };
type OnFile = (filePath: string) => Promise<DownloadMeta>;

// flibusta wraps these formats in zip: /b/ID/fb2 returns application/zip with
// one .fb2 inside. Send that zip named "Book.fb2" and the reader
// expects XML — the file won't open, hence the impression that "only mobi
// works" (it goes as a raw file). We unpack the inner file before sending.
// pdf and djvu were added because of /b/ID/download links (type pdf+zip) — the pdf
// sits inside a zip wrapper; unwrapping is safe: unwrapZip only unpacks
// files with PK magic; raw pdf (%PDF-) and mobi pass through as is.
// epub is NOT touched: epub is itself a zip, it must not be opened.
const WRAP_FORMATS = new Set(["fb2", "txt", "rtf", "html", "doc", "pdf", "djvu"]);

function unwrapZip(buf: Buffer): Buffer {
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return buf; // PK — not a zip
  try {
    const datas = new AdmZip(buf)
      .getEntries()
      .filter((e) => !e.entryName.endsWith("/"))
      .map((e) => e.getData());
    if (!datas.length) return buf;
    // flibusta: one inner file. If several — the largest, that's the book itself.
    datas.sort((a, b) => b.length - a.length);
    return datas[0];
  } catch {
    return buf; // broken zip — better to send as is than to fail the download
  }
}

export function createDownloader(tmpDir: string) {
  return {
    async fetchThen(
      url: string,
      filename: string,
      onFile: OnFile,
      fmt?: string,
      onProgress?: (p: { downloaded: number; total: number | null }) => void,
    ): Promise<DownloadMeta> {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`скачивание не удалось: ${res.status} для ${url}`);
      }
      // Streaming read instead of arrayBuffer(): count downloaded bytes for
      // progress. Content-Length can be null for chunked/zip responses — then
      // total stays null and no percentages are computed.
      const totalRaw = res.headers.get("content-length");
      const total = totalRaw ? Number(totalRaw) : null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let downloaded = 0;
      let lastReport = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          downloaded += value.byteLength;
          // Throttle to ~1/s: faster is pointless, Telegram editMessage is
          // rate-limited anyway, and extra edits burn the limit.
          const now = Date.now();
          if (onProgress && now - lastReport >= 1000) {
            onProgress({ downloaded, total });
            lastReport = now;
          }
        }
      }
      // Final report — always, so the consumer sees the final value
      // (on the fast path this is the only onProgress call).
      if (onProgress) onProgress({ downloaded, total });
      let buf: Buffer = Buffer.concat(chunks);
      if (fmt && WRAP_FORMATS.has(fmt)) buf = unwrapZip(buf);
      const safeName = filename.replace(/[^\w.-]+/g, "_");
      const file = path.join(tmpDir, `${crypto.randomUUID()}-${safeName}`);
      await fs.writeFile(file, buf);
      try {
        return await onFile(file);
      } finally {
        await fs.unlink(file).catch(() => {});
      }
    },
  };
}
