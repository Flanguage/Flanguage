(() => {
  "use strict";

  const catalog = window.FLANGUAGE_CATALOG;
  const fingerprints = window.FLANGUAGE_FINGERPRINTS;
  const spectrumIndex = window.FLANGUAGE_SPECTRUM_INDEX;
  if (!catalog?.albums?.length) return;

  const webampScript = {
    source: "vendor/webamp-2.3.1.min.js",
    integrity:
      "sha384-9waE2xOw4VkyDDXbmumm9jR3ovD2w9gGl0+ehyi66rJSOPx9lyNxs8+jSS2HruM6",
  };
  const modeStorageKey = "flanguage-player-mode";

  const channelOrder = [
    "flanguage",
    "egaugnalf",
    "fungalage",
    "flangasms",
    "flangisms",
    "flan",
    "flangussy",
    "flanthology",
    "flanghub",
    "flangdump",
    "los-flangos",
    "now-that-s-what-i-call-flanguage-volume-12",
    "flangwich-ep",
    "flangaroni",
    "flangdawg",
    "flangolingo",
    "flang",
  ];

  const orderedAlbums = [...catalog.albums].sort((left, right) => {
    const leftIndex = channelOrder.indexOf(left.slug);
    const rightIndex = channelOrder.indexOf(right.slug);
    if (leftIndex >= 0 || rightIndex >= 0) {
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    }

    const leftDate =
      Date.parse(left.publishedAt || left.releaseDate || "") || 0;
    const rightDate =
      Date.parse(right.publishedAt || right.releaseDate || "") || 0;
    return (
      leftDate - rightDate ||
      left.title.localeCompare(right.title, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.slug.localeCompare(right.slug)
    );
  });

  const elements = {
    albumFilter: document.querySelector("#album-filter"),
    audio: document.querySelector("#audio"),
    bandcampPlayer: document.querySelector("#bandcamp-player"),
    directory: document.querySelector("#terminal-directory"),
    duration: document.querySelector("#duration"),
    elapsed: document.querySelector("#elapsed"),
    next: document.querySelector("#terminal-next"),
    play: document.querySelector("#terminal-play"),
    playHost: document.querySelector("#play-host"),
    position: document.querySelector("#terminal-position"),
    previous: document.querySelector("#terminal-previous"),
    random: document.querySelector("#random"),
    rollDots: document.querySelector(".roll-dots"),
    search: document.querySelector("#search"),
    seekRow: document.querySelector("#seek-row"),
    skinSelect: document.querySelector("#skin-select"),
    skinSource: document.querySelector("#skin-source"),
    skinStatus: document.querySelector("#skin-status"),
    skinUrl: document.querySelector("#skin-url"),
    spectrum: document.querySelector("#spectrum"),
    terminalMode: document.querySelector("#terminal-mode"),
    terminalPlayer: document.querySelector("#terminal-player"),
    trackList: document.querySelector("#track-list"),
    webampHost: document.querySelector("#webamp-host"),
    webampAudio: document.querySelector("#winamp-audio"),
    webampMode: document.querySelector("#winamp-mode"),
    webampPlayer: document.querySelector("#winamp-player"),
    webampPlaceholder: document.querySelector("#webamp-placeholder"),
    loadSkin: document.querySelector("#load-skin"),
    randomSkin: document.querySelector("#random-skin"),
  };

  const tracks = orderedAlbums.flatMap((album) =>
    album.tracks.map((track) => ({ ...track, album })),
  );

  const rollWord = "FLANGUAGE";
  const rollDuration = 900;
  const rollFrameDuration = rollDuration / rollWord.length;
  const dotFont = {
    A: "010101111101101",
    E: "111100110100111",
    F: "111100110100100",
    G: "111100101101111",
    L: "100100100100111",
    N: "101111111111101",
    U: "101101101101111",
  };
  const rollDotPositions = [
    [12, 7],
    [20, 7],
    [28, 7],
    [12, 13.5],
    [20, 13.5],
    [28, 13.5],
    [12, 20],
    [20, 20],
    [28, 20],
    [12, 26.5],
    [20, 26.5],
    [28, 26.5],
    [12, 33],
    [20, 33],
    [28, 33],
  ];
  let rollFrameTimer;
  let rollCompleteTimer;

  const rollDots = rollDotPositions.map(([x, y]) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "roll-dot");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", "2.5");
    elements.rollDots.append(dot);
    return dot;
  });

  const alphaSort = (left, right) =>
    left.title.localeCompare(right.title, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.album.title.localeCompare(right.album.title, undefined, {
      sensitivity: "base",
    });

  const hashParams = new URLSearchParams(location.hash.slice(1));

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable in private browsing; the mode still works.
    }
  }

  const requestedMode = hashParams.get("mode") || readStorage(modeStorageKey);
  const initialMode = requestedMode === "winamp" ? "winamp" : "terminal";

  const state = {
    album: "all",
    current: [...tracks].sort(alphaSort)[0],
    query: "",
    mode: initialMode,
    embedMode: false,
    embedReady: false,
    spectrumData: null,
    spectrumMeta: null,
    spectrumRequest: 0,
    winamp: null,
    winampPromise: null,
    webampScriptPromise: null,
  };

  const spectrumFiles = new Map();
  const hashTrack = Number(hashParams.get("track"));
  const hashMatch = tracks.find((track) => track.id === hashTrack);
  if (hashMatch) state.current = hashMatch;

  function visibleTracks() {
    const query = state.query.trim().toLocaleLowerCase();
    return tracks
      .filter((track) => {
        const channelMatch =
          state.album === "all" || track.album.slug === state.album;
        const searchMatch =
          !query ||
          track.title.toLocaleLowerCase().includes(query) ||
          track.album.title.toLocaleLowerCase().includes(query);
        return channelMatch && searchMatch;
      })
      .sort(alphaSort);
  }

  function isPlaying() {
    return !elements.audio.paused && !elements.audio.ended;
  }

  function embedUrl(track) {
    return [
      "https://bandcamp.com/EmbeddedPlayer",
      `track=${track.id}`,
      "size=small",
      "artwork=none",
      "bgcol=000000",
      "linkcol=ffffff",
      "fgcol=ffffff",
      "transparent=false",
      "",
    ].join("/");
  }

  function updatePlayButton() {
    const playing = isPlaying();
    elements.play.classList.toggle("is-playing", playing);
    elements.play.setAttribute(
      "aria-label",
      playing ? "Pause track" : "Play track",
    );
    elements.play.title = playing ? "Pause" : "Play";
  }

  function updateHash(track) {
    const params = new URLSearchParams({
      album: track.album.slug,
      track: String(track.id),
      mode: state.mode,
    });
    history.replaceState(null, "", `#${params}`);
  }

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    const remainder = Math.floor(safe % 60);
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function updatePosition() {
    const duration = Number.isFinite(elements.audio.duration)
      ? elements.audio.duration
      : state.current.duration;
    const elapsed = Number.isFinite(elements.audio.currentTime)
      ? elements.audio.currentTime
      : 0;
    elements.position.max = String(duration || 0);
    elements.position.value = String(Math.min(elapsed, duration || 0));
    elements.elapsed.value = formatTime(elapsed);
    elements.elapsed.textContent = formatTime(elapsed);
    elements.duration.value = formatTime(duration);
    elements.duration.textContent = formatTime(duration);
  }

  async function loadSpectrum(track) {
    const request = ++state.spectrumRequest;
    const meta = spectrumIndex?.tracks?.[track.id];
    state.spectrumMeta = meta || null;
    state.spectrumData = null;
    if (!meta) return;

    try {
      if (!spectrumFiles.has(meta.file)) {
        spectrumFiles.set(
          meta.file,
          fetch(meta.file).then((response) => {
            if (!response.ok) {
              throw new Error(`Spectrum unavailable (${response.status})`);
            }
            return response.arrayBuffer();
          }),
        );
      }

      const buffer = await spectrumFiles.get(meta.file);
      if (request !== state.spectrumRequest) return;
      const length = meta.frames * spectrumIndex.bands;
      state.spectrumData = new Uint8Array(buffer, meta.offset, length);
    } catch {
      if (meta?.file) spectrumFiles.delete(meta.file);
      if (request === state.spectrumRequest) {
        state.spectrumMeta = null;
        state.spectrumData = null;
      }
    }
  }

  function reflectWinampTrack(trackId) {
    const track = tracks.find((candidate) => candidate.id === trackId);
    if (!track) return;
    state.current = track;
    document.title = `${track.title} // Flanguage`;
    updateHash(track);
    renderTracks();
    void loadSpectrum(track);
  }

  function getWinampSpectrumFrame(trackId, time) {
    if (
      state.current.id !== trackId ||
      !state.spectrumData ||
      !state.spectrumMeta ||
      !spectrumIndex
    ) {
      return null;
    }

    const frame = Math.min(
      state.spectrumMeta.frames - 1,
      Math.max(0, Math.floor(time * spectrumIndex.fps)),
    );
    const start = frame * spectrumIndex.bands;
    return state.spectrumData.subarray(start, start + spectrumIndex.bands);
  }

  function loadWebampLibrary() {
    if (window.Webamp) return Promise.resolve(window.Webamp);
    if (state.webampScriptPromise) return state.webampScriptPromise;

    state.webampScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${webampScript.source}?v=2.3.1`;
      script.integrity = webampScript.integrity;
      script.addEventListener(
        "load",
        () => {
          if (window.Webamp) resolve(window.Webamp);
          else reject(new Error("WEBAMP DID NOT INITIALIZE_"));
        },
        { once: true },
      );
      script.addEventListener(
        "error",
        () => reject(new Error("WEBAMP LIBRARY COULD NOT LOAD_")),
        { once: true },
      );
      document.head.append(script);
    }).catch((error) => {
      state.webampScriptPromise = null;
      throw error;
    });

    return state.webampScriptPromise;
  }

  async function ensureWinamp() {
    if (state.winamp) return state.winamp;
    if (state.winampPromise) return state.winampPromise;

    elements.skinStatus.textContent = "LOADING WEBAMP 2.3.1_";
    elements.skinStatus.classList.remove("error");
    elements.webampPlaceholder.hidden = false;
    state.winampPromise = (async () => {
      await loadWebampLibrary();
      if (typeof window.createFlanguageWinampMode !== "function") {
        throw new Error("WINAMP MODE MODULE COULD NOT LOAD_");
      }

      const controller = await window.createFlanguageWinampMode({
        audio: elements.webampAudio,
        getSpectrumFrame: getWinampSpectrumFrame,
        host: elements.webampHost,
        initialTrackId: state.current.id,
        loadSkinButton: elements.loadSkin,
        onTrackChange(trackId) {
          if (state.mode === "winamp") reflectWinampTrack(trackId);
        },
        placeholder: elements.webampPlaceholder,
        randomSkinButton: elements.randomSkin,
        skinSelect: elements.skinSelect,
        skinSource: elements.skinSource,
        skinStatus: elements.skinStatus,
        skinUrlInput: elements.skinUrl,
        tracks,
      });
      state.winamp = controller;
      return controller;
    })().catch((error) => {
      state.winampPromise = null;
      elements.skinStatus.textContent = error.message || "WINAMP MODE FAILED_";
      elements.skinStatus.classList.add("error");
      elements.webampPlaceholder.textContent = "USE TERMINAL MODE_";
      throw error;
    });

    return state.winampPromise;
  }

  function renderMode() {
    const winamp = state.mode === "winamp";
    elements.terminalPlayer.hidden = winamp;
    elements.directory.hidden = winamp;
    elements.webampPlayer.hidden = !winamp;
    elements.terminalMode.classList.toggle("active", !winamp);
    elements.webampMode.classList.toggle("active", winamp);
    elements.terminalMode.setAttribute("aria-pressed", String(!winamp));
    elements.webampMode.setAttribute("aria-pressed", String(winamp));
  }

  async function setMode(mode) {
    const nextMode = mode === "winamp" ? "winamp" : "terminal";
    const changed = state.mode !== nextMode;

    if (nextMode === "winamp") {
      elements.audio.pause();
      elements.bandcampPlayer.removeAttribute("src");
      state.embedReady = false;
    } else {
      state.winamp?.pause();
    }

    state.mode = nextMode;
    writeStorage(modeStorageKey, nextMode);
    renderMode();
    updateHash(state.current);

    if (nextMode === "winamp") {
      try {
        const winamp = await ensureWinamp();
        if (state.mode !== "winamp") {
          winamp.pause();
          return;
        }
        winamp.selectTrack(state.current.id, false);
      } catch {
        // The visible status explains the failure; Terminal remains one tap away.
      }
      return;
    }

    if (changed || !elements.audio.src) {
      selectTrack(state.current, false, false);
    }
  }

  function playCurrent() {
    if (state.mode === "winamp") {
      state.winamp?.play();
      return;
    }
    if (!state.current.audio) return;
    if (elements.audio.ended) elements.audio.currentTime = 0;
    elements.audio.play().catch(updatePlayButton);
  }

  function selectTrack(track, scroll = true, continuePlayback = isPlaying()) {
    if (state.mode === "winamp") {
      const continueWinamp = state.winamp?.isPlaying() || false;
      reflectWinampTrack(track.id);
      state.winamp?.selectTrack(track.id, continueWinamp);
      return;
    }

    state.current = track;
    document.title = `${track.title} // Flanguage`;
    updateHash(track);
    renderTracks();
    void loadSpectrum(track);

    elements.audio.pause();
    elements.audio.currentTime = 0;
    if (track.audio) {
      state.embedMode = false;
      state.embedReady = false;
      elements.playHost.classList.remove("embed-mode");
      elements.seekRow.hidden = false;
      elements.bandcampPlayer.removeAttribute("src");
      elements.audio.src = track.audio;
      elements.audio.load();
      elements.play.disabled = false;
      if (continuePlayback) playCurrent();
    } else {
      state.embedMode = true;
      state.embedReady = false;
      elements.playHost.classList.add("embed-mode");
      elements.seekRow.hidden = true;
      elements.bandcampPlayer.src = embedUrl(track);
      elements.bandcampPlayer.title = `Play ${track.title} by Flanguage`;
      elements.audio.removeAttribute("src");
      elements.audio.load();
      elements.play.disabled = false;
    }
    updatePlayButton();
    updatePosition();

    if (scroll) {
      requestAnimationFrame(() => {
        const row = elements.trackList.querySelector(".track-row.active");
        if (!row) return;
        const listBounds = elements.trackList.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        elements.trackList.scrollTo({
          top: elements.trackList.scrollTop + rowBounds.top - listBounds.top,
          behavior: "smooth",
        });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
  }

  function renderTracks() {
    const filtered = visibleTracks();
    elements.trackList.replaceChildren();

    if (!filtered.length) {
      const message = document.createElement("p");
      message.className = "empty-message";
      message.textContent = "NO MATCH_";
      elements.trackList.append(message);
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((track) => {
      const active = track.id === state.current.id;
      const row = document.createElement("button");
      row.className = `track-row${active ? " active" : ""}`;
      row.type = "button";
      row.dataset.trackId = track.id;
      row.setAttribute("aria-pressed", String(active));
      row.setAttribute(
        "aria-label",
        `${track.title}, from ${track.album.title}`,
      );

      const marker = document.createElement("span");
      marker.className = "track-marker";
      marker.textContent = active ? ">" : "·";

      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = track.title;

      row.append(marker, name);
      fragment.append(row);
    });

    elements.trackList.append(fragment);
  }

  function adjacentTrack(direction, continuePlayback = isPlaying()) {
    if (state.mode === "winamp") {
      if (direction < 0) state.winamp?.previous();
      else state.winamp?.next();
      return;
    }

    const pool = visibleTracks();
    if (!pool.length) return;
    const index = pool.findIndex((track) => track.id === state.current.id);
    const start = index < 0 ? 0 : index;
    selectTrack(
      pool[(start + direction + pool.length) % pool.length],
      true,
      continuePlayback,
    );
  }

  function randomTrack() {
    if (state.mode === "winamp") {
      state.winamp?.random();
      return;
    }

    const pool = visibleTracks();
    if (!pool.length) return;
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && next.id === state.current.id) {
      next = pool[(pool.indexOf(next) + 1) % pool.length];
    }
    selectTrack(next, true);
  }

  function renderRollLetter(letter) {
    const pattern = dotFont[letter] || "";
    rollDots.forEach((dot, index) => {
      dot.classList.toggle("is-on", pattern[index] === "1");
    });
  }

  function finishDiceRoll() {
    window.clearTimeout(rollFrameTimer);
    window.clearTimeout(rollCompleteTimer);
    renderRollLetter("F");
  }

  function animateDice() {
    window.clearTimeout(rollFrameTimer);
    window.clearTimeout(rollCompleteTimer);

    let frame = 0;
    const animateLetter = () => {
      renderRollLetter(rollWord[frame]);
      frame += 1;
      if (frame < rollWord.length) {
        rollFrameTimer = window.setTimeout(animateLetter, rollFrameDuration);
      }
    };
    animateLetter();
    rollCompleteTimer = window.setTimeout(finishDiceRoll, rollDuration);
  }

  function populateChannels() {
    const fragment = document.createDocumentFragment();
    orderedAlbums.forEach((album, index) => {
      const option = document.createElement("option");
      option.value = album.slug;
      option.textContent = `CH ${String(index + 1).padStart(2, "0")} / ${album.title.toLocaleUpperCase()}`;
      fragment.append(option);
    });
    elements.albumFilter.append(fragment);
  }

  elements.terminalMode.addEventListener("click", () => {
    void setMode("terminal");
  });
  elements.webampMode.addEventListener("click", () => {
    void setMode("winamp");
  });

  elements.albumFilter.addEventListener("change", (event) => {
    state.album = event.target.value;
    const first = visibleTracks()[0];
    if (first) selectTrack(first, true);
    else renderTracks();
  });

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderTracks();
  });

  elements.trackList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-track-id]");
    if (!row) return;
    const track = tracks.find(
      (candidate) => candidate.id === Number(row.dataset.trackId),
    );
    if (track) selectTrack(track, true);
  });

  elements.play.addEventListener("click", () => {
    if (isPlaying()) elements.audio.pause();
    else playCurrent();
  });
  elements.previous.addEventListener("click", () => adjacentTrack(-1));
  elements.next.addEventListener("click", () => adjacentTrack(1));
  elements.random.addEventListener("click", () => {
    animateDice();
    randomTrack();
  });
  elements.position.addEventListener("input", () => {
    if (!Number.isFinite(elements.audio.duration)) return;
    elements.audio.currentTime = Number(elements.position.value);
    updatePosition();
  });

  elements.audio.addEventListener("play", updatePlayButton);
  elements.audio.addEventListener("pause", updatePlayButton);
  elements.audio.addEventListener("loadedmetadata", updatePosition);
  elements.audio.addEventListener("durationchange", updatePosition);
  elements.audio.addEventListener("timeupdate", updatePosition);
  elements.audio.addEventListener("ended", () => {
    if (state.mode === "terminal") adjacentTrack(1, true);
  });
  elements.audio.addEventListener("error", updatePlayButton);
  elements.bandcampPlayer.addEventListener("load", () => {
    state.embedReady = true;
  });
  window.addEventListener("message", (event) => {
    if (
      event.origin === "https://bandcamp.com" &&
      event.data === "playerinited"
    ) {
      state.embedReady = true;
    }
  });

  document.addEventListener("dblclick", (event) => event.preventDefault(), {
    passive: false,
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.closest?.("#webamp")) return;
    if (
      event.target.matches("input, select, button") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    if (state.mode === "winamp") {
      if (event.key === " ") {
        event.preventDefault();
        if (state.winamp?.isPlaying()) state.winamp.pause();
        else state.winamp?.play();
      }
      if (event.key === "ArrowLeft") state.winamp?.previous();
      if (event.key === "ArrowRight") state.winamp?.next();
      if (event.key.toLocaleLowerCase() === "r") state.winamp?.random();
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      if (isPlaying()) elements.audio.pause();
      else playCurrent();
    }
    if (event.key === "ArrowLeft") adjacentTrack(-1);
    if (event.key === "ArrowRight") adjacentTrack(1);
    if (event.key.toLocaleLowerCase() === "r") randomTrack();
  });

  function startSpectrum() {
    const canvas = elements.spectrum;
    const context = canvas.getContext("2d");
    const bands = spectrumIndex?.bands || fingerprints?.bands || 64;
    const levels = new Float32Array(bands);
    let renderedTrackId = null;
    let lastDraw = performance.now();

    function normalize(raw) {
      const signal = Math.max(0, Math.min(1, (raw - 10) / 170));
      return signal < 0.04 ? 0 : signal ** 1.08;
    }

    function resize() {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function draw(now) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);

      if (renderedTrackId !== state.current.id) {
        levels.fill(0);
        renderedTrackId = state.current.id;
      }

      const elapsed = Math.max(
        1 / 240,
        Math.min(0.1, (now - lastDraw) / 1000),
      );
      lastDraw = now;
      const attack = 1 - Math.exp(-elapsed / 0.045);
      const release = 1 - Math.exp(-elapsed / 0.16);
      const active =
        isPlaying() && state.spectrumData && state.spectrumMeta && spectrumIndex;
      const fingerprint = fingerprints?.tracks?.[state.current.id];
      let frame = 0;

      if (active) {
        const framePosition = elements.audio.currentTime * spectrumIndex.fps;
        frame = Math.min(
          state.spectrumMeta.frames - 1,
          Math.max(0, Math.floor(framePosition)),
        );
      }

      for (let index = 0; index < bands; index += 1) {
        let target = 0;
        if (active) {
          target = normalize(
            state.spectrumData[frame * bands + index],
          );
        } else if (state.embedMode && fingerprint?.length === bands) {
          target = normalize(fingerprint[index] || 0);
        }
        levels[index] +=
          (target - levels[index]) *
          (target > levels[index] ? attack : release);

        const barHeight =
          levels[index] < 0.008 ? 0 : levels[index] * (height - 6);
        if (barHeight > 0) {
          const left = Math.round((index * width) / bands);
          const right = Math.round(((index + 1) * width) / bands);
          const barWidth = Math.max(1, right - left - 1);
          context.fillStyle = "#fff";
          context.fillRect(left, height - barHeight, barWidth, barHeight);
        }
      }

      requestAnimationFrame(draw);
    }

    resize();
    addEventListener("resize", resize, { passive: true });
    requestAnimationFrame(draw);
  }

  renderRollLetter("F");
  populateChannels();
  startSpectrum();
  renderMode();
  if (state.mode === "winamp") {
    reflectWinampTrack(state.current.id);
    void setMode("winamp");
  } else {
    selectTrack(state.current, false, false);
  }
})();
