// Generates the mp4s the e2e suite reads.
//
// The workflow tag is written the same way ComfyUI's VideoHelperSuite writes
// it: an arbitrary mp4 metadata key, which the mov/mp4 muxer only emits when
// -movflags use_metadata_tags is set. Without that flag ffmpeg silently drops
// unknown keys and the fixtures would be indistinguishable from plain video.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'media',
);

export const WORKFLOW = {
  last_node_id: 4,
  last_link_id: 3,
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      widgets_values: ['sd_xl_base_1.0.safetensors'],
    },
    {
      id: 2,
      type: 'CLIPTextEncode',
      widgets_values: ['a cat riding a skateboard'],
    },
  ],
  links: [[1, 1, 0, 2, 0, 'CLIP']],
  version: 0.4,
};

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Build the fixtures if they are not already present. */
export function ensureFixtures() {
  const files = ['render.mp4', 'render-faststart.mp4', 'plain.mp4'].map((f) =>
    path.join(MEDIA_DIR, f),
  );
  if (files.every((f) => fs.existsSync(f))) return;

  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `ffmpeg not found (tried "${FFMPEG}"). Install it, or set FFMPEG to a ` +
        'binary with libx264 and the lavfi input — a minimal build will not do.',
    );
  }

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tag = JSON.stringify(WORKFLOW);
  const [withTag, faststart, plain] = files;

  // moov at the end, as ffmpeg writes by default
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=20:size=1280x720:rate=30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '4000k',
    '-metadata',
    `workflow=${tag}`,
    '-movflags',
    'use_metadata_tags',
    '-y',
    withTag,
  ]);

  // same content with moov moved to the front
  ffmpeg([
    '-i',
    withTag,
    '-c',
    'copy',
    '-metadata',
    `workflow=${tag}`,
    '-movflags',
    'use_metadata_tags+faststart',
    '-y',
    faststart,
  ]);

  // no workflow tag at all
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=12',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-y',
    plain,
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixtures();
  console.log(`fixtures ready in ${MEDIA_DIR}`);
}
