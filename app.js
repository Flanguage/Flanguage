(() => {
  "use strict";

  const catalog = window.FLANGUAGE_CATALOG;
  const fingerprints = window.FLANGUAGE_FINGERPRINTS;
  const spectrumIndex = window.FLANGUAGE_SPECTRUM_INDEX;
  if (!catalog?.albums?.length) return;

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
    return (
      (leftIndex < 0 ? channelOrder.length : leftIndex) -
      (rightIndex < 0 ? channelOrder.length : rightIndex)
    );
  });

  const elements = {
    albumFilter: document.querySelector("#album-filter"),
    audio: document.querySelector("#audio"),
    bandcampPlayer: document.querySelector("#bandcamp-player"),
    duration: document.querySelector("#duration"),
    elapsed: document.querySelector("#elapsed"),
    next: document.querySelector("#next"),
    play: document.querySelector("#play"),
    playHost: document.querySelector("#play-host"),
    position: document.querySelector("#position"),
    previous: document.querySelector("#previous"),
    random: document.querySelector("#random"),
    search: document.querySelector("#search"),
    seekRow: document.querySelector("#seek-row"),
    spectrum: document.querySelector("#spectrum"),
    trackList: document.querySelector("#track-list"),
  };

  const tracks = orderedAlbums.flatMap((album) =>
    album.tracks.map((track) => ({ ...track, album })),
  );

  const alphaSort = (left, right) =>
    left.title.localeCompare(right.title, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.album.title.localeCompare(right.album.title, undefined, {
      sensitivity: "base",
    });

  const state = {
    album: "all",
    current: [...tracks].sort(alphaSort)[0],
    query: "",
    embedMode: false,
    embedReady: false,
    spectrumData: null,
    spectrumMeta: null,
    spectrumRequest: 0,
  };

  const spectrumFiles = new Map();
  const hashParams = new URLSearchParams(location.hash.slice(1));
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
      if (request === state.spectrumRequest) {
        state.spectrumMeta = null;
        state.spectrumData = null;
      }
    }
  }

  function playCurrent() {
    if (!state.current.audio) return;
    if (elements.audio.ended) elements.audio.currentTime = 0;
    elements.audio.play().catch(updatePlayButton);
  }

  function selectTrack(track, scroll = true, continuePlayback = isPlaying()) {
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
    const pool = visibleTracks();
    if (!pool.length) return;
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && next.id === state.current.id) {
      next = pool[(pool.indexOf(next) + 1) % pool.length];
    }
    selectTrack(next, true);
  }

  function animateDice() {
    elements.random.classList.remove("is-rolling");
    void elements.random.offsetWidth;
    elements.random.classList.add("is-rolling");
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
  elements.random.addEventListener("animationend", () => {
    elements.random.classList.remove("is-rolling");
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
  elements.audio.addEventListener("ended", () => adjacentTrack(1, true));
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
    if (
      event.target.matches("input, select, button") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
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
    const bands = spectrumIndex?.bands || 32;
    const levels = new Float32Array(bands);

    function resize() {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function draw() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);

      const active =
        isPlaying() && state.spectrumData && state.spectrumMeta && spectrumIndex;
      const fingerprint = fingerprints?.tracks?.[state.current.id];
      let frame = 0;
      let nextFrame = 0;
      let blend = 0;

      if (active) {
        const framePosition = elements.audio.currentTime * spectrumIndex.fps;
        frame = Math.min(
          state.spectrumMeta.frames - 1,
          Math.max(0, Math.floor(framePosition)),
        );
        nextFrame = Math.min(state.spectrumMeta.frames - 1, frame + 1);
        blend = framePosition - Math.floor(framePosition);
      }

      const gap = 2;
      const barWidth = Math.max(1, (width - gap * (bands - 1)) / bands);

      for (let index = 0; index < bands; index += 1) {
        let target = 0;
        if (active) {
          const current =
            state.spectrumData[frame * bands + index] || 0;
          const next =
            state.spectrumData[nextFrame * bands + index] || current;
          const raw = current + (next - current) * blend;
          const signal = Math.max(0, (raw - 5) / 170);
          target = signal < 0.035 ? 0 : Math.min(1, signal ** 0.78);
          levels[index] +=
            (target - levels[index]) * (target > levels[index] ? 0.42 : 0.18);
        } else if (state.embedMode && fingerprint?.length === bands) {
          const raw = fingerprint[index] || 0;
          const signal = Math.max(0, (raw - 5) / 170);
          target = signal < 0.035 ? 0 : Math.min(1, signal ** 0.78);
          levels[index] +=
            (target - levels[index]) * (target > levels[index] ? 0.34 : 0.18);
        } else {
          levels[index] = 0;
        }

        const barHeight =
          levels[index] < 0.008 ? 0 : levels[index] * (height - 6);
        if (barHeight > 0) {
          const x = index * (barWidth + gap);
          context.fillStyle = "#fff";
          context.fillRect(x, height - barHeight, barWidth, barHeight);
        }
      }

      requestAnimationFrame(draw);
    }

    resize();
    addEventListener("resize", resize, { passive: true });
    requestAnimationFrame(draw);
  }

  populateChannels();
  startSpectrum();
  selectTrack(state.current, false, false);
})();
