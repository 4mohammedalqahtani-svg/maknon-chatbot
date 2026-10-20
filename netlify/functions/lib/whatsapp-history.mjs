// ذاكرة محادثات الواتساب — آخر الرسائل لكل رقم في Netlify Blobs.
//
// الخصوصية: المفتاح بصمة مشفّرة للرقم وليس الرقم نفسه، والمحادثة تُنسى
// بعد مرور EXPIRE_MS من آخر رسالة (نفس نافذة الـ 24 ساعة في واتساب).

const STORE_NAME = 'maknon-whatsapp';
const EXPIRE_MS = 24 * 60 * 60 * 1000;
const KEEP_MESSAGES = 6; // عدد الرسائل السابقة التي تُمرَّر كسياق
const KEEP_IDS = 30; // معرّفات الرسائل المعالَجة (ميتا قد تعيد إرسال نفس الرسالة)

async function getStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

/** بصمة الرقم: تُستخدم مفتاحًا للتخزين ولتحديد المعدّل */
export async function userKey(waId) {
  const data = new TextEncoder().encode(`maknon-wa|${waId}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyRecord() {
  return { updatedAt: 0, messages: [], seen: [] };
}

/** يقرأ سجل المستخدم (فارغ إن انتهت صلاحيته) */
export async function loadRecord(key) {
  try {
    const store = await getStore();
    const rec = await store.get(key, { type: 'json' });
    if (!rec) return emptyRecord();
    if (Date.now() - (rec.updatedAt || 0) > EXPIRE_MS) return { ...emptyRecord(), seen: rec.seen || [] };
    return { ...emptyRecord(), ...rec };
  } catch (e) {
    console.error('تعذّر قراءة سجل المحادثة:', e?.message || e);
    return emptyRecord();
  }
}

export async function saveRecord(key, rec) {
  try {
    const store = await getStore();
    await store.setJSON(key, {
      updatedAt: Date.now(),
      messages: rec.messages.slice(-KEEP_MESSAGES),
      seen: rec.seen.slice(-KEEP_IDS),
    });
  } catch (e) {
    console.error('تعذّر حفظ سجل المحادثة:', e?.message || e);
  }
}

export { KEEP_MESSAGES };
