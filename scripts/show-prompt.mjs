#!/usr/bin/env node
/**
 * يطبع تعليمات النظام (البرومت) كاملة كما يستلمها النموذج.
 *
 * التشغيل:
 *   npm run prompt            عرض ملخص + القواعد فقط
 *   npm run prompt -- --full  عرض كل شيء بما فيه نصوص ملفات الدرايف
 *   npm run prompt -- --save  حفظ النسخة الكاملة في ملف prompt-preview.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStaticSystemPrompt, GREETING, FALLBACK_ANSWER } from '../netlify/functions/lib/prompt.mjs';
import { knowledge } from '../netlify/functions/lib/knowledge-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const full = args.includes('--full');
const save = args.includes('--save');

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m' };

function estimateTokens(text) {
  let arabic = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfeff)) arabic++;
  }
  return Math.ceil(arabic / 2.5 + (text.length - arabic) / 4);
}

const prompt = buildStaticSystemPrompt(knowledge);
const tokens = estimateTokens(prompt);

console.log('');
console.log(`${C.bold}========== برومت المساعد الذكي — جمعية مكنون ==========${C.reset}`);
console.log('');
console.log(`  الوضع:            ${knowledge.mode === 'full' ? 'النص الكامل' : 'البحث بالمتجهات (embeddings)'}`);
console.log(`  تاريخ آخر مزامنة: ${knowledge.builtAt || 'لم تتم مزامنة بعد'}`);
console.log(`  عدد الملفات:      ${knowledge.docs.length}`);
console.log(`  طول البرومت:      ${prompt.length.toLocaleString('en-US')} حرف`);
console.log(`  تقدير التوكنز:    ~${tokens.toLocaleString('en-US')}`);
console.log('');

if (!knowledge.builtAt) {
  console.log(`${C.yellow}تنبيه:${C.reset} ملفات الدرايف لم تُقرأ بعد على هذا الجهاز،`);
  console.log(`       لذلك سترى القواعد فقط بلا محتوى المستندات.`);
  console.log(`       لقراءتها: املأ ملف .env ثم نفّذ  ${C.cyan}npm.cmd run sync${C.reset}`);
  console.log('');
}

if (knowledge.docs.length) {
  console.log(`${C.bold}الملفات المُضمَّنة:${C.reset}`);
  knowledge.docs.forEach((d, i) => {
    const size = knowledge.mode === 'full' ? `${d.text.length.toLocaleString('en-US')} حرف` : 'مقاطع';
    console.log(`  ${i + 1}. ${d.path}${d.name} ${C.dim}(${d.kind} • ${size})${C.reset}`);
  });
  console.log('');
}

console.log(`${C.bold}رسالة التحية:${C.reset}`);
console.log(`  ${GREETING}`);
console.log('');
console.log(`${C.bold}جملة الاعتذار:${C.reset}`);
console.log(`  ${FALLBACK_ANSWER}`);
console.log('');

console.log(`${C.bold}------------------ نص البرومت ------------------${C.reset}`);
console.log('');

if (full) {
  console.log(prompt);
} else {
  const cut = prompt.indexOf('# مستندات الجمعية');
  console.log(cut > 0 ? prompt.slice(0, cut + '# مستندات الجمعية'.length) : prompt);
  console.log('');
  console.log(`${C.dim}(… هنا تأتي نصوص ملفات الدرايف)${C.reset}`);
  console.log('');
  console.log(`${C.cyan}لعرض كل شيء:${C.reset}  npm.cmd run prompt -- --full`);
  console.log(`${C.cyan}لحفظه بملف:${C.reset}   npm.cmd run prompt -- --save`);
}

if (save) {
  const out = path.join(ROOT, 'prompt-preview.txt');
  fs.writeFileSync(out, prompt, 'utf8');
  console.log('');
  console.log(`${C.green}تم الحفظ في:${C.reset} ${out}`);
}

console.log('');
