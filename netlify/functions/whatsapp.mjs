/**
 * استقبال رسائل الواتساب من ميتا (Webhook).
 *
 * GET  /api/whatsapp  — تأكيد الربط مرة واحدة عند إعداد الـ Webhook في ميتا.
 * POST /api/whatsapp  — كل رسالة جديدة. نتحقق من توقيع ميتا، ثم نسلّم الرسالة
 *                       لوظيفة خلفية (whatsapp-reply) ونرد على ميتا فورًا،
 *                       لأن ميتا تعيد الإرسال إن تأخر الرد، وتوليد الإجابة يأخذ ثوانٍ.
 */

import { verifySignature, extractMessages, whatsappConfigured } from './lib/whatsapp-api.mjs';
import { internalToken } from './lib/refresh-auth.mjs';

export const config = { path: '/api/whatsapp' };

export default async function handler(req, context) {
  // 1) تأكيد الربط من لوحة ميتا
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (
      expected &&
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === expected
    ) {
      console.log('[نجح] تم تأكيد ربط الـ Webhook مع ميتا.');
      return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    console.log('[مرفوض] محاولة تأكيد Webhook بكلمة سر غير صحيحة (WHATSAPP_VERIFY_TOKEN).');
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!whatsappConfigured()) {
    console.error('[خطأ] متغيرات الواتساب ناقصة في Netlify — راجع WHATSAPP_SETUP_AR.md.');
    return new Response('Not configured', { status: 503 });
  }

  // 2) التحقق أن الطلب من ميتا فعلًا
  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('x-hub-signature-256')))) {
    console.log('[مرفوض] طلب بتوقيع غير صحيح — تأكد من WHATSAPP_APP_SECRET.');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // 3) تسليم كل رسالة للوظيفة الخلفية (ترد 202 فورًا وتكمل وحدها)
  const messages = extractMessages(payload);
  if (messages.length) {
    const base = process.env.URL || context?.site?.url || new URL(req.url).origin;
    const token = await internalToken('maknon-whatsapp-reply');
    await Promise.all(
      messages.map((m) =>
        fetch(new URL('/api/whatsapp-reply', base), {
          method: 'POST',
          headers: { 'x-internal-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
        }).catch((e) => console.error('[خطأ] تعذّر تسليم الرسالة للوظيفة الخلفية:', e?.message || e))
      )
    );
  }

  return new Response('OK', { status: 200 });
}
