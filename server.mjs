import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, "public");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const upstreamOrigin = process.env.UPSTREAM_ORIGIN || "https://sudokupad.app";
const assetVersion = process.env.RENDER_GIT_COMMIT || "dev";
const publicAppOrigin = process.env.PUBLIC_APP_ORIGIN || "https://sudokupad-party.onrender.com";
const ctcFeedUrl = process.env.CTC_FEED_URL || "https://www.youtube.com/feeds/videos.xml?channel_id=UCC-UOdK8-mIjxBQm_ot1T-Q";
const defaultIceServers = [
  { urls: ["stun:stun.l.google.com:19302"] }
];
const iceServers = (() => {
  try {
    const parsed = JSON.parse(process.env.COLLAB_ICE_SERVERS_JSON || "");
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultIceServers;
  } catch {
    return defaultIceServers;
  }
})();
const rooms = new Map();
const ctcFeedCache = {
  expiresAt: 0,
  videos: [],
  lastFetchedAt: null
};

const publicContentTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sha(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function makeRoomId() {
  return randomBytes(6).toString("base64url").toLowerCase();
}

function normalizePuzzleId(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/)[0]
    .slice(0, 160);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlValue(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function extractXmlAttribute(block, tagName, attribute) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${attribute}="([^"]+)"`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function extractSudokuPadUrl(description) {
  const match = String(description || "").match(/https?:\/\/(?:sudokupad\.app|app\.crackingthecryptic\.com\/sudoku)\/[^\s<>"']+/i);
  return match ? match[0].replace(/[)\].,;!?]+$/, "") : "";
}

function formatPublishedDate(isoString) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

async function fetchLatestCtcVideos(limit = 5) {
  if (Date.now() < ctcFeedCache.expiresAt && ctcFeedCache.videos.length >= limit) {
    return ctcFeedCache.videos.slice(0, limit);
  }

  const response = await fetch(ctcFeedUrl, {
    headers: {
      "user-agent": "SudokuPad Party Landing Page"
    }
  });

  if (!response.ok) {
    throw new Error(`Cracking the Cryptic feed request failed with ${response.status}`);
  }

  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map((match) => match[1]);

  const videos = entries.map((entry) => {
    const title = extractXmlValue(entry, "title");
    const youtubeUrl = extractXmlAttribute(entry, "link", "href");
    const publishedAt = extractXmlValue(entry, "published");
    const thumbnailUrl = extractXmlAttribute(entry, "media:thumbnail", "url");
    const description = extractXmlValue(entry, "media:description");
    const sudokuPadUrl = extractSudokuPadUrl(description);

    return {
      title,
      youtubeUrl,
      publishedAt,
      publishedLabel: formatPublishedDate(publishedAt),
      thumbnailUrl,
      sudokuPadUrl,
      hasSudokuPadUrl: Boolean(sudokuPadUrl)
    };
  }).filter((video) => video.hasSudokuPadUrl).slice(0, limit);

  ctcFeedCache.videos = videos;
  ctcFeedCache.lastFetchedAt = new Date().toISOString();
  ctcFeedCache.expiresAt = Date.now() + 10 * 60 * 1000;

  return videos;
}

function renderCtcVideoCards(videos, options = {}) {
  const compact = options.compact === true;
  if (!videos.length) {
    return `
      <div class="ctc-empty">
        <strong>Latest uploads are loading awkwardly right now.</strong>
        <div class="mini">The launch tools still work. Try refreshing in a moment and the feed should repopulate.</div>
      </div>
    `;
  }

  return videos.map((video) => `
    <article class="video-card${compact ? " video-card--compact" : ""}">
      <a class="video-card__thumb" href="${escapeHtml(video.youtubeUrl)}" target="_blank" rel="noreferrer">
        <img src="${escapeHtml(video.thumbnailUrl)}" alt="${escapeHtml(video.title)} thumbnail" loading="lazy">
      </a>
      <div class="video-card__body">
        <div class="video-card__meta">
          <span class="video-card__badge">${video.hasSudokuPadUrl ? "SudokuPad linked" : "No SudokuPad link"}</span>
          <span>${escapeHtml(video.publishedLabel)}</span>
        </div>
        <h3>${escapeHtml(video.title)}</h3>
        <div class="video-card__actions">
          <a class="video-card__button video-card__button--watch" href="${escapeHtml(video.youtubeUrl)}" target="_blank" rel="noreferrer">Watch on YouTube</a>
          <button class="video-card__button video-card__button--play" type="button" data-ctc-puzzle-source="${escapeHtml(video.sudokuPadUrl)}">Create room from puzzle</button>
        </div>
      </div>
    </article>
  `).join("");
}

function isLocalOrPrivateHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (!value) {
    return false;
  }

  if (value === "localhost" || value === "127.0.0.1" || value === "::1" || value.endsWith(".local")) {
    return true;
  }

  if (/^10\./.test(value) || /^192\.168\./.test(value)) {
    return true;
  }

  const private172 = value.match(/^172\.(\d{1,3})\./);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function getPreferredAppOrigin(origin) {
  try {
    const current = new URL(origin);
    const preferred = new URL(publicAppOrigin);
    if (isLocalOrPrivateHostname(current.hostname) && current.origin !== preferred.origin) {
      return preferred.origin;
    }
    return current.origin;
  } catch {
    return origin;
  }
}

function shouldRedirectToPublic(url, origin) {
  if (process.env.ALLOW_LOCAL_ROOMS === "1" || url.searchParams.get("local") === "1") {
    return false;
  }

  try {
    const current = new URL(origin);
    const preferred = new URL(publicAppOrigin);
    return isPuzzleRoute(url.pathname) && isLocalOrPrivateHostname(current.hostname) && current.origin !== preferred.origin;
  } catch {
    return false;
  }
}

function isReservedPath(pathname) {
  return pathname === "/" ||
    pathname.startsWith("/api/") ||
    pathname === "/assets/collab-client.css" ||
    pathname === "/assets/collab-client.js" ||
    pathname === "/favicon.ico";
}

function isPuzzleRoute(pathname) {
  if (isReservedPath(pathname)) {
    return false;
  }

  if (/\.[a-z0-9]+$/i.test(pathname)) {
    return false;
  }

  return /^\/(?:sudoku\/)?[^/]+$/i.test(pathname);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      puzzleId: null,
      latest: null,
      clients: new Map(),
      updatedAt: Date.now()
    });
  }

  return rooms.get(roomId);
}

function peekRoom(roomId) {
  return rooms.get(roomId) || null;
}

function activePeers(room) {
  const cutoff = Date.now() - 45_000;
  const peers = [];

  for (const client of room.clients.values()) {
    if (client.lastSeen < cutoff) {
      continue;
    }

    peers.push({
      clientId: client.clientId,
      name: client.name || `Solver ${client.clientId.slice(0, 4)}`,
      connectedAt: client.connectedAt,
      lastSeen: client.lastSeen
    });
  }

  return peers.sort((left, right) => left.connectedAt - right.connectedAt);
}

function presencePayload(room) {
  const peers = activePeers(room);
  return {
    roomId: room.roomId,
    count: peers.length,
    peers
  };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, event, payload) {
  for (const client of room.clients.values()) {
    if (!client.res.writableEnded) {
      writeSse(client.res, event, payload);
    }
  }
}

function mergeReplays(currentReplay, incomingReplay) {
  if (!currentReplay) {
    return incomingReplay;
  }

  if (!incomingReplay) {
    return currentReplay;
  }

  if (currentReplay.puzzleId !== incomingReplay.puzzleId) {
    return incomingReplay;
  }

  const currentActions = Array.isArray(currentReplay.actions) ? currentReplay.actions : [];
  const incomingActions = Array.isArray(incomingReplay.actions) ? incomingReplay.actions : [];
  let prefixLength = 0;

  while (
    prefixLength < currentActions.length &&
    prefixLength < incomingActions.length &&
    currentActions[prefixLength] === incomingActions[prefixLength]
  ) {
    prefixLength += 1;
  }

  if (prefixLength === currentActions.length) {
    return incomingReplay;
  }

  if (prefixLength === incomingActions.length) {
    return currentReplay;
  }

  return {
    puzzleId: currentReplay.puzzleId,
    type: incomingReplay.type || currentReplay.type,
    version: incomingReplay.version || currentReplay.version,
    rows: incomingReplay.rows || currentReplay.rows,
    cols: incomingReplay.cols || currentReplay.cols,
    actions: currentActions.concat(incomingActions.slice(prefixLength))
  };
}

async function readJsonBody(req, sizeLimit = 1_000_000) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > sizeLimit) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function sanitizeRoomId(value, fallback) {
  const candidate = String(value || fallback || "").trim().toLowerCase();
  return candidate.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || fallback || makeRoomId();
}

function getHeaderValue(header) {
  if (Array.isArray(header)) {
    return String(header[0] || "");
  }
  return String(header || "");
}

function getRequestOrigin(req) {
  const forwardedProto = getHeaderValue(req.headers["x-forwarded-proto"]).split(",")[0].trim().toLowerCase();
  const forwardedHost = getHeaderValue(req.headers["x-forwarded-host"]).split(",")[0].trim();
  const hostHeader = forwardedHost || getHeaderValue(req.headers.host) || `localhost:${port}`;
  const hostname = hostHeader.split(":")[0].toLowerCase();
  const protocol = forwardedProto || (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ? "http" : "https");
  return `${protocol}://${hostHeader}`;
}

async function servePublicAsset(res, pathname) {
  const relativePath = pathname.replace(/^\/assets\//, "");
  const filePath = normalize(join(publicDir, relativePath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 400, { error: "Invalid asset path." });
    return;
  }

  const content = await readFile(filePath);
  const contentType = publicContentTypes[extname(filePath)] || "application/octet-stream";

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(content);
}

function injectCollabAssets(html) {
  const headTag = `<link rel="stylesheet" href="/assets/collab-client.css?v=${assetVersion}">`;
  const configTag = `<script>window.__COLLAB_PUBLIC_ORIGIN__=${JSON.stringify(publicAppOrigin)};window.__COLLAB_ICE_SERVERS__=${JSON.stringify(iceServers)};</script>`;
  const scriptTag = `<script src="/assets/collab-client.js?v=${assetVersion}" defer></script>`;
  return html
    .replace("</head>", `${headTag}\n${configTag}\n</head>`)
    .replace("</body>", `${scriptTag}\n</body>`);
}

function renderHomePage(origin, preferredOrigin, ctcVideos) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SudokuPad Party</title>
    <script>
      (() => {
        try {
          const storedTheme = localStorage.getItem("landing-theme");
          const preferredTheme = storedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
          document.documentElement.dataset.theme = preferredTheme;
        } catch {
          document.documentElement.dataset.theme = "dark";
        }
      })();
    </script>
    <style>
      :root {
        --bg: #081019;
        --panel: rgba(11, 24, 37, 0.88);
        --panel-strong: rgba(7, 18, 28, 0.95);
        --panel-soft: rgba(255, 255, 255, 0.04);
        --text: #f6f8fb;
        --muted: #9eb6c4;
        --line: rgba(173, 216, 230, 0.16);
        --accent: #8ff7cb;
        --accent-2: #ffd773;
        --accent-3: #7db6ff;
        --danger: #ff9d8f;
        --shadow: 0 30px 90px rgba(0, 0, 0, 0.42);
        --radius-xl: 28px;
        --radius-lg: 20px;
      }

      :root[data-theme="light"] {
        --bg: #f3f7fb;
        --panel: rgba(255, 255, 255, 0.88);
        --panel-strong: rgba(244, 249, 252, 0.96);
        --panel-soft: rgba(7, 18, 28, 0.04);
        --text: #10202f;
        --muted: #5f7485;
        --line: rgba(16, 32, 47, 0.12);
        --accent: #0d8f67;
        --accent-2: #c98600;
        --accent-3: #2f6bd8;
        --danger: #c85745;
        --shadow: 0 30px 80px rgba(18, 36, 52, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Space Grotesk", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 12% 18%, rgba(143, 247, 203, 0.18), transparent 26%),
          radial-gradient(circle at 84% 9%, rgba(125, 182, 255, 0.16), transparent 30%),
          radial-gradient(circle at 74% 72%, rgba(255, 215, 115, 0.13), transparent 24%),
          linear-gradient(150deg, #040a11 0%, #08131c 44%, #04090f 100%);
        transition: background 180ms ease, color 180ms ease;
      }

      :root[data-theme="light"] body {
        background:
          radial-gradient(circle at 10% 14%, rgba(13, 143, 103, 0.10), transparent 24%),
          radial-gradient(circle at 88% 10%, rgba(47, 107, 216, 0.10), transparent 28%),
          radial-gradient(circle at 74% 76%, rgba(201, 134, 0, 0.08), transparent 24%),
          linear-gradient(160deg, #f7fbff 0%, #edf4f8 46%, #f3f7fb 100%);
      }

      main {
        width: min(1200px, calc(100% - 32px));
        margin: 0 auto;
        padding: 34px 0 72px;
      }

      .hero-shell {
        display: grid;
        gap: 28px;
      }

      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        flex-wrap: wrap;
      }

      .hero {
        display: grid;
        gap: 28px;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
        align-items: stretch;
      }

      .hero-copy,
      .launch-card,
      .spotlight,
      .video-card {
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero-copy {
        position: relative;
        overflow: hidden;
        padding: 34px;
        border-radius: var(--radius-xl);
        grid-column: 1 / -1;
      }

      .hero-copy::after {
        content: "";
        position: absolute;
        inset: auto -80px -80px auto;
        width: 240px;
        height: 240px;
        background: radial-gradient(circle, rgba(143, 247, 203, 0.18), transparent 70%);
        pointer-events: none;
      }

      h1 {
        margin: 18px 0 14px;
        font-size: clamp(2.8rem, 7vw, 5.6rem);
        line-height: 0.95;
        letter-spacing: -0.05em;
      }

      .lede {
        max-width: 44rem;
        color: var(--muted);
        font-size: 1.1rem;
        line-height: 1.6;
      }

      .hero-copy__top {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        flex-wrap: wrap;
      }

      .hero-copy__top h1 {
        margin-bottom: 10px;
      }

      .hero-copy__tools {
        margin-top: 18px;
        display: grid;
        gap: 10px;
        max-width: 360px;
      }

      .hero-grid {
        margin-top: 28px;
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .hero-stat {
        padding: 16px 18px;
        border-radius: 18px;
        background: var(--panel-soft);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .hero-stat strong {
        display: block;
        font-size: 1rem;
        margin-bottom: 6px;
        color: var(--accent);
      }

      .hero-stat span {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.45;
      }

      .launch-card {
        border-radius: var(--radius-xl);
        padding: 24px;
        display: grid;
        gap: 18px;
        grid-column: 1 / -1;
      }

      .launch-card__title {
        font-size: 1.2rem;
        font-weight: 700;
      }

      .launch-card__grid {
        display: grid;
        gap: 22px;
        grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.85fr);
      }

      .launch-panel {
        display: grid;
        gap: 16px;
        align-content: start;
      }

      .launch-card__note {
        margin: -4px 0 0;
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.5;
      }

      form {
        display: grid;
        gap: 16px;
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 0.95rem;
        color: var(--muted);
      }

      input {
        width: 100%;
        padding: 16px 18px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        font: inherit;
      }

      input:focus {
        outline: 2px solid rgba(124, 245, 191, 0.4);
        border-color: rgba(124, 245, 191, 0.6);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      button {
        appearance: none;
        border: 0;
        cursor: pointer;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        font-weight: 700;
      }

      .primary {
        background: linear-gradient(135deg, var(--accent), #98ffda);
        color: #04150e;
      }

      .secondary {
        background: rgba(255, 255, 255, 0.08);
        color: var(--text);
        border: 1px solid var(--line);
      }

      .output {
        display: none;
        gap: 12px;
        margin-top: 18px;
        padding: 18px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid rgba(124, 245, 191, 0.25);
      }

      .output.visible {
        display: grid;
      }

      .output a {
        color: var(--accent);
        word-break: break-all;
      }

      .spotlight {
        margin-top: 26px;
        border-radius: var(--radius-xl);
        padding: 26px;
      }

      .section-top {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: end;
        flex-wrap: wrap;
        margin-bottom: 18px;
      }

      .section-top h2 {
        margin: 0;
        font-size: clamp(1.8rem, 4vw, 2.6rem);
        letter-spacing: -0.04em;
      }

      .section-top p {
        margin: 0;
        color: var(--muted);
        max-width: 40rem;
        line-height: 1.55;
      }

      .section-link {
        color: var(--accent);
        text-decoration: none;
        font-weight: 700;
      }

      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }

      .theme-toggle {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel-soft);
        color: var(--text);
        box-shadow: none;
      }

      .theme-toggle__icon {
        font-size: 1rem;
        line-height: 1;
      }

      .video-grid {
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }

      .video-card {
        overflow: hidden;
        border-radius: 22px;
      }

      .hero-feed {
        margin-top: 28px;
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }

      .video-card--compact {
        display: block;
      }

      .video-card--compact .video-card__thumb {
        height: auto;
      }

      .video-card--compact .video-card__body {
        padding: 16px 18px;
      }

      .video-card--compact .video-card__actions {
        grid-template-columns: 1fr;
      }

      .video-card__thumb {
        display: block;
        aspect-ratio: 16 / 9;
        overflow: hidden;
        background: #0b1620;
      }

      .video-card__thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .video-card__body {
        padding: 18px;
        display: grid;
        gap: 14px;
      }

      .video-card__meta {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        color: var(--muted);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .video-card__badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(143, 247, 203, 0.12);
        color: var(--accent);
        border: 1px solid rgba(143, 247, 203, 0.18);
      }

      .video-card h3 {
        margin: 0;
        font-size: 1.02rem;
        line-height: 1.35;
      }

      .video-card__actions {
        display: grid;
        gap: 10px;
      }

      .video-card__button {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        min-height: 44px;
        padding: 10px 14px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 700;
        font-size: 0.92rem;
      }

      .video-card__button--watch {
        color: #06131b;
        background: linear-gradient(135deg, var(--accent-2), #ffe59c);
      }

      .video-card__button--play {
        color: var(--text);
        background: rgba(125, 182, 255, 0.16);
        border: 1px solid rgba(125, 182, 255, 0.22);
      }

      .video-card__button--muted {
        color: var(--muted);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .ctc-empty {
        padding: 22px;
        border-radius: 20px;
        border: 1px dashed rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.03);
      }

      .mini {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.5;
      }

      .footer {
        margin-top: 28px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .footer code {
        color: var(--text);
      }

      @media (max-width: 1100px) {
        .hero-feed,
        .video-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }

      @media (max-width: 900px) {
        .hero {
          grid-template-columns: 1fr;
        }

        .hero-grid,
        .hero-feed,
        .video-grid,
        .launch-card__grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        main {
          width: min(100%, calc(100% - 20px));
          padding-top: 22px;
        }

        .hero-copy,
        .launch-card,
        .spotlight {
          padding: 20px;
          border-radius: 22px;
        }
      }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  </head>
  <body>
    <main>
      <section class="hero-shell">
        <div class="topbar">
          <div></div>
          <div class="topbar-actions">
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle color theme">
              <span class="theme-toggle__icon" id="theme-toggle-icon">☀</span>
              <span id="theme-toggle-label">Light mode</span>
            </button>
            <a class="section-link" href="https://www.youtube.com/channel/UCC-UOdK8-mIjxBQm_ot1T-Q" target="_blank" rel="noreferrer">Cracking the Cryptic on YouTube</a>
          </div>
        </div>

        <div class="hero">
          <div class="hero-copy">
            <div class="hero-copy__top">
              <div>
                <h1>Latest Cracking the Cryptic puzzle links.</h1>
                <p class="lede">
                  The newest five official uploads that include a SudokuPad link are now right at the top. Each one opens a fresh collaboration room immediately, or into a named room if you set one first.
                </p>
              </div>
              <a class="section-link" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCC-UOdK8-mIjxBQm_ot1T-Q" target="_blank" rel="noreferrer">Official upload feed</a>
            </div>
            <div class="hero-copy__tools">
              <label>
                Room name for Cracking the Cryptic links (optional)
                <input id="ctc-room" name="ctc-room" placeholder="leave blank for a fresh private room" autocomplete="off">
              </label>
              <div class="mini">When filled in, every Create room from puzzle button above will use this room name instead of creating a random one.</div>
            </div>
            <div class="hero-feed">
              ${renderCtcVideoCards(ctcVideos, { compact: true })}
            </div>
          </div>

          <div class="launch-card">
            <div>
              <div class="launch-card__title">Launch A Room</div>
              <p class="launch-card__note">Paste a SudokuPad URL or short puzzle ID. I’ll generate a collaboration link on the correct host for sharing.</p>
            </div>
            <form id="launch-form">
              <label>
                SudokuPad link or ID
                <input id="source" name="source" placeholder="https://sudokupad.app/94Qq6qGjh2" autocomplete="off">
              </label>
              <label>
                Room name (optional)
                <input id="room" name="room" placeholder="leave blank to create a fresh private room" autocomplete="off">
              </label>
              <div class="actions">
                <button class="primary" type="submit">Create collaboration link</button>
                <button class="secondary" type="button" id="open-public">Use shared puzzle room</button>
              </div>
            </form>
            <div class="output" id="output">
              <strong>Your collaboration link</strong>
              <a id="result-link" href="#"></a>
              <div class="actions">
                <button class="secondary" type="button" id="copy-link">Copy link</button>
                <button class="primary" type="button" id="open-link">Open room</button>
              </div>
            </div>
            <div class="launch-panel">
              <div>
                <div class="launch-card__title">Join Existing Room</div>
                <p class="launch-card__note">Type the room name someone else created and jump straight into that shared puzzle.</p>
              </div>
              <form id="join-form">
                <label>
                  Room name
                  <input id="join-room" name="join-room" placeholder="for example: streamparty" autocomplete="off">
                </label>
                <div class="actions">
                  <button class="secondary" type="submit" id="join-room-button">Join room</button>
                </div>
              </form>
              <div class="mini">Use the room name from the end of a shared collaboration link, after <code>?room=</code>.</div>
            </div>
          </div>
        </div>
      </section>

      <div class="footer">
        Collaboration origin: <code>${escapeHtml(preferredOrigin)}</code>
      </div>
    </main>

    <script>
      (() => {
        const origin = ${JSON.stringify(preferredOrigin)};
        const sourceInput = document.getElementById("source");
        const roomInput = document.getElementById("room");
        const ctcRoomInput = document.getElementById("ctc-room");
        const output = document.getElementById("output");
        const resultLink = document.getElementById("result-link");
        const copyLinkButton = document.getElementById("copy-link");
        const openLinkButton = document.getElementById("open-link");
        const openPublicButton = document.getElementById("open-public");
        const joinRoomInput = document.getElementById("join-room");
        const joinRoomButton = document.getElementById("join-room-button");
        const themeToggleButton = document.getElementById("theme-toggle");
        const themeToggleIcon = document.getElementById("theme-toggle-icon");
        const themeToggleLabel = document.getElementById("theme-toggle-label");

        function extractPuzzleId(value) {
          const raw = String(value || "").trim();
          if (!raw) return "";

          try {
            const url = new URL(raw);
            const queryPuzzleId = url.searchParams.get("puzzleid");
            if (queryPuzzleId) return queryPuzzleId.trim();
            const match = url.pathname.match(/^\\/(?:puzzle\\/|sudoku\\/)?(.+)$/i);
            return match ? decodeURIComponent(match[1]) : "";
          } catch {
            const normalized = raw.replace(/^\\/+/, "").replace(/^sudoku\\//i, "");
            return normalized.split(/[?#]/)[0];
          }
        }

        function slugifyRoom(value) {
          return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "")
            .slice(0, 64);
        }

        function randomRoom() {
          return Math.random().toString(36).slice(2, 10);
        }

        function applyTheme(theme) {
          const nextTheme = theme === "light" ? "light" : "dark";
          document.documentElement.dataset.theme = nextTheme;
          themeToggleIcon.textContent = nextTheme === "light" ? "☾" : "☀";
          themeToggleLabel.textContent = nextTheme === "light" ? "Dark mode" : "Light mode";
          themeToggleButton.setAttribute("aria-label", nextTheme === "light" ? "Switch to dark mode" : "Switch to light mode");
        }

        function toggleTheme() {
          const currentTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
          const nextTheme = currentTheme === "light" ? "dark" : "light";
          applyTheme(nextTheme);
          localStorage.setItem("landing-theme", nextTheme);
        }

        function buildLinkFromSource(source, { usePuzzleRoom, roomValue } = {}) {
          const puzzleId = extractPuzzleId(source);
          if (!puzzleId) {
            throw new Error("Please enter a SudokuPad link or puzzle ID.");
          }

          const room = usePuzzleRoom
            ? slugifyRoom(puzzleId)
            : slugifyRoom(roomValue) || randomRoom();

          const link = new URL(origin + "/" + encodeURIComponent(puzzleId));
          link.searchParams.set("room", room);
          return link.toString();
        }

        function buildLink({ usePuzzleRoom }) {
          const source = sourceInput.value;
          try {
            return buildLinkFromSource(source, {
              usePuzzleRoom,
              roomValue: roomInput.value
            });
          } catch (error) {
            sourceInput.focus();
            throw error;
          }
        }

        function showLink(link) {
          resultLink.href = link;
          resultLink.textContent = link;
          output.classList.add("visible");
        }

        async function joinExistingRoom() {
          const room = slugifyRoom(joinRoomInput.value);
          if (!room) {
            joinRoomInput.focus();
            throw new Error("Please enter a room name.");
          }

          const response = await fetch(origin + "/api/collab/lookup/" + encodeURIComponent(room));
          const payload = await response.json().catch(() => ({}));

          if (!response.ok) {
            throw new Error(payload.error || "Could not find that room.");
          }

          if (!payload.inviteLink) {
            throw new Error("That room is not ready yet.");
          }

          window.location.href = payload.inviteLink;
        }

        document.getElementById("launch-form").addEventListener("submit", (event) => {
          event.preventDefault();
          try {
            showLink(buildLink({ usePuzzleRoom: false }));
          } catch (error) {
            alert(error.message);
          }
        });

        openPublicButton.addEventListener("click", () => {
          try {
            showLink(buildLink({ usePuzzleRoom: true }));
          } catch (error) {
            alert(error.message);
          }
        });

        copyLinkButton.addEventListener("click", async () => {
          if (!resultLink.href) return;
          await navigator.clipboard.writeText(resultLink.href);
          copyLinkButton.textContent = "Copied";
          setTimeout(() => {
            copyLinkButton.textContent = "Copy link";
          }, 1200);
        });

        openLinkButton.addEventListener("click", () => {
          if (resultLink.href) {
            window.location.href = resultLink.href;
          }
        });

        document.getElementById("join-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          joinRoomButton.disabled = true;
          const originalLabel = joinRoomButton.textContent;
          joinRoomButton.textContent = "Joining...";
          try {
            await joinExistingRoom();
          } catch (error) {
            alert(error.message);
          } finally {
            joinRoomButton.disabled = false;
            joinRoomButton.textContent = originalLabel;
          }
        });

        themeToggleButton.addEventListener("click", toggleTheme);
        applyTheme(document.documentElement.dataset.theme);

        document.querySelectorAll("[data-ctc-puzzle-source]").forEach((button) => {
          button.addEventListener("click", () => {
            const source = button.getAttribute("data-ctc-puzzle-source");
            try {
              window.location.href = buildLinkFromSource(source, {
                usePuzzleRoom: false,
                roomValue: ctcRoomInput.value
              });
            } catch (error) {
              alert(error.message);
            }
          });
        });
      })();
    </script>
  </body>
</html>`;
}

async function proxyUpstream(req, res, url, { inject = false } = {}) {
  const upstreamUrl = new URL(url.pathname + url.search, upstreamOrigin);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers: {
      "user-agent": "SudokuPad Party Proxy"
    }
  });

  const headers = {
    "cache-control": inject ? "no-store" : (upstreamResponse.headers.get("cache-control") || "public, max-age=300"),
    "content-type": upstreamResponse.headers.get("content-type") || "application/octet-stream"
  };

  res.writeHead(upstreamResponse.status, headers);

  if (inject) {
    const html = await upstreamResponse.text();
    res.end(injectCollabAssets(html));
    return;
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  res.end(body);
}

function handleSse(req, res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const clientId = sanitizeRoomId(url.searchParams.get("clientId"), sha(Date.now()).slice(0, 8));
  const room = getRoom(roomId);
  const connectedAt = Date.now();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();

  res.write("retry: 3000\n");
  res.write(": connected\n\n");

  const pingId = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15_000);

  room.clients.set(clientId, {
    clientId,
    connectedAt,
    lastSeen: Date.now(),
    name: "",
    res,
    pingId
  });

  writeSse(res, "presence", presencePayload(room));

  if (room.latest) {
    writeSse(res, "snapshot", room.latest);
  }

  req.on("close", () => {
    clearInterval(pingId);
    room.clients.delete(clientId);
    room.updatedAt = Date.now();
    broadcast(room, "presence", presencePayload(room));
  });

  broadcast(room, "presence", presencePayload(room));
}

async function handlePresence(req, res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);
  const body = await readJsonBody(req);
  const clientId = sanitizeRoomId(body.clientId, sha(Math.random()).slice(0, 8));
  const name = String(body.name || "").trim().slice(0, 48);
  const client = room.clients.get(clientId);

  if (client) {
    client.name = name;
    client.lastSeen = Date.now();
  }

  room.updatedAt = Date.now();
  const payload = presencePayload(room);
  broadcast(room, "presence", payload);
  sendJson(res, 200, payload);
}

async function handleRoomRegistration(req, res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);
  const body = await readJsonBody(req);
  const puzzleId = normalizePuzzleId(body.puzzleId);

  if (!puzzleId) {
    sendJson(res, 400, { error: "Missing puzzleId." });
    return;
  }

  room.puzzleId = puzzleId;
  room.updatedAt = Date.now();

  sendJson(res, 200, {
    roomId,
    puzzleId
  });
}

async function handleRoomLookup(res, url, origin) {
  const roomId = String(url.pathname.split("/").pop() || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
  const room = roomId ? peekRoom(roomId) : null;
  const puzzleId = room?.puzzleId || room?.latest?.puzzleId || room?.latest?.replay?.puzzleId || "";
  const corsHeaders = {
    "access-control-allow-origin": "*"
  };

  if (!roomId) {
    sendJson(res, 400, { error: "Missing room name." }, corsHeaders);
    return;
  }

  if (!room) {
    sendJson(res, 404, { error: "Room not found." }, corsHeaders);
    return;
  }

  if (!puzzleId) {
    sendJson(res, 409, { error: "Room exists but is not ready yet." }, corsHeaders);
    return;
  }

  const inviteLink = new URL(`/${encodeURIComponent(puzzleId)}`, origin);
  inviteLink.searchParams.set("room", roomId);

  sendJson(res, 200, {
    roomId,
    puzzleId,
    inviteLink: inviteLink.toString()
  }, corsHeaders);
}

async function handleCallSignal(req, res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);
  const body = await readJsonBody(req);
  const fromClientId = sanitizeRoomId(body.clientId, "");
  const targetClientId = sanitizeRoomId(body.targetClientId, "");
  const signalType = String(body.signalType || "").trim().slice(0, 48);

  if (!fromClientId || !signalType || typeof body.payload !== "object" || body.payload === null) {
    sendJson(res, 400, { error: "Missing call signal payload." });
    return;
  }

  const eventPayload = {
    roomId,
    fromClientId,
    targetClientId: targetClientId || null,
    signalType,
    payload: body.payload
  };

  for (const client of room.clients.values()) {
    if (client.clientId === fromClientId) {
      continue;
    }

    if (targetClientId && client.clientId !== targetClientId) {
      continue;
    }

    if (!client.res.writableEnded) {
      writeSse(client.res, "call", eventPayload);
    }
  }

  sendJson(res, 200, { ok: true });
}

async function handleSync(res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);

  sendJson(res, 200, {
    roomId,
    puzzleId: room.puzzleId || room.latest?.puzzleId || room.latest?.replay?.puzzleId || null,
    snapshot: room.latest,
    presence: presencePayload(room)
  });
}

async function handleUpdate(req, res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);
  const body = await readJsonBody(req);

  if (!body || typeof body !== "object" || !body.replay) {
    sendJson(res, 400, { error: "Missing replay payload." });
    return;
  }

  const replay = body.replay;
  const baseRevision = Number(body.baseRevision) || 0;
  const incomingHash = sha(JSON.stringify(replay));
  const currentRevision = room.latest?.revision || 0;
  const nextReplay = baseRevision >= currentRevision ? replay : mergeReplays(room.latest?.replay, replay);
  const nextHash = sha(JSON.stringify(nextReplay));
  const previousHash = room.latest?.hash;

  if (previousHash && previousHash === nextHash) {
    sendJson(res, 200, {
      roomId,
      revision: room.latest.revision,
      unchanged: true
    });
    return;
  }

  room.latest = {
    roomId,
    revision: (room.latest?.revision || 0) + 1,
    updatedAt: Date.now(),
    puzzleId: nextReplay.puzzleId,
    clientId: sanitizeRoomId(body.clientId, "anon"),
    name: String(body.name || "").trim().slice(0, 48),
    replay: nextReplay,
    hash: nextHash,
    incomingHash
  };
  room.puzzleId = normalizePuzzleId(nextReplay.puzzleId) || room.puzzleId;
  room.updatedAt = Date.now();

  broadcast(room, "snapshot", room.latest);
  sendJson(res, 200, {
    roomId,
    revision: room.latest.revision,
    hash: room.latest.hash
  });
}

function pruneRooms() {
  const now = Date.now();

  for (const room of rooms.values()) {
    for (const [clientId, client] of room.clients.entries()) {
      if (client.lastSeen < now - 60_000) {
        clearInterval(client.pingId);
        room.clients.delete(clientId);
      }
    }

    if (room.clients.size === 0 && room.updatedAt < now - 24 * 60 * 60 * 1000) {
      rooms.delete(room.roomId);
    }
  }
}

setInterval(pruneRooms, 30_000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const origin = getRequestOrigin(req);
    const url = new URL(req.url || "/", origin);
    const { pathname } = url;
    const preferredOrigin = getPreferredAppOrigin(origin);
    const latestCtcVideos = req.method === "GET" && pathname === "/" ? await fetchLatestCtcVideos(5).catch(() => []) : [];

    if (req.method === "GET" && shouldRedirectToPublic(url, origin)) {
      const redirectUrl = new URL(url.pathname + url.search, preferredOrigin);
      res.writeHead(302, {
        location: redirectUrl.toString(),
        "cache-control": "no-store"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(renderHomePage(origin, preferredOrigin, latestCtcVideos));
      return;
    }

    if (req.method === "GET" && (pathname === "/assets/collab-client.css" || pathname === "/assets/collab-client.js")) {
      await servePublicAsset(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        upstreamOrigin,
        rooms: rooms.size
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/collab/stream/")) {
      handleSse(req, res, url);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/collab/sync/")) {
      await handleSync(res, url);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/collab/lookup/")) {
      await handleRoomLookup(res, url, preferredOrigin);
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/collab/presence/")) {
      await handlePresence(req, res, url);
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/collab/register/")) {
      await handleRoomRegistration(req, res, url);
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/collab/call/")) {
      await handleCallSignal(req, res, url);
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/collab/update/")) {
      await handleUpdate(req, res, url);
      return;
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET") {
      await proxyUpstream(req, res, url, { inject: isPuzzleRoute(pathname) });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
});

server.listen(port, host, () => {
  console.log(`SudokuPad Party running on http://${host}:${port}`);
});
