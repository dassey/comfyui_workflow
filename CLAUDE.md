# Working on this repo

A static, backend-free Vite app that pulls the ComfyUI workflow out of a
video's metadata — from a local file or from a URL the user pastes.

**Read `ARCHITECTURE.md` before changing anything.** It has the module map, the
byte-source interface both input paths share, and a Traps section listing
non-obvious failures that are easy to reintroduce (ffmpeg dropping the workflow
tag without `-movflags use_metadata_tags`; the `hidden` attribute losing to
`display: flex`; a relayed `response.url` pointing at the proxy rather than the
page).

## Conventions

- Plain JavaScript, ES modules, no framework and no TypeScript.
- Keep the three-way split: `main.js` owns the DOM, `extract.js` owns
  MediaInfo, `remote.js` owns the network. None reaches into another's domain.
- Prettier with `singleQuote` (`.prettierrc`). Run it before committing —
  defaults would rewrite every string in the codebase.

## Checks

```sh
npm test     # 22 end-to-end checks in a real browser
npm run build
```

`npm test` needs ffmpeg with `libx264` and `lavfi` on `PATH` for its fixtures;
set `FFMPEG` to point at a specific binary. It builds with `BASE_PATH=/`, so it
stays independent of the deployed base path.

Anything touching the fetch path — relays, range requests, page scraping —
should be covered there before it ships; `test/server.js` can already imitate a
host that refuses ranges, withholds CORS headers, or sits behind a proxy.

## The one thing not to regress

A CORS relay sees both the URL the user pastes and the bytes it returns. Relays
must stay individually toggleable, the chain must be reducible to direct-only,
and the status log must keep naming the transport each request took. Never
route a request through a third party without that being visible.
