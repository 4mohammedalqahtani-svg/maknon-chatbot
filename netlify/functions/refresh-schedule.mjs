/**
 * يطلق تحديث معرفة المساعد كل ليلة الساعة 12 منتصف الليل بتوقيت الرياض
 * (21:00 بتوقيت UTC). لا يحتاج نشرًا جديدًا ولا يستهلك رصيد النشر.
 *
 * للتحديث الفوري: Netlify ← Functions ← refresh-schedule ← Run now
 */

import { refreshToken } from './lib/refresh-auth.mjs';

export const config = { schedule: '0 21 * * *' };

export default async function handler(req, context) {
  const base = process.env.URL || context?.site?.url;
  const token = await refreshToken();
  if (!base || !token) {
    console.error('[خطأ] تعذّر تحديد رابط الموقع أو الرمز السري — لم يُطلق التحديث.');
    return;
  }

  const res = await fetch(new URL('/api/refresh-knowledge', base), {
    method: 'POST',
    headers: { 'x-refresh-token': token },
  });
  // الوظيفة الخلفية ترد 202 فورًا وتكمل العمل وحدها
  console.log(`[معلومة] طلب التحديث أُرسل (${res.status}). التفاصيل في سجل refresh-knowledge.`);
}
