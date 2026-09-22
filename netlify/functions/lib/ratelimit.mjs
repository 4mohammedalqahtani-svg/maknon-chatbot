// تحديد معدّل الاستخدام لكل زائر — حماية لرصيد OpenAI.
//
// الطبقة الأولى: ذاكرة مؤقتة داخل نسخة الوظيفة (سريعة جدًا، لكنها تُصفَّر عند إعادة التشغيل).
// الطبقة الثانية: Netlify Blobs — تخزين دائم مشترك بين كل النسخ (متاح في الخطة المجانية).
// إن لم تتوفر Blobs لأي سبب، نكتفي بالذاكرة ولا يتعطّل الموقع.

const memory = new Map();

let blobStorePromise = null;
async function getBlobStore() {
  if (blobStorePromise === null) {
    blobStorePromise = (async () => {
      try {
        const { getStore } = await import('@netlify/blobs');
        const store = getStore({ name: 'maknon-ratelimit', consistency: 'strong' });
        // اختبار بسيط للتأكد من عمل التخزين
        await store.get('__probe__');
        return store;
      } catch {
        return null; // غير متاح — نكمل بالذاكرة فقط
      }
    })();
  }
  return blobStorePromise;
}

/** مفتاح تعريف الزائر: نخزّن بصمة مشفّرة لعنوان IP وليس العنوان نفسه */
export async function visitorKey(ip, userAgent = '') {
  const data = new TextEncoder().encode(`maknon|${ip}|${userAgent.slice(0, 80)}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function windowIds(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60000);
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (بتوقيت UTC)
  return { minute, day };
}

function bumpMemory(key, minute, day) {
  let rec = memory.get(key);
  if (!rec || rec.minute !== minute || rec.day !== day) {
    const keepDay = rec && rec.day === day ? rec.dayCount : 0;
    rec = { minute, minuteCount: 0, day, dayCount: keepDay };
  }
  rec.minuteCount++;
  rec.dayCount++;
  memory.set(key, rec);

  // تنظيف دوري حتى لا تتضخم الذاكرة
  if (memory.size > 5000) {
    for (const [k, v] of memory) {
      if (v.minute < minute - 60) memory.delete(k);
      if (memory.size <= 2500) break;
    }
  }
  return rec;
}

/**
 * يسجّل محاولة ويعيد:
 *   { allowed, reason: 'minute' | 'day' | null, retryAfterSeconds }
 */
export async function checkRateLimit(key, { perMinute, perDay }) {
  const now = new Date();
  const { minute, day } = windowIds(now);

  const local = bumpMemory(key, minute, day);
  let minuteCount = local.minuteCount;
  let dayCount = local.dayCount;

  const store = await getBlobStore();
  if (store) {
    try {
      const raw = await store.get(key, { type: 'json' });
      const saved = raw && raw.day === day ? raw : { day, dayCount: 0, minute: 0, minuteCount: 0 };
      saved.dayCount = (saved.dayCount || 0) + 1;
      if (saved.minute === minute) saved.minuteCount = (saved.minuteCount || 0) + 1;
      else { saved.minute = minute; saved.minuteCount = 1; }

      await store.setJSON(key, saved);
      minuteCount = Math.max(minuteCount, saved.minuteCount);
      dayCount = Math.max(dayCount, saved.dayCount);
      // نُبقي الذاكرة متوافقة مع المخزن الدائم
      local.minuteCount = minuteCount;
      local.dayCount = dayCount;
    } catch {
      /* نتجاهل ونكتفي بالذاكرة */
    }
  }

  if (minuteCount > perMinute) {
    const secondsLeft = 60 - Math.floor((now.getTime() % 60000) / 1000);
    return { allowed: false, reason: 'minute', retryAfterSeconds: secondsLeft };
  }
  if (dayCount > perDay) {
    const endOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return { allowed: false, reason: 'day', retryAfterSeconds: Math.ceil((endOfDay - now.getTime()) / 1000) };
  }

  return { allowed: true, reason: null, retryAfterSeconds: 0, minuteCount, dayCount };
}
