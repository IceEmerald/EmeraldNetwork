/* ==========================================================================
   EmeraldSuite shared mobile chrome
   Provides the notes-style mobile sidebar drawer, edge pill, floating view
   switch and adaptive ribbon behaviour to Docs, Slides and Sheets.
   ========================================================================== */
(function () {
    "use strict";

    var MOBILE_MAX = 1023;
    var EDGE_ZONE = 40;
    var SWIPE_THRESHOLD = 52;
    var SWIPE_MAX_VERTICAL = 90;
    var SWIPE_MAX_TIME = 650;
    var instances = new Map();

    function qs(value, root) {
        if (!value) return null;
        if (typeof value !== "string") return value;
        return (root || document).querySelector(value);
    }

    function make(tag, className, html) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (html != null) node.innerHTML = html;
        return node;
    }

    function svg(paths, size) {
        size = size || 16;
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            paths + "</svg>";
    }

    function isMobile() {
        return window.innerWidth <= MOBILE_MAX;
    }

    function MobileShell(config) {
        this.config = config || {};
        this.app = this.config.app || "suite";
        this.root = qs(this.config.root) || document.body;
        this.sidebar = qs(this.config.sidebar);
        this.toggle = qs(this.config.toggle) || (this.sidebar && qs(".sidebar-toggle", this.sidebar));
        this.backdrop = null;
        this.sidepill = null;
        this.menuBtn = null;
        this.viewSwitch = null;
        this.viewButtons = [];
        this.currentView = this.config.viewSwitch && this.config.viewSwitch.defaultMode;
        this.isOpen = false;
        this.touch = null;
        this._init();
    }

    MobileShell.prototype._init = function () {
        var self = this;

        if (this.config.accent) {
            document.body.style.setProperty("--suite-accent", this.config.accent);
            document.body.style.setProperty("--suite-accent-soft", this.config.accentSoft || this._soft(this.config.accent));
            document.body.style.setProperty("--suite-accent-border", this.config.accentBorder || this._border(this.config.accent));
        }

        this._ensureBackdrop();
        this._ensureSidepill();
        this._ensureMenuButton();
        this._ensureViewSwitch();
        this._bindToggle();
        this._bindSwipe();
        this._bindGlobal();

        this.refresh();
        window.addEventListener("resize", function () {
            if (self._raf) return;
            self._raf = requestAnimationFrame(function () {
                self._raf = null;
                if (!isMobile()) self.close(true);
                self.refresh();
            });
        }, { passive: true });
    };

    MobileShell.prototype._soft = function (hex) {
        var rgb = this._rgb(hex);
        return rgb ? "rgba(" + rgb + ", 0.14)" : "rgba(16, 185, 129, 0.14)";
    };

    MobileShell.prototype._border = function (hex) {
        var rgb = this._rgb(hex);
        return rgb ? "rgba(" + rgb + ", 0.35)" : "rgba(16, 185, 129, 0.35)";
    };

    MobileShell.prototype._rgb = function (hex) {
        if (!hex || hex.charAt(0) !== "#") return null;
        var h = hex.slice(1);
        if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        if (h.length !== 6) return null;
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(", ");
    };

    MobileShell.prototype._ensureBackdrop = function () {
        var self = this;
        var el = document.getElementById("suiteBackdrop");
        if (!el) {
            el = make("div", "suite-backdrop sidebar-backdrop");
            el.id = "suiteBackdrop";
            document.body.appendChild(el);
        }
        el.addEventListener("click", function () { self.close(); });
        this.backdrop = el;
    };

    MobileShell.prototype._ensureSidepill = function () {
        var self = this;
        var el = document.getElementById("suiteSidepill");
        if (!el) {
            el = make("button", "suite-sidepill");
            el.id = "suiteSidepill";
            el.type = "button";
            el.setAttribute("aria-label", "Open sidebar");
            el.title = "Open sidebar";
            document.body.appendChild(el);
        }
        el.addEventListener("click", function () { self.open(); });
        this.sidepill = el;
    };

    MobileShell.prototype._ensureMenuButton = function () {
        if (this.config.menuButton === false || !this.sidebar) return;
        var self = this;
        var host = qs(".nav-links") || qs(".hdr-right") || qs("#app-header");
        var btn = document.getElementById("suiteMenuBtn");
        if (!btn) {
            btn = make("button", "suite-menu-btn");
            btn.id = "suiteMenuBtn";
            btn.type = "button";
            btn.title = "Open sidebar";
            btn.setAttribute("aria-label", "Open sidebar");
            btn.innerHTML = svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', 18);
        }
        if (host && btn.parentNode !== host) host.insertBefore(btn, host.firstChild);
        btn.addEventListener("click", function () { self.open(); });
        this.menuBtn = btn;
    };

    MobileShell.prototype._ensureViewSwitch = function () {
        var self = this;
        var cfg = this.config.viewSwitch;
        if (!cfg || !cfg.modes || !cfg.modes.length) return;
        var el = document.getElementById("suiteViewSwitch");
        if (!el) {
            el = make("div", "suite-view-switch");
            el.id = "suiteViewSwitch";
            el.setAttribute("role", "group");
            el.setAttribute("aria-label", "View mode");
            document.body.appendChild(el);
        }
        el.innerHTML = "";
        this.viewButtons = [];
        cfg.modes.forEach(function (mode) {
            var btn = make("button", "suite-view-pill");
            btn.type = "button";
            btn.dataset.mode = mode.id;
            btn.setAttribute("aria-pressed", "false");
            btn.innerHTML = (mode.icon ? svg(mode.icon, 14) : "") + "<span>" + mode.label + "</span>";
            btn.addEventListener("click", function () { self.selectView(mode.id); });
            el.appendChild(btn);
            self.viewButtons.push(btn);
        });
        this.viewSwitch = el;
    };

    MobileShell.prototype._bindToggle = function () {
        var self = this;
        if (this.toggle) {
            this.toggle.addEventListener("click", function (e) {
                e.preventDefault();
                if (isMobile()) self.toggleOpen();
                else if (self.config.desktopToggle) self.config.desktopToggle();
            });
        }
        if (this.config.newButton) {
            var newBtn = qs(this.config.newButton);
            if (newBtn) {
                newBtn.addEventListener("click", function (e) {
                    e.preventDefault();
                    if (typeof self.config.onNew === "function") self.config.onNew();
                    self.close();
                });
            }
        }
    };

    MobileShell.prototype._bindGlobal = function () {
        var self = this;
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && self.isOpen) self.close();
        });
    };

    MobileShell.prototype._bindSwipe = function () {
        var self = this;
        if (!this.root) return;

        this.root.addEventListener("touchstart", function (e) {
            if (!isMobile() || !self.sidebar) return;
            if (e.touches.length !== 1) return;
            var target = e.target;
            if (target && target.closest && target.closest(
                "input, textarea, select, [contenteditable='true'], .ms-dropdown-menu, .suite-sidebar, .modal, .modal-overlay, .ribbon, .ribbon-tabs, canvas"
            )) return;
            var t = e.touches[0];
            self.touch = {
                x: t.clientX,
                y: t.clientY,
                time: Date.now(),
                swiping: false
            };
        }, { passive: true });

        this.root.addEventListener("touchmove", function (e) {
            if (!isMobile() || !self.sidebar || !self.touch || e.touches.length !== 1) return;
            var t = e.touches[0];
            var dx = t.clientX - self.touch.x;
            var dy = t.clientY - self.touch.y;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) self.touch.swiping = true;
            if (!self.touch.swiping) return;
            var width = self.sidebar.offsetWidth || 320;
            if (self.isOpen && dx < 0) {
                var closeDx = Math.max(dx, -width);
                self.sidebar.style.transition = "none";
                self.sidebar.style.transform = "translateX(" + closeDx + "px)";
            } else if (!self.isOpen && dx > 0 && self.touch.x <= EDGE_ZONE) {
                var openDx = Math.min(dx - width, 0);
                self.sidebar.style.transition = "none";
                self.sidebar.style.transform = "translateX(" + openDx + "px)";
            }
        }, { passive: true });

        this.root.addEventListener("touchend", function (e) {
            if (!isMobile() || !self.sidebar || !self.touch) return;
            var t = e.changedTouches && e.changedTouches[0];
            if (!t) { self.touch = null; return; }
            var dx = t.clientX - self.touch.x;
            var dy = t.clientY - self.touch.y;
            var dt = Date.now() - self.touch.time;
            var startedAtEdge = self.touch.x <= EDGE_ZONE;
            var horizontal = Math.abs(dx) > SWIPE_THRESHOLD &&
                Math.abs(dy) < SWIPE_MAX_VERTICAL &&
                dt < SWIPE_MAX_TIME;

            self.sidebar.style.transition = "";
            self.sidebar.style.transform = "";

            if (horizontal) {
                if (dx > 0 && !self.isOpen && startedAtEdge) self.open();
                else if (dx < 0 && self.isOpen) self.close();
            }
            self.touch = null;
        }, { passive: true });
    };

    MobileShell.prototype._sidebarVisible = function () {
        if (!isMobile()) return false;
        if (!this.sidebar) return false;
        if (typeof this.config.sidebarVisible === "function" && !this.config.sidebarVisible()) return false;
        return true;
    };

    MobileShell.prototype.refresh = function () {
        var mobile = isMobile();
        document.body.classList.toggle("suite-mobile", mobile);

        var visible = this._sidebarVisible();
        if (this.sidepill) {
            this.sidepill.classList.toggle("is-visible", visible && !this.isOpen);
            this.sidepill.classList.toggle("is-hidden", !visible || this.isOpen);
            this.sidepill.setAttribute("aria-hidden", visible ? "false" : "true");
        }
        if (this.menuBtn) {
            this.menuBtn.style.display = visible ? "" : "none";
        }
        this.updateView();
    };

    MobileShell.prototype.updateView = function () {
        if (!this.viewSwitch) return;
        var cfg = this.config.viewSwitch || {};
        var visible = isMobile() && this._sidebarVisible();
        if (typeof cfg.visible === "function") visible = isMobile() && !!cfg.visible();
        this.viewSwitch.classList.toggle("is-visible", visible);
        var active = this.currentView;
        if (typeof cfg.active === "function") {
            try { active = cfg.active(); } catch (e) { active = this.currentView; }
        }
        for (var i = 0; i < this.viewButtons.length; i++) {
            var btn = this.viewButtons[i];
            var on = btn.dataset.mode === active;
            btn.setAttribute("aria-pressed", on ? "true" : "false");
        }
    };

    MobileShell.prototype.selectView = function (mode) {
        this.currentView = mode;
        var cfg = this.config.viewSwitch || {};
        if (typeof cfg.onSelect === "function") cfg.onSelect(mode);
        this.updateView();
    };

    MobileShell.prototype.open = function () {
        if (!this._sidebarVisible()) return;
        this.sidebar.classList.add("mobile-open", "open");
        this.sidebar.setAttribute("aria-hidden", "false");
        if (this.backdrop) this.backdrop.classList.add("visible");
        document.body.classList.add("suite-sidebar-open");
        this.isOpen = true;
        this.refresh();
        if (typeof this.config.onSidebarOpen === "function") {
            try { this.config.onSidebarOpen(); } catch (e) { }
        }
    };

    MobileShell.prototype.close = function (silent) {
        if (!this.sidebar) return;
        this.sidebar.classList.remove("mobile-open", "open");
        this.sidebar.setAttribute("aria-hidden", "true");
        if (this.backdrop) this.backdrop.classList.remove("visible");
        document.body.classList.remove("suite-sidebar-open");
        this.isOpen = false;
        this.refresh();
        if (!silent && typeof this.config.onSidebarClose === "function") {
            try { this.config.onSidebarClose(); } catch (e) { }
        }
    };

    MobileShell.prototype.toggleOpen = function () {
        if (this.isOpen) this.close();
        else this.open();
    };

    var SuiteMobile = {
        isMobile: isMobile,
        init: function (config) {
            var key = (config && config.app) || "suite";
            var existing = instances.get(key);
            if (existing) {
                existing.refresh();
                return existing;
            }
            var shell = new MobileShell(config);
            instances.set(key, shell);
            return shell;
        },
        get: function (app) {
            return instances.get(app || "suite") || null;
        },
        openSidebar: function (app) {
            var shell = instances.get(app);
            if (shell) shell.open();
        },
        closeSidebar: function (app) {
            var shell = instances.get(app);
            if (shell) shell.close();
        },
        toggleSidebar: function (app) {
            var shell = instances.get(app);
            if (shell) shell.toggleOpen();
        },
        refresh: function () {
            instances.forEach(function (shell) { shell.refresh(); });
        },
        selectView: function (app, mode) {
            var shell = instances.get(app);
            if (shell) shell.selectView(mode);
        }
    };

    window.SuiteMobile = SuiteMobile;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            document.body.classList.toggle("suite-mobile", isMobile());
        });
    } else {
        document.body.classList.toggle("suite-mobile", isMobile());
    }
})();
