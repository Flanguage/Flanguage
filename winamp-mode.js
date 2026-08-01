(() => {
  "use strict";

  const museumEndpoint = "https://skins.webamp.org/graphql";
  const museumCdnOrigin = "https://r2.webampskins.org";
  const fearSkinMd5 = "9939a355baa122d98bda12e99b22bcc7";
  const catalogTargetSize = 500;
  const randomBatchSize = 24;
  const maxSkinBytes = 5_000_000;
  const maxCachedSkins = 24;
  const skinCacheName = "flanguage-webamp-skins-v2";
  const skinStorageKey = "flanguage-winamp-museum-skin";
  const legacySkinStorageKey = "flanguage-winamp-skin";
  const catalogQuery = `
    query Catalog($first: Int!, $offset: Int!) {
      skins(first: $first, offset: $offset, sort: MUSEUM) {
        count
        nodes {
          md5
          filename(normalize_extension: true)
          download_url
          nsfw
        }
      }
    }
  `;
  const skinByMd5Query = `
    query SkinByMd5($md5: String!) {
      fetch_skin_by_md5(md5: $md5) {
        md5
        filename(normalize_extension: true)
        download_url
        nsfw
      }
    }
  `;

  class TinyEmitter {
    constructor() {
      this.listeners = new Map();
    }

    on(event, callback) {
      const callbacks = this.listeners.get(event) || new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    }

    trigger(event, ...values) {
      this.listeners.get(event)?.forEach((callback) => callback(...values));
    }

    dispose() {
      this.listeners.clear();
    }
  }

  class SpectrumAnalyser {
    constructor(getFrame, getTime, getPlaying) {
      this.getFrame = getFrame;
      this.getTime = getTime;
      this.getPlaying = getPlaying;
      this.context = null;
      this.smoothingTimeConstant = 0;
      this._fftSize = 1024;
      this.levels = new Float32Array(20);
      this.bins = new Uint16Array(20);
    }

    get fftSize() {
      return this._fftSize;
    }

    set fftSize(value) {
      this._fftSize = Number.isFinite(value) ? Math.max(32, value) : 1024;
    }

    get frequencyBinCount() {
      return Math.floor(this._fftSize / 2);
    }

    getByteTimeDomainData(output) {
      output.fill(128);
      if (!this.getPlaying()) return;

      const frame = this.getFrame();
      if (!frame?.length) return;

      const partialCount = Math.min(20, frame.length);
      let activePartials = 0;

      for (let index = 0; index < partialCount; index += 1) {
        const position = partialCount === 1 ? 0 : index / (partialCount - 1);
        const sourceIndex = Math.min(
          frame.length - 1,
          Math.round(position ** 1.35 * (frame.length - 1)),
        );
        const normalized = Math.max(
          0,
          Math.min(1, (Number(frame[sourceIndex] || 0) - 10) / 170),
        );
        this.levels[index] = normalized < 0.04 ? 0 : normalized ** 1.08;
        this.bins[index] = Math.round(2 * 120 ** position);
        if (this.levels[index] > 0) activePartials += 1;
      }

      if (!activePartials) return;
      const scale = 96 / Math.sqrt(activePartials);
      const time = this.getTime();

      for (let sample = 0; sample < output.length; sample += 1) {
        let value = 0;
        for (let partial = 0; partial < partialCount; partial += 1) {
          if (!this.levels[partial]) continue;
          const phase =
            partial * 2.399963 + time * this.bins[partial] * 0.37;
          value +=
            Math.sin(
              2 *
                Math.PI *
                ((this.bins[partial] * sample) / output.length) +
                phase,
            ) * this.levels[partial];
        }
        output[sample] = Math.max(
          0,
          Math.min(255, Math.round(128 + value * scale)),
        );
      }
    }
  }

  function createMediaClass(options) {
    const {
      audio,
      getSpectrumFrame,
      onEnded,
      setActiveTrack,
      trackByUrl,
      setStatus,
    } = options;

    return class FlanguageWebampMedia {
      constructor() {
        this.emitter = new TinyEmitter();
        this.audio = audio;
        this.audio.removeAttribute("crossorigin");
        this.audio.preload = "metadata";
        this.audio.playsInline = true;
        this.activeTrackId = null;
        this.disposers = [];
        this.analyser = new SpectrumAnalyser(
          () => getSpectrumFrame(this.activeTrackId, this.audio.currentTime),
          () => this.audio.currentTime || 0,
          () => !this.audio.paused && !this.audio.ended,
        );

        this.listen("timeupdate", () => this.emitter.trigger("timeupdate"));
        this.listen("loadedmetadata", () => {
          this.emitter.trigger("fileLoaded");
          this.emitter.trigger("stopWaiting");
          this.emitter.trigger("timeupdate");
        });
        this.listen("durationchange", () => this.emitter.trigger("fileLoaded"));
        this.listen("playing", () => {
          this.emitter.trigger("stopWaiting");
          this.emitter.trigger("playing");
        });
        this.listen("waiting", () => this.emitter.trigger("waiting"));
        this.listen("stalled", () => this.emitter.trigger("waiting"));
        this.listen("canplay", () => this.emitter.trigger("stopWaiting"));
        this.listen("ended", () => {
          this.emitter.trigger("ended");
          onEnded(this.activeTrackId);
        });
        this.listen("error", () => {
          this.emitter.trigger("stopWaiting");
          setStatus("AUDIO STREAM ERROR. TRY TERMINAL MODE_", true);
        });
      }

      listen(event, callback) {
        this.audio.addEventListener(event, callback);
        this.disposers.push(() => this.audio.removeEventListener(event, callback));
      }

      on(event, callback) {
        return this.emitter.on(event, callback);
      }

      duration() {
        const duration = this.audio.duration;
        return Number.isFinite(duration) ? duration : 0;
      }

      timeElapsed() {
        return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
      }

      async play() {
        if (this.audio.ended) this.audio.currentTime = 0;
        try {
          await this.audio.play();
        } catch {
          setStatus("TAP WINAMP PLAY TO START AUDIO_", false);
        }
      }

      pause() {
        this.audio.pause();
      }

      stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.emitter.trigger("timeupdate");
      }

      seekToPercentComplete(percent) {
        const duration = this.duration();
        if (!duration) return;
        this.audio.currentTime = Math.max(
          0,
          Math.min(duration, duration * (percent / 100)),
        );
        this.emitter.trigger("timeupdate");
      }

      async loadFromUrl(url, autoPlay) {
        this.emitter.trigger("waiting");
        const track = trackByUrl.get(url);
        this.activeTrackId = track?.id || null;
        setActiveTrack(this.activeTrackId);

        if (this.audio.src !== url) {
          this.audio.pause();
          this.audio.src = url;
          this.audio.load();
        }

        this.emitter.trigger("stopWaiting");
        if (autoPlay) await this.play();
      }

      setVolume(volume) {
        this.audio.volume = Math.max(0, Math.min(1, volume / 100));
      }

      setBalance() {}

      setPreamp() {}

      setEqBand() {}

      disableEq() {}

      enableEq() {}

      getAnalyser() {
        return this.analyser;
      }

      dispose() {
        this.audio.pause();
        this.disposers.splice(0).forEach((dispose) => dispose());
        this.emitter.dispose();
      }
    };
  }

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
      // Private browsing can disable storage without disabling playback.
    }
  }

  function isSkinMd5(value) {
    return /^[a-f0-9]{32}$/.test(String(value || "").toLowerCase());
  }

  function canonicalSkinUrl(md5) {
    const normalized = String(md5 || "").toLowerCase();
    if (!isSkinMd5(normalized)) throw new Error("INVALID SKIN IDENTIFIER_");
    return `${museumCdnOrigin}/skins/${normalized}.wsz`;
  }

  function cleanSkinName(value, md5) {
    const name = String(value || "")
      .replace(/\.wsz$/i, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (name || `SKIN ${md5.slice(0, 8)}`).slice(0, 80);
  }

  function normalizeMuseumSkin(node) {
    if (!node || node.nsfw !== false) return null;
    const md5 = String(node.md5 || "").toLowerCase();
    if (!isSkinMd5(md5)) return null;

    const skinUrl = canonicalSkinUrl(md5);
    if (String(node.download_url || "") !== skinUrl) return null;

    try {
      const parsed = new URL(skinUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.origin !== museumCdnOrigin ||
        parsed.pathname !== `/skins/${md5}.wsz` ||
        parsed.search ||
        parsed.hash
      ) {
        return null;
      }
    } catch {
      return null;
    }

    return {
      md5,
      name: cleanSkinName(node.filename, md5),
      skinUrl,
    };
  }

  function fearSkin() {
    return {
      md5: fearSkinMd5,
      name: "Fear",
      skinUrl: canonicalSkinUrl(fearSkinMd5),
    };
  }

  function readStoredSkinMd5() {
    const current = String(readStorage(skinStorageKey) || "").toLowerCase();
    if (isSkinMd5(current)) return current;

    const legacy = String(readStorage(legacySkinStorageKey) || "").toLowerCase();
    const migrated = isSkinMd5(legacy) ? legacy : fearSkinMd5;
    if (legacy || current) writeStorage(skinStorageKey, migrated);
    return migrated;
  }

  async function fetchWithTimeout(url, init, timeout = 20_000) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), timeout)
      : null;
    try {
      return await fetch(url, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer != null) window.clearTimeout(timer);
    }
  }

  async function requestMuseum(query, variables) {
    let response;
    try {
      response = await fetchWithTimeout(museumEndpoint, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error("SKIN CATALOG UNAVAILABLE_");
    }

    if (!response.ok) {
      throw new Error(`SKIN CATALOG ERROR ${response.status}_`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("SKIN CATALOG RETURNED INVALID DATA_");
    }

    if (payload?.errors?.length || !payload?.data) {
      throw new Error("SKIN CATALOG QUERY FAILED_");
    }
    return payload.data;
  }

  async function fetchMuseumPage(first, offset) {
    const data = await requestMuseum(catalogQuery, { first, offset });
    const connection = data?.skins;
    const count = Number(connection?.count);
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(connection?.nodes)) {
      throw new Error("SKIN CATALOG RETURNED INVALID DATA_");
    }

    return {
      count,
      records: connection.nodes.map(normalizeMuseumSkin).filter(Boolean),
    };
  }

  async function fetchMuseumSkin(md5) {
    const data = await requestMuseum(skinByMd5Query, { md5 });
    return normalizeMuseumSkin(data?.fetch_skin_by_md5);
  }

  async function fetchInitialCatalog() {
    const records = [];
    const seen = new Set();
    let count = 0;
    let offset = 0;
    let requestSize = catalogTargetSize;
    let attempts = 0;

    while (records.length < catalogTargetSize && attempts < 6) {
      const page = await fetchMuseumPage(requestSize, offset);
      count = page.count;
      page.records.forEach((record) => {
        if (seen.has(record.md5) || records.length >= catalogTargetSize) return;
        seen.add(record.md5);
        records.push(record);
      });

      offset += requestSize;
      attempts += 1;
      if (offset >= count) break;
      requestSize = Math.min(100, catalogTargetSize - records.length);
      if (requestSize < 1) break;
    }

    return { count, records };
  }

  async function responseToLimitedBlob(response) {
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declaredSize) && declaredSize > maxSkinBytes) {
      throw new Error("SKIN IS TOO LARGE_");
    }

    const type = response.headers.get("content-type") || "application/octet-stream";
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxSkinBytes) {
          await reader.cancel();
          throw new Error("SKIN IS TOO LARGE_");
        }
        chunks.push(value);
      }
      return new Blob(chunks, { type });
    }

    const blob = await response.blob();
    if (blob.size > maxSkinBytes) throw new Error("SKIN IS TOO LARGE_");
    return blob;
  }

  async function validateSkinBlob(blob) {
    if (!blob || blob.size < 4 || blob.size > maxSkinBytes) {
      throw new Error(blob?.size > maxSkinBytes ? "SKIN IS TOO LARGE_" : "SKIN FILE IS INVALID_");
    }
    const prefix = blob.slice(0, 4);
    let bytes;
    if (typeof prefix.arrayBuffer === "function") {
      bytes = await prefix.arrayBuffer();
    } else {
      bytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result), { once: true });
        reader.addEventListener("error", () => reject(reader.error), { once: true });
        reader.readAsArrayBuffer(prefix);
      });
    }
    const signature = new Uint8Array(bytes);
    const validZip =
      signature[0] === 0x50 &&
      signature[1] === 0x4b &&
      ((signature[2] === 0x03 && signature[3] === 0x04) ||
        (signature[2] === 0x05 && signature[3] === 0x06) ||
        (signature[2] === 0x07 && signature[3] === 0x08));
    if (!validZip) throw new Error("SKIN FILE IS NOT A WINAMP ARCHIVE_");
    return blob;
  }

  async function openSkinCache() {
    if (!("caches" in window)) return null;
    try {
      return await caches.open(skinCacheName);
    } catch {
      return null;
    }
  }

  async function trimSkinCache(cache) {
    try {
      const keys = await cache.keys();
      const excess = keys.length - maxCachedSkins;
      if (excess > 0) {
        await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
      }
    } catch {
      // Cache eviction is best effort.
    }
  }

  async function fetchSkinBlob(skinUrl) {
    const parsed = new URL(skinUrl);
    const md5 = parsed.pathname.match(/^\/skins\/([a-f0-9]{32})\.wsz$/)?.[1];
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== museumCdnOrigin ||
      !md5 ||
      parsed.href !== canonicalSkinUrl(md5)
    ) {
      throw new Error("SKIN URL WAS REJECTED_");
    }

    const cache = await openSkinCache();
    if (cache) {
      try {
        const cached = await cache.match(skinUrl);
        if (cached) return await validateSkinBlob(await responseToLimitedBlob(cached));
      } catch {
        try {
          await cache.delete(skinUrl);
        } catch {
          // A bad cache entry should never block a clean network request.
        }
      }
    }

    let response;
    try {
      response = await fetchWithTimeout(
        skinUrl,
        {
          mode: "cors",
          credentials: "omit",
          redirect: "error",
        },
        25_000,
      );
    } catch {
      throw new Error("SKIN DOWNLOAD FAILED_");
    }
    if (!response.ok) throw new Error(`SKIN DOWNLOAD FAILED: ${response.status}_`);
    if (response.url && response.url !== skinUrl) throw new Error("SKIN URL WAS REJECTED_");

    const blob = await validateSkinBlob(await responseToLimitedBlob(response));
    if (cache) {
      try {
        await cache.put(
          skinUrl,
          new Response(blob, {
            headers: {
              "Content-Type": blob.type || "application/octet-stream",
              "Content-Length": String(blob.size),
            },
          }),
        );
        await trimSkinCache(cache);
      } catch {
        // Playback does not depend on persistent browser cache availability.
      }
    }
    return blob;
  }

  function getViewportSize(viewport) {
    const rect = viewport.getBoundingClientRect?.() || {};
    return {
      width: Number(rect.width) || viewport.clientWidth || window.innerWidth || 275,
      height: Number(rect.height) || viewport.clientHeight || window.innerHeight || 232,
    };
  }

  function getInitialWindowLayout(viewport) {
    const { width, height } = getViewportSize(viewport);
    const preferredScale = Math.min(1.5, width / 275);
    const extraHeight = Math.max(
      0,
      Math.min(14, Math.floor((height / preferredScale - 232) / 29)),
    );
    return {
      extraHeight,
      groupHeight: 232 + 29 * extraHeight,
    };
  }

  const lockedWebampSelectors = [
    "#close",
    "#minimize",
    "#shade",
    "#option",
    "#eject",
    "#equalizer-button",
    "#playlist-button",
    "#playlist-close-button",
    "#playlist-shade-button",
    "#playlist-resize-target",
    "#playlist-add-menu",
    "#playlist-remove-menu",
    "#playlist-selection-menu",
    "#playlist-misc-menu",
    "#playlist-list-menu",
    ".playlist-eject-button",
  ].join(",");

  function lockWebampChrome(host) {
    host.querySelectorAll(lockedWebampSelectors).forEach((element) => {
      element.style.setProperty("pointer-events", "none", "important");
      element.setAttribute("aria-hidden", "true");
      if ("tabIndex" in element) element.tabIndex = -1;
    });
  }

  function shouldBlockWebampEvent(event) {
    const target = event.target;
    return Boolean(
      target?.classList?.contains("draggable") ||
        target?.closest?.(lockedWebampSelectors),
    );
  }

  window.createFlanguageWinampMode = async function createFlanguageWinampMode(
    options,
  ) {
    if (!window.Webamp?.browserIsSupported?.()) {
      throw new Error("THIS BROWSER CANNOT RUN WEBAMP_");
    }

    const audio = options.audio;
    const host = options.host;
    const viewport = options.viewport || host?.parentElement;
    const skinSelect = options.select || options.skinSelect;
    const randomSkinButton = options.randomButton || options.randomSkinButton;
    const skinStatus = options.status || options.skinStatus;
    const placeholder = options.placeholder;
    const sourceTracks = options.initialTracks || options.tracks || [];
    const getSpectrumFrame = options.onSpectrum || options.getSpectrumFrame || (() => null);
    const onTrackChange = options.onTrackChange || (() => {});
    const onEnded = options.onEnded || (() => {});

    if (!audio || !host || !viewport || !skinSelect || !randomSkinButton || !skinStatus) {
      throw new Error("WINAMP MODE CONTROLS ARE INCOMPLETE_");
    }

    const playableTracks = sourceTracks
      .filter((track) => track?.audio)
      .map((track, index) => ({
        ...track,
        id: track.id || track.audio || `track-${index}`,
      }));
    if (!playableTracks.length) {
      throw new Error("DIRECT AUDIO STREAMS ARE AVAILABLE ON THE LIVE PAGE_");
    }

    const trackByUrl = new Map(playableTracks.map((track) => [track.audio, track]));
    const trackById = new Map(playableTracks.map((track) => [track.id, track]));
    const skinRecords = new Map();
    let activeTrackId = null;
    let activeSkinMd5 = null;
    let catalogCount = 0;
    let skinBlobUrl = null;
    let skinLoading = false;
    let disposed = false;

    function setStatus(message, error = false) {
      skinStatus.textContent = message;
      skinStatus.classList.toggle("error", error);
    }

    function safeSpectrumFrame(trackId, time) {
      try {
        return getSpectrumFrame(trackId, time);
      } catch {
        return null;
      }
    }

    const MediaClass = createMediaClass({
      audio,
      getSpectrumFrame: safeSpectrumFrame,
      onEnded(trackId) {
        onEnded(trackId);
      },
      setActiveTrack(trackId) {
        activeTrackId = trackId;
      },
      setStatus,
      trackByUrl,
    });

    const webampTracks = playableTracks.map((track) => ({
      url: track.audio,
      duration: track.duration,
      metaData: {
        artist: track.artist || "Flanguage",
        title: track.title || "Untitled",
        album: track.album?.title || track.album || "Flanguage",
      },
    }));

    const initialLayout = getInitialWindowLayout(viewport);
    const stageHeight = initialLayout.groupHeight;
    host.style.position = "absolute";
    host.style.left = "50%";
    host.style.top = "50%";
    host.style.width = "275px";
    host.style.height = `${stageHeight}px`;
    host.style.transformOrigin = "50% 50%";
    try {
      if (getComputedStyle(viewport).position === "static") {
        viewport.style.position = "relative";
      }
    } catch {
      viewport.style.position = "relative";
    }

    function fitStage() {
      const { width, height } = getViewportSize(viewport);
      const scale = Math.max(
        0.01,
        Math.min(1.5, width / 275, height / stageHeight),
      );
      host.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }
    fitStage();

    const webamp = new window.Webamp({
      initialTracks: webampTracks,
      __customMediaClass: MediaClass,
      enableDoubleSizeMode: false,
      enableHotkeys: false,
      enableMediaSession: false,
      zIndex: 10,
      windowLayout: {
        main: {
          position: { top: 0, left: 0 },
          closed: false,
        },
        playlist: {
          position: { top: 116, left: 0 },
          size: { extraHeight: initialLayout.extraHeight, extraWidth: 0 },
          closed: false,
        },
      },
    });

    webamp.onWillClose((cancel) => cancel());
    await webamp.renderInto(host);
    host.classList.add("ready");
    viewport.classList.add("ready");
    if (placeholder) placeholder.hidden = true;

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => fitStage())
        : null;
    resizeObserver?.observe(viewport);
    window.addEventListener("resize", fitStage);

    const blockChromeEvent = (event) => {
      if (!shouldBlockWebampEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const blockDropEvent = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    ["pointerdown", "mousedown", "touchstart", "dblclick", "contextmenu"].forEach(
      (eventName) => host.addEventListener(eventName, blockChromeEvent, true),
    );
    ["dragenter", "dragover", "drop"].forEach((eventName) =>
      host.addEventListener(eventName, blockDropEvent, true),
    );
    lockWebampChrome(host);
    const chromeObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => lockWebampChrome(host))
        : null;
    chromeObserver?.observe(host, { childList: true, subtree: true });

    function selectTrack(trackId, autoplay = false) {
      const target = trackById.get(trackId);
      if (!target) return false;
      const index = webamp
        .getPlaylistTracks()
        .findIndex((item) => item.url === target.audio);
      if (index < 0) return false;
      if (!autoplay) webamp.stop();
      activeTrackId = target.id;
      webamp.setCurrentTrack(index);
      if (autoplay) webamp.play();
      onTrackChange(target.id);
      return true;
    }

    const initialTrackId = trackById.has(options.initialTrackId)
      ? options.initialTrackId
      : playableTracks[0].id;
    selectTrack(initialTrackId, false);

    webamp.onTrackDidChange((trackInfo) => {
      const track = trackInfo?.url ? trackByUrl.get(trackInfo.url) : null;
      if (!track) return;
      activeTrackId = track.id;
      onTrackChange(track.id);
    });

    function addSkinRecord(record) {
      skinRecords.set(record.md5, record);
      return record;
    }

    function createSkinOption(record, transient = false) {
      const option = document.createElement("option");
      option.value = record.md5;
      option.textContent = record.name;
      if (transient) option.dataset.transient = "true";
      return option;
    }

    function populateSkinSelect(records) {
      skinSelect.textContent = "";
      const fragment = document.createDocumentFragment();
      records.forEach((record) => {
        addSkinRecord(record);
        fragment.append(createSkinOption(record));
      });
      skinSelect.append(fragment);
    }

    function reflectSkinChoice(record) {
      Array.from(skinSelect.options)
        .filter((option) => option.dataset.transient === "true")
        .forEach((option) => option.remove());
      let option = Array.from(skinSelect.options).find(
        (candidate) => candidate.value === record.md5,
      );
      if (!option) {
        option = createSkinOption(record, true);
        skinSelect.append(option);
      }
      addSkinRecord(record);
      skinSelect.value = record.md5;
    }

    function setSkinBusy(busy) {
      skinLoading = busy;
      skinSelect.disabled = busy || skinSelect.options.length === 0;
      randomSkinButton.disabled = busy || catalogCount < 1;
    }

    async function loadSkinRecord(record) {
      let nextBlobUrl = null;
      try {
        setStatus(`LOADING ${record.name.toLocaleUpperCase()}_`);
        const blob = await fetchSkinBlob(record.skinUrl);
        if (disposed) return false;
        nextBlobUrl = URL.createObjectURL(blob);
        webamp.setSkinFromUrl(nextBlobUrl);
        await webamp.skinIsLoaded();
        if (disposed) return false;

        if (skinBlobUrl) URL.revokeObjectURL(skinBlobUrl);
        skinBlobUrl = nextBlobUrl;
        nextBlobUrl = null;
        activeSkinMd5 = record.md5;
        reflectSkinChoice(record);
        writeStorage(skinStorageKey, record.md5);
        setStatus(`${record.name.toLocaleUpperCase()}_`);
        return true;
      } catch (error) {
        setStatus(error.message || "SKIN COULD NOT BE LOADED_", true);
        return false;
      } finally {
        if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
      }
    }

    async function applySkin(record) {
      if (skinLoading || !record) return false;
      setSkinBusy(true);
      try {
        return await loadSkinRecord(record);
      } finally {
        setSkinBusy(false);
      }
    }

    async function chooseRandomSkin() {
      if (skinLoading || catalogCount < 1) return;
      setSkinBusy(true);
      setStatus("CHOOSING A RANDOM SKIN_");
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const pageSize = Math.min(randomBatchSize, catalogCount);
          const maxOffset = Math.max(0, catalogCount - pageSize);
          const offset = Math.floor(Math.random() * (maxOffset + 1));
          const page = await fetchMuseumPage(pageSize, offset);
          catalogCount = page.count;
          const choices = page.records.filter(
            (record) => record.md5 !== activeSkinMd5,
          );
          if (!choices.length) continue;
          const record = choices[Math.floor(Math.random() * choices.length)];
          addSkinRecord(record);
          await loadSkinRecord(record);
          return;
        }
        throw new Error("NO SAFE RANDOM SKIN FOUND_");
      } catch (error) {
        setStatus(error.message || "RANDOM SKIN UNAVAILABLE_", true);
      } finally {
        setSkinBusy(false);
      }
    }

    const onSkinSelect = () => {
      const md5 = String(skinSelect.value || "").toLowerCase();
      void applySkin(skinRecords.get(md5));
    };
    const onRandomSkin = () => void chooseRandomSkin();
    skinSelect.addEventListener("change", onSkinSelect);
    randomSkinButton.addEventListener("click", onRandomSkin);
    setSkinBusy(true);

    void (async () => {
      let desiredSkin = fearSkin();
      try {
        setStatus("LOADING SKIN CATALOG_");
        const catalog = await fetchInitialCatalog();
        if (disposed) return;
        catalogCount = catalog.count;
        populateSkinSelect(catalog.records);

        const storedMd5 = readStoredSkinMd5();
        desiredSkin = skinRecords.get(storedMd5) || null;
        if (!desiredSkin && storedMd5 !== fearSkinMd5) {
          try {
            desiredSkin = await fetchMuseumSkin(storedMd5);
          } catch {
            desiredSkin = null;
          }
        }
        desiredSkin = desiredSkin || fearSkin();
      } catch {
        catalogCount = 0;
        desiredSkin = fearSkin();
        populateSkinSelect([]);
        setStatus("SKIN CATALOG OFFLINE. LOADING FEAR_", true);
      } finally {
        if (!disposed) setSkinBusy(false);
      }

      if (disposed) return;
      let loaded = await applySkin(desiredSkin);
      if (!loaded && desiredSkin.md5 !== fearSkinMd5) {
        loaded = await applySkin(fearSkin());
      }
      if (!loaded && skinSelect.options.length === 0) {
        reflectSkinChoice(fearSkin());
        setSkinBusy(false);
      }
    })();

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        resizeObserver?.disconnect();
        chromeObserver?.disconnect();
        window.removeEventListener("resize", fitStage);
        ["pointerdown", "mousedown", "touchstart", "dblclick", "contextmenu"].forEach(
          (eventName) => host.removeEventListener(eventName, blockChromeEvent, true),
        );
        ["dragenter", "dragover", "drop"].forEach((eventName) =>
          host.removeEventListener(eventName, blockDropEvent, true),
        );
        skinSelect.removeEventListener("change", onSkinSelect);
        randomSkinButton.removeEventListener("click", onRandomSkin);
        if (skinBlobUrl) URL.revokeObjectURL(skinBlobUrl);
        webamp.dispose?.();
      },
      isPlaying() {
        return webamp.getMediaStatus() === "PLAYING";
      },
      next() {
        webamp.nextTrack();
      },
      pause() {
        if (webamp.getMediaStatus() === "PLAYING") webamp.pause();
      },
      play() {
        return webamp.play();
      },
      previous() {
        webamp.previousTrack();
      },
      random() {
        if (!playableTracks.length) return;
        let index = Math.floor(Math.random() * playableTracks.length);
        if (
          playableTracks.length > 1 &&
          playableTracks[index].id === activeTrackId
        ) {
          index = (index + 1) % playableTracks.length;
        }
        selectTrack(playableTracks[index].id, true);
      },
      selectTrack,
    };
  };
})();
