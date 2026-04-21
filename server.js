docker exec -it archive-drive sh
cd /app
cat > server.js << 'EOF'
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { S3Client, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5GB

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'archive-drive-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
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
const ADMIN_PASS = process.env.ADMIN_PASS || 'archive123';
const IA_USER = process.env.IA_USERNAME || 'namaycb';

function requireAuth(req, res, next) {
  if (req.session.auth) return next();
  res.status(401).json({ error: 'Login required' });
}

// Login
app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.auth = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// List buckets
app.get('/api/buckets', requireAuth, async (req, res) => {
  try {
    const data = await s3.send(new ListBucketsCommand({}));
    res.json(data.Buckets || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload - FIXED FOR IA
app.post('/api/upload/new', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    const file = req.file;
    let identifier = (req.body.identifier || `upload-${Date.now()}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 80);
    
    if (!identifier.startsWith(IA_USER.toLowerCase() + '-')) {
      identifier = `${IA_USER.toLowerCase()}-${identifier}`;
    }

    console.log(`[UPLOAD] ${identifier}/${file.originalname} (${file.size} bytes)`);

    const cmd = new PutObjectCommand({
      Bucket: identifier,
      Key: file.originalname,
      Body: file.buffer,
      ACL: 'public-read',
      ContentType: file.mimetype || 'application/octet-stream'
    });

    // IA requires these exact headers
    cmd.middlewareStack.add((next) => async (args) => {
      args.request.headers['x-archive-auto-make-bucket'] = '1';
      args.request.headers['x-archive-meta01-collection'] = 'opensource';
      args.request.headers['x-archive-meta01-mediatype'] = 'data';
      args.request.headers['x-archive-meta01-title'] = identifier;
      args.request.headers['x-archive-meta01-creator'] = IA_USER;
      args.request.headers['x-archive-meta01-description'] = `Uploaded via Archive Drive on ${new Date().toISOString()}`;
      args.request.headers['x-archive-interactive-priority'] = '1';
      args.request.headers['x-archive-queue-derive'] = '0';
      args.request.headers['x-archive-size-hint'] = String(file.size);
      return next(args);
    }, { step: 'build', name: 'addIAHeaders' });

    await s3.send(cmd);
    
    res.json({ 
      success: true, 
      identifier,
      url: `https://archive.org/details/${identifier}`,
      file: file.originalname
    });
  } catch (e) {
    console.error('[UPLOAD ERROR]', e.Code, e.message);
    res.status(500).json({ error: `${e.Code || 'UploadFailed'}: ${e.message}` });
  }
});

// List files in bucket
app.get('/api/files/:bucket', requireAuth, async (req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: req.params.bucket }));
    res.json(data.Contents || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(1003, '0.0.0.0', () => {
  console.log(`Archive Drive running on port 1003`);
  console.log(`IA User: ${IA_USER}`);
});
EOF
