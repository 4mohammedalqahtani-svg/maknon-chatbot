// أدوات WhatsApp Cloud API الرسمية من ميتا: التحقق من التوقيع، الإرسال، والتنسيق.
//
// المتغيرات المطلوبة في Netlify (التفاصيل في WHATSAPP_SETUP_AR.md):
//   WHATSAPP_TOKEN            رمز الوصول الدائم (System User token)
//   WHATSAPP_PHONE_NUMBER_ID  معرّف رقم الجوال في ميتا — تغييره وحده ينقل المساعد لرقم آخر
//   WHATSAPP_APP_SECRET       "App secret" من إعدادات التطبيق — للتحقق أن الرسالة من ميتا فعلًا
//   WHATSAPP_VERIFY_TOKEN     كلمة سر تختارها أنت وتكتبها نفسها في إعداد الـ Webhook

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const MAX_MESSAGE_CHARS = 4000; // حد ميتا 4096 حرفًا للرسالة النصية

/** هل الإعدادات الأساسية موجودة؟ */
export function whatsappConfigured() {
  return Boolean(
    process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_APP_SECRET
  );
}

/** مقارنة بزمن ثابت */
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** يتحقق من الترويسة X-Hub-Signature-256 التي توقّع بها ميتا كل طلب */
export async function verifySignature(rawBody, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sameString(header.slice(7), hex);
}

/**
 * يستخرج الرسائل الواردة من جسم الـ Webhook.
 * يتجاهل إشعارات حالة الرسائل (وصلت/قُرئت) والرسائل الموجّهة لرقم آخر.
 */
export function extractMessages(payload) {
  const out = [];
  const ownNumber = process.env.WHATSAPP_PHONE_NUMBER_ID;
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      if (!value?.messages) continue;
      if (ownNumber && value.metadata?.phone_number_id !== ownNumber) continue;
      for (const m of value.messages) {
        out.push({
          id: m.id,
          from: m.from,
          type: m.type,
          text: m.type === 'text' ? m.text?.body || '' : '',
          timestamp: Number(m.timestamp || 0),
        });
      }
    }
  }
  return out;
}

/**
 * يحوّل تنسيق Markdown (كما يكتبه النموذج للموقع) إلى تنسيق الواتساب:
 * عريض *نص*، روابط مكتوبة صراحة، ونقاط بدل الشرطات.
 */
export function toWhatsAppText(markdown) {
  return markdown
    .replace(/^#{1,6}\s*(.+?)\s*#*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (label === url ? url : `${label}: ${url}`))
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** يقسم النص الطويل على حدود الفقرات حتى لا يتجاوز حد ميتا */
export function splitMessage(text, limit = MAX_MESSAGE_CHARS) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    // فقرة واحدة أطول من الحد: نقطعها قطعًا
    let rest = para;
    while (rest.length > limit) {
      parts.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }
  if (current) parts.push(current);
  return parts;
}

/** يرسل رسالة نصية (أو عدة رسائل إن طالت) إلى رقم واتساب */
export async function sendText(to, text) {
  const url = `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  for (const body of splitMessage(text)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body, preview_url: true },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`فشل الإرسال إلى واتساب (${res.status}): ${detail.slice(0, 300)}`);
    }
  }
}
