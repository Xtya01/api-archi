const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const IA_USERNAME = process.env.IA_USERNAME || 'demo';
const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY || '';
const IA_SECRET_KEY = process.env.IA_SECRET_KEY || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET || ADMIN_PASS + '_archive_drive_secret';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory recent uploads cache
let recentUploads = [];

// Simple JWT-like token (no external lib)
function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (s !== expected) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = payload;
  next();
}

// Multer config - 5GB limit
const upload = multer({
  dest: '/tmp',
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = signToken({ user: username });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/myitems', authMiddleware, async (req, res) => {
  try {
    const url = `https://archive.org/advancedsearch.php?q=uploader:${encodeURIComponent(IA_USERNAME)}&fl[]=identifier&fl[]=title&fl[]=description&fl[]=date&fl[]=item_size&fl[]=mediatype&sort[]=addeddate desc&output=json&rows=100`;
    const iaRes = await axios.get(url, { timeout: 15000 });
    const docs = iaRes.data?.response?.docs || [];
    
    const iaResults = docs.map(d => ({
      identifier: d.identifier,
      title: d.title || d.identifier,
      description: d.description || '',
      date: d.date,
      size: d.item_size,
      mediatype: d.mediatype,
      instant: false
    }));

    // Merge with recentUploads
    const merged = [...recentUploads, ...iaResults];
    const seen = new Set();
    const deduped = merged.filter(item => {
      if (seen.has(item.identifier)) return false;
      seen.add(item.identifier);
      return true;
    }).slice(0, 100);

    res.json({ items: deduped, count: deduped.length });
  } catch (err) {
    console.error('myitems error', err.message);
    // Return cache only on error
    res.json({ items: recentUploads, count: recentUploads.length, warning: 'IA search failed, showing recent only' });
  }
});

app.get('/api/files/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const metaUrl = `https://archive.org/metadata/${encodeURIComponent(id)}`;
    const meta = await axios.get(metaUrl, { timeout: 15000 });
    const files = meta.data?.files || [];
    
    const filtered = files.filter(f => {
      const name = f.name || '';
      if (!name) return false;
      if (name.endsWith('.xml')) return false;
      if (name.endsWith('.sqlite')) return false;
      if (name.startsWith('__')) return false;
      if (name.includes('_meta')) return false;
      if (name.includes('_files.xml')) return false;
      if (name === `${id}_files.xml`) return false;
      return true;
    }).map(f => ({
      name: f.name,
      size: parseInt(f.size) || 0,
      source: f.source,
      format: f.format,
      url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`
    }));

    res.json({ identifier: id, files: filtered, count: filtered.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch files', details: err.message });
  }
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!IA_ACCESS_KEY || !IA_SECRET_KEY) return res.status(500).json({ error: 'IA keys not configured' });

    const file = req.file;
    const customId = req.body.identifier?.trim();
    const identifier = customId || `archive-drive-${Date.now()}`;
    const filename = file.originalname;
    const filePath = file.path;
    const fileSize = file.size;

    const url = `https://s3.us.archive.org/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
    
    const headers = {
      'Authorization': `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}`,
      'Content-Length': fileSize,
      'x-amz-auto-make-bucket': '1',
      'x-archive-meta01-collection': 'opensource',
      'x-archive-meta-title': req.body.title || filename,
      'x-archive-meta-mediatype': 'data',
      'x-archive-meta-uploader': IA_USERNAME,
      'x-archive-meta-description': req.body.description || `Uploaded via Archive Drive on ${new Date().toISOString()}`
    };

    const stream = fs.createReadStream(filePath);
    await axios.put(url, stream, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0
    });

    // Cleanup
    fs.unlink(filePath, () => {});

    const newItem = {
      identifier,
      title: req.body.title || filename,
      description: headers['x-archive-meta-description'],
      date: new Date().toISOString(),
      size: fileSize,
      mediatype: 'data',
      instant: true
    };

    recentUploads.unshift(newItem);
    if (recentUploads.length > 50) recentUploads = recentUploads.slice(0, 50);

    res.json({ success: true, identifier, filename, url: `https://archive.org/details/${identifier}` });
  } catch (err) {
    console.error('upload error', err.response?.data || err.message);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Upload failed', details: err.response?.data || err.message });
  }
});

app.post('/api/upload-url', authMiddleware, async (req, res) => {
  try {
    const { url: remoteUrl, filename, identifier: customId, title } = req.body;
    if (!remoteUrl) return res.status(400).json({ error: 'URL required' });
    if (!IA_ACCESS_KEY) return res.status(500).json({ error: 'IA keys not configured' });

    const tmpPath = `/tmp/dl-${Date.now()}`;
    const writer = fs.createWriteStream(tmpPath);
    
    const response = await axios({ method: 'get', url: remoteUrl, responseType: 'stream', timeout: 0 });
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const stats = fs.statSync(tmpPath);
    const fileSize = stats.size;
    const finalFilename = filename || path.basename(new URL(remoteUrl).pathname) || 'download';
    const identifier = customId || `archive-drive-${Date.now()}`;

    const uploadUrl = `https://s3.us.archive.org/${encodeURIComponent(identifier)}/${encodeURIComponent(finalFilename)}`;
    const headers = {
      'Authorization': `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}`,
      'Content-Length': fileSize,
      'x-amz-auto-make-bucket': '1',
      'x-archive-meta01-collection': 'opensource',
      'x-archive-meta-title': title || finalFilename,
      'x-archive-meta-mediatype': 'data',
      'x-archive-meta-uploader': IA_USERNAME
    };

    const stream = fs.createReadStream(tmpPath);
    await axios.put(uploadUrl, stream, { headers, maxBodyLength: Infinity, timeout: 0 });
    fs.unlink(tmpPath, () => {});

    const newItem = {
      identifier,
      title: title || finalFilename,
      date: new Date().toISOString(),
      size: fileSize,
      mediatype: 'data',
      instant: true
    };
    recentUploads.unshift(newItem);
    if (recentUploads.length > 50) recentUploads = recentUploads.slice(0, 50);

    res.json({ success: true, identifier, filename: finalFilename, url: `https://archive.org/details/${identifier}` });
  } catch (err) {
    console.error('upload-url error', err.message);
    res.status(500).json({ error: 'URL upload failed', details: err.message });
  }
});


// Cloudflare-cacheable stream proxy
app.get('/api/stream/:id/*', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const file = req.params[0];
    const url = `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
    
    // Set Cloudflare cache headers - 1 year immutable
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('CDN-Cache-Control', 'max-age=31536000');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 0
    });
    
    // Forward content type and length
    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
    
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Fallback to SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Archive Drive running on http://0.0.0.0:${PORT}`);
});
