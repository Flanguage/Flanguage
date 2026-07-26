# Flanguage Transmission Archive

A CRT-styled, mobile-friendly front end for the complete
[Flanguage Bandcamp catalog](https://flanguage.bandcamp.com).

The site indexes 17 albums and 271 tracks, with:

- Bandcamp-backed embedded playback
- Album filtering and catalog search
- Album-order or alphabetical A–Z browsing across all tracks
- Previous/next navigation
- Random selection across the full discography or current album
- Animated phosphor bar spectrum
- Responsive layouts for phones and desktops

## Updating the catalog

The committed catalog is generated directly from the public Bandcamp discography:

```bash
node scripts/scrape-bandcamp.mjs
```

Run the scraper after publishing or removing a Bandcamp release, then commit the
updated `data/catalog.js`.

## GitHub Pages

Merging into `main` triggers the included Pages deployment workflow. The final
site will be available at:

<https://flanguage.github.io/Flanguage/>
