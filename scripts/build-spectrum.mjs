import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  ANALYZER_SIGNATURE,
  BAND_EDGES,
  BANDS,
  FPS,
  SPECTRUM_VERSION,
  analyzeTrackWithRetry,
  mapConcurrent,
  parseCatalog,
  sourceMetadataMatches,
  trackSourceMetadata,
} from "./spectrum-analysis.mjs";

const CONCURRENCY = Number(process.env.SPECTRUM_CONCURRENCY || 4);
const catalogPath = new URL("../data/catalog.js", import.meta.url);
const outputDirectory = new URL("../data/spectra/", import.meta.url);
const indexPath = new URL("../data/spectrum-index.js", import.meta.url);

function parseGenerated(source, globalName) {
  const prefix = `window.${globalName} = `;
  const start = source.indexOf(prefix);
  if (start < 0) return null;
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

async function readPreviousIndex() {
  try {
    return parseGenerated(
      await readFile(indexPath, "utf8"),
      "FLANGUAGE_SPECTRUM_INDEX",
    );
  } catch {
    return null;
  }
}

function canReuse(
  previous,
  expected,
  frames,
  previousFile,
  binaryLength,
) {
  if (
    !previous ||
    previous.file !== previousFile ||
    previous.frames !== frames ||
    !sourceMetadataMatches(previous, expected)
  ) {
    return false;
  }
  const length = frames * BANDS;
  return (
    Number.isInteger(previous.offset) &&
    previous.offset >= 0 &&
    previous.offset + length <= binaryLength
  );
}

const catalog = parseCatalog(await readFile(catalogPath, "utf8"));
const previousIndex = await readPreviousIndex();
const compatiblePrevious =
  previousIndex?.version === SPECTRUM_VERSION &&
  previousIndex?.fps === FPS &&
  previousIndex?.bands === BANDS &&
  previousIndex?.analyzerSignature === ANALYZER_SIGNATURE
    ? previousIndex
    : null;
const index = {
  version: SPECTRUM_VERSION,
  method: "hybrid-linear-log",
  analyzerSignature: ANALYZER_SIGNATURE,
  fps: FPS,
  bands: BANDS,
  bandEdges: BAND_EDGES.map((frequency) =>
    Number(frequency.toFixed(3)),
  ),
  tracks: {},
};
const currentFiles = new Set();

await mkdir(outputDirectory, { recursive: true });

for (const [albumIndex, album] of catalog.albums.entries()) {
  console.log(
    `[${albumIndex + 1}/${catalog.albums.length}] ${album.title} (${album.tracks.length} tracks)`,
  );

  const previousFiles = new Set(
    album.tracks
      .map((track) => compatiblePrevious?.tracks?.[track.id]?.file)
      .filter(Boolean),
  );
  const previousFile =
    previousFiles.size === 1 ? [...previousFiles][0] : null;
  const previousName = previousFile?.startsWith("data/spectra/")
    ? previousFile.slice("data/spectra/".length)
    : null;
  let previousBinary = Buffer.alloc(0);
  if (
    compatiblePrevious &&
    previousName &&
    /^[a-z0-9._-]+\.bin$/i.test(previousName)
  ) {
    try {
      previousBinary = await readFile(new URL(previousName, outputDirectory));
    } catch {
      previousBinary = Buffer.alloc(0);
    }
  }

  const spectra = await mapConcurrent(
    album.tracks,
    CONCURRENCY,
    async (track) => {
      const frames = Math.max(1, Math.ceil(track.duration * FPS));
      const metadata = trackSourceMetadata(track, album);
      const previous = compatiblePrevious?.tracks?.[track.id];
      if (
        canReuse(
          previous,
          metadata,
          frames,
          previousFile,
          previousBinary.length,
        )
      ) {
        const length = frames * BANDS;
        console.log(`  ${track.title} (cached)`);
        return {
          track,
          frames,
          data: previousBinary.subarray(
            previous.offset,
            previous.offset + length,
          ),
          metadata,
        };
      }

      const result = await analyzeTrackWithRetry(track, { frames });
      console.log(`  ${track.title} (analyzed)`);
      return { track, ...result, metadata };
    },
  );

  const binary = Buffer.concat(
    spectra.map((spectrum) => spectrum.data),
  );
  const revision = createHash("sha256")
    .update(binary)
    .digest("hex")
    .slice(0, 16);
  const safeSlug = album.slug.replace(/[^a-z0-9-]/gi, "-");
  const outputName =
    `${safeSlug}.spectrum-v${SPECTRUM_VERSION}-${revision}.bin`;
  const file = `data/spectra/${outputName}`;
  currentFiles.add(outputName);

  let offset = 0;
  for (const spectrum of spectra) {
    index.tracks[spectrum.track.id] = {
      file,
      offset,
      frames: spectrum.frames,
      ...spectrum.metadata,
    };
    offset += spectrum.data.length;
  }

  await writeFile(new URL(outputName, outputDirectory), binary);
}

await writeFile(
  indexPath,
  `// Real frequency spectra generated from the Flanguage audio catalog.\nwindow.FLANGUAGE_SPECTRUM_INDEX = ${JSON.stringify(index)};\n`,
);

for (const entry of await readdir(outputDirectory, {
  withFileTypes: true,
})) {
  if (
    entry.isFile() &&
    entry.name.endsWith(".bin") &&
    !currentFiles.has(entry.name)
  ) {
    await unlink(new URL(entry.name, outputDirectory));
  }
}

console.log(
  `Wrote spectra for ${Object.keys(index.tracks).length} tracks at ${FPS} fps / ${BANDS} bands.`,
);
