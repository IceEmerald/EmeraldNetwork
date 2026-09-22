/* ── EmeraldSuite ⇄ EmeraldBot AI link (shared by the app pages) ──────────
   Provides the "Ask AI" entry point used by Notes/Docs/Slides/Sheets:
   it mounts a small fixed button that opens the AI chat with the currently
   open file attached, so the agent can read + edit that file directly. */
(function () {
    'use strict';

    const CHANNEL = 'emeraldsuite-agent';

    const META = {
        notes:  { label: 'EmeraldNotes',  file: 'notes.html',  color: '#a21caf' },
        docs:   { label: 'EmeraldDocs',   file: 'docs.html',   color: '#0891b2' },
        slides: { label: 'EmeraldSlides', file: 'slides.html', color: '#f97316' },
        sheets: { label: 'EmeraldSheets', file: 'sheets.html', color: '#84cc16' }
    };

    /* Open the chat page with a file attached. Relative to the app pages,
       which live at the site root alongside aichat.html. */
    function openSuiteAI(app, id) {
        if (!app || !id) return;
        try {
            window.open('aichat.html?file=' + encodeURIComponent(app) + '&owned=' + encodeURIComponent(id), '_blank');
        } catch (e) {
            location.href = 'aichat.html?file=' + encodeURIComponent(app) + '&owned=' + encodeURIComponent(id);
        }
    }

    /* Mount the floating "Ask AI" button. opts = { app, getId, label }.
       The button hides itself while no file is open (getId → null). */
    function mountButton(opts) {
        if (!opts || !opts.app) return;
        try {
            if (document.getElementById('suiteAiBtn')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'suiteAiBtn';
            btn.title = 'Ask the AI to edit this file';
            btn.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
                '<span>Ask AI</span>';
            btn.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99998;display:flex;align-items:center;gap:7px;padding:9px 15px;border:none;border-radius:999px;cursor:pointer;font:600 13px/1 "DM Sans",sans-serif;color:#fff;background:' + (opts.color || META[opts.app]?.color || '#0e7a4a') + ';box-shadow:0 4px 18px rgba(0,0,0,.35);transition:filter .15s;';
            btn.addEventListener('mouseenter', function () { btn.style.filter = 'brightness(1.1)'; });
            btn.addEventListener('mouseleave', function () { btn.style.filter = ''; });
            btn.addEventListener('click', function () {
                const id = opts.getId ? opts.getId() : null;
                if (!id) { btn.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 260 }); return; }
                openSuiteAI(opts.app, id);
            });
            document.body.appendChild(btn);
            opts.__btn = btn;
        } catch (e) { /* non-blocking */ }
    }

    /* Cross-tab broadcast used by the AI chat to tell pages "this file was
       just edited by the agent". Sheets (which has its own IndexedDB and no
       storage-layer broadcast) listens for these. */
    function postSync(msg) {
        try {
            if (typeof BroadcastChannel === 'undefined') return;
            const ch = new BroadcastChannel(CHANNEL);
            ch.postMessage(Object.assign({}, msg, { at: Date.now() }));
            try { ch.close(); } catch (e) {}
        } catch (e) {}
    }

    function onSync(fn) {
        try {
            if (typeof BroadcastChannel === 'undefined') return function () {};
            const ch = new BroadcastChannel(CHANNEL);
            ch.onmessage = (ev) => { try { fn(ev.data || {}); } catch (e) {} };
            return function () { try { ch.close(); } catch (e) {} };
        } catch (e) { return function () {}; }
    }

    window.openSuiteAI = openSuiteAI;
    window.emeraldsuiteAgent = { openSuiteAI, mountButton, postSync, onSync, META };
})();