// api/v1/tk/probe.js

import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const ALLOWED_HOSTS = [
  /\.tiktokcdn\.com$/i,
  /\.tiktokcdn-us\.com$/i,
  /\.tiktokcdn-eu\.com$/i,
  /\.tiktokv\.com$/i,
  /\.tiktokv\.us$/i,
];

const PROBE_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 55000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

/**
 * Headers TikTok's CDN expects for a signed URL.
 * `Referer` alone fixes most 403s; the rest cover hotlink / bot checks.
 */
function cdnHeaders(extra) {
  return Object.assign(
    {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.tiktok.com/",
      "Origin": "https://www.tiktok.com",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",   // no compression → Content-Length is exact
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    },
    extra || {}
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Disposition"
  );

  if (req.method === "OPTIONS") return res.status(204).end();

  const target =
    (req.query && req.query.url) ||
    (req.body && req.body.url);

  if (!target) return res.status(400).json({ error: "Missing url" });

  let parsed;
  try { parsed = new URL(target); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  if (!ALLOWED_HOSTS.some(re => re.test(parsed.hostname))) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  const wantsDownload =
    req.query.download === "1" ||
    req.query.download === "true" ||
    (req.body && req.body.download === true);

  if (wantsDownload) return handleDownload(req, res, parsed);
  return handleProbe(res, parsed);
}

/* ---------------- probe ---------------- */

async function handleProbe(res, parsed) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const upstream = await fetch(parsed.href, {
      method: "GET",
      headers: cdnHeaders({ Range: "bytes=0-0" }),
      signal: controller.signal,
      redirect: "follow",
    });

    if (upstream.body) {
      try { await upstream.body.cancel(); } catch {}
    }

    const contentType   = upstream.headers.get("content-type") || "";
    const contentRange  = upstream.headers.get("content-range");
    const contentLength = upstream.headers.get("content-length");

    let bytes = null;
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)\s*$/);
      if (m) bytes = parseInt(m[1], 10);
    }
    if (bytes == null && contentLength) {
      bytes = parseInt(contentLength, 10);
    }

    // If upstream failed, surface its body so you can see WHY
    let error = null;
    if (!upstream.ok) {
      try {
        const text = await upstream.text();
        error = text.slice(0, 500);
      } catch {}
    }

    res.status(200).json({
      url:    parsed.href,
      ok:     upstream.ok,
      status: upstream.status,
      type:   contentType.split(";")[0].trim(),
      bytes,
      size:   bytes != null ? humanSize(bytes) : null,
      error,
    });
  } catch (err) {
    res.status(502).json({
      url:   parsed.href,
      ok:    false,
      error: err.name === "AbortError" ? "Timeout" : "Fetch failed",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- download ---------------- */

async function handleDownload(req, res, parsed) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const extra = {};
    if (req.headers.range) extra.Range = req.headers.range;

    const upstream = await fetch(parsed.href, {
      method: "GET",
      headers: cdnHeaders(extra),
      signal: controller.signal,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({
        error: "Upstream " + upstream.status,
        detail: text.slice(0, 500),
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const filename    = buildFilename(req, contentType);

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", 'attachment; filename="' + filename + '"');

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    const ar = upstream.headers.get("accept-ranges");
    if (ar) res.setHeader("Accept-Ranges", ar);

    Readable.fromWeb(upstream.body).pipe(res);
    await finished(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({
        error: err.name === "AbortError" ? "Timeout" : "Download failed",
      });
    } else {
      try { res.end(); } catch {}
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------------- helpers ---------------- */

function buildFilename(req, contentType) {
  const requested =
    (req.query && req.query.filename) ||
    (req.body && req.body.filename);

  if (requested && typeof requested === "string") return sanitizeFilename(requested);
  return "tiktok-" + Date.now() + extensionFor(contentType);
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 200);
}

function extensionFor(contentType) {
  const t = (contentType || "").toLowerCase();
  if (t.includes("video/mp4"))                              return ".mp4";
  if (t.includes("video/webm"))                             return ".webm";
  if (t.includes("audio/mpeg") || t.includes("audio/mp3"))  return ".mp3";
  if (t.includes("audio/mp4")  || t.includes("audio/aac"))  return ".m4a";
  if (t.includes("image/jpeg"))                             return ".jpg";
  if (t.includes("image/png"))                              return ".png";
  if (t.includes("image/webp"))                             return ".webp";
  if (t.includes("image/gif"))                              return ".gif";
  return "";
}

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const decimals = (i === 0 || n >= 10) ? 0 : 1;
  return n.toFixed(decimals) + " " + units[i];
}
