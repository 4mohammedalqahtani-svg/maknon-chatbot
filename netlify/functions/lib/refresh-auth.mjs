// رمز سري يحمي رابط التحديث من الاستدعاء العشوائي من الإنترنت.
//
// يُشتق من مفتاح موجود أصلًا في إعدادات Netlify، فلا يحتاج المسؤول
// إلى إنشاء متغير جديد. لا يعرفه إلا وظائف الموقع نفسه.

export async function refreshToken() {
  const secret = process.env.REFRESH_SECRET || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('maknon-refresh-knowledge'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** مقارنة بزمن ثابت حتى لا يُستنتج الرمز من سرعة الرد */
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
