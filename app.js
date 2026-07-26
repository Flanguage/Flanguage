(() => {
  "use strict";

  const catalog = window.FLANGUAGE_CATALOG;
  if (!catalog?.albums?.length) return;

  const elements = {
    albumFilter: document.querySelector("#album-filter"),
    albumArt: document.querySelector("#album-art"),
    albumTitle: document.querySelector("#album-title"),
    archiveStats: document.querySelector("#archive-stats"),
    artLink: document.querySelector("#art-link"),
    clock: document.querySelector("#clock"),
    duration: document.querySelector("#track-duration"),
    next: document.querySelector("#next"),
    orderButtons: [...document.querySelectorAll(".order-button")],
    player: document.querySelector("#bandcamp-player"),
    previous: document.querySelector("#previous"),
    random: document.querySelector("#random"),
    releaseYear: document.querySelector("#release-year"),
    resultCount: document.querySelector("#result-count"),
    scopeButtons: [...document.querySelectorAll(".scope-button")],
    search: document.querySelector("#search"),
    signalNumber: document.querySelector("#signal-number"),
    spectrum: document.querySelector("#spectrum"),
    trackList: document.querySelector("#track-list"),
    trackNumber: document.querySelector("#track-number"),
    trackTitle: document.querySelector("#track-title"),
    visualizerToggle: document.querySelector("#visualizer-toggle"),
  };

  const tracks = catalog.albums.flatMap((album) =>
    album.tracks.map((track) => ({ ...track, album })),
  );

  const state = {
    current: tracks[0],
    album: "all",
    query: "",
    randomScope: "all",
    order: "album",
    spectrumOn: true,
  };

  const hashParams = new URLSearchParams(location.hash.slice(1));
  const initialTrack = Number(hashParams.get("track"));
  const initialAlbum = hashParams.get("album");
  const hashMatch = tracks.find((track) => track.id === initialTrack);

  if (hashMatch) state.current = hashMatch;
  if (
    initialAlbum &&
    catalog.albums.some((album) => album.slug === initialAlbum)
  ) {
    state.album = initialAlbum;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function totalDuration() {
    return tracks.reduce((total, track) => total + track.duration, 0);
  }

  function visibleTracks() {
    const query = state.query.trim().toLocaleLowerCase();
    const result = tracks.filter((track) => {
      const albumMatch =
        state.album === "all" || track.album.slug === state.album;
      const textMatch =
        !query ||
        track.title.toLocaleLowerCase().includes(query) ||
        track.album.title.toLocaleLowerCase().includes(query);
      return albumMatch && textMatch;
    });

    if (state.order === "alpha") {
      result.sort(
        (left, right) =>
          left.title.localeCompare(right.title, undefined, {
            numeric: true,
            sensitivity: "base",
          }) ||
          left.album.title.localeCompare(right.album.title, undefined, {
            sensitivity: "base",
          }),
      );
    }

    return result;
  }

  function randomPool() {
    if (state.randomScope === "album") {
      const album =
        state.album === "all" ? state.current.album.slug : state.album;
      return tracks.filter((track) => track.album.slug === album);
    }
    return tracks;
  }

  function embedUrl(track) {
    const params = [
      `album=${track.album.id}`,
      "size=small",
      "bgcol=07100b",
      "linkcol=65ff8f",
      `track=${track.id}`,
      "transparent=true",
    ];
    return `https://bandcamp.com/EmbeddedPlayer/${params.join("/")}/`;
  }

  function updateHash(track) {
    const params = new URLSearchParams({
      album: track.album.slug,
      track: String(track.id),
    });
    history.replaceState(null, "", `#${params}`);
  }

  function selectTrack(track, options = {}) {
    state.current = track;
    elements.albumArt.src = track.album.art;
    elements.albumArt.alt = `${track.album.title} album cover`;
    elements.albumTitle.textContent = track.album.title;
    elements.trackTitle.textContent = track.title;
    elements.trackNumber.textContent = `TRK ${String(track.number).padStart(2, "0")}`;
    elements.duration.textContent = formatTime(track.duration);
    elements.releaseYear.textContent = new Date(
      track.album.releaseDate,
    ).getUTCFullYear();
    elements.signalNumber.textContent = String(track.id % 1000).padStart(3, "0");
    elements.artLink.href = track.album.url;
    elements.player.src = embedUrl(track);
    elements.player.title = `Play ${track.title} by Flanguage on Bandcamp`;

    document.title = `${track.title} // Flanguage`;
    updateHash(track);
    renderTrackList();

    if (options.scroll) {
      requestAnimationFrame(() => {
        elements.trackList
          .querySelector(".track-row.active")
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }

  function renderTrackList() {
    const filtered = visibleTracks();
    elements.resultCount.textContent = `${filtered.length} ${
      filtered.length === 1 ? "TRACK" : "TRACKS"
    }`;
    elements.trackList.replaceChildren();

    if (!filtered.length) {
      const message = document.createElement("p");
      message.className = "empty-message";
      message.textContent = "NO SIGNALS FOUND // RETUNE SEARCH";
      elements.trackList.append(message);
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((track) => {
      const button = document.createElement("button");
      const active = track.id === state.current.id;
      button.className = `track-row${active ? " active" : ""}`;
      button.type = "button";
      button.dataset.trackId = track.id;
      button.setAttribute("aria-pressed", String(active));

      const index = document.createElement("span");
      index.className = "track-index";
      index.textContent = String(track.number).padStart(2, "0");

      const copy = document.createElement("span");
      copy.className = "track-copy";
      const title = document.createElement("strong");
      title.textContent = track.title;
      const album = document.createElement("small");
      album.textContent = track.album.title;
      copy.append(title, album);

      const time = document.createElement("span");
      time.className = "track-time";
      time.textContent = formatTime(track.duration);

      button.append(index, copy, time);
      fragment.append(button);
    });
    elements.trackList.append(fragment);
  }

  function adjacentTrack(direction) {
    const pool = visibleTracks();
    if (!pool.length) return;
    const currentIndex = pool.findIndex(
      (track) => track.id === state.current.id,
    );
    const start = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = (start + direction + pool.length) % pool.length;
    selectTrack(pool[nextIndex], { scroll: true });
  }

  function randomTrack() {
    const pool = randomPool();
    if (!pool.length) return;
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && next.id === state.current.id) {
      next = pool[(pool.indexOf(next) + 1) % pool.length];
    }
    selectTrack(next, { scroll: true });
  }

  function populateAlbums() {
    const fragment = document.createDocumentFragment();
    catalog.albums.forEach((album) => {
      const option = document.createElement("option");
      option.value = album.slug;
      option.textContent = `${album.title} (${album.tracks.length})`;
      fragment.append(option);
    });
    elements.albumFilter.append(fragment);
    elements.albumFilter.value = state.album;
  }

  function updateScopeButtons() {
    elements.scopeButtons.forEach((button) => {
      const active = button.dataset.scope === state.randomScope;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateOrderButtons() {
    elements.orderButtons.forEach((button) => {
      const active = button.dataset.order === state.order;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  elements.albumFilter.addEventListener("change", (event) => {
    state.album = event.target.value;
    renderTrackList();
    const first = visibleTracks()[0];
    if (first && state.album !== "all") selectTrack(first);
  });

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderTrackList();
  });

  elements.trackList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-track-id]");
    if (!row) return;
    const track = tracks.find(
      (candidate) => candidate.id === Number(row.dataset.trackId),
    );
    if (track) selectTrack(track);
  });

  elements.previous.addEventListener("click", () => adjacentTrack(-1));
  elements.next.addEventListener("click", () => adjacentTrack(1));
  elements.random.addEventListener("click", randomTrack);

  elements.scopeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.randomScope = button.dataset.scope;
      updateScopeButtons();
    });
  });

  elements.orderButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.order = button.dataset.order;
      updateOrderButtons();
      renderTrackList();
      requestAnimationFrame(() => {
        elements.trackList.scrollTop = 0;
      });
    });
  });

  elements.visualizerToggle.addEventListener("click", () => {
    state.spectrumOn = !state.spectrumOn;
    elements.visualizerToggle.textContent = `SPECTRUM: ${
      state.spectrumOn ? "ON" : "OFF"
    }`;
    elements.visualizerToggle.setAttribute(
      "aria-pressed",
      String(state.spectrumOn),
    );
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
    if (event.key === "ArrowLeft") adjacentTrack(-1);
    if (event.key === "ArrowRight") adjacentTrack(1);
    if (event.key.toLocaleLowerCase() === "r") randomTrack();
  });

  function startClock() {
    const update = () => {
      elements.clock.textContent = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());
    };
    update();
    setInterval(update, 1000);
  }

  function startSpectrum() {
    const canvas = elements.spectrum;
    const context = canvas.getContext("2d");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let phase = 0;

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

      const bars = Math.max(22, Math.min(54, Math.floor(width / 11)));
      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      const seed = state.current.id % 997;

      for (let index = 0; index < bars; index += 1) {
        const position = index / Math.max(1, bars - 1);
        const envelope =
          0.15 +
          Math.sin(position * Math.PI) * 0.6 +
          Math.sin(position * Math.PI * 3 + seed) * 0.08;
        const motion = state.spectrumOn
          ? Math.sin(phase * 1.8 + index * 0.57 + seed) * 0.12 +
            Math.sin(phase * 0.83 + index * 1.71) * 0.08
          : 0;
        const amplitude = Math.max(0.07, Math.min(0.94, envelope + motion));
        const barHeight = amplitude * (height - 14);
        const x = index * (barWidth + gap);
        const y = height - barHeight;

        const gradient = context.createLinearGradient(0, y, 0, height);
        gradient.addColorStop(0, "#c3ffd2");
        gradient.addColorStop(0.2, "#65ff8f");
        gradient.addColorStop(0.82, "#2c8a4b");
        gradient.addColorStop(1, "rgba(44, 138, 75, 0.2)");
        context.fillStyle = gradient;
        context.shadowColor = "rgba(101, 255, 143, 0.65)";
        context.shadowBlur = state.spectrumOn ? 7 : 2;
        context.fillRect(x, y, barWidth, barHeight);
      }

      phase += reducedMotion ? 0 : 0.035;
      requestAnimationFrame(draw);
    }

    resize();
    addEventListener("resize", resize, { passive: true });
    requestAnimationFrame(draw);
  }

  populateAlbums();
  updateScopeButtons();
  updateOrderButtons();
  startClock();
  startSpectrum();

  const hours = totalDuration() / 3600;
  elements.archiveStats.textContent = `${catalog.albums.length} ALBUMS // ${tracks.length} TRACKS // ${hours.toFixed(1)} HRS`;
  selectTrack(state.current);
})();
