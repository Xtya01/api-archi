const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'archive-drive',
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(path.join(__dirname, 'public')));

const IA_USER = process.env.IA_USERNAME || 'namaycb';
const IA_KEY = (process.env.IA_ACCESS_KEY || '').trim();
const IA_SECRET = (process.env.IA_SECRET_KEY || '').trim();
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

console.log('=== Starting with LOW auth ===');
console.log('User:', IA_USER);
console.log('Key:', IA_KEY.substring(0,6) + '...');

const auth = (req, res, next) => req.session.auth ? next() : res.status(401).json({error:'login'});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.post('/api/login', (req, res) => {
  if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
    req.session.auth = true;
    res.json({ok:true});
  } else res.status(401).json({error:'invalid'});
});

app.post('/api/upload/new', auth, upload.single('file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({error:'No file'});

    let id = (req.body.identifier || `upload-${Date.now()}`).toLowerCase().replace(/[^a-z0-9-]/g,'-');
    if (!id.startsWith(IA_USER.toLowerCase()+'-')) id = `${IA_USER.toLowerCase()}-${id}`;

    const url = `https://s3.us.archive.org/${id}/${encodeURIComponent(f.originalname)}`;
    
    console.log(`[UPLOAD] PUT ${url}`);

    const headers = {
      'Authorization': `LOW ${IA_KEY}:${IA_SECRET}`,
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta01-collection': 'opensource',
      'x-archive-meta01-mediatype': 'data',
      'x-archive-meta01-title': id,
      'x-archive-meta01-creator': IA_USER,
      'x-archive-queue-derive': '0',
      'x-archive-size-hint': f.size.toString(),
      'Content-Type': f.mimetype || 'application/octet-stream',
      'Content-Length': f.size.toString()
    };

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: f.buffer,
      duplex: 'half'
    });

    const text = await response.text();
    
    if (response.ok) {
      console.log(`[SUCCESS] ${id}`);
      res.json({ success: true, identifier: id, url: `https://archive.org/details/${id}` });
    } else {
      console.error(`[FAIL] ${response.status}`, text);
      res.status(500).json({ error: `HTTP ${response.status}: ${text.substring(0,200)}` });
    }

  } catch (e) {
    console.error('[ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(1003, '0.0.0.0', () => console.log('✓ Running on 1003 with LOW auth'));
