(() => {
  "use strict";

  const defaultSkinIdentifier = "winampskin_fear";
  const maxSkinBytes = 5_000_000;
  const skinCacheName = "flanguage-winamp-skins-v1";
  const skinStorageKey = "flanguage-winamp-skin";
  const fearSkinFallback = {
    identifier: defaultSkinIdentifier,
    title: "Winamp Skin: fear",
    creator: "jaybeez",
    skinUrl: "https://archive.org/cors/winampskin_fear/fear.wsz",
  };

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
    const { audio, getSpectrumFrame, setActiveTrack, trackByUrl, setStatus } =
      options;

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
        this.listen("ended", () => this.emitter.trigger("ended"));
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

  function parseArchiveIdentifier(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("PASTE AN ARCHIVE.ORG SKIN URL_");

    let identifier = input;
    if (input.includes("://")) {
      const url = new URL(input);
      const hostname = url.hostname.toLocaleLowerCase();
      if (hostname !== "archive.org" && !hostname.endsWith(".archive.org")) {
        throw new Error("ONLY ARCHIVE.ORG SKINS ARE ALLOWED_");
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) =>
        ["details", "download", "cors", "metadata", "embed"].includes(part),
      );
      if (marker < 0 || !parts[marker + 1]) {
        throw new Error("ARCHIVE ITEM NOT FOUND IN URL_");
      }
      identifier = decodeURIComponent(parts[marker + 1]);
    }

    if (!/^[a-z0-9._-]+$/i.test(identifier)) {
      throw new Error("INVALID ARCHIVE ITEM IDENTIFIER_");
    }
    return identifier;
  }

  function firstValue(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function archiveSkinUrl(value, identifier) {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "archive.org" ||
      parts[0] !== "cors" ||
      decodeURIComponent(parts[1] || "") !== identifier ||
      !parts[2]
    ) {
      throw new Error("ARCHIVE RETURNED AN UNSAFE SKIN URL_");
    }
    return url.href;
  }

  function encodeArchivePath(path) {
    return String(path)
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  async function resolveArchiveSkin(value) {
    const identifier = parseArchiveIdentifier(value);
    let data;

    try {
      const response = await fetch(
        `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { mode: "cors" },
      );
      if (!response.ok) throw new Error(`METADATA ${response.status}`);
      data = await response.json();
    } catch (error) {
      if (identifier === defaultSkinIdentifier) return fearSkinFallback;
      throw new Error(`ARCHIVE METADATA UNAVAILABLE: ${error.message}_`);
    }

    const metadata = data?.metadata || {};
    let skinUrl;
    const webampLink = firstValue(metadata.webamp);
    if (webampLink) {
      try {
        skinUrl = new URL(webampLink).searchParams.get("skinUrl");
      } catch {
        skinUrl = null;
      }
    }

    if (!skinUrl) {
      const files = Array.isArray(data?.files) ? data.files : [];
      const skinFile =
        files.find(
          (file) =>
            file?.source === "original" && /\.wsz$/i.test(file?.name || ""),
        ) ||
        files.find((file) => /\.wsz$/i.test(file?.name || "")) ||
        files.find(
          (file) =>
            String(firstValue(metadata.skintype) || "").toLowerCase() === "wsz" &&
            /\.zip$/i.test(file?.name || ""),
        );
      if (skinFile?.name) {
        skinUrl = `https://archive.org/cors/${encodeURIComponent(identifier)}/${encodeArchivePath(skinFile.name)}`;
      }
    }

    if (!skinUrl) throw new Error("NO CLASSIC WINAMP SKIN FOUND IN ITEM_");
    return {
      identifier,
      title: String(firstValue(metadata.title) || identifier),
      creator: String(firstValue(metadata.creator) || "UNKNOWN CREATOR"),
      skinUrl: archiveSkinUrl(skinUrl, identifier),
    };
  }

  async function fetchSkinBlob(url) {
    let cache = null;
    let response = null;

    if ("caches" in window) {
      try {
        cache = await caches.open(skinCacheName);
        response = await cache.match(url);
      } catch {
        cache = null;
      }
    }

    if (!response) {
      response = await fetch(url, { mode: "cors" });
      if (!response.ok) throw new Error(`SKIN DOWNLOAD FAILED: ${response.status}_`);
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > maxSkinBytes) throw new Error("SKIN IS TOO LARGE_");
    }

    const blob = await response.blob();
    if (blob.size > maxSkinBytes) throw new Error("SKIN IS TOO LARGE_");

    if (cache && !response.headers.get("x-flanguage-cached")) {
      try {
        await cache.put(
          url,
          new Response(blob, {
            headers: {
              "Content-Type": blob.type || "application/octet-stream",
              "Content-Length": String(blob.size),
              "X-Flanguage-Cached": "1",
            },
          }),
        );
      } catch {
        // A full or disabled cache should not prevent the skin from loading.
      }
    }

    return blob;
  }

  window.createFlanguageWinampMode = async function createFlanguageWinampMode(
    options,
  ) {
    if (!window.Webamp?.browserIsSupported?.()) {
      throw new Error("THIS BROWSER CANNOT RUN WEBAMP_");
    }

    const {
      audio,
      getSpectrumFrame,
      host,
      initialTrackId,
      loadSkinButton,
      onTrackChange,
      placeholder,
      randomSkinButton,
      skinSelect,
      skinSource,
      skinStatus,
      skinUrlInput,
      tracks,
    } = options;

    const playableTracks = tracks.filter((track) => track.audio);
    if (!playableTracks.length) {
      throw new Error("DIRECT AUDIO STREAMS ARE AVAILABLE ON THE LIVE PAGE_");
    }

    const trackByUrl = new Map(playableTracks.map((track) => [track.audio, track]));
    const trackIndexById = new Map(
      playableTracks.map((track, index) => [track.id, index]),
    );
    let activeTrackId = null;
    let skinBlobUrl = null;
    let skinLoading = false;

    function setStatus(message, error = false) {
      skinStatus.textContent = message;
      skinStatus.classList.toggle("error", error);
    }

    function getActiveSpectrumFrame(trackId, time) {
      return getSpectrumFrame(trackId, time);
    }

    const MediaClass = createMediaClass({
      audio,
      getSpectrumFrame: getActiveSpectrumFrame,
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
        artist: "Flanguage",
        title: track.title,
        album: track.album.title,
      },
    }));

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
          size: { extraHeight: 3, extraWidth: 0 },
          closed: false,
        },
      },
    });

    webamp.onWillClose((cancel) => cancel());
    await webamp.renderInto(host);
    host.classList.add("ready");
    placeholder.hidden = true;

    function selectTrack(trackId, autoplay = false) {
      const index = trackIndexById.get(trackId);
      if (index == null) return false;
      if (!autoplay) webamp.stop();
      activeTrackId = trackId;
      webamp.setCurrentTrack(index);
      if (autoplay) webamp.play();
      onTrackChange(trackId);
      return true;
    }

    selectTrack(
      trackIndexById.has(initialTrackId)
        ? initialTrackId
        : playableTracks[0].id,
      false,
    );

    webamp.onTrackDidChange((trackInfo) => {
      const track = trackInfo?.url ? trackByUrl.get(trackInfo.url) : null;
      if (!track) return;
      activeTrackId = track.id;
      onTrackChange(track.id);
    });

    function reflectSkinChoice(skin) {
      Array.from(skinSelect.options)
        .filter((option) => option.dataset.custom === "true")
        .forEach((option) => option.remove());
      let option = Array.from(skinSelect.options).find(
        (candidate) => candidate.value === skin.identifier,
      );
      if (!option) {
        option = document.createElement("option");
        option.value = skin.identifier;
        option.dataset.custom = "true";
        option.textContent = `CUSTOM / ${skin.title.toLocaleUpperCase()}`;
        skinSelect.append(option);
      }
      skinSelect.value = skin.identifier;
    }

    function setSkinBusy(busy) {
      skinLoading = busy;
      skinSelect.disabled = busy;
      randomSkinButton.disabled = busy;
      loadSkinButton.disabled = busy;
      skinUrlInput.disabled = busy;
    }

    async function applyArchiveSkin(value) {
      if (skinLoading) return false;
      setSkinBusy(true);
      setStatus("CONTACTING ARCHIVE.ORG_");
      let nextBlobUrl = null;
      let loaded = false;

      try {
        const skin = await resolveArchiveSkin(value);
        setStatus(`DOWNLOADING ${skin.title.toLocaleUpperCase()}_`);
        const blob = await fetchSkinBlob(skin.skinUrl);
        nextBlobUrl = URL.createObjectURL(blob);
        webamp.setSkinFromUrl(nextBlobUrl);
        await webamp.skinIsLoaded();

        if (skinBlobUrl) URL.revokeObjectURL(skinBlobUrl);
        skinBlobUrl = nextBlobUrl;
        nextBlobUrl = null;
        reflectSkinChoice(skin);
        skinSource.href = `https://archive.org/details/${encodeURIComponent(skin.identifier)}`;
        skinSource.textContent = `${skin.title.toLocaleUpperCase()} / ARCHIVE.ORG`;
        writeStorage(skinStorageKey, skin.identifier);
        setStatus(
          `${skin.title.toLocaleUpperCase()} / ${skin.creator.toLocaleUpperCase()}_`,
        );
        loaded = true;
      } catch (error) {
        setStatus(error.message || "SKIN COULD NOT BE LOADED_", true);
      } finally {
        if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
        setSkinBusy(false);
      }
      return loaded;
    }

    skinSelect.addEventListener("change", () => {
      void applyArchiveSkin(skinSelect.value);
    });
    randomSkinButton.addEventListener("click", () => {
      const choices = Array.from(skinSelect.options).filter(
        (option) => option.dataset.custom !== "true",
      );
      if (!choices.length) return;
      const current = choices.findIndex(
        (option) => option.value === skinSelect.value,
      );
      let index = Math.floor(Math.random() * choices.length);
      if (choices.length > 1 && index === current) index = (index + 1) % choices.length;
      void applyArchiveSkin(choices[index].value);
    });
    loadSkinButton.addEventListener("click", () => {
      void applyArchiveSkin(skinUrlInput.value);
    });
    skinUrlInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void applyArchiveSkin(skinUrlInput.value);
    });

    const initialSkin = readStorage(skinStorageKey) || defaultSkinIdentifier;
    void (async () => {
      const loaded = await applyArchiveSkin(initialSkin);
      if (!loaded && initialSkin !== defaultSkinIdentifier) {
        await applyArchiveSkin(defaultSkinIdentifier);
      }
    })();

    return {
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
        webamp.play();
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
