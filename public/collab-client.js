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
  const fallbackIceServers = Array.isArray(window.__COLLAB_ICE_SERVERS__) && window.__COLLAB_ICE_SERVERS__.length > 0
    ? window.__COLLAB_ICE_SERVERS__
    : [{ urls: ["stun:stun.l.google.com:19302"] }];

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
  const mediaPanelPositionKey = `collab-media-panel-position:${puzzleId}`;
  const mediaPanelMinimizedKey = `collab-media-panel-minimized:${puzzleId}`;
  const mediaOrderKey = `collab-media-order:${roomId}`;
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
    mediaMeshTimer: null,
    reconnectAttempts: 0,
    lastStreamEventAt: 0,
    lastLiveAt: 0,
    lastAppliedHash: "",
    syncRequestInFlight: false,
    pollHealthy: false,
    peers: [],
    control: {
      hostClientId: null,
      controllerClientId: null,
      freeForAll: false,
      accessRequests: []
    },
    lastHighlightAt: 0,
    remoteHighlights: new Map(),
    localStream: null,
    mediaEnabled: false,
    mediaBusy: false,
    micEnabled: true,
    cameraEnabled: true,
    iceServers: fallbackIceServers,
    iceServersFetchedAt: 0,
    peerConnections: new Map(),
    remoteTiles: new Map(),
    remoteOrder: (() => {
      try {
        const parsed = JSON.parse(localStorage.getItem(mediaOrderKey) || "[]");
        return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
      } catch {
        return [];
      }
    })(),
    lastMediaRepairAt: new Map(),
    draggedRemotePeerId: null,
    dragPointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    mediaDragPointerId: null,
    mediaDragOffsetX: 0,
    mediaDragOffsetY: 0,
    destroyed: false
  };

  sessionStorage.setItem(clientIdKey, state.clientId);

  const ui = createUi();
  const inviteLink = `${publicOrigin}/${encodeURIComponent(puzzleId)}?room=${encodeURIComponent(roomId)}`;

  setStatus("Connecting", "offline");
  setMeta(inviteLink);
  ui.nameInput.value = state.name;
  restoreDockPosition();
  restoreMediaPanelPosition();
  setMediaPanelMinimized(localStorage.getItem(mediaPanelMinimizedKey) === "1");
  renderRoomControl();
  updateMediaControls();
  window.addEventListener("resize", renderRemoteHighlights);
  window.addEventListener("scroll", renderRemoteHighlights, true);

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
  ui.mediaPanelHead.addEventListener("pointerdown", beginMediaPanelDrag);
  ui.mediaPanelToggle.addEventListener("click", () => {
    const minimized = !ui.mediaPanel.classList.contains("collab-media-panel--minimized");
    setMediaPanelMinimized(minimized);
  });
  ui.remoteMedia.addEventListener("dragover", handleRemoteGridDragOver);
  ui.remoteMedia.addEventListener("drop", handleRemoteGridDrop);

  ui.nameInput.addEventListener("change", () => {
    state.name = ui.nameInput.value.trim() || state.name;
    localStorage.setItem(nameKey, state.name);
    ui.nameInput.value = state.name;
    sendPresence();
  });
  ui.joinMediaButton.addEventListener("click", joinMediaSession);
  ui.micButton.addEventListener("click", toggleMicrophone);
  ui.cameraButton.addEventListener("click", toggleCamera);
  ui.leaveMediaButton.addEventListener("click", leaveMediaSession);
  ui.requestControlButton.addEventListener("click", () => {
    submitRoomControl({ action: "request" }, ui.requestControlButton);
  });
  ui.freeForAllButton.addEventListener("click", () => {
    submitRoomControl({
      action: "set-free-for-all",
      enabled: !state.control.freeForAll
    }, ui.freeForAllButton);
  });
  ui.requestList.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-grant-client-id]") : null;
    if (!button) {
      return;
    }

    submitRoomControl({
      action: "grant",
      targetClientId: button.getAttribute("data-grant-client-id")
    }, button);
  });
  window.addEventListener("keydown", handleReadOnlyKeydown, true);

  waitForSudokuPad()
    .then(() => {
      state.ready = true;
      state.lastAppliedHash = getReplayHash(getReplayPayload());
      state.lastSentHash = state.lastAppliedHash;
      patchActionBroadcasting();
      patchProgressSaving();
      registerRoom().catch((error) => {
        console.error("Room registration failed:", error);
      });
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
    if (state.mediaMeshTimer) {
      window.clearInterval(state.mediaMeshTimer);
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
    }
    if (state.eventSource) {
      state.eventSource.close();
    }
    leaveMediaSession({ silent: true });
    endDockDrag();
    endMediaPanelDrag();
    window.removeEventListener("keydown", handleReadOnlyKeydown, true);
    window.removeEventListener("resize", renderRemoteHighlights);
    window.removeEventListener("scroll", renderRemoteHighlights, true);
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
        <div class="collab-dock__label">
          Edit control
          <div class="collab-dock__control-summary"></div>
          <div class="collab-dock__actions collab-dock__actions--control">
            <button class="collab-dock__button collab-dock__button--secondary" type="button">Request control</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button">Enable free-for-all</button>
          </div>
          <div class="collab-dock__requests"></div>
        </div>
        <div class="collab-dock__label">
          Camera and audio
          <div class="collab-dock__media-status">Off</div>
          <div class="collab-dock__actions collab-dock__actions--media">
            <button class="collab-dock__button collab-dock__button--primary" type="button">Join AV</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Mic on</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Cam on</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Leave</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dock);

    const mediaPanel = document.createElement("section");
    mediaPanel.className = "collab-media-panel";
    mediaPanel.innerHTML = `
      <div class="collab-media-panel__head">
        <div class="collab-media-panel__title">Camera Feeds</div>
        <button class="collab-media-panel__toggle" type="button" aria-label="Minimize camera feeds panel" title="Minimize">-</button>
      </div>
      <div class="collab-media-panel__body">
        <div class="collab-media-panel__grid">
        <div class="collab-media-panel__card collab-media-panel__card--local collab-media-panel__card--hidden">
          <video class="collab-media-panel__video collab-media-panel__video--local" autoplay muted playsinline></video>
          <div class="collab-media-panel__label">You</div>
        </div>
        <div class="collab-media-panel__remote-grid"></div>
        </div>
      </div>
    `;
    document.body.appendChild(mediaPanel);

    const readOnlyOverlay = document.createElement("div");
    readOnlyOverlay.className = "collab-readonly";
    readOnlyOverlay.hidden = true;
    readOnlyOverlay.innerHTML = `
      <div class="collab-readonly__card">
        <div class="collab-readonly__title">Room control is active</div>
        <div class="collab-readonly__message">Waiting for the controller…</div>
      </div>
    `;
    document.body.appendChild(readOnlyOverlay);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "collab-highlight-layer";
    document.body.appendChild(highlightLayer);

    const inviteActions = dock.querySelectorAll(".collab-dock__actions")[0];
    const controlActions = dock.querySelector(".collab-dock__actions--control");
    const mediaActions = dock.querySelector(".collab-dock__actions--media");

    return {
      dock,
      head: dock.querySelector(".collab-dock__head"),
      status: dock.querySelector(".collab-dock__status"),
      toggleButton: dock.querySelector(".collab-dock__toggle"),
      nameInput: dock.querySelector(".collab-dock__input"),
      meta: dock.querySelector(".collab-dock__meta"),
      copyButton: inviteActions.querySelector(".collab-dock__button--primary"),
      shareButton: inviteActions.querySelector(".collab-dock__button--secondary"),
      peers: dock.querySelector(".collab-dock__peers"),
      controlSummary: dock.querySelector(".collab-dock__control-summary"),
      requestControlButton: controlActions.querySelectorAll(".collab-dock__button--secondary")[0],
      freeForAllButton: controlActions.querySelectorAll(".collab-dock__button--secondary")[1],
      requestList: dock.querySelector(".collab-dock__requests"),
      mediaStatus: dock.querySelector(".collab-dock__media-status"),
      joinMediaButton: mediaActions.querySelector(".collab-dock__button--primary"),
      micButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[0],
      cameraButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[1],
      leaveMediaButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[2],
      mediaPanel,
      mediaPanelHead: mediaPanel.querySelector(".collab-media-panel__head"),
      mediaPanelToggle: mediaPanel.querySelector(".collab-media-panel__toggle"),
      localVideoCard: mediaPanel.querySelector(".collab-media-panel__card--local"),
      localVideo: mediaPanel.querySelector(".collab-media-panel__video--local"),
      remoteMedia: mediaPanel.querySelector(".collab-media-panel__remote-grid"),
      readOnlyOverlay,
      readOnlyMessage: readOnlyOverlay.querySelector(".collab-readonly__message"),
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

  function persistMediaPanelPosition() {
    localStorage.setItem(mediaPanelPositionKey, JSON.stringify({
      left: ui.mediaPanel.style.left,
      top: ui.mediaPanel.style.top
    }));
  }

  function persistRemoteOrder() {
    localStorage.setItem(mediaOrderKey, JSON.stringify(state.remoteOrder));
  }

  function setMediaPanelMinimized(minimized) {
    ui.mediaPanel.classList.toggle("collab-media-panel--minimized", minimized);
    ui.mediaPanelToggle.textContent = minimized ? "+" : "-";
    ui.mediaPanelToggle.setAttribute("aria-label", minimized ? "Expand camera feeds panel" : "Minimize camera feeds panel");
    ui.mediaPanelToggle.title = minimized ? "Expand" : "Minimize";
    localStorage.setItem(mediaPanelMinimizedKey, minimized ? "1" : "0");
  }

  function restoreMediaPanelPosition() {
    const raw = localStorage.getItem(mediaPanelPositionKey);
    if (!raw) {
      return;
    }

    try {
      const saved = JSON.parse(raw);
      const left = Number.parseFloat(saved.left);
      const top = Number.parseFloat(saved.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        ui.mediaPanel.style.left = `${left}px`;
        ui.mediaPanel.style.top = `${top}px`;
        ui.mediaPanel.style.right = "auto";
        ui.mediaPanel.style.bottom = "auto";
      }
    } catch {
      localStorage.removeItem(mediaPanelPositionKey);
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

  function clampMediaPanelPosition(left, top) {
    const rect = ui.mediaPanel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);

    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  function applyMediaPanelPosition(left, top) {
    const next = clampMediaPanelPosition(left, top);
    ui.mediaPanel.style.left = `${next.left}px`;
    ui.mediaPanel.style.top = `${next.top}px`;
    ui.mediaPanel.style.right = "auto";
    ui.mediaPanel.style.bottom = "auto";
  }

  function moveMediaPanelWithPointer(clientX, clientY) {
    applyMediaPanelPosition(clientX - state.mediaDragOffsetX, clientY - state.mediaDragOffsetY);
  }

  function onMediaPanelDragMove(event) {
    if (event.pointerId !== state.mediaDragPointerId) {
      return;
    }

    event.preventDefault();
    moveMediaPanelWithPointer(event.clientX, event.clientY);
  }

  function endMediaPanelDrag(event) {
    if (event && event.pointerId !== state.mediaDragPointerId) {
      return;
    }

    if (state.mediaDragPointerId === null) {
      return;
    }

    state.mediaDragPointerId = null;
    ui.mediaPanel.classList.remove("collab-media-panel--dragging");
    window.removeEventListener("pointermove", onMediaPanelDragMove);
    window.removeEventListener("pointerup", endMediaPanelDrag);
    window.removeEventListener("pointercancel", endMediaPanelDrag);
    persistMediaPanelPosition();
  }

  function beginMediaPanelDrag(event) {
    if (event.button !== 0) {
      return;
    }

    if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, label, video")) {
      return;
    }

    const rect = ui.mediaPanel.getBoundingClientRect();
    state.mediaDragPointerId = event.pointerId;
    state.mediaDragOffsetX = event.clientX - rect.left;
    state.mediaDragOffsetY = event.clientY - rect.top;
    ui.mediaPanel.classList.add("collab-media-panel--dragging");

    window.addEventListener("pointermove", onMediaPanelDragMove);
    window.addEventListener("pointerup", endMediaPanelDrag);
    window.addEventListener("pointercancel", endMediaPanelDrag);
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

  function normalizeControl(control) {
    return {
      hostClientId: typeof control?.hostClientId === "string" ? control.hostClientId : null,
      controllerClientId: typeof control?.controllerClientId === "string" ? control.controllerClientId : null,
      freeForAll: control?.freeForAll === true,
      accessRequests: Array.isArray(control?.accessRequests)
        ? control.accessRequests
          .map((entry) => typeof entry?.clientId === "string"
            ? {
              clientId: entry.clientId,
              name: typeof entry?.name === "string" && entry.name.trim()
                ? entry.name.trim()
                : `Solver ${entry.clientId.slice(0, 4)}`
            }
            : null)
          .filter(Boolean)
        : []
    };
  }

  function getPeerName(clientId) {
    if (!clientId) {
      return "Nobody";
    }

    const peer = state.peers.find((candidate) => candidate.clientId === clientId);
    if (peer?.name) {
      return peer.name;
    }

    const request = state.control.accessRequests.find((candidate) => candidate.clientId === clientId);
    if (request?.name) {
      return request.name;
    }

    return `Solver ${clientId.slice(0, 4)}`;
  }

  function isCurrentController() {
    return Boolean(state.control.controllerClientId) && state.control.controllerClientId === state.clientId;
  }

  function hasRequestedControl() {
    return state.control.accessRequests.some((request) => request.clientId === state.clientId);
  }

  function canEditBoard() {
    if (state.control.freeForAll) {
      return true;
    }

    return isCurrentController();
  }

  function renderRoomControl() {
    const controllerName = getPeerName(state.control.controllerClientId);
    const hostName = getPeerName(state.control.hostClientId);

    if (!state.control.controllerClientId) {
      ui.controlSummary.textContent = "Checking who controls the board…";
    } else if (state.control.freeForAll) {
      ui.controlSummary.textContent = isCurrentController()
        ? "Free-for-all is on. Everyone can place digits, marks, and lines."
        : `Free-for-all is on. ${controllerName} can switch it off again.`;
    } else if (isCurrentController()) {
      ui.controlSummary.textContent = state.control.hostClientId === state.clientId
        ? "You are controlling the board as the host."
        : `You are controlling the board. Host: ${hostName}.`;
    } else {
      ui.controlSummary.textContent = `${controllerName} is controlling the board. Host: ${hostName}.`;
    }

    const requestPending = hasRequestedControl();
    ui.requestControlButton.hidden = state.control.freeForAll || isCurrentController();
    ui.requestControlButton.disabled = requestPending || !state.control.controllerClientId;
    ui.requestControlButton.textContent = requestPending ? "Request sent" : "Request control";

    ui.freeForAllButton.hidden = !isCurrentController();
    ui.freeForAllButton.disabled = !isCurrentController();
    ui.freeForAllButton.textContent = state.control.freeForAll ? "Disable free-for-all" : "Enable free-for-all";

    ui.requestList.innerHTML = "";
    ui.requestList.hidden = !(isCurrentController() && state.control.accessRequests.length > 0);

    if (isCurrentController()) {
      state.control.accessRequests.forEach((request) => {
        const row = document.createElement("div");
        row.className = "collab-dock__request";
        row.innerHTML = `
          <span class="collab-dock__request-name">${request.name}</span>
          <button class="collab-dock__request-button" type="button" data-grant-client-id="${request.clientId}" aria-label="Grant control to ${request.name}">Grant ${request.name}</button>
        `;
        ui.requestList.appendChild(row);
      });
    }

    ui.readOnlyOverlay.hidden = canEditBoard();
    ui.readOnlyMessage.textContent = !state.control.controllerClientId
      ? "Checking who controls the board for this room."
      : state.control.freeForAll
        ? "Free-for-all is on."
        : requestPending
          ? `${controllerName} controls the board right now. Your request is waiting for approval.`
          : `${controllerName} controls the board right now. Use Request control if you want to place numbers.`;
  }

  function applyControlState(control) {
    state.control = normalizeControl(control);
    renderRoomControl();
  }

  function renderPresence(payload) {
    const peers = Array.isArray(payload?.peers) ? payload.peers : [];
    state.peers = peers;
    applyControlState(payload?.control);
    ui.peers.innerHTML = "";

    if (peers.length === 0) {
      const pill = document.createElement("span");
      pill.className = "collab-dock__peer";
      pill.textContent = "Just you";
      ui.peers.appendChild(pill);
    } else {
      peers.forEach((peer) => {
        const pill = document.createElement("span");
        pill.className = "collab-dock__peer";
        pill.textContent = peer.clientId === state.clientId ? `${peer.name} (you)` : peer.name;
        ui.peers.appendChild(pill);
      });
    }

    for (const peerId of [...state.peerConnections.keys()]) {
      if (!peers.some((peer) => peer.clientId === peerId)) {
        closePeerConnection(peerId);
      }
    }

    if (state.localStream) {
      peers.forEach((peer) => {
        if (peer.clientId === state.clientId || peer.mediaEnabled !== true) {
          return;
        }

        const entry = state.peerConnections.get(peer.clientId);
        const hasLiveRemoteTracks = Boolean(entry?.remoteStream?.getTracks().some((track) => track.readyState === "live"));
        const isConnected = entry ? ["connected", "completed"].includes(entry.pc.iceConnectionState) : false;

        if (!entry || (!hasLiveRemoteTracks && !isConnected)) {
          if (shouldOfferTo(peer.clientId)) {
            negotiateWithPeer(peer.clientId);
          } else {
            sendCallSignal(peer.clientId, "restart-request", {
              reason: "presence-sync"
            }).catch((error) => {
              console.error("Presence restart request failed:", error);
            });
          }
        }
      });
    }

    renderRemoteMedia();
    updateMediaControls();
  }

  async function submitRoomControl(payload, button) {
    if (button) {
      button.disabled = true;
    }

    try {
      const response = await fetch(`/api/collab/control/${encodeURIComponent(state.roomId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: state.clientId,
          ...payload
        })
      });
      const responsePayload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(responsePayload.error || `Room control update failed with ${response.status}`);
      }

      renderPresence(responsePayload);
    } catch (error) {
      console.error("Room control update failed:", error);
      alert(error.message);
    } finally {
      renderRoomControl();
    }
  }

  function requestPeerMediaSync(peerId, reason = "repair") {
    if (!peerId || peerId === state.clientId || !state.localStream) {
      return;
    }

    const peer = state.peers.find((candidate) => candidate.clientId === peerId);
    if (!peer || peer.mediaEnabled !== true) {
      return;
    }

    const lastRepairAt = state.lastMediaRepairAt.get(peerId) || 0;
    if (Date.now() - lastRepairAt < 1_500) {
      return;
    }

    state.lastMediaRepairAt.set(peerId, Date.now());

    if (shouldOfferTo(peerId)) {
      negotiateWithPeer(peerId, { reason });
      return;
    }

    sendCallSignal(peerId, "restart-request", { reason }).catch((error) => {
      console.error("Media repair request failed:", error);
    });
  }

  function handleReadOnlyKeydown(event) {
    if (state.applyingRemote || canEditBoard()) {
      return;
    }

    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.target instanceof Element && event.target.closest(".collab-dock, .collab-media-panel")) {
      return;
    }

    if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName)) {
      return;
    }

    const blockedKeys = new Set(["Backspace", "Delete", "Enter", " ", "Spacebar"]);
    if (event.key.length === 1 || blockedKeys.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
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
      marker.innerHTML = `<span class="collab-remote-highlight__label">${highlight.name || "Controller"}</span>`;
      ui.highlightLayer.appendChild(marker);
    }
  }

  function applyHighlight(highlight) {
    if (!highlight || highlight.clientId === state.clientId) {
      return;
    }

    const normalized = {
      clientId: String(highlight.clientId),
      name: String(highlight.name || "").trim() || getPeerName(highlight.clientId),
      row: Number(highlight.row),
      col: Number(highlight.col),
      rows: Math.max(1, Number(highlight.rows) || 9),
      cols: Math.max(1, Number(highlight.cols) || 9),
      updatedAt: Number(highlight.updatedAt) || Date.now()
    };

    if (!Number.isInteger(normalized.row) || !Number.isInteger(normalized.col)) {
      return;
    }

    state.lastHighlightAt = Math.max(state.lastHighlightAt, normalized.updatedAt);
    state.remoteHighlights.set(normalized.clientId, normalized);
    renderRemoteHighlights();

    window.setTimeout(() => {
      const current = state.remoteHighlights.get(normalized.clientId);
      if (current && current.updatedAt === normalized.updatedAt) {
        state.remoteHighlights.delete(normalized.clientId);
        renderRemoteHighlights();
      }
    }, 1800);
  }

  async function sendBoardHighlight(event) {
    if (!canEditBoard() || state.applyingRemote) {
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
    const row = Math.max(0, Math.min(rows - 1, Math.floor(((event.clientY - boardRect.top) / boardRect.height) * rows)));
    const col = Math.max(0, Math.min(cols - 1, Math.floor(((event.clientX - boardRect.left) / boardRect.width) * cols)));

    try {
      await fetch(`/api/collab/highlight/${encodeURIComponent(state.roomId)}`, {
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
          cols
        })
      });
    } catch (error) {
      console.error("Highlight broadcast failed:", error);
    }
  }

  function setMediaStatus(text) {
    ui.mediaStatus.textContent = text;
  }

  function supportsRealtimeMedia() {
    return Boolean(
      navigator.mediaDevices?.getUserMedia &&
      window.RTCPeerConnection
    );
  }

  async function fetchRuntimeIceServers(force = false) {
    const cacheFreshForMs = 20 * 60 * 1000;
    if (!force && state.iceServersFetchedAt && Date.now() - state.iceServersFetchedAt < cacheFreshForMs) {
      return state.iceServers;
    }

    try {
      const response = await fetch("/api/collab/ice", {
        headers: {
          "cache-control": "no-store"
        }
      });

      if (!response.ok) {
        throw new Error(`ICE lookup failed with ${response.status}`);
      }

      const payload = await response.json();
      if (Array.isArray(payload.iceServers) && payload.iceServers.length > 0) {
        state.iceServers = payload.iceServers;
        state.iceServersFetchedAt = Date.now();
      }
    } catch (error) {
      console.error("Runtime ICE fetch failed:", error);
      if (!Array.isArray(state.iceServers) || state.iceServers.length === 0) {
        state.iceServers = fallbackIceServers;
      }
    }

    return state.iceServers;
  }

  function applyIceServers(entry) {
    try {
      entry.pc.setConfiguration({
        iceServers: state.iceServers
      });
    } catch (error) {
      console.error("Applying ICE servers failed:", error);
    }
  }

  function getPeerLabel(peerId) {
    const peer = state.peers.find((candidate) => candidate.clientId === peerId);
    return peer?.clientId === state.clientId ? `${peer.name} (you)` : (peer?.name || `Solver ${peerId.slice(0, 4)}`);
  }

  function ensureVideoPlayback(video) {
    if (!video) {
      return;
    }

    const playPromise = video.play?.();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  function attachStreamToVideo(video, stream, { muted = false } = {}) {
    if (!video) {
      return;
    }

    video.muted = muted;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    ensureVideoPlayback(video);
  }

  function requestIceRecovery(peerId, reason = "restart-request") {
    const entry = state.peerConnections.get(peerId);
    if (!entry || entry.restartInFlight) {
      return;
    }

    entry.restartInFlight = true;
    if (shouldOfferTo(peerId)) {
      fetchRuntimeIceServers(true).then(() => {
        applyIceServers(entry);
        return negotiateWithPeer(peerId, { iceRestart: true });
      }).catch((error) => {
        console.error("ICE restart failed:", error);
        entry.restartInFlight = false;
      });
      return;
    }

    sendCallSignal(peerId, "restart-request", { reason }).catch((error) => {
      console.error("ICE restart request failed:", error);
      entry.restartInFlight = false;
    });
  }

  function bindRemoteTrack(track) {
    if (!track || track.__collabBound) {
      return;
    }

    track.__collabBound = true;
    track.onunmute = () => {
      renderRemoteMedia();
      updateMediaControls();
    };
    track.onended = () => {
      renderRemoteMedia();
      updateMediaControls();
    };
  }

  function refreshRemoteStream(entry) {
    if (!entry?.remoteStream || !entry?.pc) {
      return;
    }

    const receiverTracks = entry.pc.getReceivers()
      .map((receiver) => receiver.track)
      .filter((track) => Boolean(track) && track.readyState === "live");
    const preferredTracks = new Map();

    receiverTracks.forEach((track) => {
      if (!preferredTracks.has(track.kind)) {
        preferredTracks.set(track.kind, track);
      }
    });

    const activeTracks = [...preferredTracks.values()];
    const activeTrackIds = new Set(activeTracks.map((track) => track.id));

    entry.remoteStream.getTracks().forEach((track) => {
      if (!activeTrackIds.has(track.id) || track.readyState === "ended") {
        entry.remoteStream.removeTrack(track);
      }
    });

    activeTracks.forEach((track) => {
      bindRemoteTrack(track);
      if (!entry.remoteStream.getTracks().some((candidate) => candidate.id === track.id)) {
        entry.remoteStream.addTrack(track);
      }
    });
  }

  function ensureRemoteTile(peerId) {
    let tile = state.remoteTiles.get(peerId);
    if (tile) {
      return tile;
    }

    const card = document.createElement("div");
    card.className = "collab-media-panel__card";
    card.dataset.peerId = peerId;
    card.draggable = true;
    card.addEventListener("dragstart", handleRemoteTileDragStart);
    card.addEventListener("dragend", handleRemoteTileDragEnd);
    card.addEventListener("dragover", handleRemoteTileDragOver);
    card.addEventListener("dragleave", handleRemoteTileDragLeave);
    card.addEventListener("drop", handleRemoteTileDrop);

    const video = document.createElement("video");
    video.className = "collab-media-panel__video";
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      ensureVideoPlayback(video);
    });
    video.addEventListener("canplay", () => {
      ensureVideoPlayback(video);
    });
    card.appendChild(video);

    const label = document.createElement("div");
    label.className = "collab-media-panel__label";
    card.appendChild(label);

    ui.remoteMedia.appendChild(card);
    tile = { card, video, label };
    state.remoteTiles.set(peerId, tile);
    return tile;
  }

  function removeRemoteTile(peerId) {
    const tile = state.remoteTiles.get(peerId);
    if (!tile) {
      return;
    }

    tile.video.srcObject = null;
    tile.card.remove();
    state.remoteTiles.delete(peerId);
    state.remoteOrder = state.remoteOrder.filter((candidate) => candidate !== peerId);
    persistRemoteOrder();
  }

  function updateMediaPanelVisibility() {
    const hasRemoteTiles = [...state.remoteTiles.values()].some((tile) => tile.video.srcObject);
    const shouldShow = Boolean(state.localStream) || hasRemoteTiles;
    ui.mediaPanel.classList.toggle("collab-media-panel--visible", shouldShow);
  }

  function applyRemoteTileOrder() {
    const availablePeerIds = [...state.remoteTiles.keys()];
    state.remoteOrder = state.remoteOrder.filter((peerId) => availablePeerIds.includes(peerId));

    for (const peerId of availablePeerIds) {
      if (!state.remoteOrder.includes(peerId)) {
        state.remoteOrder.push(peerId);
      }
    }

    state.remoteOrder.forEach((peerId) => {
      const tile = state.remoteTiles.get(peerId);
      if (tile) {
        ui.remoteMedia.appendChild(tile.card);
      }
    });

    persistRemoteOrder();
  }

  function moveRemotePeerBefore(draggedPeerId, targetPeerId = null) {
    const nextOrder = state.remoteOrder.filter((peerId) => peerId !== draggedPeerId);
    if (targetPeerId && nextOrder.includes(targetPeerId)) {
      const targetIndex = nextOrder.indexOf(targetPeerId);
      nextOrder.splice(targetIndex, 0, draggedPeerId);
    } else {
      nextOrder.push(draggedPeerId);
    }
    state.remoteOrder = nextOrder;
    applyRemoteTileOrder();
  }

  function handleRemoteTileDragStart(event) {
    const card = event.currentTarget;
    const peerId = card?.dataset.peerId;
    if (!peerId) {
      return;
    }

    state.draggedRemotePeerId = peerId;
    card.classList.add("collab-media-panel__card--dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", peerId);
  }

  function handleRemoteTileDragEnd(event) {
    state.draggedRemotePeerId = null;
    event.currentTarget?.classList.remove("collab-media-panel__card--dragging");
    ui.remoteMedia.querySelectorAll(".collab-media-panel__card--drop-target").forEach((card) => {
      card.classList.remove("collab-media-panel__card--drop-target");
    });
  }

  function handleRemoteTileDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget?.classList.add("collab-media-panel__card--drop-target");
  }

  function handleRemoteTileDragLeave(event) {
    event.currentTarget?.classList.remove("collab-media-panel__card--drop-target");
  }

  function handleRemoteTileDrop(event) {
    event.preventDefault();
    const targetPeerId = event.currentTarget?.dataset.peerId || null;
    event.currentTarget?.classList.remove("collab-media-panel__card--drop-target");

    if (!state.draggedRemotePeerId || state.draggedRemotePeerId === targetPeerId) {
      return;
    }

    moveRemotePeerBefore(state.draggedRemotePeerId, targetPeerId);
  }

  function handleRemoteGridDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleRemoteGridDrop(event) {
    event.preventDefault();
    if (!state.draggedRemotePeerId) {
      return;
    }

    const dropTarget = event.target instanceof Element ? event.target.closest(".collab-media-panel__card") : null;
    const targetPeerId = dropTarget?.dataset.peerId || null;
    moveRemotePeerBefore(state.draggedRemotePeerId, targetPeerId);
  }

  function renderRemoteMedia() {
    if (state.localStream) {
      attachStreamToVideo(ui.localVideo, state.localStream, { muted: true });
      ui.localVideoCard.classList.remove("collab-media-panel__card--hidden");
    } else {
      if (ui.localVideo.srcObject) {
        ui.localVideo.srcObject = null;
      }
      ui.localVideoCard.classList.add("collab-media-panel__card--hidden");
    }

    const activePeerIds = new Set();
    for (const [peerId, entry] of state.peerConnections.entries()) {
      refreshRemoteStream(entry);
      if (!entry.remoteStream || entry.remoteStream.getTracks().length === 0) {
        continue;
      }

      activePeerIds.add(peerId);
      const tile = ensureRemoteTile(peerId);
      attachStreamToVideo(tile.video, entry.remoteStream);
      tile.label.textContent = getPeerLabel(peerId);
    }

    for (const peerId of [...state.remoteTiles.keys()]) {
      if (!activePeerIds.has(peerId)) {
        removeRemoteTile(peerId);
      }
    }

    applyRemoteTileOrder();
    updateMediaPanelVisibility();
  }

  function updateMediaControls() {
    const hasLocalMedia = Boolean(state.localStream);
    const hasAudioTrack = Boolean(state.localStream?.getAudioTracks().length);
    const hasVideoTrack = Boolean(state.localStream?.getVideoTracks().length);

    ui.joinMediaButton.disabled = state.mediaBusy || hasLocalMedia;
    ui.micButton.disabled = state.mediaBusy || !hasLocalMedia || !hasAudioTrack;
    ui.cameraButton.disabled = state.mediaBusy || !hasLocalMedia || !hasVideoTrack;
    ui.leaveMediaButton.disabled = state.mediaBusy || !hasLocalMedia;

    ui.joinMediaButton.textContent = state.mediaBusy && !hasLocalMedia ? "Joining..." : "Join AV";
    ui.micButton.textContent = hasAudioTrack ? (state.micEnabled ? "Mic on" : "Mic off") : "No mic";
    ui.cameraButton.textContent = hasVideoTrack ? (state.cameraEnabled ? "Cam on" : "Cam off") : "No cam";
    ui.leaveMediaButton.textContent = "Leave";

    if (state.mediaBusy && !hasLocalMedia) {
      setMediaStatus("Requesting access...");
      return;
    }

    if (!hasLocalMedia) {
      setMediaStatus("Off");
      return;
    }

    const remoteCount = [...state.peerConnections.values()].filter((entry) => entry.remoteStream?.getTracks().length).length;
    setMediaStatus(remoteCount > 0 ? `Live with ${remoteCount + 1}` : "Live");
  }

  function closePeerConnection(peerId) {
    const entry = state.peerConnections.get(peerId);
    if (!entry) {
      return;
    }

    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.close();
    state.peerConnections.delete(peerId);
    removeRemoteTile(peerId);
    renderRemoteMedia();
    updateMediaControls();
  }

  function closeAllPeerConnections() {
    for (const peerId of [...state.peerConnections.keys()]) {
      closePeerConnection(peerId);
    }
  }

  function syncPeerConnectionTracks(entry) {
    const localTracksByKind = new Map((state.localStream?.getTracks() || []).map((track) => [track.kind, track]));
    const transceivers = entry.pc.getTransceivers();

    ["audio", "video"].forEach((kind) => {
      const localTrack = localTracksByKind.get(kind) || null;
      const transceiver = transceivers.find((candidate) =>
        candidate.receiver?.track?.kind === kind ||
        candidate.sender?.track?.kind === kind
      );

      if (transceiver) {
        if (transceiver.sender?.track !== localTrack) {
          transceiver.sender?.replaceTrack(localTrack).catch(() => {});
        }

        const nextDirection = localTrack ? "sendrecv" : "recvonly";
        if (transceiver.direction !== nextDirection) {
          try {
            transceiver.direction = nextDirection;
          } catch {
            // Some browsers may reject direction changes during transient signaling states.
          }
        }
        return;
      }

      if (localTrack && state.localStream) {
        entry.pc.addTrack(localTrack, state.localStream);
      }
    });
  }

  function shouldOfferTo(peerId) {
    return state.clientId > peerId;
  }

  function ensurePeerConnection(peerId, options = {}) {
    const syncTracks = options.syncTracks !== false;
    if (!peerId || peerId === state.clientId) {
      return null;
    }

    let entry = state.peerConnections.get(peerId);
    if (entry) {
      applyIceServers(entry);
      if (syncTracks) {
        syncPeerConnectionTracks(entry);
      }
      return entry;
    }

    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    entry = {
      pc,
      remoteStream: new MediaStream(),
      pendingCandidates: [],
      restartInFlight: false,
      makingOffer: false
    };
    state.peerConnections.set(peerId, entry);
    applyIceServers(entry);
    if (syncTracks) {
      syncPeerConnectionTracks(entry);
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      sendCallSignal(peerId, "candidate", event.candidate.toJSON()).catch((error) => {
        console.error("Candidate relay failed:", error);
      });
    };

    pc.ontrack = (event) => {
      const track = event.track;
      bindRemoteTrack(track);
      if (event.streams && event.streams[0]) {
        entry.remoteStream = event.streams[0];
        entry.remoteStream.getTracks().forEach(bindRemoteTrack);
      } else {
        refreshRemoteStream(entry);
      }
      renderRemoteMedia();
      updateMediaControls();
    };

    pc.onconnectionstatechange = () => {
      if (["connected"].includes(pc.connectionState)) {
        entry.restartInFlight = false;
        refreshRemoteStream(entry);
        renderRemoteMedia();
        updateMediaControls();
        return;
      }

      if (["closed"].includes(pc.connectionState)) {
        closePeerConnection(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        entry.restartInFlight = false;
        refreshRemoteStream(entry);
        renderRemoteMedia();
        updateMediaControls();
        return;
      }

      if (["disconnected", "failed"].includes(pc.iceConnectionState)) {
        requestIceRecovery(peerId, pc.iceConnectionState);
      }
    };

    return entry;
  }

  async function sendCallSignal(targetClientId, signalType, payload) {
    const response = await fetch(`/api/collab/call/${encodeURIComponent(state.roomId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: state.clientId,
        targetClientId,
        signalType,
        payload
      })
    });

    if (!response.ok) {
      throw new Error(`Call signaling failed with ${response.status}`);
    }
  }

  async function flushPendingCandidates(entry) {
    while (entry.pendingCandidates.length > 0) {
      const candidate = entry.pendingCandidates.shift();
      await entry.pc.addIceCandidate(candidate);
    }
  }

  async function negotiateWithPeer(peerId, options = {}) {
    const entry = ensurePeerConnection(peerId);
    if (!entry || !shouldOfferTo(peerId)) {
      return;
    }

    if (entry.makingOffer) {
      return;
    }

    if (!options.iceRestart && entry.pc.signalingState !== "stable") {
      return;
    }

    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
      await entry.pc.setLocalDescription(offer);
      await sendCallSignal(peerId, "offer", entry.pc.localDescription.toJSON());
    } catch (error) {
      entry.restartInFlight = false;
      console.error("Offer creation failed:", error);
      window.setTimeout(() => {
        if (!state.destroyed && state.localStream && state.peers.some((peer) => peer.clientId === peerId)) {
          negotiateWithPeer(peerId, options);
        }
      }, 1200);
    } finally {
      entry.makingOffer = false;
    }
  }

  async function handleCallSignal(message) {
    const peerId = String(message?.fromClientId || "");
    if (!peerId || peerId === state.clientId) {
      return;
    }

    if (message.signalType === "hangup") {
      closePeerConnection(peerId);
      return;
    }

    if (message.signalType === "announce-media") {
      if (shouldOfferTo(peerId)) {
        await negotiateWithPeer(peerId);
      } else if (state.localStream) {
        await sendCallSignal(peerId, "restart-request", {
          reason: "announce-media"
        });
      }
      return;
    }

    if (message.signalType === "restart-request") {
      if (shouldOfferTo(peerId)) {
        await negotiateWithPeer(peerId, { iceRestart: true });
      }
      return;
    }

    const entry = ensurePeerConnection(peerId, {
      syncTracks: message.signalType !== "offer"
    });
    if (!entry) {
      return;
    }

    if (message.signalType === "offer") {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      syncPeerConnectionTracks(entry);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      await flushPendingCandidates(entry);
      await sendCallSignal(peerId, "answer", entry.pc.localDescription.toJSON());
      return;
    }

    if (message.signalType === "answer") {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await flushPendingCandidates(entry);
      entry.restartInFlight = false;
      return;
    }

    if (message.signalType === "candidate") {
      const candidate = new RTCIceCandidate(message.payload);
      if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(candidate);
      } else {
        entry.pendingCandidates.push(candidate);
      }
    }
  }

  async function joinMediaSession() {
    if (state.mediaBusy || state.localStream) {
      return;
    }

    if (!supportsRealtimeMedia()) {
      alert("This browser does not support live camera/audio calls here.");
      return;
    }

    state.mediaBusy = true;
    updateMediaControls();

    try {
      const [, stream] = await Promise.all([
        fetchRuntimeIceServers(true),
        navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        })
      ]);
      state.localStream = stream;
      state.mediaEnabled = true;
      state.micEnabled = true;
      state.cameraEnabled = true;
      renderRemoteMedia();
      updateMediaControls();
      await sendPresence();

      await sendCallSignal("", "announce-media", {
        hasAudio: stream.getAudioTracks().length > 0,
        hasVideo: stream.getVideoTracks().length > 0
      });

      for (const peer of state.peers) {
        if (peer.clientId === state.clientId || peer.mediaEnabled !== true) {
          continue;
        }

        if (shouldOfferTo(peer.clientId)) {
          await negotiateWithPeer(peer.clientId);
        } else {
          await sendCallSignal(peer.clientId, "restart-request", {
            reason: "join-media"
          });
        }
      }

      window.setTimeout(() => {
        if (!state.destroyed) {
          for (const peer of state.peers) {
            requestPeerMediaSync(peer.clientId, "join-media-followup");
          }
        }
      }, 1_500);
    } catch (error) {
      console.error("Joining media failed:", error);
      state.mediaEnabled = false;
      alert("Camera/audio access failed. Please allow microphone and camera access to join the call.");
    } finally {
      state.mediaBusy = false;
      updateMediaControls();
    }
  }

  function stopLocalTracks() {
    state.localStream?.getTracks().forEach((track) => {
      track.stop();
    });
    state.localStream = null;
    state.mediaEnabled = false;
    state.micEnabled = false;
    state.cameraEnabled = false;
  }

  function leaveMediaSession(options = {}) {
    const silent = options.silent === true;
    if (!state.localStream && state.peerConnections.size === 0) {
      updateMediaControls();
      return;
    }

    if (!silent) {
      sendCallSignal("", "hangup", {}).catch((error) => {
        console.error("Hangup relay failed:", error);
      });
    }

    stopLocalTracks();
    closeAllPeerConnections();
    renderRemoteMedia();
    updateMediaControls();
    sendPresence().catch((error) => {
      console.error("Presence update after leaving media failed:", error);
    });
  }

  function toggleMicrophone() {
    const track = state.localStream?.getAudioTracks()[0];
    if (!track) {
      return;
    }

    track.enabled = !track.enabled;
    state.micEnabled = track.enabled;
    updateMediaControls();
  }

  function toggleCamera() {
    const track = state.localStream?.getVideoTracks()[0];
    if (!track) {
      return;
    }

    track.enabled = !track.enabled;
    state.cameraEnabled = track.enabled;
    updateMediaControls();
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

  function ensureMediaMeshMonitor() {
    if (state.mediaMeshTimer) {
      return;
    }

    state.mediaMeshTimer = window.setInterval(() => {
      if (state.destroyed || !state.ready || !state.localStream) {
        return;
      }

      for (const peer of state.peers) {
        if (peer.clientId === state.clientId) {
          continue;
        }

        const entry = state.peerConnections.get(peer.clientId);
        const hasLiveRemoteTracks = Boolean(entry?.remoteStream?.getTracks().some((track) => track.readyState === "live"));
        const isConnected = entry ? ["connected", "completed"].includes(entry.pc.iceConnectionState) : false;

        if (!entry || !hasLiveRemoteTracks || !isConnected) {
          requestPeerMediaSync(peer.clientId, "mesh-monitor");
        }
      }
    }, 3_000);
  }

  function startRealtime() {
    ensureHealthMonitor();
    ensureSyncMonitor();
    ensureSnapshotPolling();
    ensureMediaMeshMonitor();
    connectStream();
    sendPresence();
  }

  async function registerRoom() {
    const response = await fetch(`/api/collab/register/${encodeURIComponent(state.roomId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: state.clientId,
        puzzleId: state.puzzleId
      })
    });

    if (!response.ok) {
      throw new Error(`Room registration failed with ${response.status}`);
    }

    const payload = await response.json();
    applyControlState(payload.control);
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

      if (response.status === 403) {
        const payload = await response.json().catch(() => ({}));
        if (payload.control) {
          applyControlState(payload.control);
        }
        if (payload.snapshot) {
          await applySnapshot(payload.snapshot);
        } else {
          await fetchLatestSnapshot();
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`Sync failed with ${response.status}`);
      }

      const payload = await response.json();
      if (payload.control) {
        applyControlState(payload.control);
      }
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
          name: state.name,
          mediaEnabled: state.mediaEnabled
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

  async function applySnapshot(snapshot, options = {}) {
    const force = options.force === true;

    if (!snapshot || !snapshot.replay || (!force && snapshot.revision <= state.latestRevision)) {
      return;
    }

    state.latestRevision = Math.max(state.latestRevision, snapshot.revision || 0);

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
    const hasUnsyncedLocalChanges = canEditBoard() && currentHash !== state.lastAppliedHash;
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
    if (Array.isArray(payload.highlights)) {
      payload.highlights.forEach(applyHighlight);
    }

    if (payload.snapshot) {
          await applySnapshot(payload.snapshot, { force: true });
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
      if (Array.isArray(payload.highlights)) {
        payload.highlights.forEach(applyHighlight);
      }

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

    source.addEventListener("call", (event) => {
      try {
        markStreamActivity();
        const message = JSON.parse(event.data);
        handleCallSignal(message).catch((error) => {
          console.error("Call signal handling failed:", error);
        });
      } catch (error) {
        console.error("Call signal parse failed:", error);
      }
    });

    source.addEventListener("highlight", (event) => {
      try {
        markStreamActivity();
        applyHighlight(JSON.parse(event.data));
      } catch (error) {
        console.error("Highlight parse failed:", error);
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
      if (!state.applyingRemote && canEditBoard()) {
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

    const board = document.querySelector("#svgrenderer");
    if (!puzzle.__collabHighlightPatched && board instanceof Element) {
      board.addEventListener("pointerdown", sendBoardHighlight, true);
      puzzle.__collabHighlightPatched = true;
    }

    const original = puzzle.act.bind(puzzle);
    puzzle.act = (...args) => {
      if (!state.applyingRemote && !canEditBoard()) {
        return null;
      }
      const result = original(...args);
      if (!state.applyingRemote) {
        scheduleBroadcast();
      }
      return result;
    };
    puzzle.__collabActPatched = true;
  }
})();
