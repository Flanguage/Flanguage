import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const BANDS = 32;
const SAMPLE_SECONDS = 8;
const SAMPLE_POSITIONS = [0];
const CONCURRENCY = Number(process.env.FINGERPRINT_CONCURRENCY || 4);
const TRACK_LIMIT = Number(process.env.FINGERPRINT_TRACK_LIMIT || 0);
const FFMPEG_TIMEOUT_MS = 120_000;
const catalogPath = new URL("../data/catalog.js", import.meta.url);
const outputPath = new URL("../data/fingerprints.js", import.meta.url);

function parseCatalog(source) {
  const prefix = "window.FLANGUAGE_CATALOG = ";
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error("Could not find FLANGUAGE_CATALOG.");
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function parseTralbum(html) {
  const match = html.match(/data-tralbum="([^"]+)"/);
  if (!match) throw new Error("Bandcamp page did not include album data.");
  return JSON.parse(decodeEntities(match[1]));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "FlanguagePagesFingerprint/1.0" },
  });
  if (!response.ok) throw new Error(`${response.status} while loading ${url}`);
  return response.text();
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function sampleStarts(duration) {
  const latestStart = Math.max(0, duration - SAMPLE_SECONDS);
  return SAMPLE_POSITIONS.map((position) =>
    Math.min(
      latestStart,
      Math.max(0, duration * position - SAMPLE_SECONDS / 2),
    ),
  );
}

function fingerprintFor(track) {
  if (!track.audio) {
    throw new Error(`No audio stream for ${track.title} (${track.id}).`);
  }

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  for (const start of sampleStarts(track.duration)) {
    args.push(
      "-ss",
      start.toFixed(3),
      "-t",
      String(SAMPLE_SECONDS),
      "-rw_timeout",
      "30000000",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      track.audio,
    );
  }

  const inputs = SAMPLE_POSITIONS.map((_, index) => `[${index}:a]`).join("");
  const sampledAudio =
    SAMPLE_POSITIONS.length === 1
      ? inputs
      : `${inputs}concat=n=${SAMPLE_POSITIONS.length}:v=0:a=1`;
  const spectrum = [
    `showspectrumpic=s=${BANDS}x1`,
    "legend=0",
    "mode=combined",
    "color=intensity",
    "scale=log",
    "fscale=log",
    "start=40",
    "stop=6000",
    "drange=72",
    "limit=0",
    "orientation=horizontal",
  ].join(":");
  const filter = [
    `${sampledAudio}${spectrum}`,
    "format=gray",
  ].join(",");

  args.push(
    "-filter_complex",
    filter,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "pipe:1",
  );

  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    const chunks = [];
    const errors = [];
    process.stdout.on("data", (chunk) => chunks.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks);
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg failed for ${track.title}: ${Buffer.concat(errors).toString().trim()}`,
          ),
        );
        return;
      }
      if (output.length !== BANDS) {
        reject(
          new Error(
            `Unexpected fingerprint size for ${track.title}: ${output.length}`,
          ),
        );
        return;
      }
      resolve([...output]);
    });
  });
}

async function fingerprintWithRetry(track, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fingerprintFor(track);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          `  retrying ${track.title} (${attempt}/${attempts - 1})`,
        );
      }
    }
  }
  throw lastError;
}

const catalog = parseCatalog(await readFile(catalogPath, "utf8"));

const albumsWithStreams = await mapConcurrent(
  catalog.albums,
  4,
  async (album) => {
    const page = parseTralbum(await fetchText(album.url));
    const streams = new Map(
      page.trackinfo.map((track) => [track.id, track.file?.["mp3-128"]]),
    );
    return {
      ...album,
      tracks: album.tracks.map((track) => ({
        ...track,
        audio: streams.get(track.id),
      })),
    };
  },
);

const allTracks = albumsWithStreams.flatMap((album) => album.tracks);
const tracks = TRACK_LIMIT > 0 ? allTracks.slice(0, TRACK_LIMIT) : allTracks;
const results = await mapConcurrent(tracks, CONCURRENCY, async (track, index) => {
  console.log(`[${index + 1}/${tracks.length}] sampling ${track.title}`);
  const fingerprint = await fingerprintWithRetry(track);
  console.log(`[${index + 1}/${tracks.length}] analyzed ${track.title}`);
  return [track.id, fingerprint];
});

const fingerprints = {
  version: 1,
  bands: BANDS,
  sampleSeconds: SAMPLE_SECONDS,
  samplePositions: SAMPLE_POSITIONS,
  tracks: Object.fromEntries(results),
};

await writeFile(
  outputPath,
  `// Track-derived frequency fingerprints sampled from the real Flanguage audio.\nwindow.FLANGUAGE_FINGERPRINTS = ${JSON.stringify(fingerprints)};\n`,
);

console.log(`Wrote real-audio fingerprints for ${results.length} tracks.`);
