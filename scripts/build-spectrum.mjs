import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const FPS = 4;
const BANDS = 32;
const CONCURRENCY = 6;
const catalogPath = new URL("../data/catalog.js", import.meta.url);
const outputDirectory = new URL("../data/spectra/", import.meta.url);
const indexPath = new URL("../data/spectrum-index.js", import.meta.url);

function parseCatalog(source) {
  const prefix = "window.FLANGUAGE_CATALOG = ";
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error("Could not find FLANGUAGE_CATALOG.");
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

function spectrumFor(track) {
  if (!track.audio) {
    throw new Error(`No audio stream for ${track.title} (${track.id}).`);
  }

  const frames = Math.max(1, Math.ceil(track.duration * FPS));
  const filter = [
    `showspectrumpic=s=${BANDS}x${frames}`,
    "legend=0",
    "mode=combined",
    "color=intensity",
    "scale=log",
    "fscale=log",
    "start=40",
    "stop=6000",
    "drange=72",
    "limit=0",
    // Horizontal places time on Y (one row/frame) and frequency on X (32 bars).
    "orientation=horizontal",
  ].join(":");

  return new Promise((resolve, reject) => {
    const process = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        track.audio,
        "-lavfi",
        `${filter},format=gray`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks = [];
    const errors = [];
    process.stdout.on("data", (chunk) => chunks.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      const output = Buffer.concat(chunks);
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg failed for ${track.title}: ${Buffer.concat(errors).toString().trim()}`,
          ),
        );
        return;
      }
      if (output.length !== frames * BANDS) {
        reject(
          new Error(
            `Unexpected spectrum size for ${track.title}: ${output.length}`,
          ),
        );
        return;
      }
      resolve({ data: output, frames });
    });
  });
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

const catalog = parseCatalog(await readFile(catalogPath, "utf8"));
const index = {
  version: 1,
  fps: FPS,
  bands: BANDS,
  tracks: {},
};

await mkdir(outputDirectory, { recursive: true });

for (const [albumIndex, album] of catalog.albums.entries()) {
  console.log(
    `[${albumIndex + 1}/${catalog.albums.length}] ${album.title} (${album.tracks.length} tracks)`,
  );

  const spectra = await mapConcurrent(
    album.tracks,
    CONCURRENCY,
    async (track) => {
      const result = await spectrumFor(track);
      console.log(`  ${track.title}`);
      return { track, ...result };
    },
  );

  const file = `data/spectra/${album.slug}.bin`;
  let offset = 0;
  for (const spectrum of spectra) {
    index.tracks[spectrum.track.id] = {
      file,
      offset,
      frames: spectrum.frames,
    };
    offset += spectrum.data.length;
  }

  await writeFile(
    new URL(`${album.slug}.bin`, outputDirectory),
    Buffer.concat(spectra.map((spectrum) => spectrum.data)),
  );
}

await writeFile(
  indexPath,
  `// Real frequency spectra generated from the Flanguage audio catalog.\nwindow.FLANGUAGE_SPECTRUM_INDEX = ${JSON.stringify(index)};\n`,
);

console.log(
  `Wrote spectra for ${Object.keys(index.tracks).length} tracks at ${FPS} fps / ${BANDS} bands.`,
);
