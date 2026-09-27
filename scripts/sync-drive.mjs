#!/usr/bin/env node
/**
 * مزامنة ملفات مجلد Google Drive وتحويلها إلى ملف معرفة يستخدمه الشات بوت.
 *
 * يعمل تلقائيًا أثناء البناء على Netlify (أمر: npm run build).
 *
 * المتغيرات المطلوبة:
 *   GOOGLE_API_KEY   مفتاح Google مقيَّد على Google Drive API
 *   DRIVE_FOLDER_ID  معرّف المجلد العام (مشارَك: "أي شخص لديه الرابط - مُشاهد")
 *   OPENAI_API_KEY   (يُستخدم فقط إذا كان حجم النصوص كبيرًا فنحتاج embeddings)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'netlify', 'functions', 'lib', 'knowledge-data.mjs');
const OUT_JSON = path.join(ROOT, 'knowledge.json');

/* ------------------------------------------------------------------ */
/* إعدادات                                                             */
/* ------------------------------------------------------------------ */

// إذا زاد حجم النصوص عن هذا الحد (بالتوكنز) ننتقل تلقائيًا إلى وضع embeddings
const FULL_CONTEXT_TOKEN_LIMIT = Number(process.env.FULL_CONTEXT_TOKEN_LIMIT || 60000);
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHUNK_CHARS = 1400; // حجم المقطع الواحد في وضع embeddings
const CHUNK_OVERLAP = 200; // تداخل بين المقاطع حتى لا تُقطع المعلومة

/* ------------------------------------------------------------------ */
/* حماية الخصوصية                                                      */
/* ------------------------------------------------------------------ */

// الموقع عام، لذلك يُستبعد تلقائيًا أي ملف أو مجلد يحمل في اسمه إحدى هذه الكلمات.
// يمكن استبدال القائمة كاملة عبر المتغير DRIVE_EXCLUDE_PATTERNS (مفصولة بفاصلة).
const DEFAULT_EXCLUDE = [
  'سري', 'سرية', 'خاص', 'خاصة', 'داخلي', 'داخلية', 'لا ينشر', 'لا تنشر',
  'موظف', 'موظفين', 'منسوبي', 'المنسوبين', 'كادر', 'الكادر',
  'راتب', 'رواتب', 'مسير', 'مكافآ', 'بدلات',
  'هوية', 'هويات', 'السجل المدني', 'جوال', 'جوالات', 'أرقام التواصل',
  'بيانات شخصية', 'سيرة ذاتية', 'سير ذاتية', 'عقد', 'عقود', 'تقييم أداء',
  'كشف أسماء', 'قائمة أسماء', 'قوائم أسماء', 'مستفيدين', 'المستفيدين',
  'متبرع', 'متبرعين', 'حساب بنكي', 'ايبان', 'آيبان',
  'private', 'confidential', 'internal', 'salaries', 'employees', 'staff',
];

const EXCLUDE_PATTERNS = (process.env.DRIVE_EXCLUDE_PATTERNS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const EXCLUDE_LIST = EXCLUDE_PATTERNS.length ? EXCLUDE_PATTERNS : DEFAULT_EXCLUDE;

/** يعيد الكلمة المطابقة إن كان الاسم يدل على محتوى غير قابل للنشر */
function matchExcluded(name) {
  const n = String(name).toLowerCase();
  return EXCLUDE_LIST.find((w) => n.includes(String(w).toLowerCase())) || null;
}

// أنماط البيانات الشخصية التي نفحص النصوص بحثًا عنها
const PII_CHECKS = [
  { label: 'أرقام جوال سعودية', re: /(?:\+?966|00966|0)?5\d{8}/g },
  { label: 'أرقام هوية أو سجل مدني', re: /(?<!\d)[12]\d{9}(?!\d)/g },
  { label: 'عناوين بريد إلكتروني', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { label: 'أرقام آيبان', re: /\bSA\d{22}\b/gi },
];

/** يفحص نص ملف بحثًا عن بيانات شخصية ويعيد ملخصًا */
function scanForPII(text) {
  const found = [];
  for (const { label, re } of PII_CHECKS) {
    const hits = text.match(re);
    if (hits && hits.length) found.push(`${label}: ${hits.length}`);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* أدوات مساعدة                                                        */
/* ------------------------------------------------------------------ */

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};
const log = (...a) => console.log(...a);
const ok = (m) => log(`${C.green}[نجح]${C.reset} ${m}`);
const warn = (m) => log(`${C.yellow}[تحذير]${C.reset} ${m}`);
const info = (m) => log(`${C.cyan}[معلومة]${C.reset} ${m}`);
const fail = (m) => log(`${C.red}[خطأ]${C.reset} ${m}`);

const warnings = [];
function addWarning(m) {
  warnings.push(m);
  warn(m);
}

// ملفات استُبعدت لأن أسماءها تدل على محتوى غير قابل للنشر
const excluded = [];
// ملفات نُشرت لكن يوجد فيها ما يشبه بيانات شخصية
const piiAlerts = [];

/** تحميل ملف .env محليًا (على Netlify تأتي المتغيرات جاهزة) */
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

/** تقدير عدد التوكنز (تقريبي — العربية أكثف من الإنجليزية) */
function estimateTokens(text) {
  if (!text) return 0;
  let arabic = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfeff)) {
      arabic++;
    }
  }
  const other = text.length - arabic;
  return Math.ceil(arabic / 2.5 + other / 4);
}

/** تنظيف النص: إزالة الأسطر الفارغة الزائدة والمسافات المكررة */
function cleanText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function human(n) {
  return Number(n).toLocaleString('en-US');
}

/* ------------------------------------------------------------------ */
/* Google Drive API (بمفتاح API فقط — بدون OAuth)                      */
/* ------------------------------------------------------------------ */

const DRIVE = 'https://www.googleapis.com/drive/v3';

async function driveFetch(url, { binary = false } = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.text();
      const j = JSON.parse(body);
      detail = (j && j.error && j.error.message) || body.slice(0, 300);
    } catch {
      /* تجاهل */
    }
    const err = new Error(`HTTP ${res.status} — ${detail}`);
    err.status = res.status;
    throw err;
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** سرد كل الملفات داخل مجلد ومجلداته الفرعية */
async function listFolderRecursive(folderId, apiKey, prefix = '', depth = 0, seen = new Set()) {
  if (depth > 8) {
    addWarning(`تم تجاوز عمق المجلدات المسموح عند: ${prefix}`);
    return [];
  }
  if (seen.has(folderId)) return [];
  seen.add(folderId);

  const out = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
      pageSize: '200',
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const json = JSON.parse(await driveFetch(`${DRIVE}/files?${params}`));
    pageToken = json.nextPageToken || null;

    for (const f of json.files || []) {
      const hit = matchExcluded(f.name);

      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (hit) {
          excluded.push({ label: `${prefix}${f.name}/ (مجلد كامل)`, word: hit });
          continue;
        }
        const sub = await listFolderRecursive(f.id, apiKey, `${prefix}${f.name}/`, depth + 1, seen);
        out.push(...sub);
      } else {
        if (hit) {
          excluded.push({ label: `${prefix}${f.name}`, word: hit });
          continue;
        }
        out.push({ ...f, folderPath: prefix });
      }
    }
  } while (pageToken);

  return out;
}

/* ------------------------------------------------------------------ */
/* استخراج النص حسب نوع الملف                                          */
/* ------------------------------------------------------------------ */

const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const GSLIDE = 'application/vnd.google-apps.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function exportUrl(id, mimeType, key) {
  return `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}&key=${key}`;
}
function downloadUrl(id, key) {
  return `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true&key=${key}`;
}

async function extractPdf(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return { text: result.text || '', pages: result.total || 0 };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buffer) {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: value || '' };
}

/** تحويل ملف Excel إلى نص جدولي مقروء (كل الأوراق) */
async function extractXlsx(buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const parts = [];
  wb.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        let v = cell.value;
        if (v == null) {
          v = '';
        } else if (v instanceof Date) {
          v = v.toISOString().slice(0, 10);
        } else if (typeof v === 'object') {
          if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join('');
          else if (v.text != null) v = v.text;
          else if (v.result != null) v = v.result;
          else if (v.hyperlink != null) v = v.hyperlink;
          else v = JSON.stringify(v);
        }
        values.push(String(v).replace(/\s+/g, ' ').trim());
      });
      while (values.length && values[values.length - 1] === '') values.pop();
      if (values.some((x) => x !== '')) rows.push(values.join(' | '));
    });
    if (rows.length) parts.push(`### ورقة: ${sheet.name}\n${rows.join('\n')}`);
  });

  return { text: parts.join('\n\n') };
}

/** يعيد { text, kind, note } أو يرمي خطأ */
async function extractFile(file, apiKey) {
  const { id, name, mimeType } = file;
  const ext = (name.split('.').pop() || '').toLowerCase();

  // ملفات Google الأصلية => تصدير
  if (mimeType === GDOC) {
    return { text: await driveFetch(exportUrl(id, 'text/plain', apiKey)), kind: 'مستند Google' };
  }
  if (mimeType === GSLIDE) {
    return { text: await driveFetch(exportUrl(id, 'text/plain', apiKey)), kind: 'عرض Google' };
  }
  if (mimeType === GSHEET) {
    // نصدّره كـ xlsx حتى نقرأ كل الأوراق (تصدير CSV يعطي الورقة الأولى فقط)
    const buf = await driveFetch(exportUrl(id, XLSX_MIME, apiKey), { binary: true });
    const { text } = await extractXlsx(buf);
    return { text, kind: 'جدول Google' };
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error(`نوع ملف Google غير مدعوم للتحويل النصي (${mimeType})`);
  }

  // ملفات مرفوعة => تنزيل
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    const buf = await driveFetch(downloadUrl(id, apiKey), { binary: true });
    const { text, pages } = await extractPdf(buf);
    const clean = cleanText(text);
    // كشف الملفات الممسوحة ضوئيًا (صور بلا طبقة نصية)
    if (pages > 0 && clean.length / pages < 40) {
      return {
        text: clean,
        kind: 'PDF',
        note: `يبدو أنه ممسوح ضوئيًا (صور) بلا نص قابل للقراءة — ${pages} صفحة و ${clean.length} حرفًا فقط`,
      };
    }
    return { text: clean, kind: `PDF (${pages} صفحة)` };
  }
  if (mimeType === DOCX_MIME || ext === 'docx') {
    const buf = await driveFetch(downloadUrl(id, apiKey), { binary: true });
    const { text } = await extractDocx(buf);
    return { text, kind: 'Word' };
  }
  if (mimeType === XLSX_MIME || ext === 'xlsx' || ext === 'xlsm') {
    const buf = await driveFetch(downloadUrl(id, apiKey), { binary: true });
    const { text } = await extractXlsx(buf);
    return { text, kind: 'Excel' };
  }
  if (mimeType.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(ext)) {
    return { text: await driveFetch(downloadUrl(id, apiKey)), kind: 'نص' };
  }
  if (ext === 'doc' || mimeType === 'application/msword') {
    throw new Error('صيغة .doc القديمة غير مدعومة — افتح الملف في محرّر مستندات Google واحفظه كمستند Google أو .docx');
  }
  if (ext === 'pptx' || ext === 'ppt' || mimeType === PPTX_MIME) {
    throw new Error('ملفات PowerPoint غير مدعومة — حوّلها إلى "عروض Google التقديمية" داخل الدرايف');
  }

  throw new Error(`نوع غير مدعوم (${mimeType || ext || 'غير معروف'})`);
}

/* ------------------------------------------------------------------ */
/* تقطيع النصوص + embeddings                                           */
/* ------------------------------------------------------------------ */

function chunkText(text, title) {
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = '';

  const push = () => {
    const t = buf.trim();
    if (t.length > 30) chunks.push(t);
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > CHUNK_CHARS) {
      push();
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        buf = p.slice(i, i + CHUNK_CHARS);
        push();
      }
      continue;
    }
    if ((buf + '\n\n' + p).length > CHUNK_CHARS && buf) {
      const carry = buf.slice(-CHUNK_OVERLAP);
      push();
      buf = carry + '\n\n';
    }
    buf += p + '\n\n';
  }
  push();

  return chunks.map((c, i) => ({ title, part: i + 1, total: chunks.length, text: c }));
}

async function embedAll(chunks, apiKey) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const BATCH = 96;
  const vectors = [];

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    info(`حساب المتجهات ${i + 1}–${Math.min(i + BATCH, chunks.length)} من ${chunks.length} …`);
    const res = await client.embeddings.create({
      model: EMBED_MODEL,
      input: batch.map((c) => `${c.title}\n\n${c.text}`),
    });
    for (const d of res.data) {
      // تطبيع المتجه ليصبح حساب التشابه مجرد ضرب نقطي
      const v = d.embedding;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      vectors.push(v.map((x) => Number((x / norm).toFixed(5))));
    }
  }
  return vectors;
}

/* ------------------------------------------------------------------ */
/* البرنامج الرئيسي                                                    */
/* ------------------------------------------------------------------ */

async function main() {
  loadDotEnv();

  log('');
  log(`${C.bold}========== مزامنة معرفة المساعد الذكي — جمعية مكنون ==========${C.reset}`);
  log('');

  const apiKey = process.env.GOOGLE_API_KEY;
  const folderId = process.env.DRIVE_FOLDER_ID;

  if (!apiKey || !folderId) {
    fail('المتغيران GOOGLE_API_KEY و DRIVE_FOLDER_ID مطلوبان.');
    log('');
    log('  - محليًا: انسخ ملف .env.example إلى .env واملأ القيم.');
    log('  - على Netlify: Site configuration ثم Environment variables.');
    log('  - التفاصيل خطوة بخطوة في ملف SETUP_AR.md');
    log('');
    process.exit(1);
  }

  /* 1) سرد الملفات ------------------------------------------------- */
  info(`قراءة محتويات المجلد ${folderId} …`);
  let files;
  try {
    files = await listFolderRecursive(folderId, apiKey);
  } catch (e) {
    fail(`تعذّر قراءة المجلد: ${e.message}`);
    log('');
    if (e.status === 403) {
      log('  السبب الأرجح: Drive API غير مفعّل على المشروع، أو المفتاح مقيّد بطريقة تمنعه.');
    } else if (e.status === 404) {
      log('  السبب الأرجح: معرّف المجلد خاطئ، أو المجلد غير مشارَك "أي شخص لديه الرابط".');
    }
    log('  راجع قسم "حل المشكلات الشائعة" في ملف SETUP_AR.md');
    log('');
    process.exit(1);
  }

  if (!files.length) {
    fail('المجلد فارغ أو غير مشارَك للعامة. لا يمكن بناء معرفة للمساعد.');
    process.exit(1);
  }
  ok(`تم العثور على ${files.length} ملفًا قابلًا للنشر`);

  if (excluded.length) {
    log('');
    log(`${C.yellow}${C.bold}استُبعد ${excluded.length} عنصرًا لحماية الخصوصية:${C.reset}`);
    for (const e of excluded) log(`  ${C.yellow}—${C.reset} ${e.label} ${C.dim}(بسبب الكلمة: "${e.word}")${C.reset}`);
    log(`${C.dim}  هذه العناصر لن يراها المساعد إطلاقًا.${C.reset}`);
    log(`${C.dim}  لتعديل قائمة الاستبعاد استخدم المتغير DRIVE_EXCLUDE_PATTERNS.${C.reset}`);
  }
  log('');

  /* 2) استخراج النصوص --------------------------------------------- */
  const docs = [];
  let failedCount = 0;

  for (const f of files) {
    const label = `${f.folderPath}${f.name}`;
    try {
      const { text, kind, note } = await extractFile(f, apiKey);
      const clean = cleanText(text);

      if (!clean) {
        addWarning(`"${label}" — لم يُستخرج منه أي نص (قد يكون فارغًا أو صورًا فقط). تم تخطيه.`);
        failedCount++;
        continue;
      }
      if (note) addWarning(`"${label}" — ${note}`);

      // فحص البيانات الشخصية داخل النص المستخرج
      const pii = scanForPII(clean);
      if (pii.length) piiAlerts.push({ label, details: pii });

      docs.push({
        name: f.name,
        path: f.folderPath,
        kind,
        modified: f.modifiedTime,
        text: clean,
      });

      const tk = estimateTokens(clean);
      log(`  ${C.green}+${C.reset} ${label} ${C.dim}(${kind} • ${human(clean.length)} حرف • ~${human(tk)} توكن)${C.reset}`);
    } catch (e) {
      failedCount++;
      addWarning(`"${label}" — فشل الاستخراج: ${e.message}`);
    }
  }

  if (!docs.length) {
    fail('لم يُستخرج نص من أي ملف. لا يمكن المتابعة.');
    process.exit(1);
  }

  /* 3) التقرير ------------------------------------------------------ */
  const totalChars = docs.reduce((s, d) => s + d.text.length, 0);
  const totalTokens = docs.reduce((s, d) => s + estimateTokens(d.text), 0);

  log('');
  log(`${C.bold}---------------- التقرير ----------------${C.reset}`);
  log(`  ملفات نجحت:              ${docs.length}`);
  log(`  ملفات فشلت أو فارغة:     ${failedCount}`);
  log(`  ملفات استُبعدت للخصوصية: ${excluded.length}`);
  log(`  إجمالي الأحرف:           ${human(totalChars)}`);
  log(`  إجمالي التوكنز (تقريبي): ${human(totalTokens)}`);
  log('');

  /* 4) اختيار الوضع ------------------------------------------------- */
  const useFullContext = totalTokens <= FULL_CONTEXT_TOKEN_LIMIT;
  let payload;

  if (useFullContext) {
    ok(`الوضع المختار: ${C.bold}النص الكامل${C.reset} (كل المحتوى داخل تعليمات النظام)`);
    log(`  ${C.dim}السبب: ${human(totalTokens)} توكن <= الحد ${human(FULL_CONTEXT_TOKEN_LIMIT)}${C.reset}`);
    log(`  ${C.dim}الميزة: يستفيد تلقائيًا من التخزين المؤقت للمدخلات (prompt caching) لدى OpenAI.${C.reset}`);

    const inCost = (totalTokens / 1e6) * 0.25;
    const cachedCost = (totalTokens / 1e6) * 0.025;
    const outCost = (700 / 1e6) * 2.0;
    log('');
    log('  التكلفة التقريبية للسؤال الواحد بنموذج gpt-5-mini:');
    log(`    - أول سؤال (بلا تخزين مؤقت):        ~$${(inCost + outCost).toFixed(5)}`);
    log(`    - الأسئلة التالية (مع تخزين مؤقت):  ~$${(cachedCost + outCost).toFixed(5)}`);
    log('');

    payload = {
      mode: 'full',
      builtAt: new Date().toISOString(),
      stats: { files: docs.length, chars: totalChars, tokens: totalTokens },
      docs: docs.map((d) => ({ name: d.name, path: d.path, kind: d.kind, modified: d.modified, text: d.text })),
      chunks: [],
      vectors: [],
      embedModel: null,
    };
  } else {
    ok(`الوضع المختار: ${C.bold}البحث بالمتجهات (embeddings)${C.reset}`);
    log(`  ${C.dim}السبب: ${human(totalTokens)} توكن > الحد ${human(FULL_CONTEXT_TOKEN_LIMIT)}${C.reset}`);

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      fail('حجم النصوص كبير ويلزم استخدام embeddings، لكن OPENAI_API_KEY غير موجود.');
      log('  أضف المتغير OPENAI_API_KEY في إعدادات Netlify ثم أعد البناء.');
      process.exit(1);
    }

    const chunks = [];
    for (const d of docs) chunks.push(...chunkText(d.text, `${d.path}${d.name}`));
    info(`تم تقسيم المحتوى إلى ${chunks.length} مقطعًا`);

    const vectors = await embedAll(chunks, openaiKey);
    const embedTokens = chunks.reduce((s, c) => s + estimateTokens(c.text), 0);
    ok(`تم حساب ${vectors.length} متجهًا (تكلفة لمرة واحدة عند كل بناء: ~$${((embedTokens / 1e6) * 0.02).toFixed(5)})`);

    log('');
    log('  التكلفة التقريبية للسؤال الواحد: ~$0.002 – $0.005');
    log(`  ${C.dim}(تضمين السؤال + إرسال أفضل المقاطع فقط للنموذج)${C.reset}`);
    log('');

    payload = {
      mode: 'embed',
      builtAt: new Date().toISOString(),
      stats: { files: docs.length, chars: totalChars, tokens: totalTokens, chunks: chunks.length },
      docs: docs.map((d) => ({ name: d.name, path: d.path, kind: d.kind, modified: d.modified, text: '' })),
      chunks,
      vectors,
      embedModel: EMBED_MODEL,
    };
  }

  /* 5) الحفظ -------------------------------------------------------- */
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  // نسخة JSON للمراجعة البشرية
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        mode: payload.mode,
        builtAt: payload.builtAt,
        stats: payload.stats,
        files: docs.map((d) => ({
          name: d.name,
          path: d.path,
          kind: d.kind,
          modified: d.modified,
          chars: d.text.length,
          text: d.text,
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  // الوحدة التي تستوردها وظيفة Netlify (تُحزَّم داخلها تلقائيًا)
  const header =
    '// ملف مُولَّد تلقائيًا بواسطة scripts/sync-drive.mjs — لا تُعدّله يدويًا.\n' +
    `// تاريخ البناء: ${payload.builtAt}\n\n`;
  fs.writeFileSync(OUT_FILE, header + 'export const knowledge = ' + JSON.stringify(payload) + ';\n', 'utf8');

  const outSize = fs.statSync(OUT_FILE).size;
  ok(`تم حفظ knowledge.json (${human(fs.statSync(OUT_JSON).size)} بايت)`);
  ok(`تم حفظ netlify/functions/lib/knowledge-data.mjs (${human(outSize)} بايت)`);

  if (outSize > 40 * 1024 * 1024) {
    addWarning('حجم ملف المعرفة تجاوز 40 ميجابايت وقد يفشل نشر الوظيفة على Netlify. قلّل عدد الملفات.');
  }

  /* 6) إنذار البيانات الشخصية --------------------------------------- */
  if (piiAlerts.length) {
    log('');
    log(`${C.red}${C.bold}############ إنذار خصوصية ############${C.reset}`);
    log(`${C.red}عُثر على ما يشبه بيانات شخصية داخل ${piiAlerts.length} ملفًا سيُنشر للعامة:${C.reset}`);
    log('');
    for (const a of piiAlerts) {
      log(`  ${C.red}!${C.reset} ${a.label}`);
      log(`     ${C.dim}${a.details.join(' • ')}${C.reset}`);
    }
    log('');
    log(`${C.yellow}الموقع عام يدخله أي شخص. راجع هذه الملفات فورًا:${C.reset}`);
    log('  - إن كانت تحتوي بيانات أشخاص، انقلها خارج مجلد الدرايف المُشارَك.');
    log('  - أو أعد تسميتها بإضافة كلمة "خاص" في بداية الاسم ليستبعدها النظام تلقائيًا.');
    log(`${C.dim}  ملاحظة: قواعد المساعد تمنع كشف هذه البيانات، لكن الضمان الحقيقي هو ألا تصل إليه أصلًا.${C.reset}`);
    log('');
  }

  /* 7) ملخص التحذيرات ---------------------------------------------- */
  log('');
  if (warnings.length) {
    log(`${C.yellow}${C.bold}تحذيرات تحتاج انتباهك (${warnings.length}):${C.reset}`);
    warnings.forEach((w, i) => log(`  ${i + 1}. ${w}`));
    log('');
    log(`${C.dim}ملاحظة: الملفات الممسوحة ضوئيًا (صور) تحتاج تحويلها إلى نص.${C.reset}`);
    log(`${C.dim}أسهل طريقة: في الدرايف اضغط على الملف بالزر الأيمن ثم "فتح باستخدام" ثم "محرّر مستندات Google".${C.reset}`);
    log('');
  } else {
    ok('لا توجد تحذيرات — كل الملفات استُخرجت بنجاح.');
  }

  log(`${C.green}${C.bold}اكتملت المزامنة بنجاح.${C.reset}`);
  log('');
}

main().catch((e) => {
  log('');
  fail(`خطأ غير متوقع: ${e.stack || e.message}`);
  process.exit(1);
});
