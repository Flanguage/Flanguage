import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

const BAND_URL = "https://flanguage.bandcamp.com";
const OUTPUT = new URL("../data/catalog.js", import.meta.url);
const includeStreams = process.argv.includes("--include-streams");
const emitGithubOutput = process.argv.includes("--github-output");

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

function albumSlugs(html) {
  return [
    ...new Set(
      [...html.matchAll(/href="\/album\/([^"?]+)(?:\?[^"]*)?"/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "FlanguagePagesCatalog/2.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} while loading ${url}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
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

function inventoryFor(albums) {
  return albums.map((album) => ({
    id: album.id,
    slug: album.slug,
    modifiedAt: album.modifiedAt,
    tracks: album.tracks.map((track) => ({
      id: track.id,
      durationMs: track.durationMs,
      sourceRevision: track.sourceRevision,
    })),
  }));
}

function inventoryHashFor(albums) {
  return createHash("sha256")
    .update(JSON.stringify(inventoryFor(albums)))
    .digest("hex");
}

async function scrapeAlbums() {
  const musicHtml = await fetchText(`${BAND_URL}/music`);
  const slugs = albumSlugs(musicHtml);
  if (!slugs.length) throw new Error("Bandcamp returned no album links.");

  const albums = await mapConcurrent(slugs, 4, async (slug) => {
    const url = `${BAND_URL}/album/${slug}`;
    const page = parseTralbum(await fetchText(url));
    const album = page.current;

    return {
      id: album.id,
      slug,
      title: album.title,
      artist: page.artist || "Flanguage",
      url,
      art: `https://f4.bcbits.com/img/a${album.art_id}_10.jpg`,
      publishedAt:
        album.new_date || album.publish_date || album.release_date || null,
      releaseDate: album.release_date || album.new_date || null,
      modifiedAt: album.mod_date || null,
      tracks: page.trackinfo
        .filter((track) => track.streaming && !track.unreleased_track)
        .map((track) => {
          const stream = track.file?.["mp3-128"];
          let sourceRevision = track.encodings_id || null;
          if (!sourceRevision && stream) {
            try {
              sourceRevision = new URL(stream).pathname;
            } catch {
              sourceRevision = null;
            }
          }
          const duration = Number(track.duration) || 0;
          return {
            id: track.id,
            number: track.track_num,
            title: track.title,
            duration: Number(duration.toFixed(3)),
            durationMs: Math.round(duration * 1000),
            sourceRevision,
            url: `${BAND_URL}${track.title_link}`,
            ...(includeStreams && stream ? { audio: stream } : {}),
          };
        }),
    };
  });

  albums.sort(
    (left, right) =>
      (Date.parse(right.publishedAt || right.releaseDate) || 0) -
      (Date.parse(left.publishedAt || left.releaseDate) || 0),
  );

  const trackIds = albums.flatMap((album) =>
    album.tracks.map((track) => track.id),
  );
  if (!trackIds.length) {
    throw new Error("Bandcamp returned no playable tracks.");
  }
  if (new Set(trackIds).size !== trackIds.length) {
    throw new Error("Bandcamp returned duplicate track IDs.");
  }
  return albums;
}

async function previousCatalog() {
  try {
    const source = await readFile(OUTPUT, "utf8");
    const prefix = "window.FLANGUAGE_CATALOG = ";
    return JSON.parse(
      source.slice(source.indexOf(prefix) + prefix.length).replace(/;\s*$/, ""),
    );
  } catch {
    return null;
  }
}

let albums = await scrapeAlbums();
const previous = await previousCatalog();
const currentAlbumIds = new Set(albums.map((album) => album.id));
const currentTrackIds = new Set(
  albums.flatMap((album) => album.tracks.map((track) => track.id)),
);
const possibleRemoval =
  previous?.albums?.some((album) => !currentAlbumIds.has(album.id)) ||
  previous?.albums?.some((album) =>
    album.tracks.some((track) => !currentTrackIds.has(track.id)),
  );

if (possibleRemoval) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const confirmed = await scrapeAlbums();
  if (inventoryHashFor(albums) !== inventoryHashFor(confirmed)) {
    throw new Error(
      "Bandcamp returned inconsistent catalogs while confirming a removal.",
    );
  }
  albums = confirmed;
}

const trackIds = albums.flatMap((album) =>
  album.tracks.map((track) => track.id),
);
const catalog = {
  artist: "Flanguage",
  source: `${BAND_URL}/music`,
  generatedAt: new Date().toISOString(),
  albums,
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  OUTPUT,
  `// Generated from ${BAND_URL}/music\nwindow.FLANGUAGE_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`,
);

const inventoryHash = inventoryHashFor(albums);

if (emitGithubOutput && process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `inventory=${inventoryHash}\n`);
}

const trackCount = trackIds.length;
console.log(
  `Wrote ${albums.length} albums and ${trackCount} tracks${includeStreams ? " with fresh streams" : ""} (inventory ${inventoryHash.slice(0, 12)}).`,
);
