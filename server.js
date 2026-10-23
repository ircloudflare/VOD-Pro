// server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp("^" + UUID + "$", "i");
const VOD_PATH_RE = new RegExp("^/[^/]+/videos/(" + UUID + ")/?$", "i");
const VOD_PATH_ALT_RE = new RegExp("^/video/(" + UUID + ")/?$", "i");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0";

// kick.com, any subdomain of it, and any CloudFront host
function isAllowedHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "kick.com" || h.endsWith(".kick.com") || h.endsWith(".cloudfront.net");
}

function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" && isAllowedHost(parsed.hostname);
  } catch {
    return false;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };
}

function sendText(res, status, message) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

// Rewrite every URI in an HLS playlist so it points back to this server
function rewritePlaylist(text, upstreamUrl, origin) {
  const proxify = (raw) => {
    const abs = new URL(raw, upstreamUrl).toString();
    return origin + "/proxy?url=" + encodeURIComponent(abs);
  };

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`);
      }

      return proxify(trimmed);
    })
    .join("\n");
}

// Fallback: walk any JSON value and collect allowed https URLs that look like playlists
function collectPlaylistUrls(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;

  if (typeof value === "string") {
    if (value.startsWith("https://") && /\.m3u8(\?|$)/i.test(value) && isAllowedUrl(value)) {
      out.push(value);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPlaylistUrls(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) collectPlaylistUrls(value[key], out, depth + 1);
  }

  return out;
}

// Is the input a Kick VOD page URL or a bare video ID? -> { id, pageUrl } or null
function parseVodInput(input) {
  const s = (input || "").trim();

  if (UUID_RE.test(s)) {
    return { id: s, pageUrl: `https://kick.com/video/${s}` };
  }

  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (host !== "kick.com" && host !== "www.kick.com") return null;
    const m = u.pathname.match(VOD_PATH_RE) || u.pathname.match(VOD_PATH_ALT_RE);
    if (!m) return null;
    return { id: m[1], pageUrl: `https://kick.com${u.pathname}` };
  } catch {
    return null;
  }
}

// Resolve a VOD to its master.m3u8 through kick-video.download
async function resolveVod({ id, pageUrl }, channelId) {
  const api = new URL("https://kick-video.download/api/get-kick-video2");
  api.searchParams.set("url", pageUrl);
  if (channelId) api.searchParams.set("channelId", channelId);

  const upstream = await fetch(api, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://kick-video.download/",
    },
    redirect: "follow",
  });

  if (!upstream.ok) throw new Error("kick-video.download returned status " + upstream.status);

  let data;
  try {
    data = await upstream.json();
  } catch {
    throw new Error("kick-video.download returned a non-JSON response");
  }

  const candidates = [data?.video?.recording_url, data?.source];
  const found =
    candidates.find((u) => typeof u === "string" && isAllowedUrl(u)) ||
    collectPlaylistUrls(data)[0];

  if (!found) throw new Error("No playable playlist found in kick-video.download response");
  return found;
}

// /proxy?url=<VOD page URL | video ID | playlist URL | segment URL>[&channelId=...]
async function handleProxy(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method not allowed");
  }

  let target = requestUrl.searchParams.get("url");
  if (!target) return sendText(res, 400, "Missing url parameter");

  // VOD page URL or ID: resolve it to the real m3u8 first
  const vod = parseVodInput(target);
  if (vod) {
    try {
      target = await resolveVod(vod, requestUrl.searchParams.get("channelId"));
    } catch (err) {
      return sendText(res, 502, "Could not resolve VOD: " + err.message);
    }
  }

  if (!isAllowedUrl(target)) {
    return sendText(res, 403, "Host not allowed");
  }
  const upstreamUrl = new URL(target);

  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const origin = `${proto}://${req.headers.host}`;

  const upstreamHeaders = new Headers({
    "User-Agent": BROWSER_UA,
    "Accept": "*/*",
    "Origin": "https://kick.com",
    "Referer": "https://kick.com/",
  });
  if (req.headers.range) upstreamHeaders.set("Range", req.headers.range);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return sendText(res, 502, "Could not reach upstream: " + err.message);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return sendText(res, upstream.status, "Upstream error " + upstream.status);
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  const isPlaylist = upstreamUrl.pathname.endsWith(".m3u8") || contentType.includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = rewritePlaylist(text, upstreamUrl, origin);
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
    });
    return res.end(req.method === "HEAD" ? undefined : rewritten);
  }

  const headers = { ...corsHeaders() };
  headers["Content-Type"] = contentType || "video/mp2t";
  headers["Cache-Control"] = "public, max-age=3600";
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  res.writeHead(upstream.status, headers);

  if (req.method === "HEAD" || !upstream.body) {
    return res.end();
  }

  const body = Readable.fromWeb(upstream.body);
  body.on("error", () => res.destroy());
  res.on("close", () => body.destroy());
  body.pipe(res);
}

async function serveIndex(req, res) {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : html);
  } catch {
    sendText(res, 500, "index.html not found in public/");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://localhost");

    if (requestUrl.pathname === "/proxy") return await handleProxy(req, res, requestUrl);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      return await serveIndex(req, res);
    }

    sendText(res, 404, "Not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, "Internal server error");
    else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`HLS player listening on port ${PORT}`);
});