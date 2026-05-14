(() => {
  const pathMatch = window.location.pathname.match(/^\/(?:sudoku\/)?([^/?#]+)/i);
  const puzzleId = pathMatch ? decodeURIComponent(pathMatch[1]) : "";

  if (!puzzleId) {
    return;
  }

  const publicOrigin = window.location.origin;
  const query = new URLSearchParams(window.location.search);
  const roomId = (() => {
    const fallback = puzzleId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "shared";
    const candidate = String(query.get("room") || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return candidate || fallback;
  })();
  const clientIdKey = `coop-client-id:${roomId}`;
  const nameKey = "coop-display-name";
  const minimizedKey = `coop-dock-minimized:${puzzleId}`;
  const inviteLink = `${publicOrigin}/${encodeURIComponent(puzzleId)}?room=${encodeURIComponent(roomId)}&coop=1`;
  const syncPollIntervalMs = 1_000;
  const localReplayCheckMs = 250;
  const requestTimeoutMs = 10_000;
  const pointerBroadcastThrottleMs = 60;

  const state = {
    roomId,
    puzzleId,
    clientId: sessionStorage.getItem(clientIdKey) || `${Math.random().toString(36).slice(2, 10)}`,
    name: localStorage.getItem(nameKey) || `Solver ${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    eventSource: null,
    ready: false,
    live: false,
    applyingRemote: false,
    queuedSnapshot: null,
    latestRevision: 0,
    lastAppliedHash: "",
    lastSentHash: "",
    inFlightHash: "",
    broadcastTimer: null,
    presenceTimer: null,
    snapshotTimer: null,
    replayMonitorTimer: null,
    reconnectTimer: null,
    destroyed: false,
    peers: [],
    remoteHighlights: new Map(),
    lastPointerSentAt: 0,
    lastPointerKey: ""
  };

  sessionStorage.setItem(clientIdKey, state.clientId);

  const ui = createUi();
  ui.nameInput.value = state.name;
  setStatus("Connecting", "offline");
  setMeta(inviteLink);
  setDockMinimized(localStorage.getItem(minimizedKey) === "1");

  ui.copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(inviteLink);
    const label = ui.copyButton.textContent;
    ui.copyButton.textContent = "Copied";
    window.setTimeout(() => {
      ui.copyButton.textContent = label;
    }, 1200);
  });

  ui.openButton.addEventListener("click", () => {
    window.open(inviteLink, "_blank", "noopener,noreferrer");
  });

  ui.toggleButton.addEventListener("click", () => {
    const nextMinimized = !ui.dock.classList.contains("collab-dock--minimized");
    setDockMinimized(nextMinimized);
  });

  ui.nameInput.addEventListener("change", () => {
    state.name = ui.nameInput.value.trim() || state.name;
    localStorage.setItem(nameKey, state.name);
    ui.nameInput.value = state.name;
    sendPresence().catch((error) => {
      console.error("Presence update failed:", error);
    });
  });

  window.addEventListener("resize", renderRemoteHighlights);
  window.addEventListener("scroll", renderRemoteHighlights, true);

  waitForSudokuPad()
    .then(async () => {
      state.ready = true;
      state.lastAppliedHash = getReplayHash(getReplayPayload());
      state.lastSentHash = state.lastAppliedHash;
      patchActionBroadcasting();
      patchProgressSaving();
      await registerRoom();
      await fetchLatestSnapshot({ force: true });
      startRealtime();
    })
    .catch((error) => {
      console.error("Co-op bootstrap failed:", error);
      setStatus("SudokuPad failed to load", "offline");
    });

  window.addEventListener("beforeunload", () => {
    state.destroyed = true;
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (state.presenceTimer) {
      window.clearInterval(state.presenceTimer);
    }
    if (state.snapshotTimer) {
      window.clearInterval(state.snapshotTimer);
    }
    if (state.replayMonitorTimer) {
      window.clearInterval(state.replayMonitorTimer);
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
    }
  });

  function createUi() {
    const dock = document.createElement("aside");
    dock.className = "collab-dock";
    dock.innerHTML = `
      <div class="collab-dock__head">
        <div>
          <div class="collab-dock__title">Co-op Room</div>
          <div class="collab-dock__status" data-state="offline">Connecting</div>
        </div>
        <button class="collab-dock__toggle" type="button" aria-label="Minimize co-op room panel" title="Minimize">-</button>
      </div>
      <div class="collab-dock__body">
        <label class="collab-dock__label">
          Display name
          <input class="collab-dock__input" type="text" maxlength="48">
        </label>
        <div class="collab-dock__label">
          Invite link
          <div class="collab-dock__meta"></div>
        </div>
        <div class="collab-dock__actions">
          <button class="collab-dock__button collab-dock__button--primary" type="button">Copy invite</button>
          <button class="collab-dock__button collab-dock__button--secondary" type="button">Open invite</button>
        </div>
        <div class="collab-dock__label">
          Solvers in room
          <div class="collab-dock__peers"></div>
        </div>
        <p class="collab-dock__note">This clean rebuild syncs board state and selected-cell highlights only.</p>
      </div>
    `;

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "collab-remote-highlight-layer";
    document.body.append(highlightLayer, dock);

    return {
      dock,
      status: dock.querySelector(".collab-dock__status"),
      nameInput: dock.querySelector(".collab-dock__input"),
      meta: dock.querySelector(".collab-dock__meta"),
      copyButton: dock.querySelector(".collab-dock__button--primary"),
      openButton: dock.querySelector(".collab-dock__button--secondary"),
      toggleButton: dock.querySelector(".collab-dock__toggle"),
      peers: dock.querySelector(".collab-dock__peers"),
      highlightLayer
    };
  }

  function setStatus(text, mode) {
    ui.status.textContent = text;
    ui.status.dataset.state = mode;
  }

  function setMeta(text) {
    ui.meta.textContent = text;
    ui.meta.title = text;
  }

  function setDockMinimized(minimized) {
    ui.dock.classList.toggle("collab-dock--minimized", minimized);
    ui.toggleButton.textContent = minimized ? "+" : "-";
    ui.toggleButton.setAttribute("aria-label", minimized ? "Expand co-op room panel" : "Minimize co-op room panel");
    ui.toggleButton.title = minimized ? "Expand" : "Minimize";
    localStorage.setItem(minimizedKey, minimized ? "1" : "0");
  }

  function renderPresence(payload) {
    const peers = Array.isArray(payload?.peers) ? payload.peers : [];
    state.peers = peers;
    ui.peers.innerHTML = "";

    if (peers.length === 0) {
      const pill = document.createElement("span");
      pill.className = "collab-dock__peer";
      pill.textContent = "Just you";
      ui.peers.appendChild(pill);
      return;
    }

    peers.forEach((peer) => {
      const pill = document.createElement("span");
      pill.className = "collab-dock__peer";
      pill.textContent = peer.clientId === state.clientId ? `${peer.name} (you)` : peer.name;
      ui.peers.appendChild(pill);
    });
  }

  function getFramework() {
    return typeof Framework !== "undefined" ? Framework : window.Framework;
  }

  function getReplayApi() {
    return typeof Replay !== "undefined" ? Replay : window.Replay;
  }

  function getPuzzleApi() {
    return typeof Puzzle !== "undefined" ? Puzzle : window.Puzzle;
  }

  function getReplayPayload() {
    const framework = getFramework();
    const replayApi = getReplayApi();
    const replay = replayApi.create(framework.app.puzzle);
    replay.actions = [...(replay.actions || [])].filter((action) => typeof action === "string" && action.length > 0);
    return replay;
  }

  function getReplayHash(replay) {
    return JSON.stringify(replay);
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

  function waitForSudokuPad(timeoutMs = 30_000) {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const tick = () => {
        const app = getFramework()?.app;
        const puzzle = app?.puzzle;

        if (app && puzzle && typeof app.getReplay === "function" && typeof app.loadReplay === "function" && puzzle.puzzleId) {
          resolve();
          return;
        }

        if (Date.now() - start > timeoutMs) {
          reject(new Error("Timed out waiting for the SudokuPad runtime."));
          return;
        }

        window.setTimeout(tick, 150);
      };

      tick();
    });
  }

  function collabFetch(url, options = {}, timeoutMs = requestTimeoutMs) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
      ...options,
      signal: controller.signal
    }).finally(() => {
      window.clearTimeout(timeoutId);
    });
  }

  async function registerRoom() {
    const response = await collabFetch(`/api/coop/register/${encodeURIComponent(state.roomId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: state.clientId,
        name: state.name,
        puzzleId: state.puzzleId
      })
    });

    if (!response.ok) {
      throw new Error(`Room registration failed with ${response.status}`);
    }

    const payload = await response.json();
    renderPresence(payload.presence);
  }

  async function sendPresence() {
    const response = await collabFetch(`/api/coop/presence/${encodeURIComponent(state.roomId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: state.clientId,
        name: state.name
      })
    });

    if (!response.ok) {
      throw new Error(`Presence update failed with ${response.status}`);
    }

    const payload = await response.json();
    renderPresence(payload.presence);
  }

  function scheduleBroadcast(delayMs = 45) {
    window.clearTimeout(state.broadcastTimer);
    state.broadcastTimer = window.setTimeout(() => {
      pushLocalReplay().catch((error) => {
        console.error("Replay sync failed:", error);
      });
    }, delayMs);
  }

  async function pushLocalReplay() {
    if (!state.ready || state.applyingRemote) {
      return;
    }

    const replay = getReplayPayload();
    const hash = getReplayHash(replay);

    if (hash === state.lastSentHash || hash === state.inFlightHash) {
      return;
    }

    state.inFlightHash = hash;

    try {
      const response = await collabFetch(`/api/coop/update/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          name: state.name,
          replay,
          baseRevision: state.latestRevision
        })
      });

      if (!response.ok) {
        throw new Error(`Replay update failed with ${response.status}`);
      }

      const payload = await response.json();
      state.latestRevision = Math.max(state.latestRevision, Number(payload.revision) || 0);
      state.lastAppliedHash = hash;
      state.lastSentHash = hash;
      setStatus("Live", "live");
    } finally {
      state.inFlightHash = "";
    }
  }

  async function applySnapshot(snapshot, options = {}) {
    const force = options.force === true;

    if (!snapshot || !snapshot.replay || (!force && snapshot.revision <= state.latestRevision)) {
      return;
    }

    state.latestRevision = Math.max(state.latestRevision, Number(snapshot.revision) || 0);

    if (state.applyingRemote) {
      state.queuedSnapshot = snapshot;
      return;
    }

    const framework = getFramework();
    const replayApi = getReplayApi();
    const puzzleApi = getPuzzleApi();
    const currentReplay = replayApi.create(framework.app.puzzle);
    const currentHash = getReplayHash(currentReplay);
    const snapshotHash = getReplayHash(snapshot.replay);
    const hasUnsyncedLocalChanges = currentHash !== state.lastAppliedHash;
    const nextReplay = hasUnsyncedLocalChanges ? mergeReplays(snapshot.replay, currentReplay) : snapshot.replay;
    const nextHash = getReplayHash(nextReplay);

    if (nextHash === currentHash) {
      if (!hasUnsyncedLocalChanges) {
        state.lastAppliedHash = snapshotHash;
        state.lastSentHash = snapshotHash;
      }
      setStatus("Live", "live");
      return;
    }

    state.applyingRemote = true;
    setStatus(`Syncing from ${snapshot.name || "room"}`, "live");

    try {
      await framework.app.loadReplay(nextReplay, { speed: -1 });
      const replayLength = puzzleApi.replayLength(nextReplay);

      if (!Number.isNaN(replayLength)) {
        framework.app.timer.setStartTime(Date.now() - replayLength);
      }

      if (hasUnsyncedLocalChanges) {
        state.lastAppliedHash = snapshotHash;
      } else {
        state.lastAppliedHash = nextHash;
        state.lastSentHash = nextHash;
      }

      setStatus("Live", "live");
    } catch (error) {
      console.error("Remote replay apply failed:", error);
      setStatus("Sync error", "offline");
    } finally {
      state.applyingRemote = false;
      if (nextHash !== state.lastSentHash) {
        scheduleBroadcast();
      }

      if (state.queuedSnapshot && state.queuedSnapshot.revision > snapshot.revision) {
        const queued = state.queuedSnapshot;
        state.queuedSnapshot = null;
        applySnapshot(queued);
      }
    }
  }

  async function fetchLatestSnapshot({ force = false } = {}) {
    const response = await collabFetch(`/api/coop/sync/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`);

    if (!response.ok) {
      throw new Error(`Snapshot fetch failed with ${response.status}`);
    }

    const payload = await response.json();
    renderPresence(payload.presence);
    if (Array.isArray(payload.highlights)) {
      payload.highlights.forEach(applyHighlight);
    }

    if (payload.snapshot) {
      await applySnapshot(payload.snapshot, { force });
    } else {
      setStatus("Live", "live");
    }
  }

  function connectStream() {
    if (state.destroyed) {
      return;
    }

    if (state.eventSource) {
      state.eventSource.close();
    }

    const source = new EventSource(`/api/coop/stream/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`);
    state.eventSource = source;

    source.addEventListener("open", () => {
      state.live = true;
      setStatus("Live", "live");
    });

    source.addEventListener("presence", (event) => {
      const payload = JSON.parse(event.data);
      renderPresence(payload);
    });

    source.addEventListener("snapshot", (event) => {
      const payload = JSON.parse(event.data);
      applySnapshot(payload).catch((error) => {
        console.error("Snapshot apply failed:", error);
      });
    });

    source.addEventListener("highlight", (event) => {
      const payload = JSON.parse(event.data);
      if (Array.isArray(payload)) {
        payload.forEach(applyHighlight);
      } else {
        applyHighlight(payload);
      }
    });

    source.addEventListener("error", () => {
      state.live = false;
      setStatus("Reconnecting", "offline");
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      if (!state.reconnectTimer) {
        state.reconnectTimer = window.setTimeout(() => {
          state.reconnectTimer = null;
          connectStream();
        }, 1_500);
      }
    });
  }

  function startRealtime() {
    connectStream();
    sendPresence().catch((error) => {
      console.error("Initial presence failed:", error);
    });

    state.presenceTimer = window.setInterval(() => {
      sendPresence().catch((error) => {
        console.error("Presence refresh failed:", error);
      });
    }, 20_000);

    state.snapshotTimer = window.setInterval(() => {
      fetchLatestSnapshot().catch((error) => {
        console.error("Snapshot poll failed:", error);
      });
    }, syncPollIntervalMs);

    state.replayMonitorTimer = window.setInterval(() => {
      pushLocalReplay().catch((error) => {
        console.error("Replay monitor failed:", error);
      });
    }, localReplayCheckMs);
  }

  function getBoardRect() {
    const board = document.querySelector("#svgrenderer");
    return board instanceof Element ? board.getBoundingClientRect() : null;
  }

  function getBoardDimensions() {
    const replay = getReplayPayload();
    return {
      rows: Math.max(1, Number(replay.rows) || 9),
      cols: Math.max(1, Number(replay.cols) || 9)
    };
  }

  function pruneRemoteHighlights() {
    const cutoff = Date.now() - 4_000;
    for (const [clientId, highlight] of state.remoteHighlights.entries()) {
      if (!highlight || highlight.updatedAt < cutoff) {
        state.remoteHighlights.delete(clientId);
      }
    }
  }

  function renderRemoteHighlights() {
    pruneRemoteHighlights();
    ui.highlightLayer.innerHTML = "";

    const boardRect = getBoardRect();
    if (!boardRect || boardRect.width <= 0 || boardRect.height <= 0) {
      return;
    }

    for (const highlight of state.remoteHighlights.values()) {
      const cellWidth = boardRect.width / Math.max(1, highlight.cols || 9);
      const cellHeight = boardRect.height / Math.max(1, highlight.rows || 9);
      const marker = document.createElement("div");
      marker.className = "collab-remote-highlight";
      marker.dataset.row = String(highlight.row);
      marker.dataset.col = String(highlight.col);
      marker.style.left = `${boardRect.left + cellWidth * highlight.col}px`;
      marker.style.top = `${boardRect.top + cellHeight * highlight.row}px`;
      marker.style.width = `${cellWidth}px`;
      marker.style.height = `${cellHeight}px`;
      marker.innerHTML = `<span class="collab-remote-highlight__label">${highlight.name || "Solver"}</span>`;
      ui.highlightLayer.appendChild(marker);

      if (Number.isFinite(highlight.xRatio) && Number.isFinite(highlight.yRatio)) {
        const cursor = document.createElement("div");
        cursor.className = "collab-remote-cursor";
        cursor.style.left = `${boardRect.left + boardRect.width * highlight.xRatio}px`;
        cursor.style.top = `${boardRect.top + boardRect.height * highlight.yRatio}px`;
        cursor.innerHTML = `
          <span class="collab-remote-cursor__arrow"></span>
          <span class="collab-remote-cursor__label">${highlight.name || "Solver"}</span>
        `;
        ui.highlightLayer.appendChild(cursor);
      }
    }
  }

  function applyHighlight(highlight) {
    if (!highlight || highlight.clientId === state.clientId) {
      return;
    }

    const normalized = {
      clientId: String(highlight.clientId),
      name: String(highlight.name || "").trim() || "Solver",
      row: Number(highlight.row),
      col: Number(highlight.col),
      rows: Math.max(1, Number(highlight.rows) || 9),
      cols: Math.max(1, Number(highlight.cols) || 9),
      xRatio: Number(highlight.xRatio),
      yRatio: Number(highlight.yRatio),
      updatedAt: Number(highlight.updatedAt) || Date.now()
    };

    if (!Number.isInteger(normalized.row) || !Number.isInteger(normalized.col)) {
      return;
    }

    state.remoteHighlights.set(normalized.clientId, normalized);
    renderRemoteHighlights();
  }

  async function sendBoardHighlight(event, options = {}) {
    if (state.applyingRemote || !state.roomId || !state.clientId) {
      return;
    }

    const boardRect = getBoardRect();
    if (!boardRect) {
      return;
    }

    if (
      event.clientX < boardRect.left ||
      event.clientX > boardRect.right ||
      event.clientY < boardRect.top ||
      event.clientY > boardRect.bottom
    ) {
      return;
    }

    const { rows, cols } = getBoardDimensions();
    const xRatio = Math.max(0, Math.min(1, (event.clientX - boardRect.left) / boardRect.width));
    const yRatio = Math.max(0, Math.min(1, (event.clientY - boardRect.top) / boardRect.height));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(((event.clientY - boardRect.top) / boardRect.height) * rows)));
    const col = Math.max(0, Math.min(cols - 1, Math.floor(((event.clientX - boardRect.left) / boardRect.width) * cols)));
    const pointerKey = `${row}:${col}:${xRatio.toFixed(3)}:${yRatio.toFixed(3)}`;

    if (!options.force) {
      if (pointerKey === state.lastPointerKey && Date.now() - state.lastPointerSentAt < pointerBroadcastThrottleMs) {
        return;
      }

      if (Date.now() - state.lastPointerSentAt < pointerBroadcastThrottleMs) {
        return;
      }
    }

    try {
      await collabFetch(`/api/coop/highlight/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          name: state.name,
          row,
          col,
          rows,
          cols,
          xRatio,
          yRatio
        })
      });
      state.lastPointerSentAt = Date.now();
      state.lastPointerKey = pointerKey;
    } catch (error) {
      console.error("Highlight broadcast failed:", error);
    }
  }

  function sendBoardCursor(event) {
    sendBoardHighlight(event).catch((error) => {
      console.error("Cursor broadcast failed:", error);
    });
  }

  function patchProgressSaving() {
    const puzzle = getFramework().app.puzzle;

    if (puzzle.__coopSavePatched) {
      return;
    }

    const original = puzzle.saveProgress.bind(puzzle);
    puzzle.saveProgress = (...args) => {
      const result = original(...args);
      if (!state.applyingRemote) {
        scheduleBroadcast(100);
      }
      return result;
    };
    puzzle.__coopSavePatched = true;
  }

  function patchActionBroadcasting() {
    const puzzle = getFramework().app.puzzle;

    if (puzzle.__coopActPatched) {
      return;
    }

    if (!puzzle.__coopHighlightPatched) {
      document.addEventListener("pointerdown", (event) => {
        sendBoardHighlight(event, { force: true }).catch((error) => {
          console.error("Highlight broadcast failed:", error);
        });
      }, true);
      document.addEventListener("pointermove", sendBoardCursor, true);
      puzzle.__coopHighlightPatched = true;
    }

    const original = puzzle.act.bind(puzzle);
    puzzle.act = (...args) => {
      const result = original(...args);
      if (!state.applyingRemote) {
        scheduleBroadcast();
      }
      return result;
    };
    puzzle.__coopActPatched = true;
  }
})();
