import { readFile, writeFile } from "node:fs/promises";
import {
  FINGERPRINT_SAMPLE_POSITION,
  FINGERPRINT_SAMPLE_SECONDS,
  FINGERPRINT_SIGNATURE,
  BAND_EDGES,
  BANDS,
  SPECTRUM_VERSION,
  analyzeTrackWithRetry,
  mapConcurrent,
  parseCatalog,
  sourceMetadataMatches,
  trackSourceMetadata,
} from "./spectrum-analysis.mjs";

const CONCURRENCY = Number(process.env.FINGERPRINT_CONCURRENCY || 4);
const TRACK_LIMIT = Number(process.env.FINGERPRINT_TRACK_LIMIT || 0);
const catalogPath = new URL("../data/catalog.js", import.meta.url);
const outputPath = new URL("../data/fingerprints.js", import.meta.url);

function parseGenerated(source, globalName) {
  const prefix = `window.${globalName} = `;
  const start = source.indexOf(prefix);
  if (start < 0) return null;
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

async function readPreviousFingerprints() {
  try {
    return parseGenerated(
      await readFile(outputPath, "utf8"),
      "FLANGUAGE_FINGERPRINTS",
    );
  } catch {
    return null;
  }
}

function canReuse(previous, source, expected) {
  return (
    Array.isArray(previous) &&
    previous.length === BANDS &&
    sourceMetadataMatches(source, expected)
  );
}

function sampleWindow(track) {
  const duration = Math.max(0, Number(track.duration) || 0);
  const sampleDuration = Math.min(
    FINGERPRINT_SAMPLE_SECONDS,
    duration,
  );
  return {
    start: Math.max(
      0,
      Math.min(
        duration - sampleDuration,
        duration * FINGERPRINT_SAMPLE_POSITION - sampleDuration / 2,
      ),
    ),
    duration: sampleDuration,
  };
}

const catalog = parseCatalog(await readFile(catalogPath, "utf8"));
const previousFingerprints = await readPreviousFingerprints();
const compatiblePrevious =
  previousFingerprints?.version === SPECTRUM_VERSION &&
  previousFingerprints?.bands === BANDS &&
  previousFingerprints?.fingerprintSignature === FINGERPRINT_SIGNATURE
    ? previousFingerprints
    : null;
const allTracks = catalog.albums.flatMap((album) =>
  album.tracks.map((track) => ({ track, album })),
);
const tracks = TRACK_LIMIT > 0 ? allTracks.slice(0, TRACK_LIMIT) : allTracks;

const results = await mapConcurrent(tracks, CONCURRENCY, async (item, index) => {
  const { track, album } = item;
  const metadata = trackSourceMetadata(track, album);
  const previous = compatiblePrevious?.tracks?.[track.id];
  const previousSource = compatiblePrevious?.sources?.[track.id];
  if (canReuse(previous, previousSource, metadata)) {
    console.log(`[${index + 1}/${tracks.length}] cached ${track.title}`);
    return [track.id, previous, metadata];
  }

  console.log(`[${index + 1}/${tracks.length}] sampling ${track.title}`);
  const window = sampleWindow(track);
  const result = await analyzeTrackWithRetry(track, {
    frames: 1,
    ...window,
  });
  console.log(`[${index + 1}/${tracks.length}] analyzed ${track.title}`);
  return [track.id, [...result.data], metadata];
});

const fingerprints = {
  version: SPECTRUM_VERSION,
  method: "hybrid-linear-log",
  fingerprintSignature: FINGERPRINT_SIGNATURE,
  bands: BANDS,
  bandEdges: BAND_EDGES.map((frequency) =>
    Number(frequency.toFixed(3)),
  ),
  sampleSeconds: FINGERPRINT_SAMPLE_SECONDS,
  samplePosition: FINGERPRINT_SAMPLE_POSITION,
  tracks: Object.fromEntries(
    results.map(([trackId, fingerprint]) => [trackId, fingerprint]),
  ),
  sources: Object.fromEntries(
    results.map(([trackId, , source]) => [trackId, source]),
  ),
};

await writeFile(
  outputPath,
  `// Track-derived frequency fingerprints sampled from the real Flanguage audio.\nwindow.FLANGUAGE_FINGERPRINTS = ${JSON.stringify(fingerprints)};\n`,
);

console.log(`Wrote real-audio fingerprints for ${results.length} tracks.`);
