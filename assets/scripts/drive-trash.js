(function () {
    'use strict';
    var KEY = 'emerald.drive.metadata.v1';
    function key(type, id) { return String(type) + ':' + String(id); }
    async function metadata() {
        var storage = window.EmeraldIDBStorage;
        if (!storage || !storage.getJSON) return {};
        try { return (await storage.getJSON(KEY)) || {}; } catch (_) { return {}; }
    }
    async function isTrashed(type, id) {
        var values = await metadata();
        return !!(values[key(type, id)] && values[key(type, id)].trashed);
    }
    async function moveToTrash(type, id, title) {
        var storage = window.EmeraldIDBStorage;
        if (!storage || !storage.setJSON) return false;
        var values = await metadata();
        values[key(type, id)] = Object.assign({}, values[key(type, id)], {
            trashed: true, trashedAt: Date.now(), title: String(title || 'Untitled')
        });
        await storage.setJSON(KEY, values);
        return true;
    }
    window.EmeraldDriveTrash = { isTrashed: isTrashed, moveToTrash: moveToTrash };
})();
