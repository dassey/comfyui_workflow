## ComfyUI Video Workflow Extractor

Extract the ComfyUI workflow embedded in a video's metadata — from a file on
your machine, or straight from the page the video is posted on.

Video parsing runs entirely in your browser via
[mediainfo.js](https://github.com/buzz/mediainfo.js); the workflow JSON is
never uploaded anywhere.

## How to use

### A local file

Drag and drop a video anywhere on the page, or pick it with the file input.

### A URL

Paste either a direct link to a video file or the address of the page the
video sits on, then press **Extract**. Dragging a link in from another tab
does the same thing.

For a page, the app fetches the HTML and looks for the video in:

- `<video>` and `<source>` tags, including their `data-src` variants
- `og:video`, `og:video:url`, `og:video:secure_url` and
  `twitter:player:stream` meta tags, and `<link rel="video_src">`
- JSON-LD `contentUrl` and `embedUrl`
- `<a>` links pointing at a video file
- any video URL left in the raw markup, including the `"\/"`-escaped form
  that inline JSON usually carries

Relative paths resolve against the page's `<base href>` when it declares one.
If more than one candidate turns up, you pick which to read; those with a
video file extension are listed first.

Where the host supports HTTP range requests, only the few kilobytes MediaInfo
actually needs are downloaded rather than the entire video. Hosts that don't
support ranges fall back to a full download, with progress shown and a Cancel
button.

## About the network options

Browsers refuse to read another site's pages or files unless that site opts in
via CORS, and most don't. Every request is therefore tried directly first and
then retried through a list of public CORS relays, which you can reorder,
disable, or replace under **Network options**.

This is worth understanding before you paste a private link: **a relay sees the
URL you paste and the bytes it passes back.** Untick every relay to keep all
requests direct — extraction will then only work for hosts that send CORS
headers — or point the app at a relay you run yourself using the custom field.

The status log under the input reports which route each request took, so you
can always tell whether a relay was involved.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
npm run preview  # serve the production build
```

The build assumes it is served from `/comfyui_workflow/`. Set `BASE_PATH` to
change that, e.g. `BASE_PATH=/ npm run build` for a domain root.

### Tests

```sh
npx playwright install chromium   # once
npm test
```

`npm test` builds the app, starts it alongside a local origin that imitates
the sites the extractor has to read, and drives a real browser through 22
checks: range-capable and range-ignoring hosts, CORS-blocked and relayed
fetches, each page-scraping strategy above, `moov` at either end of the file,
the candidate picker, junk input, and the local-file path.

It needs **ffmpeg** on `PATH` (with `libx264` and `lavfi`) to build its
fixtures on first run — a minimal build such as the one bundled with
Playwright will not do. Point `FFMPEG` at another binary to override, and
`npm run fixtures` to build them without running the suite. Fixtures land in
`test/media/`, which is ignored.

The fixtures embed the workflow the way ComfyUI's VideoHelperSuite does — an
arbitrary mp4 metadata key written with `-movflags use_metadata_tags` — so
the suite exercises the real extraction path rather than a stand-in.

Deploys to GitHub Pages via `.github/workflows/deploy.yml` on every push to
`main`. That workflow needs the repository's Pages source set to **GitHub
Actions** (Settings → Pages) rather than a branch.

## How it works

[`ARCHITECTURE.md`](ARCHITECTURE.md) covers the module layout, the shared
byte-source interface behind both input paths, how the CORS relay chain and
HTTP range reader are built, and the non-obvious traps worth knowing before
changing any of it.

## Credits

Based on
[gabecastello/comfyui-video-workflow-viewer](https://github.com/gabecastello/comfyui-video-workflow-viewer),
which provides the file-based extractor this builds on. The upstream
repository does not publish a license.
