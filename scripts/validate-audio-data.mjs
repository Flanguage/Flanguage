import { appendFile, readFile, stat } from "node:fs/promises";
import {
  ANALYZER_SIGNATURE,
  BANDS,
  FINGERPRINT_SIGNATURE,
  FPS,
  SPECTRUM_VERSION,
  parseCatalog,
  sourceMetadataMatches,
  trackSourceMetadata,
} from "./spectrum-analysis.mjs";

const emitGithubOutput = process.argv.includes("--github-output");
const assertValid = process.argv.includes("--assert");
const catalogPath = new URL("../data/catalog.js", import.meta.url);
const fingerprintsPath = new URL("../data/fingerprints.js", import.meta.url);
const spectrumIndexPath = new URL(
  "../data/spectrum-index.js",
  import.meta.url,
);
const spectraDirectory = new URL("../data/spectra/", import.meta.url);

function parseGenerated(source, globalName) {
  const prefix = `window.${globalName} = `;
  const start = source.indexOf(prefix);
  if (start < 0) {
    throw new Error(`Could not find ${globalName}.`);
  }
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

const problems = [];
let catalog;
let fingerprints;
let spectrumIndex;

try {
  [catalog, fingerprints, spectrumIndex] = await Promise.all([
    readFile(catalogPath, "utf8").then(parseCatalog),
    readFile(fingerprintsPath, "utf8").then((source) =>
      parseGenerated(source, "FLANGUAGE_FINGERPRINTS"),
    ),
    readFile(spectrumIndexPath, "utf8").then((source) =>
      parseGenerated(source, "FLANGUAGE_SPECTRUM_INDEX"),
    ),
  ]);
} catch (error) {
  problems.push(error.message);
}

if (catalog && fingerprints && spectrumIndex) {
  if (
    spectrumIndex.version !== SPECTRUM_VERSION ||
    spectrumIndex.fps !== FPS ||
    spectrumIndex.bands !== BANDS ||
    spectrumIndex.analyzerSignature !== ANALYZER_SIGNATURE
  ) {
    problems.push("Spectrum analyzer signature is not current.");
  }
  if (
    fingerprints.version !== SPECTRUM_VERSION ||
    fingerprints.bands !== BANDS ||
    fingerprints.fingerprintSignature !== FINGERPRINT_SIGNATURE
  ) {
    problems.push("Fingerprint analyzer signature is not current.");
  }

  const tracks = catalog.albums.flatMap((album) =>
    album.tracks.map((track) => ({ track, album })),
  );
  if (Object.keys(spectrumIndex.tracks || {}).length !== tracks.length) {
    problems.push("Spectrum track count does not match the catalog.");
  }
  if (Object.keys(fingerprints.tracks || {}).length !== tracks.length) {
    problems.push("Fingerprint track count does not match the catalog.");
  }
  if (Object.keys(fingerprints.sources || {}).length !== tracks.length) {
    problems.push("Fingerprint source count does not match the catalog.");
  }

  for (const album of catalog.albums) {
    let albumFile = null;
    let expectedOffset = 0;

    for (const track of album.tracks) {
      const metadata = trackSourceMetadata(track, album);
      const fingerprint = fingerprints.tracks?.[track.id];
      const fingerprintSource = fingerprints.sources?.[track.id];
      const spectrum = spectrumIndex.tracks?.[track.id];
      const frames = Math.max(1, Math.ceil(track.duration * FPS));

      if (!Array.isArray(fingerprint) || fingerprint.length !== BANDS) {
        problems.push(`Fingerprint is missing for track ${track.id}.`);
      }
      if (!sourceMetadataMatches(fingerprintSource, metadata)) {
        problems.push(`Fingerprint source is stale for track ${track.id}.`);
      }
      if (
        !spectrum ||
        spectrum.frames !== frames ||
        spectrum.offset !== expectedOffset ||
        !sourceMetadataMatches(spectrum, metadata)
      ) {
        problems.push(`Spectrum metadata is stale for track ${track.id}.`);
      }

      if (spectrum?.file) {
        albumFile ||= spectrum.file;
        if (spectrum.file !== albumFile) {
          problems.push(`Album ${album.id} uses multiple spectrum files.`);
        }
      }
      expectedOffset += frames * BANDS;
    }

    const fileName = albumFile?.startsWith("data/spectra/")
      ? albumFile.slice("data/spectra/".length)
      : null;
    if (!fileName || !/^[a-z0-9._-]+\.bin$/i.test(fileName)) {
      problems.push(`Album ${album.id} has no safe spectrum file.`);
      continue;
    }
    try {
      const details = await stat(new URL(fileName, spectraDirectory));
      if (!details.isFile() || details.size !== expectedOffset) {
        problems.push(`Spectrum file size is wrong for album ${album.id}.`);
      }
    } catch {
      problems.push(`Spectrum file is missing for album ${album.id}.`);
    }
  }
}

const valid = problems.length === 0;
if (emitGithubOutput && process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `valid=${valid}\n`);
}

if (valid) {
  console.log("Audio analysis cache is complete and current.");
} else {
  console.log(`Audio analysis needs a rebuild (${problems.length} checks).`);
  for (const problem of problems) console.log(`- ${problem}`);
}

if (assertValid && !valid) process.exitCode = 1;
