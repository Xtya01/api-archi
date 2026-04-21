/**
 * Archive Drive v6.2.1 - Production Server
 * Fixed: 411 Length Required on upload
 * Features: auth, my-items, upload, streaming, Cloudflare fallback
 */
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const CONFIG = {
  IA_USERNAME: process.env.IA_USERNAME || 'namaycb',
  IA_ACCESS_KEY: process.env.IA_ACCESS_KEY,
  IA_SECRET_KEY: process.env.IA_SECRET_KEY,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'Admin@2330',
  CF_WORKER: process.env.CF_WORKER || '',
  ORACLE_CACHE: process.env.ORACLE_CACHE || ''
};

console.log('=== Archive Drive v6.2.1 Starting ===');
console.log('User:', CONFIG.IA_USERNAME);
console.log('IA Keys:', CONFIG.IA_ACCESS_KEY ? 'Configured ✓' : 'Missing ✗');
console.log('Cloudflare:', CONFIG.CF_WORKER || 'disabled');
console.log('Port:', PORT);

// ================= MIDDLEWARE =================
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessions = new Map();
const upload = multer({ 
  dest: '/tmp/uploads/',
  limits: { fileSize: 5 * 1024 } // 5GB
});

// ================= AUTH =================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[AUTH] Login: ${username}`);
  
  if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: username, created: Date.now() });
    return res.json({ token, user: username });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  if (!sessions.has(token)) return res.status(401).json({ error: 'Invalid token' });
  next();
};

// ================= HELPERS =================
function getFileUrl(identifier, filename) {
  const encoded = encodeURIComponent(filename);
  const rand = Math.random();
  if (CONFIG.CF_WORKER && rand < 0.3) {
    return `https://${CONFIG.CF_WORKER}/ia/${identifier}/${encoded}`;
  }
  if (CONFIG.ORACLE_CACHE && rand < 0.5) {
    return `http://${CONFIG.ORACLE_CACHE}/ia/${identifier}/${encoded}`;
  }
  return `https://archive.org/download/${identifier}/${encoded}`;
}

function isMediaFile(filename) {
  return /\.(mp4|mkv|avi|mov|webm|mp3|wav|flac|jpg|jpeg|png|gif|pdf)$/i.test(filename);
}

function isMetadataFile(filename) {
  return /\.(xml|sqlite)$/i.test(filename) || 
         filename.startsWith('__') ||
         filename.includes('_meta') ||
         filename.includes('_files') ||
         filename.includes('_reviews');
}

// ================= API ROUTES =================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '6.2.1',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get user's items
app.get('/api/myitems', auth, async (req, res) => {
  try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=item_size&fl[]=downloads&sort[]=date desc&rows=200&output=json`;
    const response = await axios.get(searchUrl, { timeout: 15000 });
    const docs = response.data.response?.docs || [];
    
    const items = docs.map(doc => ({
      identifier: doc.identifier,
      title: doc.title || doc.identifier,
      date: doc.date,
      size: doc.item_size || 0,
      downloads: doc.downloads || 0
    }));
    
    res.json({ items, total: items.length });
  } catch (error) {
    console.error('[API] myitems:', error.message);
    res.status(500).json({ error: 'Failed to fetch items', details: error.message });
  }
});

// Get files for item
app.get('/api/files/:id', auth, async (req, res) => {
  const identifier = req.params.id;
  try {
    const { data } = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 15000 });
    const files = (data.files || [])
      .filter(f => f.source === 'original' && !isMetadataFile(f.name))
      .map(f => ({
        name: f.name,
        size: parseInt(f.size) || 0,
        format: f.format,
        isMedia: isMediaFile(f.name),
        url: getFileUrl(identifier, f.name),
        directUrl: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`
      }))
      .sort((a, b) => b.size - a.size);
    
    res.json({
      identifier,
      title: data.metadata?.title,
      files,
      total: files.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files', details: error.message });
  }
});

// Upload - FIXED FOR 411 ERROR
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  console.log(`[UPLOAD] Starting: ${req.file?.originalname}`);
  
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  if (!CONFIG.IA_ACCESS_KEY || !CONFIG.IA_SECRET_KEY) {
    return res.status(500).json({ error: 'IA S3 keys not configured' });
  }
  
  const filepath = req.file.path;
  
  try {
    const identifier = req.body.identifier || `${CONFIG.IA_USERNAME}-upload-${Date.now()}`;
    const filename = req.file.originalname;
    const filesize = req.file.size;
    
    console.log(`[UPLOAD] ${identifier}/${filename} (${filesize} bytes)`);
    
    // Read file to buffer to get exact Content-Length (fixes 411)
    const fileBuffer = fs.readFileSync(filepath);
    
    const uploadUrl = `https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`;
    
    const response = await axios.put(uploadUrl, fileBuffer, {
      headers: {
        'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
        'Content-Length': filesize.toString(), // CRITICAL FIX
        'Content-Type': 'application/octet-stream',
        'x-amz-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta-mediatype': 'data',
        'x-archive-meta-title': filename.replace(/\.[^/.]+$/, '').substring(0, 100),
        'x-archive-meta-description': `Uploaded via Archive Drive on ${new Date().toISOString()}`,
        'x-archive-meta-uploader': CONFIG.IA_USERNAME,
        'x-archive-queue-derive': '0',
        'x-archive-size-hint': filesize.toString()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000, // 10 minutes
      validateStatus: (status) => status < 500
    });
    
    fs.unlinkSync(filepath);
    
    if (response.status >= 400) {
      throw new Error(`Archive.org returned ${response.status}: ${JSON.stringify(response.data)}`);
    }
    
    console.log(`[UPLOAD] Success: ${identifier}`);
    res.json({ 
      success: true, 
      identifier, 
      filename,
      size: filesize,
      url: `https://archive.org/details/${identifier}`
    });
    
  } catch (error) {
    console.error('[UPLOAD] Error:', error.message);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    
    res.status(500).json({ 
      error: 'Upload failed',
      details: error.response?.data || error.message,
      status: error.response?.status
    });
  }
});

// Search
app.get('/api/search', auth, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ items: [] });
  
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&rows=20&output=json`;
    const response = await axios.get(url, { timeout: 10000 });
    res.json({ items: response.data.response?.docs || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status
app.get('/api/status', auth, (req, res) => {
  res.json({
    server: 'Archive Drive v6.2.1',
    user: CONFIG.IA_USERNAME,
    ia_configured: !!(CONFIG.IA_ACCESS_KEY && CONFIG.IA_SECRET_KEY),
    cloudflare: !!CONFIG.CF_WORKER,
    oracle: !!CONFIG.ORACLE_CACHE,
    uptime: Math.floor(process.uptime())
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Listening on 0.0.0.0:${PORT}`);
  console.log(`✓ Access: http://localhost:${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
