(() => {
  const pathMatch = window.location.pathname.match(/^\/(?:sudoku\/)?([^/?#]+)/i);
  const puzzleId = pathMatch ? decodeURIComponent(pathMatch[1]) : "";

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
    broadcastTimer: null,
    pendingApply: false,
    presenceTimer: null
  };

  sessionStorage.setItem(clientIdKey, state.clientId);

  const ui = createUi();
  const inviteLink = `${window.location.origin}/${encodeURIComponent(puzzleId)}?room=${encodeURIComponent(roomId)}`;

  setStatus("Connecting", "offline");
  setMeta(inviteLink);
  ui.nameInput.value = state.name;

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

  ui.nameInput.addEventListener("change", () => {
    state.name = ui.nameInput.value.trim() || state.name;
    localStorage.setItem(nameKey, state.name);
    ui.nameInput.value = state.name;
    sendPresence();
  });

  waitForSudokuPad()
    .then(() => {
      state.ready = true;
      patchProgressSaving();
      connectStream();
      sendPresence();
      state.presenceTimer = window.setInterval(sendPresence, 20_000);
    })
    .catch((error) => {
      console.error("Collaboration bootstrap failed:", error);
      setStatus("SudokuPad failed to load", "offline");
    });

  window.addEventListener("beforeunload", () => {
    if (state.presenceTimer) {
      window.clearInterval(state.presenceTimer);
    }
    if (state.eventSource) {
      state.eventSource.close();
    }
  });

  function createUi() {
    const dock = document.createElement("aside");
    dock.className = "collab-dock";
    dock.innerHTML = `
      <div class="collab-dock__head">
        <div class="collab-dock__title">Live Collaboration</div>
        <div class="collab-dock__status" data-state="offline">Connecting</div>
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
      status: dock.querySelector(".collab-dock__status"),
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
    const replay = replayApi.fixReplay(replayApi.decode(framework.app.getReplay({ noStates: true })));
    return replay;
  }

  function scheduleBroadcast() {
    window.clearTimeout(state.broadcastTimer);
    state.broadcastTimer = window.setTimeout(pushLocalReplay, 180);
  }

  async function pushLocalReplay() {
    if (!state.ready || state.applyingRemote) {
      return;
    }

    try {
      const replay = getReplayPayload();
      const hash = JSON.stringify(replay);

      if (hash === state.lastSentHash) {
        return;
      }

      state.lastSentHash = hash;

      const response = await fetch(`/api/collab/update/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          name: state.name,
          puzzleId: state.puzzleId,
          replay
        })
      });

      if (!response.ok) {
        throw new Error(`Sync failed with ${response.status}`);
      }
    } catch (error) {
      console.error("Local replay push failed:", error);
      setStatus("Reconnecting", "offline");
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

    if (replayApi.compare(currentReplay, snapshot.replay)) {
      state.lastSentHash = JSON.stringify(snapshot.replay);
      setStatus("Live", "live");
      return;
    }

    state.applyingRemote = true;
    setStatus(`Syncing from ${snapshot.name || "room"}`, "live");

    try {
      await framework.app.loadReplay(snapshot.replay, { speed: -1 });
      const replayLength = puzzleApi.replayLength(snapshot.replay);

      if (!Number.isNaN(replayLength)) {
        framework.app.timer.setStartTime(Date.now() - replayLength);
      }

      state.lastSentHash = JSON.stringify(snapshot.replay);
      setStatus("Live", "live");
    } catch (error) {
      console.error("Remote replay apply failed:", error);
      setStatus("Sync error", "offline");
    } finally {
      state.applyingRemote = false;

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
    renderPresence(payload.presence);

    if (payload.snapshot) {
      await applySnapshot(payload.snapshot);
    } else if ((getFramework().app.puzzle.replayStack || []).length > 1) {
      scheduleBroadcast();
    } else {
      setStatus("Live", "live");
    }
  }

  function connectStream() {
    const source = new EventSource(`/api/collab/stream/${encodeURIComponent(state.roomId)}?clientId=${encodeURIComponent(state.clientId)}`);
    state.eventSource = source;

    source.addEventListener("open", () => {
      state.live = true;
      setStatus("Live", "live");
      sendPresence();
      fetchInitialSnapshot().catch((error) => {
        console.error("Initial snapshot fetch failed:", error);
        setStatus("Initial sync failed", "offline");
      });
    });

    source.addEventListener("error", () => {
      state.live = false;
      setStatus("Offline", "offline");
    });

    source.addEventListener("presence", (event) => {
      try {
        renderPresence(JSON.parse(event.data));
      } catch (error) {
        console.error("Presence parse failed:", error);
      }
    });

    source.addEventListener("snapshot", (event) => {
      try {
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
})();
