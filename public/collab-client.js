(() => {
  const pathMatch = window.location.pathname.match(/^\/(?:sudoku\/)?([^/?#]+)/i);
  const puzzleId = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
  const publicOrigin = (() => {
    try {
      return new URL(window.__COLLAB_PUBLIC_ORIGIN__ || window.location.origin).origin;
    } catch {
      return window.location.origin;
    }
  })();

  if (!puzzleId) {
    return;
  }

  const roomId = (() => {
    const fromQuery = new URLSearchParams(window.location.search).get("room");
    const fallback = puzzleId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
    const candidate = String(fromQuery || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return candidate || fallback || "shared";
  })();

  const clientIdKey = `collab-client-id:${roomId}`;
  const nameKey = "collab-display-name";
  const dockPositionKey = `collab-dock-position:${puzzleId}`;
  const immediateBroadcastDelayMs = 45;
  const fallbackBroadcastDelayMs = 120;
  const syncMonitorIntervalMs = 250;
  const snapshotPollIntervalMs = 500;

  const state = {
    roomId,
    puzzleId,
    clientId: sessionStorage.getItem(clientIdKey) || `${Math.random().toString(36).slice(2, 10)}`,
    name: localStorage.getItem(nameKey) || `Solver ${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
    eventSource: null,
    live: false,
    ready: false,
    applyingRemote: false,
    queuedSnapshot: null,
    latestRevision: 0,
    lastSentHash: "",
    inFlightHash: "",
    broadcastTimer: null,
    presenceTimer: null,
    reconnectTimer: null,
    healthTimer: null,
    syncTimer: null,
    snapshotTimer: null,
    reconnectAttempts: 0,
    lastStreamEventAt: 0,
    lastLiveAt: 0,
    lastAppliedHash: "",
    syncRequestInFlight: false,
    pollHealthy: false,
    dragPointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    destroyed: false
  };

  sessionStorage.setItem(clientIdKey, state.clientId);

  const ui = createUi();
  const inviteLink = `${publicOrigin}/${encodeURIComponent(puzzleId)}?room=${encodeURIComponent(roomId)}`;

  setStatus("Connecting", "offline");
  setMeta(inviteLink);
  ui.nameInput.value = state.name;
  restoreDockPosition();

  ui.copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(inviteLink);
    ui.copyButton.textContent = "Copied";
    window.setTimeout(() => {
      ui.copyButton.textContent = "Copy invite";
    }, 1200);
  });

  ui.shareButton.addEventListener("click", () => {
    window.location.href = inviteLink;
  });

  ui.toggleButton.addEventListener("click", () => {
    const minimized = ui.dock.classList.toggle("collab-dock--minimized");
    ui.toggleButton.textContent = minimized ? "+" : "-";
    ui.toggleButton.setAttribute("aria-label", minimized ? "Expand live collaboration panel" : "Minimize live collaboration panel");
    ui.toggleButton.title = minimized ? "Expand" : "Minimize";
  });
  ui.head.addEventListener("pointerdown", beginDockDrag);

  ui.nameInput.addEventListener("change", () => {
    state.name = ui.nameInput.value.trim() || state.name;
    localStorage.setItem(nameKey, state.name);
    ui.nameInput.value = state.name;
    sendPresence();
  });

  waitForSudokuPad()
    .then(() => {
      state.ready = true;
      state.lastAppliedHash = getReplayHash(getReplayPayload());
      state.lastSentHash = state.lastAppliedHash;
      patchActionBroadcasting();
      patchProgressSaving();
      startRealtime();
      state.presenceTimer = window.setInterval(sendPresence, 20_000);
    })
    .catch((error) => {
      console.error("Collaboration bootstrap failed:", error);
      setStatus("SudokuPad failed to load", "offline");
    });

  window.addEventListener("beforeunload", () => {
    state.destroyed = true;
    if (state.presenceTimer) {
      window.clearInterval(state.presenceTimer);
    }
    if (state.healthTimer) {
      window.clearInterval(state.healthTimer);
    }
    if (state.syncTimer) {
      window.clearInterval(state.syncTimer);
    }
    if (state.snapshotTimer) {
      window.clearInterval(state.snapshotTimer);
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
    }
    if (state.eventSource) {
      state.eventSource.close();
    }
    endDockDrag();
  });

  function createUi() {
    const dock = document.createElement("aside");
    dock.className = "collab-dock";
    dock.innerHTML = `
      <div class="collab-dock__head">
        <div class="collab-dock__head-main">
          <div class="collab-dock__title">Live Collaboration</div>
          <div class="collab-dock__status" data-state="offline">Connecting</div>
        </div>
        <button class="collab-dock__toggle" type="button" aria-label="Minimize live collaboration panel" title="Minimize">-</button>
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
      </div>
    `;
    document.body.appendChild(dock);

    return {
      dock,
      head: dock.querySelector(".collab-dock__head"),
      status: dock.querySelector(".collab-dock__status"),
      toggleButton: dock.querySelector(".collab-dock__toggle"),
      nameInput: dock.querySelector(".collab-dock__input"),
      meta: dock.querySelector(".collab-dock__meta"),
      copyButton: dock.querySelector(".collab-dock__button--primary"),
      shareButton: dock.querySelector(".collab-dock__button--secondary"),
      peers: dock.querySelector(".collab-dock__peers")
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

  function clampDockPosition(left, top) {
    const rect = ui.dock.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);

    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  function applyDockPosition(left, top) {
    const next = clampDockPosition(left, top);
    ui.dock.style.left = `${next.left}px`;
    ui.dock.style.top = `${next.top}px`;
    ui.dock.style.right = "auto";
    ui.dock.style.bottom = "auto";
  }

  function persistDockPosition() {
    localStorage.setItem(dockPositionKey, JSON.stringify({
      left: ui.dock.style.left,
      top: ui.dock.style.top
    }));
  }

  function restoreDockPosition() {
    const raw = localStorage.getItem(dockPositionKey);
    if (!raw) {
      return;
    }

    try {
      const saved = JSON.parse(raw);
      const left = Number.parseFloat(saved.left);
      const top = Number.parseFloat(saved.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        applyDockPosition(left, top);
      }
    } catch {
      localStorage.removeItem(dockPositionKey);
    }
  }

  function moveDockWithPointer(clientX, clientY) {
    applyDockPosition(clientX - state.dragOffsetX, clientY - state.dragOffsetY);
  }

  function onDockDragMove(event) {
    if (event.pointerId !== state.dragPointerId) {
      return;
    }

    event.preventDefault();
    moveDockWithPointer(event.clientX, event.clientY);
  }

  function endDockDrag(event) {
    if (event && event.pointerId !== state.dragPointerId) {
      return;
    }

    if (state.dragPointerId === null) {
      return;
    }

    state.dragPointerId = null;
    ui.dock.classList.remove("collab-dock--dragging");
    window.removeEventListener("pointermove", onDockDragMove);
    window.removeEventListener("pointerup", endDockDrag);
    window.removeEventListener("pointercancel", endDockDrag);
    persistDockPosition();
  }

  function beginDockDrag(event) {
    if (event.button !== 0) {
      return;
    }

    if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, label")) {
      return;
    }

    const rect = ui.dock.getBoundingClientRect();
    state.dragPointerId = event.pointerId;
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    ui.dock.classList.add("collab-dock--dragging");

    window.addEventListener("pointermove", onDockDragMove);
    window.addEventListener("pointerup", endDockDrag);
    window.addEventListener("pointercancel", endDockDrag);
  }

  function refreshConnectionStatus() {
    if (state.applyingRemote) {
      return;
    }

    if (state.live || state.pollHealthy) {
      setStatus("Live", "live");
      return;
    }

    if (state.ready) {
      setStatus("Reconnecting", "offline");
    }
  }

  function renderPresence(payload) {
    const peers = Array.isArray(payload?.peers) ? payload.peers : [];
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

  function scheduleBroadcast(delayMs = immediateBroadcastDelayMs) {
    window.clearTimeout(state.broadcastTimer);
    state.broadcastTimer = window.setTimeout(pushLocalReplay, delayMs);
  }

  function markStreamActivity() {
    state.lastStreamEventAt = Date.now();
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function closeEventSource() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function scheduleReconnect(reason = "Reconnecting") {
    if (state.destroyed) {
      return;
    }

    closeEventSource();
    clearReconnectTimer();
    state.live = false;
    state.reconnectAttempts += 1;
    if (!state.pollHealthy) {
      setStatus(reason, "offline");
    }

    const delayMs = Math.min(10_000, 1_000 * Math.pow(1.6, Math.max(0, state.reconnectAttempts - 1)));
    state.reconnectTimer = window.setTimeout(() => {
      connectStream();
    }, delayMs);
  }

  function ensureHealthMonitor() {
    if (state.healthTimer) {
      return;
    }

    state.healthTimer = window.setInterval(() => {
      if (state.destroyed || !state.ready) {
        return;
      }

      const silenceMs = Date.now() - state.lastStreamEventAt;
      if (state.live && silenceMs > 35_000) {
        scheduleReconnect("Reconnecting");
        fetchInitialSnapshot().catch(() => {});
      } else if (!state.live && !state.reconnectTimer) {
        connectStream();
      }
    }, 10_000);
  }

  function ensureSyncMonitor() {
    if (state.syncTimer) {
      return;
    }

    state.syncTimer = window.setInterval(() => {
      if (state.destroyed || !state.ready || state.applyingRemote) {
        return;
      }

      const replay = getReplayPayload();
      const hash = getReplayHash(replay);
      if (hash !== state.lastSentHash && hash !== state.inFlightHash) {
        scheduleBroadcast(fallbackBroadcastDelayMs);
      }
    }, syncMonitorIntervalMs);
  }

  function ensureSnapshotPolling() {
    if (state.snapshotTimer) {
      return;
    }

    state.snapshotTimer = window.setInterval(() => {
      if (state.destroyed || !state.ready) {
        return;
      }

      fetchLatestSnapshot({ silent: true }).catch(() => {});
    }, snapshotPollIntervalMs);
  }

  function startRealtime() {
    ensureHealthMonitor();
    ensureSyncMonitor();
    ensureSnapshotPolling();
    connectStream();
    sendPresence();
  }

  async function pushLocalReplay() {
    if (!state.ready || state.applyingRemote) {
      return;
    }

    try {
      const replay = getReplayPayload();
      const hash = getReplayHash(replay);

      if (hash === state.lastSentHash || hash === state.inFlightHash) {
        return;
      }

      state.inFlightHash = hash;

      const response = await fetch(`/api/collab/update/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          name: state.name,
          puzzleId: state.puzzleId,
          baseRevision: state.latestRevision,
          replay
        })
      });

      if (!response.ok) {
        throw new Error(`Sync failed with ${response.status}`);
      }

      const payload = await response.json();
      state.lastSentHash = hash;
      state.lastAppliedHash = hash;
      state.latestRevision = Math.max(state.latestRevision, Number(payload.revision) || 0);
      state.pollHealthy = true;
      refreshConnectionStatus();
    } catch (error) {
      console.error("Local replay push failed:", error);
      scheduleReconnect("Reconnecting");
    } finally {
      const completedHash = state.inFlightHash;
      state.inFlightHash = "";
      if (completedHash) {
        const currentHash = getReplayHash(getReplayPayload());
        if (currentHash !== state.lastSentHash) {
          scheduleBroadcast();
        }
      }
    }
  }

  async function sendPresence() {
    try {
      const response = await fetch(`/api/collab/presence/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          name: state.name
        })
      });

      if (response.ok) {
        const payload = await response.json();
        renderPresence(payload);
      }
    } catch (error) {
      console.error("Presence update failed:", error);
    }
  }

  async function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.replay || snapshot.revision <= state.latestRevision) {
      return;
    }

    state.latestRevision = snapshot.revision;

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
      state.pollHealthy = true;
      if (!hasUnsyncedLocalChanges) {
        state.lastAppliedHash = snapshotHash;
        state.lastSentHash = snapshotHash;
      }
      refreshConnectionStatus();
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

      state.pollHealthy = true;
      if (hasUnsyncedLocalChanges) {
        state.lastAppliedHash = snapshotHash;
      } else {
        state.lastAppliedHash = nextHash;
        state.lastSentHash = nextHash;
      }
      refreshConnectionStatus();
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

  async function fetchInitialSnapshot() {
    const response = await fetch(`/api/collab/sync/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`);
    if (!response.ok) {
      throw new Error(`Initial sync failed with ${response.status}`);
    }

    const payload = await response.json();
    markStreamActivity();
    renderPresence(payload.presence);
    state.pollHealthy = true;

    if (payload.snapshot) {
      await applySnapshot(payload.snapshot);
    } else if ((getFramework().app.puzzle.replayStack || []).length > 1) {
      scheduleBroadcast();
    } else {
      state.lastAppliedHash = getReplayHash(getReplayPayload());
      state.lastSentHash = state.lastAppliedHash;
      refreshConnectionStatus();
    }
  }

  async function fetchLatestSnapshot({ silent = false } = {}) {
    if (state.syncRequestInFlight) {
      return;
    }

    state.syncRequestInFlight = true;

    try {
      const response = await fetch(`/api/collab/sync/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`, {
        headers: {
          "cache-control": "no-store"
        }
      });

      if (!response.ok) {
        throw new Error(`Snapshot poll failed with ${response.status}`);
      }

      const payload = await response.json();
      markStreamActivity();
      renderPresence(payload.presence);
      state.pollHealthy = true;

      if (payload.snapshot) {
        await applySnapshot(payload.snapshot);
      } else {
        refreshConnectionStatus();
      }
    } catch (error) {
      state.pollHealthy = false;
      refreshConnectionStatus();
      if (!silent) {
        throw error;
      }
    } finally {
      state.syncRequestInFlight = false;
    }
  }

  function connectStream() {
    if (state.destroyed) {
      return;
    }

    closeEventSource();
    clearReconnectTimer();
    const source = new EventSource(`/api/collab/stream/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`);
    state.eventSource = source;

    source.addEventListener("open", () => {
      if (state.eventSource !== source) {
        return;
      }
      state.live = true;
      state.reconnectAttempts = 0;
      state.lastLiveAt = Date.now();
      markStreamActivity();
      refreshConnectionStatus();
      sendPresence();
      fetchInitialSnapshot().catch((error) => {
        console.error("Initial snapshot fetch failed:", error);
        scheduleReconnect("Initial sync failed");
      });
    });

    source.addEventListener("error", () => {
      if (state.eventSource !== source || state.destroyed) {
        return;
      }
      state.live = false;
      scheduleReconnect("Reconnecting");
    });

    source.addEventListener("presence", (event) => {
      try {
        markStreamActivity();
        renderPresence(JSON.parse(event.data));
      } catch (error) {
        console.error("Presence parse failed:", error);
      }
    });

    source.addEventListener("snapshot", (event) => {
      try {
        markStreamActivity();
        const snapshot = JSON.parse(event.data);
        applySnapshot(snapshot);
      } catch (error) {
        console.error("Snapshot parse failed:", error);
      }
    });
  }

  function patchProgressSaving() {
    const puzzle = getFramework().app.puzzle;

    if (puzzle.__collabPatched) {
      return;
    }

    const original = puzzle.saveProgress.bind(puzzle);
    puzzle.saveProgress = (...args) => {
      const result = original(...args);
      if (!state.applyingRemote) {
        scheduleBroadcast();
      }
      return result;
    };
    puzzle.__collabPatched = true;
  }

  function patchActionBroadcasting() {
    const puzzle = getFramework().app.puzzle;

    if (puzzle.__collabActPatched) {
      return;
    }

    const original = puzzle.act.bind(puzzle);
    puzzle.act = (...args) => {
      const result = original(...args);
      if (!state.applyingRemote) {
        scheduleBroadcast();
      }
      return result;
    };
    puzzle.__collabActPatched = true;
  }
})();
