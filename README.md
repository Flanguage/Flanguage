# Flanguage Transmission Archive

A monochrome terminal-style, mobile-friendly front end for the complete
[Flanguage Bandcamp catalog](https://flanguage.bandcamp.com).

The site indexes 17 albums and 271 tracks, with:

- Bandcamp-backed native playback with seek and time readout
- Black-and-white, artwork-free transport controls
- Terminal-themed album channels and catalog search
- Alphabetical A–Z browsing across all tracks
- Previous/next navigation
- Dice-based random selection within the current channel
- Song-synchronized 32-band frequency spectrum
- Responsive layouts for phones and desktops
- iPhone-safe touch controls with double-tap zoom and text selection disabled

## Updating the catalog

The committed catalog is generated directly from the public Bandcamp discography:

```bash
node scripts/scrape-bandcamp.mjs
```

Run the scraper after publishing or removing a Bandcamp release, then commit the
updated `data/catalog.js`.

The Pages workflow refreshes Bandcamp's expiring stream URLs before every
deployment and every six hours. Frequency data is generated from the real audio
by `scripts/build-spectrum.mjs` on the first deployment, then cached for later
deployments.

## GitHub Pages

Merging into `main` triggers the included Pages deployment workflow. The final
site will be available at:

<https://flanguage.github.io/Flanguage/>
