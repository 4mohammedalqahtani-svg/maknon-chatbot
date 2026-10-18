#!/usr/bin/env node
/**
 * مزامنة ملفات مجلد Google Drive وتحويلها إلى ملف معرفة يستخدمه الشات بوت.
 *
 * يعمل أثناء البناء على Netlify (أمر: npm run build) وعلى الجهاز (npm run sync).
 * المنطق نفسه في netlify/functions/lib/drive-sync.mjs، ويستخدمه أيضًا
 * التحديث الليلي (netlify/functions/refresh-knowledge.mjs) بدون نشر جديد.
 *
 * المتغيرات المطلوبة:
 *   GOOGLE_API_KEY   مفتاح Google مقيَّد على Google Drive API
 *   DRIVE_FOLDER_ID  معرّف المجلد العام (مشارَك: "أي شخص لديه الرابط - مُشاهد")
 *   OPENAI_API_KEY   (يُستخدم فقط إذا كان حجم النصوص كبيرًا فنحتاج embeddings)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKnowledge,
  estimateTokens,
  SyncError,
  FULL_CONTEXT_TOKEN_LIMIT,
} from '../netlify/functions/lib/drive-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'netlify', 'functions', 'lib', 'knowledge-data.mjs');
const OUT_JSON = path.join(ROOT, 'knowledge.json');

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

function human(n) {
  return Number(n).toLocaleString('en-US');
}

const logger = {
  log,
  info,
  ok,
  warn,
};

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

  /* 1) القراءة والاستخراج ----------------------------------------- */
  let result;
  try {
    result = await buildKnowledge({ apiKey, folderId, openaiKey: process.env.OPENAI_API_KEY, logger });
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    fail(e.message);
    log('');
    for (const h of e.hints) log(`  ${h}`);
    if (e.status) log('  راجع قسم "حل المشكلات الشائعة" في ملف SETUP_AR.md');
    log('');
    process.exit(1);
  }

  const { payload, docs, excluded, piiAlerts, warnings, failedCount, totalChars, totalTokens } = result;

  if (excluded.length) {
    log('');
    log(`${C.yellow}${C.bold}استُبعد ${excluded.length} عنصرًا لحماية الخصوصية:${C.reset}`);
    for (const e of excluded) log(`  ${C.yellow}—${C.reset} ${e.label} ${C.dim}(بسبب الكلمة: "${e.word}")${C.reset}`);
    log(`${C.dim}  هذه العناصر لن يراها المساعد إطلاقًا.${C.reset}`);
    log(`${C.dim}  لتعديل قائمة الاستبعاد استخدم المتغير DRIVE_EXCLUDE_PATTERNS.${C.reset}`);
  }

  /* 2) التقرير ------------------------------------------------------ */
  log('');
  log(`${C.bold}---------------- التقرير ----------------${C.reset}`);
  log(`  ملفات نجحت:              ${docs.length}`);
  log(`  ملفات فشلت أو فارغة:     ${failedCount}`);
  log(`  ملفات استُبعدت للخصوصية: ${excluded.length}`);
  log(`  إجمالي الأحرف:           ${human(totalChars)}`);
  log(`  إجمالي التوكنز (تقريبي): ${human(totalTokens)}`);
  log('');

  /* 3) الوضع المختار ------------------------------------------------ */
  if (payload.mode === 'full') {
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
  } else {
    ok(`الوضع المختار: ${C.bold}البحث بالمتجهات (embeddings)${C.reset}`);
    log(`  ${C.dim}السبب: ${human(totalTokens)} توكن > الحد ${human(FULL_CONTEXT_TOKEN_LIMIT)}${C.reset}`);

    const embedTokens = payload.chunks.reduce((s, c) => s + estimateTokens(c.text), 0);
    ok(`تم حساب ${payload.vectors.length} متجهًا (تكلفة لمرة واحدة عند كل بناء: ~$${((embedTokens / 1e6) * 0.02).toFixed(5)})`);

    log('');
    log('  التكلفة التقريبية للسؤال الواحد: ~$0.002 – $0.005');
    log(`  ${C.dim}(تضمين السؤال + إرسال أفضل المقاطع فقط للنموذج)${C.reset}`);
    log('');
  }

  /* 4) الحفظ -------------------------------------------------------- */
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
    warn('حجم ملف المعرفة تجاوز 40 ميجابايت وقد يفشل نشر الوظيفة على Netlify. قلّل عدد الملفات.');
    warnings.push('حجم ملف المعرفة تجاوز 40 ميجابايت وقد يفشل نشر الوظيفة على Netlify. قلّل عدد الملفات.');
  }

  /* 5) إنذار البيانات الشخصية --------------------------------------- */
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

  /* 6) ملخص التحذيرات ---------------------------------------------- */
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
