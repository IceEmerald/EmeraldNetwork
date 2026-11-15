

(function () {
    'use strict';

    var STORE_THEME = 'emeraldcore.wiki.theme';

    var root = document.querySelector('.wiki-root');
    if (!root) return;

    var nav = root.querySelector('.wiki-nav');
    var searchInput = root.querySelector('[data-wiki-search]');
    var searchClear = root.querySelector('.wiki-search-clear');
    var emptyState = root.querySelector('.wiki-empty');
    var notFound = root.querySelector('[data-notfound]');
    var hero = root.querySelector('[data-hero]');
    var burger = root.querySelector('.wiki-burger');
    var themeBtn = root.querySelector('.wiki-theme-btn');
    var crumbs = root.querySelector('[data-crumbs]');
    var pager = root.querySelector('[data-pager]');
    var toc = root.querySelector('[data-outline]');
    var main = root.querySelector('.wiki-main');

    var blocks = [].slice.call(root.querySelectorAll('.wiki-block'));

    function el(tag, className, text) {
        var n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    function readStore(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {  }
    }

    function normalize(s) { return (s || '').toLowerCase(); }

    function slug(text) {
        return normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function debounce(fn, wait) {
        var t;
        return function () {
            var args = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(self, args); }, wait);
        };
    }

    function cleanTitle(heading) {
        if (!heading) return '';
        var clone = heading.cloneNode(true);
        var anchors = clone.querySelectorAll('.wiki-anchor');
        for (var i = 0; i < anchors.length; i++) anchors[i].remove();
        return clone.textContent.trim();
    }

    function titleOf(pageEl) {
        return cleanTitle(pageEl.querySelector('.wiki-block-head h2')) || pageEl.id;
    }

    function setAccent(node, accent, soft) {
        if (!node || !accent) return;
        node.style.setProperty('--w-app', accent);
        node.style.setProperty('--w-app-ink', inkFor(accent));
        node.style.setProperty('--w-app-soft', alphaOf(inkFor(accent), soft === undefined ? 0.16 : soft));
    }

    function isDark() {
        return document.documentElement.getAttribute('data-wiki-theme') === 'dark';
    }

    function applyAccent(node, accent) {
        setAccent(node, accent, 0.16);
    }

    function alphaOf(accent, alpha) {
        var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((accent || '').trim());
        if (!m) return 'rgba(35, 154, 77, ' + alpha + ')';
        return 'rgba(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ', ' + alpha + ')';
    }

    function accentOf(node) {
        var value = window.getComputedStyle(node).getPropertyValue('--w-app');
        return (value || '').trim() || '#239a4d';
    }

    var DARK_PANEL = '#252525';

    function rgbOf(hex) {
        var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim());
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }

    function toHex(rgb) {
        return '#' + rgb.map(function (n) {
            return ('0' + Math.round(Math.min(255, Math.max(0, n))).toString(16)).slice(-2);
        }).join('');
    }

    function whiten(hex, pct) {
        var rgb = rgbOf(hex);
        if (!rgb) return hex;
        return toHex(rgb.map(function (n) { return n + (255 - n) * pct / 100; }));
    }

    function relativeLuminance(hex) {
        var rgb = rgbOf(hex);
        if (!rgb) return 0;
        var c = rgb.map(function (n) {
            n /= 255;
            return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    function contrast(a, b) {
        var la = relativeLuminance(a), lb = relativeLuminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    function liftFor(accent, target) {
        var best = accent;
        for (var pct = 0; pct <= 100; pct += 4) {
            var candidate = whiten(accent, pct);
            if (contrast(candidate, DARK_PANEL) >= target) return candidate;
            best = candidate;
        }
        return best;
    }

    function inkFor(accent) {
        if (!accent || accent.indexOf('var(') === 0) return accent;
        return isDark() ? liftFor(accent, 4.5) : accent;
    }

    function refreshAccents() {
        if (!root) return;
        var dark = isDark();
        var soft = dark ? 0.22 : 0.16;

        [].forEach.call(root.querySelectorAll(
            '.wiki-block, .wiki-nav-link, .wiki-nav-pill, .wiki-nav-outline-pill, .wiki-toc, .wiki-pager-btn'
        ), function (el) {
            var accent = el.style.getPropertyValue('--w-app');
            if (!accent) return;
            el.style.setProperty('--w-app-ink', inkFor(accent));
            if (el.style.getPropertyValue('--w-app-soft')) {
                el.style.setProperty('--w-app-soft', alphaOf(inkFor(accent), soft));
            }
        });
    }

    var toastEl = document.getElementById('custom-toast');
    var toastTimer = null;

    function toast(message) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
    }

    var products = [];
    var productByKey = {};
    var info = {};

    function buildModel() {
        blocks.forEach(function (block, order) {
            var key = block.getAttribute('data-product') || 'other';
            var label = block.getAttribute('data-product-label');

            if (!productByKey[key]) {
                productByKey[key] = {
                    key: key,
                    label: label || key,
                    accent: accentOf(block),
                    pages: []
                };
                products.push(productByKey[key]);
            } else if (label) {
                productByKey[key].label = label;
            }

            info[block.id] = { el: block, product: key, order: order, only: false };
            productByKey[key].pages.push(block);
        });

        products.forEach(function (product) {
            product.pages.forEach(function (page) { info[page.id].only = product.pages.length === 1; });
        });
    }

    function addressOf(pageEl) {
        var entry = info[pageEl.id];
        if (!entry) return '';
        return entry.only ? entry.product : entry.product + '.' + entry.el.id;
    }

    var readingOrder = [];

    function buildReadingOrder() {
        blocks.forEach(function (block) {
            var heading = block.querySelector('.wiki-block-head h2');
            var sub = block.querySelector('.wiki-block-head p');
            readingOrder.push({
                el: block,
                address: addressOf(block),
                product: info[block.id].product,
                label: titleOf(block),
                summary: sub ? sub.textContent.trim() : '',
                accent: accentOf(block)
            });
        });
    }

    function productAddress(product) {

        return product.pages.length === 1 ? addressOf(product.pages[0]) : product.key;
    }

    var view = { product: 'home', pageId: null, all: false };

    function resolve(raw) {
        if (raw == null) return null;
        var text = String(raw).trim();
        if (!text) return null;

        if (text.toLowerCase() === 'all') return { all: true };

        var dot = text.indexOf('.');
        if (dot > -1) {
            var productKey = text.slice(0, dot);
            var pageId = text.slice(dot + 1);

            if (info[pageId]) {
                var entry = info[pageId];
                return { product: entry.product, pageId: entry.only ? null : pageId };
            }
            if (productByKey[productKey]) return { product: productKey, pageId: null };
            return null;
        }

        if (productByKey[text]) return { product: text, pageId: null };
        if (info[text]) {
            var single = info[text];
            return { product: single.product, pageId: single.only ? null : text };
        }
        return null;
    }

    function pagesFor(target) {
        if (!target) return [];
        if (target.all) return blocks.slice();
        var product = productByKey[target.product];
        if (!product) return [];
        if (target.pageId) {
            var entry = info[target.pageId];
            return entry ? [entry.el] : [];
        }
        return product.pages.slice();
    }

    function currentAddress() {
        if (view.all) return 'all';
        if (view.pageId) return view.product + '.' + view.pageId;
        return view.product;
    }

    function routeInUrl() {
        return new URLSearchParams(window.location.search).get('section');
    }

    function writeUrl(address, push) {
        var url = window.location.pathname + '?section=' + encodeURIComponent(address);
        try {
            window.history[push ? 'pushState' : 'replaceState']({ wiki: true }, '', url);
        } catch (e) {  }
    }

    var searching = false;
    var lastRoute = { product: 'home', pageId: null };

    function render(opts) {
        opts = opts || {};

        var target = view.all ? { all: true } : { product: view.product, pageId: view.pageId };
        var visible = pagesFor(target);
        var visibleIds = {};
        visible.forEach(function (b) { visibleIds[b.id] = true; });

        blocks.forEach(function (block) {
            block.classList.toggle('is-page-hidden', !visibleIds[block.id]);
        });

        if (!searching) lastRoute = { product: view.product, pageId: view.pageId };

        if (hero) hero.hidden = view.all || view.product !== 'home';
        if (pager) pager.hidden = view.all || (notFound && !notFound.hidden);
        updateChrome(visible);
    }

    var switchPending = null;
    var switchAnimating = false;

    var SWITCH_MS = 180;

    function applyRoute(target, opts) {
        if (notFound) notFound.hidden = true;

        view = target;
        render();

        var address = currentAddress();
        writeUrl(address, opts.push !== false && !opts.fromScroll);

        if (opts.fromScroll) {

        } else {

            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        syncSidebar();
    }

    function go(target, opts) {
        opts = opts || {};

        if (!target) {
            showNotFound(opts.rawAddress);
            return;
        }

        if (opts.fromScroll || opts.instant || !main) {
            applyRoute(target, opts);
            return;
        }

        if (switchAnimating) {
            switchPending = { target: target, opts: opts };
            return;
        }

        switchPending = { target: target, opts: opts };
        switchAnimating = true;
        main.classList.add('is-switching');

        setTimeout(function () {
            var next = switchPending;
            switchPending = null;
            try {
                if (next) applyRoute(next.target, next.opts);
            } finally {

                void main.offsetWidth;
                main.classList.remove('is-switching');
                setTimeout(function () { switchAnimating = false; }, 200);
            }
        }, SWITCH_MS);
    }

    function showNotFound(address) {
        blocks.forEach(function (block) { block.classList.add('is-page-hidden'); });
        if (hero) hero.hidden = true;
        if (pager) pager.hidden = true;
        if (notFound) {
            notFound.hidden = false;
            var slot = notFound.querySelector('[data-notfound-route]');
            if (slot) slot.textContent = '?section=' + (address || '');
        }
        syncSidebar();
    }

    function buildSidebar() {
        if (!nav) return;
        nav.innerHTML = '';

        var list = el('ul', 'wiki-nav-list');
        var currentCategory = null;

        products.forEach(function (product) {
            product.pages.forEach(function (page, index) {
                var category = page.getAttribute('data-category') || 'Pages';

                if (category !== currentCategory) {
                    currentCategory = category;
                    nav.appendChild(el('div', 'wiki-nav-group', category));
                    list = el('ul', 'wiki-nav-list');
                    nav.appendChild(list);
                }

                var li = el('li');

                if (index === 0) {
                    var link = el('a', 'wiki-nav-link wiki-nav-link--product');
                    link.href = '#';
                    link.setAttribute('data-nav', product.key);
                    link.title = product.label;
                    link.style.setProperty('--w-app', product.accent);
                    link.appendChild(el('span', 'wiki-nav-text', product.label));
                    if (product.pages.length > 1) link.appendChild(el('span', 'wiki-nav-count', String(product.pages.length)));
                    li.appendChild(link);

                    if (product.pages.length > 1) {
                        var sub = el('ul', 'wiki-nav-sub');
                        sub.setAttribute('data-sub', product.key);
                        sub.hidden = true;
                        product.pages.forEach(function (subPage) {
                            var sli = el('li');
                            var slink = el('a', 'wiki-nav-link wiki-nav-link--page');
                            slink.href = '#';
                            slink.setAttribute('data-nav', addressOf(subPage));
                            slink.style.setProperty('--w-app', accentOf(subPage));
                            slink.appendChild(el('span', 'wiki-nav-text', titleOf(subPage)));
                            sli.appendChild(slink);
                            sub.appendChild(sli);
                        });
                        li.appendChild(sub);
                    }
                }

                list.appendChild(li);
            });
        });

        nav.addEventListener('click', function (e) {
            var link = e.target.closest('.wiki-nav-link');
            if (!link) return;
            e.preventDefault();
            closeNav();
            var target = resolve(link.getAttribute('data-nav'));
            go(target || { product: link.getAttribute('data-nav'), pageId: null });
        });
    }

    function buildOutline() {
        var holder = toc;
        if (!holder) return;
        holder.innerHTML = '';

        var page = null;
        if (!view.all) {
            if (view.pageId) {
                page = info[view.pageId].el;
            } else if (view.product && productByKey[view.product]) {
                page = productByKey[view.product].pages[0];
            }
        }
        if (!page) return;

        if (notFound && !notFound.hidden) {
            holder.innerHTML = '';
            return;
        }

        var headings = [].slice.call(page.querySelectorAll('.wiki-block-body h3'))
            .filter(function (h) { return h.id && !h.querySelector('.wiki-anchor') || h.id; });

        if (!headings.length) return;

        applyAccent(holder, accentOf(page));

        holder.appendChild(el('div', 'wiki-nav-group wiki-nav-outline-title', 'On this page'));

        var ol = el('ol');
        headings.forEach(function (heading) {
            var li = el('li');
            li.setAttribute('data-level', heading.tagName === 'H4' ? '4' : '3');
            var a = el('a', null, cleanTitle(heading));
            a.href = '#' + heading.id;
            a.setAttribute('data-outline', heading.id);
            li.appendChild(a);
            ol.appendChild(li);
        });

        var pill = el('span', 'wiki-nav-outline-pill');
        pill.setAttribute('aria-hidden', 'true');
        holder.appendChild(pill);
        holder.appendChild(ol);

        refreshHeading();
    }

    function syncOutlinePill() {
        var holder = toc;
        if (!holder) return;

        var pill = holder.querySelector('.wiki-nav-outline-pill');
        if (!pill) return;

        var link = holder.querySelector('a.is-current');
        if (!link) {
            pill.classList.remove('is-on');
            return;
        }

        var h = link.offsetHeight;
        var rail = h ? Math.max(11, Math.round(h * 0.66)) : 11;
        var y = h ? Math.round(link.offsetTop + (h - rail) / 2) : Math.round(link.offsetTop);

        pill.style.height = rail + 'px';
        pill.style.transform = 'translate3d(0,' + y + 'px,0)';
        pill.classList.add('is-on');
    }

    function setCurrentHeading(id) {
        var holder = toc;
        if (!holder || !id) return;

        var links = holder.querySelectorAll('a[data-outline]');
        var found = null;
        [].forEach.call(links, function (a) {
            var on = a.getAttribute('data-outline') === id;
            a.classList.toggle('is-current', on);
            if (on) found = a;
        });

        if (!found && links.length) {
            links[links.length - 1].classList.add('is-current');
        }

        syncOutlinePill();
    }

    function syncSidebar() {
        if (!nav) return;
        var address = currentAddress();
        var active = view.all ? 'all' : (view.pageId ? view.product + '.' + view.pageId : view.product);

        [].forEach.call(nav.querySelectorAll('.wiki-nav-link'), function (link) {
            var key = link.getAttribute('data-nav');
            link.classList.toggle('is-active', key === address || key === active);
        });

        [].forEach.call(nav.querySelectorAll('.wiki-nav-sub'), function (sub) {
            sub.hidden = sub.getAttribute('data-sub') !== view.product;
        });

        syncPill();
    }

    function syncPill() {
        if (!nav) return;

        var pill = nav.querySelector('.wiki-nav-pill');
        if (!pill) {
            pill = el('span', 'wiki-nav-pill');
            pill.setAttribute('aria-hidden', 'true');
            nav.insertBefore(pill, nav.firstChild);
        }

        var row = nav.querySelector('.wiki-nav-link.is-reading') ||
            nav.querySelector('.wiki-nav-link.is-active');

        if (!row) {
            pill.classList.remove('is-on');
            return;
        }

        var h = row.offsetHeight;
        var rail = h ? Math.max(14, Math.round(h * 0.62)) : 14;
        var y = h ? Math.round(row.offsetTop + (h - rail) / 2) : Math.round(row.offsetTop);
        var accent = getComputedStyle(row).getPropertyValue('--w-app');

        setAccent(pill, accent || 'var(--w-brand)');
        pill.style.height = rail + 'px';
        pill.style.transform = 'translate3d(0,' + y + 'px,0)';
        pill.classList.add('is-on');
    }

    function updateChrome(visible) {
        buildOutline();

        refreshAccents();

        if (crumbs) {
            crumbs.innerHTML = '';
            var home = el('a', 'wiki-crumb', 'Wiki');
            home.href = '?section=home';
            home.addEventListener('click', function (e) { e.preventDefault(); closeNav(); go({ product: 'home', pageId: null }); });
            crumbs.appendChild(home);

            var product = productByKey[view.product];
            if (product && visible.length > 1) {
                crumbs.appendChild(el('span', 'wiki-crumb-sep', '/'));
                var pl = el('a', 'wiki-crumb', product.label);
                pl.href = '?section=' + product.key;
                pl.addEventListener('click', function (e) { e.preventDefault(); closeNav(); go({ product: product.key, pageId: null }); });
                crumbs.appendChild(pl);
            }

            if (view.pageId) {
                crumbs.appendChild(el('span', 'wiki-crumb-sep', '/'));
                crumbs.appendChild(el('span', 'wiki-crumb wiki-crumb--current', titleOf(info[view.pageId].el)));
            }
        }

        if (pager && !pager.hidden) {
            pager.innerHTML = '';

            var currentEl = view.pageId
                ? info[view.pageId].el
                : (productByKey[view.product] ? productByKey[view.product].pages[0] : null);
            var index = readingOrder.findIndex(function (entry) { return entry.el === currentEl; });

            function pageButton(entry, direction) {
                var btn = el('a', 'wiki-pager-btn wiki-pager-btn--' + direction);
                btn.href = '?section=' + entry.address;
                applyAccent(btn, entry.accent);
                btn.appendChild(el('span', 'wiki-pager-dir', direction === 'prev' ? '←' : '→'));
                var body = el('span', 'wiki-pager-body');
                body.appendChild(el('span', 'wiki-pager-kind', entry.product === view.product ? 'Same product' : productByKey[entry.product].label));
                body.appendChild(el('span', 'wiki-pager-label', entry.label));
                btn.appendChild(body);
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    closeNav();
                    go(resolve(entry.address));
                });
                return btn;
            }

            var prev = index > 0 ? readingOrder[index - 1] : null;
            var next = (index > -1 && index < readingOrder.length - 1) ? readingOrder[index + 1] : null;

            if (prev) pager.appendChild(pageButton(prev, 'prev'));
            if (next) pager.appendChild(pageButton(next, 'next'));
            if (!prev && !next) pager.hidden = true;
        }
    }

    function applyTheme(theme) {
        var resolved = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-wiki-theme', resolved);

        refreshAccents();
        if (themeBtn) {
            var label = 'Theme: ' + resolved + '. Click to switch.';
            themeBtn.setAttribute('aria-label', label);
            themeBtn.setAttribute('title', label);
        }
    }

    function initTheme() {
        applyTheme(readStore(STORE_THEME, 'light'));
        if (!themeBtn) return;

        themeBtn.addEventListener('click', function () {
            var next = readStore(STORE_THEME, 'light') === 'dark' ? 'light' : 'dark';
            writeStore(STORE_THEME, next);
            applyTheme(next);
            toast('Theme: ' + next);
        });
    }

    function initCopy() {

        [].forEach.call(root.querySelectorAll('.wiki-copy'), function (row) {
            if (row.querySelector('.wiki-copy-btn')) return;
            row.appendChild(el('button', 'wiki-copy-btn', 'Copy'));
        });

        root.addEventListener('click', function (e) {
            var copyBtn = e.target.closest('.wiki-copy-btn');
            if (copyBtn) {
                var row = copyBtn.closest('.wiki-copy');
                var code = row && row.querySelector('code');
                var text = ((code ? code.textContent : (row ? row.textContent : '')) || '').trim();
                copyText(text).then(function () {
                    copyBtn.textContent = 'Copied';
                    toast('Copied to clipboard');
                    setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1400);
                }, function () {
                    toast('Copy blocked — select the text manually');
                });
                return;
            }

        });
    }

    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            ok ? resolve() : reject();
        });
    }

    var filterState = {};

    function applyFilter(name) {
        var bar = root.querySelector('.wiki-filters[data-filter-for="' + name + '"]');
        if (!bar) return;

        var scope = root.querySelector('[data-filter-scope="' + name + '"]');
        if (!scope) return;

        var items = [].slice.call(scope.querySelectorAll('[data-cat]'));
        var readout = bar.parentNode ? bar.parentNode.querySelector('[data-filter-count]') : null;
        var value = filterState[name] || 'all';

        [].forEach.call(bar.querySelectorAll('.wiki-filter'), function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-value') === value);
        });

        var shown = 0;
        items.forEach(function (item) {
            var cat = item.getAttribute('data-cat') || '';
            var show = value === 'all' || (' ' + cat).indexOf(' ' + value) !== -1;
            item.classList.toggle('is-filtered', !show);
            if (show) shown++;
        });

        if (readout) {
            readout.textContent = shown === items.length ? '' : shown + ' of ' + items.length;
        }
    }

    function syncFilters() {
        Object.keys(filterState).forEach(applyFilter);
    }

    function initFilters() {
        [].forEach.call(root.querySelectorAll('.wiki-filters[data-filter-for]'), function (bar) {
            filterState[bar.getAttribute('data-filter-for')] = 'all';
        });

        root.addEventListener('click', function (e) {
            var btn = e.target.closest('.wiki-filter');
            if (!btn) return;
            var bar = btn.closest('.wiki-filters[data-filter-for]');
            if (!bar) return;
            filterState[bar.getAttribute('data-filter-for')] = btn.getAttribute('data-value');
            applyFilter(bar.getAttribute('data-filter-for'));
        });
    }

    var index = [];

    function buildIndex() {
        blocks.forEach(function (block) {
            var body = block.querySelector('.wiki-block-body');
            var heading = block.querySelector('.wiki-block-head h2');
            if (!body) return;

            block.__originalHTML = body.innerHTML;

            index.push({
                block: block,
                body: body,
                text: normalize(
                    (heading ? heading.textContent : '') + ' ' +
                    (block.getAttribute('data-tags') || '') + ' ' +
                    body.textContent
                )
            });
        });
    }

    function restore(entry) {
        entry.body.innerHTML = entry.block.__originalHTML;
    }

    function wrapMatches(rootNode, query) {
        var walker = document.createTreeWalker(rootNode, window.NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || node.nodeValue.trim() === '') return window.NodeFilter.FILTER_REJECT;
                var parent = node.parentNode;
                if (!parent) return window.NodeFilter.FILTER_REJECT;
                var tag = parent.nodeName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return window.NodeFilter.FILTER_REJECT;
                if (normalize(node.nodeValue).indexOf(query) === -1) return window.NodeFilter.FILTER_REJECT;
                return window.NodeFilter.FILTER_ACCEPT;
            }
        });

        var targets = [];
        var node;
        while ((node = walker.nextNode())) targets.push(node);

        targets.forEach(function (textNode) {
            var text = textNode.nodeValue;
            var lower = normalize(text);
            var fragment = document.createDocumentFragment();
            var cursor = 0;
            var at;

            while ((at = lower.indexOf(query, cursor)) !== -1) {
                if (at > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, at)));
                fragment.appendChild(el('mark', 'wiki-hit', text.substr(at, query.length)));
                cursor = at + query.length;
            }
            if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
            textNode.parentNode.replaceChild(fragment, textNode);
        });
    }

    function runSearch(rawQuery) {
        var query = normalize(rawQuery.trim());
        var highlighting = query.length >= 2;

        if (highlighting && !searching) {

            searching = true;
            view = { all: true };
            render();
        }

        if (!highlighting && searching) {
            searching = false;
            view = lastRoute.all ? lastRoute : { product: lastRoute.product, pageId: lastRoute.pageId };
            render();
        }

        var shownBlocks = 0;

        index.forEach(function (entry) {
            var hit = !query || entry.text.indexOf(query) !== -1;

            restore(entry);
            if (highlighting && hit) wrapMatches(entry.body, query);

            entry.block.classList.toggle('is-filtered', !hit);
            if (hit) shownBlocks++;
        });

        if (emptyState) {
            emptyState.classList.toggle('is-shown', shownBlocks === 0 && query.length >= 2);
            var label = emptyState.querySelector('[data-empty-query]');
            if (label) label.textContent = rawQuery;
        }

        syncFilters();
    }

    function initSearch() {
        buildIndex();
        if (!searchInput) return;

        var lastLoggedQuery = '';
        function logSearchNow(value) {
            var q = String(value || '').replace(/\s+/g, ' ').trim();
            if (q.length < 2) { lastLoggedQuery = ''; return; }
            if (q === lastLoggedQuery) return;
            lastLoggedQuery = q;
            try {
                window.EmeraldHistory.action('Searched wiki for \u201C' + (q.length > 80 ? q.slice(0, 80) + '\u2026' : q) + '\u201D');
            } catch (_) {}
        }
        var logSearch = debounce(logSearchNow, 900);

        searchInput.addEventListener('input', debounce(function () {
            runSearch(searchInput.value);
            logSearch(searchInput.value);
        }, 140));

        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                searchInput.value = '';
                runSearch('');
                logSearchNow('');
                searchInput.blur();
            } else if (e.key === 'Enter') {
                logSearchNow(searchInput.value);
            }
        });

        searchInput.addEventListener('change', function () {
            logSearchNow(searchInput.value);
        });

        if (searchClear) {
            searchClear.addEventListener('click', function () {
                searchInput.value = '';
                runSearch('');
                logSearchNow('');
                searchInput.focus();
            });
        }
    }

    function headings() {
        return [].slice.call(root.querySelectorAll('.wiki-block-body h3[id]'));
    }

    function headingsInView() {
        return headings().filter(function (h) {
            var block = h.closest('.wiki-block');
            return block && !block.classList.contains('is-page-hidden') &&
                !block.classList.contains('is-filtered');
        });
    }

    function refreshHeading() {

        if (!toc) return;
        if (!toc.querySelector('a.is-current, a[data-outline]')) {
            setCurrentHeading(null);
            return;
        }

        var live = headingsInView();
        if (!live.length) { setCurrentHeading(null); return; }

        var best = null;
        var bestTop = -Infinity;
        live.forEach(function (h) {
            var top = h.getBoundingClientRect().top;
            if (top <= 96 && top > bestTop) { bestTop = top; best = h; }
        });

        setCurrentHeading(best ? best.id : live[0].id);
    }

    function initHeadingSpy() {
        var queued = false;

        function onScroll() {
            if (queued) return;
            queued = true;
            (window.requestAnimationFrame || setTimeout)(function () {
                queued = false;
                refreshHeading();
            }, 16);
        }

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        refreshHeading();
    }

    function initScrollSpy() {
        if (!('IntersectionObserver' in window)) return;

        var visibleTop = {};

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) visibleTop[entry.target.id] = entry.boundingClientRect.top;
                else delete visibleTop[entry.target.id];
            });

            var shownBlocks = blocks.filter(function (b) {
                return !b.classList.contains('is-page-hidden') && !b.classList.contains('is-filtered');
            });
            if (!shownBlocks.length) return;

            var best = null;
            var bestTop = Infinity;
            shownBlocks.forEach(function (block) {
                var top = visibleTop[block.id];
                if (top != null && top < bestTop) { bestTop = top; best = block; }
            });
            if (!best) return;

            syncSidebarFocus(best.id);

            if (searching) return;
            if (view.pageId) return;
            if (shownBlocks.length < 2) return;

            var product = productByKey[view.product];
            var atProductStart = product && !view.pageId && best === product.pages[0];
            var address = atProductStart ? productAddress(product) : addressOf(best);

            if (address === routeInUrl()) return;
            writeUrl(address, false);
        }, { rootMargin: '-64px 0px -60% 0px', threshold: 0 });

        blocks.forEach(function (block) { observer.observe(block); });
    }

    function syncSidebarFocus(pageId) {
        if (!nav) return;
        var address = addressOf(document.getElementById(pageId));
        [].forEach.call(nav.querySelectorAll('.wiki-nav-link--page'), function (link) {
            link.classList.toggle('is-reading', link.getAttribute('data-nav') === address);
        });
        syncPill();
    }

    function addAnchors() {
        blocks.forEach(function (block) {
            var targets = block.querySelectorAll('.wiki-block-head h2, .wiki-block-body h3');
            [].forEach.call(targets, function (heading) {
                if (heading.querySelector('.wiki-anchor')) return;
                var id = heading.id || (block.id + '-' + slug(heading.textContent));
                heading.id = id;

                var a = el('a', 'wiki-anchor', '#');
                a.href = '?section=' + encodeURIComponent(addressOf(block)) + '#' + id;
                a.setAttribute('aria-label', 'Link to this section');
                a.addEventListener('click', function (e) {
                    e.preventDefault();
                    var base = window.location.pathname + '?section=' + encodeURIComponent(addressOf(block));
                    try { window.history.replaceState({ wiki: true }, '', base + '#' + id); } catch (err) {  }
                    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
                heading.appendChild(a);
            });
        });
    }

    function closeNav() {
        if (!root) return;
        root.classList.remove('nav-open');
        if (burger) burger.setAttribute('aria-expanded', 'false');
    }

    function initNavToggle() {
        if (!burger || !nav) return;

        burger.addEventListener('click', function () {
            var open = root.classList.toggle('nav-open');
            burger.setAttribute('aria-expanded', String(open));
        });

        document.addEventListener('click', function (e) {
            if (!root.classList.contains('nav-open')) return;
            if (nav.contains(e.target) || burger.contains(e.target)) return;
            closeNav();
        });
    }

    function initCrossLinks() {
        root.addEventListener('click', function (e) {
            var link = e.target.closest('a[href^="#"]');
            if (!link || link.classList.contains('wiki-anchor')) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;

            var id = link.getAttribute('href').slice(1);
            if (!id) return;
            if (!info[id] && !document.getElementById(id)) return;

            e.preventDefault();
            closeNav();

            if (!info[id]) {

                document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }

            var entry = info[id];
            var target = { product: entry.product, pageId: entry.only ? null : id };
            go(target);

            var heading = link.getAttribute('data-target-heading');
            if (heading) {
                setTimeout(function () {
                    var node = document.getElementById(heading);
                    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 240);
            }
        });
    }

    function initKeys() {
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                if (!searchInput) return;
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
                return;
            }

            if (e.key === 'Escape') {
                if (root.classList.contains('nav-open')) { closeNav(); return; }
                if (searchInput && document.activeElement === searchInput && searchInput.value) {
                    searchInput.value = '';
                    runSearch('');
                }
            }
        });
    }

    function routeFromLocation() {
        var params = new URLSearchParams(window.location.search);
        var section = params.get('section');

        if (section != null) {
            return { resolved: resolve(section), raw: section };
        }

        var hash = window.location.hash.slice(1);
        if (hash) {
            if (info[hash]) return { resolved: resolve(hash), raw: hash };
            var owner = blocks.find(function (b) {
                return b.querySelector('#' + CSS.escape(hash));
            });
            if (owner) return { resolved: resolve(owner.id), raw: owner.id, focus: hash };
        }

        return { resolved: resolve(products.length ? products[0].key : ''), raw: null };
    }

    function initRouting() {
        buildModel();
        addAnchors();
        buildReadingOrder();
        buildSidebar();

        var fromLocation = routeFromLocation();
        var target = fromLocation.resolved;

        if (!target) {
            showNotFound(fromLocation.raw);
            writeUrl('home', true);
            view = resolve('home') || { product: products[0].key, pageId: null };
            render();
            return;
        }

        view = target;
        render();
        syncSidebar();
        writeUrl(currentAddress(), true);

        if (fromLocation.focus) {
            var heading = document.getElementById(fromLocation.focus);
            if (heading) setTimeout(function () { heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120);
        }

        window.addEventListener('popstate', function () {
            var next = routeFromLocation();
            if (!next.resolved) { showNotFound(next.raw); return; }
            if (searching) {
                searching = false;
                if (searchInput) searchInput.value = '';
                runSearch('');
            }
            view = next.resolved;
            render();
            var first = pagesFor(view)[0];
            if (first) window.scrollTo({ top: Math.max(0, first.getBoundingClientRect().top + window.pageYOffset - 74), behavior: 'smooth' });
        });
    }

    function initNotFoundSuggestions() {
        if (!notFound) return;
        var holder = notFound.querySelector('[data-notfound-suggestions]');
        if (!holder) return;
        products.forEach(function (product) {
            var card = el('a', 'wiki-card');
            card.href = '?section=' + product.key;
            applyAccent(card, product.accent);
            card.appendChild(el('h4', null, product.label));
            card.appendChild(el('p', null, product.pages[0] ? product.pages[0].querySelector('.wiki-block-head p').textContent.trim() : ''));
            card.addEventListener('click', function (e) {
                e.preventDefault();
                go({ product: product.key, pageId: null });
            });
            holder.appendChild(card);
        });
    }

    initTheme();
    initRouting();
    initNotFoundSuggestions();

    try { localStorage.removeItem('emeraldcore.wiki.collapsed'); } catch (e) {}

    var navWidth = nav ? nav.clientWidth : 0;
    window.addEventListener('resize', function () {
        if (!nav) return;
        if (nav.clientWidth === navWidth) return;
        navWidth = nav.clientWidth;
        syncPill();
        refreshHeading();
    });

    initCopy();
    initFilters();
    initSearch();
    initHeadingSpy();
    initScrollSpy();
    initCrossLinks();
    initNavToggle();
    initKeys();
}());
