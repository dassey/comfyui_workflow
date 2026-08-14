# Architecture

How this is built and, more usefully, why. The README covers using it; this
covers rebuilding or changing it.

## The governing constraint

This is a static site with no backend — a Vite build deployed to GitHub Pages.
Everything happens in the visitor's browser. That single constraint produces
almost every interesting decision below: there is no server to fetch a URL on
our behalf, no server to parse a video, and nowhere to hide a secret.

## Module map

| File             | Responsibility                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `src/main.js`    | All DOM construction, event wiring, status/progress/log, history. Knows nothing about HTTP. |
| `src/extract.js` | MediaInfo lifecycle and workflow extraction. Knows nothing about the network.               |
| `src/remote.js`  | Everything network: CORS relays, page scraping, range reads. Knows nothing about the DOM.   |
| `src/style.css`  | Styles.                                                                                     |
| `test/`          | End-to-end suite (see Testing).                                                             |

### The seam that holds it together

Both input paths converge on one tiny interface — a **random-access byte
source**:

```js
{ size: number, read(chunkSize, offset) => Promise<Uint8Array> }
```

`sourceFromBlob()` wraps a local `File`; `openRemoteVideo()` produces the same
shape over HTTP. `analyzeSource()` consumes it and cannot tell the difference.
MediaInfo's `analyzeData(size, read)` drives it, seeking wherever it likes.

Adding a third input (a paste buffer, an OPFS file, a torrent) means writing
one more producer of that shape and nothing else.

## Three hard problems

### 1. CORS — the browser refuses to read other sites

A browser will not hand JavaScript the bytes of a cross-origin resource unless
that origin opts in, and most video hosts don't. A cross-origin block surfaces
as a bare `TypeError` with no detail, indistinguishable from a network failure.

The answer is a **transport chain**. A transport is just `{id, label, build(url)}`
where `build` maps a target URL to a fetchable one. `fetchWithFallback()` walks
the chain and returns the first success, collecting each failure into an
`AllTransportsFailed` error that lists what was tried — the user needs that
detail to understand why nothing worked.

Order is `direct` first, then public relays (`corsproxy.io`, `allorigins.win`,
`codetabs.com`), then a user-supplied `{url}` template. Settings persist under
the `comfyui_workflow_proxies` localStorage key.

**A relay sees the URL and the bytes.** That is a genuine privacy cost, not a
footnote. It is why relays are individually toggleable, why the whole chain can
be reduced to `direct`, why a self-hosted relay is supported, and why the
status log names the transport used for every request. Preserve that
visibility in any redesign — silently routing a user's private link through a
third party would be the worst thing this app could do.

### 2. Size — videos are large, metadata is small

ComfyUI renders run to hundreds of megabytes; MediaInfo needs a few small
windows. `openRemoteVideo()` therefore tries two strategies in order:

**Range mode.** Probe with `Range: bytes=0-1`. A `206` plus a parseable
`Content-Range` total means the host supports partial content. Reads are then
aligned to `BLOCK_SIZE` (512 KB) and cached in a `Map` capped at
`MAX_CACHED_BLOCKS` (96, so ~48 MB ceiling), reinserted on hit to keep the map
in least-recent-first order. The cache stores _promises_, not resolved bytes,
so concurrent reads of one block coalesce into a single request. In practice a
1.8 MB file needs about 5 requests.

A host may ignore the range header and return `200` with the whole body even
mid-sequence; `createRangeSource` detects the oversized response and slices out
the window it asked for.

**Full-download mode.** If no transport yields a `206`, stream the whole body
with `response.body.getReader()`, reporting progress, and serve reads from the
buffer. This is also the path for hosts behind a relay that strips `Range`.

Both modes accept an `AbortSignal`, which is what the Cancel button pulls.

### 3. Finding the video on a page

`findVideoUrls(html, pageUrl)` runs layered passes, most trustworthy first,
keeping the first sighting of each URL:

1. `og:video`, `og:video:url`, `og:video:secure_url`, `twitter:player:stream`
2. `<link rel="video_src">`
3. `<video src|data-src>`, `<source src|data-src>`
4. JSON-LD `contentUrl` / `embedUrl`
5. `<a href>` pointing at a video file
6. A regex sweep of the raw markup, after `html.replace(/\\\//g, '/')` — inline
   JSON almost always escapes `/` as `\/`, and this is the pass that catches
   JS-driven sites where the DOM passes find nothing

Candidates are scored: a video file extension in the path outranks one without
(an `og:video` may point at an embed page), and `.mp4`/`.mov` outrank other
containers. One candidate proceeds automatically; several go to a picker.

## Traps

These are the things that cost real time. Changing the surrounding code without
knowing them will reintroduce the bug.

**ffmpeg drops the workflow tag by default.** `workflow` is not a standard mp4
metadata key, and the mov/mp4 muxer silently discards unknown keys unless
`-movflags use_metadata_tags` is set. ComfyUI's VideoHelperSuite sets it. A
fixture built without it looks fine and carries no workflow — the extractor
then appears broken when it is correct.

**`[hidden]` loses to `display: flex`.** The `hidden` attribute is just a UA
stylesheet rule, so any explicit `display` in the stylesheet beats it and the
"hidden" panel renders as an empty box. `style.css` carries an explicit
`[hidden] { display: none !important }`. Don't remove it.

**`response.url` is the relay's address, not the page's.** Resolve relative
video paths against the URL the user supplied (and the document's `<base href>`
if present), never against the response.

**`moov` position varies.** ffmpeg writes the metadata atom at the end unless
`+faststart` moves it to the front. The range reader must handle both, which is
why the suite covers each.

**Prettier has no upstream config.** Upstream is single-quoted but shipped no
`.prettierrc`, so running Prettier with defaults rewrites every string in the
codebase. `.prettierrc` pins `singleQuote` to prevent that churn.

**History names can come from a URL.** `renderHistory()` builds nodes with
`textContent`, not an HTML string. Upstream interpolated `fileName` into
`innerHTML`; once names derive from user-pasted URLs that becomes an injection
vector.

## Testing

`npm test` (see `test/e2e.js`) builds with `BASE_PATH=/`, starts the app beside
a local origin that imitates real-world hosts, and drives Chromium through 22
checks.

`test/server.js` is the interesting half: one origin serving the same videos
under `/` (ranges + CORS), `/norange/` (ranges refused), and `/nocors/` (CORS
headers withheld), plus a `/relay` endpoint standing in for a public CORS
proxy. That lets the suite exercise every branch of the transport chain without
touching the internet.

`test/fixtures.js` generates the mp4s with ffmpeg rather than committing ~4 MB
of binaries, embedding the workflow exactly as ComfyUI does.

Two harness properties worth keeping: preview is spawned **detached** and killed
by process group (killing the npm wrapper alone orphans vite, which keeps the
port and makes the next run test a stale bundle), and the suite **refuses to
start** if something already serves the preview port, so that situation reports
itself instead of producing confident nonsense.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push to
`main`. Because it uploads a build artifact, the repository's Pages source must
be set to **GitHub Actions**, not a branch.

`vite.config.js` sets `base` to `/comfyui_workflow/` to match the Pages URL,
overridable with `BASE_PATH` — which is exactly what the test suite does to
stay independent of it.

## Provenance

Built on
[gabecastello/comfyui-video-workflow-viewer](https://github.com/gabecastello/comfyui-video-workflow-viewer),
which contributed the file-drop extractor and the history sidebar. The URL
path, the module split, and the test suite were added here. Upstream publishes
no license.
