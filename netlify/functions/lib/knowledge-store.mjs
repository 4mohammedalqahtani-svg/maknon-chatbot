// مكان حفظ معرفة المساعد بين التحديثات — Netlify Blobs.
//
// التحديث الليلي (refresh-knowledge.mjs) يقرأ الدرايف ويحفظ المعرفة هنا،
// فيستخدمها الشات فورًا بدون نشر جديد (النشر يستهلك رصيد Netlify).
//
// النسخة المضمَّنة وقت البناء (knowledge-data.mjs) تبقى احتياطًا:
// نستخدم الأحدث من النسختين حسب تاريخ البناء.

import { knowledge as bundled } from './knowledge-data.mjs';

const STORE_NAME = 'maknon-knowledge';
const KEY = 'current';
const RECHECK_MS = 60 * 1000; // كل كم نتحقق من وجود نسخة أحدث

let cached = null; // { knowledge, etag }
let lastCheck = 0;

async function getStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function newer(a, b) {
  return Date.parse(a?.builtAt || 0) > Date.parse(b?.builtAt || 0);
}

/** يحفظ معرفة جديدة بنتها المزامنة */
export async function saveKnowledge(payload) {
  const store = await getStore();
  await store.setJSON(KEY, payload, {
    metadata: { builtAt: payload.builtAt, mode: payload.mode, files: payload.stats?.files || 0 },
  });
}

/** يعيد تاريخ آخر معرفة محفوظة (أو null) */
export async function savedBuiltAt() {
  const store = await getStore();
  const meta = await store.getMetadata(KEY);
  return meta?.metadata?.builtAt || null;
}

/**
 * يعيد المعرفة الحالية: الأحدث بين المحفوظة في Blobs والمضمَّنة وقت البناء.
 * لا يتعطّل الشات إن تعذّر الوصول إلى Blobs؛ يكمل بآخر نسخة يعرفها.
 */
export async function getKnowledge() {
  const fallback = cached?.knowledge || bundled;
  if (Date.now() - lastCheck < RECHECK_MS) return fallback;
  lastCheck = Date.now();

  try {
    const store = await getStore();
    const meta = await store.getMetadata(KEY);
    if (!meta) return fallback;
    if (cached && meta.etag === cached.etag) return cached.knowledge;
    if (!newer(meta.metadata, bundled)) return bundled;

    const fresh = await store.getWithMetadata(KEY, { type: 'json' });
    if (fresh?.data) cached = { knowledge: fresh.data, etag: fresh.etag };
  } catch (e) {
    console.error('تعذّر قراءة المعرفة من Netlify Blobs:', e?.message || e);
  }
  return cached?.knowledge || bundled;
}
