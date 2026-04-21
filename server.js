import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  credentials: { accessKeyId: process.env.IA_ACCESS_KEY, secretAccessKey: process.env.IA_SECRET_KEY },
  forcePathStyle: true,
});

const upload = multer({ storage: multer.memoryStorage() });

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/myitems', async (req, res) => {
  try {
    const email = process.env.IA_EMAIL;
    const url = `https://archive.org/advancedsearch.php?q=creator:(${encodeURIComponent(email)})&fl[]=identifier,title,item_size&output=json&rows=50`;
    const { data } = await axios.get(url);
    res.json(data.response.docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/list/:item', async (req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: req.params.item }));
    const files = (data.Contents || []).map(f => ({ name: f.Key, size: f.Size }));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload/:item', upload.array('files'), async (req, res) => {
  try {
    let item = req.params.item;
    if (item === 'new') item = `drive-${Date.now()}`;
    for (const file of req.files) {
      await new Upload({ client: s3, params: { Bucket: item, Key: file.originalname, Body: file.buffer, ACL: 'public-read', Metadata: { 'x-archive-auto-make-bucket': '1' } } }).done();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload-url/:item', async (req, res) => {
  try {
    let item = req.params.item;
    if (item === 'new') item = `drive-${Date.now()}`;
    const { url } = req.body;
    const filename = path.basename(new URL(url).pathname) || 'file';
    const stream = await axios.get(url, { responseType: 'stream' });
    await new Upload({ client: s3, params: { Bucket: item, Key: filename, Body: stream.data, ACL: 'public-read', Metadata: { 'x-archive-auto-make-bucket': '1' } } }).done();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('Running on port 3000'));