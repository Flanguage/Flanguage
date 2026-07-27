import { spawn } from "node:child_process";

export const SPECTRUM_VERSION = 3;
export const FPS = 8;
export const BANDS = 64;
export const ANALYSIS_BINS = 2048;
export const ANALYSIS_RATE = 32000;
export const LOW_HZ = 30;
export const BASS_SPLIT_HZ = 300;
export const BASS_BANDS = 16;
export const HIGH_HZ = 16000;
export const FINGERPRINT_SAMPLE_SECONDS = 12;
export const FINGERPRINT_SAMPLE_POSITION = 0.5;

export const BAND_EDGES = Array.from({ length: BANDS + 1 }, (_, index) => {
  if (index <= BASS_BANDS) {
    return (
      LOW_HZ +
      (BASS_SPLIT_HZ - LOW_HZ) * (index / BASS_BANDS)
    );
  }
  return (
    BASS_SPLIT_HZ *
    Math.pow(
      HIGH_HZ / BASS_SPLIT_HZ,
      (index - BASS_BANDS) / (BANDS - BASS_BANDS),
    )
  );
});

export const BIN_EDGES = (() => {
  const edges = [];
  for (const [index, frequency] of BAND_EDGES.entries()) {
    const rounded = Math.round((frequency / HIGH_HZ) * ANALYSIS_BINS);
    if (index === 0) {
      edges.push(Math.max(0, rounded));
      continue;
    }
    const maximum = ANALYSIS_BINS - (BANDS - index);
    edges.push(
      Math.max(edges[index - 1] + 1, Math.min(maximum, rounded)),
    );
  }
  return edges;
})();

export const ANALYZER_SIGNATURE = [
  `v${SPECTRUM_VERSION}`,
  `${ANALYSIS_RATE}hz`,
  `${ANALYSIS_BINS}bins`,
  `${BANDS}bands`,
  `${FPS}fps`,
  `${LOW_HZ}-${BASS_SPLIT_HZ}-${HIGH_HZ}hz`,
  "hybrid-linear-log",
  "disjoint-round",
  "peak70-30",
  "log72db-hann",
].join(":");

export const FINGERPRINT_SIGNATURE = [
  ANALYZER_SIGNATURE,
  `${FINGERPRINT_SAMPLE_SECONDS}s`,
  `position${FINGERPRINT_SAMPLE_POSITION}`,
].join(":");

export function parseCatalog(source) {
  const prefix = "window.FLANGUAGE_CATALOG = ";
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error("Could not find FLANGUAGE_CATALOG.");
  return JSON.parse(source.slice(start + prefix.length).replace(/;\s*$/, ""));
}

export async function mapConcurrent(items, concurrency, mapper) {
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

export function trackSourceMetadata(track, album) {
  return {
    durationMs: track.durationMs ?? Math.round(track.duration * 1000),
    sourceRevision: track.sourceRevision ?? null,
    albumRevision: album.modifiedAt ?? null,
  };
}

export function sourceMetadataMatches(actual, expected) {
  return (
    actual?.durationMs === expected.durationMs &&
    actual?.sourceRevision === expected.sourceRevision &&
    actual?.albumRevision === expected.albumRevision
  );
}

export function reduceSpectrumRow(row) {
  if (row.length !== ANALYSIS_BINS) {
    throw new Error(
      `Expected ${ANALYSIS_BINS} analysis bins, received ${row.length}.`,
    );
  }

  const reduced = Buffer.allocUnsafe(BANDS);
  for (let band = 0; band < BANDS; band += 1) {
    const start = BIN_EDGES[band];
    const end = BIN_EDGES[band + 1];
    let largest = 0;
    let second = 0;

    for (let bin = start; bin < end; bin += 1) {
      const value = row[bin];
      if (value >= largest) {
        second = largest;
        largest = value;
      } else if (value > second) {
        second = value;
      }
    }

    reduced[band] =
      end - start <= 1
        ? largest
        : Math.round(largest * 0.7 + second * 0.3);
  }
  return reduced;
}

function analysisFilter(frames) {
  return [
    "highpass=f=28",
    `aresample=${ANALYSIS_RATE}`,
    [
      `showspectrumpic=s=${ANALYSIS_BINS}x${frames}`,
      "legend=0",
      "mode=combined",
      "color=intensity",
      "scale=log",
      "fscale=lin",
      "start=0",
      `stop=${HIGH_HZ}`,
      "drange=72",
      "limit=0",
      "win_func=hann",
      "orientation=horizontal",
    ].join(":"),
    "format=gray",
  ].join(",");
}

export function analyzeTrack(track, { frames, start = 0, duration } = {}) {
  if (!track.audio) {
    throw new Error(`No audio stream for ${track.title} (${track.id}).`);
  }
  if (!Number.isInteger(frames) || frames < 1) {
    throw new Error(`Invalid analysis frame count for ${track.title}.`);
  }

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  if (Number.isFinite(duration) && duration > 0) {
    args.push("-t", duration.toFixed(3));
  }
  if (/^https?:/i.test(track.audio)) {
    args.push(
      "-rw_timeout",
      "120000000",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
    );
  }
  args.push(
    "-i",
    track.audio,
    "-lavfi",
    analysisFilter(frames),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "pipe:1",
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = Buffer.allocUnsafe(frames * BANDS);
    const errors = [];
    let carry = Buffer.alloc(0);
    let rows = 0;
    let settled = false;
    const analysisSeconds =
      Number(duration) || Number(track.duration) || 60;
    const timeoutMs = Math.max(
      180_000,
      Math.min(900_000, Math.ceil(analysisSeconds * 1500)),
    );
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      fail(new Error(`FFmpeg timed out while analyzing ${track.title}.`));
    }, timeoutMs);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    ffmpeg.stdout.on("data", (chunk) => {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (bytes.length - offset >= ANALYSIS_BINS) {
        if (rows >= frames) {
          ffmpeg.kill("SIGKILL");
          fail(new Error(`FFmpeg returned too many rows for ${track.title}.`));
          return;
        }
        const row = bytes.subarray(offset, offset + ANALYSIS_BINS);
        reduceSpectrumRow(row).copy(output, rows * BANDS);
        rows += 1;
        offset += ANALYSIS_BINS;
      }
      carry = bytes.subarray(offset);
    });
    ffmpeg.stderr.on("data", (chunk) => errors.push(chunk));
    ffmpeg.on("error", fail);
    ffmpeg.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(
          new Error(
            `FFmpeg failed for ${track.title}: ${Buffer.concat(errors).toString().trim()}`,
          ),
        );
        return;
      }
      if (rows !== frames || carry.length) {
        fail(
          new Error(
            `Unexpected spectrum size for ${track.title}: ${rows} rows and ${carry.length} trailing bytes.`,
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ data: output, frames });
    });
  });
}

export async function analyzeTrackWithRetry(track, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await analyzeTrack(track, options);
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
