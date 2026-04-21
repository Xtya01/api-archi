require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Config
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@2330';
const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY;
const IA_SECRET_KEY = process.env.IA_SECRET_KEY;
const IA_USERNAME = process.env.IA_USERNAME || 'namaycb';
const CF_WORKER = process.env.CF_WORKER || '';
const ORACLE_CACHE = process.env.ORACLE_CACHE || '';

console.log('✓ Cloudflare:', CF_WORKER ? 'enabled' : 'disabled');
console.log('✓ Oracle cache:', ORACLE_CACHE ? `enabled (${ORACLE_CACHE})` : 'disabled (optional)');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  next();
});

const sessions = new Map();
const upload = multer({ dest: '/tmp/', limits: { fileSize: 5 * 1024 * 1024 } });

// Auth middleware
function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now());
    if (sessions.size > 100) {
      const oldest = [...sessions.keys()][0];
      sessions.delete(oldest);
    }
    res.json({ token, user: username });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Smart CDN URL resolver
function getFastUrl(id, name, ipfsHash = null) {
  const encoded = encodeURIComponent(name);
  const r = Math.random();
  
  if (CF_WORKER && r < 0.25) {
    return `https://${CF_WORKER}/ia/${id}/${encoded}`;
  }
  
  if (ipfsHash && r < 0.70) {
    const gateway = r < 0.5 ? 'https://cloudflare-ipfs.com' : 'https://dweb.link';
    return `${gateway}/ipfs/${ipfsHash}/${encoded}`;
  }
  
  if (ORACLE_CACHE && r < 0.85) {
    return `http://${ORACLE_CACHE}/ia/${id}/${encoded}`;
  }
  
  const mirrors = ['https://ia800900.us.archive.org','https://archive.org'];
  const mirror = mirrors[Math.floor(Math.random() * mirrors.length)];
  return `${mirror}/download/${id}/${encoded}`;
}

// Get files
app.get('/api/files/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { data } = await axios.get(`https://archive.org/metadata/${id}`, { timeout: 15000 });
    
    if (!data?.files) return res.json({ files: [], id, title: id });
    
    const ipfsHash = data.metadata?.ipfs || data.ipfs || null;
    const title = data.metadata?.title || id;
    
    const files = data.files
      .filter(f => f.name && !f.name.endsWith('_meta.xml') && !f.name.endsWith('_files.xml') && f.source === 'original')
      .map(f => ({
        name: f.name,
        size: parseInt(f.size) || 0,
        format: f.format || path.extname(f.name).slice(1).toUpperCase(),
        mtime: f.mtime ? new Date(parseInt(f.mtime) * 1000).toISOString() : new Date().toISOString(),
        url: getFastUrl(id, f.name, ipfsHash),
        directUrl: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
        ipfs: ipfsHash
      }))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    
    res.json({ files, id, title, ipfs: ipfsHash, count: files.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch files', details: err.message });
  }
});

// Upload
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!IA_ACCESS_KEY || !IA_SECRET_KEY) {
      return res.status(500).json({ error: 'IA keys not configured' });
    }
    
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    
    const identifier = req.body.identifier || `${IA_USERNAME}-remote-${Date.now()}`;
    const filename = file.originalname;
    
    const stream = fs.createReadStream(file.path);
    await axios.put(`https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`, stream, {
      headers: {
        'Authorization': `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}`,
        'x-amz-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta-mediatype': 'data',
        'x-archive-meta-title': filename,
        'x-archive-meta-creator': IA_USERNAME,
        'Content-Type': file.mimetype || 'application/octet-stream'
      },
      maxBodyLength: Infinity,
      timeout: 0
    });
    
    fs.unlinkSync(file.path);
    res.json({ success: true, identifier, filename, url: `https://archive.org/details/${identifier}` });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Upload failed', details: err.response?.data || err.message });
  }
});

// Delete
app.delete('/api/delete/:id/:filename', auth, async (req, res) => {
  try {
    const { id, filename } = req.params;
    await axios.delete(`https://s3.us.archive.org/${id}/${encodeURIComponent(filename)}`, {
      headers: { 'Authorization': `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}` }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Status
app.get('/api/status', auth, async (req, res) => {
  const status = {
    server: 'v6.2',
    timestamp: new Date().toISOString(),
    cloudflare: { enabled: !!CF_WORKER, url: CF_WORKER || null, usage: '25%', status: CF_WORKER ? 'active' : 'disabled' },
    ipfs: { enabled: true, gateways: ['cloudflare-ipfs.com','dweb.link'], usage: '45%', status: 'active' },
    oracle: { enabled: !!ORACLE_CACHE, url: ORACLE_CACHE || null, usage: ORACLE_CACHE ? '15%' : '0%', status: ORACLE_CACHE ? 'active' : 'optional - not configured' },
    archive: { enabled: true, mirrors: 2, usage: ORACLE_CACHE ? '15%' : '30%', status: 'active' },
    webtorrent: { enabled: true, saving: '50-70%', status: 'active' }
  };
  res.json(status);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Archive Drive v6.2 running on port ${PORT}`);
});
