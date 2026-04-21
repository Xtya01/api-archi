/**
 * Archive Drive v6.2 - Production Server
 * Features: auth, my-items, upload, streaming, Cloudflare + Oracle fallback
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Config from environment
const CONFIG = {
  IA_USERNAME: process.env.IA_USERNAME || 'namaycb',
  IA_ACCESS_KEY: process.env.IA_ACCESS_KEY,
  IA_SECRET_KEY: process.env.IA_SECRET_KEY,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'Admin@2330',
  CF_WORKER: process.env.CF_WORKER || '',
  ORACLE_CACHE: process.env.ORACLE_CACHE || ''
};

console.log('=== Archive Drive v6.2 Starting ===');
console.log('User:', CONFIG.IA_USERNAME);
console.log('Cloudflare:', CONFIG.CF_WORKER ? 'ENABLED' : 'disabled');
console.log('Oracle:', CONFIG.ORACLE_CACHE ? 'ENABLED' : 'disabled');

// Middleware
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  next();
});

// Session storage (in-memory)
const sessions = new Map();
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } }); // 5GB

// ================= AUTH =================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[AUTH] Login attempt: ${username}`);
  
  if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: username, created: Date.now() });
    console.log(`[AUTH] Success: ${username}`);
    return res.json({ token, user: username });
  }
  
  console.log(`[AUTH] Failed: ${username}`);
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
  
  // 30% Cloudflare, 20% Oracle, 50% direct
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
  const mediaExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.mp3', '.wav', '.flac', '.jpg', '.jpeg', '.png', '.gif', '.pdf'];
  return mediaExts.some(ext => filename.toLowerCase().endsWith(ext));
}

function isMetadataFile(filename) {
  return filename.endsWith('.xml') || 
         filename.endsWith('.sqlite') || 
         filename.startsWith('__') ||
         filename.includes('_meta') ||
         filename.includes('_files') ||
         filename.includes('_reviews');
}

// ================= API ROUTES =================

// Get user's items
app.get('/api/myitems', auth, async (req, res) => {
  console.log(`[API] Fetching items for ${CONFIG.IA_USERNAME}`);
  try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=item_size&fl[]=downloads&sort[]=date desc&rows=200&output=json`;
    
    const response = await axios.get(searchUrl, { timeout: 15000 });
    const docs = response.data.response.docs || [];
    
    const items = docs.map(doc => ({
      identifier: doc.identifier,
      title: doc.title || doc.identifier,
      date: doc.date,
      size: doc.item_size || 0,
      downloads: doc.downloads || 0
    }));
    
    console.log(`[API] Found ${items.length} items`);
    res.json({ items, total: items.length });
  } catch (error) {
    console.error('[API] myitems error:', error.message);
    res.status(500).json({ error: 'Failed to fetch items', details: error.message });
  }
});

// Get files for an item
app.get('/api/files/:id', auth, async (req, res) => {
  const identifier = req.params.id;
  console.log(`[API] Fetching files for ${identifier}`);
  
  try {
    const metaUrl = `https://archive.org/metadata/${identifier}`;
    const response = await axios.get(metaUrl, { timeout: 15000 });
    
    const metadata = response.data.metadata || {};
    const files = response.data.files || [];
    
    // Filter and process files
    const processedFiles = files
      .filter(f => f.source === 'original' && !isMetadataFile(f.name))
      .map(f => ({
        name: f.name,
        size: parseInt(f.size) || 0,
        format: f.format,
        isMedia: isMediaFile(f.name),
        url: getFileUrl(identifier, f.name),
        directUrl: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
        created: f.mtime
      }))
      .sort((a, b) => {
        // Media files first, then by size descending
        if (a.isMedia && !b.isMedia) return -1;
        if (!a.isMedia && b.isMedia) return 1;
        return b.size - a.size;
      });
    
    console.log(`[API] ${identifier}: ${processedFiles.length} files`);
    res.json({
      identifier,
      title: metadata.title,
      description: metadata.description,
      files: processedFiles,
      total: processedFiles.length
    });
  } catch (error) {
    console.error(`[API] files error for ${identifier}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch files', details: error.message });
  }
});

// Upload file
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  console.log(`[UPLOAD] Starting upload: ${req.file?.originalname}`);
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  
  if (!CONFIG.IA_ACCESS_KEY || !CONFIG.IA_SECRET_KEY) {
    return res.status(500).json({ error: 'IA credentials not configured' });
  }
  
  try {
    const identifier = req.body.identifier || `${CONFIG.IA_USERNAME}-upload-${Date.now()}`;
    const filename = req.file.originalname;
    
    console.log(`[UPLOAD] To ${identifier}/${filename} (${req.file.size} bytes)`);
    
    const uploadUrl = `https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`;
    const fileStream = fs.createReadStream(req.file.path);
    
    const response = await axios.put(uploadUrl, fileStream, {
      headers: {
        'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
        'x-amz-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta-mediatype': 'data',
        'x-archive-meta-title': filename,
        'x-archive-meta-uploader': CONFIG.IA_USERNAME,
        'Content-Type': 'application/octet-stream'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000 // 5 minutes
    });
    
    // Cleanup temp file
    fs.unlinkSync(req.file.path);
    
    console.log(`[UPLOAD] Success: ${identifier}`);
    res.json({ 
      success: true, 
      identifier, 
      filename,
      url: `https://archive.org/details/${identifier}`
    });
    
  } catch (error) {
    console.error('[UPLOAD] Error:', error.message);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ 
      error: 'Upload failed', 
      details: error.response?.data || error.message 
    });
  }
});

// System status
app.get('/api/status', auth, (req, res) => {
  res.json({
    server: 'Archive Drive v6.2',
    user: CONFIG.IA_USERNAME,
    cloudflare: {
      enabled: !!CONFIG.CF_WORKER,
      endpoint: CONFIG.CF_WORKER
    },
    oracle: {
      enabled: !!CONFIG.ORACLE_CACHE,
      endpoint: CONFIG.ORACLE_CACHE
    },
    ia_configured: !!(CONFIG.IA_ACCESS_KEY && CONFIG.IA_SECRET_KEY),
    uptime: process.uptime()
  });
});

// Search
app.get('/api/search', auth, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ items: [] });
  
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&rows=20&output=json`;
    const response = await axios.get(url, { timeout: 10000 });
    res.json({ items: response.data.response.docs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Server running on http://0.0.0.0:${PORT}`);
  console.log(`✓ Admin: ${CONFIG.ADMIN_USER}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  process.exit(0);
});
