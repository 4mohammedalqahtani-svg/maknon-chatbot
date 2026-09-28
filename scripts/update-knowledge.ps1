# تحديث معرفة المساعد الذكي لجمعية مكنون
#
# يطلب من Netlify إعادة قراءة ملفات Google Drive ونشر نسخة محدّثة.
# استخدمه بعد كل تعديل أو إضافة أو حذف لملف في مجلد الدرايف.
#
# لا تشغّل هذا الملف مباشرة — اضغط مرتين على update-knowledge.bat

$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$hookFile = Join-Path $root 'build-hook.txt'

function Line { param($t = '') Write-Host $t }
function Head {
  Line ''
  Write-Host '  ========================================================' -ForegroundColor DarkCyan
  Write-Host '        تحديث معرفة المساعد الذكي — جمعية مكنون' -ForegroundColor Cyan
  Write-Host '  ========================================================' -ForegroundColor DarkCyan
  Line ''
}
function Pause-End {
  Line ''
  Write-Host '  اضغط أي مفتاح للإغلاق...' -ForegroundColor DarkGray
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
}

Head

# ---------- قراءة الرابط ----------
if (-not (Test-Path $hookFile)) {
  Write-Host '  [خطأ] لم يتم العثور على رابط التحديث.' -ForegroundColor Red
  Line ''
  Line '  الخطوات لإنشائه (مرة واحدة فقط):'
  Line ''
  Line '    1. افتح موقعك في Netlify ثم Site configuration'
  Line '    2. Build & deploy ثم انزل إلى Build hooks'
  Line '    3. اضغط Add build hook'
  Line '    4. الاسم: تحديث ملفات الدرايف   —   الفرع: main'
  Line '    5. اضغط Save وانسخ الرابط'
  Line '    6. الصق الرابط في ملف جديد باسم build-hook.txt هنا:'
  Write-Host "       $hookFile" -ForegroundColor Yellow
  Line ''
  Line '  التفاصيل كاملة في المرحلة 6 من ملف SETUP_AR.md'
  Pause-End
  exit 1
}

$hook = Get-Content $hookFile -Encoding UTF8 |
        Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') } |
        Select-Object -First 1

if ($hook) { $hook = $hook.Trim() }

if (-not $hook -or -not $hook.StartsWith('https://api.netlify.com/build_hooks/')) {
  Write-Host '  [خطأ] الرابط داخل build-hook.txt غير صحيح.' -ForegroundColor Red
  Line ''
  Line '  يجب أن يبدأ بـ:  https://api.netlify.com/build_hooks/'
  Pause-End
  exit 1
}

# ---------- إرسال الطلب ----------
Write-Host '  جارٍ إرسال طلب التحديث إلى Netlify ...' -ForegroundColor DarkGray
Line ''

try {
  $res = Invoke-WebRequest -Uri $hook -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
  $code = [int]$res.StatusCode
} catch {
  $code = 0
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
}

if ($code -eq 200 -or $code -eq 201) {
  Write-Host '  [نجح] تم إرسال طلب التحديث.' -ForegroundColor Green
  Line ''
  Line '  ماذا بعد؟'
  Line '    • النشر يستغرق من دقيقتين إلى خمس دقائق.'
  Line '    • تابعه من لوحة Netlify في قسم Deploys.'
  Write-Host '    • راجع سجل النشر وابحث عن: "إنذار خصوصية"' -ForegroundColor Yellow
  Line '    • بعد الانتهاء افتح الموقع واضغط Ctrl+Shift+R'
}
elseif ($code -eq 404) {
  Write-Host '  [خطأ] الرابط غير صحيح أو حُذف الـ Build Hook من Netlify.' -ForegroundColor Red
  Line '  أنشئ واحدًا جديدًا وحدّث ملف build-hook.txt'
}
elseif ($code -eq 0) {
  Write-Host '  [خطأ] تعذّر الاتصال بالإنترنت.' -ForegroundColor Red
  Line '  تأكد من اتصالك ثم أعد المحاولة.'
}
else {
  Write-Host "  [خطأ] فشل الإرسال. رمز الاستجابة: $code" -ForegroundColor Red
  Line '  راجع محتوى ملف build-hook.txt'
}

Pause-End
