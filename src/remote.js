/**
 * Fetching a video that lives on someone else's page, from a static site with
 * no backend of its own.
 *
 * Two problems have to be solved:
 *
 *  1. CORS. A browser will not hand us the bytes of a cross-origin URL unless
 *     that origin opts in. Most sites do not, so requests are attempted
 *     directly first and then retried through a list of CORS relays.
 *  2. Size. ComfyUI videos can be hundreds of megabytes and MediaInfo only
 *     needs a few small windows of the file. Where the server supports HTTP
 *     range requests we read just those windows; otherwise we fall back to
 *     downloading the whole file into memory.
 */

const VIDEO_EXTENSION = /\.(?:mp4|m4v|mov|webm|mkv)(?![a-z0-9])/i;

const BLOCK_SIZE = 512 * 1024;
const MAX_CACHED_BLOCKS = 96;

export const BUILT_IN_PROXIES = [
  {
    id: 'direct',
    label: 'Direct (no proxy)',
    build: (url) => url,
  },
  {
    id: 'corsproxy',
    label: 'corsproxy.io',
    build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  },
  {
    id: 'allorigins',
    label: 'allorigins.win',
    build: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    id: 'codetabs',
    label: 'codetabs.com',
    build: (url) =>
      `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  },
];

const SETTINGS_KEY = 'comfyui_workflow_proxies';
const DEFAULT_SETTINGS = {
  enabled: BUILT_IN_PROXIES.map((p) => p.id),
  custom: '',
};

export function loadProxySettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
    return {
      enabled: Array.isArray(stored.enabled)
        ? stored.enabled
        : DEFAULT_SETTINGS.enabled,
      custom: typeof stored.custom === 'string' ? stored.custom : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveProxySettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Turn stored settings into the ordered list of transports to try. */
export function buildTransports(settings) {
  const transports = BUILT_IN_PROXIES.filter((p) =>
    settings.enabled.includes(p.id),
  );

  const custom = (settings.custom || '').trim();
  if (custom.includes('{url}')) {
    transports.push({
      id: 'custom',
      label: 'custom proxy',
      build: (url) => custom.replace('{url}', encodeURIComponent(url)),
    });
  }

  return transports;
}

export function looksLikeVideoUrl(url) {
  try {
    return VIDEO_EXTENSION.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);

  try {
    // Be forgiving about a pasted "example.com/post" with no scheme.
    const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // ...but don't turn an arbitrary word into a hostname.
    if (
      !hasScheme &&
      !url.hostname.includes('.') &&
      url.hostname !== 'localhost'
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

class AllTransportsFailed extends Error {
  constructor(attempts) {
    super(
      `Could not fetch the URL. Attempts:\n${attempts.map((a) => `  • ${a}`).join('\n')}`,
    );
    this.name = 'AllTransportsFailed';
    this.attempts = attempts;
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* body already consumed or unreadable */
  }
}

function describeError(err) {
  // A cross-origin block surfaces as an opaque TypeError with no detail.
  if (err instanceof TypeError) return 'blocked (CORS or network)';
  return err?.message || String(err);
}

/** Try each transport in order, returning the first successful response. */
async function fetchWithFallback(url, init, { transports, signal, onNote }) {
  const attempts = [];

  for (const transport of transports) {
    try {
      const response = await fetch(transport.build(url), { ...init, signal });
      if (!response.ok) {
        await discardBody(response);
        attempts.push(`${transport.label}: HTTP ${response.status}`);
        continue;
      }
      if (transport.id !== 'direct') {
        onNote?.(`Relayed through ${transport.label}.`);
      }
      return { response, transport };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      attempts.push(`${transport.label}: ${describeError(err)}`);
    }
  }

  throw new AllTransportsFailed(attempts);
}

/* ------------------------------------------------------------------ *
 * Finding the video on a page
 * ------------------------------------------------------------------ */

const META_VIDEO_KEYS = [
  'og:video',
  'og:video:url',
  'og:video:secure_url',
  'twitter:player:stream',
];

const ABSOLUTE_VIDEO =
  /https?:\/\/[^\s"'<>\\)\]]+?\.(?:mp4|m4v|mov|webm|mkv)(?![a-z0-9])(?:\?[^\s"'<>\\)\]]*)?/gi;

const RELATIVE_VIDEO =
  /["'(](\/[^\s"'<>()]+?\.(?:mp4|m4v|mov|webm|mkv)(?![a-z0-9])(?:\?[^\s"'<>()]*)?)["')]/gi;

function collectJsonLdUrls(value, out) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdUrls(item, out);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'string' &&
      (key === 'contentUrl' || key === 'embedUrl')
    ) {
      out.push(item);
    } else {
      collectJsonLdUrls(item, out);
    }
  }
}

/**
 * Scrape a page for anything that looks like a video file.
 *
 * Candidates whose path carries a video extension are marked `likely` and
 * sorted first; the rest (an `og:video` pointing at an extension-less CDN
 * path, say) are kept as fallbacks for the user to pick from.
 *
 * @returns {Array<{ url: string, source: string, likely: boolean }>}
 */
export function findVideoUrls(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Resolve against <base href> when the page declares one. Note that the
  // page URL — not the response URL — is the base, since a relayed response
  // reports the proxy's address.
  let base = pageUrl;
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      /* malformed <base>, keep the page URL */
    }
  }

  const found = new Map();

  const add = (raw, source) => {
    if (!raw || typeof raw !== 'string') return;

    let absolute;
    try {
      absolute = new URL(raw.trim(), base);
    } catch {
      return;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return;

    absolute.hash = '';
    const likely = VIDEO_EXTENSION.test(absolute.pathname);

    // Keep the first sighting: earlier passes are the more trustworthy ones.
    if (!found.has(absolute.href)) {
      found.set(absolute.href, { url: absolute.href, source, likely });
    }
  };

  for (const meta of doc.querySelectorAll('meta[content]')) {
    const key = meta.getAttribute('property') || meta.getAttribute('name');
    if (key && META_VIDEO_KEYS.includes(key.toLowerCase())) {
      add(meta.getAttribute('content'), key);
    }
  }

  add(
    doc.querySelector('link[rel="video_src"]')?.getAttribute('href'),
    'link video_src',
  );

  for (const el of doc.querySelectorAll('video[src], video[data-src]')) {
    add(el.getAttribute('src') || el.getAttribute('data-src'), '<video>');
  }

  for (const el of doc.querySelectorAll('source[src], source[data-src]')) {
    add(el.getAttribute('src') || el.getAttribute('data-src'), '<source>');
  }

  for (const script of doc.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    try {
      const urls = [];
      collectJsonLdUrls(JSON.parse(script.textContent), urls);
      for (const url of urls) add(url, 'JSON-LD');
    } catch {
      /* not valid JSON-LD */
    }
  }

  for (const el of doc.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (href && VIDEO_EXTENSION.test(href)) add(href, 'link');
  }

  // Last resort: sweep the raw markup. Catches URLs that only exist inside
  // inline JSON or JS, where "/" is commonly escaped as "\/".
  const raw = html.replace(/\\\//g, '/');
  for (const match of raw.matchAll(ABSOLUTE_VIDEO))
    add(match[0], 'page source');
  for (const match of raw.matchAll(RELATIVE_VIDEO))
    add(match[1], 'page source');

  const candidates = [...found.values()];
  candidates.sort((a, b) => score(b) - score(a));
  return candidates;
}

function score(candidate) {
  let value = 0;
  if (candidate.likely) value += 4;
  if (/\.(?:mp4|m4v|mov)(?![a-z0-9])/i.test(candidate.url)) value += 2;
  return value;
}

/**
 * Fetch a page and pull the video candidates out of it.
 *
 * @returns {Promise<{ kind: 'video' } | { kind: 'html', candidates: Array }>}
 */
export async function resolvePage(pageUrl, ctx) {
  const { response } = await fetchWithFallback(
    pageUrl,
    { headers: { Accept: 'text/html,application/xhtml+xml,*/*' } },
    ctx,
  );

  const contentType = response.headers.get('content-type') || '';
  if (/^video\//i.test(contentType)) {
    await discardBody(response);
    return { kind: 'video' };
  }

  const html = await response.text();
  return { kind: 'html', candidates: findVideoUrls(html, pageUrl) };
}

/* ------------------------------------------------------------------ *
 * Reading the video itself
 * ------------------------------------------------------------------ */

function parseTotalSize(contentRange) {
  const match = /\/(\d+)\s*$/.exec(contentRange || '');
  return match ? Number(match[1]) : 0;
}

/**
 * A random-access source backed by HTTP range requests.
 *
 * Reads are aligned to fixed-size blocks and cached, so MediaInfo's many
 * small seeks collapse into a handful of requests.
 */
function createRangeSource(url, transport, size, { signal, onProgress }) {
  const cache = new Map();
  let bytesFetched = 0;

  function loadBlock(index) {
    const start = index * BLOCK_SIZE;
    if (start >= size) return Promise.resolve(new Uint8Array(0));
    const end = Math.min(start + BLOCK_SIZE, size) - 1;

    const pending = (async () => {
      const response = await fetch(transport.build(url), {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Range request failed (HTTP ${response.status})`);
      }

      let bytes = new Uint8Array(await response.arrayBuffer());

      // A server that ignores the range header hands back the whole file.
      if (response.status === 200 && bytes.length > end - start + 1) {
        bytes = bytes.subarray(start, end + 1);
      }

      bytesFetched += bytes.length;
      onProgress?.({ loaded: bytesFetched, total: size, streaming: true });
      return bytes;
    })();

    cache.set(index, pending);
    while (cache.size > MAX_CACHED_BLOCKS) {
      cache.delete(cache.keys().next().value);
    }
    return pending;
  }

  function getBlock(index) {
    const cached = cache.get(index);
    if (cached) {
      cache.delete(index); // reinsert to keep the map in least-recent-first order
      cache.set(index, cached);
      return cached;
    }
    return loadBlock(index);
  }

  return {
    size,
    async read(chunkSize, offset) {
      const end = Math.min(offset + chunkSize, size);
      if (offset >= size || end <= offset) return new Uint8Array(0);

      const out = new Uint8Array(end - offset);
      let written = 0;
      let position = offset;

      while (position < end) {
        const index = Math.floor(position / BLOCK_SIZE);
        const block = await getBlock(index);
        const withinBlock = position - index * BLOCK_SIZE;
        if (withinBlock >= block.length) break; // short read: server gave us less than asked

        const take = Math.min(block.length - withinBlock, end - position);
        out.set(block.subarray(withinBlock, withinBlock + take), written);
        written += take;
        position += take;
      }

      return written === out.length ? out : out.subarray(0, written);
    },
  };
}

async function downloadAll(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Open a remote video as a random-access source for MediaInfo.
 *
 * Prefers range requests; falls back to buffering the whole file when the
 * server (or the relay in front of it) will not serve partial content.
 *
 * @returns {Promise<{ size: number, read: Function }>}
 */
export async function openRemoteVideo(videoUrl, ctx) {
  const { transports, signal, onNote, onProgress } = ctx;
  const attempts = [];

  for (const transport of transports) {
    try {
      const response = await fetch(transport.build(videoUrl), {
        headers: { Range: 'bytes=0-1' },
        signal,
      });
      const size = parseTotalSize(response.headers.get('content-range'));
      await discardBody(response);

      if (response.status === 206 && size > 0) {
        onNote?.(
          `Range requests work via ${transport.label} — reading only the metadata, not the whole ${formatBytes(size)}.`,
        );
        return createRangeSource(videoUrl, transport, size, {
          signal,
          onProgress,
        });
      }
      attempts.push(
        `${transport.label}: no partial content (HTTP ${response.status})`,
      );
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      attempts.push(`${transport.label}: ${describeError(err)}`);
    }
  }

  onNote?.(
    'No range support — downloading the full file to read its metadata.',
  );

  const { response } = await fetchWithFallback(videoUrl, {}, ctx).catch(
    (err) => {
      if (err instanceof AllTransportsFailed) {
        throw new AllTransportsFailed([...attempts, ...err.attempts]);
      }
      throw err;
    },
  );

  const bytes = await downloadAll(response, onProgress);
  return {
    size: bytes.length,
    read: async (chunkSize, offset) =>
      bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
  };
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
