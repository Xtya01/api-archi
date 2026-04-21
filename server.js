const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { S3Client, ListBucketsCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5GB
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'archive-drive-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

app.use(express.static(path.join(__dirname, 'public')));

const s3 = new S3Client({
  endpoint: 'https://s3.us.archive.org',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.IA_ACCESS_KEY,
    secretAccessKey: process.env.IA_SECRET_KEY
  },
  forcePathStyle: true
});

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const IA_USER = process.env.IA_USERNAME || 'namaycb';

// Auth middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Authentication required' });
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.authenticated = true;
    req.session.user = user;
    res.json({ success: true, user });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/buckets', requireAuth, async (req, res) => {
  try {
    const data = await s3.send(new ListBucketsCommand({}));
    res.json({ buckets: data.Buckets || [] });
  } catch (error) {
    console.error('List buckets error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/new', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const file = req.file;
    let identifier = req.body.identifier || `upload-${Date.now()}`;
    
    // Clean identifier for archive.org
    identifier = identifier.toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);

    // Prefix with username
    if (!identifier.startsWith(IA_USER.toLowerCase() + '-')) {
      identifier = `${IA_USER.toLowerCase()}-${identifier}`;
    }

    console.log(`[${new Date().toISOString()}] UPLOAD: ${identifier}/${file.originalname} (${(file.size/1024/1024).toFixed(2)} MB)`);

    const putCommand = new PutObjectCommand({
      Bucket: identifier,
      Key: file.originalname,
      Body: file.buffer,
      ACL: 'public-read',
      ContentType: file.mimetype || 'application/octet-stream'
    });

    // Add Archive.org specific headers
    putCommand.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers['x-archive-auto-make-bucket'] = '1';
        args.request.headers['x-archive-meta01-collection'] = 'opensource';
        args.request.headers['x-archive-meta01-mediatype'] = 'data';
        args.request.headers['x-archive-meta01-title'] = identifier;
        args.request.headers['x-archive-meta01-creator'] = IA_USER;
        args.request.headers['x-archive-meta01-description'] = `Uploaded via Archive Drive on ${new Date().toISOString().split('T')[0]}`;
        args.request.headers['x-archive-interactive-priority'] = '1';
        args.request.headers['x-archive-queue-derive'] = '0';
        args.request.headers['x-archive-size-hint'] = String(file.size);
        return next(args);
      },
      { step: 'build', name: 'archiveOrgHeaders' }
    );

    await s3.send(putCommand);

    const url = `https://archive.org/details/${identifier}`;
    console.log(`[${new Date().toISOString()}] SUCCESS: ${url}`);
    
    res.json({
      success: true,
      identifier,
      filename: file.originalname,
      size: file.size,
      url
    });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] UPLOAD ERROR:`, error.Code, error.message);
    res.status(500).json({ 
      error: `${error.Code || 'UploadFailed'}: ${error.message}`,
      details: error.$metadata ? `HTTP ${error.$metadata.httpStatusCode}` : ''
    });
  }
});

app.get('/api/files/:bucket', requireAuth, async (req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ 
      Bucket: req.params.bucket,
      MaxKeys: 1000
    }));
    res.json({ files: data.Contents || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 1003;
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(`✓ Archive Drive running on port ${PORT}`);
  console.log(`✓ Archive.org user: ${IA_USER}`);
  console.log(`✓ Admin user: ${ADMIN_USER}`);
  console.log(`✓ Time: ${new Date().toISOString()}`);
  console.log('========================================');
});
