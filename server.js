const express = require('express');
const cors = require('cors');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'archive123';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'archive-drive-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7*24*60*60*1000, httpOnly: true, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024*1024 } });

function getS3() {
  return new S3Client({
    endpoint: 'https://s3.us.archive.org',
    region: 'us-east-1',
    credentials: { accessKeyId: process.env.IA_ACCESS_KEY, secretAccessKey: process.env.IA_SECRET_KEY },
    forcePathStyle: true
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Auth routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    req.session.user = username;
    return res.json({ success: true, user: username });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session?.authenticated) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    hasKeys: !!(process.env.IA_ACCESS_KEY && process.env.IA_SECRET_KEY),
    email: process.env.IA_EMAIL || '',
    authenticated: !!req.session?.authenticated
  });
});

// Protected routes
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const s3 = getS3();
    const data = await s3.send(new ListBucketsCommand({}));
    const items = (data.Buckets || []).map(b => ({ name: b.Name, created: b.CreationDate }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/new', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const { title, description, collection } = req.body;
    const files = req.files;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const identifier = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').substring(0,80)+'-'+Date.now();
    const s3 = getS3();
    for (const file of files) {
      await new Upload({
        client: s3,
        params: {
          Bucket: identifier,
          Key: file.originalname,
          Body: file.buffer,
          Metadata: {
            'x-archive-meta-title': title,
            'x-archive-meta-description': description||'',
            'x-archive-meta-collection': collection||'opensource',
            'x-archive-meta-creator': process.env.IA_EMAIL||'',
            'x-archive-auto-make-bucket': '1'
          },
          ACL: 'public-read'
        }
      }).done();
    }
    res.json({ success: true, identifier, itemUrl: `https://archive.org/details/${identifier}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/url', requireAuth, async (req, res) => {
  try {
    const { url, title } = req.body;
    const identifier = title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-'+Date.now();
    const response = await axios({ url, responseType: 'stream', timeout: 300000 });
    const filename = url.split('/').pop().split('?')[0] || 'file.bin';
    await new Upload({
      client: getS3(),
      params: {
        Bucket: identifier,
        Key: filename,
        Body: response.data,
        Metadata: { 'x-archive-meta-title': title, 'x-archive-meta-source': url, 'x-archive-auto-make-bucket':'1' },
        ACL: 'public-read'
      }
    }).done();
    res.json({ success: true, identifier, itemUrl: `https://archive.org/details/${identifier}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Archive Drive running on ${PORT}`));
