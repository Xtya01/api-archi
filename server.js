const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'archive-v2', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));

const IA_USER = (process.env.IA_USERNAME || 'namaycb').toLowerCase();
const IA_KEY = (process.env.IA_ACCESS_KEY || '').trim();
const IA_SECRET = (process.env.IA_SECRET_KEY || '').trim();
const AUTH = `LOW ${IA_KEY}:${IA_SECRET}`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

const auth = (req, res, next) => req.session.auth? next() : res.status(401).json({error:'login'});

app.get('/', (req,res) => res.sendFile(__dirname + '/public/index.html'));
app.post('/api/login', (req,res) => {
  if(req.body.user===ADMIN_USER && req.body.pass===ADMIN_PASS){req.session.auth=true;res.json({ok:true})}
  else res.status(401).json({error:'invalid'});
});

// LIST ITEMS
app.get('/api/items', auth, async (req,res) => {
  try {
    const url = `https://archive.org/advancedsearch.php?q=creator:${IA_USER}&fl[]=identifier&fl[]=title&fl[]=item_size&fl[]=downloads&sort[]=addeddate+desc&rows=50&output=json`;
    const r = await fetch(url);
    const data = await r.json();
    res.json({ items: data.response.docs });
  } catch(e){ res.status(500).json({error:e.message}) }
});

// LIST FILES IN ITEM
app.get('/api/files/:id', auth, async (req,res) => {
  try {
    const r = await fetch(`https://archive.org/metadata/${req.params.id}`);
    const data = await r.json();
    const files = (data.files || []).filter(f => f.source!== 'metadata').map(f => ({
      name: f.name,
      size: f.size,
      url: `https://${req.params.id}.archive.org/0/items/${req.params.id}/${encodeURIComponent(f.name)}`
    }));
    res.json({ files });
  } catch(e){ res.status(500).json({error:e.message}) }
});

// UPLOAD FILES
app.post('/api/upload', auth, upload.array('files', 10), async (req,res) => {
  try {
    const results = [];
    for(const f of req.files){
      let id = (req.body.identifier || `upload-${Date.now()}`).toLowerCase().replace(/[^a-z0-9-]/g,'-');
      if(!id.startsWith(IA_USER+'-')) id = `${IA_USER}-${id}`;

      const url = `https://s3.us.archive.org/${id}/${encodeURIComponent(f.originalname)}`;
      const headers = {
        'Authorization': AUTH,
        'x-archive-auto-make-bucket': '1',
        'x-archive-meta01-collection': 'opensource',
        'x-archive-meta01-mediatype': 'data',
        'x-archive-meta01-creator': IA_USER,
        'x-archive-queue-derive': '0',
        'Content-Length': f.size.toString()
      };

      const r = await fetch(url, { method:'PUT', headers, body:f.buffer, duplex:'half' });
      results.push({ file: f.originalname, id, ok: r.ok, url: `https://archive.org/details/${id}` });
    }
    res.json({ results });
  } catch(e){ res.status(500).json({error:e.message}) }
});

// REMOTE URL UPLOAD
app.post('/api/upload-url', auth, async (req,res) => {
  try {
    const { url, identifier, filename } = req.body;
    if(!url) return res.status(400).json({error:'URL required'});

    console.log('[REMOTE]', url);
    const fileRes = await fetch(url);
    if(!fileRes.ok) throw new Error(`Fetch failed: ${fileRes.status}`);

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const name = filename || url.split('/').pop().split('?')[0] || 'file.bin';

    let id = (identifier || `remote-${Date.now()}`).toLowerCase().replace(/[^a-z0-9-]/g,'-');
    if(!id.startsWith(IA_USER+'-')) id = `${IA_USER}-${id}`;

    const uploadUrl = `https://s3.us.archive.org/${id}/${encodeURIComponent(name)}`;
    const headers = {
      'Authorization': AUTH,
      'x-archive-auto-make-bucket': '1',
      'x-archive-meta01-collection': 'opensource',
      'x-archive-meta01-mediatype': 'data',
      'x-archive-meta01-creator': IA_USER,
      'x-archive-queue-derive': '0',
      'Content-Length': buffer.length.toString()
    };

    const r = await fetch(uploadUrl, { method:'PUT', headers, body:buffer, duplex:'half' });

    res.json({ success: r.ok, id, filename: name, url: `https://archive.org/details/${id}` });
  } catch(e){ res.status(500).json({error:e.message}) }
});

// DELETE FILE
app.delete('/api/files/:id/:name', auth, async (req,res) => {
  try {
    const url = `https://s3.us.archive.org/${req.params.id}/${encodeURIComponent(req.params.name)}`;
    const r = await fetch(url, { method:'DELETE', headers: { 'Authorization': AUTH } });
    res.json({ ok: r.ok });
  } catch(e){ res.status(500).json({error:e.message}) }
});

app.listen(1003, '0.0.0.0', () => console.log('✓ Archive Drive v2 on 1003'));
