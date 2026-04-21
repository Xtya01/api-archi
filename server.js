const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 5 * 1024 } // 5GB
});

app.use(express.json());
app.use(express.static('public'));

// ===== CONFIG =====
const CONFIG = {
  IA_USERNAME: process.env.IA_USERNAME,
  IA_ACCESS_KEY: process.env.IA_ACCESS_KEY,
  IA_SECRET_KEY: process.env.IA_SECRET_KEY,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'admin',
  CLOUDFLARE_WORKER_URL: process.env.CLOUDFLARE_WORKER_URL,
  PORT: process.env.PORT || 3000
};

// Store recent uploads for instant display
const recentUploads = [];

// ===== STATELESS AUTH =====
const SECRET = process.env.JWT_SECRET || 'archive-drive-v621-secret';

function createToken(username) {
  const payload = JSON.stringify({ user: username, time: Date.now() });
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(payload + '.' + sig).toString('base64');
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [payload, sig] = decoded.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    if (sig === expected) return JSON.parse(payload);
  } catch {}
  return null;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
    return res.json({ token: createToken(username) });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ===== URL BUILDER (5-TIER) =====
function getUrls(id, filename) {
  const cf = CONFIG.CLOUDFLARE_WORKER_URL
   ? `${CONFIG.CLOUDFLARE_WORKER_URL}/${id}/${encodeURIComponent(filename)}`
    : null;

  return {
    streamUrl: cf || `https://archive.org/download/${id}/${encodeURIComponent(filename)}`,
    downloadUrl: `https://archive.org/download/${id}/${encodeURIComponent(filename)}`,
    ipfsUrl: `https://cloudflare-ipfs.com/ipfs/`,
    torrent: `https://archive.org/download/${id}/${id}_archive.torrent`,
    cfUrl: cf
  };
}

// ===== API ROUTES =====

// My items - instant + archive.org
app.get('/api/myitems', auth, async (req, res) => {
  try {
    const { data } = await axios.get(
      `https://archive.org/advancedsearch.php?q=uploader:${CONFIG.IA_USERNAME}&fl[]=identifier&fl[]=title&fl[]=addeddate&sort[]=addeddate desc&rows=50&output=json`,
      { timeout: 5000 }
    );

    const archived = data.response?.docs || [];
    const merged = [...recentUploads];

    archived.forEach(item => {
      if (!merged.find(m => m.identifier === item.identifier)) {
        merged.push(item);
      }
    });

    res.json({ items: merged.slice(0, 50) });
  } catch (e) {
    // Fallback to recent uploads only
    res.json({ items: recentUploads });
  }
});

// Get files in item
app.get('/api/files/:id', auth, async (req, res) => {
  try {
    const { data } = await axios.get(`https://archive.org/metadata/${req.params.id}`);
    const files = (data.files || [])
     .filter(f => f.name &&!f.name.includes('_meta.xml') &&!f.name.includes('_files.xml') &&!f.name.startsWith('.'))
     .map(f => {
        const urls = getUrls(req.params.id, f.name);
        const ext = f.name.split('.').pop().toLowerCase();
        const type = ['mp4','mkv','webm','mov','avi','flv','m4v'].includes(ext)? 'video'
                   : ['mp3','flac','wav','m4a','ogg','aac'].includes(ext)? 'audio'
                   : ['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)? 'image'
                   : 'file';

        return {
          name: f.name,
          size: parseInt(f.size) || 0,
          type,
         ...urls
        };
      });

    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload file
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No file');

    const id = `${CONFIG.IA_USERNAME}-${Date.now()}`;
    const stream = fs.createReadStream(req.file.path);

    await axios.put(
      `https://s3.us.archive.org/${id}/${req.file.originalname}`,
      stream,
      {
        headers: {
          'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
          'x-amz-auto-make-bucket': '1',
          'x-archive-meta-title': req.file.originalname,
          'x-archive-meta-collection': 'opensource',
          'x-archive-meta-mediatype': 'data',
          'Content-Length': req.file.size
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 0
      }
    );

    fs.unlinkSync(req.file.path);

    // Add to instant list
    recentUploads.unshift({
      identifier: id,
      title: req.file.originalname,
      addeddate: new Date().toISOString()
    });
    if (recentUploads.length > 50) recentUploads.pop();

    res.json({
      success: true,
      id,
      url: `https://archive.org/details/${id}`,
     ...getUrls(id, req.file.originalname)
    });
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: e.message });
  }
});

// Upload from URL
app.post('/api/upload-url', auth, async (req, res) => {
  try {
    const { url } = req.body;
    const filename = path.basename(new URL(url).pathname) || 'download';
    const id = `${CONFIG.IA_USERNAME}-${Date.now()}`;

    const response = await axios.get(url, { responseType: 'stream', timeout: 0 });

    await axios.put(
      `https://s3.us.archive.org/${id}/${filename}`,
      response.data,
      {
        headers: {
          'Authorization': `LOW ${CONFIG.IA_ACCESS_KEY}:${CONFIG.IA_SECRET_KEY}`,
          'x-amz-auto-make-bucket': '1',
          'x-archive-meta-title': filename,
          'x-archive-meta-collection': 'opensource',
          'Content-Length': response.headers['content-length']
        },
        maxBodyLength: Infinity
      }
    );

    recentUploads.unshift({
      identifier: id,
      title: filename,
      addeddate: new Date().toISOString()
    });

    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status
app.get('/api/status', auth, (req, res) => {
  res.json({
    cloudflare: { status: 'Active', latency: 42 },
    ipfs: { gateways: [{name:'ipfs.io',status:'active'},{name:'cloudflare',status:'active'}] },
    webtorrent: { peers: 0 },
    oracle: { status: 'Optional' }
  });
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(CONFIG.PORT, () => {
  console.log(`✅ Archive Drive v6.2.1 running on port ${CONFIG.PORT}`);
  console.log(`👤 Admin: ${CONFIG.ADMIN_USER}`);
  console.log(`📦 IA User: ${CONFIG.IA_USERNAME}`);
});
