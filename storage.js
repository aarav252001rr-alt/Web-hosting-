const axios   = require('axios');
const FormData = require('form-data');
const JSZip   = require('jszip');

const TOKEN = process.env.BOT_TOKEN;

const CONTENT_TYPES = {
  'html': 'text/html;charset=UTF-8', 'htm': 'text/html;charset=UTF-8',
  'css':  'text/css', 'js': 'application/javascript',
  'json': 'application/json', 'xml': 'application/xml',
  'png':  'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
  'gif':  'image/gif', 'svg': 'image/svg+xml', 'ico': 'image/x-icon',
  'webp': 'image/webp', 'woff': 'font/woff', 'woff2': 'font/woff2',
  'ttf':  'font/ttf', 'otf': 'font/otf',
  'txt':  'text/plain', 'pdf': 'application/pdf',
  'mp4':  'video/mp4', 'webm': 'video/webm',
};

function getContentType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ── Download from Telegram ────────────────────────────────────────────────────
async function getTgFileInfo(fileId) {
  const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  if (!res.data.ok) throw new Error('Cannot get file info from Telegram');
  return res.data.result;
}

async function downloadFromTelegram(fileId) {
  const info = await getTgFileInfo(fileId);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`;
  const res  = await axios.get(url, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), filePath: info.file_path };
}

// ── Upload single buffer to Telegram channel ──────────────────────────────────
async function uploadToTelegram(buffer, filename, chatId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename });

  const res = await axios.post(
    `https://api.telegram.org/bot${TOKEN}/sendDocument`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );

  if (!res.data.ok) throw new Error('Telegram upload failed: ' + res.data.description);
  const doc = res.data.result.document;
  return { fileId: doc.file_id, size: doc.file_size };
}

// ── Extract ZIP ───────────────────────────────────────────────────────────────
async function extractZip(buffer) {
  const zip   = await JSZip.loadAsync(buffer);
  const files = {};

  const tasks = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    if (relPath.includes('__MACOSX') || relPath.includes('.DS_Store')) return;

    // Strip top-level folder if present
    const parts = relPath.split('/');
    const cleanPath = parts.length > 1 && !relPath.startsWith('/') ? parts.slice(1).join('/') : relPath;
    if (!cleanPath) return;

    tasks.push(entry.async('nodebuffer').then(buf => { files[cleanPath] = buf; }));
  });

  await Promise.all(tasks);

  // Ensure index.html exists
  if (!files['index.html'] && !files['index.htm']) {
    const htmlKey = Object.keys(files).find(k => k.endsWith('.html') || k.endsWith('.htm'));
    if (htmlKey) { files['index.html'] = files[htmlKey]; delete files[htmlKey]; }
  }

  return files; // { 'index.html': Buffer, 'css/style.css': Buffer, ... }
}

// ── Main: Process uploaded file/zip → store in Telegram ──────────────────────
// Returns array of { path, tgFileId, size, contentType }
async function processUpload(buffer, originalName, storageChatId) {
  const ext   = (originalName.split('.').pop() || '').toLowerCase();
  const isZip = ext === 'zip';

  let fileMap = {}; // { 'index.html': Buffer, ... }

  if (isZip) {
    fileMap = await extractZip(buffer);
    if (!Object.keys(fileMap).length) throw new Error('ZIP file empty hai');
  } else {
    // Single file — treat as index.html
    fileMap['index.html'] = buffer;
  }

  // Upload each file to Telegram storage channel
  const results = [];
  for (const [filePath, buf] of Object.entries(fileMap)) {
    const ct = getContentType(filePath);
    const { fileId, size } = await uploadToTelegram(buf, filePath, storageChatId);
    results.push({ path: filePath, tgFileId: fileId, size, contentType: ct });
    await new Promise(r => setTimeout(r, 300)); // Rate limit safe
  }

  return results;
}

// ── Serve file for Worker API ─────────────────────────────────────────────────
// requestPath = "/about.html" or "/" or "/css/style.css"
async function serveFile(site, requestPath) {
  let lookupPath = (requestPath || '/').replace(/^\//, '') || 'index.html';

  // Directory → try index.html
  if (!lookupPath.includes('.') || lookupPath.endsWith('/')) {
    lookupPath = lookupPath.replace(/\/$/, '') + '/index.html';
    if (lookupPath.startsWith('/')) lookupPath = lookupPath.slice(1);
    if (lookupPath === '/index.html') lookupPath = 'index.html';
  }

  let fileEntry = site.files.find(f => f.path === lookupPath);

  // Fallback to index.html
  if (!fileEntry) fileEntry = site.files.find(f => f.path === 'index.html' || f.path === 'index.htm');
  if (!fileEntry) return null;

  // Get fresh Telegram file path
  const info = await getTgFileInfo(fileEntry.tgFileId);
  return {
    telegramUrl: `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`,
    contentType: fileEntry.contentType || 'text/html;charset=UTF-8',
    size: fileEntry.size,
  };
}

module.exports = { processUpload, serveFile, downloadFromTelegram, getContentType, getTgFileInfo };
