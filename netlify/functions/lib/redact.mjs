// تنقية البيانات الشخصية من الإجابة (خط الدفاع الأخير).
// مشترك بين الموقع والواتساب.

// الرقم الموحد للجمعية رقم معلَن ولا يُحجب
const PUBLIC_NUMBERS = /^9200\d{5}$/;

const REDACTIONS = [
  // بريد إلكتروني
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, mask: '[بريد محجوب]' },
  // آيبان سعودي
  { re: /\bSA\d{22}\b/gi, mask: '[رقم حساب محجوب]' },
  // جوال سعودي بصيغه المختلفة
  { re: /(?:\+?966|00966)5\d{8}|(?<!\d)05\d{8}(?!\d)/g, mask: '[رقم محجوب]' },
  // هوية أو سجل مدني (10 أرقام تبدأ بـ 1 أو 2)
  { re: /(?<!\d)[12]\d{9}(?!\d)/g, mask: '[رقم محجوب]' },
];

/** يحجب أنماط البيانات الشخصية من نص */
export function redact(text) {
  let out = text;
  for (const { re, mask } of REDACTIONS) {
    out = out.replace(re, (m) => (PUBLIC_NUMBERS.test(m) ? m : mask));
  }
  return out;
}

/**
 * منقّي يعمل مع البثّ التدريجي.
 * يحتفظ بآخر جزء من النص حتى تكتمل الأنماط التي قد تنقسم بين دفعتين،
 * ولا يُخرج إلا حتى آخر مسافة بيضاء آمنة.
 */
export function createRedactingStreamer() {
  const HOLD = 64; // عدد الأحرف المحجوزة احتياطًا
  let buffer = '';

  return {
    push(delta) {
      buffer += delta;
      if (buffer.length <= HOLD) return '';
      // نبحث عن آخر مسافة بيضاء قبل المنطقة المحجوزة حتى لا نقطع نمطًا
      const limit = buffer.length - HOLD;
      const match = /\s(?=\S*$)/.exec(buffer.slice(0, limit));
      const cut = match ? match.index + 1 : buffer.slice(0, limit).lastIndexOf(' ') + 1;
      if (cut <= 0) return '';
      const ready = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return redact(ready);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return redact(rest);
    },
  };
}
