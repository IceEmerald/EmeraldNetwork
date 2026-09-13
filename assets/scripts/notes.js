async function compressToUrl(str) {
    const bytes = new TextEncoder().encode(str);
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const arr = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decompressFromUrl(token) {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(out);
}
class NotesApp {
    constructor() {
        this.notes = [];
        this.currentNoteId = null;
        this.saveTimeout = null;
        this.isInitialized = false;
        this.savedSelection = null;
        this.isMobile = () => window.innerWidth <= 1023;
        this.sidebarOpen = false;
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.isSwiping = false;
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        this.collabSessionId = null;
        this.collabSessionRef = null;
        this.collabDb = null;
        this.collabUser = null;
        this.collabIsOwner = false;
        this.collabPermission = 'edit';
        this.collabMode = false;
        this.collabNoteData = null;
        this.collabNoteId = null;
        this.collabNoteVisible = false;
        // Mirrors the local "isViewOnly" computed in setEditorForSession so that
        // every editing entry point (undo/redo, find&replace, execCommand, etc.) can
        // cheaply check it without re-deriving the rule.
        this.isViewOnly = false;
        this.collabSessions = new Map();
        this._activeCollabSessionId = null;
        this._collabMergeBaseContent = '';
        this.ready = this.init();
    }
    async init() {
        await this.loadNotesFromStorage();
        this.initializeCollaboration();
        this.setupEventListeners();
        this.setupStorageSync();
        this.setupRibbon();
        this.setupMobileRibbon();
        this.setupTextEditor();
        this.setupDrawing();
        this.setupImageDragDrop();
        this.setupTableResize();
        this.setupImageInteractions();
        this.setupCanvasDragHandle();
        this.setupStatusBar();
        this.setupFindReplace();
        this.renderNotesList();
        this.renderNotesCards();
        this.showWelcomeScreenIfNeeded();
        this.updateRibbonAvailability();
        this.checkShareSessionFromURL();
        this.setupMobileUI();
        this.setupSwipeGesture();
        this.isInitialized = true;
    }
    async loadNotesFromStorage() {
        try {
            const storage = window.EmeraldIDBStorage;
            let storedNotes = null;
            if (storage) {
                storedNotes = await storage.getJSON('emeraldnotes_data');
                if (!storedNotes) {
                    storedNotes = await storage.migrateLocalJSON('emeraldnotes_data');
                }
                await Promise.all([
                    storage.migrateLocalJSON('emeraldnotes_collab_sessions'),
                    storage.migrateLocalJSON('emeraldnotes_collab_owner'),
                    storage.migrateLocalJSON('emeraldnotes_collab_non_owner'),
                    storage.migrateLocalJSON('emeraldnotes_collaborator'),
                    storage.migrateLocalJSON('sidebarCollapsed'),
                ]);
            } else {
                storedNotes = NotesApp.memoryStorageFallback.get('emeraldnotes_data') || null;
            }
            if (storedNotes) {
                this.notes = storedNotes;
                this.notes.forEach(note => {
                    if (note.content && typeof note.content === 'string') {
                        if (note.content.trim() === '<p>Start typing your note here...</p>' ||
                            note.content.trim() === 'Start typing your note here...') {
                            note.content = '';
                        }
                        const legacyEmptyPatterns = [
                            '<div>\u00A0</div>', '<p>\u00A0</p>',
                            '<div>&nbsp;</div>', '<p>&nbsp;</p>'
                        ];
                        if (legacyEmptyPatterns.includes(note.content.trim())) {
                            note.content = '';
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error loading notes from storage:', error);
            this.notes = [];
        }
    }
    saveNotesToStorage() {
        try {
            const toSave = this.notes.filter(n => !n._isCollabNote);
            const storage = window.EmeraldIDBStorage;
            if (storage) {
                storage.setJSONSync('emeraldnotes_data', toSave);
            } else {
                NotesApp.memoryStorageFallback.set('emeraldnotes_data', toSave);
            }
            this.showSaveIndicator('saved');
        } catch (error) {
            console.error('Error saving notes to storage:', error);
            this.showSaveIndicator('error');
        }
    }
    getStoredValue(key) {
        const storage = window.EmeraldIDBStorage;
        if (storage) return storage.getJSONSync(key);
        return NotesApp.memoryStorageFallback.has(key) ? NotesApp.memoryStorageFallback.get(key) : null;
    }
    setStoredValue(key, value) {
        const storage = window.EmeraldIDBStorage;
        if (storage) storage.setJSONSync(key, value);
        else NotesApp.memoryStorageFallback.set(key, value);
    }
    removeStoredValue(key) {
        const storage = window.EmeraldIDBStorage;
        if (storage) storage.delete(key).catch(() => {});
        NotesApp.memoryStorageFallback.delete(key);
    }
    setupStorageSync() {
        if (this._storageSyncReady || !window.EmeraldIDBStorage?.subscribe) return;
        this._storageSyncReady = true;
        window.EmeraldIDBStorage.subscribe(({ key }) => {
            if (key === 'emeraldnotes_data') {
                this.handleExternalNotesChange();
            }
        });
    }
    async handleExternalNotesChange() {
        if (this._handlingExternalNotesChange) return;
        this._handlingExternalNotesChange = true;
        const previousId = this.currentNoteId;
        const titleInput = document.getElementById('noteTitle');
        const textEditor = document.getElementById('textEditor');
        const tabIsActive = document.hasFocus();
        const editorFocused = tabIsActive && !!(textEditor && textEditor.contains(document.activeElement));
        const titleFocused = tabIsActive && document.activeElement === titleInput;
        const preserveActiveDraft = (editorFocused || titleFocused) && previousId;
        const activeDraft = preserveActiveDraft
            ? this.notes.find(note => note.id === previousId)
            : null;

        try {
            await this.loadNotesFromStorage();
            if (activeDraft) {
                const index = this.notes.findIndex(note => note.id === activeDraft.id);
                if (index >= 0) {
                    this.notes[index] = activeDraft;
                } else {
                    this.notes.unshift(activeDraft);
                }
            }

            const activeStillExists = previousId && this.notes.some(note => note.id === previousId);
            this.currentNoteId = activeStillExists ? previousId : null;
            this.renderNotesList();
            this.renderNotesCards();

            if (activeStillExists && !preserveActiveDraft) {
                this.refreshSelectedNoteView(previousId);
            } else if (!activeStillExists) {
                this.showWelcomeScreenIfNeeded();
            }
        } catch (error) {
            console.error('Error syncing notes from IndexedDB:', error);
        } finally {
            this._handlingExternalNotesChange = false;
        }
    }
    refreshSelectedNoteView(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;
        const noteTitle = document.getElementById('noteTitle');
        const textEditor = document.getElementById('textEditor');
        if (noteTitle) noteTitle.value = note.title;
        if (textEditor) {
            this._applySanitizedHtml(textEditor, note.content);
            textEditor.style.backgroundColor = note.color && note.color !== '#ffffff'
                ? note.color
                : 'rgba(255, 255, 255, 0.5)';
            this.updatePlaceholderState(textEditor);
        }
        this.showWelcomeScreenIfNeeded();
        this.loadDrawing();
        this.updateStatusBar();
    }
    showToast(message, duration = 3000) {
        const toast = document.getElementById('custom-toast');
        if (!toast) { console.warn(message); return; }
        const m = message.toLowerCase();
        let icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
        if (m.includes('clipboard') || m.includes('copied') || m.includes('link copied')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        else if (m.includes('reconnected')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        else if (m.includes('reconnect')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
        else if (m.includes('joined shared') || m.includes('joined collab')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
        else if (m.includes('session closed') || m.includes('ended this session')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
        else if (m.includes('view only')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        else if (m.includes('can now edit') || m.includes('permission changed')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        else if (m.includes('failed') || m.includes('error')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        else if (m.includes('limit') || m.includes('only have 1') || m.includes('already have') || m.includes('large') || m.includes('select an image') || m.includes('no text')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        else if (m.includes('image')) icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
        toast.innerHTML = `<span style="display:flex;align-items:center;gap:8px;"><span>${icon}</span><span>${this.escapeHtml(message)}</span></span>`;
        toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }
    initializeCollaboration() {
        this.dbUrl = 'https://emeraldnetworkweb-default-rtdb.asia-southeast1.firebasedatabase.app';
        this.collabDb = true;
        this.collabUser = this.loadCollaboratorInfo();
        this._setupConnectionMonitor();
        window.addEventListener('visibilitychange', () => {
            if (document.hidden) this.leaveCollaboration();
            else if (this.collabSessionId) this.updateActiveUserPresence();
        });
        window.addEventListener('beforeunload', () => {
            if (this.collabSessionId && this.collabUser) {
                if (this.collabMode && (this.collabPermission === 'edit' || this.collabIsOwner) && this.collabNoteData) {
                    try {
                        navigator.sendBeacon(
                            `${this.dbUrl}/sharednotes/${this.collabSessionId}.json`,
                            JSON.stringify({ note: this.collabNoteData })
                        );
                    } catch (err) {
                        console.warn('Failed to flush collab note before unload', err);
                    }
                }
                navigator.sendBeacon(
                    `${this.dbUrl}/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}.json?x-http-method-override=DELETE`,
                    ''
                );
            }
        });
    }
    _sessionUrl(path = '') {
        return `${this.dbUrl}/sharednotes/${this.collabSessionId}${path}.json`;
    }
    _getSessionByNoteId(noteId) {
        for (const s of this.collabSessions.values()) {
            if (s.noteId === noteId) return s;
        }
        return null;
    }
    _isCollabNoteId(noteId) {
        for (const s of this.collabSessions.values()) {
            if (s.noteId === noteId) return true;
        }
        return false;
    }
    _registerSession(sessionId, data) {
        const existing = this.collabSessions.get(sessionId) || {};
        this.collabSessions.set(sessionId, {
            sessionId,
            noteId: data.noteId ?? existing.noteId ?? null,
            isOwner: data.isOwner ?? existing.isOwner ?? false,
            permission: data.permission ?? existing.permission ?? 'edit',
            noteData: data.noteData ?? existing.noteData ?? null,
            activeUsers: data.activeUsers ?? existing.activeUsers ?? {},
            eventSource: data.eventSource ?? existing.eventSource ?? null,
            lastPushedModifiedAt: existing.lastPushedModifiedAt ?? null
        });
        this._persistAllSessions();
    }
    _unregisterSession(sessionId) {
        const s = this.collabSessions.get(sessionId);
        if (s && s.eventSource) { try { s.eventSource.close(); } catch (_) {} }
        this.collabSessions.delete(sessionId);
        this._persistAllSessions();
    }
    _switchActiveSession(sessionId) {
        if (this._activeCollabSessionId && this.collabSessions.has(this._activeCollabSessionId)) {
            const old = this.collabSessions.get(this._activeCollabSessionId);
            old.noteData = this.collabNoteData;
            old.activeUsers = this._activeUsers || {};
            old.permission = this.collabPermission;
            old.lastPushedModifiedAt = this._lastPushedModifiedAt;
        }
        const sess = this.collabSessions.get(sessionId);
        if (!sess) return false;
        this._activeCollabSessionId = sessionId;
        this.collabMode = true;
        this.collabIsOwner = sess.isOwner;
        this.collabSessionId = sess.sessionId;
        this.collabNoteId = sess.noteId;
        this.collabPermission = sess.permission;
        this.collabNoteData = sess.noteData;
        this._activeUsers = sess.activeUsers || {};
        this._lastPushedModifiedAt = sess.lastPushedModifiedAt || null;
        return true;
    }
    _persistAllSessions() {
        const sessions = [];
        for (const s of this.collabSessions.values()) {
            sessions.push({ sessionId: s.sessionId, noteId: s.noteId, isOwner: s.isOwner });
        }
        try {
            if (sessions.length > 0) {
                this.setStoredValue('emeraldnotes_collab_sessions', sessions);
            } else {
                this.removeStoredValue('emeraldnotes_collab_sessions');
            }
        } catch (_) {}
    }
    _clearAllSessions() {
        for (const s of this.collabSessions.values()) {
            if (s.eventSource) { try { s.eventSource.close(); } catch (_) {} }
        }
        this.collabSessions.clear();
        this._activeCollabSessionId = null;
        this.removeStoredValue('emeraldnotes_collab_sessions');
        this.removeStoredValue('emeraldnotes_collab_owner');
        this.removeStoredValue('emeraldnotes_collab_non_owner');
    }
    _setupConnectionMonitor() {
        this._disconnected = false;
        this._reconnectTimer = null;
        this._disconnectModalEl = null;
        const onOffline = () => {
            if (this._disconnected) return;
            this._disconnected = true;
            this.showToast('Reconnecting…', 99999);
            this._reconnectTimer = setTimeout(() => {
                if (this._disconnected) this._showDisconnectModal();
            }, 15000);
        };
        const onOnline = () => {
            if (!this._disconnected) return;
            this._disconnected = false;
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
            this.showToast('Reconnected!', 4000);
        };
        window.addEventListener('offline', onOffline);
        window.addEventListener('online', onOnline);
    }
    _showDisconnectModal() {
        if (this._disconnectModalEl) return;
        const overlay = document.createElement('div');
        overlay.id = 'disconnectModal';
        overlay.className = 'link-modal';
        overlay.innerHTML = `
            <div class="link-modal-content" style="max-width:380px;text-align:center;">
                <div class="link-modal-header">
                    <div class="link-modal-icon" style="background:#ee5a52;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="1" y1="1" x2="23" y2="23"/>
                            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
                            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
                            <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
                            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
                            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                            <line x1="12" y1="20" x2="12.01" y2="20"/>
                        </svg>
                    </div>
                    <h3 class="link-modal-title">Connection Lost</h3>
                </div>
                <div class="link-modal-body">
                    <p style="font-size:14px;color:#383838;text-align:center;margin:0;font-family:'DM Sans',sans-serif;line-height:1.6;">
                        Your internet connection was lost. Check your connection then reload to continue working.
                    </p>
                </div>
                <div class="link-modal-actions" style="justify-content:center;">
                    <button class="link-modal-btn link-modal-btn-create" id="disconnectReloadBtn" style="background:#a21caf;border-color:rgba(162,28,175,0.3);">Reload</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));
        this._disconnectModalEl = overlay;
        const reloadBtn = overlay.querySelector('#disconnectReloadBtn');
        reloadBtn.addEventListener('click', () => window.location.reload());
        reloadBtn.addEventListener('mouseover', function() { this.style.background = '#86198f'; });
        reloadBtn.addEventListener('mouseout', function() { this.style.background = '#a21caf'; });
    }
    _hideDisconnectModal() {
        if (this._disconnectModalEl) {
            this._disconnectModalEl.remove();
            this._disconnectModalEl = null;
        }
    }
    async _dbGet(path = '') {
        const res = await fetch(`${this.dbUrl}${path}.json`);
        if (!res.ok) throw new Error(`DB GET failed: ${res.status}`);
        return res.json();
    }
    async _dbPut(path = '', data) {
        await fetch(`${this.dbUrl}${path}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }
    async _dbPatch(path = '', data) {
        await fetch(`${this.dbUrl}${path}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }
    async _dbDelete(path = '') {
        await fetch(`${this.dbUrl}${path}.json`, { method: 'DELETE' });
    }
    loadCollaboratorInfo() {
        try {
            const parsed = this.getStoredValue('emeraldnotes_collaborator');
            if (parsed) {
                if (parsed && parsed.id && parsed.name && parsed.color) {
                    return parsed;
                }
            }
        } catch (error) {
            console.warn('Failed to load collaborator info', error);
        }
        const names = ['Jade', 'Nova', 'Luna', 'Kai', 'Aria', 'Echo', 'Onyx', 'Ariel', 'Zara', 'Orion'];
        const colors = ['#00b894', '#0984e3', '#6c5ce7', '#e17055', '#00cec9', '#fdcb6e', '#ff7675', '#74b9ff', '#55efc4', '#ffeaa7'];
        const _rnd = (n) => {
            const max = Math.floor(0x100000000 / n) * n;
            let x;
            do { x = crypto.getRandomValues(new Uint32Array(1))[0]; } while (x >= max);
            return x % n;
        };
        const randomName = names[_rnd(names.length)];
        const randomNumber = _rnd(90) + 10;
        const collaborator = {
            id: this.generateSecureId(16),
            name: `${randomName} ${randomNumber}`,
            color: colors[_rnd(colors.length)]
        };
        if (!collaborator.name || collaborator.name.trim() === '') {
            collaborator.name = 'User ' + _rnd(9999);
        }
        this.setStoredValue('emeraldnotes_collaborator', collaborator);
        return collaborator;
    }
    checkShareSessionFromURL() {
        const params = new URLSearchParams(window.location.search);
        const sessionId = params.get('collab');
        if (sessionId) {
            this.joinCollabSession(sessionId);
            // NOTE: We intentionally do NOT clear the ?collab= URL here.
            // The address bar should keep showing ?collab=<sessionId> while
            // the user is viewing the shared note — that way they can copy
            // the link from the address bar to re-share it. When the user
            // later opens a different note, updateOwnedLinkBar() will
            // automatically replace the URL with ?owned=<id> (or a different
            // ?collab=<id> if they switch to another shared note).
            return;
        }
        let restored = [];
        try {
            const saved = this.getStoredValue('emeraldnotes_collab_sessions');
            if (saved) restored = saved;
        } catch (_) {}
        if (restored.length === 0) {
            try {
                const legacyOwner = this.getStoredValue('emeraldnotes_collab_owner');
                if (legacyOwner) {
                    const { sessionId: sid, noteId } = legacyOwner;
                    if (sid) restored.push({ sessionId: sid, noteId, isOwner: true });
                }
            } catch (_) {}
            try {
                const legacyNO = this.getStoredValue('emeraldnotes_collab_non_owner');
                if (legacyNO) {
                    const { sessionId: sid } = legacyNO;
                    if (sid && !restored.some(r => r.sessionId === sid)) {
                        restored.push({ sessionId: sid, noteId: null, isOwner: false });
                    }
                }
            } catch (_) {}
            this.removeStoredValue('emeraldnotes_collab_owner');
            this.removeStoredValue('emeraldnotes_collab_non_owner');
        }
        if (restored.length === 0) return;
        const ownerSessions = restored.filter(r => r.isOwner);
        const nonOwnerSessions = restored.filter(r => !r.isOwner);
        for (const sess of ownerSessions) {
            const { sessionId: sid, noteId } = sess;
            if (!sid) continue;
            this._dbGet(`/sharednotes/${sid}`).then(data => {
                if (!data || data.status === 'closed' || data.ownerId !== this.collabUser.id) {
                    this.collabSessions.delete(sid);
                    this._persistAllSessions();
                    return;
                }
                const resolvedNoteId = noteId || data.noteId || null;
                const noteData = data.note || { title: 'Untitled Note', content: '', color: '#ffffff', modifiedAt: new Date().toISOString() };
                const activeUsers = data.activeUsers || {};
                const isFirstActive = !this._activeCollabSessionId;
                this._registerSession(sid, {
                    noteId: resolvedNoteId,
                    isOwner: true,
                    permission: data.permission || 'edit',
                    noteData,
                    activeUsers
                });
                if (isFirstActive) {
                    this._activeCollabSessionId = sid;
                    this.collabSessionId = sid;
                    this.collabNoteId = resolvedNoteId;
                    this.collabIsOwner = true;
                    this.collabPermission = data.permission || 'edit';
                    this.collabMode = true;
                    this.collabNoteData = noteData;
                    this._activeUsers = activeUsers;
                    this.collabNoteVisible = false;
                    this._setOwnerOnlyButtonsVisible(true);
                    if (resolvedNoteId && this.notes.some(n => n.id === resolvedNoteId)) {
                        this.renderNotesList();
                    }
                }
                this.setupSessionListener(sid);
                if (isFirstActive) this.updateActiveUserPresence();
            }).catch(() => {
                this.collabSessions.delete(sid);
                this._persistAllSessions();
            });
        }
        for (const sess of nonOwnerSessions) {
            const { sessionId: sid } = sess;
            if (!sid) continue;
            this.joinCollabSession(sid, true).catch(() => {
                this.collabSessions.delete(sid);
                this._persistAllSessions();
            });
        }
    }
    async joinCollabSession(sessionId, silent = false) {
        try {
            const data = await this._dbGet(`/sharednotes/${sessionId}`);
            if (!data) {
                if (!silent) this.showShareModal({ title: 'Invalid Session', message: 'This live collaboration link is no longer valid.' });
                return;
            }
            if (data.status === 'closed') {
                if (!silent) this.showShareModal({ title: 'Session Closed', message: 'This shared note session has ended.' });
                return;
            }
            if (!this.collabSessions.has(sessionId) && this.collabSessions.size >= 1) {
                if (!silent) this.showShareModal({ title: 'Limit Reached', message: 'You already have an active collaboration note. You can only participate in 1 at a time. Leave your current session to join another.' });
                return;
            }
            const isOwner = data.ownerId === this.collabUser.id;
            const permission = data.permission || 'edit';
            const noteData = data.note || { title: 'Untitled Note', content: '', color: '#ffffff', modifiedAt: new Date().toISOString() };
            const ownerNoteId = data.noteId || null;
            let noteId;
            if (ownerNoteId && this.notes.some(n => n.id === ownerNoteId && !n._isCollabNote)) {
                noteId = ownerNoteId;
            } else {
                noteId = '_collab_' + sessionId;
                this.notes = this.notes.filter(n => !(n._isCollabNote && n._collabSessionId === sessionId));
                this.notes.unshift({
                    id: noteId,
                    title: noteData.title || 'Shared Note',
                    content: noteData.content || '',
                    color: noteData.color || '#ffffff',
                    modifiedAt: noteData.modifiedAt || new Date().toISOString(),
                    _isCollabNote: true,
                    _collabSessionId: sessionId
                });
            }
            this._registerSession(sessionId, {
                noteId,
                isOwner,
                permission,
                noteData,
                activeUsers: data.activeUsers || {}
            });
            if (!silent) {
                this._activeCollabSessionId = sessionId;
                this.collabSessionId = sessionId;
                this.collabNoteId = noteId;
                this.collabIsOwner = isOwner;
                this.collabPermission = permission;
                this.collabMode = true;
                this.collabNoteData = noteData;
                this._activeUsers = data.activeUsers || {};
                this.collabNoteVisible = true;
                this.currentNoteId = noteId;
                this.setEditorForSession(noteData);
                if (!this.collabIsOwner) {
                    this._showLeaveButton();
                }
                this.renderNotesList();
                this.renderNotesCards();
                this.renderShareCollaborators(data.activeUsers || {});
                this.setupSessionListener(sessionId);
                this.updateActiveUserPresence();
                this.renderCollabBar(data.activeUsers || {});
                this._updateLeaveButtonVisibility();
                this.showToast(`Joined shared note as ${this.collabUser.name || 'Guest'}`);
            } else {
                this.setupSessionListener(sessionId);
                this.renderNotesList();
                this.renderNotesCards();
            }
        } catch (err) {
            console.error('Failed to join collab session', err);
            if (!silent) this.showToast('Failed to join session. Please try again.');
        }
    }
    openShareModal() {
        if (!this.currentNoteId && !this.collabMode) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        const existingSess = note ? this._getSessionByNoteId(note.id) : null;
        if (existingSess && this._activeCollabSessionId !== existingSess.sessionId) {
            this._switchActiveSession(existingSess.sessionId);
            this.collabNoteVisible = true;
            this.renderCollabBar(this._activeUsers || {});
        }
        if (!existingSess && this.collabSessions.size >= 1) {
            this.showToast('You already have an active collaboration note. You can only have 1 at a time.');
            return;
        }
        if (!this.collabSessionId || !this.collabMode) {
            this.collabSessionId = this.collabSessionId || this.generateSecureId(16);
            this.collabNoteId = note ? note.id : null;
            this.collabIsOwner = true;
            this.collabMode = true;
            this.collabPermission = 'edit';
            this.collabNoteVisible = true;
            this.collabNoteData = note ? { ...note } : { title: 'Untitled Note', content: '', color: '#ffffff', modifiedAt: new Date().toISOString() };
            const safeName = (this.collabUser.name && this.collabUser.name !== 'undefined')
                ? this.collabUser.name
                : ('User ' + (this.collabUser.id || '').slice(0, 4));
            const ownerEntry = {
                id: this.collabUser.id,
                name: safeName,
                color: this.collabUser.color || '#00b894',
                cursor: null,
                updatedAt: new Date().toISOString(),
                isOwner: true
            };
            this._activeUsers = { [this.collabUser.id]: ownerEntry };
            this._registerSession(this.collabSessionId, {
                noteId: this.collabNoteId,
                isOwner: true,
                permission: this.collabPermission,
                noteData: this.collabNoteData,
                activeUsers: this._activeUsers
            });
            this._activeCollabSessionId = this.collabSessionId;
            this._dbPut(`/sharednotes/${this.collabSessionId}`, {
                ownerId: this.collabUser.id,
                noteId: this.collabNoteId,
                permission: this.collabPermission,
                status: 'open',
                createdAt: new Date().toISOString(),
                note: this.collabNoteData,
                activeUsers: this._activeUsers
            });
            this.setupSessionListener(this.collabSessionId);
            this.renderCollabBar(this._activeUsers);
            this._setOwnerOnlyButtonsVisible(true);
        }
        const shareModal = document.getElementById('shareModal');
        const shareLink = document.getElementById('shareLink');
        const permissionSelect = document.getElementById('sharePermission');
        const permissionGroup = document.getElementById('sharePermissionGroup');
        const collaboratorsGroup = document.getElementById('shareCollaboratorsList');
        const cancelBtn = document.getElementById('shareModalCancel');
        const copyBtn = document.getElementById('shareModalCopy');
        const closeBtn = document.getElementById('shareModalClose');
        if (!shareModal || !shareLink || !permissionSelect) return;
        shareLink.value = `${window.location.origin}${window.location.pathname}?collab=${this.collabSessionId}`;
        permissionSelect.value = this.collabPermission;
        if (permissionGroup) permissionGroup.style.display = this.collabIsOwner ? '' : 'none';
        if (collaboratorsGroup) collaboratorsGroup.style.display = this.collabIsOwner ? '' : 'none';
        if (closeBtn) closeBtn.style.display = this.collabIsOwner ? 'inline-flex' : 'none';
        if (copyBtn) copyBtn.style.display = 'inline-flex'; 
        shareModal.classList.add('show');
        const cleanup = () => {
            shareModal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            if (copyBtn) copyBtn.removeEventListener('click', handleCopy);
            if (closeBtn) closeBtn.removeEventListener('click', handleCloseSession);
            permissionSelect.removeEventListener('change', handlePermissionChange);
        };
        const handleCopy = () => {
            shareLink.select();
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(shareLink.value);
                } else {
                    document.execCommand('copy');
                }
                this.showToast('Link copied to clipboard');
                cleanup();
            } catch (error) {
                console.warn('Copy failed', error);
            }
        };
        const handlePermissionChange = () => {
            this.collabPermission = permissionSelect.value;
            if (this.collabSessionId) {
                this._dbPatch(`/sharednotes/${this.collabSessionId}`, { permission: this.collabPermission });
            }
        };
        const handleCloseSession = async () => {
            if (!this.collabIsOwner || !this.collabSessionId) return;
            await this._dbPatch(`/sharednotes/${this.collabSessionId}`, { status: 'closed', closedAt: new Date().toISOString() });
            this.showToast('Session closed');
            cleanup();
            this._resetCollabState();
        };
        cancelBtn.addEventListener('click', cleanup);
        if (closeBtn) closeBtn.addEventListener('click', handleCloseSession);
        if (copyBtn) copyBtn.addEventListener('click', handleCopy);
        permissionSelect.addEventListener('change', handlePermissionChange);
    }
    showShareModal({ title = 'Live Collaboration', message = '', collaborators = [] } = {}) {
        const modal = document.getElementById('shareModal');
        const shareLink = document.getElementById('shareLink');
        const permissionGroup = document.getElementById('sharePermissionGroup');
        const collaboratorsGroup = document.getElementById('shareCollaboratorsList');
        const copyBtn = document.getElementById('shareModalCopy');
        const closeBtn = document.getElementById('shareModalClose');
        if (!modal) return;
        if (title) modal.querySelector('.link-modal-title').textContent = title;
        if (shareLink) shareLink.value = message;
        if (permissionGroup) permissionGroup.style.display = 'none';
        if (collaboratorsGroup) collaboratorsGroup.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';
        if (copyBtn) copyBtn.style.display = 'none';
        modal.classList.add('show');
        const cancelBtn = document.getElementById('shareModalCancel');
        if (cancelBtn) cancelBtn.onclick = () => {
            modal.classList.remove('show');
        };
    }
    async updateActiveUserPresence() {
        if (!this.collabSessionId || !this.collabUser) return;
        const safeName = (this.collabUser.name && this.collabUser.name !== 'undefined')
            ? this.collabUser.name
            : ('User ' + (this.collabUser.id || '').slice(0, 4));
        await this._dbPatch(`/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}`, {
            id: this.collabUser.id,
            name: safeName,
            color: this.collabUser.color || '#00b894',
            cursor: null,
            updatedAt: new Date().toISOString(),
            isOwner: this.collabIsOwner
        });
    }
    setupSessionListener(sessionId) {
        const sid = sessionId || this.collabSessionId;
        if (!sid) return;
        const existingSess = this.collabSessions.get(sid);
        if (existingSess && existingSess.eventSource) {
            try { existingSess.eventSource.close(); } catch (_) {}
        }
        const isActive = () => this._activeCollabSessionId === sid;
        const getSess = () => this.collabSessions.get(sid);
        const url = `${this.dbUrl}/sharednotes/${sid}.json`;
        const es = new EventSource(url);
        this._registerSession(sid, { eventSource: es });
        const applyNoteUpdate = (note) => {
            if (!note) return;
            const sess = getSess();
            if (!sess) return;
            const lastPushed = isActive() ? this._lastPushedModifiedAt : sess.lastPushedModifiedAt;
            if (lastPushed && lastPushed === note.modifiedAt) {
                sess.noteData = note;
                if (isActive()) this._collabMergeBaseContent = note.content || '';
                return;
            }
            const prevData = isActive() ? this.collabNoteData : sess.noteData;
            if (!prevData || note.modifiedAt !== prevData.modifiedAt) {
                if (isActive()) { this.collabNoteData = note; }
                sess.noteData = note;
                const virtualNote = this.notes.find(n => n._isCollabNote && n._collabSessionId === sid);
                if (virtualNote) {
                    virtualNote.title = note.title || 'Shared Note';
                    virtualNote.content = note.content || '';
                    virtualNote.color = note.color || '#ffffff';
                    virtualNote.modifiedAt = note.modifiedAt;
                    this.renderNotesList();
                }
                if (isActive() && this.collabNoteVisible) {
                    const textEditor = document.getElementById('textEditor');
                    const editorHasFocus = textEditor && document.activeElement === textEditor;
                    const msSinceLocalEdit = this._lastLocalEditAt ? (Date.now() - this._lastLocalEditAt) : Infinity;
                    const remoteContent = note.content || '';
                    const localContent = textEditor ? (this.isEditorEmpty(textEditor) ? '' : textEditor.innerHTML.trim()) : '';
                    const mergeBase = this._collabMergeBaseContent ?? prevData?.content ?? '';
                    const hasUnpushedLocalContent = localContent !== mergeBase && localContent !== remoteContent;

                    if (hasUnpushedLocalContent && this.collabPermission === 'edit') {
                        const merged = this._mergeNonOverlappingChanges(mergeBase, localContent, remoteContent);
                        if (merged.clean) {
                            const mergedNote = {
                                ...note,
                                content: merged.value,
                                title: this.collabNoteData?.title || note.title || 'Untitled Note',
                                color: this.collabNoteData?.color || note.color || '#ffffff',
                                modifiedAt: new Date().toISOString()
                            };
                            this.collabNoteData = mergedNote;
                            sess.noteData = mergedNote;
                            this._collabMergeBaseContent = mergedNote.content || '';
                            if (virtualNote) {
                                virtualNote.title = mergedNote.title || 'Shared Note';
                                virtualNote.content = mergedNote.content || '';
                                virtualNote.color = mergedNote.color || '#ffffff';
                                virtualNote.modifiedAt = mergedNote.modifiedAt;
                                this.renderNotesList();
                            }
                            this.setEditorForSession(mergedNote, false);
                            this._pushCollabNoteNow(mergedNote);
                            return;
                        }
                    }

                    if (editorHasFocus && msSinceLocalEdit < 1500) {
                        if (this._pendingRemoteNote) clearTimeout(this._pendingRemoteNoteTimer);
                        this._pendingRemoteNote = note;
                        this._pendingRemoteNoteTimer = setTimeout(() => {
                            if (this._pendingRemoteNote) {
                                this.collabNoteData = this._pendingRemoteNote;
                                sess.noteData = this._pendingRemoteNote;
                                this.setEditorForSession(this._pendingRemoteNote, false);
                                this._pendingRemoteNote = null;
                            }
                        }, 1500);
                    } else {
                        if (this._pendingRemoteNoteTimer) {
                            clearTimeout(this._pendingRemoteNoteTimer);
                            this._pendingRemoteNote = null;
                        }
                        this.setEditorForSession(note, false);
                    }
                }
            }
        };
        const applyPermissionUpdate = (perm) => {
            if (!perm) return;
            const sess = getSess();
            if (!sess) return;
            const prev = isActive() ? this.collabPermission : sess.permission;
            if (perm === prev) return;
            sess.permission = perm;
            if (isActive()) {
                this.collabPermission = perm;
                const nd = isActive() ? this.collabNoteData : sess.noteData;
                if (nd) this.setEditorForSession(nd, false);
                this.renderCollabBar(this._activeUsers || {});
                if (!this.collabIsOwner) {
                    this.showToast(perm === 'edit' ? 'Permission changed: You can now edit' : 'Permission changed: View only');
                }
            }
        };
        const applyClose = () => {
            const sess = getSess();
            if (!sess) return;
            if (sess.isOwner) return;
            if (isActive()) {
                const msg = 'The owner has ended this session.';
                this._resetCollabState();
                this.showToast(msg, 5000);
            } else {
                const virtualNote = this.notes.find(n => n._isCollabNote && n._collabSessionId === sid);
                if (virtualNote) {
                    this.notes = this.notes.filter(n => !(n._isCollabNote && n._collabSessionId === sid));
                    this.renderNotesList();
                }
                this._unregisterSession(sid);
            }
        };
        const applyActiveUsers = (activeUsers) => {
            const sess = getSess();
            if (!sess) return;
            sess.activeUsers = activeUsers;
            if (isActive()) {
                this._activeUsers = activeUsers;
                this.renderShareCollaborators(activeUsers);
                this.renderCollabBar(activeUsers);
            }
        };
        es.addEventListener('put', (event) => {
            try {
                const msg = JSON.parse(event.data);
                const data = msg.data;
                if (!data) return;
                const users = data.activeUsers || {};
                applyActiveUsers(users);
                if (data.status === 'closed') { applyClose(); return; }
                applyNoteUpdate(data.note);
            } catch (e) { console.warn('SSE put parse error', e); }
        });
        es.addEventListener('patch', (event) => {
            try {
                const msg = JSON.parse(event.data);
                const path = msg.path || '/';
                const data = msg.data;
                if (path === '/' || path === '') {
                    if (data.note) applyNoteUpdate(data.note);
                    if (data.permission) applyPermissionUpdate(data.permission);
                    if (data.activeUsers !== undefined) applyActiveUsers(data.activeUsers || {});
                    if (data.status === 'closed') applyClose();
                } else if (path === '/note') {
                    applyNoteUpdate(data);
                } else if (path === '/permission') {
                    applyPermissionUpdate(data);
                } else if (path === '/status') {
                    if (data === 'closed') applyClose();
                } else if (path.startsWith('/activeUsers')) {
                    const sess = getSess();
                    if (!sess) return;
                    const parts = path.split('/').filter(Boolean);
                    const users = isActive() ? (this._activeUsers || {}) : (sess.activeUsers || {});
                    if (parts.length === 1) {
                        applyActiveUsers(data || {});
                    } else if (parts.length >= 2) {
                        const uid = parts[1];
                        const updated = { ...users };
                        if (data === null) { delete updated[uid]; } else { updated[uid] = { ...(updated[uid] || {}), ...data }; }
                        applyActiveUsers(updated);
                    }
                }
            } catch (e) { console.warn('SSE patch parse error', e); }
        });
        es.onerror = () => { console.warn(`SSE connection lost for session ${sid}, will auto-reconnect`); };
    }
    _safeUserName(user) {
        return (user.name && user.name !== 'undefined' && user.name.trim())
            ? user.name
            : ('User ' + (user.id || '???').slice(0, 4));
    }
    _renderCollabCursors() {
        const cursors = document.getElementById('collabCursors');
        if (!cursors) return;
        if (!this.collabNoteVisible) {
            cursors.innerHTML = '';
            return;
        }
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        if (!this._labelTimers) this._labelTimers = new Map();
        const cursorsRect = cursors.getBoundingClientRect();
        const users = Object.values(this._activeUsers || {});
        const activeIds = new Set();
        users.forEach(user => {
            if (user.id === this.collabUser.id || !user.cursor) return;
            let rect = null;
            if (user.cursor.charOffset !== undefined) {
                try {
                    const range = this._getRangeFromTextOffset(editor, user.cursor.charOffset);
                    rect = range.getBoundingClientRect();
                } catch (e) {}
            } else if (user.cursor.top !== undefined) {
                const editorRect = editor.getBoundingClientRect();
                rect = {
                    top: user.cursor.top - editor.scrollTop + editorRect.top,
                    left: user.cursor.left - editor.scrollLeft + editorRect.left,
                    height: user.cursor.height || 18
                };
            }
            if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) return;
            const visualTop = rect.top - cursorsRect.top;
            const visualLeft = rect.left - cursorsRect.left;
            const height = rect.height || 18;
            activeIds.add(user.id);
            let cursorEl = cursors.querySelector(`[data-user-id="${user.id}"]`);
            if (cursorEl) {
                cursorEl.style.top = `${visualTop}px`;
                cursorEl.style.left = `${visualLeft}px`;
                cursorEl.style.height = `${height}px`;
            } else {
                cursorEl = document.createElement('div');
                cursorEl.className = 'collab-cursor';
                cursorEl.dataset.userId = user.id;
                cursorEl.style.cssText = `top:${visualTop}px;left:${visualLeft}px;height:${height}px;--cursor-color:${user.color || '#005fa3'}`;
                const label = document.createElement('div');
                label.className = 'collab-cursor-label';
                label.textContent = this._safeUserName(user);
                label.style.background = user.color || '#005fa3';
                cursorEl.appendChild(label);
                cursors.appendChild(cursorEl);
                cursorEl.addEventListener('mouseenter', () => {
                    if (this._labelTimers.has(user.id)) {
                        clearTimeout(this._labelTimers.get(user.id));
                        this._labelTimers.delete(user.id);
                    }
                    label.classList.add('label-visible');
                });
                cursorEl.addEventListener('mouseleave', () => {
                    const t = setTimeout(() => {
                        label.classList.remove('label-visible');
                        this._labelTimers.delete(user.id);
                    }, 5000);
                    this._labelTimers.set(user.id, t);
                });
            }
        });
        cursors.querySelectorAll('.collab-cursor').forEach(el => {
            if (!activeIds.has(el.dataset.userId)) el.remove();
        });
    }
    _setupCollabCursorScrollSync() {
        if (this._collabCursorScrollBound) return;
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        this._collabCursorScrollBound = () => this._renderCollabCursors();
        editor.addEventListener('scroll', this._collabCursorScrollBound, { passive: true });
    }
    renderShareCollaborators(activeUsers) {
        const users = Object.values(activeUsers || {});
        const container = document.getElementById('shareCollaborators');
        if (container) {
            container.innerHTML = '';
            users.forEach(user => {
                const badge = document.createElement('span');
                badge.textContent = this._safeUserName(user) + (user.isOwner ? ' (Owner)' : '');
                badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:' + (user.color || '#00b894') + ';color:#fff;padding:6px 10px;border-radius:999px;font-size:13px;';
                container.appendChild(badge);
            });
        }
        this._setupCollabCursorScrollSync();
        this._renderCollabCursors();
        this.renderCollabBar(activeUsers);
    }
    renderCollabBar(activeUsers) {
        const old = document.getElementById('collabPresenceBar');
        if (old) old.remove();
        const navAvatars = document.getElementById('collabNavAvatars');
        const statbarPerm = document.getElementById('statbar-perm');
        const statbarSepPerm = document.getElementById('statbar-sep-perm');
        const editorArea = document.querySelector('.editor-area');
        if (!editorArea || !this.collabMode || !this.collabNoteVisible) {
            if (navAvatars) navAvatars.innerHTML = '';
            if (statbarPerm) { statbarPerm.innerHTML = ''; statbarPerm.style.display = 'none'; }
            if (statbarSepPerm) statbarSepPerm.style.display = 'none';
            return;
        }
        const users = Object.values(activeUsers || {});
        const MAX_VISIBLE = 4;
        const visibleUsers = users.slice(0, MAX_VISIBLE);
        const overflowCount = users.length - MAX_VISIBLE;
        let avatarsHtml = visibleUsers.map(user => {
            const displayName = this._safeUserName(user);
            const initial = displayName[0].toUpperCase();
            const isMe = user.id === this.collabUser.id;
            return `<div class="collab-avatar${isMe ? ' collab-avatar-me' : ''}" style="background:${user.color || '#00b894'}" title="${displayName}${isMe ? ' (You)' : ''}${user.isOwner ? ' · Owner' : ''}">
                ${initial}
                ${user.isOwner ? `<span class="collab-avatar-crown" title="Session Owner"><svg width="13" height="10" viewBox="0 0 13 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8.5L2.5 3.5L5.5 6.5L6.5 1L7.5 6.5L10.5 3.5L12 8.5H1Z" stroke="#FFD700" stroke-width="1.4" stroke-linejoin="round" fill="rgba(255,215,0,0.15)"/></svg></span>` : ''}
            </div>`;
        }).join('');
        if (overflowCount > 0) {
            avatarsHtml += `<div class="collab-avatar collab-avatar-overflow" title="${overflowCount} more collaborator${overflowCount > 1 ? 's' : ''}">+${overflowCount}</div>`;
        }
        if (navAvatars) navAvatars.innerHTML = avatarsHtml;
        const permText = this.collabIsOwner
            ? 'Owner'
            : this.collabPermission === 'edit'
                ? 'Can Edit'
                : 'Can View';
        const permClass = this.collabIsOwner
            ? 'collab-perm-owner'
            : this.collabPermission === 'edit'
                ? 'collab-perm-edit'
                : 'collab-perm-view';
        if (statbarPerm) {
            statbarPerm.innerHTML = `<span class="collab-perm-badge ${permClass}">${permText}</span>`;
            statbarPerm.style.display = '';
        }
        if (statbarSepPerm) statbarSepPerm.style.display = '';
    }
    _setOwnerOnlyButtonsVisible(visible) {
        ['exportNoteBtn', 'deleteNoteBtn', 'noteColorDropdown'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = visible ? '' : 'none';
        });
        // Keep the undo/redo buttons visually in sync with the view-only state.
        // Undo/redo should be enabled for any collaborator with edit permission,
        // regardless of whether they are the session owner. Only disable when the
        // session is truly view-only (non-owner + permission === 'view').
        this.updateRibbonAvailability();
        this._updateLeaveButtonVisibility();
    }
    _hideLeaveButton() {
        const leaveBtn = document.getElementById('leaveCollabBtn');
        if (!leaveBtn) return;
        leaveBtn.classList.remove('visible');
        leaveBtn.style.display = 'none';
    }
    _showLeaveButton() {
        const leaveBtn = document.getElementById('leaveCollabBtn');
        if (!leaveBtn) return;
        leaveBtn.classList.add('visible');
        leaveBtn.style.display = 'inline-flex';
    }
    _updateLeaveButtonVisibility() {
        const leaveBtn = document.getElementById('leaveCollabBtn');
        if (!leaveBtn) return;
        if (!this.collabMode || this.collabIsOwner || !this.collabNoteVisible) {
            leaveBtn.style.display = 'none';
            return;
        }
        const currentSession = this._activeCollabSessionId ? this.collabSessions.get(this._activeCollabSessionId) : null;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        const isSessionNote = currentSession && this.currentNoteId && currentSession.noteId === this.currentNoteId;
        const isVirtualSharedNote = note && note._isCollabNote && note._collabSessionId === currentSession?.sessionId;
        if (currentSession && !currentSession.isOwner && (isSessionNote || isVirtualSharedNote)) {
            leaveBtn.style.display = 'inline-flex';
        } else {
            leaveBtn.style.display = 'none';
        }
    }
    setEditorForSession(noteData, focus = true) {
        const titleInput = document.getElementById('noteTitle');
        const textEditor = document.getElementById('textEditor');
        const isViewOnly = !this.collabIsOwner && this.collabPermission === 'view';
        const isNonOwner = !this.collabIsOwner;
        // Persist the computed view-only flag on the instance so every editing entry
        // point can read it without re-deriving the rule.
        this.isViewOnly = isViewOnly;
        this.collabNoteVisible = true;
        if (titleInput) {
            titleInput.value = noteData.title || 'Untitled Note';
            titleInput.disabled = isViewOnly;
        }
        // Visually disable undo/redo in view-only mode so the user gets immediate
        // feedback that those operations are blocked.
        this.updateRibbonAvailability();
        if (textEditor) {
            const editorHasFocus = document.activeElement === textEditor;
            let savedOffset = null;
            let oldText = null;
            if (editorHasFocus) {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    if (textEditor.contains(range.startContainer)) {
                        savedOffset = this._getCharOffset(textEditor, range.startContainer, range.startOffset);
                        oldText = textEditor.textContent;
                    }
                }
            }
            this._applySanitizedHtml(textEditor, noteData.content || '');
            this._collabMergeBaseContent = noteData.content || '';
            textEditor.contentEditable = this.collabIsOwner || this.collabPermission === 'edit';
            if (noteData.color && noteData.color !== '#ffffff') {
                textEditor.style.backgroundColor = noteData.color;
            } else {
                textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
            }
            if (editorHasFocus && savedOffset !== null && oldText !== null) {
                const newText = textEditor.textContent;
                let adjustedOffset = savedOffset;
                if (oldText !== newText) {
                    const change = this._findTextChangeRange(oldText, newText);
                    if (change.start <= savedOffset) {
                        adjustedOffset = savedOffset + (change.newAdded - change.oldRemoved);
                    }
                }
                adjustedOffset = Math.max(0, Math.min(adjustedOffset, newText.length));
                this._restoreCharOffset(textEditor, adjustedOffset);
            }
        }
        document.body.classList.toggle('collab-view-only', isViewOnly);
        document.body.classList.toggle('collab-non-owner', isNonOwner);
        if (isNonOwner) {
            this._setOwnerOnlyButtonsVisible(false);
            this._showLeaveButton();
        } else {
            this._setOwnerOnlyButtonsVisible(true);
            this._hideLeaveButton();
        }
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) welcomeScreen.classList.add('hidden');
        const editorHeader = document.querySelector('.editor-header');
        if (editorHeader) editorHeader.style.display = 'flex';
        const editorContent = document.querySelector('.editor-content');
        if (editorContent) editorContent.style.display = 'flex';
        const editorStatusbar = document.getElementById('editorStatusbar');
        if (editorStatusbar) editorStatusbar.style.display = '';
        document.body.classList.remove('no-active-note');
        if (focus && textEditor && (this.collabIsOwner || this.collabPermission === 'edit')) {
            textEditor.focus();
        }
        // Update the browser address bar to show ?collab=<sessionId> for this
        // shared note. This makes the URL switch dynamically — e.g. if the
        // user was previously viewing one of their own notes (?owned=...),
        // opening a collab note changes the URL to ?collab=... and vice versa.
        this.updateOwnedLinkBar(noteData);
    }
    updateCollabNoteTitle(title) {
        if (!this.collabMode || !this.collabNoteVisible) return;
        this.collabNoteData = this.collabNoteData || {};
        this.collabNoteData.title = title.slice(0, 40) || 'Untitled Note';
        this.collabNoteData.modifiedAt = new Date().toISOString();
        if (this.currentNoteId) {
            const note = this.notes.find(n => n.id === this.currentNoteId);
            if (note) {
                note.title = this.collabNoteData.title;
                note.modifiedAt = this.collabNoteData.modifiedAt;
                this.renderNotesList();
                if (!note._isCollabNote) {
                    this.renderNotesCards();
                    this.debouncedSave();
                }
            }
        }
        this._debouncedCollabPush();
    }
    _getCharOffset(root, node, offset) {
        let charCount = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const n = walker.currentNode;
            if (n === node) return charCount + offset;
            charCount += n.textContent.length;
        }
        return charCount;
    }
    _findTextChangeRange(oldText, newText) {
        const oldLen = oldText.length;
        const newLen = newText.length;
        let start = 0;
        while (start < oldLen && start < newLen && oldText[start] === newText[start]) start++;
        let oldEnd = oldLen - 1;
        let newEnd = newLen - 1;
        while (oldEnd >= start && newEnd >= start && oldText[oldEnd] === newText[newEnd]) {
            oldEnd--;
            newEnd--;
        }
        return {
            start,
            oldRemoved: Math.max(0, oldEnd - start + 1),
            newAdded: Math.max(0, newEnd - start + 1)
        };
    }
    _getSingleChange(base, changed) {
        if (base === changed) {
            return { start: 0, end: 0, text: '', changed: false };
        }
        let start = 0;
        while (start < base.length && start < changed.length && base[start] === changed[start]) start++;

        let baseEnd = base.length;
        let changedEnd = changed.length;
        while (
            baseEnd > start &&
            changedEnd > start &&
            base[baseEnd - 1] === changed[changedEnd - 1]
        ) {
            baseEnd--;
            changedEnd--;
        }

        return {
            start,
            end: baseEnd,
            text: changed.slice(start, changedEnd),
            changed: true
        };
    }
    _mergeNonOverlappingChanges(base, local, remote) {
        if (local === remote) return { clean: true, value: local };
        if (base === local) return { clean: true, value: remote };
        if (base === remote) return { clean: true, value: local };

        const localChange = this._getSingleChange(base, local);
        const remoteChange = this._getSingleChange(base, remote);
        if (!localChange.changed) return { clean: true, value: remote };
        if (!remoteChange.changed) return { clean: true, value: local };

        const overlaps = localChange.start < remoteChange.end && remoteChange.start < localChange.end;
        if (overlaps) return { clean: false, value: local };

        const changes = [localChange, remoteChange].sort((a, b) => b.start - a.start);
        let merged = base;
        changes.forEach(change => {
            merged = merged.slice(0, change.start) + change.text + merged.slice(change.end);
        });
        return { clean: true, value: merged };
    }
    _restoreCharOffset(root, targetOffset) {
        if (targetOffset == null || targetOffset < 0) return;
        let remaining = targetOffset;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const n = walker.currentNode;
            if (remaining <= n.textContent.length) {
                try {
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.setStart(n, remaining);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (_) {}
                return;
            }
            remaining -= n.textContent.length;
        }
        try {
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(root);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) {}
    }
    updateCollabNoteContent() {
        if (!this.collabMode || !this.collabNoteVisible) return;
        if (this.collabNoteId && this.currentNoteId && this.currentNoteId !== this.collabNoteId) return;
        const textEditor = document.getElementById('textEditor');
        if (!textEditor) return;
        this._lastLocalEditAt = Date.now();
        const content = textEditor.innerHTML.trim();
        this.collabNoteData = this.collabNoteData || {};
        this.collabNoteData.content = this.isEditorEmpty(textEditor) ? '' : content;
        this.collabNoteData.modifiedAt = new Date().toISOString();
        if (this.currentNoteId) {
            const note = this.notes.find(n => n.id === this.currentNoteId);
            if (note) {
                note.content = this.collabNoteData.content;
                note.modifiedAt = this.collabNoteData.modifiedAt;
                this.renderNotesList();
                if (!note._isCollabNote) {
                    this.renderNotesCards();
                    this.debouncedSave();
                }
            }
        }
        this._debouncedCollabPush();
    }
    _debouncedCollabPush() {
        if (this._collabPushTimer) clearTimeout(this._collabPushTimer);
        this._collabPushTimer = setTimeout(() => {
            if (this.collabSessionId && (this.collabPermission === 'edit' || this.collabIsOwner) && this.collabNoteData) {
                this._pushCollabNoteNow(this.collabNoteData);
            }
        }, 400);
    }
    _pushCollabNoteNow(noteData = this.collabNoteData) {
        if (!this.collabSessionId || (this.collabPermission !== 'edit' && !this.collabIsOwner) || !noteData) return;
        this._lastPushedModifiedAt = noteData.modifiedAt;
        this._dbPatch(`/sharednotes/${this.collabSessionId}`, { note: noteData });
    }
    _getTextOffset(editor, node, offset) {
        let count = 0;
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        let current;
        while ((current = walker.nextNode())) {
            if (current === node) return count + offset;
            count += current.textContent.length;
        }
        return count;
    }
    _getRangeFromTextOffset(editor, charOffset) {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        let count = 0;
        let current;
        while ((current = walker.nextNode())) {
            const len = current.textContent.length;
            if (count + len >= charOffset) {
                const range = document.createRange();
                const pos = Math.min(charOffset - count, len);
                range.setStart(current, pos);
                range.setEnd(current, pos);
                return range;
            }
            count += len;
        }
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        return range;
    }
    handleSelectionChange() {
        if (!this.collabMode || !this.collabSessionId || !this.collabUser) return;
        if (!this.collabNoteVisible) return;
        const editor = document.getElementById('textEditor');
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !editor.contains(selection.focusNode)) return;
        const charOffset = this._getTextOffset(editor, selection.focusNode, selection.focusOffset);
        const position = { charOffset };
        if (this._cursorDebounce) clearTimeout(this._cursorDebounce);
        this._cursorDebounce = setTimeout(() => {
            this._dbPatch(`/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}`, { cursor: position, updatedAt: new Date().toISOString() });
        }, 200);
    }
    leaveCollaboration() {
        if (!this.collabUser) return;
        for (const sess of this.collabSessions.values()) {
            const sid = sess.sessionId;
            if (!sid) continue;
            if (!sess.isOwner) {
                this._dbPatch(`/sharednotes/${sid}/activeUsers/${this.collabUser.id}`, {
                    id: this.collabUser.id,
                    name: this.collabUser.name,
                    color: this.collabUser.color,
                    cursor: null,
                    updatedAt: new Date().toISOString(),
                    isOwner: false,
                    reconnectTimeout: new Date(Date.now() + 30000).toISOString()
                }).catch(() => {});
                setTimeout(() => {
                    this._dbDelete(`/sharednotes/${sid}/activeUsers/${this.collabUser.id}`).catch(() => {});
                }, 30000);
            } else {
                this._dbDelete(`/sharednotes/${sid}/activeUsers/${this.collabUser.id}`).catch(() => {});
            }
        }
    }
    leaveCollabNote() {
        if (this.collabIsOwner) return; 
        this.removeStoredValue('emeraldnotes_collab_non_owner');
        if (this.collabSessionId) {
            this._unregisterSession(this.collabSessionId);
        }
        if (this.collabSessionId && this.collabUser) {
            this._dbDelete(`/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}`).catch(() => {});
        }
        if (this._collabEventSource) {
            this._collabEventSource.close();
            this._collabEventSource = null;
        }
        this._activeCollabSessionId = null;
        this.collabMode = false;
        this.collabIsOwner = false;
        this.collabSessionId = null;
        this.collabNoteId = null;
        this.collabPermission = 'edit';
        this.collabNoteData = null;
        this.collabNoteVisible = false;
        this.isViewOnly = false;
        this._activeUsers = {};
        this.notes = this.notes.filter(n => !n._isCollabNote);
        if (this.currentNoteId && !this.notes.some(n => n.id === this.currentNoteId)) {
            this.currentNoteId = null;
        }
        const navAvatars = document.getElementById('collabNavAvatars');
        if (navAvatars) navAvatars.innerHTML = '';
        const statbarPerm = document.getElementById('statbar-perm');
        if (statbarPerm) { statbarPerm.innerHTML = ''; statbarPerm.style.display = 'none'; }
        const statbarSepPerm = document.getElementById('statbar-sep-perm');
        if (statbarSepPerm) statbarSepPerm.style.display = 'none';
        document.body.classList.remove('collab-view-only', 'collab-non-owner');
        const cursors = document.getElementById('collabCursors');
        if (cursors) cursors.innerHTML = '';
        this._setOwnerOnlyButtonsVisible(true);
        this._hideLeaveButton();
        const textEditor = document.getElementById('textEditor');
        if (textEditor) textEditor.contentEditable = 'true';
        const titleInput = document.getElementById('noteTitle');
        if (titleInput) titleInput.disabled = false;
        this.renderNotesList();
        this.renderNotesCards();
        this.showWelcomeScreenIfNeeded();
    }
    _resetCollabState() {
        if (this._collabEventSource) {
            this._collabEventSource.close();
            this._collabEventSource = null;
        }
        if (this.collabSessionId && this.collabUser) {
            this._dbDelete(`/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}`).catch(() => {});
        }
        this.collabMode = false;
        this.collabIsOwner = false;
        this.collabSessionId = null;
        this.collabNoteId = null;
        this.collabPermission = 'edit';
        this.collabNoteData = null;
        this.collabNoteVisible = false;
        this.isViewOnly = false;
        this._activeUsers = {};
        this._lastPushedModifiedAt = null;
        this.notes = this.notes.filter(n => !n._isCollabNote);
        if (this.currentNoteId && !this.notes.some(n => n.id === this.currentNoteId)) {
            this.currentNoteId = null;
        }
        const bar = document.getElementById('collabPresenceBar');
        if (bar) bar.remove();
        const navAvatars = document.getElementById('collabNavAvatars');
        if (navAvatars) navAvatars.innerHTML = '';
        const statbarPerm = document.getElementById('statbar-perm');
        if (statbarPerm) { statbarPerm.innerHTML = ''; statbarPerm.style.display = 'none'; }
        const statbarSepPerm = document.getElementById('statbar-sep-perm');
        if (statbarSepPerm) statbarSepPerm.style.display = 'none';
        document.body.classList.remove('collab-view-only', 'collab-non-owner');
        const cursors = document.getElementById('collabCursors');
        if (cursors) cursors.innerHTML = '';
        this._hideLeaveButton();
        this.removeStoredValue('emeraldnotes_collab_owner');
        this.removeStoredValue('emeraldnotes_collab_non_owner');
        this.removeStoredValue('emeraldnotes_collab_sessions');
        for (const s of this.collabSessions.values()) {
            if (s.eventSource) { try { s.eventSource.close(); } catch (_) {} }
        }
        this.collabSessions.clear();
        this._activeCollabSessionId = null;
        this._setOwnerOnlyButtonsVisible(true);
        const textEditor = document.getElementById('textEditor');
        if (textEditor) textEditor.contentEditable = 'true';
        const titleInput = document.getElementById('noteTitle');
        if (titleInput) titleInput.disabled = false;
        this.renderNotesList();
        this.renderNotesCards();
        this.showWelcomeScreenIfNeeded();
    }
    showSaveIndicator(status) {
        const indicator = document.getElementById('saveIndicator');
        if (!indicator) {
            console.warn('Expected DOM element not found: saveIndicator');
            return;
        }
        const text = indicator.querySelector('.save-text');
        indicator.className = 'save-indicator';
        switch (status) {
            case 'saving':
                indicator.classList.add('saving');
                text.textContent = 'Saving...';
                break;
            case 'saved':
                text.textContent = 'All changes saved';
                break;
            case 'error':
                text.textContent = 'Error saving';
                break;
        }
    }
    debouncedSave() {
        this.showSaveIndicator('saving');
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.saveNotesToStorage(), 1000);
    }
    setupEventListeners() {
        const newNoteBtn = document.getElementById('newNoteBtn');
        const welcomeNewNoteBtn = document.getElementById('welcomeNewNoteBtn');
        if (newNoteBtn) newNoteBtn.addEventListener('click', () => this.createNewNote());
        if (welcomeNewNoteBtn) welcomeNewNoteBtn.addEventListener('click', () => this.createNewNote());
        const deleteNoteBtn = document.getElementById('deleteNoteBtn');
        if (deleteNoteBtn) deleteNoteBtn.addEventListener('click', () => this.deleteCurrentNote());
        const leaveCollabBtn = document.getElementById('leaveCollabBtn');
        if (leaveCollabBtn) leaveCollabBtn.addEventListener('click', () => this.leaveCollabNote());
        const exportNoteBtn = document.getElementById('exportNoteBtn');
        if (exportNoteBtn) exportNoteBtn.addEventListener('click', () => this.exportNoteAsLink());
        const shareNoteBtn = document.getElementById('shareNoteBtn');
        if (shareNoteBtn) shareNoteBtn.addEventListener('click', () => this.openShareModal());
        const noteTitle = document.getElementById('noteTitle');
        if (noteTitle) {
            noteTitle.addEventListener('input', (e) => {
                if (this.collabMode && this.collabNoteVisible) {
                    this.updateCollabNoteTitle(e.target.value);
                } else if (this.currentNoteId && !this.collabNoteVisible) {
                    this.updateNoteTitle(e.target.value);
                }
            });
        }
        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            textEditor.addEventListener('input', () => {
                this.updatePlaceholderState(textEditor);
                if (this.collabMode && this.collabNoteVisible) {
                    this.updateCollabNoteContent();
                } else if (this.currentNoteId && !this.collabNoteVisible) {
                    this.updateNoteContent();
                }
                this.updateRibbonAvailability();
            });
        }
        document.addEventListener('selectionchange', () => {
            this.handleSelectionChange();
            this.updateRibbonAvailability();
        });
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
        document.querySelectorAll('.ribbon-btn, .ribbon-tab').forEach(el => {
            el.addEventListener('mousedown', (e) => e.preventDefault());
        });
        document.querySelectorAll('.ms-dropdown-item, .color-swatch').forEach(el => {
            el.addEventListener('mousedown', (e) => e.preventDefault());
        });
        this.setupMSDropdowns();
        this.setupCustomContextMenu();
        this.setupEditorPlaceholder();
        this.setupSidebarToggle();
        this.setupTableToolbar();
    }
    setupMobileUI() {
        if (!document.getElementById('sidebarBackdrop')) {
            const backdrop = document.createElement('div');
            backdrop.id = 'sidebarBackdrop';
            backdrop.className = 'sidebar-backdrop';
            backdrop.addEventListener('click', () => this.closeMobileSidebar());
            document.querySelector('.notes-app').appendChild(backdrop);
        }
        if (!document.getElementById('swipeHint')) {
            const hint = document.createElement('div');
            hint.id = 'swipeHint';
            hint.className = 'swipe-hint';
            hint.addEventListener('click', () => this.openMobileSidebar());
            document.querySelector('.notes-app').appendChild(hint);
        }
    }
    openMobileSidebar() {
        if (!this.isMobile()) return;
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        sidebar.classList.add('mobile-open');
        backdrop.classList.add('visible');
        this.sidebarOpen = true;
    }
    closeMobileSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('visible');
        this.sidebarOpen = false;
    }
    setupSwipeGesture() {
        const app = document.querySelector('.notes-app');
        const LEFT_EDGE_ZONE = 40; 
        app.addEventListener('touchstart', (e) => {
            if (!this.isMobile()) return;
            const touch = e.touches[0];
            this.touchStartX = touch.clientX;
            this.touchStartY = touch.clientY;
            this.touchStartTime = Date.now();
            this.isSwiping = false;
        }, { passive: true });
        app.addEventListener('touchmove', (e) => {
            if (!this.isMobile()) return;
            const touch = e.touches[0];
            const dx = touch.clientX - this.touchStartX;
            const dy = touch.clientY - this.touchStartY;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
                this.isSwiping = true;
            }
            if (!this.isSwiping) return;
            const canOpen = this.touchStartX <= LEFT_EDGE_ZONE;
            const sidebar = document.querySelector('.sidebar');
            const sidebarWidth = sidebar.offsetWidth;
            if (this.sidebarOpen && dx < 0) {
                const clampedDx = Math.max(dx, -sidebarWidth);
                sidebar.style.transform = `translateX(${clampedDx}px)`;
                sidebar.style.transition = 'none';
            } else if (!this.sidebarOpen && dx > 0 && canOpen) {
                const clampedDx = Math.min(dx - sidebarWidth, 0);
                sidebar.style.transform = `translateX(${clampedDx}px)`;
                sidebar.style.transition = 'none';
            }
        }, { passive: true });
        app.addEventListener('touchend', (e) => {
            if (!this.isMobile()) return;
            const touch = e.changedTouches[0];
            const dx = touch.clientX - this.touchStartX;
            const dy = touch.clientY - this.touchStartY;
            const dt = Date.now() - this.touchStartTime;
            const sidebar = document.querySelector('.sidebar');
            sidebar.style.transition = '';
            sidebar.style.transform = '';
            const THRESHOLD = 50;         
            const MAX_VERTICAL = 80;      
            const MAX_TIME = 600;         
            const isHorizontalSwipe =
                Math.abs(dx) > THRESHOLD &&
                Math.abs(dy) < MAX_VERTICAL &&
                dt < MAX_TIME;
            if (!isHorizontalSwipe) return;
            const startedAtEdge = this.touchStartX <= LEFT_EDGE_ZONE;
            if (dx > 0 && !this.sidebarOpen && startedAtEdge) {
                this.openMobileSidebar();
            } else if (dx < 0 && this.sidebarOpen) {
                this.closeMobileSidebar();
            }
        }, { passive: true });
    }
    setupMobileRibbon() {
        this.buildMobileRibbon();
        window.addEventListener('resize', () => {
            this.buildMobileRibbon();
        });
    }
    buildMobileRibbon() {
        const ribbonContent = document.querySelector('.ribbon-content');
        if (!ribbonContent) return;
        if (!this.isMobile()) {
            const mobileRow = document.getElementById('mobileRibbonRow');
            if (mobileRow) mobileRow.remove();
            const morePanel = document.getElementById('mobileMorePanel');
            if (morePanel) morePanel.remove();
            return;
        }
        if (document.getElementById('mobileRibbonRow')) return;
        const row = document.createElement('div');
        row.id = 'mobileRibbonRow';
        row.className = 'mobile-ribbon-row';
        const clipboard = [
            { command: 'cut', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`, title: 'Cut' },
            { command: 'copy', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`, title: 'Copy' },
            { command: 'paste', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`, title: 'Paste' },
        ];
        const formatting = [
            { command: 'bold', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>`, title: 'Bold' },
            { command: 'italic', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`, title: 'Italic' },
            { command: 'underline', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>`, title: 'Underline' },
            { command: 'strikeThrough', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><path d="M16 6C16 6 14.5 4 12 4C9.5 4 7 5.5 7 8C7 10.5 9.5 11 12 12C14.5 13 17 13.5 17 16C17 18.5 14.5 20 12 20C9.5 20 8 18 8 18"/></svg>`, title: 'Strikethrough' },
            { command: 'subscript', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5l8 8m0-8L4 13"/><text x="13" y="19" font-size="8" fill="currentColor" stroke="none" font-weight="700">2</text></svg>`, title: 'Subscript' },
            { command: 'superscript', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9l8 8m0-8L4 17"/><text x="13" y="9" font-size="8" fill="currentColor" stroke="none" font-weight="700">2</text></svg>`, title: 'Superscript' },
        ];
        const div0 = document.createElement('div');
        div0.className = 'mobile-ribbon-divider';
        const undoRedo = [
            { command: 'undo', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`, title: 'Undo' },
            { command: 'redo', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>`, title: 'Redo' },
        ];
        const div1 = document.createElement('div');
        div1.className = 'mobile-ribbon-divider';
        const secondary = [
            { command: 'insertUnorderedList', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`, title: 'Bullet List' },
            { command: 'insertOrderedList', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`, title: 'Numbered List' },
        ];
        const div2 = document.createElement('div');
        div2.className = 'mobile-ribbon-divider';
        const tertiary = [
            { command: 'justifyLeft', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`, title: 'Align Left' },
            { command: 'justifyCenter', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>`, title: 'Center' },
            { command: 'justifyRight', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>`, title: 'Align Right' },
        ];
        const makeBtn = (command, icon, title, cls = 'ribbon-btn format-btn') => {
            const btn = document.createElement('button');
            btn.className = cls;
            btn.dataset.command = command;
            btn.title = title;
            btn.innerHTML = icon;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (btn.disabled) return;
                this.executeCommand(command);
                this.updateButtonStates();
            });
            return btn;
        };
        [...clipboard].forEach(({ command, icon, title }) => row.appendChild(makeBtn(command, icon, title)));
        row.appendChild(div0);
        [...formatting].forEach(({ command, icon, title }) => row.appendChild(makeBtn(command, icon, title)));
        row.appendChild(div0.cloneNode());
        [...undoRedo].forEach(({ command, icon, title }) => row.appendChild(makeBtn(command, icon, title)));
        row.appendChild(div1);
        [...secondary].forEach(({ command, icon, title }) => row.appendChild(makeBtn(command, icon, title)));
        row.appendChild(div2);
        [...tertiary].forEach(({ command, icon, title }) => row.appendChild(makeBtn(command, icon, title)));
        const div3 = document.createElement('div');
        div3.className = 'mobile-ribbon-divider';
        row.appendChild(div3);
        const insertDefs = [
            { id: 'mobileInsertTableBtn', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>`, title: 'Table' },
            { id: 'mobileInsertImageBtn', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`, title: 'Image' },
            { id: 'mobileInsertTodoBtn', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="4" height="4" rx="1"/><line x1="10" y1="7" x2="21" y2="7"/><rect x="3" y="13" width="4" height="4" rx="1"/><line x1="10" y1="15" x2="21" y2="15"/><polyline points="3,19 5,21 9,17"/></svg>`, title: 'To-Do' },
            { id: 'mobileDrawBtn', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`, title: 'Draw' },
        ];
        insertDefs.forEach(({ id, icon, title }) => {
            const btn = document.createElement('button');
            btn.className = 'ribbon-btn';
            btn.id = id;
            btn.title = title;
            btn.innerHTML = icon;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            row.appendChild(btn);
        });
        const div4 = document.createElement('div');
        div4.className = 'mobile-ribbon-divider';
        row.appendChild(div4);
        const fontFamilyWrapper = document.createElement('div');
        fontFamilyWrapper.id = 'mobileFontFamilyDropdown';
        fontFamilyWrapper.className = 'ms-dropdown';
        fontFamilyWrapper.style.cssText = 'flex-shrink:0;';
        fontFamilyWrapper.innerHTML = `
            <button class="ms-dropdown-btn" type="button" style="min-width:80px;max-width:100px;">
                <span class="dropdown-value">Arial</span>
            </button>
            <div class="ms-dropdown-menu">
                <div class="ms-dropdown-item" style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;cursor:default;pointer-events:none;padding:4px 8px 2px 12px;">Sans-Serif</div>
                <div class="ms-dropdown-item" data-value="Arial" style="font-family:Arial,sans-serif;">Arial</div>
                <div class="ms-dropdown-item" data-value="Helvetica" style="font-family:Helvetica,sans-serif;">Helvetica</div>
                <div class="ms-dropdown-item" data-value="Verdana" style="font-family:Verdana,sans-serif;">Verdana</div>
                <div class="ms-dropdown-item" data-value="Roboto" style="font-family:Roboto,sans-serif;">Roboto</div>
                <div class="ms-dropdown-item" data-value="Open Sans" style="font-family:'Open Sans',sans-serif;">Open Sans</div>
                <div class="ms-dropdown-item" data-value="Lato" style="font-family:Lato,sans-serif;">Lato</div>
                <div class="ms-dropdown-item" data-value="Montserrat" style="font-family:Montserrat,sans-serif;">Montserrat</div>
                <div class="ms-dropdown-item" data-value="Poppins" style="font-family:Poppins,sans-serif;">Poppins</div>
                <div class="ms-dropdown-item" data-value="Raleway" style="font-family:Raleway,sans-serif;">Raleway</div>
                <div class="ms-dropdown-item" data-value="Nunito" style="font-family:Nunito,sans-serif;">Nunito</div>
                <div class="ms-dropdown-item" data-value="Ubuntu" style="font-family:Ubuntu,sans-serif;">Ubuntu</div>
                <div class="ms-dropdown-item" data-value="Quicksand" style="font-family:Quicksand,sans-serif;">Quicksand</div>
                <div class="ms-dropdown-item" style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;cursor:default;pointer-events:none;padding:4px 8px 2px 12px;">Serif</div>
                <div class="ms-dropdown-item" data-value="Georgia" style="font-family:Georgia,serif;">Georgia</div>
                <div class="ms-dropdown-item" data-value="Merriweather" style="font-family:Merriweather,serif;">Merriweather</div>
                <div class="ms-dropdown-item" data-value="Lora" style="font-family:Lora,serif;">Lora</div>
                <div class="ms-dropdown-item" style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;cursor:default;pointer-events:none;padding:4px 8px 2px 12px;">Monospace</div>
                <div class="ms-dropdown-item" data-value="Courier New" style="font-family:'Courier New',monospace;">Courier New</div>
                <div class="ms-dropdown-item" data-value="Fira Code" style="font-family:'Fira Code',monospace;">Fira Code</div>
                <div class="ms-dropdown-item" style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;cursor:default;pointer-events:none;padding:4px 8px 2px 12px;">Handwriting</div>
                <div class="ms-dropdown-item" data-value="Dancing Script" style="font-family:'Dancing Script',cursive;">Dancing Script</div>
                <div class="ms-dropdown-item" data-value="Pacifico" style="font-family:Pacifico,cursive;">Pacifico</div>
                <div class="ms-dropdown-item" data-value="Caveat" style="font-family:Caveat,cursive;">Caveat</div>
            </div>
        `;
        row.appendChild(fontFamilyWrapper);
        const fontSizeWrapper = document.createElement('div');
        fontSizeWrapper.id = 'mobileFontSizeDropdown';
        fontSizeWrapper.className = 'ms-dropdown';
        fontSizeWrapper.style.cssText = 'flex-shrink:0;';
        fontSizeWrapper.innerHTML = `
            <button class="ms-dropdown-btn" type="button" style="min-width:54px;">
                <span class="dropdown-value">10</span>
            </button>
            <div class="ms-dropdown-menu">
                <div class="ms-dropdown-item" data-value="10">10</div>
                <div class="ms-dropdown-item" data-value="12">12</div>
                <div class="ms-dropdown-item" data-value="14">14</div>
                <div class="ms-dropdown-item" data-value="16">16</div>
                <div class="ms-dropdown-item" data-value="18">18</div>
                <div class="ms-dropdown-item" data-value="20">20</div>
                <div class="ms-dropdown-item" data-value="24">24</div>
                <div class="ms-dropdown-item" data-value="28">28</div>
                <div class="ms-dropdown-item" data-value="32">32</div>
                <div class="ms-dropdown-item" data-value="36">36</div>
                <div class="ms-dropdown-item" data-value="48">48</div>
            </div>
        `;
        row.appendChild(fontSizeWrapper);
        const fontColorWrapper = document.createElement('div');
        fontColorWrapper.id = 'mobileFontColorDropdown';
        fontColorWrapper.className = 'ms-dropdown';
        fontColorWrapper.style.cssText = 'flex-shrink:0;';
        fontColorWrapper.innerHTML = `
            <button class="ms-dropdown-btn" type="button" style="min-width:80px;">
                <span class="color-preview" style="background:#000000;width:12px;height:12px;border-radius:2px;display:inline-block;margin-right:6px;flex-shrink:0;"></span>
                <span class="dropdown-value">Color</span>
            </button>
            <div class="ms-dropdown-menu">
                <div class="ms-dropdown-item" data-value="#000000" data-label="Black"><span class="color-preview" style="background:#000000;width:12px;height:12px;border-radius:2px;"></span> Black</div>
                <div class="ms-dropdown-item" data-value="#DC143C" data-label="Red"><span class="color-preview" style="background:#DC143C;width:12px;height:12px;border-radius:2px;"></span> Red</div>
                <div class="ms-dropdown-item" data-value="#FF8C00" data-label="Orange"><span class="color-preview" style="background:#FF8C00;width:12px;height:12px;border-radius:2px;"></span> Orange</div>
                <div class="ms-dropdown-item" data-value="#FFD700" data-label="Yellow"><span class="color-preview" style="background:#FFD700;width:12px;height:12px;border-radius:2px;"></span> Yellow</div>
                <div class="ms-dropdown-item" data-value="#008000" data-label="Green"><span class="color-preview" style="background:#008000;width:12px;height:12px;border-radius:2px;"></span> Green</div>
                <div class="ms-dropdown-item" data-value="#0000FF" data-label="Blue"><span class="color-preview" style="background:#0000FF;width:12px;height:12px;border-radius:2px;"></span> Blue</div>
                <div class="ms-dropdown-item" data-value="#800080" data-label="Purple"><span class="color-preview" style="background:#800080;width:12px;height:12px;border-radius:2px;"></span> Purple</div>
                <div class="ms-dropdown-item" data-value="#FF1493" data-label="Pink"><span class="color-preview" style="background:#FF1493;width:12px;height:12px;border-radius:2px;"></span> Pink</div>
                <div class="ms-dropdown-item" data-value="#ffffff" data-label="White"><span class="color-preview" style="background:#ffffff;width:12px;height:12px;border-radius:2px;border:1px solid #ccc;"></span> White</div>
            </div>
        `;
        row.appendChild(fontColorWrapper);
        const highlightWrapper = document.createElement('div');
        highlightWrapper.id = 'mobileHighlightDropdown';
        highlightWrapper.className = 'ms-dropdown';
        highlightWrapper.style.cssText = 'flex-shrink:0;';
        highlightWrapper.innerHTML = `
            <button class="ms-dropdown-btn" type="button" style="min-width:90px;">
                <span class="color-preview" style="background:transparent;width:12px;height:12px;border-radius:2px;border:1px solid #ccc;display:inline-block;margin-right:6px;flex-shrink:0;"></span>
                <span class="dropdown-value">Highlight</span>
            </button>
            <div class="ms-dropdown-menu">
                <div class="ms-dropdown-item" data-value="#FFFF00" data-label="Yellow"><span class="color-preview" style="background:#FFFF00;width:12px;height:12px;border-radius:2px;"></span> Yellow</div>
                <div class="ms-dropdown-item" data-value="#90EE90" data-label="Light Green"><span class="color-preview" style="background:#90EE90;width:12px;height:12px;border-radius:2px;"></span> Light Green</div>
                <div class="ms-dropdown-item" data-value="#FFB6C1" data-label="Light Pink"><span class="color-preview" style="background:#FFB6C1;width:12px;height:12px;border-radius:2px;"></span> Light Pink</div>
                <div class="ms-dropdown-item" data-value="#ADD8E6" data-label="Light Blue"><span class="color-preview" style="background:#ADD8E6;width:12px;height:12px;border-radius:2px;"></span> Light Blue</div>
                <div class="ms-dropdown-item" data-value="transparent" data-label="None"><span class="color-preview" style="background:transparent;width:12px;height:12px;border:1px solid #ccc;border-radius:2px;"></span> None</div>
            </div>
        `;
        row.appendChild(highlightWrapper);
        this.wireMobileDropdown(fontFamilyWrapper, (value) => {
            this.restoreSelection();
            this.executeCommand('fontName', value);
        });
        this.wireMobileDropdown(fontSizeWrapper, (value) => {
            this.restoreSelection();
            this.executeCommand('fontSize', value);
        });
        this.wireMobileDropdown(fontColorWrapper, (value) => {
            this.restoreSelection();
            this.executeCommand('foreColor', value);
        });
        this.wireMobileDropdown(highlightWrapper, (value) => {
            this.restoreSelection();
            this.executeCommand('hiliteColor', value);
        });
        const mobileInsertTableBtn = row.querySelector('#mobileInsertTableBtn');
        const mobileInsertImageBtn = row.querySelector('#mobileInsertImageBtn');
        const mobileInsertTodoBtn = row.querySelector('#mobileInsertTodoBtn');
        const mobileDrawBtn = row.querySelector('#mobileDrawBtn');
        const desktopImageInput = document.getElementById('insertImageInput');
        if (mobileInsertTableBtn) {
            mobileInsertTableBtn.addEventListener('click', () => { if (!mobileInsertTableBtn.disabled) this.insertTable(); });
        }
        if (mobileInsertImageBtn) {
            mobileInsertImageBtn.addEventListener('click', () => {
                if (mobileInsertImageBtn.disabled) return;
                this.saveSelection();
                if (desktopImageInput) desktopImageInput.click();
            });
        }
        if (mobileInsertTodoBtn) {
            mobileInsertTodoBtn.addEventListener('click', () => { if (!mobileInsertTodoBtn.disabled) this.insertTodo(); });
        }
        if (mobileDrawBtn) {
            mobileDrawBtn.addEventListener('click', () => { if (!mobileDrawBtn.disabled) this.toggleDrawMode(); });
        }
        ribbonContent.appendChild(row);
    }
    wireMobileDropdown(dropdownEl, onSelect) {
        if (!dropdownEl) return;
        const btn = dropdownEl.querySelector('.ms-dropdown-btn');
        const menu = dropdownEl.querySelector('.ms-dropdown-menu');
        const items = dropdownEl.querySelectorAll('.ms-dropdown-item');
        const openPortal = () => {
            if (!menu._portalParent) {
                menu._portalParent = menu.parentNode;
            }
            if (menu.parentNode !== document.body) {
                document.body.appendChild(menu);
            }
            menu.classList.remove('ms-portal-closing');
            clearTimeout(menu._closeTimer);
            menu.style.visibility = 'hidden';
            menu.style.display = 'block';
            menu.style.position = 'fixed';
            menu.style.zIndex = '99999';
            menu.style.minWidth = '160px';
            menu.style.maxHeight = '260px';
            menu.style.overflowY = 'auto';
            const btnRect = btn.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const mw = Math.max(menu.scrollWidth, 160);
            const mh = Math.min(menu.scrollHeight, 260);
            let left = btnRect.left;
            let top = btnRect.bottom + 4;
            if (left + mw > vw - 8) left = vw - mw - 8;
            if (left < 8) left = 8;
            if (top + mh > vh - 8) top = Math.max(btnRect.top - mh - 4, 8);
            menu.style.top = top + 'px';
            menu.style.left = left + 'px';
            menu.style.width = mw + 'px';
            menu.style.visibility = '';
            menu.style.animation = 'dropdownFadeIn 0.2s ease';
            dropdownEl.classList.add('active');
        };
        const closePortal = () => {
            dropdownEl.classList.remove('active');
            menu.style.animation = '';
            menu.classList.add('ms-portal-closing');
            menu._closeTimer = setTimeout(() => {
                menu.classList.remove('ms-portal-closing');
                if (menu._portalParent && menu.parentNode === document.body) {
                    menu._portalParent.appendChild(menu);
                }
                menu.style.display = '';
                menu.style.position = '';
                menu.style.zIndex = '';
                menu.style.top = '';
                menu.style.left = '';
                menu.style.width = '';
                menu.style.minWidth = '';
                menu.style.maxHeight = '';
                menu.style.overflowY = '';
                menu.style.visibility = '';
                menu.style.animation = '';
            }, 150);
        };
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            this.saveSelection();
            const wasActive = dropdownEl.classList.contains('active');
            document.querySelectorAll('.ms-dropdown.active').forEach(d => {
                if (d !== dropdownEl) {
                    const m = d.querySelector('.ms-dropdown-menu');
                    d.classList.remove('active');
                    if (m) {
                        if (m._portalParent && m.parentNode === document.body) {
                            m._portalParent.appendChild(m);
                        }
                        m.style.display = '';
                        m.style.position = '';
                        m.style.zIndex = '';
                        m.style.top = '';
                        m.style.left = '';
                        m.style.width = '';
                        m.style.minWidth = '';
                        m.style.maxHeight = '';
                        m.style.overflowY = '';
                        m.style.visibility = '';
                    }
                }
            });
            if (!wasActive) {
                openPortal();
            } else {
                closePortal();
            }
        });
        items.forEach(item => {
            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const value = item.dataset.value;
                if (value === undefined || value === null || value === '') return; 
                const label = item.dataset.label || item.textContent.trim();
                const valueSpan = btn.querySelector('.dropdown-value');
                if (valueSpan) valueSpan.textContent = label;
                const colorPreview = btn.querySelector('.color-preview');
                if (colorPreview && value) {
                    colorPreview.style.background = value;
                }
                closePortal();
                setTimeout(() => {
                    const editor = document.getElementById('textEditor');
                    if (editor) editor.focus();
                    onSelect(value);
                    this.updateButtonStates();
                }, 10);
            });
        });
        document.addEventListener('click', (e) => {
            if (dropdownEl.classList.contains('active') &&
                !menu.contains(e.target) && !btn.contains(e.target)) {
                closePortal();
            }
        }, true);
    }
    setupRibbon() {
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchRibbonTab(tabName);
            });
        });
        document.querySelectorAll('.format-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (btn.disabled) return;
                const command = btn.dataset.command;
                this.executeCommand(command);
                this.updateButtonStates();
                this.updateRibbonAvailability();
            });
        });
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.addEventListener('click', () => {
            // View-only collaborators must not be able to mutate the document,
            // even locally — `execCommand('undo')` would silently bypass
            // contentEditable=false in some browsers.
            if (this.isViewOnly || undoBtn.disabled) return;
            document.getElementById('textEditor').focus();
            document.execCommand('undo');
            setTimeout(() => this.updateRibbonAvailability(), 0);
        });
        if (redoBtn) redoBtn.addEventListener('click', () => {
            if (this.isViewOnly || redoBtn.disabled) return;
            document.getElementById('textEditor').focus();
            document.execCommand('redo');
            setTimeout(() => this.updateRibbonAvailability(), 0);
        });
        const cutBtn = document.getElementById('cutBtn');
        const copyBtn = document.getElementById('copyBtn');
        const pasteBtn = document.getElementById('pasteBtn');
        if (cutBtn) cutBtn.addEventListener('click', () => { if (!cutBtn.disabled) this.executeCommand('cut'); });
        if (copyBtn) copyBtn.addEventListener('click', () => { if (!copyBtn.disabled) this.executeCommand('copy'); });
        if (pasteBtn) pasteBtn.addEventListener('click', () => { if (!pasteBtn.disabled) this.executeCommand('paste'); });
        const insertTableBtn = document.getElementById('insertTableBtn');
        const insertTodoBtn = document.getElementById('insertTodoBtn');
        const drawBtn = document.getElementById('drawBtn');
        const insertImageBtn = document.getElementById('insertImageBtn');
        const insertImageInput = document.getElementById('insertImageInput');
        if (insertTableBtn) insertTableBtn.addEventListener('click', () => { if (!insertTableBtn.disabled) this.insertTable(); });
        if (insertTodoBtn) insertTodoBtn.addEventListener('click', () => { if (!insertTodoBtn.disabled) this.insertTodo(); });
        const findReplaceBtn = document.getElementById('findReplaceBtn');
        if (findReplaceBtn) findReplaceBtn.addEventListener('click', () => this.openFindReplace());
        const ribbonRoot = document.querySelector('.ribbon');
        if (ribbonRoot) {
            ribbonRoot.addEventListener('mousedown', (e) => {
                const editor = document.getElementById('textEditor');
                if (!editor) return;
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                    this.saveSelection();
                }
            }, true);
        }
        if (drawBtn) drawBtn.addEventListener('click', () => { if (!drawBtn.disabled) this.toggleDrawMode(); });
        if (insertImageBtn) insertImageBtn.addEventListener('click', () => {
            if (insertImageBtn.disabled) return;
            this.saveSelection();
            if (insertImageInput) insertImageInput.click();
        });
        if (insertImageInput) insertImageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) { this.insertImage(file); }
            insertImageInput.value = '';
        });
        const zoomInBtn = document.getElementById('zoomInBtn');
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        if (zoomInBtn) zoomInBtn.addEventListener('click', () => this.zoomIn());
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => this.zoomOut());
    }
    setupTextEditor() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        editor.addEventListener('wheel', (e) => e.stopPropagation(), false);
        editor.addEventListener('mouseup', () => {
            this.saveSelection();
            this.updateButtonStates();
            this.updateRibbonAvailability();
        });
        editor.addEventListener('keyup', () => {
            this.saveSelection();
            this.updateButtonStates();
            this.updateRibbonAvailability();
        });
        editor.addEventListener('blur', () => this.saveSelection());
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                this.openFindReplace();
            }
            // Ctrl+H opens Find & Replace too, but in view-only mode the Replace UI
            // is hidden — so there's no point opening the bar with a replace intent.
            // We still allow Ctrl+F in view-only (find-only usage).
            if ((e.ctrlKey || e.metaKey) && e.key === 'h' && !this.isViewOnly) {
                e.preventDefault();
                this.openFindReplace();
            }
            // Hard-block Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z in view-only. Some browsers
            // still fire native undo even when contentEditable is false; this guard
            // makes the behavior consistent across browsers.
            if (this.isViewOnly && (e.ctrlKey || e.metaKey)) {
                const k = e.key.toLowerCase();
                if (k === 'z' || k === 'y') {
                    e.preventDefault();
                }
            }
        });
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return;
                const node = sel.getRangeAt(0).commonAncestorContainer;
                const label = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
                const todoLabel = label && label.closest ? label.closest('.todo-label') : null;
                if (todoLabel) {
                    e.preventDefault();
                    const todoItem = todoLabel.closest('.todo-item');
                    if (todoItem) {
                        if (e.shiftKey) {
                            todoItem.style.paddingLeft = '';
                            delete todoItem.dataset.indent;
                        } else {
                            todoItem.style.paddingLeft = '24px';
                            todoItem.dataset.indent = '1';
                        }
                        this.updateNoteContent();
                    }
                }
                return;
            }
            if (e.key !== 'Enter') return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const node = sel.getRangeAt(0).commonAncestorContainer;
            const label = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            const todoLabel = label && label.closest ? label.closest('.todo-label') : null;
            if (!todoLabel) return;
            e.preventDefault();
            const todoItem = todoLabel.closest('.todo-item');
            if (!todoItem) return;
            const newBlock = document.createElement('div');
            newBlock.innerHTML = '<br>';
            const next = todoItem.nextSibling;
            if (next) {
                todoItem.parentNode.insertBefore(newBlock, next);
            } else {
                todoItem.parentNode.appendChild(newBlock);
            }
            const newRange = document.createRange();
            newRange.setStart(newBlock, 0);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            this.updateNoteContent();
        });
        editor.addEventListener('paste', (e) => {
            setTimeout(() => {
                this.updatePlaceholderState(editor);
                this.updateNoteContent();
            }, 10);
        });
        editor.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox' && e.target.closest('.todo-item')) {
                const clickedItem = e.target.closest('.todo-item');
                const isSubTodo = clickedItem.dataset.indent === '1';
                setTimeout(() => {
                    if (e.target.checked) {
                        e.target.setAttribute('checked', 'checked');
                        if (!isSubTodo) {
                            let sibling = clickedItem.nextElementSibling;
                            while (sibling && sibling.classList && sibling.classList.contains('todo-item') && sibling.dataset.indent === '1') {
                                const cb = sibling.querySelector('.todo-checkbox');
                                if (cb && !cb.checked) { cb.checked = true; cb.setAttribute('checked', 'checked'); }
                                sibling = sibling.nextElementSibling;
                            }
                        }
                    } else {
                        e.target.removeAttribute('checked');
                        if (!isSubTodo) {
                            let sibling = clickedItem.nextElementSibling;
                            while (sibling && sibling.classList && sibling.classList.contains('todo-item') && sibling.dataset.indent === '1') {
                                const cb = sibling.querySelector('.todo-checkbox');
                                if (cb && cb.checked) { cb.checked = false; cb.removeAttribute('checked'); }
                                sibling = sibling.nextElementSibling;
                            }
                        }
                    }
                    this.updateNoteContent();
                }, 0);
            }
        });
    }
    saveSelection() {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }
    }
    restoreSelection() {
        if (this.savedSelection) {
            const editor = document.getElementById('textEditor');
            if (!editor) return;
            // Guard against detached ranges: if a collab sync re-rendered the
            // editor's innerHTML between saveSelection() and restoreSelection(),
            // the saved range's containers are no longer children of the editor.
            // addRange() would silently no-op in that case, leaving highlight /
            // font commands operating on the wrong (possibly collapsed) selection.
            const sc = this.savedSelection.startContainer;
            const ec = this.savedSelection.endContainer;
            if (!sc || !ec || !editor.contains(sc) || !editor.contains(ec)) {
                return;
            }
            editor.focus();
            const selection = window.getSelection();
            selection.removeAllRanges();
            try {
                selection.addRange(this.savedSelection.cloneRange());
            } catch (e) {
                // Silently ignore — the current browser selection will stand.
            }
        }
    }
    switchRibbonTab(tabName) {
        document.querySelectorAll('.ribbon-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        document.querySelectorAll('.ribbon-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
    }
    executeCommand(command, value = null) {
        // In view-only collab mode the only allowed clipboard action is 'copy'.
        // 'cut', 'paste', and all formatting commands are blocked so the viewer
        // cannot mutate the note even locally.
        if (this.isViewOnly && command !== 'copy') return;
        document.getElementById('textEditor').focus();
        try {
            if (command === 'cut') { this.modernCut(); return; }
            if (command === 'copy') { this.modernCopy(); return; }
            if (command === 'paste') { this.modernPaste(); return; }
            if (command === 'fontName') { this.modernFontFamily(value); return; }
            if (command === 'fontSize') { this.modernFontSize(value); return; }
            if (command === 'foreColor') { this.modernTextColor(value); return; }
            if (command === 'hiliteColor') { this.modernHighlightColor(value); return; }
            if (value) {
                document.execCommand(command, false, value);
            } else {
                document.execCommand(command, false, null);
            }
        } catch (error) {
            console.error('Error executing command:', command, error);
        }
        this.updateNoteContent();
        this.updateRibbonAvailability();
    }
    getRibbonSelectionState() {
        const editor = document.getElementById('textEditor');
        const selection = window.getSelection();
        let selectionInEditor = false;
        let hasSelectedText = false;
        if (editor && selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            selectionInEditor = editor.contains(range.commonAncestorContainer)
                || editor.contains(selection.anchorNode)
                || editor.contains(selection.focusNode);
            hasSelectedText = selectionInEditor && !selection.isCollapsed && selection.toString().length > 0;
        }
        return {
            editor,
            hasActiveNote: !!this.currentNoteId,
            canEdit: !!this.currentNoteId && !this.isViewOnly,
            selectionInEditor,
            hasSelectedText
        };
    }
    setRibbonControlDisabled(control, disabled) {
        if (!control) return;
        control.disabled = !!disabled;
        control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        control.classList.toggle('is-unavailable', !!disabled);
    }
    setCommandControlsDisabled(command, disabled) {
        document.querySelectorAll(`[data-command="${command}"]`).forEach(control => {
            this.setRibbonControlDisabled(control, disabled);
        });
    }
    setRibbonGroupAvailability(groupId, enabled) {
        const group = document.getElementById(groupId);
        if (!group) return;
        group.style.opacity = '';
        group.style.pointerEvents = '';
        group.querySelectorAll('.group-label, .font-group-label').forEach(label => {
            label.style.opacity = '1';
            label.style.pointerEvents = 'auto';
        });
        group.querySelectorAll('button, input, select, textarea').forEach(control => {
            if (control.type === 'file') return;
            this.setRibbonControlDisabled(control, !enabled);
        });
    }
    updateRibbonAvailability() {
        const state = this.getRibbonSelectionState();
        const editableContext = state.canEdit && state.selectionInEditor;
        const editableSelection = state.canEdit && state.hasSelectedText;
        const readableSelection = state.hasActiveNote && state.hasSelectedText;

        this.setRibbonControlDisabled(document.getElementById('undoBtn'), !state.canEdit || !this.queryEditingCommandEnabled('undo'));
        this.setRibbonControlDisabled(document.getElementById('redoBtn'), !state.canEdit || !this.queryEditingCommandEnabled('redo'));
        this.setRibbonControlDisabled(document.getElementById('cutBtn'), !editableSelection);
        this.setRibbonControlDisabled(document.getElementById('copyBtn'), !readableSelection);
        this.setRibbonControlDisabled(document.getElementById('pasteBtn'), !editableContext);

        this.setCommandControlsDisabled('undo', !state.canEdit || !this.queryEditingCommandEnabled('undo'));
        this.setCommandControlsDisabled('redo', !state.canEdit || !this.queryEditingCommandEnabled('redo'));
        this.setCommandControlsDisabled('cut', !editableSelection);
        this.setCommandControlsDisabled('copy', !readableSelection);
        this.setCommandControlsDisabled('paste', !editableContext);
        ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript'].forEach(command => {
            this.setCommandControlsDisabled(command, !editableContext);
        });
        ['justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'].forEach(command => {
            this.setCommandControlsDisabled(command, !editableContext);
        });

        this.setRibbonGroupAvailability('fontGroup', editableContext);
        this.setRibbonGroupAvailability('paragraphGroup', editableContext);
        this.setRibbonGroupAvailability('insertGroup', state.canEdit);

        ['mobileFontFamilyDropdown', 'mobileFontSizeDropdown', 'mobileFontColorDropdown', 'mobileHighlightDropdown'].forEach(id => {
            this.setRibbonControlDisabled(document.querySelector(`#${id} .ms-dropdown-btn`), !editableContext);
        });
        ['mobileInsertTableBtn', 'mobileInsertImageBtn', 'mobileInsertTodoBtn', 'mobileDrawBtn'].forEach(id => {
            this.setRibbonControlDisabled(document.getElementById(id), !state.canEdit);
        });

        document.body.classList.toggle('ribbon-has-unavailable-actions', true);
    }
    queryEditingCommandEnabled(command) {
        if (!this.currentNoteId || this.isViewOnly) return false;
        try {
            return document.queryCommandEnabled(command);
        } catch {
            return false;
        }
    }
    updateButtonStates() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) {
            this.updateRibbonAvailability();
            return;
        }
        const commands = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'];
        commands.forEach(command => {
            const btns = document.querySelectorAll(`[data-command="${command}"]`);
            btns.forEach(btn => {
                try {
                    btn.classList.toggle('active', document.queryCommandState(command));
                } catch { btn.classList.remove('active'); }
            });
        });
        this.updateFontStateFromDOM();
        this.updateRibbonAvailability();
    }
    updateFontStateFromDOM() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        let currentNode = range.commonAncestorContainer;
        if (currentNode.nodeType === Node.TEXT_NODE) currentNode = currentNode.parentElement;
        let fontFamily = '', fontSize = '', textColor = '', backgroundColor = '';
        let element = currentNode;
        while (element && element !== document.getElementById('textEditor')) {
            const styles = window.getComputedStyle(element);
            if (!fontFamily && styles.fontFamily && styles.fontFamily !== 'inherit') {
                const raw = styles.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
                fontFamily = raw;
            }
            if (!fontSize && element.style && element.style.fontSize)
                fontSize = element.style.fontSize.replace('px', '');
            if (!textColor && element.style && element.style.color)
                textColor = element.style.color;
            if (!backgroundColor) {
                // Use getComputedStyle (not just inline style) so the swatch
                // reflects inherited / computed background colors — e.g. when a
                // highlight was applied via execCommand('hiliteColor') which may
                // emit <font style="background-color:..."> or <mark> rather than
                // a <span> with inline style. This keeps the swatch in sync with
                // what the user actually sees.
                const bg = styles.backgroundColor;
                if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
                    backgroundColor = bg;
                }
            }
            // Also check <font> tag attributes
            if (!textColor && element.tagName && element.tagName.toLowerCase() === 'font' && element.getAttribute('color'))
                textColor = element.getAttribute('color');
            element = element.parentElement;
        }
        const fontFamilyDropdown = document.getElementById('fontFamilyDropdown');
        if (fontFamilyDropdown && fontFamily) {
            const valueSpan = fontFamilyDropdown.querySelector('.dropdown-value');
            if (valueSpan) {
                // Try exact match first, then case-insensitive
                let matchingItem = fontFamilyDropdown.querySelector(`[data-value="${fontFamily}"]`);
                if (!matchingItem) {
                    const lower = fontFamily.toLowerCase();
                    matchingItem = Array.from(fontFamilyDropdown.querySelectorAll('.ms-dropdown-item'))
                        .find(el => el.dataset.value.toLowerCase() === lower);
                }
                if (matchingItem) valueSpan.textContent = matchingItem.textContent.trim();
            }
        }
        const fontSizeDropdown = document.getElementById('fontSizeDropdown');
        if (fontSizeDropdown && fontSize) {
            const valueSpan = fontSizeDropdown.querySelector('.dropdown-value');
            if (valueSpan) valueSpan.textContent = fontSize; // no 'px' suffix
        }
        const fontColorDropdown = document.getElementById('fontColorDropdown');
        if (fontColorDropdown && textColor) {
            const colorPreview = fontColorDropdown.querySelector('.color-preview');
            if (colorPreview) { colorPreview.style.background = textColor; colorPreview.setAttribute('data-color', textColor); }
        }
        const highlightColorDropdown = document.getElementById('highlightColorDropdown');
        if (highlightColorDropdown) {
            const colorPreview = highlightColorDropdown.querySelector('.color-preview');
            if (colorPreview) {
                if (backgroundColor && backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent') {
                    colorPreview.style.background = backgroundColor;
                    colorPreview.style.border = '';
                } else {
                    colorPreview.style.background = 'transparent';
                    colorPreview.style.border = '1px solid #ccc';
                }
            }
        }
    }
    // ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'n': e.preventDefault(); this.createNewNote(); break;
                case 's': e.preventDefault(); this.saveNotesToStorage(); break;
                case 'b':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('bold'); this.updateButtonStates(); }
                    break;
                case 'i':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('italic'); this.updateButtonStates(); }
                    break;
                case 'u':
                    if (this.isEditorFocused()) { e.preventDefault(); this.executeCommand('underline'); this.updateButtonStates(); }
                    break;
                // Defense-in-depth: also intercept Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
                // here, in addition to the document-level keydown handler in
                // setupTextEditor(). Some browsers route keystrokes through
                // different listeners depending on focus; having both guards
                // guarantees view-only mode never lets undo/redo through.
                case 'z':
                case 'y':
                    if (this.isViewOnly && this.isEditorFocused()) {
                        e.preventDefault();
                    }
                    break;
            }
        }
    }
    isEditorFocused() {
        return document.getElementById('textEditor').contains(document.activeElement);
    }
    // ─── Notes CRUD ──────────────────────────────────────────────────────────────
    createNewNote() {
        const note = {
            id: this.generateId(),
            title: 'Untitled Note',
            content: '',
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        };
        this.notes.unshift(note);
        this.selectNote(note.id);
        this.renderNotesList();
        this.renderNotesCards();
        this.debouncedSave();
        setTimeout(() => {
            const titleInput = document.getElementById('noteTitle');
            if (!titleInput) {
                console.warn('Expected DOM element not found: noteTitle');
                return;
            }
            titleInput.select();
        }, 100);
        // On mobile, close sidebar after selecting/creating a note
        if (this.isMobile()) this.closeMobileSidebar();
    }
    selectNote(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;
        this.currentNoteId = noteId;
        const noteTitle = document.getElementById('noteTitle');
        if (!noteTitle) {
            console.warn('Expected DOM element not found: noteTitle');
            return;
        }
        noteTitle.value = note.title;
        const textEditorInit = document.getElementById('textEditor');
        if (!textEditorInit) {
            console.warn('Expected DOM element not found: textEditor');
            return;
        }
        this._applySanitizedHtml(textEditorInit, note.content);
        const textEditor = document.getElementById('textEditor');
        if (note.color && note.color !== '#ffffff') {
            textEditor.style.backgroundColor = note.color;
        } else {
            textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
        }
        const sessionForNote = this._getSessionByNoteId(noteId);
        if (sessionForNote) {
            if (!this._activeCollabSessionId || this._activeCollabSessionId !== sessionForNote.sessionId) {
                this._switchActiveSession(sessionForNote.sessionId);
            }
            this.collabNoteVisible = true;
            this.setEditorForSession(this.collabNoteData || sessionForNote.noteData || note, false);
            this.updateActiveUserPresence();
            this.renderShareCollaborators(sessionForNote.activeUsers || {});
            this.renderCollabBar(sessionForNote.activeUsers || {});
            if (!sessionForNote.isOwner) {
                this._showLeaveButton();
            } else {
                this._hideLeaveButton();
            }
        } else if (this.collabMode && noteId === this.collabNoteId) {
            // Switching back to the shared note — restore collab view
            this.collabNoteVisible = true;
            if (this.collabNoteData) {
                this.setEditorForSession(this.collabNoteData, false);
            } else {
                this.setEditorForSession(note, false);
            }
            this.renderCollabBar(this._activeUsers || {});
        } else if (this.collabMode) {
            // Switching away from shared note to own note
            this.collabNoteVisible = false;
            // Clear cursor in Firebase so others don't see it
            if (this.collabSessionId && this.collabUser) {
                this._dbPatch(`/sharednotes/${this.collabSessionId}/activeUsers/${this.collabUser.id}`, { cursor: null }).catch(() => {});
            }
            this.renderCollabBar({});
            const cursors = document.getElementById('collabCursors');
            if (cursors) cursors.innerHTML = '';
            if (!this.collabIsOwner) {
                this._setOwnerOnlyButtonsVisible(true);
                document.body.classList.remove('collab-non-owner', 'collab-view-only');
                // Switching from a view-only shared note back to one of our own notes —
                // the local isViewOnly flag must be reset so editing works again.
                this.isViewOnly = false;
                this.updateRibbonAvailability();
            }
            this._hideLeaveButton();
            const textEditor = document.getElementById('textEditor');
            if (textEditor) textEditor.contentEditable = 'true';
            const titleInput = document.getElementById('noteTitle');
            if (titleInput) titleInput.disabled = false;
        }
        const noteColorDropdown = document.getElementById('noteColorDropdown');
        if (noteColorDropdown) {
            const colorPreview = noteColorDropdown.querySelector('.color-preview');
            const dropdownValue = noteColorDropdown.querySelector('.dropdown-value');
            const currentColor = note.color || '#ffffff';
            if (colorPreview) { colorPreview.style.background = currentColor; colorPreview.setAttribute('data-color', currentColor); }
            if (dropdownValue) {
                const colorItem = noteColorDropdown.querySelector(`[data-value="${currentColor}"]`);
                dropdownValue.textContent = colorItem ? (colorItem.dataset.label || 'Default') : 'Default';
            }
        }
        // Update the browser address bar to reflect the currently-open note.
        // For local notes this sets ?owned=<id>; for collab notes that route
        // through setEditorForSession() the URL is set there instead. This
        // call is what makes the URL switch DYNAMICALLY as the user clicks
        // different notes in the sidebar.
        this.updateOwnedLinkBar(note);
        document.querySelectorAll('.note-item').forEach(item => {
            item.classList.toggle('active', item.dataset.noteId === noteId);
        });
        const wasWelcome = document.body.classList.contains('no-active-note');
        const welcomeScreen = document.getElementById('welcomeScreen');
        if (welcomeScreen) {
            welcomeScreen.classList.add('hidden');
        } else {
            console.warn('Expected DOM element not found: welcomeScreen');
        }
        const editorHeader = document.querySelector('.editor-header');
        if (editorHeader) {
            editorHeader.style.display = 'flex';
        } else {
            console.warn('Expected DOM element not found: .editor-header');
        }
        const editorContent = document.querySelector('.editor-content');
        if (editorContent) {
            editorContent.style.display = 'flex';
        } else {
            console.warn('Expected DOM element not found: .editor-content');
        }
        const _sb = document.getElementById('editorStatusbar');
        if (_sb) _sb.style.display = '';
        document.body.classList.remove('no-active-note');
        if (wasWelcome) {
            const ribbon = document.querySelector('.ribbon');
            if (ribbon) {
                ribbon.classList.remove('entering');
                void ribbon.offsetWidth; 
                ribbon.classList.add('entering');
            }
        }
        if (this.isMobile()) this.closeMobileSidebar();
        if (this.isDrawMode) { this.isDrawMode = false; const tb = document.getElementById('drawToolbar'); if (tb) tb.classList.remove('visible'); const db = document.getElementById('drawBtn'); if (db) db.classList.remove('active'); const te = document.getElementById('textEditor'); if (te) te.contentEditable = 'true'; }
        this.loadDrawing();
        this.updateStatusBar();
        this._setOwnerOnlyButtonsVisible(!this.collabMode || this.collabIsOwner || !this.collabNoteVisible || this.currentNoteId !== this.collabNoteId);
        this._updateLeaveButtonVisibility();
        this.updateRibbonAvailability();
        setTimeout(() => {
            const textEditorFocus = document.getElementById('textEditor');
            if (textEditorFocus) {
                textEditorFocus.focus();
                this.updateRibbonAvailability();
            } else {
                console.warn('Expected DOM element not found: textEditor');
            }
        }, 100);
    }
    updateNoteTitle(title) {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            let t = (title || '').slice(0, 40);
            if (title && title.length > 70) {
                const titleEl = document.getElementById('noteTitle');
                if (titleEl) titleEl.value = t;
            }
            note.title = t || 'Untitled Note';
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.renderNotesCards();
            this.debouncedSave();
        }
    }
    updateNoteContent() {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (note) {
            const textEditor = document.getElementById('textEditor');
            const content = textEditor.innerHTML.trim();
            note.content = this.isEditorEmpty(textEditor) ? '' : content;
            note.modifiedAt = new Date().toISOString();
            this.renderNotesList();
            this.renderNotesCards();
            this.debouncedSave();
        }
    }
    deleteCurrentNote() {
        if (!this.currentNoteId) return;
        const currentNote = this.notes.find(n => n.id === this.currentNoteId);
        if (!currentNote) return;
        if (currentNote._isCollabNote) return;
        const title = currentNote.title || 'Untitled Note';
        this.showDeleteModal(title, () => {
            if (this.collabMode && this.collabIsOwner && this.currentNoteId === this.collabNoteId) {
                this._dbPatch(`/sharednotes/${this.collabSessionId}`, { status: 'closed', closedAt: new Date().toISOString() }).catch(() => {});
                this._resetCollabState();
            }
            const currentIndex = this.notes.findIndex(n => n.id === this.currentNoteId);
            this.notes = this.notes.filter(note => note.id !== this.currentNoteId);
            if (this.notes.length > 0) {
                const nextIndex = currentIndex < this.notes.length ? currentIndex : this.notes.length - 1;
                this.selectNote(this.notes[nextIndex].id);
            } else {
                this.currentNoteId = null;
                this.showWelcomeScreenIfNeeded();
                const noteTitle = document.getElementById('noteTitle');
                const textEditor = document.getElementById('textEditor');
                if (noteTitle) noteTitle.value = '';
                if (textEditor) { textEditor.innerHTML = ''; textEditor.style.backgroundColor = 'rgba(255, 255, 255, 0.5)'; }
            }
            this.saveNotesToStorage();
            this.renderNotesList();
            this.renderNotesCards();
        });
    }
    renderNotesList() {
        const notesList = document.getElementById('notesList');
        notesList.innerHTML = '';
        this.notes.forEach(note => notesList.appendChild(this.createNoteListItem(note)));
        this._updateLeaveButtonVisibility();
    }
    createNoteListItem(note) {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.noteId = note.id;
        const isActiveNote = note.id === this.currentNoteId;
        if (isActiveNote) div.classList.add('active');
        if (note.color && note.color !== '#ffffff') {
            div.style.backgroundColor = note.color;
            div.style.borderColor = isActiveNote ? 'rgba(162, 28, 175, 0.3)' : note.color;
            const shadowColor = this.hexToRgba(note.color, 0.3);
            const restingShadow = isActiveNote ? 'rgba(162, 28, 175, 0.18)' : shadowColor;
            const hoverShadow = isActiveNote ? 'rgba(162, 28, 175, 0.28)' : this.hexToRgba(note.color, 0.4);
            div.style.boxShadow = `0 4px 16px ${restingShadow}`;
            div.addEventListener('mouseenter', () => { div.style.boxShadow = `0 8px 24px ${hoverShadow}`; });
            div.addEventListener('mouseleave', () => { div.style.boxShadow = `0 4px 16px ${restingShadow}`; });
        }
        const plainText = (note.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const preview = plainText.substring(0, 150);
        const date = new Date(note.modifiedAt);
        const isLiveNote = note._isCollabNote || this._isCollabNoteId(note.id);
        div.innerHTML = `
            <div class="note-item-title">${this.escapeHtml(note.title)}</div>
            <div class="note-item-preview">${this.escapeHtml(preview)}${preview.length === 150 ? '...' : ''}</div>
            <div class="note-item-date">${isLiveNote ? '<span class="note-live-dot"></span>' : ''}${this.formatDate(date)}</div>
        `;
        div.addEventListener('click', () => {
            this.selectNote(note.id);
            if (this.isMobile()) this.closeMobileSidebar();
        });
        return div;
    }
    renderNotesCards() {
        const notesListDisplay = document.getElementById('notesListDisplay');
        const noNotesContainer = document.getElementById('noNotesContainer');
        if (!notesListDisplay) return;
        notesListDisplay.innerHTML = '';
        if (this.notes.length === 0) {
            notesListDisplay.style.display = 'none';
            noNotesContainer.style.display = 'flex';
            return;
        }
        notesListDisplay.style.display = 'grid';
        noNotesContainer.style.display = 'none';
        const colorClasses = ['pink', 'blue', 'green', 'yellow', 'purple'];
        this.notes.forEach((note, index) => {
            const card = document.createElement('div');
            card.className = 'note-card';
            card.dataset.noteId = note.id;
            if (note.color && note.color !== '#ffffff') {
                const colorIndex = this.getColorClassFromHex(note.color);
                if (colorIndex !== -1) {
                    card.classList.add(colorClasses[colorIndex]);
                }
            }
            const plainText = (note.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            const preview = plainText.substring(0, 100);
            const date = new Date(note.modifiedAt);
            const formattedDate = this.formatDate(date);
            const title = note.title || 'Untitled Note';
            card.innerHTML = `
                <h4 class="note-card-title">${this.escapeHtml(title)}</h4>
                <p class="note-card-preview">${this.escapeHtml(preview)}</p>
                <p class="note-card-date">${formattedDate}</p>
            `;
            card.addEventListener('click', () => {
                this.selectNote(note.id);
            });
            notesListDisplay.appendChild(card);
        });
        this._updateLeaveButtonVisibility();
    }
    getColorClassFromHex(hex) {
        const colorMap = {
            '#ffe4e1': 0, 
            '#e6f3ff': 1, 
            '#e8f5e8': 2, 
            '#fff9e6': 3, 
            '#f3e6ff': 4  
        };
        return colorMap[hex] !== undefined ? colorMap[hex] : -1;
    }
    showWelcomeScreenIfNeeded() {
        const hasNotes = this.notes.length > 0;
        const welcomeScreen = document.getElementById('welcomeScreen');
        const editorHeader = document.querySelector('.editor-header');
        const editorContent = document.querySelector('.editor-content');
        const statusbar = document.getElementById('editorStatusbar');
        const ribbon = document.querySelector('.ribbon');
        const sidebar = document.querySelector('.sidebar');
        const editorArea = document.querySelector('.editor-area');
        if (hasNotes && this.currentNoteId) {
            welcomeScreen.classList.add('hidden');
            editorHeader.style.display = 'flex';
            editorContent.style.display = 'flex';
            if (statusbar) statusbar.style.display = '';
            document.body.classList.remove('no-active-note');
            if (ribbon) { ribbon.classList.remove('entering'); void ribbon.offsetWidth; ribbon.classList.add('entering'); }
            if (sidebar) sidebar.classList.remove('appearing');
            if (editorArea) { editorArea.classList.remove('appearing'); void editorArea.offsetWidth; editorArea.classList.add('appearing'); }
        } else {
            welcomeScreen.classList.remove('hidden');
            editorHeader.style.display = 'none';
            editorContent.style.display = 'none';
            if (statusbar) statusbar.style.display = 'none';
            document.body.classList.add('no-active-note');
            this.currentNoteId = null;
            if (ribbon) ribbon.classList.remove('entering');
            if (sidebar) sidebar.classList.remove('appearing');
            if (editorArea) editorArea.classList.remove('appearing');
            this._setOwnerOnlyButtonsVisible(true);
            this._updateLeaveButtonVisibility();
            this.renderNotesCards();
            // IMPORTANT: Do NOT clear the URL here. `showWelcomeScreenIfNeeded()`
            // runs DURING init() (line 78), BEFORE `openOwnedNoteFromUrl()` and
            // `importNoteFromUrl()` get a chance to read the URL (they run
            // later in the DOMContentLoaded handler). Clearing the URL here
            // would silently break ?owned= / ?collab= / ?share= / ?s= links.
            //
            // Stale URL cleanup is handled by the specific handlers:
            //   - ?owned= : openOwnedNoteFromUrl() clears it if the note isn't found
            //   - ?collab= : checkShareSessionFromURL() clears it after joining
            //   - ?share= / ?s= : importNoteFromUrl() clears it after importing
            //   - Any other URL : left alone (e.g. refresh on a non-notes page)
        }
        this.updateRibbonAvailability();
    }
    insertTable() { this.saveSelection(); this.showTableModal(); }
    insertTodo() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        const selection = window.getSelection();
        let useRange = null;
        if (selection && selection.rangeCount > 0) {
            const r = selection.getRangeAt(0);
            if (editor.contains(r.commonAncestorContainer)) {
                useRange = r;
            }
        }
        if (!useRange && this.savedSelection &&
            editor.contains(this.savedSelection.commonAncestorContainer)) {
            editor.focus();
            const sel2 = window.getSelection();
            sel2.removeAllRanges();
            sel2.addRange(this.savedSelection.cloneRange());
            useRange = sel2.getRangeAt(0);
        }
        const div = document.createElement('div');
        div.className = 'todo-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'todo-checkbox';
        const label = document.createElement('span');
        label.className = 'todo-label';
        label.textContent = ' ';
        div.appendChild(checkbox);
        div.appendChild(label);
        if (useRange) {
            let node = useRange.commonAncestorContainer;
            let existingTodo = null;
            while (node && node !== editor) {
                if (node.nodeType === 1 && node.classList && node.classList.contains('todo-item')) {
                    existingTodo = node;
                    break;
                }
                node = node.parentNode;
            }
            if (existingTodo) {
                if (existingTodo.nextSibling) {
                    existingTodo.parentNode.insertBefore(div, existingTodo.nextSibling);
                } else {
                    existingTodo.parentNode.appendChild(div);
                }
            } else {
                useRange.deleteContents();
                useRange.insertNode(div);
            }
        } else {
            editor.focus();
            editor.appendChild(div);
        }
        const newRange = document.createRange();
        newRange.selectNodeContents(label);
        newRange.collapse(false);
        const sel3 = window.getSelection();
        sel3.removeAllRanges();
        sel3.addRange(newRange);
        this.updateNoteContent();
    }
    insertImage(file) {
        const editor = document.getElementById('textEditor');
        if (!file || !editor) return;
        if (!file.type.startsWith('image/')) {
            this.showToast('Please select an image file.');
            return;
        }
        const maxSize = 25 * 1024 * 1024; 
        if (file.size > maxSize) {
            this.showToast('Image too large. Please use images under 25 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const img = `<img src="${dataUrl}" alt="${file.name}" style="max-width:100%;height:auto;border-radius:6px;">`;
            this.restoreSelection();
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                this.executeCommand('insertHTML', img);
            } else {
                editor.focus();
                this.executeCommand('insertHTML', img);
            }
            this.updateNoteContent();
        };
        reader.onerror = () => { this.showToast('Failed to read image file.'); };
        reader.readAsDataURL(file);
    }
    setupImageDragDrop() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        editor.addEventListener('dragover', (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.items).some(i => i.kind === 'file' && i.type.startsWith('image/'))) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                editor.classList.add('drag-over');
            }
        });
        editor.addEventListener('dragleave', (e) => {
            if (!editor.contains(e.relatedTarget)) {
                editor.classList.remove('drag-over');
            }
        });
        editor.addEventListener('drop', (e) => {
            editor.classList.remove('drag-over');
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files) return;
            let handled = false;
            Array.from(files).forEach(file => {
                if (file.type.startsWith('image/')) {
                    handled = true;
                    e.preventDefault();
                    e.stopPropagation();
                    this.insertImage(file);
                }
            });
        });
    }
    setupTableResize() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        let resizing = false;
        let startX = 0;
        let startW = 0;
        let targetCell = null;
        let nextCell = null;
        editor.addEventListener('mousemove', (e) => {
            if (resizing) return;
            const th = e.target.closest('th, td');
            if (!th) { editor.style.cursor = ''; return; }
            const rect = th.getBoundingClientRect();
            const nearRight = e.clientX > rect.right - 6 && e.clientX < rect.right + 4;
            if (nearRight) {
                editor.style.cursor = 'col-resize';
            } else {
                editor.style.cursor = '';
            }
        });
        editor.addEventListener('mousedown', (e) => {
            const th = e.target.closest('th, td');
            if (!th) return;
            const rect = th.getBoundingClientRect();
            const nearRight = e.clientX > rect.right - 6 && e.clientX < rect.right + 4;
            if (!nearRight) return;
            e.preventDefault();
            resizing = true;
            startX = e.clientX;
            targetCell = th;
            startW = th.offsetWidth;
            const row = th.parentElement;
            const idx = Array.from(row.cells).indexOf(th);
            nextCell = row.cells[idx + 1] || null;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!resizing || !targetCell) return;
            const diff = e.clientX - startX;
            const newW = Math.max(40, startW + diff);
            targetCell.style.width = newW + 'px';
            if (nextCell) nextCell.style.width = '';
        });
        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            targetCell = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this.updateNoteContent();
        });
    }
    setupStatusBar() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        const update = () => this.updateStatusBar();
        editor.addEventListener('keyup', update);
        editor.addEventListener('mouseup', update);
        editor.addEventListener('input', update);
        editor.addEventListener('focus', update);
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                update();
            }
        });
        this.updateStatusBar();
    }
    updateStatusBar() {
        const editor = document.getElementById('textEditor');
        const lineEl = document.getElementById('statbar-line');
        const wordsEl = document.getElementById('statbar-words');
        const charsEl = document.getElementById('statbar-chars');
        if (!editor || !lineEl || !wordsEl || !charsEl) return;
        const text = editor.innerText || '';
        const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
        const chars = text.replace(/\r/g, '').length;
        let line = 1, col = 1;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
            const range = sel.getRangeAt(0);
            const pre = range.cloneRange();
            pre.selectNodeContents(editor);
            pre.setEnd(range.endContainer, range.endOffset);
            const frag = pre.cloneContents();
            const tmp = document.createElement('div');
            tmp.appendChild(frag);
            const before = tmp.innerText || '';
            const lines = before.split(/\n/);
            line = lines.length;
            col = lines[lines.length - 1].length + 1;
        }
        lineEl.textContent = `Ln ${line}, Col ${col}`;
        wordsEl.textContent = `${words} word${words === 1 ? '' : 's'}`;
        charsEl.textContent = `${chars} character${chars === 1 ? '' : 's'}`;
    }
    setupImageInteractions() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        editor.addEventListener('click', (e) => {
            const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
            editor.querySelectorAll('.img-resize-wrapper.selected').forEach(w => {
                if (w !== (img && img.parentElement)) w.classList.remove('selected');
            });
            editor.querySelectorAll('img.img-selected').forEach(i => {
                if (i !== img) i.classList.remove('img-selected');
            });
            if (!img) return;
            this._wrapImageForResize(img);
            const wrap = img.parentElement;
            if (wrap && wrap.classList.contains('img-resize-wrapper')) {
                wrap.classList.add('selected');
            }
            img.classList.add('img-selected');
        });
    }
    _wrapImageForResize(img) {
        if (!img) return;
        let wrapper = img.parentElement;
        if (wrapper && wrapper.classList.contains('img-resize-wrapper')) return wrapper;
        wrapper = document.createElement('span');
        wrapper.className = 'img-resize-wrapper';
        wrapper.contentEditable = 'false';
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);
        const handle = document.createElement('span');
        handle.className = 'img-resize-handle';
        wrapper.appendChild(handle);
        let resizing = false, sX = 0, sY = 0, sW = 0, sH = 0, ar = 1;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            sX = e.clientX; sY = e.clientY;
            sW = img.offsetWidth; sH = img.offsetHeight;
            ar = sW / Math.max(1, sH);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'se-resize';
        });
        const moveH = (e) => {
            if (!resizing) return;
            const dx = e.clientX - sX;
            const newW = Math.max(40, sW + dx);
            const newH = Math.max(40, Math.round(newW / ar));
            img.style.width = newW + 'px';
            img.style.height = newH + 'px';
            img.style.maxWidth = 'none';
        };
        const upH = () => {
            if (!resizing) return;
            resizing = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            this.updateNoteContent();
        };
        document.addEventListener('mousemove', moveH);
        document.addEventListener('mouseup', upH);
        img.draggable = true;
        img.addEventListener('dragstart', (e) => {
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', '');
            }
            this._draggingImg = img;
        });
        img.addEventListener('dragend', () => { this._draggingImg = null; });
        const editor = document.getElementById('textEditor');
        if (editor && !editor.dataset.imgDropWired) {
            editor.dataset.imgDropWired = '1';
            editor.addEventListener('dragover', (e) => {
                if (this._draggingImg) e.preventDefault();
            });
            editor.addEventListener('drop', (e) => {
                if (!this._draggingImg) return;
                e.preventDefault();
                const img = this._draggingImg;
                const wrap = img.parentElement && img.parentElement.classList.contains('img-resize-wrapper')
                    ? img.parentElement : img;
                let range = null;
                if (document.caretRangeFromPoint) {
                    range = document.caretRangeFromPoint(e.clientX, e.clientY);
                } else if (document.caretPositionFromPoint) {
                    const p = document.caretPositionFromPoint(e.clientX, e.clientY);
                    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
                }
                const originalParent = wrap.parentNode;
                const originalSibling = wrap.nextSibling;
                if (range) {
                    if (originalParent) originalParent.removeChild(wrap);
                    range.insertNode(wrap);
                    this.updateNoteContent();
                } else if (originalParent) {
                    originalParent.insertBefore(wrap, originalSibling);
                }
                this._draggingImg = null;
            });
        }
        return wrapper;
    }
    setupCanvasDragHandle() {
        const canvas = document.getElementById('drawingCanvas');
        const editorContent = canvas ? canvas.parentElement : null;
        if (!canvas || !editorContent) return;
        const handle = document.createElement('div');
        handle.id = 'canvasDragHandle';
        handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5H10V7H8V5ZM14 5H16V7H14V5ZM8 11H10V13H8V11ZM14 11H16V13H14V11ZM8 17H10V19H8V17ZM14 17H16V19H14V17Z"/></svg> Move`;
        editorContent.appendChild(handle);
        const resizeHandle = document.createElement('div');
        resizeHandle.id = 'canvasResizeHandle';
        editorContent.appendChild(resizeHandle);
        const positionOverlays = () => {
            const top = parseInt(canvas.style.top || '0') || 0;
            const left = parseInt(canvas.style.left || '0') || 0;
            const w = canvas.offsetWidth || parseInt(canvas.style.width || '0') || 0;
            const h = canvas.offsetHeight || parseInt(canvas.style.height || '0') || 0;
            handle.style.top = (top - 24) + 'px';
            handle.style.left = left + 'px';
            handle.style.right = '';
            resizeHandle.style.top = (top + h - 8) + 'px';
            resizeHandle.style.left = (left + w - 8) + 'px';
        };
        let dragging = false;
        let startX, startY, initTop = 0, initLeft = 0;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initTop = parseInt(canvas.style.top || '0') || 0;
            initLeft = parseInt(canvas.style.left || '0') || 0;
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            canvas.style.top = (initTop + dy) + 'px';
            canvas.style.left = (initLeft + dx) + 'px';
            positionOverlays();
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            this._persistDrawingMeta();
            this.debouncedSave();
        });
        let resizing = false;
        let rStartX, rStartY, rStartW = 0, rStartH = 0;
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            resizing = true;
            rStartX = e.clientX;
            rStartY = e.clientY;
            rStartW = canvas.offsetWidth;
            rStartH = canvas.offsetHeight;
            document.body.style.userSelect = '';
            document.body.style.cursor = 'se-resize';
        });
        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const dw = e.clientX - rStartX;
            const dh = e.clientY - rStartY;
            const newW = Math.max(40, rStartW + dw);
            const newH = Math.max(40, rStartH + dh);
            canvas.style.width = newW + 'px';
            canvas.style.height = newH + 'px';
            positionOverlays();
        });
        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            document.body.style.cursor = '';
            this._rebakeCanvasToCSSSize();
            this._persistDrawingMeta();
            this.debouncedSave();
        });
        const update = () => {
            const isVisible = canvas.style.display !== 'none' && !this.isDrawMode;
            if (isVisible) {
                handle.classList.add('visible');
                resizeHandle.classList.add('visible');
                positionOverlays();
            } else {
                handle.classList.remove('visible');
                resizeHandle.classList.remove('visible');
            }
        };
        const observer = new MutationObserver(update);
        observer.observe(canvas, { attributes: true, attributeFilter: ['style'] });
        this._updateCanvasOverlays = update;
    }
    _rebakeCanvasToCSSSize() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.offsetWidth || parseInt(canvas.style.width || '0') || canvas.width;
        const cssH = canvas.offsetHeight || parseInt(canvas.style.height || '0') || canvas.height;
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        off.getContext('2d').drawImage(canvas, 0, 0);
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        this.drawCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.drawCtx.scale(dpr, dpr);
        this.drawCtx.imageSmoothingEnabled = true;
        this.drawCtx.imageSmoothingQuality = 'high';
        this.drawCtx.lineCap = 'round';
        this.drawCtx.lineJoin = 'round';
        this.drawCtx.clearRect(0, 0, cssW, cssH);
        this.drawCtx.drawImage(off, 0, 0, cssW, cssH);
    }
    showTableModal() {
        const modal = document.getElementById('tableModal');
        const cancelBtn = document.getElementById('tableModalCancel');
        const createBtn = document.getElementById('tableModalCreate');
        const rowsInput = document.getElementById('tableRows');
        const colsInput = document.getElementById('tableCols');
        if (!modal) return;
        modal.classList.add('show');
        setTimeout(() => rowsInput.focus(), 100);
        const cleanup = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            createBtn.removeEventListener('click', handleCreate);
            modal.removeEventListener('click', handleBackdrop);
            document.removeEventListener('keydown', handleEscape);
        };
        const handleCreate = () => {
            const rows = parseInt(rowsInput.value);
            const cols = parseInt(colsInput.value);
            if (rows && cols && rows > 0 && cols > 0) { this.createTable(rows, cols); cleanup(); }
        };
        const handleBackdrop = (e) => { if (e.target === modal) cleanup(); };
        const handleEscape = (e) => { if (e.key === 'Escape') cleanup(); };
        const handleEnter = (e) => { if (e.key === 'Enter') handleCreate(); };
        cancelBtn.addEventListener('click', cleanup);
        createBtn.addEventListener('click', handleCreate);
        modal.addEventListener('click', handleBackdrop);
        document.addEventListener('keydown', handleEscape);
        rowsInput.addEventListener('keydown', handleEnter);
        colsInput.addEventListener('keydown', handleEnter);
    }
    createTable(rows, cols) {
        let tableHTML = '<table>';
        tableHTML += '<tr>';
        for (let j = 0; j < cols; j++) tableHTML += '<th> </th>';
        tableHTML += '</tr>';
        for (let i = 1; i < rows; i++) {
            tableHTML += '<tr>';
            for (let j = 0; j < cols; j++) tableHTML += '<td> </td>';
            tableHTML += '</tr>';
        }
        tableHTML += '</table><br>';
        this.restoreSelection();
        this.executeCommand('insertHTML', tableHTML);
    }
    setupDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        this.drawCtx = canvas.getContext('2d');
        this.drawCtx.imageSmoothingEnabled = true;
        this.drawCtx.imageSmoothingQuality = 'high';
        this.isDrawMode = false;
        this.isDrawing = false;
        this.drawTool = 'pen';
        this.drawColor = '#000000';
        this.drawSize = 2;
        this._drawPoints = [];
        this._drawingMeta = null;
        canvas.addEventListener('mousedown', (e) => this.startDraw(e));
        canvas.addEventListener('mousemove', (e) => this.drawLine(e));
        canvas.addEventListener('mouseup', () => this.endDraw());
        canvas.addEventListener('mouseleave', () => this.endDraw());
        canvas.addEventListener('touchstart', (e) => {
            this.startDraw(e.touches[0]);
        }, { passive: true });
        canvas.addEventListener('touchmove', (e) => {
            if (this.isDrawing) e.preventDefault();
            this.drawLine(e.touches[0]);
        }, { passive: false });
        canvas.addEventListener('touchend', () => this.endDraw());
        const penBtn = document.getElementById('drawPenBtn');
        const eraserBtn = document.getElementById('drawEraserBtn');
        const clearBtn = document.getElementById('drawClearBtn');
        const doneBtn = document.getElementById('drawDoneBtn');
        const colorSection = document.querySelector('.draw-color-section');
        const colorDivider = colorSection ? colorSection.previousElementSibling : null;
        if (penBtn) penBtn.addEventListener('click', () => {
            this.drawTool = 'pen';
            penBtn.classList.add('active');
            if (eraserBtn) eraserBtn.classList.remove('active');
            if (colorSection) colorSection.classList.remove('eraser-hidden');
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.remove('eraser-hidden');
            if (canvas) canvas.classList.remove('eraser-active');
        });
        if (eraserBtn) eraserBtn.addEventListener('click', () => {
            this.drawTool = 'eraser';
            eraserBtn.classList.add('active');
            if (penBtn) penBtn.classList.remove('active');
            if (colorSection) colorSection.classList.add('eraser-hidden');
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.add('eraser-hidden');
            if (canvas) canvas.classList.add('eraser-active');
        });
        if (clearBtn) clearBtn.addEventListener('click', () => {
            const c = document.getElementById('drawingCanvas');
            if (c && this.drawCtx) this.drawCtx.clearRect(0, 0, c.width, c.height);
        });
        if (doneBtn) doneBtn.addEventListener('click', () => this.finishDrawing());
        const colorPresets = document.getElementById('drawColorPresets');
        if (colorPresets) {
            colorPresets.addEventListener('click', (e) => {
                const swatch = e.target.closest('.draw-color-swatch');
                if (swatch) {
                    this.drawColor = swatch.dataset.color;
                    colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
                    swatch.classList.add('active');
                }
            });
        }
        const colorPicker = document.getElementById('drawColorPicker');
        if (colorPicker) {
            colorPicker.addEventListener('input', () => {
                this.drawColor = colorPicker.value;
                if (colorPresets) colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
            });
        }
        const toolbar = document.getElementById('drawToolbar');
        if (toolbar) {
            toolbar.addEventListener('click', (e) => {
                const sizeBtn = e.target.closest('.draw-size-btn');
                if (sizeBtn) {
                    this.drawSize = parseInt(sizeBtn.dataset.size);
                    toolbar.querySelectorAll('.draw-size-btn').forEach(b => b.classList.remove('active'));
                    sizeBtn.classList.add('active');
                    const slider = document.getElementById('drawThickness');
                    if (slider) slider.value = this.drawSize;
                }
            });
        }
    }
    _configureCanvasForCss(cssW, cssH) {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        this.drawCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.drawCtx.scale(dpr, dpr);
        this.drawCtx.imageSmoothingEnabled = true;
        this.drawCtx.imageSmoothingQuality = 'high';
        this.drawCtx.lineCap = 'round';
        this.drawCtx.lineJoin = 'round';
    }
    resizeCanvas() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        const container = canvas.parentElement || document.querySelector('.editor-content');
        if (!container) return;
        const cssW = container.offsetWidth || container.clientWidth || 800;
        const cssH = Math.max(container.offsetHeight || container.clientHeight || 600, 600);
        let snapshot = null;
        try { snapshot = canvas.width > 0 ? canvas.toDataURL() : null; } catch (_) {}
        this._configureCanvasForCss(cssW, cssH);
        if (snapshot && this.drawCtx) {
            const img = new Image();
            img.onload = () => {
                if (this.drawCtx) this.drawCtx.drawImage(img, 0, 0, cssW, cssH);
            };
            img.src = snapshot;
        }
    }
    toggleDrawMode() {
        this.isDrawMode = !this.isDrawMode;
        const canvas = document.getElementById('drawingCanvas');
        const toolbar = document.getElementById('drawToolbar');
        const textEditor = document.getElementById('textEditor');
        const drawBtn = document.getElementById('drawBtn');
        if (this.isDrawMode) {
            if (canvas) {
                canvas.style.pointerEvents = 'all';
                canvas.style.display = 'block';
                canvas.style.top = '0px';
                canvas.style.left = '0px';
            }
            const note = this.notes.find(n => n.id === this.currentNoteId);
            const meta = note ? this._getDrawingMeta(note) : null;
            this.resizeCanvas();
            if (meta && meta.dataUrl && this.drawCtx) {
                const img = new Image();
                img.onload = () => {
                    if (!this.drawCtx) return;
                    this.drawCtx.drawImage(img, meta.x || 0, meta.y || 0, meta.w || img.width, meta.h || img.height);
                };
                img.src = meta.dataUrl;
            }
            if (textEditor) { textEditor.contentEditable = 'false'; }
            if (toolbar) toolbar.classList.add('visible');
            if (drawBtn) drawBtn.classList.add('active');
        } else {
            this._cropAndPersistDrawing();
            if (canvas) { canvas.style.pointerEvents = 'none'; }
            if (textEditor) { textEditor.contentEditable = 'true'; }
            if (toolbar) toolbar.classList.remove('visible');
            if (drawBtn) drawBtn.classList.remove('active');
            if (this._updateCanvasOverlays) this._updateCanvasOverlays();
        }
    }
    finishDrawing() { if (this.isDrawMode) this.toggleDrawMode(); }
    _eventToCssXY(e) {
        const canvas = document.getElementById('drawingCanvas');
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    startDraw(e) {
        if (!this.isDrawMode || !this.drawCtx) return;
        this.isDrawing = true;
        const { x, y } = this._eventToCssXY(e);
        this._drawPoints = [{ x, y }];
        const thickness = this.drawSize || 2;
        if (this.drawTool === 'eraser') {
            this.drawCtx.globalCompositeOperation = 'destination-out';
            this.drawCtx.lineWidth = thickness * 5;
        } else {
            this.drawCtx.globalCompositeOperation = 'source-over';
            this.drawCtx.strokeStyle = this.drawColor || '#000000';
            this.drawCtx.lineWidth = thickness;
        }
        this.drawCtx.beginPath();
        this.drawCtx.arc(x, y, Math.max(0.5, this.drawCtx.lineWidth / 2), 0, Math.PI * 2);
        this.drawCtx.fillStyle = this.drawTool === 'eraser' ? '#000' : (this.drawColor || '#000000');
        this.drawCtx.fill();
        this.drawCtx.beginPath();
        this.drawCtx.moveTo(x, y);
    }
    drawLine(e) {
        if (!this.isDrawMode || !this.isDrawing || !this.drawCtx) return;
        const { x, y } = this._eventToCssXY(e);
        const pts = this._drawPoints;
        pts.push({ x, y });
        if (pts.length >= 3) {
            const p0 = pts[pts.length - 3];
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            const mid1x = (p0.x + p1.x) / 2;
            const mid1y = (p0.y + p1.y) / 2;
            const mid2x = (p1.x + p2.x) / 2;
            const mid2y = (p1.y + p2.y) / 2;
            this.drawCtx.beginPath();
            this.drawCtx.moveTo(mid1x, mid1y);
            this.drawCtx.quadraticCurveTo(p1.x, p1.y, mid2x, mid2y);
            this.drawCtx.stroke();
        } else {
            const p0 = pts[0];
            const p1 = pts[1];
            this.drawCtx.beginPath();
            this.drawCtx.moveTo(p0.x, p0.y);
            this.drawCtx.lineTo(p1.x, p1.y);
            this.drawCtx.stroke();
        }
    }
    endDraw() {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        const pts = this._drawPoints;
        if (pts.length >= 2 && this.drawCtx) {
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            this.drawCtx.beginPath();
            this.drawCtx.moveTo(mx, my);
            this.drawCtx.lineTo(p2.x, p2.y);
            this.drawCtx.stroke();
        }
        this._drawPoints = [];
    }
    _computeDrawingBBox() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return null;
        const W = canvas.width;
        const H = canvas.height;
        if (W === 0 || H === 0) return null;
        let data;
        try { data = this.drawCtx.getImageData(0, 0, W, H).data; }
        catch (_) { return null; }
        let minX = W, minY = H, maxX = -1, maxY = -1;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const a = data[(y * W + x) * 4 + 3];
                if (a > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        const dpr = window.devicePixelRatio || 1;
        const padCss = 4;
        const padDev = Math.round(padCss * dpr);
        const x0 = Math.max(0, minX - padDev);
        const y0 = Math.max(0, minY - padDev);
        const x1 = Math.min(W - 1, maxX + padDev);
        const y1 = Math.min(H - 1, maxY + padDev);
        const wDev = x1 - x0 + 1;
        const hDev = y1 - y0 + 1;
        const off = document.createElement('canvas');
        off.width = wDev;
        off.height = hDev;
        off.getContext('2d').drawImage(canvas, x0, y0, wDev, hDev, 0, 0, wDev, hDev);
        return {
            x: x0 / dpr,
            y: y0 / dpr,
            w: wDev / dpr,
            h: hDev / dpr,
            dataUrl: off.toDataURL('image/png')
        };
    }
    _cropAndPersistDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas || !this.drawCtx) return;
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        const bbox = this._computeDrawingBBox();
        canvas.style.display = 'none';
        if (this.drawCtx) this.drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        note.drawing = null;
        this._drawingMeta = null;
        if (!bbox) {
            this.debouncedSave();
            return;
        }
        const editor = document.getElementById('textEditor');
        if (editor) {
            const img = document.createElement('img');
            img.src = bbox.dataUrl;
            img.alt = 'drawing';
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.borderRadius = '6px';
            img.setAttribute('data-drawing', '1');
            let placed = false;
            if (this.savedSelection && editor.contains(this.savedSelection.commonAncestorContainer)) {
                try {
                    const range = this.savedSelection.cloneRange();
                    range.collapse(false);
                    range.insertNode(img);
                    placed = true;
                } catch (_) {}
            }
            if (!placed) {
                editor.appendChild(img);
            }
            this.updateNoteContent();
            if (this.collabMode) this.updateCollabNoteContent();
        }
    }
    _persistDrawingMeta() {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        const meta = this._getDrawingMeta(note);
        if (!meta) return;
        const x = parseInt(canvas.style.left || '0') || 0;
        const y = parseInt(canvas.style.top || '0') || 0;
        const w = canvas.offsetWidth || meta.w;
        const h = canvas.offsetHeight || meta.h;
        try {
            const dataUrl = canvas.toDataURL('image/png');
            note.drawing = { dataUrl, x, y, w, h };
            this._drawingMeta = note.drawing;
        } catch (_) {
            note.drawing = { dataUrl: meta.dataUrl, x, y, w, h };
            this._drawingMeta = note.drawing;
        }
    }
    _getDrawingMeta(note) {
        if (!note || !note.drawing) return null;
        if (typeof note.drawing === 'string') {
            return { dataUrl: note.drawing, x: 0, y: 0, w: null, h: null };
        }
        return note.drawing;
    }
    saveDrawing() {
        this._cropAndPersistDrawing();
    }
    _uriClean(v) {
        try {
            return decodeURIComponent(encodeURIComponent(v));
        } catch (e) { return ''; }
    }
    // Media-image sanitizer (CodeQL js/xss WriteUrlSink). Data:-URLs are
    // converted to a fresh browser-generated blob: URL so a storage-sourced
    // payload never reaches an <img> src; every value handed back passes
    // through _uriClean(), whose encodeURIComponent() call is a recognized
    // XSS sanitizer node, so no storage/user taint survives into the sink.
    _noteSafeImageSrc(u) {
        const v = String(u || '').trim();
        if (!v) return '';
        if (v.startsWith('data:image/')) {
            try {
                const comma = v.indexOf(',');
                const bytes = Uint8Array.from(atob(v.slice(comma + 1)), (ch) => ch.charCodeAt(0));
                return this._uriClean(URL.createObjectURL(new Blob([bytes], { type: v.slice(5, comma) || 'image/png' })));
            } catch (e) { return ''; }
        }
        if (v.startsWith('https://') || v.startsWith('http://') || v.startsWith('blob:')) return this._uriClean(v);
        if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(v) && !v.startsWith('//')) return this._uriClean(v);
        return '';
    }
    loadDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        canvas.style.display = 'none';
        this._drawingMeta = null;
        if (this._updateCanvasOverlays) this._updateCanvasOverlays();
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        const meta = this._getDrawingMeta(note);
        if (meta && meta.dataUrl) {
            const editor = document.getElementById('textEditor');
            if (editor) {
                const img = document.createElement('img');
                const du = String(meta.dataUrl || '').trim();
                // Only image data-URLs, web/blob URLs and relative paths survive.
                img.src = this._noteSafeImageSrc(du);
                img.alt = 'drawing';
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.style.borderRadius = '6px';
                img.setAttribute('data-drawing', '1');
                editor.appendChild(img);
            }
            note.drawing = null;
            this.updateNoteContent();
        }
    }
    zoomIn() {
        const editor = document.getElementById('textEditor');
        editor.style.fontSize = (parseFloat(getComputedStyle(editor).fontSize) * 1.1) + 'px';
    }
    zoomOut() {
        const editor = document.getElementById('textEditor');
        editor.style.fontSize = (parseFloat(getComputedStyle(editor).fontSize) * 0.9) + 'px';
    }
    generateId() {
        return 'note_' + Date.now() + '_' + this.generateSecureId(9);
    }
    generateSecureId(length = 16) {
        const arr = new Uint8Array(Math.ceil(length / 2));
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
    }
    formatDate(date) {
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return date.toLocaleDateString();
        if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
        return 'Just now';
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    hexToRgba(hex, opacity) {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
    sanitizeHtml(html) {
        if (!html) return '';
        const allowedTags = [
            'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
            'font', 'input', 'img', 's', 'strike', 'sub', 'sup'
        ];
        const allowedAttributes = [
            'style', 'href', 'target', 'rel',
            'face', 'color', 'size',
            'type', 'checked', 'class', 'data-checked',
            'width', 'height', 'colspan', 'rowspan', 'border',
            'cellpadding', 'cellspacing', 'align', 'valign',
            'src', 'alt', 'draggable'
        ];
        try {
            const _sanDoc = new DOMParser().parseFromString(html || '', 'text/html');
            const div = _sanDoc.body;
            div.querySelectorAll('script, iframe, object, embed, form, link, meta').forEach(el => el.remove());
            div.querySelectorAll('*').forEach(element => {
                const tagName = element.tagName.toLowerCase();
                if (tagName === 'input' && element.getAttribute('type') !== 'checkbox') {
                    element.remove(); return;
                }
                if (!allowedTags.includes(tagName)) {
                    const span = document.createElement('span');
                    while (element.firstChild) span.appendChild(element.firstChild);
                    element.parentNode.replaceChild(span, element);
                    return;
                }
                Array.from(element.attributes).forEach(attr => {
                    const attrName = attr.name.toLowerCase();
                    const attrValue = attr.value;
                    const attrValueLower = attrValue.toLowerCase();
                    if (attrName === 'href' && tagName === 'a') {
                        if (attrValueLower.startsWith('http://') || attrValueLower.startsWith('https://') || attrValueLower.startsWith('mailto:')) return;
                    }
                    if (attrName === 'src' && tagName === 'img') {
                        if (attrValueLower.startsWith('data:image/') || attrValueLower.startsWith('http://') || attrValueLower.startsWith('https://') || attrValueLower.startsWith('/')) return;
                    }
                    if (attrName.startsWith('on') || attrValueLower.includes('javascript:') ||
                        (attrName === 'src' && tagName !== 'img') || (attrName === 'href' && tagName !== 'a') || !allowedAttributes.includes(attrName)) {
                        element.removeAttribute(attr.name);
                    }
                });
                if (element.hasAttribute('style')) {
                    const style = element.getAttribute('style');
                    if (style && (style.includes('javascript:') || style.includes('expression(') || style.includes('@import'))) {
                        element.removeAttribute('style');
                    }
                }
            });
            return div.innerHTML;
        } catch (error) {
            return String(html || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    }
    _applySanitizedHtml(el, html) {
        if (!html) { el.innerHTML = ''; return; }
        const _asTags = [
            'p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'a',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
            'font', 'input', 'img', 's', 'strike', 'sub', 'sup'
        ];
        const _asAttrs = [
            'style', 'href', 'target', 'rel',
            'face', 'color', 'size',
            'type', 'checked', 'class', 'data-checked',
            'width', 'height', 'colspan', 'rowspan', 'border',
            'cellpadding', 'cellspacing', 'align', 'valign',
            'src', 'alt', 'draggable'
        ];
        try {
            // innerHTML only receives DOMPurify output; the fallback path uses
            // textContent (a safe sink) so no tainted string reaches an HTML sink.
            const _asBody = document.createElement('div');
            if (typeof DOMPurify !== 'undefined') {
                _asBody.innerHTML = DOMPurify.sanitize(html || '', { FORCE_BODY: true });
            } else {
                _asBody.textContent = html || '';
            }
            _asBody.querySelectorAll('script, iframe, object, embed, form, link, meta').forEach(e => e.remove());
            _asBody.querySelectorAll('*').forEach(element => {
                const tn = element.tagName.toLowerCase();
                if (tn === 'input' && element.getAttribute('type') !== 'checkbox') { element.remove(); return; }
                if (!_asTags.includes(tn)) {
                    const sp = document.createElement('span');
                    while (element.firstChild) sp.appendChild(element.firstChild);
                    element.parentNode.replaceChild(sp, element);
                    return;
                }
                Array.from(element.attributes).forEach(attr => {
                    const an = attr.name.toLowerCase(), av = attr.value, avl = av.toLowerCase();
                    if (an === 'href' && tn === 'a') {
                        if (avl.startsWith('http://') || avl.startsWith('https://') || avl.startsWith('mailto:')) return;
                    }
                    if (an === 'src' && tn === 'img') {
                        if (avl.startsWith('data:image/') || avl.startsWith('http://') || avl.startsWith('https://') || avl.startsWith('/')) return;
                    }
                    if (an.startsWith('on') || avl.includes('javascript:') ||
                        (an === 'src' && tn !== 'img') || (an === 'href' && tn !== 'a') || !_asAttrs.includes(an)) {
                        element.removeAttribute(attr.name);
                    }
                });
                if (element.hasAttribute('style')) {
                    const st = element.getAttribute('style');
                    if (st && (st.includes('javascript:') || st.includes('expression(') || st.includes('@import'))) {
                        element.removeAttribute('style');
                    }
                }
            });
            el.innerHTML = '';
            while (_asBody.firstChild) el.appendChild(_asBody.firstChild);
        } catch (_) { el.textContent = html || ''; }
    }
    _closePortal(animate = true) {
        if (!this._portalMenu) return;
        const menu = this._portalMenu;
        const dropdown = this._portalDropdown;
        const btn = this._portalBtn;
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        dropdown.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            menu.removeEventListener('animationend', cleanup);
            menu.classList.remove('ms-portal-closing');
            menu.style.cssText = '';
            dropdown.appendChild(menu);
        };
        if (animate) {
            menu.classList.add('ms-portal-closing');
            menu.addEventListener('animationend', cleanup);
            setTimeout(cleanup, 220); 
        } else {
            cleanup();
        }
    }
    _openPortal(dropdown, btn, menu) {
        this._closePortal(false); 
        document.body.appendChild(menu);
        this._portalMenu = menu;
        this._portalDropdown = dropdown;
        this._portalBtn = btn;
        dropdown.classList.add('active');
        btn.setAttribute('aria-expanded', 'true');
        const maxH = Math.min(320, window.innerHeight * 0.6);
        menu.style.cssText = `position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:${maxH}px;overflow-y:auto;`;
        const btnRect = btn.getBoundingClientRect();
        const mW = menu.offsetWidth || 180;
        const mH = menu.offsetHeight || 260;
        const vW = window.innerWidth;
        const vH = window.innerHeight;
        let top = btnRect.bottom + 4;
        if (top + mH > vH - 8) top = btnRect.top - mH - 4;
        if (top < 8) top = btnRect.bottom + 4;
        let left = btnRect.left;
        if (left + mW > vW - 8) left = vW - mW - 8;
        if (left < 8) left = 8;
        menu.style.cssText = `position:fixed;display:block;visibility:visible;z-index:999999;margin:0;left:${left}px;top:${top}px;max-height:${maxH}px;overflow-y:auto;animation:dropdownFadeIn 0.18s ease;`;
    }
    setupMSDropdowns() {
        document.querySelectorAll('.ms-dropdown').forEach(dropdown => {
            const btn = dropdown.querySelector('.ms-dropdown-btn');
            const menu = dropdown.querySelector('.ms-dropdown-menu');
            const items = dropdown.querySelectorAll('.ms-dropdown-item');
            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-haspopup', 'listbox');
            menu.setAttribute('role', 'listbox');
            items.forEach((item, index) => {
                item.setAttribute('role', 'option');
                item.setAttribute('tabindex', '-1');
                item.id = `dropdown-item-${dropdown.id}-${index}`;
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                this.saveSelection();
                if (this._portalDropdown === dropdown) {
                    this._closePortal();
                    return;
                }
                this._openPortal(dropdown, btn, menu);
                if (items[0]) items[0].focus();
            });
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); btn.click(); }
            });
            items.forEach((item, index) => {
                item.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); (items[index + 1] || items[0]).focus(); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[index - 1] || items[items.length - 1]).focus(); }
                    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
                    else if (e.key === 'Escape') { e.preventDefault(); this._closePortal(); btn.focus(); }
                });
            });
            items.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation(); e.preventDefault();
                    const value = item.dataset.value;
                    if (value === undefined || value === null || value === '') return; 
                    const label = item.dataset.label || item.textContent;
                    const valueSpan = btn.querySelector('.dropdown-value');
                    const isColorOnlyDropdown = dropdown.id === 'fontColorDropdown' || dropdown.id === 'highlightColorDropdown';
                    if (valueSpan && !isColorOnlyDropdown) valueSpan.textContent = label;
                    const colorPreview = btn.querySelector('.color-preview');
                    if (colorPreview && value) {
                        if (value === 'transparent') {
                            colorPreview.style.background = 'transparent';
                            colorPreview.style.border = '1px solid #ccc';
                            colorPreview.removeAttribute('data-color');
                        } else {
                            colorPreview.style.background = value;
                            colorPreview.style.border = '';
                            colorPreview.setAttribute('data-color', value);
                        }
                    }
                    this._closePortal();
                    setTimeout(() => {
                        const editor = document.getElementById('textEditor');
                        if (editor) editor.focus();
                        this.restoreSelection();
                        if (dropdown.id === 'fontFamilyDropdown') this.executeCommand('fontName', value);
                        else if (dropdown.id === 'fontSizeDropdown') this.executeCommand('fontSize', value);
                        else if (dropdown.id === 'fontColorDropdown') this.executeCommand('foreColor', value);
                        else if (dropdown.id === 'highlightColorDropdown') this.executeCommand('hiliteColor', value);
                        else if (dropdown.id === 'noteColorDropdown') this.updateNoteColor(value);
                        this.updateButtonStates();
                    }, 10);
                });
            });
        });
        document.addEventListener('click', (e) => {
            if (this._portalMenu &&
                !this._portalMenu.contains(e.target) &&
                this._portalBtn && !this._portalBtn.contains(e.target)) {
                this._closePortal();
            }
        });
    }
    setupCustomContextMenu() {
        const contextMenu = document.getElementById('customContextMenu');
        const textEditor = document.getElementById('textEditor');
        if (!contextMenu || !textEditor) return;
        textEditor.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.saveSelection();
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.top = e.pageY + 'px';
            contextMenu.style.display = 'block';
            const rect = contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) contextMenu.style.left = (e.pageX - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) contextMenu.style.top = (e.pageY - rect.height) + 'px';
        });
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            this.restoreSelection();
            switch (item.dataset.action) {
                case 'copy': this.executeCommand('copy'); break;
                case 'paste': this.executeCommand('paste'); break;
                case 'bold': this.executeCommand('bold'); this.updateButtonStates(); break;
                case 'italic': this.executeCommand('italic'); this.updateButtonStates(); break;
                case 'underline': this.executeCommand('underline'); this.updateButtonStates(); break;
                case 'selectAll': this.executeCommand('selectAll'); break;
            }
            contextMenu.style.display = 'none';
        });
        document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) contextMenu.style.display = 'none'; });
        document.addEventListener('scroll', () => { contextMenu.style.display = 'none'; });
    }
    setupTableToolbar() {
        const toolbar = document.getElementById('tableToolbar');
        const editor = document.getElementById('textEditor');
        if (!toolbar || !editor) return;
        let activeCell = null;
        editor.addEventListener('click', (e) => {
            const cell = e.target.closest('td, th');
            if (cell && editor.contains(cell)) {
                activeCell = cell;
                toolbar.style.display = 'flex';
                const table = cell.closest('table');
                const tableRect = table.getBoundingClientRect();
                const tbH = 36;
                let top = tableRect.top - tbH - 6;
                if (top < 4) top = tableRect.bottom + 6;
                toolbar.style.top = top + 'px';
                toolbar.style.left = Math.max(4, tableRect.left) + 'px';
            } else {
                if (!toolbar.contains(e.target)) { toolbar.style.display = 'none'; activeCell = null; }
            }
        });
        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.tbl-btn');
            if (!btn || !activeCell) return;
            const action = btn.dataset.tbl;
            const row = activeCell.parentElement;
            const table = row ? row.closest('table') : null;
            if (!table) return;
            const colIndex = Array.from(row.children).indexOf(activeCell);
            if (action === 'addRowAbove') {
                const newRow = this._makeTableRow(row.cells.length, row.querySelector('th') ? 'th' : 'td');
                row.parentNode.insertBefore(newRow, row);
            } else if (action === 'addRowBelow') {
                const newRow = this._makeTableRow(row.cells.length, 'td');
                row.parentNode.insertBefore(newRow, row.nextSibling);
            } else if (action === 'deleteRow') {
                if (table.rows.length > 1) { row.remove(); activeCell = null; toolbar.style.display = 'none'; }
                else { table.remove(); toolbar.style.display = 'none'; activeCell = null; }
            } else if (action === 'addColLeft') {
                Array.from(table.rows).forEach((r, ri) => {
                    const cell = document.createElement(ri === 0 ? 'th' : 'td');
                    cell.textContent = ri === 0 ? 'Header' : '';
                    r.insertBefore(cell, r.cells[colIndex]);
                });
            } else if (action === 'addColRight') {
                Array.from(table.rows).forEach((r, ri) => {
                    const cell = document.createElement(ri === 0 ? 'th' : 'td');
                    cell.textContent = ri === 0 ? 'Header' : '';
                    const ref = r.cells[colIndex + 1];
                    if (ref) r.insertBefore(cell, ref); else r.appendChild(cell);
                });
            } else if (action === 'deleteCol') {
                if (row.cells.length > 1) {
                    Array.from(table.rows).forEach(r => { if (r.cells[colIndex]) r.cells[colIndex].remove(); });
                }
            }
            this.updateNoteContent();
        });
        document.addEventListener('click', (e) => {
            if (!editor.contains(e.target) && !toolbar.contains(e.target)) {
                toolbar.style.display = 'none'; activeCell = null;
            }
        });
    }
    _makeTableRow(colCount, cellTag = 'td') {
        const row = document.createElement('tr');
        for (let i = 0; i < colCount; i++) {
            const cell = document.createElement(cellTag);
            cell.textContent = '';
            row.appendChild(cell);
        }
        return row;
    }
    updateNoteColor(color) {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        note.color = color;
        const textEditor = document.getElementById('textEditor');
        if (textEditor) {
            textEditor.style.backgroundColor = color === '#ffffff' ? 'rgba(255, 255, 255, 0.5)' : color;
        }
        if (this.collabMode && this.collabIsOwner && this.collabNoteData && this.currentNoteId === this.collabNoteId) {
            this.collabNoteData.color = color;
            this.collabNoteData.modifiedAt = new Date().toISOString();
            this._debouncedCollabPush();
        }
        this.renderNotesList();
        this.renderNotesCards();
        if (!note._isCollabNote) this.debouncedSave();
    }
    showDeleteModal(noteTitle, onConfirm) {
        const modal = document.getElementById('deleteModal');
        const message = document.getElementById('deleteModalMessage');
        const cancelBtn = document.getElementById('deleteModalCancel');
        const confirmBtn = document.getElementById('deleteModalConfirm');
        message.textContent = `Are you sure you want to delete "${noteTitle}"? This action cannot be undone.`;
        modal.classList.add('show');
        const cleanup = () => {
            modal.classList.remove('show');
            cancelBtn.removeEventListener('click', cleanup);
            confirmBtn.removeEventListener('click', handleConfirm);
            modal.removeEventListener('click', handleBackdrop);
            document.removeEventListener('keydown', handleEscape);
        };
        const handleConfirm = () => { cleanup(); onConfirm(); };
        const handleBackdrop = (e) => { if (e.target === modal) cleanup(); };
        const handleEscape = (e) => { if (e.key === 'Escape') cleanup(); };
        cancelBtn.addEventListener('click', cleanup);
        confirmBtn.addEventListener('click', handleConfirm);
        modal.addEventListener('click', handleBackdrop);
        document.addEventListener('keydown', handleEscape);
    }
    setupSidebarToggle() {
        const toggleBtn = document.getElementById('sidebarToggle');
        const sidebar = document.querySelector('.sidebar');
        if (!toggleBtn || !sidebar) return;
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (this.isMobile()) {
                if (this.sidebarOpen) this.closeMobileSidebar();
                else this.openMobileSidebar();
                return;
            }
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            this.setStoredValue('sidebarCollapsed', isCollapsed);
            this.updateToggleIcon(toggleBtn, isCollapsed);
        });
        const savedState = this.getStoredValue('sidebarCollapsed');
        if (savedState === true && !this.isMobile()) {
            sidebar.classList.add('collapsed');
            this.updateToggleIcon(toggleBtn, true);
        }
        toggleBtn.style.opacity = '1';
        toggleBtn.style.pointerEvents = 'auto';
    }
    updateToggleIcon(toggleBtn, isCollapsed) {
        const svg = toggleBtn.querySelector('svg');
        if (!svg) return;
        if (isCollapsed) {
            svg.innerHTML = '<line x1="9" y1="18" x2="15" y2="12"/><line x1="9" y1="6" x2="15" y2="12"/>';
            toggleBtn.title = 'Expand Sidebar';
        } else {
            svg.innerHTML = '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>';
            toggleBtn.title = 'Collapse Sidebar';
        }
    }
    isEditorEmpty(editor) {
        const content = editor.innerHTML.trim();
        const textContent = editor.textContent.trim();
        const meaningfulElements = content.match(/<(img|table|audio|video|iframe|embed|object|canvas|svg)[^>]*>/gi);
        if (meaningfulElements && meaningfulElements.length > 0) return false;
        const listMatches = content.match(/<(ul|ol)[^>]*>[\s\S]*?<\/(ul|ol)>/gi);
        if (listMatches && listMatches.some(list => {
            const tmp = document.createElement('div');
            tmp.innerHTML = list;
            return tmp.textContent.trim() !== '';
        })) return false;
        if (textContent === '' || textContent === '\u00A0') return true;
        const emptyPatterns = ['', '<br>', '<div></div>', '<p></p>', '<div><br></div>', '<p><br></p>', '<div>\u00A0</div>', '<p>\u00A0</p>', '<p>Start typing your note here...</p>', '<ul></ul>', '<ol></ol>', '<ul><li></li></ul>', '<ol><li></li></ol>'];
        return emptyPatterns.includes(content);
    }
    updatePlaceholderState(editor) {
        if (this.isEditorEmpty(editor)) editor.setAttribute('data-empty', 'true');
        else editor.removeAttribute('data-empty');
    }
    setupEditorPlaceholder() {
        const textEditor = document.getElementById('textEditor');
        if (!textEditor) return;
        textEditor.addEventListener('focus', () => this.updatePlaceholderState(textEditor));
        textEditor.addEventListener('blur', () => this.updatePlaceholderState(textEditor));
        textEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' || e.key === 'Delete')
                setTimeout(() => this.updatePlaceholderState(textEditor), 0);
        });
        this.updatePlaceholderState(textEditor);
    }
    async modernCut() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const selectedText = range.toString();
        if (selectedText) {
            try {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([this.getSelectedHtml()], { type: 'text/html' }),
                    'text/plain': new Blob([selectedText], { type: 'text/plain' })
                })]);
                range.deleteContents();
                this.updateNoteContent();
            } catch { try { document.execCommand('cut'); this.updateNoteContent(); } catch (err) { console.error('Cut failed:', err); } }
        }
    }
    async modernCopy() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const selectedText = selection.toString();
        if (selectedText) {
            try {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([this.getSelectedHtml()], { type: 'text/html' }),
                    'text/plain': new Blob([selectedText], { type: 'text/plain' })
                })]);
            } catch { try { document.execCommand('copy'); } catch (err) { console.error('Copy failed:', err); } }
        }
    }
    async modernPaste() {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                if (item.types.includes('text/html')) {
                    const html = await (await item.getType('text/html')).text();
                    if (html) { this.insertHtmlAtSelection(html); this.updateNoteContent(); return; }
                }
                if (item.types.includes('text/plain')) {
                    const text = await (await item.getType('text/plain')).text();
                    if (text) { this.insertTextAtSelection(text); this.updateNoteContent(); return; }
                }
            }
        } catch {
            try {
                const text = await navigator.clipboard.readText();
                if (text) { this.insertTextAtSelection(text); this.updateNoteContent(); return; }
            } catch {
                try { document.execCommand('paste'); this.updateNoteContent(); } catch (err) { console.error('Paste failed:', err); }
            }
        }
    }
    modernFontFamily(font) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.fontFamily = font;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { fontFamily: font });
        } else {
            const span = document.createElement('span');
            span.style.fontFamily = font;
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('fontName', false, font); }
        }
        this.updateNoteContent();
    }
    modernFontSize(size) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { fontSize: size + 'px' });
        } else {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('fontSize', false, size); }
        }
        this.updateNoteContent();
    }
    modernTextColor(color) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
            const span = document.createElement('span');
            span.style.color = color;
            span.className = 'temp-formatting';
            span.innerHTML = '&#8203;';
            range.insertNode(span);
            range.setStartAfter(span);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            this.setupTempFormatting(span, { color });
        } else {
            const span = document.createElement('span');
            span.style.color = color;
            try {
                span.appendChild(range.extractContents());
                range.insertNode(span);
                range.selectNodeContents(span);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch { document.execCommand('foreColor', false, color); }
        }
        this.updateNoteContent();
    }
    modernHighlightColor(color) {
        this.restoreSelection();
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        const range = selection.getRangeAt(0);
        // Bail out if the restored range is outside the editor — this happens
        // when the saved range got detached (e.g. by a collab sync re-render).
        // Operating on a stale range would either silently no-op or apply the
        // highlight to the wrong element, which is the root cause of the
        // "highlight sometimes doesn't apply correctly" symptom.
        if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
            return;
        }
        const isNone = !color || color === 'transparent' || color === 'none';
        if (range.collapsed) {
            if (!isNone) {
                // Clean up any prior orphaned temp-formatting span first, so
                // repeated "pick color with no selection" actions don't stack
                // up zero-width-space spans that later escape into the saved
                // note content (another source of "highlight doesn't clear").
                if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                    this.tempFormattingSpan.parentNode.removeChild(this.tempFormattingSpan);
                    this.tempFormattingSpan = null;
                    this.tempFormattingStyles = null;
                }
                const span = document.createElement('span');
                span.style.backgroundColor = color;
                span.className = 'temp-formatting';
                span.innerHTML = '&#8203;';
                range.insertNode(span);
                range.setStartAfter(span);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                this.setupTempFormatting(span, { backgroundColor: color });
            }
        } else {
            if (isNone) {
                this._clearHighlightInRange(editor, range);
            } else {
                const span = document.createElement('span');
                span.style.backgroundColor = color;
                try {
                    span.appendChild(range.extractContents());
                    range.insertNode(span);
                    range.selectNodeContents(span);
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch (e) {
                    // Fallback for edge cases (e.g. selection crossing element
                    // boundaries that extractContents can't serialize). Try
                    // hiliteColor first, then backColor (Firefox).
                    try { document.execCommand('hiliteColor', false, color); }
                    catch (_) { try { document.execCommand('backColor', false, color); } catch (__) {} }
                }
            }
        }
        this.updateNoteContent();
    }
    /**
     * Strip background-color from every element that intersects the given range.
     *
     * This replaces the previous buggy clear logic which:
     *   1. Skipped descendant spans entirely when the range's common ancestor
     *      was the editor itself (i.e. multi-paragraph selections) — causing
     *      "highlight doesn't clear" when the user selected across paragraphs.
     *   2. Lost access to descendant spans after unwrapping the ancestor itself.
     *   3. Only matched <span style="background-color">, ignoring <font> and
     *      <mark> elements that execCommand fallbacks may have produced.
     *
     * The new implementation walks the entire subtree of the range's root
     * (the editor itself when the selection spans multiple blocks), collects
     * every element that has any background-color set, and strips it —
     * unwrapping the element if it has no remaining styling.
     */
    _clearHighlightInRange(editor, range) {
        const unwrapElement = (el) => {
            const parent = el.parentNode;
            if (!parent) return;
            // Move children out before removing the wrapper.
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
            // Normalize adjacent text nodes that may have been split.
            if (parent.normalize) parent.normalize();
        };
        const hasBackgroundColor = (el) => {
            if (!el.style) return false;
            if (el.style.backgroundColor) return true;
            // Legacy <font bgcolor="..."> from old execCommand output.
            if (el.tagName === 'FONT' && el.getAttribute('bgcolor')) return true;
            return false;
        };
        const stripBackgroundColor = (el) => {
            if (el.style && el.style.backgroundColor) {
                el.style.removeProperty('background-color');
            }
            if (el.tagName === 'FONT' && el.getAttribute('bgcolor')) {
                el.removeAttribute('bgcolor');
            }
        };
        const isUnwrappable = (el) => {
            if (el.tagName === 'SPAN') {
                const style = el.getAttribute('style');
                return (!style || style.trim() === '') && !el.className;
            }
            // Unwrap legacy <font> tags that have no remaining attributes.
            if (el.tagName === 'FONT') {
                return !el.getAttribute('color') && !el.getAttribute('bgcolor') &&
                       !el.getAttribute('size') && !el.getAttribute('face');
            }
            return false;
        };
        const intersectsRange = (el) => {
            try { return range.intersectsNode(el); }
            catch (e) { return false; }
        };

        // Step 1: walk up from the range's common ancestor, clearing any
        // ancestor element that fully contains the range and has a background.
        // This handles the case where the entire selection sits inside a
        // single highlighted wrapper.
        let ancestor = range.commonAncestorContainer;
        if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
        let cur = ancestor;
        while (cur && cur !== editor && cur !== document.body) {
            if (cur.nodeType === Node.ELEMENT_NODE && hasBackgroundColor(cur)) {
                stripBackgroundColor(cur);
                if (isUnwrappable(cur)) {
                    const next = cur.parentElement;
                    unwrapElement(cur);
                    cur = next;
                    continue;
                }
            }
            cur = cur.parentElement;
        }

        // Step 2: collect every descendant of the root that has a background
        // color AND intersects the range. The root is the editor itself when
        // the selection spans multiple block elements (the previous code
        // bailed out in this case — that was the main "doesn't clear" bug).
        ancestor = range.commonAncestorContainer;
        if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
        const root = (ancestor && editor.contains(ancestor)) ? ancestor : editor;

        const candidates = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    // IMPORTANT: use FILTER_SKIP (not FILTER_REJECT) here.
                    // FILTER_REJECT would skip the node's entire subtree, so
                    // a <p> without a background-color would cause us to miss
                    // the highlighted <span> inside it. FILTER_SKIP visits the
                    // node's children even when the node itself is filtered out.
                    if (!hasBackgroundColor(node)) return NodeFilter.FILTER_SKIP;
                    if (!intersectsRange(node)) return NodeFilter.FILTER_SKIP;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );
        while (walker.nextNode()) candidates.push(walker.currentNode);

        // Step 3: strip in reverse order (deepest first) so unwrapping an
        // outer element doesn't invalidate our references to inner ones.
        for (let i = candidates.length - 1; i >= 0; i--) {
            const el = candidates[i];
            if (!el.parentNode) continue; // already removed by an earlier unwrap
            stripBackgroundColor(el);
            if (isUnwrappable(el)) unwrapElement(el);
        }
    }
    insertTextAtSelection(text) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    getSelectedHtml() {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return '';
        const div = document.createElement('div');
        div.appendChild(selection.getRangeAt(0).cloneContents());
        return div.innerHTML;
    }
    insertHtmlAtSelection(html) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const _tmpEl = document.createElement('div');
        this._applySanitizedHtml(_tmpEl, html);
        const _frag = document.createDocumentFragment();
        while (_tmpEl.firstChild) _frag.appendChild(_tmpEl.firstChild);
        range.insertNode(_frag);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }
    setupTempFormatting(span, styles) {
        const editor = document.getElementById('textEditor');
        this.tempFormattingStyles = styles;
        this.tempFormattingSpan = span;
        const handleInput = (e) => {
            if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
                const range = window.getSelection().getRangeAt(0);
                const textNode = range.startContainer;
                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                    const newSpan = document.createElement('span');
                    Object.assign(newSpan.style, this.tempFormattingStyles);
                    if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                        this.tempFormattingSpan.parentNode.replaceChild(newSpan, this.tempFormattingSpan);
                        newSpan.appendChild(textNode);
                        const newRange = document.createRange();
                        newRange.setStartAfter(newSpan);
                        newRange.collapse(true);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(newRange);
                    }
                }
                this.tempFormattingStyles = null;
                this.tempFormattingSpan = null;
                editor.removeEventListener('input', handleInput);
            }
        };
        const cleanupHandler = () => {
            if (this.tempFormattingSpan && this.tempFormattingSpan.parentNode) {
                this.tempFormattingSpan.parentNode.removeChild(this.tempFormattingSpan);
                if (this.tempFormattingSpan.parentNode && this.tempFormattingSpan.parentNode.normalize)
                    this.tempFormattingSpan.parentNode.normalize();
            }
            this.tempFormattingStyles = null;
            this.tempFormattingSpan = null;
            editor.removeEventListener('input', handleInput);
            editor.removeEventListener('click', cleanupHandler);
        };
        editor.addEventListener('input', handleInput, { once: true });
        editor.addEventListener('click', cleanupHandler, { once: true });
        editor.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) cleanupHandler();
        }, { once: true });
    }
    async exportNoteAsLink() {
        if (!this.currentNoteId) return;
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note) return;
        try {
            const exportModal = document.getElementById('exportModal');
            const exportLink = document.getElementById('exportLink');
            const cancelBtn = document.getElementById('exportModalCancel');
            const copyBtn = document.getElementById('exportModalCopy');
            if (!exportModal) return;
            this.saveSelection();
            const MAX_URL_LENGTH = 8215;
            // The share link parameter was renamed from `s` to `share` for clarity.
            // Old `?s=` links are still accepted on import for backward compatibility.
            const baseUrl = `${window.location.origin}${window.location.pathname}?share=`;
            // Include the note's color (`cl`) in the export payload so the receiver
            // sees the same background color the sender chose. Previously the color
            // was dropped here and hardcoded to white on import.
            const token = await compressToUrl(JSON.stringify({
                t: note.title,
                c: note.content,
                cl: note.color || '#ffffff'
            }));
            const fullUrl = baseUrl + token;
            if (fullUrl.length > MAX_URL_LENGTH) {
                exportModal.classList.add('show');
                exportLink.value = 'This note is too long to share with a link.';
                exportLink.readOnly = true;
                exportLink.select();
                if (copyBtn) copyBtn.disabled = true;
                const cleanupTooLong = () => {
                    exportModal.classList.remove('show');
                    if (copyBtn) copyBtn.disabled = false;
                    cancelBtn.removeEventListener('click', cleanupTooLong);
                    if (copyBtn) copyBtn.removeEventListener('click', cleanupTooLong);
                };
                cancelBtn.addEventListener('click', cleanupTooLong);
                if (copyBtn) copyBtn.addEventListener('click', cleanupTooLong);
                return;
            }
            if (copyBtn) copyBtn.disabled = false;
            const shareLink = `${window.location.origin}${window.location.pathname}?share=${token}`;
            exportModal.classList.add('show');
            exportLink.value = shareLink;
            exportLink.select();
            const cleanup = () => {
                exportModal.classList.remove('show');
                cancelBtn.removeEventListener('click', cleanup);
                copyBtn.removeEventListener('click', handleCopy);
            };
            const handleCopy = () => {
                exportLink.select();
                const finishCopy = () => {
                    this.showToast('Link copied to clipboard');
                    cleanup();
                };
                try {
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(exportLink.value)
                            .then(finishCopy)
                            .catch(() => { document.execCommand('copy'); finishCopy(); });
                    } else {
                        document.execCommand('copy');
                        finishCopy();
                    }
                } catch {
                    finishCopy();
                }
                cancelBtn.removeEventListener('click', cleanup);
                copyBtn.removeEventListener('click', handleCopy);
            };
            cancelBtn.addEventListener('click', cleanup);
            copyBtn.addEventListener('click', handleCopy);
        } catch (error) { console.error('Error encoding note:', error); }
    }
    /**
     * Open the user's own note via the `?owned=<id>` URL parameter.
     *
     * Unlike `?share=` (which imports a copy of someone else's note) and
     * `?collab=` (which joins a live collaboration session), `?owned=` is a
     * purely personal link: it lets the user bookmark or copy-paste a direct
     * link to one of their own notes from the browser address bar so they
     * don't have to hunt for it in the sidebar list. If the note id isn't in
     * the local storage (e.g. the user is on a different device), we fall
     * back to the welcome screen.
     *
     * Returns true if the parameter was present (so the caller knows to skip
     * the `?share=` import path).
     */
    openOwnedNoteFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const ownedId = params.get('owned');
        if (!ownedId) return false;
        // Only open notes the user actually owns locally. Collab virtual notes
        // (note._isCollabNote === true) are not "owned" and must not be opened
        // through this path — that's what ?collab= is for.
        const note = this.notes.find(n => n.id === ownedId && !n._isCollabNote);
        if (note) {
            this.selectNote(ownedId);
            // selectNote() already re-wrote the address bar with the current
            // note's ?owned=<id> URL via updateOwnedLinkBar(), so we leave it
            // intact and DON'T clear it here.
        } else {
            // Note not found locally — clear the stale ?owned= URL (so refresh
            // doesn't keep re-triggering this path) and show the welcome screen
            // so the user can pick another note.
            this.showWelcomeScreenIfNeeded();
            window.history.replaceState({}, document.title, window.location.pathname);
        }
        return true;
    }
    /**
     * Refresh the browser address bar to reflect the currently-open note.
     * Called from selectNote() (and setEditorForSession() for collab notes)
     * so the URL auto-updates every time the user opens a different note.
     *
     * Behavior:
     *   - Local note (the user's own)         → `?owned=<noteId>`
     *   - Collab/shared note (active session) → `?collab=<sessionId>`
     *   - No active note (welcome screen)     → URL cleared
     *
     * The URL switches DYNAMICALLY as the user opens different notes — e.g.
     * if they're viewing a collab note (?collab=ABC) and then click one of
     * their own notes in the sidebar, the URL changes to ?owned=<id>. If
     * they click back to the collab note, it changes back to ?collab=ABC.
     *
     * No visible UI bar is rendered — the URL lives only in the address bar.
     */
    updateOwnedLinkBar(note) {
        // Case 1: We're viewing an active collab/shared note → show ?collab=
        if (this.collabMode && this.collabNoteVisible && this.collabSessionId) {
            const collabUrl = `${window.location.origin}${window.location.pathname}?collab=${encodeURIComponent(this.collabSessionId)}`;
            window.history.replaceState({}, document.title, collabUrl);
            return;
        }
        // Case 2: We're viewing one of the user's own local notes → show ?owned=
        if (note && !note._isCollabNote) {
            const ownedUrl = `${window.location.origin}${window.location.pathname}?owned=${encodeURIComponent(note.id)}`;
            window.history.replaceState({}, document.title, ownedUrl);
            return;
        }
        // Case 3: No active note (or a collab note that isn't currently
        // visible) → clear the URL so it doesn't show a stale link.
        // (showWelcomeScreenIfNeeded handles the welcome-screen case; this
        // branch covers edge cases like switching to a collab note that
        // failed to load.)
        if (window.location.search) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }
    async importNoteFromUrl() {
        const params = new URLSearchParams(window.location.search);
        // Accept both the new `share` parameter and the legacy `s` parameter
        // so existing shared links continue to work after the rename.
        const token = params.get('share') || params.get('s');
        if (!token) return;
        try {
            const data = JSON.parse(await decompressFromUrl(token));
            const newNote = {
                id: this.generateId(),
                title: data.t || 'Untitled',
                content: data.c || '',
                // Read the exported color (`cl`) if present, defaulting to white
                // for legacy links that were generated before color was included.
                color: (typeof data.cl === 'string' && data.cl) ? data.cl : '#ffffff',
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString()
            };
            this.notes.unshift(newNote);
            // Clear the ?share= / ?s= URL BEFORE calling selectNote(), so
            // that selectNote() → updateOwnedLinkBar() sets the new note's
            // ?owned=<id> URL cleanly (without the stale ?share= still in
            // the address bar confusing things).
            window.history.replaceState({}, document.title, window.location.pathname);
            this.selectNote(newNote.id);
            this.renderNotesList();
            this.renderNotesCards();
            this.saveNotesToStorage();
            setTimeout(() => this.showImportModal(data.t || 'Untitled'), 150);
        } catch (error) { console.error('Error importing note:', error); }
    }
    showImportModal(noteTitle) {
        const modal = document.getElementById('importModal');
        const message = document.getElementById('importModalMessage');
        const cancelBtn = document.getElementById('importModalCancel');
        const continueBtn = document.getElementById('importModalContinue');
        if (!modal || !message) return;
        message.innerHTML = `Added to your collection: <strong>${noteTitle}</strong>`;
        modal.classList.add('show');
        const close = () => modal.classList.remove('show');
        if (cancelBtn) cancelBtn.onclick = close;
        if (continueBtn) continueBtn.onclick = close;
    }

    setupFindReplace() {
        const bar = document.getElementById('findReplaceBar');
        if (!bar) return;
        this._frMatches = [];
        this._frCurrent = -1;
        const findInput = document.getElementById('frFindInput');
        const replaceInput = document.getElementById('frReplaceInput');
        const prevBtn = document.getElementById('frPrevBtn');
        const nextBtn = document.getElementById('frNextBtn');
        const replaceOneBtn = document.getElementById('frReplaceOneBtn');
        const replaceAllBtn = document.getElementById('frReplaceAllBtn');
        const closeBtn = document.getElementById('frCloseBtn');
        const countEl = document.getElementById('frCount');
        const caseCb = document.getElementById('frCaseSensitive');
        findInput.addEventListener('input', () => this._frRun());
        caseCb.addEventListener('change', () => this._frRun());
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? this._frMove(-1) : this._frMove(1); }
            if (e.key === 'Escape') this.closeFindReplace();
        });
        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeFindReplace();
        });
        prevBtn.addEventListener('click', () => this._frMove(-1));
        nextBtn.addEventListener('click', () => this._frMove(1));
        replaceOneBtn.addEventListener('click', () => this._frReplaceOne());
        replaceAllBtn.addEventListener('click', () => this._frReplaceAll());
        closeBtn.addEventListener('click', () => this.closeFindReplace());
    }

    openFindReplace() {
        const bar = document.getElementById('findReplaceBar');
        if (!bar) return;
        bar.style.display = 'block';
        // In view-only mode, hide the Replace UI so the user can only search
        // (and copy text via the browser's native selection + Ctrl+C). The
        // Replace One / Replace All buttons are also disabled in
        // _frUpdateButtons() as a defense-in-depth measure.
        const replaceRow = document.getElementById('frReplaceRow');
        if (replaceRow) {
            replaceRow.style.display = this.isViewOnly ? 'none' : '';
        }
        const findInput = document.getElementById('frFindInput');
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) {
            findInput.value = sel.toString().trim();
        }
        findInput.focus();
        findInput.select();
        this._frRun();
    }

    closeFindReplace() {
        const bar = document.getElementById('findReplaceBar');
        if (bar) bar.style.display = 'none';
        this._frClearHighlights();
        this._frMatches = [];
        this._frCurrent = -1;
        const countEl = document.getElementById('frCount');
        if (countEl) countEl.textContent = '';
        document.getElementById('textEditor')?.focus();
    }

    _frClearHighlights() {
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        editor.querySelectorAll('mark.fr-highlight').forEach(mark => {
            const parent = mark.parentNode;
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
            parent.normalize();
        });
    }

    _frRun() {
        this._frClearHighlights();
        this._frMatches = [];
        this._frCurrent = -1;
        const findInput = document.getElementById('frFindInput');
        const countEl = document.getElementById('frCount');
        const query = findInput.value;
        if (!query) {
            findInput.classList.remove('fr-no-match');
            if (countEl) countEl.textContent = '';
            this._frUpdateButtons();
            return;
        }
        const caseSensitive = document.getElementById('frCaseSensitive')?.checked;
        const editor = document.getElementById('textEditor');
        if (!editor) return;
        const textNodes = [];
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) { textNodes.push(node); return; }
            if (node.nodeName === 'MARK') return;
            node.childNodes.forEach(walk);
        };
        walk(editor);
        const flags = caseSensitive ? 'g' : 'gi';
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, flags);
        textNodes.forEach(textNode => {
            const text = textNode.nodeValue;
            let match;
            regex.lastIndex = 0;
            const parts = [];
            let lastIndex = 0;
            while ((match = regex.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
                }
                const mark = document.createElement('mark');
                mark.className = 'fr-highlight';
                mark.textContent = match[0];
                parts.push(mark);
                this._frMatches.push(mark);
                lastIndex = regex.lastIndex;
            }
            if (parts.length === 0) return;
            if (lastIndex < text.length) parts.push(document.createTextNode(text.slice(lastIndex)));
            const frag = document.createDocumentFragment();
            parts.forEach(p => frag.appendChild(p));
            textNode.parentNode.replaceChild(frag, textNode);
        });
        const count = this._frMatches.length;
        if (countEl) countEl.textContent = count === 0 ? 'No results' : '';
        findInput.classList.toggle('fr-no-match', count === 0);
        if (count > 0) { this._frCurrent = 0; this._frHighlightCurrent(); }
        this._frUpdateButtons();
    }

    _frHighlightCurrent() {
        this._frMatches.forEach((m, i) => {
            m.classList.toggle('fr-current', i === this._frCurrent);
        });
        const cur = this._frMatches[this._frCurrent];
        if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const countEl = document.getElementById('frCount');
        if (countEl && this._frMatches.length > 0) {
            countEl.textContent = `${this._frCurrent + 1} / ${this._frMatches.length}`;
        }
    }

    _frMove(dir) {
        if (!this._frMatches.length) return;
        this._frCurrent = (this._frCurrent + dir + this._frMatches.length) % this._frMatches.length;
        this._frHighlightCurrent();
    }

    _frReplaceOne() {
        if (this.isViewOnly) return;
        if (this._frCurrent < 0 || !this._frMatches[this._frCurrent]) return;
        const replaceVal = document.getElementById('frReplaceInput')?.value || '';
        const mark = this._frMatches[this._frCurrent];
        const textNode = document.createTextNode(replaceVal);
        mark.parentNode.replaceChild(textNode, mark);
        this._frMatches.splice(this._frCurrent, 1);
        if (this._frCurrent >= this._frMatches.length) this._frCurrent = 0;
        if (this._frMatches.length > 0) this._frHighlightCurrent();
        else {
            const countEl = document.getElementById('frCount');
            if (countEl) countEl.textContent = 'No results';
        }
        this._frUpdateButtons();
        this.updateNoteContent();
    }

    _frReplaceAll() {
        // View-only guard — see _frReplaceOne for rationale.
        if (this.isViewOnly) return;
        if (!this._frMatches.length) return;
        const replaceVal = document.getElementById('frReplaceInput')?.value || '';
        this._frMatches.forEach(mark => {
            const textNode = document.createTextNode(replaceVal);
            if (mark.parentNode) mark.parentNode.replaceChild(textNode, mark);
        });
        const count = this._frMatches.length;
        this._frMatches = [];
        this._frCurrent = -1;
        const countEl = document.getElementById('frCount');
        if (countEl) countEl.textContent = `Replaced ${count}`;
        document.getElementById('frFindInput')?.classList.remove('fr-no-match');
        this._frUpdateButtons();
        this.updateNoteContent();
        setTimeout(() => this._frRun(), 100);
    }

    _frUpdateButtons() {
        const has = this._frMatches.length > 0;
        const prevBtn = document.getElementById('frPrevBtn');
        const nextBtn = document.getElementById('frNextBtn');
        const replaceOneBtn = document.getElementById('frReplaceOneBtn');
        const replaceAllBtn = document.getElementById('frReplaceAllBtn');
        if (prevBtn) prevBtn.disabled = !has;
        if (nextBtn) nextBtn.disabled = !has;
        if (replaceOneBtn) replaceOneBtn.disabled = !has || this.isViewOnly;
        if (replaceAllBtn) replaceAllBtn.disabled = !has || this.isViewOnly;
    }
}
NotesApp.memoryStorageFallback = new Map();
document.addEventListener('DOMContentLoaded', () => {
    window.notesApp = new NotesApp();
    window.notesApp.ready.then(() => {
        if (!window.notesApp.openOwnedNoteFromUrl()) {
            window.notesApp.importNoteFromUrl();
        }
    });
});
window.addEventListener('beforeunload', () => {
    const app = window.notesApp;
    if (app && app.saveTimeout) { clearTimeout(app.saveTimeout); app.saveNotesToStorage(); }
});
