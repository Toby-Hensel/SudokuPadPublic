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
const rooms = new Map();

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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
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
      latest: null,
      clients: new Map(),
      updatedAt: Date.now()
    });
  }

  return rooms.get(roomId);
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sanitizeRoomId(value, fallback) {
  const candidate = String(value || fallback || "").trim().toLowerCase();
  return candidate.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || fallback || makeRoomId();
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
  const scriptTag = `<script src="/assets/collab-client.js?v=${assetVersion}" defer></script>`;
  return html
    .replace("</head>", `${headTag}\n</head>`)
    .replace("</body>", `${scriptTag}\n</body>`);
}

function renderHomePage(origin) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SudokuPad Party</title>
    <style>
      :root {
        --bg: #08131b;
        --panel: rgba(11, 27, 39, 0.86);
        --panel-strong: rgba(10, 22, 32, 0.96);
        --text: #f3f6f8;
        --muted: #9bb5c4;
        --line: rgba(173, 216, 230, 0.18);
        --accent: #7cf5bf;
        --accent-2: #ffd36d;
        --danger: #ff8b7f;
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.4);
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
          radial-gradient(circle at top left, rgba(124, 245, 191, 0.18), transparent 36%),
          radial-gradient(circle at 85% 10%, rgba(255, 211, 109, 0.18), transparent 28%),
          linear-gradient(160deg, #051017 0%, #0b1620 48%, #06131b 100%);
      }

      main {
        width: min(1080px, calc(100% - 32px));
        margin: 0 auto;
        padding: 48px 0 64px;
      }

      .hero {
        display: grid;
        gap: 28px;
        grid-template-columns: 1.15fr 0.85fr;
        align-items: start;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
        color: var(--muted);
        font-size: 0.92rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      h1 {
        margin: 18px 0 14px;
        font-size: clamp(2.8rem, 7vw, 5.6rem);
        line-height: 0.95;
        letter-spacing: -0.05em;
      }

      .lede {
        max-width: 42rem;
        color: var(--muted);
        font-size: 1.1rem;
        line-height: 1.6;
      }

      .card {
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
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

      .facts {
        display: grid;
        gap: 14px;
      }

      .fact {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
      }

      .fact strong {
        display: block;
        margin-bottom: 6px;
        color: var(--accent-2);
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

      @media (max-width: 900px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <div class="eyebrow">Real-time SudokuPad rooms</div>
          <h1>Open the same SudokuPad links, but solve them together.</h1>
          <p class="lede">
            Paste any SudokuPad URL or short puzzle ID and this site will open the official puzzle board through a collaboration-enabled proxy.
            Everyone in the same room sees the board update live.
          </p>
        </div>

        <div class="card">
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
        </div>
      </section>

      <section class="facts" style="margin-top: 26px;">
        <div class="fact">
          <strong>What stays compatible</strong>
          <div class="mini">Short IDs like <code>/94Qq6qGjh2</code>, <code>/sudoku/94Qq6qGjh2</code>, and SudokuPad URLs with the puzzle embedded all resolve through the same upstream puzzle data.</div>
        </div>
        <div class="fact">
          <strong>How syncing works</strong>
          <div class="mini">The page mirrors SudokuPad's own replay/action format, so ordinary digit entry, notes, colors, and undo/redo stay aligned between solvers in the same room.</div>
        </div>
        <div class="fact">
          <strong>Current deployment model</strong>
          <div class="mini">Rooms are stored in server memory. That keeps setup simple for a single server, but you'll want Redis or a database-backed pub/sub layer before scaling across multiple instances.</div>
        </div>
      </section>

      <div class="footer">
        Default origin: <code>${escapeHtml(origin)}</code>
      </div>
    </main>

    <script>
      (() => {
        const origin = ${JSON.stringify(origin)};
        const sourceInput = document.getElementById("source");
        const roomInput = document.getElementById("room");
        const output = document.getElementById("output");
        const resultLink = document.getElementById("result-link");
        const copyLinkButton = document.getElementById("copy-link");
        const openLinkButton = document.getElementById("open-link");
        const openPublicButton = document.getElementById("open-public");

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

        function buildLink({ usePuzzleRoom }) {
          const puzzleId = extractPuzzleId(sourceInput.value);
          if (!puzzleId) {
            sourceInput.focus();
            throw new Error("Please enter a SudokuPad link or puzzle ID.");
          }

          const room = usePuzzleRoom
            ? slugifyRoom(puzzleId)
            : slugifyRoom(roomInput.value) || randomRoom();

          const link = new URL(origin + "/" + encodeURIComponent(puzzleId));
          link.searchParams.set("room", room);
          return link.toString();
        }

        function showLink(link) {
          resultLink.href = link;
          resultLink.textContent = link;
          output.classList.add("visible");
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

async function handleSync(res, url) {
  const roomId = sanitizeRoomId(url.pathname.split("/").pop(), "default");
  const room = getRoom(roomId);

  sendJson(res, 200, {
    roomId,
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
    const origin = `http://${req.headers.host || `localhost:${port}`}`;
    const url = new URL(req.url || "/", origin);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(renderHomePage(origin));
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

    if (req.method === "POST" && pathname.startsWith("/api/collab/presence/")) {
      await handlePresence(req, res, url);
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
