// Records the deck's animations into GIFs for the README (headless Chrome).
//   npm install puppeteer-core gifenc pngjs
//   node record-gifs.js             → every GIF + deck tour + cover.png
//   node record-gifs.js auth-store  → one job (or "tour")
// Chrome location can be overridden with the CHROME environment variable.
const puppeteer = require('puppeteer-core');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTML = path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', 'docs');
fs.mkdirSync(OUT, { recursive: true });

// sel: elements whose union is cropped (null = whole viewport); dur = one full loop in seconds
const JOBS = [
  { name: 'http-stateless',     slide: 3,  sel: ['.stateless'],         dur: 8,    fig: true },
  { name: 'authn-vs-authz',     slide: 5,  sel: ['.id-scan', '.doors'], dur: 12,   header: true, pad: 8 },
  { name: 'token-timeline',     slide: 11, sel: ['.tl'],                dur: 9,    fig: true },
  { name: 'lifecycle-sequence', slide: 13, sel: null,                   dur: 15.6, scale: 0.55, fps: 6 },
  { name: 'xss-storage',        slide: 12, sel: ['.xss'],               dur: 8,    fig: true },
  { name: 'fetch-wrapper',      slide: 14, sel: ['.icp'],               dur: 5,    fig: true },
  { name: 'silent-refresh',     slide: 15, sel: ['.sr-btn', '#srFig'],  dur: 14 },
  { name: 'auth-store',         slide: 17, sel: ['.sig'],               dur: 6,    fig: true },
  { name: 'route-guard',        slide: 18, sel: ['.guard'],             dur: 10,   fig: true },
  { name: 'hidden-button-curl', slide: 21, sel: ['.curl'],              dur: 7,    fig: true },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (page, opts) => Buffer.from(await page.screenshot({ type: 'png', ...opts }));

async function openSlide(browser, slide, scale = 1) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: scale });
  await page.goto(`file:///${HTML}#${slide}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function encode(frames, file) {
  const gif = GIFEncoder();
  for (const f of frames) {
    // rgb565, not rgb444: in 444 bins white panels and the near-white page merge into one lavender
    const palette = quantize(f.rgba, 256, { format: 'rgb565' });
    gif.writeFrame(applyPalette(f.rgba, palette, 'rgb565'), f.w, f.h, { palette, delay: Math.round(f.delay) });
  }
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
  return fs.statSync(file).size;
}

async function record(browser, job) {
  const scale = job.scale || 1, fps = job.fps || 10;
  const page = await openSlide(browser, job.slide, scale);
  await sleep(1200); // let the entrance animations settle
  let clip;
  if (job.sel) {
    clip = await page.evaluate((sel, fig, header, pad) => {
      let els = sel.flatMap(s => [...document.querySelectorAll('.slide.is-active ' + s)]);
      if (fig) els = els.map(e => e.closest('figure') || e);
      if (header) els = els.map(e => e.parentElement);
      const rs = els.map(e => e.getBoundingClientRect());
      const x = Math.min(...rs.map(r => r.left)) - pad, y = Math.min(...rs.map(r => r.top)) - pad;
      const r = Math.max(...rs.map(r => r.right)) + pad, b = Math.max(...rs.map(r => r.bottom)) + pad;
      return { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(r - x), height: Math.ceil(b - y) };
    }, job.sel, !!job.fig, !!job.header, job.pad ?? 12);
  }
  const shots = [];
  const t0 = Date.now();
  while (Date.now() - t0 < job.dur * 1000) {
    const buf = await shot(page, { clip, optimizeForSpeed: true });
    shots.push({ t: Date.now() - t0, buf });
  }
  await page.close();

  // resample to a fixed fps; identical consecutive frames are merged into one longer frame
  const step = 1000 / fps, frames = [];
  for (let tt = 0, k = 0; tt < job.dur * 1000; tt += step) {
    while (k + 1 < shots.length && shots[k + 1].t <= tt) k++;
    const last = frames[frames.length - 1];
    if (last && last.buf.equals(shots[k].buf)) { last.delay += step; continue; }
    const png = PNG.sync.read(shots[k].buf);
    frames.push({ rgba: png.data, w: png.width, h: png.height, delay: step, buf: shots[k].buf });
  }
  const size = encode(frames, path.join(OUT, job.name + '.gif'));
  console.log(`${job.name}.gif  ${frames.length} frames  ${frames[0].w}x${frames[0].h}  ${(size / 1024).toFixed(0)} KB`);
}

async function tour(browser) {
  const page = await openSlide(browser, 1, 0.6);
  const n = await page.evaluate(() => document.querySelectorAll('.slide').length);
  const frames = [];
  for (let k = 1; k <= n; k++) {
    if (k > 1) await page.keyboard.press('ArrowRight');
    await sleep(2400);
    const png = PNG.sync.read(await shot(page));
    frames.push({ rgba: png.data, w: png.width, h: png.height, delay: k === 1 ? 2600 : 1700 });
  }
  const size = encode(frames, path.join(OUT, 'deck-tour.gif'));
  console.log(`deck-tour.gif  ${frames.length} frames  ${frames[0].w}x${frames[0].h}  ${(size / 1024).toFixed(0)} KB`);
  await page.keyboard.press('Home');
  await sleep(2000);
  fs.writeFileSync(path.join(OUT, 'cover.png'), await shot(page));
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
  const only = process.argv[2];
  for (const job of JOBS) if (!only || only === job.name) await record(browser, job);
  if (!only || only === 'tour') await tour(browser);
  await browser.close();
})();
