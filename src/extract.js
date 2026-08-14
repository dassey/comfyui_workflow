import MediaInfoFactory from 'mediainfo.js';
import mediaInfoWasmUrl from 'mediainfo.js/MediaInfoModule.wasm?url';

let mediaInfoPromise = null;

// The wasm module is a few hundred KB, so only pay for it on first use.
function getMediaInfo() {
  if (!mediaInfoPromise) {
    mediaInfoPromise = MediaInfoFactory({
      format: 'object',
      locateFile: (path, prefix) =>
        path === 'MediaInfoModule.wasm' ? mediaInfoWasmUrl : `${prefix}${path}`,
    });
  }
  return mediaInfoPromise;
}

/**
 * Analyze any random-access byte source.
 *
 * @param {{ size: number, read: (chunkSize: number, offset: number) => Promise<Uint8Array> }} source
 * @returns {Promise<{ metadata: object, workflow: string | null }>}
 */
export async function analyzeSource({ size, read }) {
  const mediaInfo = await getMediaInfo();
  const metadata = await mediaInfo.analyzeData(size, read);
  return { metadata, workflow: findWorkflow(metadata) };
}

/** Wrap a File/Blob as a random-access source. */
export function sourceFromBlob(blob) {
  return {
    size: blob.size,
    read: async (chunkSize, offset) =>
      new Uint8Array(
        await blob.slice(offset, offset + chunkSize).arrayBuffer(),
      ),
  };
}

/**
 * ComfyUI stores the workflow as a JSON string in an mp4 metadata tag, which
 * MediaInfo surfaces somewhere under `media.track[].extra`. The exact nesting
 * differs between muxers, so walk the whole tree looking for the key.
 */
export function findWorkflow(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  if (typeof obj.workflow === 'string') {
    return obj.workflow;
  }

  for (const value of Object.values(obj)) {
    const found = findWorkflow(value);
    if (found) return found;
  }

  return null;
}

/** Pretty-print JSON, leaving non-JSON text untouched. */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
