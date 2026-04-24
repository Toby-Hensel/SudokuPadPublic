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
  const iceServers = Array.isArray(window.__COLLAB_ICE_SERVERS__) && window.__COLLAB_ICE_SERVERS__.length > 0
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
    peers: [],
    localStream: null,
    mediaEnabled: false,
    mediaBusy: false,
    micEnabled: true,
    cameraEnabled: true,
    peerConnections: new Map(),
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
  updateMediaControls();

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
  ui.joinMediaButton.addEventListener("click", joinMediaSession);
  ui.micButton.addEventListener("click", toggleMicrophone);
  ui.cameraButton.addEventListener("click", toggleCamera);
  ui.leaveMediaButton.addEventListener("click", leaveMediaSession);

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
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
    }
    if (state.eventSource) {
      state.eventSource.close();
    }
    leaveMediaSession({ silent: true });
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
        <div class="collab-dock__label">
          Camera and audio
          <div class="collab-dock__media-status">Off</div>
          <div class="collab-dock__actions collab-dock__actions--media">
            <button class="collab-dock__button collab-dock__button--primary" type="button">Join AV</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Mic on</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Cam on</button>
            <button class="collab-dock__button collab-dock__button--secondary" type="button" disabled>Leave</button>
          </div>
          <video class="collab-dock__local-video" autoplay muted playsinline></video>
          <div class="collab-dock__remote-media"></div>
        </div>
      </div>
    `;
    document.body.appendChild(dock);

    const inviteActions = dock.querySelectorAll(".collab-dock__actions")[0];
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
      mediaStatus: dock.querySelector(".collab-dock__media-status"),
      joinMediaButton: mediaActions.querySelector(".collab-dock__button--primary"),
      micButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[0],
      cameraButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[1],
      leaveMediaButton: mediaActions.querySelectorAll(".collab-dock__button--secondary")[2],
      localVideo: dock.querySelector(".collab-dock__local-video"),
      remoteMedia: dock.querySelector(".collab-dock__remote-media")
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

    for (const peerId of [...state.peerConnections.keys()]) {
      if (!peers.some((peer) => peer.clientId === peerId)) {
        closePeerConnection(peerId);
      }
    }

    if (state.localStream) {
      peers.forEach((peer) => {
        if (peer.clientId !== state.clientId && shouldOfferTo(peer.clientId) && !state.peerConnections.has(peer.clientId)) {
          negotiateWithPeer(peer.clientId);
        }
      });
    }

    renderRemoteMedia();
    updateMediaControls();
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

  function getPeerLabel(peerId) {
    const peer = state.peers.find((candidate) => candidate.clientId === peerId);
    return peer?.clientId === state.clientId ? `${peer.name} (you)` : (peer?.name || `Solver ${peerId.slice(0, 4)}`);
  }

  function renderRemoteMedia() {
    ui.remoteMedia.innerHTML = "";

    if (state.localStream) {
      ui.localVideo.srcObject = state.localStream;
      ui.localVideo.classList.add("collab-dock__local-video--live");
    } else {
      ui.localVideo.srcObject = null;
      ui.localVideo.classList.remove("collab-dock__local-video--live");
    }

    for (const [peerId, entry] of state.peerConnections.entries()) {
      if (!entry.remoteStream || entry.remoteStream.getTracks().length === 0) {
        continue;
      }

      const card = document.createElement("div");
      card.className = "collab-dock__remote-card";

      const video = document.createElement("video");
      video.className = "collab-dock__remote-video";
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = entry.remoteStream;
      card.appendChild(video);

      const label = document.createElement("div");
      label.className = "collab-dock__remote-label";
      label.textContent = getPeerLabel(peerId);
      card.appendChild(label);

      ui.remoteMedia.appendChild(card);
    }
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
    entry.pc.close();
    state.peerConnections.delete(peerId);
    renderRemoteMedia();
    updateMediaControls();
  }

  function closeAllPeerConnections() {
    for (const peerId of [...state.peerConnections.keys()]) {
      closePeerConnection(peerId);
    }
  }

  function syncPeerConnectionTracks(entry) {
    const localTracks = state.localStream?.getTracks() || [];
    const senders = entry.pc.getSenders();

    if (localTracks.length === 0) {
      if (!entry.recvOnlyReady) {
        entry.pc.addTransceiver("audio", { direction: "recvonly" });
        entry.pc.addTransceiver("video", { direction: "recvonly" });
        entry.recvOnlyReady = true;
      }
      return;
    }

    localTracks.forEach((track) => {
      const existingSender = senders.find((sender) => sender.track && sender.track.kind === track.kind);
      if (existingSender) {
        if (existingSender.track !== track) {
          existingSender.replaceTrack(track).catch(() => {});
        }
        return;
      }

      entry.pc.addTrack(track, state.localStream);
    });
  }

  function shouldOfferTo(peerId) {
    return state.clientId > peerId;
  }

  function ensurePeerConnection(peerId) {
    if (!peerId || peerId === state.clientId) {
      return null;
    }

    let entry = state.peerConnections.get(peerId);
    if (entry) {
      syncPeerConnectionTracks(entry);
      return entry;
    }

    const pc = new RTCPeerConnection({ iceServers });
    entry = {
      pc,
      remoteStream: new MediaStream(),
      pendingCandidates: [],
      recvOnlyReady: false
    };
    state.peerConnections.set(peerId, entry);
    syncPeerConnectionTracks(entry);

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      sendCallSignal(peerId, "candidate", event.candidate.toJSON()).catch((error) => {
        console.error("Candidate relay failed:", error);
      });
    };

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!entry.remoteStream.getTracks().some((candidate) => candidate.id === track.id)) {
          entry.remoteStream.addTrack(track);
        }
      });
      renderRemoteMedia();
      updateMediaControls();
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        closePeerConnection(peerId);
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

  async function negotiateWithPeer(peerId) {
    const entry = ensurePeerConnection(peerId);
    if (!entry || !shouldOfferTo(peerId)) {
      return;
    }

    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await sendCallSignal(peerId, "offer", entry.pc.localDescription.toJSON());
    } catch (error) {
      console.error("Offer creation failed:", error);
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
      }
      return;
    }

    const entry = ensurePeerConnection(peerId);
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      state.localStream = stream;
      state.micEnabled = true;
      state.cameraEnabled = true;
      renderRemoteMedia();
      updateMediaControls();

      await sendCallSignal("", "announce-media", {
        hasAudio: stream.getAudioTracks().length > 0,
        hasVideo: stream.getVideoTracks().length > 0
      });

      for (const peer of state.peers) {
        if (peer.clientId !== state.clientId && shouldOfferTo(peer.clientId)) {
          await negotiateWithPeer(peer.clientId);
        }
      }
    } catch (error) {
      console.error("Joining media failed:", error);
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

  function startRealtime() {
    ensureHealthMonitor();
    ensureSyncMonitor();
    ensureSnapshotPolling();
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
        puzzleId: state.puzzleId
      })
    });

    if (!response.ok) {
      throw new Error(`Room registration failed with ${response.status}`);
    }
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
