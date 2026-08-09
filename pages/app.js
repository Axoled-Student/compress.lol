import { FFmpeg } from './vendor/ffmpeg/index.js';
import { toBlobURL } from './vendor/util/index.js';

await window.__coiReady;

const MB = 1024 * 1024;
const MAX_INPUT_BYTES = 500 * MB;
const MAX_TARGET_MB = 500;

const els = {
  videoInput: document.querySelector('#videoInput'),
  filePickerTitle: document.querySelector('#filePickerTitle'),
  filePickerMeta: document.querySelector('#filePickerMeta'),
  metadata: document.querySelector('#metadata'),
  metaName: document.querySelector('#metaName'),
  metaSize: document.querySelector('#metaSize'),
  metaDuration: document.querySelector('#metaDuration'),
  metaResolution: document.querySelector('#metaResolution'),
  presetGrid: document.querySelector('#presetGrid'),
  customWrap: document.querySelector('#customWrap'),
  customTarget: document.querySelector('#customTarget'),
  targetSummary: document.querySelector('#targetSummary'),
  compressButton: document.querySelector('#compressButton'),
  status: document.querySelector('#status'),
  progressWrap: document.querySelector('#progressWrap'),
  progressText: document.querySelector('#progressText'),
  progressPercent: document.querySelector('#progressPercent'),
  progressBar: document.querySelector('#progressBar'),
  result: document.querySelector('#result'),
  resultSize: document.querySelector('#resultSize'),
  savedPercent: document.querySelector('#savedPercent'),
  downloadButton: document.querySelector('#downloadButton'),
  errorBox: document.querySelector('#errorBox')
};

let ffmpeg;
let ffmpegReady = false;
let selectedFile = null;
let metadata = null;
let targetMode = '25';
let outputBytes = null;
let processing = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function clearError() {
  els.errorBox.textContent = '';
  els.errorBox.classList.add('hidden');
}

function setStatus(message) {
  els.status.textContent = message;
}

function setProgress(percent, message = 'Compressing…') {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressWrap.classList.remove('hidden');
  els.progressText.textContent = message;
  els.progressPercent.textContent = `${value}%`;
  els.progressBar.style.width = `${value}%`;
}

function getTargetMB() {
  if (targetMode === 'custom') {
    return Number.parseFloat(els.customTarget.value);
  }
  return Number.parseFloat(targetMode);
}

function validateTarget(showMessage = false) {
  const targetMB = getTargetMB();
  let message = '';
  if (!Number.isFinite(targetMB) || targetMB < 1 || targetMB > MAX_TARGET_MB) {
    message = 'Target size must be between 1 MB and 500 MB.';
  } else if (selectedFile && targetMB * MB >= selectedFile.size) {
    message = `Choose a target smaller than the source file (${formatBytes(selectedFile.size)}).`;
  }
  if (showMessage && message) showError(message);
  return !message;
}

function updateActionState() {
  els.compressButton.disabled = processing || !ffmpegReady || !selectedFile || !metadata || !validateTarget(false);
}

function updateTargetUI() {
  const targetMB = getTargetMB();
  els.targetSummary.textContent = Number.isFinite(targetMB) ? `${targetMB} MB` : 'Invalid';
  els.customWrap.classList.toggle('hidden', targetMode !== 'custom');
  for (const button of els.presetGrid.querySelectorAll('.preset')) {
    button.classList.toggle('active', button.dataset.mb === targetMode);
  }
  clearError();
  updateActionState();
}

async function readVideoMetadata(file) {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('The browser could not read this video container.'));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Could not determine the video duration.');
    }
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function selectFile(file) {
  clearError();
  outputBytes = null;
  els.result.classList.add('hidden');
  els.progressWrap.classList.add('hidden');

  if (!file) {
    selectedFile = null;
    metadata = null;
    els.metadata.classList.add('hidden');
    updateActionState();
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    els.videoInput.value = '';
    showError(`This Pages edition supports source files up to 500 MB. Selected file: ${formatBytes(file.size)}.`);
    return;
  }

  selectedFile = file;
  els.filePickerTitle.textContent = file.name;
  els.filePickerMeta.textContent = formatBytes(file.size);
  els.metaName.textContent = file.name;
  els.metaSize.textContent = formatBytes(file.size);
  els.metaDuration.textContent = 'Reading…';
  els.metaResolution.textContent = 'Reading…';
  els.metadata.classList.remove('hidden');
  setStatus('Reading video metadata…');
  updateActionState();

  try {
    metadata = await readVideoMetadata(file);
    els.metaDuration.textContent = formatDuration(metadata.duration);
    els.metaResolution.textContent = metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : 'Unknown';
    setStatus(ffmpegReady ? 'Ready to compress.' : 'FFmpeg is still loading…');
  } catch (error) {
    metadata = null;
    showError(error instanceof Error ? error.message : 'Unable to read video metadata.');
    setStatus('Video metadata failed.');
  }
  updateActionState();
}

function calculateBitrates(targetMB, durationSeconds) {
  const targetBytes = targetMB * MB;
  // Leave ~3.5% for MP4 container overhead and bitrate variation.
  const usableBits = targetBytes * 8 * 0.965;
  const totalKbps = Math.floor(usableBits / durationSeconds / 1000);
  if (totalKbps < 140) {
    throw new Error('The selected target is too small for this video duration. Choose a larger target size.');
  }
  const audioKbps = Math.max(64, Math.min(128, Math.floor(totalKbps * 0.09)));
  const videoKbps = Math.max(80, totalKbps - audioKbps);
  return { videoKbps, audioKbps };
}

async function cleanupFFmpeg(inputDir) {
  if (!ffmpeg) return;
  try { await ffmpeg.unmount(inputDir); } catch {}
  try { await ffmpeg.deleteDir(inputDir); } catch {}
  try { await ffmpeg.deleteFile('output.mp4'); } catch {}
}

async function compress() {
  if (!selectedFile || !metadata || !ffmpegReady || !ffmpeg || processing) return;
  clearError();
  if (!validateTarget(true)) return;

  const targetMB = getTargetMB();
  let bitrates;
  try {
    bitrates = calculateBitrates(targetMB, metadata.duration);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Unable to calculate bitrate.');
    return;
  }

  processing = true;
  outputBytes = null;
  els.result.classList.add('hidden');
  els.compressButton.disabled = true;
  setProgress(0, 'Mounting source video…');
  setStatus(`Compressing toward ${targetMB} MB…`);

  const inputDir = '/input';
  const inputPath = `${inputDir}/${selectedFile.name}`;
  const threads = window.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

  try {
    await cleanupFFmpeg(inputDir);
    await ffmpeg.createDir(inputDir);
    // WORKERFS exposes the browser File directly instead of duplicating the full input into MEMFS.
    await ffmpeg.mount('WORKERFS', { files: [selectedFile] }, inputDir);

    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', `${bitrates.videoKbps}k`,
      '-maxrate', `${bitrates.videoKbps}k`,
      '-bufsize', `${bitrates.videoKbps * 2}k`,
      '-threads', String(threads),
      '-c:a', 'aac',
      '-b:a', `${bitrates.audioKbps}k`,
      '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y', 'output.mp4'
    ];

    setProgress(1, 'Encoding video…');
    await ffmpeg.exec(args);
    setProgress(99, 'Reading compressed file…');
    const data = await ffmpeg.readFile('output.mp4');
    outputBytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);

    const saved = Math.max(0, (1 - outputBytes.length / selectedFile.size) * 100);
    els.resultSize.textContent = formatBytes(outputBytes.length);
    els.savedPercent.textContent = `${saved.toFixed(1)}%`;
    els.result.classList.remove('hidden');
    setProgress(100, 'Complete');
    setStatus(`Finished. Target was ${targetMB} MB; actual output is ${formatBytes(outputBytes.length)}.`);
  } catch (error) {
    console.error(error);
    showError(error instanceof Error ? error.message : 'Compression failed. Try a larger target or a smaller source video.');
    setStatus('Compression failed.');
  } finally {
    await cleanupFFmpeg(inputDir);
    processing = false;
    updateActionState();
  }
}

function download() {
  if (!outputBytes || !selectedFile) return;
  const blob = new Blob([outputBytes], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stem = selectedFile.name.replace(/\.[^.]+$/, '') || 'video';
  link.href = url;
  link.download = `${stem}-compressed-${getTargetMB()}MB.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.videoInput.addEventListener('change', () => selectFile(els.videoInput.files?.[0] || null));
els.presetGrid.addEventListener('click', (event) => {
  const button = event.target.closest('.preset');
  if (!button) return;
  targetMode = button.dataset.mb;
  updateTargetUI();
  if (targetMode === 'custom') els.customTarget.focus();
});
els.customTarget.addEventListener('input', updateTargetUI);
els.compressButton.addEventListener('click', compress);
els.downloadButton.addEventListener('click', download);

async function loadFFmpeg() {
  try {
    if (!window.crossOriginIsolated) {
      setStatus('Preparing browser isolation for FFmpeg…');
    }
    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (!processing || !Number.isFinite(progress)) return;
      setProgress(Math.max(1, Math.min(98, progress * 98)), 'Encoding video…');
    });
    ffmpeg.on('log', ({ message }) => {
      if (processing && message) console.debug('[ffmpeg]', message);
    });

    setStatus('Loading FFmpeg core…');
    await ffmpeg.load({
      coreURL: await toBlobURL('./ffmpeg/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL('./ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
      workerURL: await toBlobURL('./ffmpeg/ffmpeg-core.worker.js', 'text/javascript')
    });
    ffmpegReady = true;
    setStatus(selectedFile && metadata ? 'Ready to compress.' : 'FFmpeg ready. Choose a video.');
  } catch (error) {
    console.error(error);
    showError('FFmpeg failed to load. Refresh the page once; if it still fails, try a Chromium-based desktop browser.');
    setStatus('FFmpeg failed to load.');
  }
  updateActionState();
}

updateTargetUI();
loadFFmpeg();
