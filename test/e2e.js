// End-to-end suite: builds the app, serves it, and drives a real browser
// against a local origin that mimics the network conditions the extractor
// meets in the wild.
//
// The app is built with BASE_PATH=/ so these checks stay independent of
// whatever base path the deployed site uses.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureFixtures, WORKFLOW } from './fixtures.js';
import { startOrigin, ORIGIN } from './server.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 4173);
const APP = `http://localhost:${PREVIEW_PORT}/`;

const results = [];
let browser;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/**
 * Refuse to run against a server we did not start. A stale `vite preview` on
 * the port would otherwise serve an older bundle — possibly from a different
 * base path — and every failure it caused would be a lie about the code.
 */
async function assertPortFree(url) {
  try {
    await fetch(url);
  } catch {
    return; // nothing listening, which is what we want
  }
  throw new Error(
    `Something is already serving ${url}. Stop it (or set PREVIEW_PORT) ` +
      'before running the suite.',
  );
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function newPage({ proxies = ['direct'], custom = '' } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(
    ([enabled, customProxy]) => {
      localStorage.setItem(
        'comfyui_workflow_proxies',
        JSON.stringify({ enabled, custom: customProxy }),
      );
    },
    [proxies, custom],
  );
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: 'networkidle' });
  return page;
}

async function submitUrl(page, url) {
  await page.fill('#urlInput', url);
  await page.click('#fetchBtn');
}

/** Resolve once the run has settled (Cancel hidden, status written). */
async function settle(page, timeout = 45000) {
  await page.waitForFunction(
    () =>
      document.getElementById('cancelBtn').hidden &&
      document.getElementById('status').textContent.trim() !== '',
    { timeout },
  );
  return {
    status: (await page.textContent('#status')).trim(),
    output: await page.inputValue('#output'),
    log: await page.$$eval('#log li', (ls) => ls.map((l) => l.textContent)),
  };
}

function workflowLooksRight(output) {
  try {
    const parsed = JSON.parse(output);
    return (
      parsed.last_node_id === WORKFLOW.last_node_id &&
      Array.isArray(parsed.nodes) &&
      parsed.nodes[0].type === WORKFLOW.nodes[0].type
    );
  } catch {
    return false;
  }
}

async function checks() {
  // Direct .mp4 URL, range requests available
  {
    const page = await newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r));
    await submitUrl(page, `${ORIGIN}/render.mp4`);
    const r = await settle(page);
    check(
      'direct mp4 URL extracts workflow',
      workflowLooksRight(r.output),
      r.status,
    );
    check(
      'direct mp4 uses range requests',
      r.log.some((l) => /Range requests work/i.test(l)),
    );
    const fetched = requests.filter((r) =>
      r.url().includes('render.mp4'),
    ).length;
    check(
      'range mode reads windows, not the whole file',
      fetched > 0 && fetched < 12,
      `${fetched} requests`,
    );
  }

  const pageCases = [
    ['page with <source> tag', '/page/source-tag'],
    ['page with og:video meta', '/page/og-meta'],
    ['url escaped as \\/ inside inline JSON', '/page/escaped-json'],
    ['relative src resolved against <base>', '/page/relative-base'],
    ['range-less server falls back to full download', '/page/norange'],
  ];
  for (const [name, route] of pageCases) {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}${route}`);
    const r = await settle(page);
    check(name, workflowLooksRight(r.output), r.status);
    if (route === '/page/norange') {
      check(
        'full-download fallback is reported',
        r.log.some((l) => /No range support/i.test(l)),
      );
    }
  }

  // Several candidates -> picker, then pick one
  {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}/page/multiple`);
    await page.waitForSelector('.candidate', { timeout: 20000 });
    const count = await page.$$eval('.candidate', (els) => els.length);
    check('multiple videos show a picker', count >= 3, `${count} candidates`);
    await page.click('.candidate');
    const r = await settle(page);
    check(
      'picking a candidate extracts it',
      workflowLooksRight(r.output),
      r.status,
    );
  }

  // Page with no video at all
  {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}/page/none`);
    const r = await settle(page);
    check(
      'page with no video reports clearly',
      /no video files found/i.test(r.status),
      r.status,
    );
  }

  // CORS-blocked, direct only
  {
    const page = await newPage({ proxies: ['direct'] });
    await submitUrl(page, `${ORIGIN}/nocors/render.mp4`);
    const r = await settle(page);
    check(
      'CORS-blocked video fails with an explanation',
      /could not fetch/i.test(r.status) ||
        r.log.some((l) => /blocked/i.test(l)),
      r.status,
    );
  }

  // ...and the same video recovered through a relay
  {
    const page = await newPage({
      proxies: ['direct'],
      custom: `${ORIGIN}/relay?target={url}`,
    });
    await submitUrl(page, `${ORIGIN}/nocors/render.mp4`);
    const r = await settle(page);
    check(
      'custom relay recovers a CORS-blocked video',
      workflowLooksRight(r.output),
      r.status,
    );
    check(
      'relay use is disclosed in the log',
      r.log.some((l) => /custom proxy/i.test(l)),
    );
  }

  // mp4 with no workflow tag
  {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}/plain.mp4`);
    const r = await settle(page);
    check(
      'mp4 without workflow shows metadata',
      /no workflow found/i.test(r.status) && r.output.includes('"@type"'),
      r.status,
    );
  }

  // faststart (moov at the front)
  {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}/render-faststart.mp4`);
    const r = await settle(page);
    check(
      'faststart mp4 (moov at front)',
      workflowLooksRight(r.output),
      r.status,
    );
  }

  // Junk input
  {
    const page = await newPage();
    await submitUrl(page, 'not a url at all');
    await page.waitForTimeout(500);
    const status = (await page.textContent('#status')).trim();
    check(
      'nonsense input is rejected',
      /does not look like a url/i.test(status),
      status,
    );
  }

  // Scheme-less input becomes https://
  {
    const page = await newPage();
    await submitUrl(page, 'example.com/render.mp4');
    const r = await settle(page);
    check(
      'scheme-less URL is normalized to https',
      r.log.some((l) => l.includes('https://example.com/render.mp4')),
    );
  }

  // Local file input still works
  {
    const page = await newPage();
    await page.setInputFiles(
      '#fileInput',
      path.join(REPO, 'test/media/render.mp4'),
    );
    await page.waitForFunction(
      () => document.getElementById('status').textContent.includes('Workflow'),
      { timeout: 30000 },
    );
    check(
      'local file upload still works',
      workflowLooksRight(await page.inputValue('#output')),
    );
  }

  // History records the source URL
  {
    const page = await newPage();
    await submitUrl(page, `${ORIGIN}/render.mp4`);
    await settle(page);
    await page.click('#saveHistoryBtn');
    await page.waitForSelector('.history-item');
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('comfyui_workflow_history')),
    );
    check(
      'history stores the source URL',
      stored[0].sourceUrl === `${ORIGIN}/render.mp4` &&
        stored[0].fileName === 'render.mp4',
    );
  }

  // A history name is text, never markup
  {
    const page = await newPage();
    await page.evaluate(() => {
      localStorage.setItem(
        'comfyui_workflow_history',
        JSON.stringify([
          {
            id: '1',
            fileName: '<img src=x onerror="window.__xss=true">',
            timestamp: Date.now(),
            data: '{}',
          },
        ]),
      );
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.history-item');
    const xss = await page.evaluate(() => window.__xss === true);
    const imgs = await page.$$eval('.history-item img', (e) => e.length);
    check('history name is escaped', !xss && imgs === 0);
  }
}

async function main() {
  ensureFixtures();
  await run('npm', ['run', 'build'], {
    env: { ...process.env, BASE_PATH: '/' },
  });

  await assertPortFree(APP);
  const origin = await startOrigin();

  // `preview` re-reads vite.config.js, so it needs the same BASE_PATH as the
  // build or it will serve the bundle from the deployed sub-path instead.
  // detached puts npm and the vite process it spawns in one process group, so
  // the teardown below can take both down — killing npm alone orphans vite,
  // which then squats on the port and poisons the next run.
  const preview = spawn(
    'npm',
    ['run', 'preview', '--', '--port', String(PREVIEW_PORT)],
    {
      cwd: REPO,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, BASE_PATH: '/' },
    },
  );

  try {
    await waitFor(APP);
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    });
    await checks();
  } finally {
    await browser?.close();
    try {
      process.kill(-preview.pid, 'SIGTERM');
    } catch {
      /* group already gone */
    }
    origin.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await browser?.close();
  process.exit(2);
});
