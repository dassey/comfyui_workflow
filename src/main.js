import './style.css';
import { analyzeSource, sourceFromBlob, prettyJson } from './extract.js';
import {
  BUILT_IN_PROXIES,
  buildTransports,
  formatBytes,
  loadProxySettings,
  looksLikeVideoUrl,
  normalizeUrl,
  openRemoteVideo,
  resolvePage,
  saveProxySettings,
} from './remote.js';

const LOCAL_STORAGE_KEY = 'comfyui_workflow_history';

// Helper to get history from LocalStorage
function getHistory() {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  return data ? JSON.parse(data) : [];
}

// Helper to save history to LocalStorage
function saveHistory(history) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(history));
}

document.querySelector('#app').innerHTML = `
  <div class="topbar">
    <div class="topbar-left">
      <button id="toggleSidebarBtn">☰ History</button>
      <span class="app-title">ComfyUI Video Workflow Extractor</span>
    </div>
    <span class="topbar-note">
      Metadata is parsed in your browser.
      <a href="https://github.com/dassey/comfyui_workflow" target="_blank" rel="noreferrer">GitHub</a>
    </span>
  </div>

  <div class="app-layout">
    <!-- Collapsible Sidebar -->
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <h3>Saved History</h3>
        <button id="clearAllBtn" style="font-size: 0.75rem; color: #ef4444;">Clear All</button>
      </div>
      <ul id="historyList" class="history-list"></ul>
    </aside>

    <!-- Main Workspace -->
    <main class="main-content">
      <div class="container">
        <div class="source-row">
          <label class="source-label" for="fileInput">Local file</label>
          <input id="fileInput" type="file" accept=".mp4,.m4v,.mov,.webm,.mkv" />
        </div>

        <div class="source-divider"><span>or</span></div>

        <form id="urlForm" class="source-row" novalidate>
          <label class="source-label" for="urlInput">Page or video URL</label>
          <input
            id="urlInput"
            type="text"
            class="url-input"
            spellcheck="false"
            placeholder="https://example.com/gallery/my-render  —  or a direct .mp4 link"
          />
          <button type="submit" id="fetchBtn">Extract</button>
          <button type="button" id="cancelBtn" class="secondary" hidden>Cancel</button>
        </form>

        <details id="networkOptions" class="network-options">
          <summary>Network options</summary>
          <p class="hint">
            Browsers block reads of other sites' pages and files unless that site
            opts in, so each fetch is tried directly first and then retried
            through the relays below, in order. A relay sees the URL you paste and
            the bytes it passes back — turn them off to keep every request direct.
          </p>
          <div id="proxyList" class="proxy-list"></div>
          <label class="custom-proxy">
            Custom relay
            <input
              id="customProxy"
              type="text"
              class="url-input"
              spellcheck="false"
              placeholder="https://my-proxy.example/?target={url}"
            />
          </label>
          <p class="hint">Use <code>{url}</code> where the encoded target URL should go.</p>
        </details>

        <div id="candidates" class="candidates" hidden></div>
        <p id="status" class="status"></p>
        <p id="progress" class="progress" hidden></p>
        <ul id="log" class="log"></ul>

        <div class="button-row">
          <button id="copyBtn" disabled>Copy Workflow</button>
          <button id="downloadBtn" disabled>Download</button>
          <button id="saveHistoryBtn" disabled>Save to History</button>
        </div>
        <textarea id="output" class="output" spellcheck="false"></textarea>
      </div>
    </main>

    <!-- Drop overlay -->
    <div id="dragOverlay" class="drag-overlay hidden">
      <div class="drag-overlay-message">
        📂 Drop file anywhere
      </div>
    </div>
  </div>
`;

// Elements
const fileInput = document.getElementById('fileInput');
const urlForm = document.getElementById('urlForm');
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const cancelBtn = document.getElementById('cancelBtn');
const proxyList = document.getElementById('proxyList');
const customProxy = document.getElementById('customProxy');
const candidatesBox = document.getElementById('candidates');
const status = document.getElementById('status');
const progress = document.getElementById('progress');
const log = document.getElementById('log');
const output = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const saveHistoryBtn = document.getElementById('saveHistoryBtn');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const sidebar = document.getElementById('sidebar');
const historyList = document.getElementById('historyList');
const dragOverlay = document.getElementById('dragOverlay');

let currentSourceName = '';
let currentSourceUrl = '';
let controller = null;

/* ------------------------------------------------------------------ *
 * Status, progress and log
 * ------------------------------------------------------------------ */

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function showProgress({ loaded, total, streaming }) {
  progress.hidden = false;
  if (streaming) {
    progress.textContent = `Read ${formatBytes(loaded)} of ${formatBytes(total)} (metadata only)`;
  } else if (total) {
    const percent = Math.min(100, Math.round((loaded / total) * 100));
    progress.textContent = `Downloaded ${formatBytes(loaded)} of ${formatBytes(total)} (${percent}%)`;
  } else {
    progress.textContent = `Downloaded ${formatBytes(loaded)}`;
  }
}

function clearProgress() {
  progress.hidden = true;
  progress.textContent = '';
}

function logLine(text, kind = '') {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = line.trim();
    log.appendChild(li);
  }
}

function clearLog() {
  log.innerHTML = '';
}

function setResultAvailable(available) {
  copyBtn.disabled = !available;
  downloadBtn.disabled = !available;
  saveHistoryBtn.disabled = !available;
}

/* ------------------------------------------------------------------ *
 * Network options
 * ------------------------------------------------------------------ */

let proxySettings = loadProxySettings();

for (const proxy of BUILT_IN_PROXIES) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = proxy.id;
  checkbox.checked = proxySettings.enabled.includes(proxy.id);
  checkbox.addEventListener('change', () => {
    proxySettings.enabled = [
      ...proxyList.querySelectorAll('input:checked'),
    ].map((i) => i.value);
    saveProxySettings(proxySettings);
  });
  label.append(checkbox, document.createTextNode(` ${proxy.label}`));
  proxyList.appendChild(label);
}

customProxy.value = proxySettings.custom;
customProxy.addEventListener('change', () => {
  proxySettings.custom = customProxy.value.trim();
  saveProxySettings(proxySettings);
});

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

async function runExtraction(source, name, sourceUrl) {
  setStatus('Parsing metadata…');
  const { metadata, workflow } = await analyzeSource(source);

  currentSourceName = name;
  currentSourceUrl = sourceUrl || '';

  if (workflow) {
    setStatus('Workflow extracted', 'ok');
    copyBtn.textContent = 'Copy Workflow';
    output.value = prettyJson(workflow);
  } else {
    setStatus('No workflow found! Showing all metadata searched', 'error');
    copyBtn.textContent = 'Copy Metadata';
    output.value = JSON.stringify(metadata, null, 2);
  }

  setResultAvailable(true);
}

function remoteContext() {
  return {
    transports: buildTransports(proxySettings),
    signal: controller.signal,
    onNote: (text) => logLine(text),
    onProgress: showProgress,
  };
}

/** Wrap a remote run: one controller at a time, uniform error reporting. */
async function withRemoteRun(work) {
  if (!buildTransports(proxySettings).length) {
    setStatus(
      'Enable at least one fetch method under Network options.',
      'error',
    );
    return;
  }

  controller?.abort();
  controller = new AbortController();
  fetchBtn.disabled = true;
  cancelBtn.hidden = false;

  try {
    await work();
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Cancelled', 'muted');
    } else {
      setStatus(String(err.message).split('\n')[0], 'error');
      logLine(err.message, 'error');
      console.error(err);
    }
  } finally {
    fetchBtn.disabled = false;
    cancelBtn.hidden = true;
    controller = null;
    clearProgress();
  }
}

function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

async function extractFromVideoUrl(videoUrl, sourceUrl) {
  logLine(`Video: ${videoUrl}`);
  setStatus('Reading video…');
  const source = await openRemoteVideo(videoUrl, remoteContext());
  await runExtraction(source, filenameFromUrl(videoUrl), sourceUrl || videoUrl);
}

function renderCandidates(candidates, pageUrl) {
  candidatesBox.hidden = false;
  candidatesBox.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'candidates-heading';
  heading.textContent = `${candidates.length} videos found on that page — pick one:`;
  candidatesBox.appendChild(heading);

  for (const candidate of candidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate';
    button.title = candidate.url;

    const name = document.createElement('span');
    name.className = 'candidate-name';
    name.textContent = filenameFromUrl(candidate.url);

    const meta = document.createElement('span');
    meta.className = 'candidate-meta';
    meta.textContent = candidate.likely
      ? candidate.source
      : `${candidate.source} (no file extension)`;

    button.append(name, meta);
    button.addEventListener('click', () => {
      candidatesBox.hidden = true;
      clearLog();
      withRemoteRun(() => extractFromVideoUrl(candidate.url, pageUrl));
    });

    candidatesBox.appendChild(button);
  }
}

function clearCandidates() {
  candidatesBox.hidden = true;
  candidatesBox.innerHTML = '';
}

async function handleUrl(rawInput) {
  const url = normalizeUrl(rawInput);
  if (!url) {
    setStatus('That does not look like a URL.', 'error');
    return;
  }

  clearCandidates();
  clearLog();
  setResultAvailable(false);
  output.value = '';

  await withRemoteRun(async () => {
    if (looksLikeVideoUrl(url)) {
      await extractFromVideoUrl(url, url);
      return;
    }

    setStatus('Fetching page…');
    logLine(`Fetching ${url}`);
    const page = await resolvePage(url, remoteContext());

    if (page.kind === 'video') {
      logLine('The server returned a video, so using this URL directly.');
      await extractFromVideoUrl(url, url);
      return;
    }

    if (page.candidates.length === 0) {
      setStatus('No video files found on that page.', 'error');
      logLine(
        'Nothing on the page looked like an .mp4/.webm/.mov file. If the video only loads after ' +
          'a script runs, open it directly (right-click the video → copy video address) and paste that URL.',
      );
      return;
    }

    logLine(`Found ${page.candidates.length} video candidate(s).`);

    if (page.candidates.length === 1) {
      await extractFromVideoUrl(page.candidates[0].url, url);
    } else {
      renderCandidates(page.candidates, url);
      setStatus('Multiple videos found — pick one below.', 'muted');
    }
  });
}

urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleUrl(urlInput.value);
});

cancelBtn.addEventListener('click', () => controller?.abort());

// File Upload Handler
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  clearCandidates();
  clearLog();
  clearProgress();
  setResultAvailable(false);
  output.value = '';
  setStatus('Reading metadata...');

  try {
    await runExtraction(sourceFromBlob(file), file.name, '');
  } catch (err) {
    setStatus('Error parsing file metadata', 'error');
    console.error(err);
  }
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

// Render history list from LocalStorage
function renderHistory() {
  const history = getHistory();
  historyList.innerHTML = '';

  if (history.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No saved items';
    historyList.appendChild(empty);
    return;
  }

  history.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    // Built as nodes rather than markup: names can come from a pasted URL.
    const info = document.createElement('div');
    info.className = 'history-item-info';

    const name = document.createElement('span');
    name.className = 'history-item-name';
    name.textContent = item.fileName;
    if (item.sourceUrl) name.title = item.sourceUrl;

    const date = document.createElement('span');
    date.className = 'history-item-date';
    date.textContent = new Date(item.timestamp).toLocaleString();

    info.append(name, date);

    const actions = document.createElement('div');
    actions.className = 'action-buttons';

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-item-btn';
    editBtn.title = 'Rename item';
    editBtn.textContent = '✏️';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-item-btn';
    deleteBtn.title = 'Delete item';
    deleteBtn.textContent = '🗑';

    actions.append(editBtn, deleteBtn);
    li.append(info, actions);

    // Click on item body -> Load into editor
    li.addEventListener('click', (e) => {
      if (
        e.target.classList.contains('delete-item-btn') ||
        e.target.classList.contains('edit-item-btn')
      )
        return;

      output.value = item.data;
      currentSourceName = item.fileName;
      currentSourceUrl = item.sourceUrl || '';
      setStatus(`Loaded "${item.fileName}" from history`);
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
    });

    // Click pencil icon -> Open prompt to edit name
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = window.prompt('Enter new name:', item.fileName);
      if (newName !== null && newName.trim() !== '') {
        updateHistoryItemName(item.id, newName.trim());
      }
    });

    // Click delete button -> Remove item
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(item.id);
    });

    historyList.appendChild(li);
  });
}

function deleteHistoryItem(id) {
  const history = getHistory().filter((item) => item.id !== id);
  saveHistory(history);
  renderHistory();
}

function updateHistoryItemName(id, newName) {
  const history = getHistory();
  const item = history.find((i) => i.id === id);
  if (item) {
    item.fileName = newName;
    saveHistory(history);
    renderHistory();
  }
}

/* ------------------------------------------------------------------ *
 * Output actions
 * ------------------------------------------------------------------ */

copyBtn.addEventListener('click', async () => {
  const original = copyBtn.textContent;
  copyBtn.textContent = 'Copied';
  setTimeout(() => {
    copyBtn.textContent = original;
  }, 2000);
  await navigator.clipboard.writeText(output.value);
});

downloadBtn.addEventListener('click', async () => {
  downloadBtn.textContent = 'Downloading...';
  setTimeout(() => {
    downloadBtn.textContent = 'Download';
  }, 2000);
  const blob = new Blob([output.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'workflow.json';
  a.click();
  URL.revokeObjectURL(url);
});

saveHistoryBtn.addEventListener('click', () => {
  if (!output.value) return;

  const history = getHistory();
  const newItem = {
    id: Date.now().toString(),
    fileName: currentSourceName || 'Untitled Workflow',
    sourceUrl: currentSourceUrl,
    timestamp: Date.now(),
    data: output.value,
  };

  history.unshift(newItem); // Add newest item first
  saveHistory(history);
  renderHistory();
});

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

clearAllBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all saved history?')) {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    renderHistory();
  }
});

// Initial Render
renderHistory();

/* ------------------------------------------------------------------ *
 * Drag and drop
 * ------------------------------------------------------------------ */

// Prevent default drag behaviors across the window
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => e.preventDefault());
  window.addEventListener(eventName, (e) => e.stopPropagation());
});

// Show signal/overlay when dragging a file over the window
let dragCounter = 0; // Helps track nested child element hover states

window.addEventListener('dragenter', (e) => {
  dragCounter++;
  if (e.dataTransfer.types.includes('Files')) {
    dragOverlay.classList.remove('hidden');
  }
});

window.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter === 0) {
    dragOverlay.classList.add('hidden');
  }
});

// Handle the dropped file anywhere on the page
window.addEventListener('drop', (e) => {
  dragCounter = 0;
  dragOverlay.classList.add('hidden');

  // A URL dragged in from another tab is treated the same as a pasted one.
  const droppedText =
    e.dataTransfer.getData('text/uri-list') ||
    e.dataTransfer.getData('text/plain');

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    fileInput.files = files;
    fileInput.dispatchEvent(new Event('change'));
  } else if (droppedText && normalizeUrl(droppedText)) {
    urlInput.value = droppedText.trim();
    handleUrl(droppedText);
  }
});
