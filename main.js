'use strict';
const { Plugin, ItemView, PluginSettingTab, Setting, Notice } = require('obsidian');

// ═══════════════════════════════════════════════════════════
//  ثوابت
// ═══════════════════════════════════════════════════════════
const VIEW_TYPE_OMNI = 'omni-note-view';
const DATA_DIR       = 'OmniNote-Data';

const MONTHS  = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                 'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const DAYS_S  = ['أح','اث','ثل','أر','خم','جم','سب'];
const DAYS_F  = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

const DEFAULT_SETTINGS = {
    workDuration   : 25,
    shortBreak     : 5,
    quoteInterval  : 30,
    quoteFontSize  : 16,
    quotes         : [
        { text: 'إن العلم في الصغر كالنقش في الحجر.', author: 'مثل عربي' },
        { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
        { text: "Life is what happens when you're busy making other plans.", author: 'John Lennon' },
    ],
    stickyNotes    : {},   // { "YYYY-MM-DD": "نص" }
    calendarTasks  : {},   // { "YYYY-MM-DD": [{id,text,time,notifsSent}] }
    progressTasks  : [],   // [{id,name,total,unit,done,completed,createdAt}]
    pomodoroLog    : [],   // [{date,note,duration,type}]
};

// ═══════════════════════════════════════════════════════════
//  مساعدات
// ═══════════════════════════════════════════════════════════
const uid     = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad     = n  => String(n).padStart(2, '0');
const fmtDate = d  => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtTime = s  => `${pad(Math.max(0, Math.floor(s/60)))}:${pad(Math.max(0, s%60))}`;
const escapeHTML = str => String(str).replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag));

function sendNotif(title, body) {
    try {
        new Notice(`${title} — ${body}`, 8000);
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') {
            new Notification(title, { body, silent: false });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') new Notification(title, { body });
            });
        }
    } catch(_) {}
}

function parseCSV(raw) {
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
        const cols = [];
        let cur = '', inQ = false;
        for (const ch of line) {
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
            else cur += ch;
        }
        cols.push(cur.trim());
        const text   = (cols[0] || '').replace(/^"|"$/g, '').trim();
        const author = (cols[1] || 'مجهول').replace(/^"|"$/g, '').trim();
        if (text) results.push({ text, author });
    }
    return results;
}

// ═══════════════════════════════════════════════════════════
//  العرض الرئيسي
// ═══════════════════════════════════════════════════════════
class OmniNoteView extends ItemView {

    constructor(leaf, plugin) {
        super(leaf);
        this.plugin    = plugin;
        this.S         = plugin.settings;
        this.timeRem   = this.S.workDuration * 60;
        this.timerInt  = null;
        this.isBreak   = false;
        this.sessions  = 0;
        this.viewDate  = new Date();
        this.selDate   = null;
        this.quoteIdx  = Math.floor(Math.random() * Math.max(this.S.quotes.length, 1));
        this._activeNote = null;
    }

    getViewType()    { return VIEW_TYPE_OMNI; }
    getDisplayText() { return 'OmniNote'; }
    getIcon()        { return 'calendar-clock'; }

    async onOpen() {
        const root = this.containerEl.children[1];
        root.empty();
        root.setAttribute('dir', 'rtl');
        root.classList.add('omni-root');
        this.root = root;
        this._build();
    }

    _build() {
        this.root.innerHTML = '';
        const wrap = this.root.createDiv('omni-wrap');
        this._buildQuote(wrap);
        this._buildPomo(wrap);
        this._buildCalendar(wrap);
        this._buildProgress(wrap);
    }

    // ─────────────────────────────────────────
    //  بطاقة الحكمة
    // ─────────────────────────────────────────
    _buildQuote(wrap) {
        const card = wrap.createDiv('omni-card omni-quote-card');
        const q = this.S.quotes[this.quoteIdx % Math.max(this.S.quotes.length, 1)]
                  || { text: '...', author: '' };

        card.innerHTML = `
<div class="omni-card-hd">
  <span class="omni-card-ico">💡</span>
  <span class="omni-card-ttl">حكمة اليوم</span>
  <button class="omni-ghost-btn" id="oq-import" title="استيراد CSV">📥</button>
  <button class="omni-ghost-btn" id="oq-next"   title="حكمة أخرى">↻</button>
  <input type="file" id="oq-file" accept=".csv" style="display:none">
</div>
<p class="omni-q-text"   id="oq-text" style="font-size: ${this.S.quoteFontSize || 16}px">"${escapeHTML(q.text)}"</p>
<p class="omni-q-author" id="oq-author" style="font-size: ${(this.S.quoteFontSize || 16) * 0.8}px">— ${escapeHTML(q.author)}</p>
<div style="text-align: left; margin-top: 5px;">
  <button class="omni-ghost-btn" id="oq-font-inc" title="تكبير الخط" style="padding: 0 5px; font-size: 1.1em;">+</button>
  <button class="omni-ghost-btn" id="oq-font-dec" title="تصغير الخط" style="padding: 0 5px; font-size: 1.1em;">−</button>
</div>`;

        const updateFont = async (d) => {
            this.S.quoteFontSize = Math.max(10, Math.min(48, (this.S.quoteFontSize || 16) + d));
            card.querySelector('#oq-text').style.fontSize = `${this.S.quoteFontSize}px`;
            card.querySelector('#oq-author').style.fontSize = `${this.S.quoteFontSize * 0.8}px`;
            await this.plugin.saveSettings();
        };

        card.querySelector('#oq-font-inc').onclick = () => updateFont(1);
        card.querySelector('#oq-font-dec').onclick = () => updateFont(-1);

        card.querySelector('#oq-next').onclick = () => {
            this.quoteIdx = (this.quoteIdx + 1) % Math.max(this.S.quotes.length, 1);
            const nq = this.S.quotes[this.quoteIdx] || { text: '...', author: '' };
            card.querySelector('#oq-text').textContent   = `"${nq.text}"`; // textContent escapes naturally
            card.querySelector('#oq-author').textContent = `— ${nq.author}`;
        };

        const fileInp = card.querySelector('#oq-file');
        card.querySelector('#oq-import').onclick = () => fileInp.click();

        fileInp.onchange = async e => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text   = await file.text();
                const parsed = parseCSV(text);
                if (!parsed.length) { new Notice('⚠️ لم يُعثر على حكم في الملف'); return; }
                // إضافة الحكم الجديدة إلى القائمة الحالية بدلاً من استبدالها
                this.S.quotes = [...this.S.quotes, ...parsed];
                await this.plugin.saveSettings();
                const nq = parsed[0]; // عرض أول حكمة من الملف المستورد حديثاً
                card.querySelector('#oq-text').textContent   = `"${nq.text}"`;
                card.querySelector('#oq-author').textContent = `— ${nq.author}`;
                new Notice(`✅ تم استيراد ${parsed.length} حكمة`);
            } catch (_) { new Notice('⚠️ خطأ في قراءة الملف'); }
            fileInp.value = '';
        };
    }

    // ─────────────────────────────────────────
    //  بطاقة البومودورو
    // ─────────────────────────────────────────
    _buildPomo(wrap) {
        const card = wrap.createDiv('omni-card omni-pomo-card');
        card.innerHTML = `
<div class="omni-card-hd">
  <span class="omni-card-ico">⏱️</span>
  <span class="omni-card-ttl">بومودورو</span>
  <span class="omni-mode-badge" id="op-badge">عمل</span>
</div>
<div class="omni-timer" id="op-timer">${fmtTime(this.timeRem)}</div>
<div class="omni-pomo-btns">
  <button class="omni-btn omni-btn-accent" id="op-start">▶ ابدأ</button>
  <button class="omni-btn omni-btn-muted"  id="op-pause">⏸ توقف</button>
  <button class="omni-btn omni-btn-ghost"  id="op-reset">↺ إعادة</button>
  <button class="omni-btn omni-btn-ghost"  id="op-skip">⏭ تخطي</button>
</div>
<div class="omni-dur-row">
  <div class="omni-dur-lbl">
    <span>عمل</span>
    <div class="omni-stepper">
      <button class="omni-step-btn" id="op-wd">−</button>
      <input  class="omni-dur-inp" type="number" id="op-wi"
              value="${this.S.workDuration}" min="1" max="120">
      <button class="omni-step-btn" id="op-wi2">+</button>
    </div>
    <span>دقيقة</span>
  </div>
  <div class="omni-dur-lbl">
    <span>استراحة</span>
    <div class="omni-stepper">
      <button class="omni-step-btn" id="op-bd">−</button>
      <input  class="omni-dur-inp" type="number" id="op-bi"
              value="${this.S.shortBreak}" min="1" max="60">
      <button class="omni-step-btn" id="op-bi2">+</button>
    </div>
    <span>دقيقة</span>
  </div>
</div>
<div class="omni-sessions-row">🔥 جلسات مكتملة: <strong id="op-sessions">0</strong></div>
<div class="omni-note-row" id="op-note-row" style="display:none">
  📝 جلسة على: <span id="op-note-name" class="omni-note-chip"></span>
</div>`;

        const disp   = card.querySelector('#op-timer');
        const badge  = card.querySelector('#op-badge');
        const sessEl = card.querySelector('#op-sessions');
        const noteRow= card.querySelector('#op-note-row');
        const noteNm = card.querySelector('#op-note-name');

        const upd = () => { disp.textContent = fmtTime(this.timeRem); };

        // ── steppers ──
        const clampWork = v => Math.max(1, Math.min(120, v));
        const clampBrk  = v => Math.max(1, Math.min(60,  v));

        const stepW = async d => {
            this.S.workDuration = clampWork(this.S.workDuration + d);
            card.querySelector('#op-wi').value = this.S.workDuration;
            await this.plugin.saveSettings();
            if (!this.timerInt && !this.isBreak) { this.timeRem = this.S.workDuration*60; upd(); }
        };
        const stepB = async d => {
            this.S.shortBreak = clampBrk(this.S.shortBreak + d);
            card.querySelector('#op-bi').value = this.S.shortBreak;
            await this.plugin.saveSettings();
        };

        card.querySelector('#op-wd').onclick  = () => stepW(-1);
        card.querySelector('#op-wi2').onclick = () => stepW(+1);
        card.querySelector('#op-bd').onclick  = () => stepB(-1);
        card.querySelector('#op-bi2').onclick = () => stepB(+1);

        card.querySelector('#op-wi').oninput = async e => {
            this.S.workDuration = clampWork(parseInt(e.target.value) || 25);
            await this.plugin.saveSettings();
            if (!this.timerInt && !this.isBreak) { this.timeRem = this.S.workDuration*60; upd(); }
        };
        card.querySelector('#op-bi').oninput = async e => {
            this.S.shortBreak = clampBrk(parseInt(e.target.value) || 5);
            await this.plugin.saveSettings();
        };

        // ── controls ──
        const completeSession = async () => {
            if (this.timerInt) { clearInterval(this.timerInt); this.timerInt = null; }
            if (!this.isBreak) {
                this.sessions++;
                sessEl.textContent = this.sessions;
                await this.plugin.logPomodoro({
                    date: fmtDate(new Date()),
                    note: this._activeNote || '—',
                    duration: this.S.workDuration,
                    type: 'work',
                });
                this.isBreak = true;
                this.timeRem = this.S.shortBreak * 60;
                badge.textContent = 'استراحة';
                badge.classList.add('omni-break');
                sendNotif('OmniNote ⏱️',
                    `انتهت جلسة العمل على "${this._activeNote || 'الملاحظة'}"! استرح الآن 🎉`);
            } else {
                this.isBreak = false;
                this.timeRem = this.S.workDuration * 60;
                badge.textContent = 'عمل';
                badge.classList.remove('omni-break');
                noteRow.style.display = 'none';
                sendNotif('OmniNote ⏱️', 'انتهت الاستراحة! وقت العمل 💪');
            }
            upd();
        };

        card.querySelector('#op-start').onclick = () => {
            if (this.timerInt) return;
            const active = this.app.workspace.getActiveFile();
            this._activeNote = active?.basename || null;
            if (this._activeNote) { noteNm.textContent = this._activeNote; noteRow.style.display = 'flex'; }

            const endTime = Date.now() + (this.timeRem * 1000);
            this.timerInt = setInterval(async () => {
                this.timeRem = Math.ceil((endTime - Date.now()) / 1000);
                if (this.timeRem > 0) { upd(); return; }
                this.timeRem = 0; upd();
                await completeSession();
            }, 1000);
            this.plugin.registerInterval(this.timerInt);
        };

        card.querySelector('#op-pause').onclick = () => {
            clearInterval(this.timerInt); this.timerInt = null;
        };
        card.querySelector('#op-skip').onclick = async () => {
            await completeSession();
        };
        card.querySelector('#op-reset').onclick = () => {
            clearInterval(this.timerInt); this.timerInt = null;
            this.isBreak = false;
            this.timeRem = this.S.workDuration * 60;
            badge.textContent = 'عمل'; badge.classList.remove('omni-break');
            noteRow.style.display = 'none';
            upd();
        };
    }

    // ─────────────────────────────────────────
    //  بطاقة التقويم
    // ─────────────────────────────────────────
    _buildCalendar(wrap) {
        const card = wrap.createDiv('omni-card omni-cal-card');
        card.innerHTML = `
<div class="omni-card-hd">
  <span class="omni-card-ico">📅</span>
  <span class="omni-card-ttl">التقويم</span>
</div>
<div class="omni-cal-nav">
  <button class="omni-ghost-btn" id="oc-prev">‹</button>
  <span class="omni-month-lbl" id="oc-lbl"></span>
  <button class="omni-ghost-btn" id="oc-next">›</button>
</div>
<div class="omni-cal-grid" id="oc-grid"></div>

<!-- لوحة ملاحظة اليوم -->
<div class="omni-sticky-panel" id="oc-panel" style="display:none">
  <div class="omni-sticky-hd">
    <span class="omni-sticky-date" id="oc-date-lbl"></span>
    <div style="display: flex; gap: 4px; align-items: center;">
      <button class="omni-ghost-btn omni-del-day-btn" id="oc-del-day" title="حذف الملاحظة">🗑</button>
      <button class="omni-ghost-btn" id="oc-close" title="إغلاق">✕</button>
    </div>
  </div>
  <textarea class="omni-sticky-ta" id="oc-note-ta" placeholder="ملاحظة حرة..."></textarea>
  <div class="omni-task-list" id="oc-task-list"></div>
  <div class="omni-task-add-row">
    <input type="text"  class="omni-field omni-task-inp" id="oc-task-txt" placeholder="أضف مهمة...">
    <input type="time"  class="omni-field omni-time-inp" id="oc-task-time" value="09:00">
    <button class="omni-btn omni-btn-accent omni-add-task-btn" id="oc-task-add">+</button>
  </div>
  <button class="omni-btn omni-btn-accent omni-sticky-save-btn" id="oc-save">💾 حفظ</button>
</div>`;

        card.querySelector('#oc-prev').onclick = () => {
            this.viewDate.setMonth(this.viewDate.getMonth() - 1);
            this._drawGrid(card);
        };
        card.querySelector('#oc-next').onclick = () => {
            this.viewDate.setMonth(this.viewDate.getMonth() + 1);
            this._drawGrid(card);
        };
        card.querySelector('#oc-close').onclick = () => {
            card.querySelector('#oc-panel').style.display = 'none';
            this.selDate = null; this._drawGrid(card);
        };
        card.querySelector('#oc-del-day').onclick = async () => {
            if (!this.selDate) return;
            if (this.S.stickyNotes[this.selDate]) {
                delete this.S.stickyNotes[this.selDate];
                await this.plugin.saveSettings();
                card.querySelector('#oc-note-ta').value = '';
                new Notice('تم مسح ملاحظة التقويم 🗑');
                this._drawGrid(card); // لتحديث النقطة في التقويم إن لزم الأمر
            }
        };
        card.querySelector('#oc-save').onclick = async () => {
            if (!this.selDate) return;
            const txt = card.querySelector('#oc-note-ta').value.trim();
            if (txt) this.S.stickyNotes[this.selDate] = txt;
            else     delete this.S.stickyNotes[this.selDate];
            await this.plugin.saveSettings();
            new Notice('تم الحفظ ✓');
        };
        card.querySelector('#oc-task-add').onclick   = () => this._addTask(card);
        card.querySelector('#oc-task-txt').onkeypress = e => { if (e.key==='Enter') this._addTask(card); };

        this._drawGrid(card);
    }

    _drawGrid(card) {
        const grid    = card.querySelector('#oc-grid');
        const lbl     = card.querySelector('#oc-lbl');
        const yr = this.viewDate.getFullYear(), mo = this.viewDate.getMonth();
        const today   = fmtDate(new Date());

        lbl.textContent = `${MONTHS[mo]} ${yr}`;
        grid.innerHTML  = '';

        // رؤوس الأيام
        DAYS_S.forEach(d => { const h = grid.createDiv('omni-dn'); h.textContent = d; });

        // خلايا فارغة قبل اليوم الأول
        const firstDow = new Date(yr, mo, 1).getDay();
        for (let i = 0; i < firstDow; i++) grid.createDiv('omni-dc omni-dc-empty');

        // خلايا الأيام
        const total = new Date(yr, mo+1, 0).getDate();
        for (let d = 1; d <= total; d++) {
            const ds  = `${yr}-${pad(mo+1)}-${pad(d)}`;
            const el  = grid.createDiv('omni-dc');
            if (ds === today)       el.classList.add('omni-today');
            if (ds === this.selDate) el.classList.add('omni-selected');
            const hasNote  = !!this.S.stickyNotes[ds];
            const taskCnt  = (this.S.calendarTasks[ds] || []).length;
            if (hasNote || taskCnt) el.classList.add('omni-has-note');

            const num = el.createSpan('omni-dc-num');
            num.textContent = d;

            if (taskCnt) {
                const badge = el.createSpan('omni-task-badge');
                badge.textContent = taskCnt;
            }
            el.onclick = () => this._openDay(card, ds);
        }
    }

    _openDay(card, ds) {
        this.selDate = ds;
        const [yr,mo,dy] = ds.split('-').map(Number);
        const dow = new Date(yr, mo-1, dy).getDay();
        card.querySelector('#oc-date-lbl').textContent =
            `${DAYS_F[dow]}، ${dy} ${MONTHS[mo-1]} ${yr}`;
        card.querySelector('#oc-note-ta').value =
            this.S.stickyNotes[ds] || '';
        card.querySelector('#oc-panel').style.display = 'flex';
        this._drawTaskList(card, ds);
        this._drawGrid(card);
        card.querySelector('#oc-task-txt').focus();
    }

    _drawTaskList(card, ds) {
        const list  = card.querySelector('#oc-task-list');
        list.innerHTML = '';
        const tasks = this.S.calendarTasks[ds] || [];
        if (!tasks.length) return;
        tasks.forEach(t => {
            const row = list.createDiv('omni-ctask-row');
            row.innerHTML = `
<span class="omni-ctask-time">${escapeHTML(t.time || '')}</span>
<span class="omni-ctask-text">${escapeHTML(t.text)}</span>
<button class="omni-ghost-btn omni-ctask-del" data-id="${t.id}" title="حذف">🗑</button>`;
            row.querySelector('.omni-ctask-del').onclick = async () => {
                this.S.calendarTasks[ds] =
                    (this.S.calendarTasks[ds] || []).filter(x => x.id !== t.id);
                if (!this.S.calendarTasks[ds].length) delete this.S.calendarTasks[ds];
                await this.plugin.saveSettings();
                this._drawTaskList(card, ds);
                this._drawGrid(card);
            };
        });
    }

    async _addTask(card) {
        const txtEl  = card.querySelector('#oc-task-txt');
        const timeEl = card.querySelector('#oc-task-time');
        const text   = txtEl.value.trim();
        if (!text || !this.selDate) return;
        if (!this.S.calendarTasks[this.selDate]) this.S.calendarTasks[this.selDate] = [];
        this.S.calendarTasks[this.selDate].push({
            id: uid(), text, time: timeEl.value || '09:00', notifsSent: {}
        });
        txtEl.value = '';
        await this.plugin.saveSettings();
        this._drawTaskList(card, this.selDate);
        this._drawGrid(card);
    }

    // ─────────────────────────────────────────
    //  بطاقة متابعة الإنجاز
    // ─────────────────────────────────────────
    _buildProgress(wrap) {
        const card = wrap.createDiv('omni-card omni-prog-card');
        card.innerHTML = `
<div class="omni-card-hd">
  <span class="omni-card-ico">📊</span>
  <span class="omni-card-ttl">متابعة الإنجاز</span>
  <button class="omni-ghost-btn" id="opr-add-btn" title="إضافة مهمة">+</button>
</div>

<!-- نموذج الإضافة — يظهر عند الطلب فقط -->
<div class="omni-prog-form" id="opr-form" style="display:none">
  <input type="text"   class="omni-field" id="opr-name"  placeholder="اسم المهمة">
  <div class="omni-prog-form-row">
    <input type="number" class="omni-field omni-field-sm" id="opr-total"
           placeholder="الوحدات" min="1" value="">
    <input type="text"   class="omni-field omni-field-sm" id="opr-unit"
           placeholder="وحدة">
  </div>
  <div class="omni-prog-form-btns">
    <button class="omni-btn omni-btn-accent" id="opr-submit">إضافة ✓</button>
    <button class="omni-btn omni-btn-ghost"  id="opr-cancel">إلغاء</button>
  </div>
</div>

<!-- قائمة المهام -->
<div class="omni-prog-list" id="opr-list"></div>`;

        card.querySelector('#opr-add-btn').onclick = () => {
            const f = card.querySelector('#opr-form');
            f.style.display = f.style.display === 'none' ? 'flex' : 'none';
            if (f.style.display === 'flex') card.querySelector('#opr-name').focus();
        };
        card.querySelector('#opr-cancel').onclick = () => {
            card.querySelector('#opr-form').style.display = 'none';
        };
        card.querySelector('#opr-submit').onclick = async () => {
            const name  = card.querySelector('#opr-name').value.trim();
            const total = parseInt(card.querySelector('#opr-total').value) || 1;
            const unit  = card.querySelector('#opr-unit').value.trim() || 'وحدة';
            if (!name) { new Notice('أدخل اسم المهمة'); return; }
            if (total < 1) { new Notice('عدد الوحدات يجب أن يكون أكبر من صفر'); return; }
            this.S.progressTasks.push({
                id: uid(), name, total, unit, done: 0,
                completed: false, createdAt: fmtDate(new Date())
            });
            card.querySelector('#opr-name').value  = '';
            card.querySelector('#opr-total').value = '';
            card.querySelector('#opr-unit').value  = '';
            card.querySelector('#opr-form').style.display = 'none';
            await this.plugin.saveSettings();
            await this.plugin.writeProgressFile();
            this._drawProgress(card);
        };

        this._drawProgress(card);
    }

    _drawProgress(card) {
        const list = card.querySelector('#opr-list');
        list.innerHTML = '';

        const active    = this.S.progressTasks.filter(t => !t.completed && !t.archived);
        const completed = this.S.progressTasks.filter(t =>  t.completed && !t.archived);

        if (!active.length && !completed.length) {
            list.createDiv('omni-prog-empty').textContent = 'لا توجد مهام بعد';
            return;
        }

        const renderItem = (task, isDone) => {
            const pct  = Math.min(100, Math.round((task.done / Math.max(task.total, 1)) * 100));
            const item = list.createDiv(`omni-prog-item${isDone ? ' omni-prog-done' : ''}`);
            item.innerHTML = `
<div class="omni-prog-item-hd">
  <span class="omni-prog-name-lbl">${escapeHTML(task.name)}</span>
  <span class="omni-prog-units">${escapeHTML(task.done)}/${escapeHTML(task.total)} ${escapeHTML(task.unit)}</span>
</div>
<div class="omni-prog-bar-wrap">
  <div class="omni-prog-bar" style="width:${pct}%"></div>
</div>
<div class="omni-prog-item-ft">
  ${!isDone ? `
  <div class="omni-stepper omni-prog-stepper">
    <button class="omni-step-btn" data-id="${task.id}" data-a="dec">−</button>
    <span class="omni-prog-pct">${pct}%</span>
    <button class="omni-step-btn omni-step-accent" data-id="${task.id}" data-a="inc">+</button>
  </div>
  <div class="omni-prog-side-btns">
    <button class="omni-ghost-btn" data-id="${task.id}" data-a="done" title="اكتمل">✓</button>
    <button class="omni-ghost-btn" data-id="${task.id}" data-a="del"  title="حذف">🗑</button>
  </div>
  ` : `
  <span class="omni-prog-pct omni-pct-done">✓ مكتمل — ${pct}%</span>
  <button class="omni-ghost-btn" data-id="${task.id}" data-a="del" title="حذف">🗑</button>
  `}
</div>`;

            item.querySelectorAll('[data-a]').forEach(btn => {
                btn.onclick = async () => {
                    const { id, a } = btn.dataset;
                    const t = this.S.progressTasks.find(x => x.id === id);
                    if (!t) return;
                    
                    // تعديل منطق الزائد والناقص ليعتمد على المعادلة (a/b) * 100 = c%
                    // حيث a هي الوحدة المدخلة
                    const step = parseFloat(t.unit) || 1;
                    
                    if (a === 'inc') t.done = Math.min(t.total, t.done + step);
                    if (a === 'dec') t.done = Math.max(0, t.done - step);
                    if (a === 'done') {
                        t.completed = true; t.done = t.total;
                        sendNotif('OmniNote 🎉', `تم إكمال المهمة: ${t.name}`);
                    }
                    if (a === 'del') {
                        t.archived = true;
                        t.archivedDate = fmtDate(new Date());
                    }
                    await this.plugin.saveSettings();
                    await this.plugin.writeProgressFile();
                    this._drawProgress(card);
                };
            });
        };

        active.forEach(t    => renderItem(t, false));
        if (completed.length) {
            const sep = list.createDiv('omni-prog-sep');
            sep.textContent = '— مكتملة —';
            completed.forEach(t => renderItem(t, true));
        }
    }

    async onClose() {
        if (this.timerInt) clearInterval(this.timerInt);
    }
}

// ═══════════════════════════════════════════════════════════
//  صفحة الإعدادات
// ═══════════════════════════════════════════════════════════
class OmniSettingsTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl: el } = this;
        el.empty();
        el.setAttribute('dir', 'rtl');
        el.createEl('h2', { text: '⚙️ إعدادات OmniNote' });

        // ── البومودورو
        el.createEl('h3', { text: '⏱️ البومودورو' });
        new Setting(el)
            .setName('مدة العمل (دقائق)')
            .addText(t => t.setValue(String(this.plugin.settings.workDuration))
                .onChange(async v => {
                    this.plugin.settings.workDuration = Math.max(1, parseInt(v) || 25);
                    await this.plugin.saveSettings();
                }));
        new Setting(el)
            .setName('مدة الاستراحة (دقائق)')
            .addText(t => t.setValue(String(this.plugin.settings.shortBreak))
                .onChange(async v => {
                    this.plugin.settings.shortBreak = Math.max(1, parseInt(v) || 5);
                    await this.plugin.saveSettings();
                }));

        // ── الحكم
        el.createEl('h3', { text: '💡 الحكم والاقتباسات' });
        new Setting(el)
            .setName('الفترة بين إشعارات الحكم (دقائق)')
            .setDesc('كل كم دقيقة تظهر حكمة في إشعارات ويندوز')
            .addText(t => t.setValue(String(this.plugin.settings.quoteInterval))
                .onChange(async v => {
                    this.plugin.settings.quoteInterval = Math.max(1, parseInt(v) || 30);
                    await this.plugin.saveSettings();
                    this.plugin.restartQuoteTimer();
                }));

        const note = el.createDiv('omni-settings-note');
        note.innerHTML = `
	📥 <strong>استيراد الحكم:</strong> استخدم زر <code>📥</code> في واجهة البلاجن مباشرةً.<br>
	الملف يجب أن يكون CSV بعمودين: <strong>نص الحكمة</strong> ثم <strong>الكاتب</strong>.<br>
	الحكم الحالية: <strong>${this.plugin.settings.quotes.length} حكمة</strong>`;

        // ── إضافة حكمة يدوياً
        el.createEl('h3', { text: '✍️ إضافة حكمة يدوياً' });
        const manualDiv = el.createDiv('omni-manual-quote-wrap');
        manualDiv.style.display = 'flex';
        manualDiv.style.flexDirection = 'column';
        manualDiv.style.gap = '10px';
        manualDiv.style.padding = '10px';
        manualDiv.style.background = 'var(--background-secondary)';
        manualDiv.style.borderRadius = '8px';

        const qTextInp = manualDiv.createEl('textarea', { placeholder: 'نص الحكمة...' });
        qTextInp.style.width = '100%';
        qTextInp.style.height = '60px';
        qTextInp.style.direction = 'rtl';

        const qAuthInp = manualDiv.createEl('input', { type: 'text', placeholder: 'المؤلف...' });
        qAuthInp.style.width = '100%';
        qAuthInp.style.direction = 'rtl';

        const addBtn = manualDiv.createEl('button', { text: 'إضافة الحكمة +' });
        addBtn.classList.add('mod-cta');
        addBtn.onclick = async () => {
            const text = qTextInp.value.trim();
            const author = qAuthInp.value.trim() || 'مجهول';
            if (!text) { new Notice('يرجى كتابة نص الحكمة'); return; }
            
            this.plugin.settings.quotes.push({ text, author });
            await this.plugin.saveSettings();
            
            qTextInp.value = '';
            qAuthInp.value = '';
            new Notice('✅ تمت إضافة الحكمة بنجاح');
            this.display(); // تحديث العرض لإظهار العدد الجديد
        };

        // ── إدارة الحكم الحالية
        el.createEl('h3', { text: '📋 قائمة الحكم الحالية' });
        const tableContainer = el.createDiv('omni-quotes-table-container');
        tableContainer.style.maxHeight = '300px';
        tableContainer.style.overflowY = 'auto';
        tableContainer.style.border = '1px solid var(--background-modifier-border)';
        tableContainer.style.borderRadius = '8px';
        tableContainer.style.marginTop = '10px';

        const table = tableContainer.createEl('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.fontSize = '0.85em';

        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.style.background = 'var(--background-secondary-alt)';
        headerRow.createEl('th', { text: 'الحكمة' }).style.padding = '8px';
        headerRow.createEl('th', { text: 'المؤلف' }).style.padding = '8px';
        headerRow.createEl('th', { text: 'إجراء' }).style.padding = '8px';

        const tbody = table.createEl('tbody');
        this.plugin.settings.quotes.forEach((q, index) => {
            const row = tbody.createEl('tr');
            row.style.borderTop = '1px solid var(--background-modifier-border)';
            
            const textCell = row.createEl('td', { text: q.text });
            textCell.style.padding = '8px';
            textCell.style.maxWidth = '200px';
            textCell.style.overflow = 'hidden';
            textCell.style.textOverflow = 'ellipsis';
            textCell.style.whiteSpace = 'nowrap';

            const authCell = row.createEl('td', { text: q.author });
            authCell.style.padding = '8px';
            authCell.style.textAlign = 'center';

            const actionCell = row.createEl('td');
            actionCell.style.padding = '8px';
            actionCell.style.textAlign = 'center';
            
            const delBtn = actionCell.createEl('button', { text: '🗑' });
            delBtn.style.padding = '2px 6px';
            delBtn.onclick = async () => {
                this.plugin.settings.quotes.splice(index, 1);
                await this.plugin.saveSettings();
                new Notice('تم حذف الحكمة');
                this.display();
            };
        });

        // ── مجلد البيانات
        el.createEl('h3', { text: '💾 مجلد البيانات' });
        el.createDiv('omni-settings-note').innerHTML =
            `يتم حفظ السجلات والبيانات في مجلد:<br>
            <code>${DATA_DIR}/</code> داخل الـ vault`;
    }
}

// ═══════════════════════════════════════════════════════════
//  البلاجن الرئيسي
// ═══════════════════════════════════════════════════════════
class OmniNotePlugin extends Plugin {

    async onload() {
        await this.loadSettings();

        this.registerView(VIEW_TYPE_OMNI, leaf => new OmniNoteView(leaf, this));
        this.addRibbonIcon('calendar-clock', 'OmniNote', () => this.activateView());
        this.addCommand({
            id: 'open-omni-view',
            name: 'افتح OmniNote',
            callback: () => this.activateView(),
        });
        this.addSettingTab(new OmniSettingsTab(this.app, this));

        // طلب إذن الإشعارات
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        this.startQuoteTimer();
        this.startNotifCheck();

        // إنشاء مجلد البيانات فوراً
        await this._ensureDataDir();
    }

    // ── مجلد البيانات ──────────────────────────────────
    async _ensureDataDir() {
        try {
            const a = this.app.vault.adapter;
            if (!(await a.exists(DATA_DIR))) {
                await a.mkdir(DATA_DIR);
                console.log('OmniNote: Created data directory:', DATA_DIR);
            }
        } catch (e) {
            console.error('OmniNote: Failed to create data directory:', e);
        }
    }

    async logPomodoro(entry) {
        if (!Array.isArray(this.settings.pomodoroLog)) this.settings.pomodoroLog = [];
        this.settings.pomodoroLog.push(entry);
        if (this.settings.pomodoroLog.length > 500)
            this.settings.pomodoroLog = this.settings.pomodoroLog.slice(-500);
        await this.saveSettings();
        try {
            await this._ensureDataDir();
            const today = fmtDate(new Date());
            const filePath = `${DATA_DIR}/${today}.md`;
            const adapter = this.app.vault.adapter;
            
            let content = "";
            if (await adapter.exists(filePath)) {
                content = await adapter.read(filePath);
            } else {
                content = `# إحصائيات يوم ${today}\n\n`;
            }
            
            const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const safeNote = escapeHTML(entry.note || 'بدون ملاحظة');
            const newRow = `| ${timeStr} | ${safeNote} | ${entry.duration} دقيقة | ${entry.type === 'work' ? 'عمل' : 'استراحة'} |\n`;
            
            const pomoHeader = "## سجل البومودورو\n| الوقت | الملاحظة | المدة | النوع |\n| :--- | :--- | :--- | :--- |\n";
            if (content.includes('## سجل البومودورو')) {
                const nextSectionIdx = content.indexOf('\n## ', content.indexOf('## سجل البومودورو') + 5);
                if (nextSectionIdx !== -1) {
                    const before = content.substring(0, nextSectionIdx);
                    const after = content.substring(nextSectionIdx);
                    content = before.replace(/\n*$/, '') + '\n' + newRow + after;
                } else {
                    content = content.replace(/\n*$/, '') + '\n' + newRow;
                }
            } else {
                content += `\n${pomoHeader}${newRow}`;
            }
            
            await adapter.write(filePath, content);
        } catch (e) {
            console.error('OmniNote: Failed to log pomodoro to daily file:', e);
        }
    }

    async writeProgressFile() {
        try {
            await this._ensureDataDir();
            
            const adapter = this.app.vault.adapter;
            
            // حذف ملف progress-tasks.json إذا كان موجوداً
            if (await adapter.exists(`${DATA_DIR}/progress-tasks.json`)) {
                await adapter.remove(`${DATA_DIR}/progress-tasks.json`);
            }
            
            // تحديث الملف اليومي بملخص المهام
            const today = fmtDate(new Date());
            const filePath = `${DATA_DIR}/${today}.md`;
            
            let content = "";

            if (await adapter.exists(filePath)) {
                content = await adapter.read(filePath);
            } else {
                content = `# إحصائيات يوم ${today}\n`;
            }
            
            let taskSummary = "| المهمة | الإنجاز | النسبة | الحالة |\n| :--- | :--- | :--- | :--- |\n";
            
            const tasksToExport = this.settings.progressTasks.filter(t => !t.archived || t.archivedDate === today);
            tasksToExport.forEach(t => {
                const pct = Math.min(100, Math.round((t.done/Math.max(t.total, 1)) * 100));
                const status = t.completed ? '✅ مكتملة' : '⏳ جارية';
                taskSummary += `| ${escapeHTML(t.name)} | ${escapeHTML(t.done)}/${escapeHTML(t.total)} ${escapeHTML(t.unit)} | ${pct}% | ${status} |\n`;
            });
            
            const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const sectionTitle = `## متابعة الإنجاز (تحديث: ${timeStr})\n\n`;
            
            // Safe replacement using regex based on the ## title prefix
            const progressRegex = /## متابعة الإنجاز(?:.*?\n)+?(?=\n## |\Z)/;
            const fullSection = sectionTitle + taskSummary + "\n";
            
            if (progressRegex.test(content)) {
                content = content.replace(progressRegex, fullSection);
            } else {
                content = content.replace(/\n*$/, '') + "\n\n" + fullSection;
            }
            
            await adapter.write(filePath, content);
        } catch (e) {
            console.error('OmniNote: Failed to write progress to daily file:', e);
        }
    }

    // ── مؤقت الحكم ─────────────────────────────────────
    startQuoteTimer() {
        if (this._qTimer) clearInterval(this._qTimer);
        const ms = (this.settings.quoteInterval || 30) * 60 * 1000;
        this._qTimer = window.setInterval(() => {
            const qs = this.settings.quotes;
            if (!qs.length) return;
            const q = qs[Math.floor(Math.random() * qs.length)];
            sendNotif('💡 حكمة اليوم — OmniNote', `"${escapeHTML(q.text)}" — ${escapeHTML(q.author)}`);
        }, ms);
        this.registerInterval(this._qTimer);
    }
    restartQuoteTimer() { this.startQuoteTimer(); }

    // ── فحص إشعارات المهام ────────────────────────────
    startNotifCheck() {
        if (this._nTimer) clearInterval(this._nTimer);
        this._doNotifCheck();
        this._nTimer = window.setInterval(() => this._doNotifCheck(), 60 * 1000);
        this.registerInterval(this._nTimer);
    }

    async _doNotifCheck() {
        const now = Date.now();
        const windows = [
            { key: 'h24', ms: 24*60*60*1000, label: 'بعد 24 ساعة'  },
            { key: 'h12', ms: 12*60*60*1000, label: 'بعد 12 ساعة'  },
            { key: 'h2',  ms:  2*60*60*1000, label: 'بعد ساعتين'   },
        ];
        let dirty = false;
        for (const [ds, tasks] of Object.entries(this.settings.calendarTasks || {})) {
            for (const task of tasks) {
                const [yr, mo, dy] = ds.split('-').map(Number);
                const [h, m] = (task.time || '23:59').split(':').map(Number);
                const dueTs  = new Date(yr, mo-1, dy, h, m).getTime();
                const diff   = dueTs - now;
                if (!task.notifsSent) task.notifsSent = {};
                for (const w of windows) {
                    if (!task.notifsSent[w.key] && diff > 0 && diff <= w.ms) {
                        sendNotif('📅 تذكير — OmniNote', `"${task.text}" مستحقة ${w.label}`);
                        task.notifsSent[w.key] = true;
                        dirty = true;
                    }
                }
            }
        }
        if (dirty) await this.saveSettings();
    }

    // ── دورة الحياة ────────────────────────────────────
    async onunload() {
        if (this._qTimer) clearInterval(this._qTimer);
        if (this._nTimer) clearInterval(this._nTimer);
    }

    async loadSettings() {
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        // ضمان وجود المصفوفات / الكائنات
        if (!this.settings.stickyNotes)   this.settings.stickyNotes   = {};
        if (!this.settings.calendarTasks) this.settings.calendarTasks = {};
        if (!Array.isArray(this.settings.progressTasks)) this.settings.progressTasks = [];
        if (!Array.isArray(this.settings.pomodoroLog))   this.settings.pomodoroLog   = [];
        if (!Array.isArray(this.settings.quotes) || !this.settings.quotes.length)
            this.settings.quotes = DEFAULT_SETTINGS.quotes;
    }

    async saveSettings() { await this.saveData(this.settings); }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_OMNI)[0];
        if (!leaf) {
            const r = workspace.getRightLeaf(false);
            await r.setViewState({ type: VIEW_TYPE_OMNI, active: true });
            leaf = r;
        }
        workspace.revealLeaf(leaf);
    }
}

module.exports = OmniNotePlugin;
