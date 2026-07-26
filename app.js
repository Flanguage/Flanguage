(() => {
  "use strict";

  const catalog = window.FLANGUAGE_CATALOG;
  if (!catalog?.albums?.length) return;

  const elements = {
    albumFilter: document.querySelector("#album-filter"),
    next: document.querySelector("#next"),
    player: document.querySelector("#bandcamp-player"),
    previous: document.querySelector("#previous"),
    random: document.querySelector("#random"),
    search: document.querySelector("#search"),
    spectrum: document.querySelector("#spectrum"),
    trackList: document.querySelector("#track-list"),
  };

  const tracks = catalog.albums.flatMap((album) =>
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
    spectrumKick: 1,
  };

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

  function updateHash(track) {
    const params = new URLSearchParams({
      album: track.album.slug,
      track: String(track.id),
    });
    history.replaceState(null, "", `#${params}`);
  }

  function selectTrack(track, scroll = false) {
    state.current = track;
    state.spectrumKick = 1;
    elements.player.src = embedUrl(track);
    elements.player.title = `Play ${track.title} by Flanguage`;
    document.title = `${track.title} // Flanguage`;
    updateHash(track);
    renderTracks();

    if (scroll) {
      requestAnimationFrame(() => {
        elements.trackList
          .querySelector(".track-row.active")
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

  function adjacentTrack(direction) {
    const pool = visibleTracks();
    if (!pool.length) return;
    const index = pool.findIndex((track) => track.id === state.current.id);
    const start = index < 0 ? 0 : index;
    selectTrack(pool[(start + direction + pool.length) % pool.length], true);
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

  function populateChannels() {
    const fragment = document.createDocumentFragment();
    catalog.albums.forEach((album, index) => {
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
    if (first) selectTrack(first);
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
    if (track) selectTrack(track);
  });

  elements.previous.addEventListener("click", () => adjacentTrack(-1));
  elements.next.addEventListener("click", () => adjacentTrack(1));
  elements.random.addEventListener("click", randomTrack);

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
    if (event.key === "ArrowLeft") adjacentTrack(-1);
    if (event.key === "ArrowRight") adjacentTrack(1);
    if (event.key.toLocaleLowerCase() === "r") randomTrack();
  });

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

      const count = Math.max(30, Math.min(64, Math.floor(width / 8)));
      const gap = 2;
      const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
      const seed = state.current.id % 521;

      for (let index = 0; index < count; index += 1) {
        const normalized = index / Math.max(1, count - 1);
        const bass = Math.exp(-normalized * 2.1) * 0.32;
        const middle = Math.sin(normalized * Math.PI) * 0.42;
        const trackShape =
          Math.sin(normalized * (6 + (seed % 5)) + seed) * 0.08;
        const motion =
          Math.sin(phase * 1.5 + index * 0.55 + seed) * 0.13 +
          Math.sin(phase * 0.67 + index * 1.37) * 0.07;
        const amplitude = Math.max(
          0.03,
          Math.min(
            0.96,
            0.1 +
              bass +
              middle +
              trackShape +
              motion * state.spectrumKick,
          ),
        );
        const barHeight = Math.max(2, amplitude * (height - 8));
        const x = index * (barWidth + gap);
        context.fillStyle = "#fff";
        context.fillRect(x, height - barHeight, barWidth, barHeight);
      }

      state.spectrumKick += (0.72 - state.spectrumKick) * 0.018;
      if (!reducedMotion) phase += 0.04;
      requestAnimationFrame(draw);
    }

    resize();
    addEventListener("resize", resize, { passive: true });
    requestAnimationFrame(draw);
  }

  populateChannels();
  startSpectrum();
  selectTrack(state.current);
})();
