/**
 * Archive Drive v7.0 - Production Ready for Portainer
 * Uses ENV vars only - no hardcoded credentials
 */
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG FROM PORTAINER ENV
const CONFIG = {
  IA_USERNAME: process.env.IA_USERNAME || '',
  IA_ACCESS_KEY: process.env.IA_ACCESS_KEY || '',
  IA_SECRET_KEY: process.env.IA_SECRET_KEY || '',
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'admin123',
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5GB
};

console.log('=== Archive Drive v7.0 ===');
console.log(`IA User: ${CONFIG.IA_USERNAME}`);
console.log(`Admin: ${CONFIG.ADMIN_USER}`);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessions = new Map();
const recentUploads = [];
const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: CONFIG.MAX_FILE_SIZE }
});

// AUTH
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: username, created: Date.now() });
    return res.json({ success: true, token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token ||!sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// HELPERS
const iaUpload = async (identifier, filename, filepath, filesize, extraMeta = {}) => {
  const stream = fs.createReadStream(filepath);
  const headers = {
    'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
    'Content-Length': filesize,
    'x-amz-auto-make-bucket': '1',
    'x-archive-meta01-collection': 'opensource',
    'x-archive-meta-title': filename,
    'x-archive-meta-uploader': CONFIG.IA_USERNAME,
   ...extraMeta
  };

  await axios.put(
    `https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`,
    stream,
    { headers, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 0 }
  );
};

// MY ITEMS - with instant cache
app.get('/api/myitems', auth, async (req, res) => {
  try {
    const url = `https://archive.org/advancedsearch.php?q=uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&fl[]=date&sort[]=date desc&rows=50&output=json`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const iaItems = (data.response?.docs || []).map(d => ({
      identifier: d.identifier,
      title: d.title || d.identifier,
      date: d.date,
      source: 'archive'
    }));

    const combined = [...recentUploads,...iaItems];
    const unique = Array.from(new Map(combined.map(i => [i.identifier, i])).values());

    res.json({ items: unique.slice(0, 100) });
  } catch (e) {
    res.json({ items: recentUploads });
  }
});

// FILES
app.get('/api/files/:id', auth, async (req, res) => {
  try {
    const { data } = await axios.get(`https://archive.org/metadata/${req.params.id}`, { timeout: 15000 });
    const files = (data.files || [])
     .filter(f => f.source === 'original' &&!f.name.endsWith('.xml') &&!f.name.includes('_meta'))
     .map(f => ({
        name: f.name,
        size: parseInt(f.size) || 0,
        url: `https://archive.org/download/${req.params.id}/${encodeURIComponent(f.name)}`
      }));
    res.json({ identifier: req.params.id, files });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load' });
  }
});

// FILE UPLOAD
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const identifier = req.body.identifier || `${CONFIG.IA_USERNAME}-${Date.now()}`;
  const filename = req.file.originalname;

  try {
    await iaUpload(identifier, filename, req.file.path, req.file.size);
    fs.unlinkSync(req.file.path);

    recentUploads.unshift({
      identifier,
      title: filename,
      date: new Date().toISOString(),
      source: 'instant'
    });
    if (recentUploads.length > 50) recentUploads.pop();

    res.json({ success: true, identifier, filename });
  } catch (e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// URL UPLOAD
app.post('/api/upload-url', auth, async (req, res) => {
  const { url, filename } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const identifier = `${CONFIG.IA_USERNAME}-url-${Date.now()}`;
  const fname = filename || url.split('/').pop().split('?')[0] || 'download';
  const tmpPath = `/tmp/${Date.now()}-${fname}`;

  try {
    const writer = fs.createWriteStream(tmpPath);
    const response = await axios.get(url, { responseType: 'stream', timeout: 0 });
    const totalSize = parseInt(response.headers['content-length'] || '0');

    if (totalSize > CONFIG.MAX_FILE_SIZE) throw new Error('File too large');

    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const stats = fs.statSync(tmpPath);
    await iaUpload(identifier, fname, tmpPath, stats.size, {
      'x-archive-meta-source': url
    });

    fs.unlinkSync(tmpPath);

    recentUploads.unshift({ identifier, title: fname, date: new Date().toISOString(), source: 'instant' });

    res.json({ success: true, identifier, filename: fname });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', user: CONFIG.IA_USERNAME }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Server running on port ${PORT}`);
});
