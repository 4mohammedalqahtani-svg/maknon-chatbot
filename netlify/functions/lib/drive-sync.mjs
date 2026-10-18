/**
 * قراءة ملفات مجلد Google Drive وتحويلها إلى معرفة يستخدمها الشات بوت.
 *
 * يُستخدم من مكانين:
 *   - scripts/sync-drive.mjs           وقت البناء أو على الجهاز (npm run sync)
 *   - netlify/functions/refresh-knowledge.mjs   التحديث الليلي بدون نشر جديد
 *
 * المتغيرات المطلوبة:
 *   GOOGLE_API_KEY   مفتاح Google مقيَّد على Google Drive API
 *   DRIVE_FOLDER_ID  معرّف المجلد العام (مشارَك: "أي شخص لديه الرابط - مُشاهد")
 *   OPENAI_API_KEY   (يُستخدم فقط إذا كان حجم النصوص كبيرًا فنحتاج embeddings)
 */

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

function excludeList() {
  const custom = (process.env.DRIVE_EXCLUDE_PATTERNS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_EXCLUDE;
}

/** يعيد الكلمة المطابقة إن كان الاسم يدل على محتوى غير قابل للنشر */
function matchExcluded(name, list) {
  const n = String(name).toLowerCase();
  return list.find((w) => n.includes(String(w).toLowerCase())) || null;
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

/** تقدير عدد التوكنز (تقريبي — العربية أكثف من الإنجليزية) */
export function estimateTokens(text) {
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
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function human(n) {
  return Number(n).toLocaleString('en-US');
}

/** خطأ يوقف المزامنة كاملة (تبقى المعرفة السابقة كما هي) */
export class SyncError extends Error {
  constructor(message, { status, hints = [] } = {}) {
    super(message);
    this.status = status;
    this.hints = hints;
  }
}

const silentLogger = { log() {}, info() {}, ok() {}, warn() {} };

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
async function listFolderRecursive(state, folderId, prefix = '', depth = 0) {
  const { apiKey, seen, excluded, addWarning, exclude } = state;
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
      const hit = matchExcluded(f.name, exclude);

      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (hit) {
          excluded.push({ label: `${prefix}${f.name}/ (مجلد كامل)`, word: hit });
          continue;
        }
        const sub = await listFolderRecursive(state, f.id, `${prefix}${f.name}/`, depth + 1);
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
  // pdf.js يحتاج DOMMatrix وأخواتها في Node. يجلبها بنفسه عادةً، لكن داخل
  // وظائف Netlify لا تُرفق المكتبة إلا إذا استوردناها صراحةً هنا.
  if (!globalThis.DOMMatrix) {
    const canvas = await import('@napi-rs/canvas');
    globalThis.DOMMatrix = canvas.DOMMatrix;
    globalThis.ImageData ??= canvas.ImageData;
    globalThis.Path2D ??= canvas.Path2D;
  }
  const { PDFParse } = await import('pdf-parse');
  // نفس السبب: نحمّل عامل pdf.js من داخل المكتبة بدل ملف قد لا يُرفق
  const { getData } = await import('pdf-parse/worker');
  PDFParse.setWorker(getData());
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

async function embedAll(chunks, apiKey, logger) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const BATCH = 96;
  const vectors = [];

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    logger.info(`حساب المتجهات ${i + 1}–${Math.min(i + BATCH, chunks.length)} من ${chunks.length} …`);
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
/* بناء المعرفة                                                        */
/* ------------------------------------------------------------------ */

/**
 * يقرأ مجلد الدرايف ويبني كائن المعرفة.
 *
 * يعيد { payload, docs, excluded, piiAlerts, warnings, failedCount, totalChars, totalTokens }
 * ويرمي SyncError إن تعذّر بناء أي معرفة (فتبقى المعرفة السابقة كما هي).
 */
export async function buildKnowledge({ apiKey, folderId, openaiKey, logger = silentLogger } = {}) {
  if (!apiKey || !folderId) {
    throw new SyncError('المتغيران GOOGLE_API_KEY و DRIVE_FOLDER_ID مطلوبان.');
  }

  const warnings = [];
  const addWarning = (m) => {
    warnings.push(m);
    logger.warn(m);
  };
  // ملفات استُبعدت لأن أسماءها تدل على محتوى غير قابل للنشر
  const excluded = [];
  // ملفات نُشرت لكن يوجد فيها ما يشبه بيانات شخصية
  const piiAlerts = [];

  /* 1) سرد الملفات ------------------------------------------------- */
  logger.info(`قراءة محتويات المجلد ${folderId} …`);
  let files;
  try {
    const state = { apiKey, seen: new Set(), excluded, addWarning, exclude: excludeList() };
    files = await listFolderRecursive(state, folderId);
  } catch (e) {
    const hints = [];
    if (e.status === 403) {
      hints.push('السبب الأرجح: Drive API غير مفعّل على المشروع، أو المفتاح مقيّد بطريقة تمنعه.');
    } else if (e.status === 404) {
      hints.push('السبب الأرجح: معرّف المجلد خاطئ، أو المجلد غير مشارَك "أي شخص لديه الرابط".');
    }
    throw new SyncError(`تعذّر قراءة المجلد: ${e.message}`, { status: e.status, hints });
  }

  if (!files.length) {
    throw new SyncError('المجلد فارغ أو غير مشارَك للعامة. لا يمكن بناء معرفة للمساعد.');
  }
  logger.ok(`تم العثور على ${files.length} ملفًا قابلًا للنشر`);

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
      logger.log(`  + ${label} (${kind} • ${human(clean.length)} حرف • ~${human(tk)} توكن)`);
    } catch (e) {
      failedCount++;
      addWarning(`"${label}" — فشل الاستخراج: ${e.message}`);
    }
  }

  if (!docs.length) {
    throw new SyncError('لم يُستخرج نص من أي ملف. لا يمكن المتابعة.');
  }

  const totalChars = docs.reduce((s, d) => s + d.text.length, 0);
  const totalTokens = docs.reduce((s, d) => s + estimateTokens(d.text), 0);

  /* 3) اختيار الوضع ------------------------------------------------- */
  let payload;

  if (totalTokens <= FULL_CONTEXT_TOKEN_LIMIT) {
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
    if (!openaiKey) {
      throw new SyncError('حجم النصوص كبير ويلزم استخدام embeddings، لكن OPENAI_API_KEY غير موجود.', {
        hints: ['أضف المتغير OPENAI_API_KEY في إعدادات Netlify.'],
      });
    }

    const chunks = [];
    for (const d of docs) chunks.push(...chunkText(d.text, `${d.path}${d.name}`));
    logger.info(`تم تقسيم المحتوى إلى ${chunks.length} مقطعًا`);

    const vectors = await embedAll(chunks, openaiKey, logger);

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

  return { payload, docs, excluded, piiAlerts, warnings, failedCount, totalChars, totalTokens };
}

export { FULL_CONTEXT_TOKEN_LIMIT };
