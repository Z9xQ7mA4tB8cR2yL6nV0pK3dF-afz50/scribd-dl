const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const { jsPDF } = require('jspdf');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL প্রয়োজন' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs.set(jobId, { status: 'queued', progress: 0, text: 'শুরু হচ্ছে...', fileId: null, error: null });

  processDocument(jobId, url);

  res.json({ jobId });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/file/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.fileId) return res.status(404).json({ error: 'File not ready' });
  const file = jobs.get(job.fileId + '_file');
  if (!file) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
});

async function processDocument(jobId, url) {
  const job = jobs.get(jobId);
  let browser;

  try {
    job.status = 'processing';
    job.text = 'ব্রাউজার চালু হচ্ছে...';

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const pg = await browser.newPage();
    await pg.setViewport({ width: 1280, height: 900 });
    await pg.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    pg.setDefaultNavigationTimeout(60000);
    pg.setDefaultTimeout(60000);

    let finalUrl = url.trim();
    if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;
    const docMatch = finalUrl.match(/(?:doc|document|embeds|read|book|presentation)\/(\d+)/);
    const docId = docMatch ? docMatch[1] : null;
    if (docId && !finalUrl.includes('/embeds/')) {
      finalUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll&access_key=key-1`;
    }

    job.text = 'Scribd পেজ খোলা হচ্ছে...';
    await pg.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);

    job.text = 'ডকুমেন্ট পড়া হচ্ছে...';
    const docTitle = await pg.evaluate(() => {
      const el = document.querySelector('[data-e2e="doc_page_title"]') || document.querySelector('.title') || document.querySelector('title');
      return el ? el.innerText.trim() : 'Scribd_Document';
    });

    const totalPages = await pg.evaluate(() => {
      return document.querySelectorAll("div.outer_page_container div[id^='outer_page_']").length;
    });

    if (totalPages === 0) throw new Error('কোনো পেজ পাওয়া যায়নি');

    job.text = `${docTitle} — ${totalPages} পেজ পাওয়া গেছে`;
    job.progress = 5;

    const pageImages = [];
    const sliceSize = 85 / Math.max(totalPages, 1);

    for (let i = 0; i < totalPages; i++) {
      job.text = `পেজ ${i + 1}/${totalPages}...`;
      job.progress = 5 + Math.round(i * sliceSize);

      await pg.evaluate((idx) => {
        const pages = document.querySelectorAll("div.outer_page_container div[id^='outer_page_']");
        if (pages[idx]) pages[idx].scrollIntoView({ behavior: 'instant', block: 'start' });
      }, i);
      await sleep(1500);

      const dims = await pg.evaluate((idx) => {
        const pages = document.querySelectorAll("div.outer_page_container div[id^='outer_page_']");
        const page = pages[idx];
        if (!page) return null;
        const imgs = Array.from(page.querySelectorAll('img.absimg, img[src*="html.scribdassets"], img.orig_image'))
          .filter(img => img.getBoundingClientRect().width > 50 && img.getBoundingClientRect().height > 50);
        if (imgs.length === 0) return null;
        const img = imgs[0];
        return {
          imgW: img.naturalWidth || 0, imgH: img.naturalHeight || 0,
          renderW: Math.round(img.getBoundingClientRect().width),
          renderH: Math.round(img.getBoundingClientRect().height),
          renderX: Math.round(img.getBoundingClientRect().x),
          renderY: Math.round(img.getBoundingClientRect().y)
        };
      }, i);

      if (!dims) continue;

      const origW = dims.imgW > 10 ? dims.imgW : dims.renderW;
      const origH = dims.imgH > 10 ? dims.imgH : dims.renderH;

      try {
        const ss = await pg.screenshot({
          type: 'jpeg',
          quality: 75,
          clip: { x: dims.renderX, y: dims.renderY, width: dims.renderW, height: dims.renderH }
        });
        const dataUrl = 'data:image/jpeg;base64,' + ss.toString('base64');
        pageImages.push({ dataUrl, width: origW, height: origH });
      } catch (e) {}
    }

    if (pageImages.length === 0) throw new Error('কোনো পেজ capture হয়নি');

    job.text = `PDF তৈরি (${pageImages.length} পেজ)...`;
    job.progress = 92;

    const first = pageImages[0];
    const orient = first.width > first.height ? 'landscape' : 'portrait';
    const pdf = new jsPDF({ orientation: orient, unit: 'px', format: [first.width, first.height], hotfixes: ['px_scaling'] });

    for (let i = 0; i < pageImages.length; i++) {
      const img = pageImages[i];
      const p = img.width > img.height ? 'l' : 'p';
      if (i === 0) {
        pdf.addImage(img.dataUrl, 'JPEG', 0, 0, img.width, img.height, undefined, 'FAST');
      } else {
        pdf.addPage([img.width, img.height], p);
        pdf.addImage(img.dataUrl, 'JPEG', 0, 0, img.width, img.height, undefined, 'FAST');
      }
      job.progress = 92 + Math.round((i / pageImages.length) * 6);
    }

    const safeName = docTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().replace(/\s+/g, '_') || 'Scribd_Document';
    const pdfBuffer = Buffer.from(pdf.output('arraybuffer'));
    const fileKey = jobId + '_file';
    jobs.set(fileKey, { buffer: pdfBuffer, filename: safeName + '.pdf' });

    job.status = 'done';
    job.progress = 100;
    job.text = `${pageImages.length} পেজ • ${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB`;
    job.fileId = jobId;

    setTimeout(() => {
      jobs.delete(jobId);
      jobs.delete(fileKey);
    }, 3600000);

  } catch (error) {
    console.error('Error:', error.message);
    job.status = 'error';
    job.text = error.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Scribd Downloader running on port ${PORT}`);
});
