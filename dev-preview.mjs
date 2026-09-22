/**
 * خادم معاينة محلي للواجهة فقط — للتجربة البصرية بدون مفاتيح.
 *
 * يخدم مجلد public ويحاكي /api/chat بإجابة تجريبية مبثوثة.
 * لا يستدعي OpenAI ولا Google إطلاقًا.
 *
 * التشغيل:   node dev-preview.mjs
 * ثم افتح:   http://localhost:8899
 *
 * للتجربة الحقيقية استخدم "netlify dev" بعد إنشاء ملف .env (انظر SETUP_AR.md).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = 8899;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DEMO = `**برامج جمعية مكنون** تشمل ما يلي:

1. **حلقات تحفيظ القرآن الكريم** للرجال والنساء في أحياء الرياض.
2. **الدورات الصيفية** المكثفة للطلاب والطالبات.
3. برنامج *الإجازة بالسند المتصل* لحفظة كتاب الله.

- أوقات الحلقات: بعد صلاة العصر وبعد صلاة المغرب.
- التسجيل متاح عبر الموقع الرسمي أو بالحضور إلى المقر.

للاستفسار يمكنك التواصل على الرقم 920011799.

_(هذه إجابة تجريبية من خادم المعاينة، وليست من ملفات الدرايف.)_`;

const APOLOGY =
  'عذرًا، لم أجد إجابة لهذا السؤال في المصادر المتاحة لدي. ' +
  'يمكنك التواصل مع الجمعية على الرقم الموحد 920011799.';

http
  .createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // محاكاة الخادم الخلفي
    if (url === '/api/chat' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;

      let question = '';
      try {
        const body = JSON.parse(raw);
        const last = body.messages?.[body.messages.length - 1];
        question = last?.content || '';
      } catch { /* تجاهل */ }

      // أسئلة خارج نطاق الملفات => رسالة الاعتذار
      const outOfScope = /طقس|حرارة|أخبار|رياضة|سعر|برمج|ترجم/.test(question);
      const text = outOfScope ? APOLOGY : DEMO;

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      for (const piece of text.split(/(\s+)/)) {
        res.write(JSON.stringify({ t: 'delta', v: piece }) + '\n');
        await new Promise((r) => setTimeout(r, 15));
      }
      res.write(JSON.stringify({ t: 'done' }) + '\n');
      res.end();
      return;
    }

    // محاكاة استقبال تقييمات Netlify Forms
    if (url === '/' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      console.log('[تقييم تجريبي]', decodeURIComponent(raw).slice(0, 160));
      res.writeHead(200).end('ok');
      return;
    }

    // الملفات الثابتة
    const file = path.join(PUB, url === '/' ? 'index.html' : url);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('غير موجود');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => {
    console.log('');
    console.log('  معاينة المساعد الذكي تعمل على:  http://localhost:' + PORT);
    console.log('  (إجابات تجريبية — بدون OpenAI وبدون Google Drive)');
    console.log('  للإيقاف: Ctrl + C');
    console.log('');
  });
