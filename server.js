/**
 * Archive Drive v6.3 - Instant Uploads + URL Upload
 */
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  IA_USERNAME: process.env.IA_USERNAME || 'namaycb',
  IA_ACCESS_KEY: process.env.IA_ACCESS_KEY,
  IA_SECRET_KEY: process.env.IA_SECRET_KEY,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'Admin@2330',
};

console.log('=== Archive Drive v6.3 ===');

app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessions = new Map();
const recentUploads = []; // INSTANT CACHE
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } });

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: username });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid' });
});

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token ||!sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Helpers
function getUrl(id, file) { return `https://archive.org/download/${id}/${encodeURIComponent(file)}`; }

// My Items - MERGES INSTANT CACHE
app.get('/api/myitems', auth, async (req, res) => {
  try {
    const url = `https://archive.org/advancedsearch.php?q=uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=item_size&sort[]=date desc&rows=100&output=json`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const iaItems = (data.response?.docs || []).map(d => ({
      identifier: d.identifier,
      title: d.title || d.identifier,
      date: d.date,
      size: d.item_size || 0,
      source: 'archive'
    }));

    // Merge instant uploads (show first)
    const all = [...recentUploads,...iaItems];
    const unique = Array.from(new Map(all.map(i => [i.identifier, i])).values());

    res.json({ items: unique.slice(0, 100), total: unique.length });
  } catch (e) {
    // If IA fails, still show recent uploads
    res.json({ items: recentUploads, total: recentUploads.length });
  }
});

// Files
app.get('/api/files/:id', auth, async (req, res) => {
  try {
    const { data } = await axios.get(`https://archive.org/metadata/${req.params.id}`, { timeout: 15000 });
    const files = (data.files || [])
     .filter(f => f.source === 'original' &&!f.name.match(/\.(xml|sqlite)$/) &&!f.name.startsWith('__'))
     .map(f => ({ name: f.name, size: parseInt(f.size) || 0, url: getUrl(req.params.id, f.name) }));
    res.json({ identifier: req.params.id, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FILE UPLOAD - INSTANT
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const identifier = req.body.identifier || `${CONFIG.IA_USERNAME}-upload-${Date.now()}`;
    const filename = req.file.originalname;
    const buffer = fs.readFileSync(req.file.path);

    await axios.put(`https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`, buffer, {
      headers: {
        'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
        'Content-Length': req.file.size,
        'x-amz-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta-title': filename,
        'x-archive-meta-uploader': CONFIG.IA_USERNAME
      },
      timeout: 600000
    });

    fs.unlinkSync(req.file.path);

    // ADD TO INSTANT CACHE
    recentUploads.unshift({
      identifier,
      title: filename,
      date: new Date().toISOString(),
      size: req.file.size,
      source: 'instant'
    });
    if (recentUploads.length > 50) recentUploads.pop();

    res.json({ success: true, identifier, filename, size: req.file.size });
  } catch (e) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// URL UPLOAD - NEW
app.post('/api/upload-url', auth, async (req, res) => {
  try {
    const { url, identifier: customId, filename: customName } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const identifier = customId || `${CONFIG.IA_USERNAME}-url-${Date.now()}`;
    const filename = customName || url.split('/').pop().split('?')[0] || 'file';

    console.log(`[URL] Downloading ${url}`);
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 600000, maxContentLength: 5 * 1024 * 1024 });
    const buffer = Buffer.from(response.data);

    await axios.put(`https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`, buffer, {
      headers: {
        'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
        'Content-Length': buffer.length,
        'x-amz-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta-title': filename,
        'x-archive-meta-source-url': url
      }
    });

    recentUploads.unshift({ identifier, title: filename, date: new Date().toISOString(), size: buffer.length, source: 'instant' });

    res.json({ success: true, identifier, filename, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`✓ Running on ${PORT}`));
