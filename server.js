import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'https://s3.us.archive.org',
  credentials: {
    accessKeyId: process.env.IA_ACCESS_KEY,
    secretAccessKey: process.env.IA_SECRET_KEY,
  },
  forcePathStyle: true,
});

const upload = multer({ storage: multer.memoryStorage() });

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/myitems', async (req, res) => {
  try {
    const email = process.env.IA_EMAIL;
    const url = `https://archive.org/advancedsearch.php?q=creator:(${encodeURIComponent(email)})&fl[]=identifier,title&output=json&rows=100`;
    const { data } = await axios.get(url);
    res.json(data.response.docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/list/:item', async (req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: req.params.item }));
    res.json({ files: (data.Contents || []).map(f => ({ name: f.Key, size: f.Size })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload/:item', upload.array('files'), async (req, res) => {
  try {
    let item = req.params.item === 'new' ? `drive-${Date.now()}` : req.params.item;
    for (const f of req.files) {
      await new Upload({ client: s3, params: { Bucket: item, Key: f.originalname, Body: f.buffer, ACL: 'public-read', Metadata: { 'x-archive-auto-make-bucket': '1' } } }).done();
    }
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
