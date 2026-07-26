import { mkdir, writeFile } from "node:fs/promises";

const BAND_URL = "https://flanguage.bandcamp.com";
const OUTPUT = new URL("../data/catalog.js", import.meta.url);

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
  const response = await fetch(url, {
    headers: { "user-agent": "FlanguagePagesCatalog/1.0" },
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

const musicHtml = await fetchText(`${BAND_URL}/music`);
const slugs = albumSlugs(musicHtml);

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
    releaseDate: album.release_date || album.new_date,
    tracks: page.trackinfo
      .filter((track) => track.streaming && !track.unreleased_track)
      .map((track) => ({
        id: track.id,
        number: track.track_num,
        title: track.title,
        duration: Math.round(track.duration || 0),
        url: `${BAND_URL}${track.title_link}`,
      })),
  };
});

albums.sort(
  (left, right) => new Date(right.releaseDate) - new Date(left.releaseDate),
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

const trackCount = albums.reduce(
  (total, album) => total + album.tracks.length,
  0,
);
console.log(`Wrote ${albums.length} albums and ${trackCount} tracks.`);
