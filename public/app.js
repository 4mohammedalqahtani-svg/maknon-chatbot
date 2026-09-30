/* ==========================================================================
   المساعد الذكي لجمعية مكنون — منطق الواجهة
   ========================================================================== */
(function () {
  'use strict';

  var GREETING = 'السلام عليكم ورحمة الله وبركاته، أهلًا بك في المساعد الذكي لجمعية مكنون. كيف أستطيع مساعدتك اليوم؟';
  var MAX_CHARS = 600;
  var HISTORY_LIMIT = 6; // عدد الرسائل التي تُمرَّر كسياق للنموذج

  var $ = function (id) { return document.getElementById(id); };
  var messagesEl = $('messages');
  var formEl = $('chatForm');
  var inputEl = $('input');
  var sendBtn = $('sendBtn');
  var toastEl = $('toast');
  var charCountEl = $('charCount');

  var history = [];   // [{ role: 'user' | 'assistant', content: '...' }]
  var isBusy = false;

  /* ---------------- أيقونات SVG ---------------- */

  var ICONS = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14.2 9.8 21.5 12l-7.3 2.2L12 21.5 9.8 14.2 2.5 12l7.3-2.2z"/></svg>',
    markBadge: '<span class="greeting-badge"><img class="greeting-logo" src="/assets/mark.png" alt="شعار جمعية مكنون" width="306" height="240" /></span>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5 9 17.5 20 6.5"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21V10l4.5-8a2 2 0 0 1 2.9 2.2L13.5 9H19a2 2 0 0 1 2 2.4l-1.6 8A2 2 0 0 1 17.4 21z"/><path d="M7 10H4v11h3z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3v11l-4.5 8a2 2 0 0 1-2.9-2.2L10.5 15H5a2 2 0 0 1-2-2.4l1.6-8A2 2 0 0 1 6.6 3z"/><path d="M17 14h3V3h-3z"/></svg>'
  };

  /* ---------------- عرض Markdown بأمان ---------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // نعرض تنسيقًا محدودًا وآمنًا: عناوين، قوائم، عريض، مائل، كود، فواصل.
  function renderMarkdown(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    var html = '';
    var listType = null;

    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    function inline(s) {
      var out = escapeHtml(s);
      out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
      // روابط ماركداون + أرقام الهاتف
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      out = out.replace(/(^|[^\d>])(9200\d{5})(?!\d)/g,
        '$1<a href="tel:$2" dir="ltr">$2</a>');
      return out;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) { closeList(); continue; }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); html += '<hr>'; continue; }

      var h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += '<h4>' + inline(h[2]) + '</h4>'; continue; }

      var ul = trimmed.match(/^[-*•]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += '<li>' + inline(ul[1]) + '</li>';
        continue;
      }

      var ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += '<li>' + inline(ol[2]) + '</li>';
        continue;
      }

      closeList();
      html += '<p>' + inline(trimmed) + '</p>';
    }

    closeList();
    return html;
  }

  /* ---------------- عناصر الواجهة ---------------- */

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  function renderGreeting() {
    var box = document.createElement('div');
    box.className = 'greeting';
    box.innerHTML =
      ICONS.markBadge +
      '<h2 class="greeting-title">' + escapeHtml(GREETING) + '</h2>' +
      '<p class="greeting-sub">اسألني عن برامج الجمعية وخدماتها وشروط التسجيل وأوقات الحلقات.</p>';
    messagesEl.appendChild(box);
  }

  function addRow(kind) {
    var row = document.createElement('div');
    row.className = 'msg-row ' + kind;

    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = kind === 'user' ? ICONS.user : ICONS.star;

    var wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);

    row.appendChild(avatar);
    row.appendChild(wrap);
    messagesEl.appendChild(row);

    return { row: row, wrap: wrap, bubble: bubble };
  }

  function addUserMessage(text) {
    var el = addRow('user');
    el.bubble.textContent = text;
    scrollToBottom();
  }

  function addTypingRow() {
    var el = addRow('bot');
    el.bubble.innerHTML = '<div class="typing" aria-label="جارٍ كتابة الإجابة"><span></span><span></span><span></span></div>';
    scrollToBottom();
    return el;
  }

  function addErrorMessage(text) {
    var el = addRow('bot');
    el.bubble.classList.add('error');
    el.bubble.textContent = text;
    scrollToBottom();
  }

  /* ---------------- أزرار النسخ والتقييم ---------------- */

  function buildActions(wrap, question, answer) {
    var bar = document.createElement('div');
    bar.className = 'msg-actions';

    // نسخ
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'action-btn';
    copyBtn.innerHTML = ICONS.copy + '<span>نسخ</span>';
    copyBtn.addEventListener('click', function () {
      copyText(answer).then(function (okDone) {
        if (!okDone) { showToast('تعذّر النسخ، يمكنك تحديد النص يدويًا.'); return; }
        copyBtn.innerHTML = ICONS.check + '<span>تم النسخ</span>';
        copyBtn.classList.add('is-active');
        showToast('تم النسخ');
        setTimeout(function () {
          copyBtn.innerHTML = ICONS.copy + '<span>نسخ</span>';
          copyBtn.classList.remove('is-active');
        }, 2000);
      });
    });

    // تقييم
    var upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'action-btn';
    upBtn.setAttribute('aria-label', 'إجابة مفيدة');
    upBtn.innerHTML = ICONS.up + '<span>مفيدة</span>';

    var downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'action-btn';
    downBtn.setAttribute('aria-label', 'إجابة غير مفيدة');
    downBtn.innerHTML = ICONS.down + '<span>غير مفيدة</span>';

    function rate(value, btn) {
      upBtn.disabled = true;
      downBtn.disabled = true;
      btn.classList.add('is-active');
      btn.disabled = false;
      sendFeedback(value, question, answer);
      showToast('شكرًا لتقييمك');
    }

    upBtn.addEventListener('click', function () { rate('مفيدة', upBtn); });
    downBtn.addEventListener('click', function () { rate('غير مفيدة', downBtn); });

    bar.appendChild(copyBtn);
    bar.appendChild(upBtn);
    bar.appendChild(downBtn);
    wrap.appendChild(bar);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var done = document.execCommand('copy');
      document.body.removeChild(ta);
      return done;
    } catch (e) {
      return false;
    }
  }

  // إرسال التقييم إلى Netlify Forms (يظهر في لوحة Netlify ضمن Forms)
  function sendFeedback(rating, question, answer) {
    var data = new URLSearchParams();
    data.append('form-name', 'feedback');
    data.append('rating', rating);
    data.append('question', question.slice(0, 1000));
    data.append('answer', answer.slice(0, 4000));
    data.append('page', location.pathname);

    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: data.toString()
    }).catch(function () { /* لا نزعج المستخدم إذا فشل الإرسال */ });
  }

  /* ---------------- إرسال السؤال والبثّ ---------------- */

  function setBusy(busy) {
    isBusy = busy;
    sendBtn.disabled = busy;
    inputEl.disabled = busy;
    if (!busy) inputEl.focus();
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
    var left = MAX_CHARS - inputEl.value.length;
    if (left <= 80) {
      charCountEl.textContent = '(' + left + ' حرفًا متبقيًا)';
      charCountEl.classList.toggle('warn', left <= 20);
    } else {
      charCountEl.textContent = '';
      charCountEl.classList.remove('warn');
    }
  }

  /**
   * يحذف جملة "عذرًا، لم أجد إجابة..." إذا جاءت مع إجابة فعلية.
   * إن كانت الجملة هي كل الرد، يبقى الرد كما هو.
   */
  function stripTrailingApology(text) {
    var re = /\s*عذرًا،?\s*لم أجد إجابة لهذا السؤال[^\n]*?(?:920011799\.?)?\s*$/;
    var m = text.match(re);
    if (!m) return text;
    var rest = text.slice(0, m.index).trim();
    // نحذفها فقط إن بقي قبلها محتوى حقيقي
    return rest.replace(/[\s*_\-•]+/g, '').length > 20 ? rest : text;
  }

  async function ask(question) {
    addUserMessage(question);
    history.push({ role: 'user', content: question });

    var typing = addTypingRow();
    setBusy(true);

    var answer = '';
    var finished = false;

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-HISTORY_LIMIT) })
      });

      if (!res.ok) {
        var msg = 'تعذّر الحصول على إجابة. يرجى المحاولة مرة أخرى.';
        try {
          var errJson = await res.json();
          if (errJson && errJson.error) msg = errJson.error;
        } catch (e) { /* تجاهل */ }
        typing.row.remove();
        addErrorMessage(msg);
        history.pop();
        return;
      }

      if (!res.body) throw new Error('no-stream');

      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      var started = false;
      var streamError = null;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var parts = buffer.split('\n');
        buffer = parts.pop();

        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line) continue;
          var evt;
          try { evt = JSON.parse(line); } catch (e) { continue; }

          if (evt.t === 'delta') {
            if (!started) { typing.bubble.innerHTML = ''; started = true; }
            answer += evt.v;
            typing.bubble.innerHTML = renderMarkdown(answer) + '<span class="caret"></span>';
            scrollToBottom();
          } else if (evt.t === 'error') {
            streamError = evt.v;
          } else if (evt.t === 'done') {
            finished = true;
          }
        }
      }

      if (streamError && !answer) {
        typing.row.remove();
        addErrorMessage(streamError);
        history.pop();
        return;
      }

      if (!answer) {
        typing.row.remove();
        addErrorMessage('لم تصل إجابة. يرجى المحاولة مرة أخرى.');
        history.pop();
        return;
      }

      // حماية احتياطية: إن أضاف النموذج جملة الاعتذار بعد إجابة فعلية، نحذفها
      answer = stripTrailingApology(answer);

      // إنهاء الفقاعة
      typing.bubble.innerHTML = renderMarkdown(answer);
      if (/لم أجد إجابة لهذا السؤال/.test(answer)) {
        typing.bubble.classList.add('apology');
      }
      if (streamError) {
        var note = document.createElement('p');
        note.textContent = streamError;
        note.style.color = 'var(--error-text)';
        typing.bubble.appendChild(note);
      }

      history.push({ role: 'assistant', content: answer });
      buildActions(typing.wrap, question, answer);
      scrollToBottom();

    } catch (e) {
      typing.row.remove();
      addErrorMessage('تعذّر الاتصال بالخدمة. تأكد من اتصالك بالإنترنت ثم حاول مرة أخرى.');
      if (history[history.length - 1] && history[history.length - 1].role === 'user') history.pop();
    } finally {
      setBusy(false);
      if (!finished) scrollToBottom();
    }
  }

  /* ---------------- محادثة جديدة ---------------- */

  function newChat() {
    history = [];
    messagesEl.innerHTML = '';
    renderGreeting();
    inputEl.value = '';
    autoGrow();
    inputEl.focus();
    showToast('تم بدء محادثة جديدة');
  }

  /* ---------------- الوضع الليلي ---------------- */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var btn = $('themeToggle');
    var label = theme === 'dark' ? 'التبديل إلى الوضع النهاري' : 'التبديل إلى الوضع الليلي';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function initTheme() {
    applyTheme(currentTheme());

    $('themeToggle').addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('maknon-theme', next); } catch (e) { /* تجاهل */ }
      showToast(next === 'dark' ? 'تم تفعيل الوضع الليلي' : 'تم تفعيل الوضع النهاري');
    });

    // تتبّع إعداد الجهاز ما لم يختر المستخدم وضعًا بنفسه
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem('maknon-theme'); } catch (err) { /* تجاهل */ }
        if (!saved) applyTheme(e.matches ? 'dark' : 'light');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------------- التهيئة ---------------- */

  function init() {
    initTheme();
    renderGreeting();

    formEl.addEventListener('submit', function (e) {
      e.preventDefault();
      if (isBusy) return;
      var text = inputEl.value.trim();
      if (!text) return;
      if (text.length > MAX_CHARS) {
        showToast('سؤالك طويل جدًا. الحد الأقصى ' + MAX_CHARS + ' حرفًا.');
        return;
      }
      inputEl.value = '';
      autoGrow();
      ask(text);
    });

    inputEl.addEventListener('input', autoGrow);

    inputEl.addEventListener('keydown', function (e) {
      // Enter يرسل، و Shift+Enter ينزل سطرًا
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        formEl.requestSubmit ? formEl.requestSubmit() : formEl.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    var sideBtn = $('newChatBtnSide');
    var mobileBtn = $('newChatBtnMobile');
    if (sideBtn) sideBtn.addEventListener('click', newChat);
    if (mobileBtn) mobileBtn.addEventListener('click', newChat);

    autoGrow();
    inputEl.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
