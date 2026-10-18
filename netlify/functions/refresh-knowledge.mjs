/**
 * تحديث معرفة المساعد من Google Drive بدون نشر جديد.
 *
 * وظيفة خلفية (تعمل حتى 15 دقيقة): تقرأ مجلد الدرايف، تبني المعرفة،
 * وتحفظها في Netlify Blobs فيستخدمها الشات فورًا.
 *
 * لا تُستدعى يدويًا من المتصفح: تطلقها وظيفة refresh-schedule كل ليلة.
 * النتيجة تظهر في سجل الوظيفة: Netlify ← Logs ← Functions ← refresh-knowledge
 */

import { buildKnowledge, SyncError } from './lib/drive-sync.mjs';
import { saveKnowledge } from './lib/knowledge-store.mjs';
import { refreshToken, sameToken } from './lib/refresh-auth.mjs';

export const config = { path: '/api/refresh-knowledge', background: true };

const logger = {
  log: (m) => console.log(m),
  info: (m) => console.log(`[معلومة] ${m}`),
  ok: (m) => console.log(`[نجح] ${m}`),
  warn: (m) => console.log(`[تحذير] ${m}`),
};

export default async function handler(req) {
  const expected = await refreshToken();
  if (!expected || !sameToken(req.headers.get('x-refresh-token'), expected)) {
    console.log('[مرفوض] طلب تحديث بدون رمز صحيح.');
    return;
  }

  const started = Date.now();
  console.log('========== تحديث معرفة المساعد من Google Drive ==========');

  let result;
  try {
    result = await buildKnowledge({
      apiKey: process.env.GOOGLE_API_KEY,
      folderId: process.env.DRIVE_FOLDER_ID,
      openaiKey: process.env.OPENAI_API_KEY,
      logger,
    });
  } catch (e) {
    console.error(`[خطأ] ${e.message}`);
    if (e instanceof SyncError) {
      for (const h of e.hints) console.error(`  ${h}`);
      if (!process.env.GOOGLE_API_KEY || !process.env.DRIVE_FOLDER_ID) {
        console.error('  تأكد أن نطاق (Scopes) المتغيرين في Netlify يشمل Functions وليس Builds فقط.');
      }
    }
    console.error('  بقيت المعرفة السابقة كما هي.');
    return;
  }

  const { payload, excluded, piiAlerts, warnings, failedCount } = result;
  await saveKnowledge(payload);

  console.log(
    `[نجح] حُفظت المعرفة: ${payload.stats.files} ملفًا • الوضع ${payload.mode} • ` +
      `فشل ${failedCount} • استُبعد ${excluded.length} للخصوصية • ${Math.round((Date.now() - started) / 1000)} ثانية`
  );
  for (const e of excluded) console.log(`  استُبعد: ${e.label} (بسبب الكلمة: "${e.word}")`);
  for (const a of piiAlerts) console.log(`  [إنذار خصوصية] ${a.label}: ${a.details.join(' • ')}`);
  warnings.forEach((w, i) => console.log(`  تحذير ${i + 1}: ${w}`));
}
