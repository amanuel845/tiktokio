// api/v1/tk/size.js
//
// Probe the byte size of one or more download URLs.
// Uses a Range request so the server reports the total size
// without downloading the file.

const TIMEOUT_MS = 8000;     // per URL
const MAX_URLS = 10;
const CONCURRENCY = 4;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const urls = Array.isArray(req.body && req.body.urls)
    ? req.body.urls.slice(0, MAX_URLS)
    : [];

  if (!urls.length) {
    return res.status(400).json({ error: "No URLs provided" });
  }

  const results = await mapWithConcurrency(urls, CONCURRENCY, probeSize);

  res.status(200).json({
    sizes: results.map((r, i) => ({ url: urls[i], ...r }))
  });
}

/**
 * Probe a single URL for its total byte size.
 *
 * Sends `Range: bytes=0-0` so the server responds with
 * `Content-Range: bytes 0-0/TOTAL` without sending the whole file.
 * Falls back to `Content-Length` if the server ignores the Range header.
 */
async function probeSize(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
      redirect: "follow",
    });

    // Cancel the body immediately — we only want the headers.
    if (response.body && typeof response.body.cancel === "function") {
      try { await response.body.cancel(); } catch {}
    }

    if (!response.ok && response.status !== 206) {
      return { ok: false, error: "HTTP " + response.status };
    }

    const contentRange = response.headers.get("content-range");
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)\s*$/);
      if (m) {
        const bytes = parseInt(m[1], 10);
        return { ok: true, bytes, formatted: humanSize(bytes) };
      }
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (Number.isFinite(bytes)) {
        return { ok: true, bytes, formatted: humanSize(bytes) };
      }
    }

    return { ok: false, error: "No size header" };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "Timeout" : "Fetch failed"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const decimals = (i === 0 || n >= 10) ? 0 : 1;
  return n.toFixed(decimals) + " " + units[i];
}

/**
 * Run `fn` over `items` with a max of `limit` in flight at once.
 * Preserves input order in the returned array.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
