'use strict';
// 上传的文件：存在 <工作区>/uploads/<房间 id>/<文件 id>/（meta.json + 原文件 + 提取出的 text.txt + 发给模型的图片）。
// 图片发给能看图的模型；文档（txt / 代码 / Word / PPT / Excel / PDF……）提取文字写进提示词，所有智能体都能读。
// PDF、.doc / .rtf、HEIC 照片要用 Mac 自带的工具（PDFKit、textutil、sips）；Word / PPT / Excel 在 Windows 上也能读。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');

const MAC = process.platform === 'darwin';
// fileBytes：单个文件最大（默认 1GB，可以用 UPLOAD_MB 改）；readBytes：这么大以内的才读内容（文档、图片），更大的只存原文件（视频照样截图）
const LIMITS = { fileBytes: (Number(process.env.UPLOAD_MB) || 1024) * 1024 * 1024, readBytes: 30 * 1024 * 1024, keepFree: 3 * 1024 ** 3,
  perMessage: 10, fileChars: 60000, images: 8, pdfPages: 5, videoFrames: 6 };

const IMAGE_SEND = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }; // 模型接口都认的图片格式
const IMAGE_MAX_SIDE = 2000, IMAGE_MAX_BYTES = 3.5 * 1024 * 1024; // 各家接口的上限（Claude 单张 5MB）以内
const NO_VISION = '（用户发了图片，但你看不到图片内容：请如实说明，不要猜测或编造图片里有什么。）';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...opts }, (e, out) => (e ? reject(e) : resolve(out)));
});
const safeName = (s) => String(s || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(-120) || '文件';
const extOf = (name) => (path.extname(name).slice(1) || '').toLowerCase();
const size = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// 看文件开头的几个字节认类型（不全信扩展名：网页上显示图片前要确认真的是图片）
function sniff(buf) {
  const hex = buf.subarray(0, 12).toString('hex'), ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (ascii.startsWith('GIF8')) return 'gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (hex.startsWith('504b0304')) return 'zip';
  if (ascii.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii.slice(8, 12))) return 'heic';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff';
  if (ascii.startsWith('BM')) return 'bmp';
  return '';
}

// 文本文件：UTF-8（带不带 BOM）、UTF-16、中文 Windows 常见的 GBK；有很多 \0 的当二进制
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch {}
  try { return new TextDecoder('gb18030', { fatal: true }).decode(buf); } catch {}
  return null;
}

// ---------- Word / PPT / Excel（都是 zip 包着 XML）----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }); // 防止解压炸弹
      throw new Error('不支持的压缩方式');
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const numbered = (zip, re) => [...zip.keys()].filter((k) => re.test(k)).sort((a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]));
function officeText(buf, ext) {
  const zip = readZip(buf);
  const get = (n) => (zip.has(n) ? zip.get(n)().toString('utf8') : '');
  if (ext === 'docx' || zip.has('word/document.xml')) {
    return xmlText(get('word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n'));
  }
  if (ext === 'pptx' || zip.has('ppt/presentation.xml')) {
    return numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/).map((k, i) => {
      const paras = zip.get(k)().toString('utf8').split(/<\/a:p>/).map((p) => (p.match(/<a:t>[^<]*<\/a:t>/g) || []).map(xmlText).join('')).filter((s) => s.trim());
      return `--- 第 ${i + 1} 页 ---\n${paras.join('\n')}`;
    }).join('\n\n');
  }
  if (ext === 'xlsx' || zip.has('xl/workbook.xml')) {
    const shared = (get('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => (si.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(xmlText).join(''));
    const names = (get('xl/workbook.xml').match(/<sheet [^>]*name="[^"]*"/g) || []).map((s) => xmlText(s.match(/name="([^"]*)"/)[1]));
    return numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((k, i) => {
      const rows = (zip.get(k)().toString('utf8').match(/<row[^>]*>[\s\S]*?<\/row>/g) || []).map((row) => (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
        const v = (c.match(/<v>([^<]*)<\/v>/) || [])[1];
        if (/t="s"/.test(c)) return shared[Number(v)] || '';
        if (/t="inlineStr"/.test(c)) return (c.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(xmlText).join('');
        return v === undefined ? '' : xmlText(v);
      }).join('\t').replace(/\t+$/, '')).filter((r) => r.trim());
      return `--- 工作表「${names[i] || i + 1}」---\n${rows.join('\n')}`;
    }).join('\n\n');
  }
  throw new Error('认不出这个文件里的内容');
}

// ---------- PDF（Mac 自带的 PDFKit，用 JXA 调用，不用装东西）----------
const PDF_JXA = `ObjC.import('PDFKit'); ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('打不开这个 PDF');
  if (doc.isLocked) throw new Error('这个 PDF 有密码');
  const n = doc.pageCount;
  if (argv[1] !== 'render') {
    const out = [];
    for (let i = 0; i < n; i++) { const s = doc.pageAtIndex(i).string; out.push(!s || s.isNil() ? '' : s.js); }
    return JSON.stringify(out);
  }
  const files = [];
  for (let i = 0; i < Math.min(n, Number(argv[3])); i++) {
    const page = doc.pageAtIndex(i), box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
    const k = 1600 / Math.max(box.size.width, box.size.height);
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * k, box.size.height * k), $.kPDFDisplayBoxMediaBox);
    const png = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    const f = argv[2] + '/page-' + (i + 1) + '.png';
    png.writeToFileAtomically(f, true); files.push('page-' + (i + 1) + '.png');
  }
  return JSON.stringify(files);
}`;
const pdf = (file, ...args) => run('osascript', ['-l', 'JavaScript', '-e', PDF_JXA, file, ...args]).then((s) => JSON.parse(s));

// ---------- 图片：HEIC（iPhone 照片）、TIFF、BMP 转成 JPEG，太大的缩小；不是 Mac 时只收接口认的格式 ----------
async function prepareImage(dir, file, type, bytes) {
  if (!MAC) return IMAGE_SEND[type] && bytes <= IMAGE_MAX_BYTES ? path.basename(file) : null;
  const info = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const side = Math.max(...[...info.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])));
  if (IMAGE_SEND[type] && side <= IMAGE_MAX_SIDE && bytes <= IMAGE_MAX_BYTES) return path.basename(file);
  const keepPng = type === 'png' && bytes <= IMAGE_MAX_BYTES * 2; // 截图里有字，尽量不转 JPEG
  const out = keepPng ? 'send.png' : 'send.jpg';
  const args = keepPng ? [] : ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85'];
  if (side > IMAGE_MAX_SIDE) args.push('-Z', String(IMAGE_MAX_SIDE));
  await run('sips', [...args, file, '--out', path.join(dir, out)]);
  return fs.statSync(path.join(dir, out)).size <= IMAGE_MAX_BYTES ? out : null;
}

// ---------- 视频：ffprobe 读时长和分辨率，ffmpeg 均匀截几张画面发给能看图的模型（声音听不了）----------
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', 'mts']);
const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }; // 浏览器能直接播放的
const findTool = (name) => [process.env.PATH ? process.env.PATH.split(':') : [], '/opt/homebrew/bin', '/usr/local/bin'].flat().map((d) => path.join(d, name)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
const clock = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s2 = String(sec % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s2}` : `${m}:${s2}`; };
async function prepareVideo(dir, file, meta) {
  const probe = findTool('ffprobe'), ffmpeg = findTool('ffmpeg');
  if (!probe || !ffmpeg) { meta.note = '这台电脑没装 ffmpeg，模型看不到画面（终端运行 brew install ffmpeg 后重新上传）'; return; }
  const info = JSON.parse(await run(probe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]));
  const v = (info.streams || []).find((x) => x.codec_type === 'video');
  const dur = Number(info.format && info.format.duration) || 0;
  if (!v) throw new Error('里面没有视频画面');
  meta.duration = Math.round(dur * 10) / 10; meta.width = v.width; meta.height = v.height;
  meta.audio = (info.streams || []).some((x) => x.codec_type === 'audio');
  const n = dur > 2 ? LIMITS.videoFrames : 1;
  meta.frameTimes = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : dur * (i + 0.5) / n;
    const out = `frame-${i + 1}.jpg`;
    try {
      await run(ffmpeg, ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', '-y', path.join(dir, out)], { timeout: 90000 });
      if (fs.existsSync(path.join(dir, out))) { meta.images.push(out); meta.frameTimes.push(Math.round(t)); }
    } catch {}
  }
  meta.preview = meta.images[0] || undefined; // 网页上的封面
  meta.note = `${clock(dur)}${v.width ? ` · ${v.width}×${v.height}` : ''}${meta.images.length ? ` · 截了 ${meta.images.length} 张画面给模型看` : ''}${meta.audio ? '，声音听不到' : ''}`;
}

// ---------- 收文件：边收边写进硬盘（大视频不经过内存）----------
function receive(req, roomDir, limit) {
  fs.mkdirSync(roomDir, { recursive: true });
  const tmp = path.join(roomDir, `.incoming-${crypto.randomBytes(6).toString('hex')}`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; req.unpipe(out); out.destroy(); fs.rmSync(tmp, { force: true }); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(Object.assign(new Error('文件太大'), { status: 413 })); req.destroy(); } });
    req.on('aborted', () => fail(new Error('上传中断了')));
    req.on('error', fail); out.on('error', fail);
    out.on('finish', () => { if (!failed) resolve({ path: tmp, size }); });
    req.pipe(out);
  });
}
const diskFree = (dir) => { try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch { return Infinity; } };

// ---------- 保存一个上传的文件 ----------
async function save(roomDir, name, src) {
  name = safeName(name);
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(roomDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = extOf(name);
  const original = 'original' + (ext && /^[a-z0-9]{1,8}$/.test(ext) ? '.' + ext : '');
  const file = path.join(dir, original);
  if (Buffer.isBuffer(src)) fs.writeFileSync(file, src); else fs.renameSync(src.path, file);
  const bytes = Buffer.isBuffer(src) ? src.length : src.size;
  const head = readHead(file);
  const type = sniff(head);
  const big = bytes > LIMITS.readBytes;
  const buf = big ? null : Buffer.isBuffer(src) ? src : fs.readFileSync(file);
  const meta = { id, name, size: bytes, kind: 'other', original, images: [], ts: Date.now() };
  let text = null;
  try {
    const isVideo = VIDEO_EXT.has(ext) || (head.subarray(4, 8).toString('latin1') === 'ftyp' && type !== 'heic');
    if (isVideo) {
      meta.kind = 'video';
      meta.inline = !!VIDEO_MIME[ext];
      await prepareVideo(dir, file, meta);
    } else if (big) {
      meta.note = `超过 ${Math.round(LIMITS.readBytes / 1048576)}MB，只保存原文件，不读内容（Claude Code、Codex 能在工作目录里打开它）`;
    } else if (['png', 'jpg', 'gif', 'webp', 'heic', 'tiff', 'bmp'].includes(type)) {
      meta.kind = 'image';
      meta.inline = !!IMAGE_SEND[type]; // 浏览器能直接显示的格式
      const send = await prepareImage(dir, file, type, bytes);
      if (send) meta.images = [send]; else meta.note = MAC ? '图片太大，发不了给模型' : '这种图片格式要在 Mac 上才能转换';
      if (!meta.inline && MAC && send) meta.preview = send; // HEIC 等：网页上显示转好的 JPEG
    } else if (type === 'pdf') {
      if (!MAC) throw new Error('提取 PDF 文字要在 Mac 上');
      const pages = await pdf(file);
      meta.kind = 'doc'; meta.pages = pages.length;
      text = pages.map((t, i) => (pages.length > 1 ? `--- 第 ${i + 1} 页 ---\n` : '') + t.trim()).join('\n\n');
      // 扫描件（几乎没有文字）：前几页转成图片，发给能看图的模型
      if (pages.join('').replace(/\s/g, '').length < 30 * pages.length) {
        meta.scanned = true; text = null;
        meta.images = await pdf(file, 'render', dir, String(LIMITS.pdfPages));
      }
    } else if (type === 'zip' && ['docx', 'pptx', 'xlsx'].includes(ext)) {
      meta.kind = 'doc'; text = officeText(buf, ext);
    } else if (MAC && ['doc', 'rtf', 'odt', 'wps', 'webarchive'].includes(ext)) {
      meta.kind = 'doc'; text = await run('textutil', ['-convert', 'txt', '-stdout', file]);
    } else if (!type) {
      text = decodeText(buf);
      if (text !== null) meta.kind = 'doc';
    }
  } catch (e) {
    meta.kind = meta.kind === 'image' ? 'image' : 'other';
    meta.note = '读不出内容：' + String(e.message || e).split('\n')[0].slice(0, 120);
  }
  if (text !== null) {
    text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    meta.chars = text.length;
    if (text.length > LIMITS.fileChars) { meta.truncated = true; text = text.slice(0, LIMITS.fileChars); }
    fs.writeFileSync(path.join(dir, 'text.txt'), text);
    if (!text) meta.note = '文件里没有文字';
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, 0); return b.subarray(0, n); } finally { fs.closeSync(fd); }
}

// 消息里记的附件信息（不含路径；网页显示、发给模型时用）
const pub = (m) => ({ id: m.id, name: m.name, size: m.size, kind: m.kind, chars: m.chars, pages: m.pages, scanned: m.scanned || undefined,
  truncated: m.truncated || undefined, images: m.images.length, inline: m.inline || undefined, preview: !!m.preview || undefined, note: m.note,
  duration: m.duration, width: m.width, height: m.height });
function load(roomDir, id) {
  if (!/^[0-9a-f]{12}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(roomDir, id, 'meta.json'), 'utf8')); } catch { return null; }
}
const texts = new Map(); // 提取出的文字：每次发言都要用，读一次就记住
function textOf(roomDir, a) {
  const f = path.join(roomDir, a.id, 'text.txt');
  if (!texts.has(f)) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch {} texts.set(f, t); if (texts.size > 200) texts.delete(texts.keys().next().value); }
  return texts.get(f);
}

// 写进提示词的附件内容：文档放全文，图片写一行说明（图片本身另外发）
function promptText(roomDir, list) {
  return (list || []).map((a) => {
    if (a.kind === 'image') return `📎 图片「${a.name}」${a.images ? '' : `（${a.note || '没能发给模型'}）`}`;
    if (a.kind === 'video') {
      const meta = load(roomDir, a.id) || {};
      const at = (meta.frameTimes || []).map(clock).join('、');
      return `📎 视频「${a.name}」（${size(a.size)}${a.duration ? `，时长 ${clock(a.duration)}` : ''}${a.width ? `，${a.width}×${a.height}` : ''}）：${a.images ? `从里面均匀截了 ${a.images} 张画面发给你（分别在 ${at}），你看到的只是这几帧，不是整段视频` : a.note || '模型看不到画面'}${meta.audio ? '；声音听不到' : ''}。`;
    }
    if (a.scanned) return `📎 PDF「${a.name}」（${a.pages} 页，是扫描件 / 图片，没有文字；前 ${a.images} 页已转成图片发出）`;
    const t = a.kind === 'doc' ? textOf(roomDir, a) : '';
    if (!t) return `📎 文件「${a.name}」（${size(a.size)}）：${a.note || '这种文件读不了内容'}`;
    const tail = a.truncated ? `\n（文件太长，只放了前 ${LIMITS.fileChars} 字，全文 ${a.chars} 字）` : '';
    return `📎 文件「${a.name}」的内容：\n<<<\n${t}\n>>>${tail}`;
  }).join('\n\n');
}
// 发给能看图的模型的图片（base64）
function visuals(roomDir, list) {
  const out = [];
  for (const a of list || []) {
    const meta = load(roomDir, a.id);
    for (const f of (meta && meta.images) || []) {
      if (out.length >= LIMITS.images) return out;
      try { const buf = fs.readFileSync(path.join(roomDir, a.id, f)); out.push({ name: a.name, mime: IMAGE_SEND[sniff(buf)] || 'image/png', data: buf.toString('base64') }); } catch {}
    }
  }
  return out;
}
// 原文件（Claude Code、Codex 的工作目录要复制原文件过去）
const originals = (roomDir, list) => (list || []).map((a) => { const m = load(roomDir, a.id); return m && { name: m.name, path: path.join(roomDir, m.id, m.original) }; }).filter(Boolean);

// 网页上看 / 下载：图片（真是图片的）直接显示，其他一律下载
function servable(roomDir, id, preview) {
  const m = load(roomDir, id);
  if (!m) return null;
  const f = preview && m.preview ? m.preview : m.original;
  const file = path.join(roomDir, m.id, f);
  let head; try { head = readHead(file); } catch { return null; }
  const img = IMAGE_SEND[sniff(head)];
  const video = !img && m.kind === 'video' && f === m.original ? VIDEO_MIME[extOf(m.name)] : null;
  return { file, name: m.name, mime: img || video || 'application/octet-stream', inline: !!(img || video), video: !!video };
}

// 把图片放进最后一条用户消息（OpenAI 兼容格式 / Claude 格式）
function withImagesOpenAI(messages, images) {
  if (!images || !images.length) return messages;
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return messages;
  const out = messages.slice();
  out[i] = { ...out[i], content: [{ type: 'text', text: String(out[i].content) }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))] };
  return out;
}
const claudeContent = (text, images) => (images && images.length
  ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text }]
  : text);

module.exports = { LIMITS, NO_VISION, receive, diskFree, save, load, pub, promptText, visuals, originals, servable, withImagesOpenAI, claudeContent, safeName, officeText, decodeText };
