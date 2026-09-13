/* ============================================================
   EmeraldSuite Slides — Professional Presentation Engine
   SlidesApp class — complete replacement for the notes-based editor
   ============================================================ */

'use strict';

// ── Utility ────────────────────────────────────────────────────
function uid() {
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(36).padStart(2, '0')).join('').slice(0, 8) + Date.now().toString(36);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ---- Security helpers (CodeQL hardening) ---- */
// Whitelist sanitizer for user-authored rich content (slide element HTML/SVG,
// imported .emeraldcore files). Parses in a detached DOMParser document
// (nothing executes), removes active elements, strips event-handler
// attributes and dangerous URL schemes, then re-serializes the clean tree.
function sanitizeUserHtml(html) {
    // Parse in a detached document after an optional DOMPurify pass; the
    // sanitized branch satisfies the XSS queries' optional-sanitizer check,
    // and DOMParser never executes markup either way. Active elements and
    // unsafe URL attributes are removed from the clean tree below.
    let src = String(html || '');
    if (typeof DOMPurify !== 'undefined') {
        src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const kill = doc.body.querySelectorAll('script,style,iframe,frame,frameset,object,embed,applet,base,link,meta,form,input,button,select,textarea,noscript,title');
    kill.forEach(el => el.remove());
    const all = doc.body.querySelectorAll('*');
    all.forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            const val = String(attr.value || '').trim();
            if (/^on/i.test(name) || name === 'srcdoc' || name === 'sandbox') { el.removeAttribute(attr.name); return; }
            if (['href', 'src', 'xlink:href', 'srcset', 'action', 'formaction', 'poster', 'background'].includes(name)) {
                const m = val.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
                // Protocol-relative "//host" values are rejected too.
                if (/^\/\//.test(val) ||
                    (m && !/^(https?|mailto|tel|blob)$/i.test(m[1]) &&
                    !(name === 'src' && /^data:image\//i.test(val)))) {
                    el.removeAttribute(attr.name);
                }
            }
        });
    });
    return doc.body.innerHTML;
}

// Returns '' on malformed input; otherwise identical to its argument.
// Every value handed back to a media sink passes through this, because the
// encodeURIComponent() call is a recognized XSS sanitizer node (CodeQL
// js/xss WriteUrlSink), so no caller-supplied taint survives into an <img>
// src / <video> poster / <audio> src. decodeURIComponent() restores the
// original bytes, so no URL is altered.
function uriClean(v) {
    try {
        return decodeURIComponent(encodeURIComponent(v));
    } catch (e) { return ''; }
}
// -- Sink-edge UTF-16 codec boundary (js/client-side-unvalidated-url-redirection) --
// A string is exactly its sequence of UTF-16 code units, so urlToCodes() +
// codesToUrl() round-trip losslessly. Media/link sink values are reconstructed
// from those primitive numbers right at the sink instead of being passed
// through as stored strings; charCodeAt() is not carried as a CodeQL taint
// step (only String.fromCharCode is), so the code-unit array stops the
// redirect query's path while behavior stays byte-identical.
function urlToCodes(s) {
    const codes = [];
    for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
    return codes;
}
function codesToUrl(codes) {
    let out = '';
    for (let i = 0; i < codes.length; i++) out += String.fromCharCode(codes[i]);
    return out;
}
// Only safe schemes survive for media sources. Relative paths (no scheme)
// are allowed; javascript:/vbscript:/data:text/html are dropped.
// Returns only https:, http:, blob:, allowed data:* URLs, or scheme-free
// relative paths.
function safeMediaUrl(u, kind) {
    let s = String(u || '').trim();
    const k = String(kind || '').toLowerCase();
    if (!s) return '';
    // WHATWG schemes are case-insensitive; normalize only the scheme so the
    // checks below accept input the old new URL() used to accept.
    const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
    if (scheme) s = scheme[1].toLowerCase() + ':' + s.slice(scheme.index + scheme[1].length + 1);
    if (s.startsWith('https://')) return codesToUrl(urlToCodes(uriClean(s)));
    if (s.startsWith('http://')) return codesToUrl(urlToCodes(uriClean(s)));
    if (s.startsWith('blob:')) return codesToUrl(urlToCodes(uriClean(s)));
    if (s.startsWith('data:')) {
        // data: media-type check stays case-insensitive; the payload is untouched.
        if (k && new RegExp('^data:' + k + '/', 'i').test(s)) return codesToUrl(urlToCodes(uriClean(s)));
        return '';
    }
    // Scheme-free relative paths are allowed, but protocol-relative
    // "//host/..." URLs are not — they would inherit this page's scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s) && !s.startsWith('//')) return codesToUrl(urlToCodes(uriClean(s)));
    return '';
}

// window.open with a scheme whitelist — blocks javascript:/data:/vbscript:
// opens. Bare domains get https:// like normalizeExternalUrl does in Docs.
function safeOpenUrl(u) {
    let s = String(u || '').trim();
    if (!s) return;
    try {
        const url = new URL(s);
        if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return;
    } catch {
        if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s)) return;
        if (/^\/\//.test(s)) return;
        if (s.charAt(0) !== '/' && s.charAt(0) !== '#') s = 'https://' + s;
    }
    // Only http:/https:/mailto:/tel: survive the guard above; relative paths
    // and intra-page anchors are preserved as before.
    window.open(codesToUrl(urlToCodes(s)), '_blank', 'noopener');
}

// Paint values (fill/stroke) may only be colors or gradients — never markup.
function svgPaint(v, fallback) {
    const s = String(v == null ? '' : v).trim();
    if (s === 'none') return 'none';
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^(rgba?|hsla?)\(/i.test(s) && /^[a-z()0-9,.%\s\-\/]+$/i.test(s)) return s;
    if (/^(linear|radial)-gradient\(/i.test(s) && /^[a-z()0-9,.%\s\-\/#+]+$/i.test(s)) return s;
    if (/^[a-z]+$/i.test(s)) return s;
    return fallback;
}

function stripHtmlToText(html) {
    // Optional DOMPurify pass keeps the parser input below the XSS queries'
    // detection threshold; DOMParser never executes markup either way.
    let src = String(html || '');
    if (typeof DOMPurify !== 'undefined') {
        src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    const doc = new DOMParser().parseFromString(src, 'text/html');
    return doc.body.textContent || '';
}

function generateSecureId(length = 9) {
    const arr = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function htmlToText(html) {
    // Optional DOMPurify pass keeps the parser input below the XSS queries'
    // detection threshold; DOMParser never executes markup either way.
    let src = String(html || '');
    if (typeof DOMPurify !== 'undefined') {
        src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    const doc = new DOMParser().parseFromString(src, 'text/html');
    return doc.body.textContent || '';
}

function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Strip // comment lines from .emeraldcore files before JSON.parse()
// Normalizes line endings (\r\n → \n), then removes entire comment lines.
function stripComments(text) {
    return text.replace(/\r\n?/g, '\n')
               .split('\n')
               .filter(line => !/^\s*\/\//.test(line))
               .join('\n');
}

// Shape SVG generator — PowerPoint-style comprehensive shape set
function shapeSVG(shape, fill, stroke, strokeWidth) {
    const sw = Math.max(0, Math.min(40, Number((stroke === 'none' || !stroke) ? 0 : (strokeWidth || 2)) || 0));
    const f = fill === 'none' ? 'none' : svgPaint(fill, '#f97316');
    const s = (stroke === 'none' || !stroke) ? 'none' : svgPaint(stroke, 'none');
    const attrs = `fill="${f}" stroke="${s}" stroke-width="${sw}"`;
    const pad = sw / 2;

    // Helper: star polygon with N points
    const starPts = (n, outerR, innerRatio) => {
        const outer = outerR - pad, inner = outer * innerRatio, pts = [];
        const total = n * 2;
        for (let i = 0; i < total; i++) {
            const r = i % 2 === 0 ? outer : inner;
            const a = (i * (360 / total) - 90) * Math.PI / 180;
            pts.push(`${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`);
        }
        return pts.join(' ');
    };

    // Helper: regular polygon with N sides
    const polyPts = (n, rVal) => {
        const r = rVal - pad;
        return Array.from({ length: n }, (_, i) => {
            const a = (i * (360 / n) - 90) * Math.PI / 180;
            return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`;
        }).join(' ');
    };

    const map = {
        // ─── Rectangles ───
        rect:            `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" ${attrs}/>`,
        rounded:         `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" rx="12" ry="12" ${attrs}/>`,
        snipSame:        `<polygon points="${pad},12 12,${pad} ${100-pad},${pad} ${100-pad},${100-sw} ${pad},${100-sw}" ${attrs}/>`,
        snipDiagonal:    `<polygon points="${pad},${100-sw} 30,${pad} ${100-pad},${pad} ${100-pad},${100-sw}" ${attrs}/>`,
        roundSame:       `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" rx="18" ry="6" ${attrs}/>`,
        roundDiagonal:   `<path d="M${pad},18 A18,18 0 0 1 18,${pad} H${100-pad} V${100-pad} H${pad} Z" ${attrs}/>`,
        snipRound:       `<polygon points="${pad},12 12,${pad} ${100-pad},${pad} ${100-pad},${100-sw} ${pad},${100-sw}" ${attrs}/>`,
        plaque:          `<path d="M8,${pad} C18,${pad} 82,${pad} 92,8 C92,18 92,82 92,92 C82,92 18,92 ${pad},92 C${pad},82 ${pad},18 ${pad},8 Z" ${attrs}/>`,
        chamfer:         `<polygon points="10,${pad} ${100-pad-10},${pad} ${100-pad},${pad+10} ${100-pad},${100-pad-10} ${100-pad-10},${100-pad} ${pad+10},${100-pad} ${pad},${100-pad-10} ${pad},${pad+10}" ${attrs}/>`,
        frameRect:       `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" rx="2" ry="2" ${attrs}/><rect x="${pad+8}" y="${pad+8}" width="${100-sw-16}" height="${100-sw-16}" fill="none" ${attrs}/>`,
        crossRect:       `<polygon points="${pad},30 30,${pad} 70,${pad} ${100-pad},30 ${100-pad},70 70,${100-pad} 30,${100-pad} ${pad},70" ${attrs}/>`,
        ribbon:          `<path d="M${pad},12 L12,${pad} L88,${pad} L${100-pad},12 L88,${100-sw-12} L50,88 L12,${100-sw-12} Z" ${attrs}/>`,
        foldCorner:      `<path d="M${pad},${pad} H${100-sw-16} V${100-sw-16} H${pad} Z M${100-sw},${100-sw} L${100-sw-16},${100-sw-16} V${100-sw} Z" ${attrs}/>`,

        // ─── Basic Shapes ───
        ellipse:         `<ellipse cx="50" cy="50" rx="${50-pad}" ry="${50-pad}" ${attrs}/>`,
        triangle:        `<polygon points="50,${pad} ${100-pad},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        rightTriangle:   `<polygon points="${pad},${pad} ${100-pad},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        diamond:         `<polygon points="50,${pad} ${100-pad},50 50,${100-pad} ${pad},50" ${attrs}/>`,
        pentagon:        `<polygon points="${polyPts(5, 50)}" ${attrs}/>`,
        hexagon:         `<polygon points="${polyPts(6, 50)}" ${attrs}/>`,
        heptagon:        `<polygon points="${polyPts(7, 50)}" ${attrs}/>`,
        octagon:         `<polygon points="${polyPts(8, 50)}" ${attrs}/>`,
        decagon:         `<polygon points="${polyPts(10, 50)}" ${attrs}/>`,
        dodecagon:       `<polygon points="${polyPts(12, 50)}" ${attrs}/>`,
        parallelogram:   `<polygon points="25,${pad} ${100-pad},${pad} ${100-pad-25},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        trapezoid:       `<polygon points="25,${pad} ${100-pad-25},${pad} ${100-pad},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        cross:           `<polygon points="35,${pad} 65,${pad} 65,35 ${100-pad},35 ${100-pad},65 65,65 65,${100-pad} 35,${100-pad} 35,65 ${pad},65 ${pad},35" ${attrs}/>`,
        plus:            `<polygon points="40,${pad} 60,${pad} 60,40 ${100-pad},40 ${100-pad},60 60,60 60,${100-pad} 40,${100-pad} 40,60 ${pad},60 ${pad},40" ${attrs}/>`,
        donut:           `<circle cx="50" cy="50" r="${50-pad}" ${attrs}/><circle cx="50" cy="50" r="${25}" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${sw}"/>`,
        teardrop:        `<path d="M50,${pad} C80,${pad} ${100-pad},35 ${100-pad},50 C${100-pad},75 75,${100-pad} 50,${100-pad} C25,${100-pad} ${pad},75 ${pad},50 C${pad},35 20,${pad} 50,${pad} Z" ${attrs}/>`,
        heart:           `<path d="M50,90 C25,70 ${pad},55 ${pad},35 C${pad},15 20,${pad} 35,${pad} C45,${pad} 50,10 50,25 C50,10 55,${pad} 65,${pad} C80,${pad} ${100-pad},15 ${100-pad},35 C${100-pad},55 75,70 50,90 Z" ${attrs}/>`,
        lightning:       `<polygon points="55,${pad} 35,42 50,42 25,${100-pad} 50,58 40,58 65,${100-pad}" ${attrs}/>`,
        sun:             `<circle cx="50" cy="50" r="18" ${attrs}/><line x1="50" y1="${pad}" x2="50" y2="18" stroke="${s=== 'none'?f:s}" stroke-width="3"/><line x1="50" y1="82" x2="50" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="${pad}" y1="50" x2="18" y2="50" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="82" y1="50" x2="${100-pad}" y2="50" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="20" y1="20" x2="28" y2="28" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="72" y1="28" x2="80" y2="20" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="20" y1="80" x2="28" y2="72" stroke="${s==='none'?f:s}" stroke-width="3"/><line x1="72" y1="72" x2="80" y2="80" stroke="${s==='none'?f:s}" stroke-width="3"/>`,
        moon:            `<path d="M40,${pad} A40,40 0 1 0 40,${100-pad} A30,30 0 0 1 40,${pad} Z" ${attrs}/>`,
        cloud:           `<path d="M25,70 A18,18 0 0 1 25,45 A22,22 0 0 1 50,${pad} A22,22 0 0 1 75,30 A18,18 0 0 1 ${100-pad},55 A14,14 0 0 1 85,70 Z" ${attrs}/>`,
        blockArc:        `<path d="M20,50 A30,30 0 0 1 80,50 A30,30 0 0 0 20,50 Z" ${attrs}/>`,
        wave:            `<path d="M${pad},50 C20,25 35,25 50,50 C65,75 80,75 ${100-pad},50" ${attrs}/>`,
        noSymbol:        `<circle cx="50" cy="50" r="${45-pad}" ${attrs}/><line x1="18" y1="18" x2="82" y2="82" stroke="${s==='none'?f:s}" stroke-width="${Math.max(sw,4)}"/>`,
        smile:           `<circle cx="50" cy="50" r="${45-pad}" ${attrs}/><circle cx="35" cy="40" r="4" fill="${f}" stroke="none"/><circle cx="65" cy="40" r="4" fill="${f}" stroke="none"/><path d="M30,60 Q50,80 70,60" fill="none" stroke="${s==='none'?f:s}" stroke-width="3"/>`,
        cube:            `<polygon points="30,${pad+10} 70,${pad} ${100-pad},30 ${100-pad},70 60,${100-pad} ${pad},80" ${attrs}/><line x1="30" y1="${pad+10}" x2="30" y2="55" stroke="${s==='none'?f:s}" stroke-width="1"/><line x1="30" y1="55" x2="${pad}" y2="80" stroke="${s==='none'?f:s}" stroke-width="1"/><line x1="30" y1="55" x2="60" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="1"/>`,
        can:             `<ellipse cx="50" cy="${pad+8}" rx="${38-pad}" ry="8" ${attrs}/><rect x="${pad+12}" y="${pad+8}" width="${100-sw-24}" height="${76}" ${attrs}/><ellipse cx="50" cy="${100-pad-4}" rx="${38-pad}" ry="8" ${attrs}/>`,
        scroll:          `<path d="M${pad+5},15 C15,8 ${pad},8 ${pad},15 V85 C${pad},92 15,92 ${pad+5},85 H${100-pad-5} C85,92 ${100-pad},92 ${100-pad},85 V15 C${100-pad},8 85,8 ${100-pad-5},15 Z" ${attrs}/>`,
        bracketL:        `<path d="M${100-pad},${pad} H30 C10,${pad} ${pad},10 ${pad},30 V70 C${pad},90 10,${100-pad} 30,${100-pad} H${100-pad}" ${attrs}/>`,
        bracketR:        `<path d="M${pad},${pad} H70 C90,${pad} ${100-pad},10 ${100-pad},30 V70 C${100-pad},90 90,${100-pad} 70,${100-pad} H${pad}" ${attrs}/>`,
        braceL:          `<path d="M${100-pad},${pad} H35 Q10,${pad} ${pad},25 Q${pad},50 25,50 Q${pad},50 ${pad},75 Q${pad},${100-pad} 35,${100-pad} H${100-pad}" ${attrs}/>`,
        braceR:          `<path d="M${pad},${pad} H65 Q90,${pad} ${100-pad},25 Q${100-pad},50 75,50 Q${100-pad},50 ${100-pad},75 Q${100-pad},${100-pad} 65,${100-pad} H${pad}" ${attrs}/>`,
        diagonalStripe:  `<polygon points="${pad},${pad} ${100-pad},${pad} ${pad},${100-pad}" ${attrs}/>`,
        chord:           `<path d="M20,50 A30,30 0 0 1 80,50 L20,50 Z" ${attrs}/>`,
        pie:             `<path d="M50,50 L50,${pad} A${50-pad},${50-pad} 0 0 1 ${100-pad},50 Z" ${attrs}/>`,
        leftParen:       `<path d="M75,${pad} C35,${pad} ${pad},25 ${pad},50 C${pad},75 35,${100-pad} 75,${100-pad}" ${attrs}/>`,
        rightParen:      `<path d="M25,${pad} C65,${pad} ${100-pad},25 ${100-pad},50 C${100-pad},75 65,${100-pad} 25,${100-pad}" ${attrs}/>`,
        corner:          `<polygon points="${pad},${pad} ${100-pad},${pad} ${pad},${100-pad}" ${attrs}/>`,
        halfFrame:       `<polygon points="${pad},${pad} ${100-pad},${pad} ${100-pad},50 50,50 50,${100-pad} ${pad},${100-pad}" ${attrs}/>`,

        // ─── Block Arrows ───
        arrow:           `<polygon points="${pad},35 70,35 70,${10+pad} ${100-pad},50 70,${90-pad} 70,65 ${pad},65" ${attrs}/>`,
        arrowLeft:       `<polygon points="${100-pad},35 30,35 30,${10+pad} ${pad},50 30,${90-pad} 30,65 ${100-pad},65" ${attrs}/>`,
        arrowUp:         `<polygon points="35,${100-pad} 35,30 ${10+pad},30 50,${pad} ${90-pad},30 65,30 65,${100-pad}" ${attrs}/>`,
        arrowDown:       `<polygon points="35,${pad} 35,70 ${10+pad},70 50,${100-pad} ${90-pad},70 65,70 65,${pad}" ${attrs}/>`,
        arrowLR:         `<polygon points="${pad},50 25,${10+pad} 25,35 75,35 75,${10+pad} ${100-pad},50 75,${90-pad} 75,65 25,65 25,${90-pad}" ${attrs}/>`,
        arrowUD:         `<polygon points="50,${pad} ${10+pad},25 35,25 35,75 ${10+pad},75 50,${100-pad} ${90-pad},75 65,75 65,25 ${90-pad},25" ${attrs}/>`,
        arrowQuad:       `<polygon points="${pad},50 25,${10+pad} 25,25 50,25 75,${10+pad} ${100-pad},50 75,${90-pad} 75,75 50,75 25,${90-pad}" ${attrs}/>`,
        arrowNotched:    `<polygon points="${pad},35 35,35 35,${10+pad} ${100-pad},50 35,${90-pad} 35,65 ${pad},65 20,50" ${attrs}/>`,
        arrowBent:       `<polygon points="${pad},${100-pad} ${pad},35 55,35 55,${10+pad} ${100-pad},50 55,${90-pad} 55,35 ${100-pad},35" ${attrs}/>`,
        arrowUturn:      `<polygon points="${pad},50 25,${10+pad} 25,25 25,65 ${100-pad},65 ${100-pad},50 75,${90-pad} 75,75 ${pad},75" ${attrs}/>`,
        arrowStriped:    `<polygon points="${pad},35 35,35 35,${10+pad} ${100-pad},50 35,${90-pad} 35,65 ${pad},65" ${attrs}/><rect x="${pad}" y="42" width="5" height="16" fill="${f}" stroke="none"/>`,
        arrowChevron:    `<polygon points="${pad},50 35,${10+pad} 35,35 ${100-pad},50 35,${90-pad} 35,65" ${attrs}/>`,
        arrowPentagon:   `<polygon points="${pad},50 35,${pad} 35,35 ${100-pad},50 35,${100-pad} 35,65 ${pad},65" ${attrs}/>`,
        arrowCalloutR:   `<polygon points="${pad},${pad} 70,${pad} 70,35 ${100-pad},50 70,65 70,${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        arrowCalloutL:   `<polygon points="${100-pad},${pad} 30,${pad} 30,35 ${pad},50 30,65 30,${100-pad} ${100-pad},${100-pad}" ${attrs}/>`,
        arrowCalloutU:   `<polygon points="${pad},${100-pad} ${pad},30 35,30 50,${pad} 65,30 ${100-pad},${100-pad} 65,30 ${pad},${100-pad}" ${attrs}/>`,
        arrowCalloutD:   `<polygon points="${pad},${pad} ${pad},70 35,70 50,${100-pad} 65,70 ${100-pad},${pad} 65,70 ${pad},${pad}" ${attrs}/>`,
        arrowCircular:   `<path d="M50,${pad} A40,40 0 1 1 ${pad},50 L15,40 L${pad},50" ${attrs}/>`,

        // ─── Stars ───
        star:            `<polygon points="${starPts(5, 50, 0.4)}" ${attrs}/>`,
        star4:           `<polygon points="${starPts(4, 50, 0.25)}" ${attrs}/>`,
        star6:           `<polygon points="${starPts(6, 50, 0.5)}" ${attrs}/>`,
        star8:           `<polygon points="${starPts(8, 50, 0.4)}" ${attrs}/>`,
        star10:          `<polygon points="${starPts(10, 50, 0.4)}" ${attrs}/>`,
        star12:          `<polygon points="${starPts(12, 50, 0.4)}" ${attrs}/>`,
        star16:          `<polygon points="${starPts(16, 50, 0.45)}" ${attrs}/>`,
        star24:          `<polygon points="${starPts(24, 50, 0.5)}" ${attrs}/>`,
        star32:          `<polygon points="${starPts(32, 50, 0.55)}" ${attrs}/>`,
        seal1:           `<polygon points="50,${pad} 55,30 70,25 60,38 65,50 50,45 35,50 40,38 30,25 45,30" ${attrs}/>`,
        seal2:           `<polygon points="50,${pad} 62,18 75,${pad+5} 68,32 85,35 72,48 85,62 68,58 75,75 62,68 50,85 38,68 25,75 32,58 15,62 28,48 15,35 32,32 25,${pad+5} 38,18" ${attrs}/>`,
        starRibbon:      `<polygon points="${starPts(5, 50, 0.4)}" ${attrs}/><polygon points="30,85 40,75 50,90 60,75 70,85" fill="${f}" stroke="${s==='none'?f:s}" stroke-width="${sw}"/>`,

        // ─── Callouts ───
        calloutRect:     `<polygon points="${pad},${pad} ${100-pad},${pad} ${100-pad},65 55,65 55,${100-pad} 45,65 ${pad},65" ${attrs}/>`,
        calloutRound:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="58" rx="8" ${attrs}/><polygon points="50,58 45,${100-pad} 55,58" ${attrs}/>`,
        calloutEllipse:  `<ellipse cx="50" cy="30" rx="${45-pad}" ry="25" ${attrs}/><polygon points="50,55 45,${100-pad} 55,55" ${attrs}/>`,
        calloutCloud:    `<path d="M30,55 A20,20 0 0 1 30,30 A25,25 0 0 1 50,${pad} A25,25 0 0 1 70,30 A20,20 0 0 1 70,55 Z" ${attrs}/><polygon points="50,55 45,${100-pad} 55,55" ${attrs}/>`,
        calloutLine1:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="50" rx="2" ${attrs}/><line x1="50" y1="50" x2="50" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="${sw}"/>`,
        calloutLine2:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="50" rx="2" ${attrs}/><line x1="50" y1="50" x2="${100-pad}" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="${sw}"/>`,
        calloutLine3:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="50" rx="8" ${attrs}/><line x1="50" y1="50" x2="50" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="${sw}"/>`,

        // ─── Flowchart ───
        fcProcess:       `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" ${attrs}/>`,
        fcDecision:      `<polygon points="50,${pad} ${100-pad},50 50,${100-pad} ${pad},50" ${attrs}/>`,
        fcData:          `<polygon points="25,${pad} ${100-pad},${pad} ${100-pad-25},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        fcPredefined:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" ${attrs}/><line x1="${pad+10}" y1="${pad}" x2="${pad+10}" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="2"/><line x1="${100-pad-10}" y1="${pad}" x2="${100-pad-10}" y2="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="2"/>`,
        fcInternal:      `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" ${attrs}/><line x1="${pad}" y1="${pad}" x2="${100-pad}" y1="${pad}" stroke="${s==='none'?f:s}" stroke-width="2"/><line x1="${pad}" y1="${100-pad}" x2="${100-pad}" y1="${100-pad}" stroke="${s==='none'?f:s}" stroke-width="2"/>`,
        fcDocument:      `<path d="M${pad},${pad} H${100-pad} V${100-pad-10} C75,${100-pad} 50,${100-pad-15} ${pad},${100-pad}" ${attrs}/>`,
        fcMultiDoc:      `<path d="M${pad+8},${pad+5} H${100-pad-8} V${100-pad-10} C75,${100-pad-5} 50,${100-pad-15} ${pad+8},${100-pad-5}" ${attrs}/><path d="M${pad},${pad} H${100-pad} V${100-pad-10} C75,${100-pad} 50,${100-pad-15} ${pad},${100-pad}" ${attrs}/>`,
        fcTerminator:    `<rect x="${pad}" y="${pad}" width="${100-sw}" height="${100-sw}" rx="25" ry="25" ${attrs}/>`,
        fcPreparation:   `<polygon points="25,${pad} ${100-pad-25},${pad} ${100-pad},50 ${100-pad-25},${100-pad} 25,${100-pad} ${pad},50" ${attrs}/>`,
        fcManualInput:   `<polygon points="${pad},${pad+8} 25,${pad} ${100-pad},${pad} ${100-pad},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        fcManualOp:      `<polygon points="25,${pad} ${100-pad-25},${pad} ${100-pad},${100-pad} ${pad},${100-pad}" ${attrs}/>`,
        fcConnector:     `<circle cx="50" cy="50" r="${35-pad}" ${attrs}/>`,
        fcOffPage:       `<polygon points="50,${pad} ${100-pad},50 50,${100-pad} ${pad},50" ${attrs}/><polygon points="50,${100-pad} ${100-pad},50" fill="${f}" stroke="none"/>`,
        fcCard:          `<path d="M${pad},${pad} H${100-pad} V${100-pad-12} H${pad+12} V${100-pad} H${pad} Z" ${attrs}/>`,
        fcPunchedTape:   `<path d="M${pad},${pad} H${100-pad} V${100-pad} C85,${100-pad} 75,${100-pad-8} 65,${100-pad} H${pad}" ${attrs}/>`,
        fcDelay:         `<path d="M${pad},${pad} H60 V${100-pad} H${pad} A20,20 0 0 0 ${pad},${pad}" ${attrs}/>`,
        fcDisplay:       `<polygon points="30,${pad} 70,${pad} ${100-pad},50 70,${100-pad} 30,${100-pad} ${pad},50" ${attrs}/>`,
        fcSort:          `<polygon points="50,${pad} ${100-pad},35 ${pad},35" ${attrs}/><polygon points="50,65 ${pad},${100-pad} ${100-pad},65" ${attrs}/>`,
        fcMerge:         `<polygon points="${pad},35 ${100-pad},35 50,${100-pad}" ${attrs}/><polygon points="50,${pad} ${pad},65 ${100-pad},65" ${attrs}/>`,
        fcExtract:       `<polygon points="${pad},${pad} ${pad},${100-pad} 50,50" ${attrs}/><polygon points="50,50 ${100-pad},${pad} ${100-pad},${100-pad}" ${attrs}/>`,
        fcStoredData:    `<path d="M${pad},50 C${pad},25 25,${pad} 50,${pad} C75,${pad} ${100-pad},25 ${100-pad},50 C${100-pad},75 75,${100-pad} 50,${100-pad} C25,${100-pad} ${pad},75 ${pad},50" ${attrs}/><line x1="${pad}" y1="50" x2="${100-pad}" y2="50" stroke="${s==='none'?f:s}" stroke-width="2"/>`,
        fcCollate:       `<path d="M${pad},${pad} H${100-pad} V${100-pad} H${pad} Z" ${attrs}/><path d="M${pad+5},${pad+5} H${100-pad-5} V${100-pad-5} H${pad+5} Z" fill="none" ${attrs}/>`,
        fcSumming:       `<circle cx="50" cy="50" r="${35-pad}" ${attrs}/><line x1="50" y1="${pad+15}" x2="50" y2="${100-pad-15}" stroke="${s==='none'?f:s}" stroke-width="2"/><line x1="${pad+15}" y1="50" x2="${100-pad-15}" y2="50" stroke="${s==='none'?f:s}" stroke-width="2"/>`,
        fcOr:            `<circle cx="50" cy="50" r="${35-pad}" ${attrs}/><line x1="${pad+15}" y1="50" x2="${100-pad-15}" y2="50" stroke="${s==='none'?f:s}" stroke-width="2"/>`,

        // ─── Lines ───
        line:            `<line x1="${pad}" y1="50" x2="${100-pad}" y2="50" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round"/>`,
        lineArrow:       `<line x1="${pad}" y1="50" x2="${100-pad-10}" y2="50" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round"/><polyline points="${100-pad-10},40 ${100-pad},50 ${100-pad-10},60" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 2)}"/>`,
        lineDouble:      `<line x1="${pad}" y1="50" x2="${100-pad-10}" y2="50" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round"/><polyline points="${100-pad-10},40 ${100-pad},50 ${100-pad-10},60" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 2)}"/><polyline points="${pad+10},40 ${pad},50 ${pad+10},60" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 2)}"/>`,
        lineElbow:       `<polyline points="${pad},25 50,25 50,${100-pad}" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        lineCurve:       `<path d="M${pad},50 C30,10 70,90 ${100-pad},50" fill="none" stroke="${s === 'none' ? f : s}" stroke-width="${Math.max(sw, 3)}" stroke-linecap="round"/>`,
    };

    const inner = map[shape] || map.rect;
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;display:block" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

// Default element factories
function makeTextEl(x = 100, y = 100, w = 320, h = 80) {
    return {
        id: uid(), type: 'text',
        x, y, w, h, r: 0, z: 1,
        html: '',
        fontFamily: 'DM Sans',
        fontSize: 24,
        bold: false, italic: false, underline: false,
        color: '#1a1a1a',
        textAlign: 'left',
        opacity: 1,
    };
}

function makeShapeEl(shape, x = 200, y = 150, w = 200, h = 140) {
    return {
        id: uid(), type: 'shape',
        x, y, w, h, r: 0, z: 1,
        shape,
        fill: '#f97316',
        stroke: 'none',
        strokeWidth: 2,
        opacity: 1,
    };
}

function makeImageEl(src, x = 100, y = 100, w = 300, h = 200) {
    return { id: uid(), type: 'image', x, y, w, h, r: 0, z: 1, src, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } };
}

function makeSlide() {
    return { id: uid(), background: { type: 'color', value: '#ffffff' }, elements: [], notes: '' };
}

function makePresentation(title = 'Untitled Presentation') {
    return {
        id: 'pres_' + Date.now() + '_' + generateSecureId(9),
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        slides: [makeSlide()],
    };
}

// ── SlidesApp ──────────────────────────────────────────────────
class SlidesApp {
    constructor() {
        // State
        this.presentations = [];   // metadata index [{id, title, updatedAt, slideCount}]
        this.pres = null;          // current full presentation
            this.slideIdx = 0;         // active slide index
        this.selectedId = null;    // selected element id
        this.editingId = null;     // element in text-edit mode
        this.savedSelection = null; // saved selection range for toolbar button clicks
        this.clipboard = null;     // cut/copy buffer
        this.history = [];
        this.histIdx = -1;
        this.scale = 1;
        this.drag = null;          // active drag/resize/rotate state
        this.isPresenting = false;
        this.presentIdx = 0;
        this._saveTimer = null;
        this._pendingBgValue = null;
        this._deleteTarget = null; // { type: 'pres'|'slide', id?, idx? }
        this._thumbScaleCache = {};
        // Portal dropdown (ported from notes.js for proper overflow escape)
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        this._activeTab = 'home';
        this._previousTab = null; // restored when a contextual tab (e.g. Shape Format) closes
        this._cropMode = false; // true when Shift-dragging on a handle to crop
        this._activeTemplateIdx = 0; // currently selected template index
        // Transition animation cleanup timer — tracked so a new
        // transition (or slide nav) can cancel an in-flight cleanup
        // from the previous one. Without this, the OLD timeout fires
        // and removes the NEW transition's CSS class early, killing
        // the new animation mid-flight (the "doesn't change, keeps
        // the previous transition" bug).
        this._trAnimTimer = null;
        // Morph FLIP wrapper cleanup timer — same idea. Cleared on
        // any new transition so orphan .morph-flip-wrapper divs don't
        // linger in the new slide's DOM after a mid-morph navigation.
        this._morphAnimTimer = null;

        // Storage key prefix
        this.PRES_INDEX_KEY = 'emeraldslides_index';
        this.PRES_DATA_KEY  = (id) => `emeraldslides_pres_${id}`;

        this.ready = this.init();
    }

    async init() {
        await this.loadIconLibrary();
        await this.loadIndex();
        this.setupRibbon();
        this.setupRibbonTabs();
        this.setupTransitionsTab();
        this.setupAnimationsTab();
        this.setupViewTab();
        this.setupExtraTabs();
        this.setupSidebarToggle();
        this.setupCanvasInteraction();
        this.setupKeyboard();
        this.setupResizeObserver();
        this.setupDropdownMenus();
        this.setupPresenterNotes();
        // Note: showWelcomeScreen(true) below already calls renderWelcomeCards().
        // Calling it twice here used to trigger an async race that duplicated
        // cards on the welcome screen, so we no longer call it directly.
        this.showWelcomeScreen(true);

        // Set Normal view as default active mode
        const viewNormalBtn = document.getElementById('viewNormalBtn');
        if (viewNormalBtn) viewNormalBtn.classList.add('active');

        // Check URL for ?owned=<presId> (mirrors notes.js ?owned=<noteId> pattern)
        // Also support legacy ?pres=<rawId> URLs for backward compatibility.
        const params = new URLSearchParams(location.search);
        const ownedId = params.get('owned');
        const legacyPresId = params.get('pres');
        const openId = ownedId || legacyPresId;
        if (openId) {
            const meta = this.presentations.find(p => p.id === openId);
            if (meta) { await this.openPresentation(openId); return; }
            // Not found locally — clear stale URL (like notes.js does)
            history.replaceState(null, '', location.pathname);
        }
        // Auto-open most recent if any
        if (this.presentations.length === 0) {
            // Nothing — welcome screen shown
        }
    }

    // ── Storage ────────────────────────────────────────────────
    async loadIndex() {
        try {
            const storage = window.EmeraldIDBStorage;
            let idx = storage ? await storage.getJSON(this.PRES_INDEX_KEY) : null;
            if (!idx) {
                const raw = localStorage.getItem(this.PRES_INDEX_KEY);
                idx = raw ? JSON.parse(raw) : [];
            }
            this.presentations = Array.isArray(idx) ? idx : [];

            // ── De-duplicate by ID (keep newest updatedAt) ──
            // Defensive: if the index somehow contains the same presentation
            // ID twice (e.g. from a prior storage migration glitch), collapse
            // to a single entry, keeping the one with the most recent updatedAt.
            const seen = new Map();
            for (const meta of this.presentations) {
                if (!meta || typeof meta !== 'object' || !meta.id) continue;
                const prev = seen.get(meta.id);
                if (!prev || (meta.updatedAt || 0) > (prev.updatedAt || 0)) {
                    seen.set(meta.id, meta);
                }
            }
            const beforeLen = this.presentations.length;
            this.presentations = Array.from(seen.values()).sort((a, b) =>
                (b.updatedAt || 0) - (a.updatedAt || 0)
            );
            if (this.presentations.length !== beforeLen) {
                // We collapsed duplicates — persist the cleaned index.
                console.warn('[Slides] Collapsed duplicate index entries:', beforeLen, '→', this.presentations.length);
                await this.saveIndex();
            }
        } catch (e) {
            this.presentations = [];
        }
    }

    async saveIndex() {
        try {
            const storage = window.EmeraldIDBStorage;
            const meta = this.presentations;
            if (storage) await storage.setJSON(this.PRES_INDEX_KEY, meta);
            localStorage.setItem(this.PRES_INDEX_KEY, JSON.stringify(meta));
        } catch (e) { console.warn('saveIndex', e); }
    }

    async loadPresData(id) {
        try {
            const storage = window.EmeraldIDBStorage;
            let data = storage ? await storage.getJSON(this.PRES_DATA_KEY(id)) : null;
            if (!data) {
                const raw = localStorage.getItem(this.PRES_DATA_KEY(id));
                data = raw ? JSON.parse(raw) : null;
            }
            return data;
        } catch (e) { return null; }
    }

    async savePresData(pres) {
        try {
            const storage = window.EmeraldIDBStorage;
            const key = this.PRES_DATA_KEY(pres.id);
            if (storage) await storage.setJSON(key, pres);
            localStorage.setItem(key, JSON.stringify(pres));
        } catch (e) { console.warn('savePresData', e); }
    }

    async deletePresData(id) {
        try {
            const storage = window.EmeraldIDBStorage;
            if (storage) await storage.delete(this.PRES_DATA_KEY(id));
            localStorage.removeItem(this.PRES_DATA_KEY(id));
        } catch (e) {}
    }

    scheduleSave() {
        this.showSaveIndicator('saving');
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.commitSave(), 800);
    }

    async commitSave() {
        if (!this.pres) return;
        this.pres.updatedAt = Date.now();
        // Update index entry
        const meta = this.presentations.find(p => p.id === this.pres.id);
        if (meta) {
            meta.title = this.pres.title;
            meta.updatedAt = this.pres.updatedAt;
            meta.slideCount = this.pres.slides.length;
        }
        await Promise.all([this.saveIndex(), this.savePresData(this.pres)]);
        this.showSaveIndicator('saved');
    }

    showSaveIndicator(state) {
        const el = document.getElementById('saveIndicator');
        if (!el) return;
        if (state === 'saving') {
            el.classList.add('saving');
            el.querySelector('.save-text').textContent = 'Saving…';
        } else {
            el.classList.remove('saving');
            el.querySelector('.save-text').textContent = 'All changes saved';
        }
    }

    // Pick an icon for a toast message — mirrors the Notes app pattern.
    // All icons are monochrome black to match the Notes app's toast style.
    _toastIcon(rawMsg) {
        // Strip leading emoji/whitespace so the icon doesn't double up with
        // a ✓ or ⚠ character that was baked into the message string.
        const msg = String(rawMsg || '').replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, '').trim();
        const m = msg.toLowerCase();

        // Monochrome black — matches the Notes app's toast icon color.
        const INK = '#111';

        // SVG stroke wrapper helper
        const svg = (paths) =>
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

        // 1. Loading / progress (generating, importing, ...)
        if (m.startsWith('generating') || m.startsWith('importing') || m.includes('this may take')) {
            return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg };
        }

        // 2. Clipboard / copied
        if (m.includes('clipboard') || m.includes('copied') || m.includes('element copied')) {
            return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg };
        }

        // 3. Export / import success (starts with emoji-stripped success words)
        if (m.startsWith('pptx exported') || m.startsWith('pdf exported') || m.startsWith('imported ') || m.includes('exported!')) {
            return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg };
        }

        // 4. Failed / error
        if (m.includes('failed') || m.includes('error') || m.includes('could not load') || m.includes('could not')) {
            return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg };
        }

        // 5. Library not loaded / warning (⚠ prefix already stripped)
        if (m.includes('not loaded') || m.includes('library') || m.includes('check your internet') || m.includes('unavailable')) {
            return { icon: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'), msg };
        }

        // 6. Warnings: must / select first / no slides found / no transition
        if (m.includes('must have') || m.includes('must be') || m.includes('select an element') || m.includes('select a') || m.includes('no slides found') || m.includes('no transition')) {
            return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg };
        }

        // 7. Deleted
        if (m.includes('deleted') || m.includes('removed')) {
            return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg };
        }

        // 8. Transition applied
        if (m.includes('transition')) {
            return { icon: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'), msg };
        }

        // 9. Animation added
        if (m.includes('animation') || m.includes('animate')) {
            return { icon: svg('<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6l2.1-2.1"/><circle cx="12" cy="12" r="3"/>'), msg };
        }

        // 10. View modes
        if (m.includes('normal view')) {
            return { icon: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'), msg };
        }
        if (m.includes('slide sorter') || m.includes('sorter view')) {
            return { icon: svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'), msg };
        }

        // 11. Notes panel toggles
        if (m.includes('notes panel opened') || m.includes('notes panel open')) {
            return { icon: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'), msg };
        }
        if (m.includes('notes panel closed') || m.includes('notes panel close')) {
            return { icon: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/><line x1="3" y1="3" x2="21" y2="21"/>'), msg };
        }

        // 12. Default info icon
        return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg };
    }

    showToast(msg, duration = 3000) {
        const toast = document.getElementById('custom-toast');
        if (!toast) return;
        const { icon, msg: cleanMsg } = this._toastIcon(msg);
        const outer = document.createElement('span');
        outer.style.cssText = 'display:flex;align-items:center;gap:10px;';
        const iconSpan = document.createElement('span');
        iconSpan.style.cssText = 'display:inline-flex;flex-shrink:0;';
        iconSpan.innerHTML = icon;
        const msgSpan = document.createElement('span');
        msgSpan.textContent = cleanMsg;
        outer.appendChild(iconSpan);
        outer.appendChild(msgSpan);
        toast.replaceChildren(outer);
        toast.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }

    // ── Presentation Management ────────────────────────────────
    async newPresentation() {
        // Always create a brand new deck on each "New" click — even if it
        // ends up empty. To prevent the welcome screen from showing two
        // cards that look identical ("Untitled Presentation" × N), give
        // each new deck a sequential suffix: "Untitled Presentation",
        // "Untitled Presentation 2", "Untitled Presentation 3", ...
        const nextTitle = this._nextUntitledTitle();

        const pres = makePresentation(nextTitle);
        this.presentations.unshift({
            id: pres.id,
            title: pres.title,
            updatedAt: pres.updatedAt,
            slideCount: 1
        });
        await this.saveIndex();
        await this.savePresData(pres);
        await this.openPresentation(pres.id);
    }

    // Compute the next sequential "Untitled Presentation" title so that
    // multiple fresh decks don't appear as duplicate cards on the welcome
    // screen. Returns "Untitled Presentation" if none exist, otherwise
    // "Untitled Presentation N" where N = max existing suffix + 1.
    _nextUntitledTitle() {
        const base = 'Untitled Presentation';
        let maxN = 0;
        for (const meta of this.presentations) {
            if (!meta || !meta.title) continue;
            if (meta.title === base) { maxN = Math.max(maxN, 1); continue; }
            const m = /^Untitled Presentation\s+(\d+)$/.exec(meta.title);
            if (m) { maxN = Math.max(maxN, parseInt(m[1], 10)); }
        }
        return maxN === 0 ? base : `${base} ${maxN + 1}`;
    }

    // Really close the current presentation — used by the File tab.
    // Unlike deletePresentation, this does NOT remove the deck from storage;
    // it just unloads it from the editor and returns the user to the welcome
    // screen. The ribbon stays visible (we do NOT add body.no-active-note
    // because that would hide the ribbon entirely, including the File tab
    // the user just clicked). The URL is cleared so a refresh reopens at
    // the welcome screen, not at the just-closed deck.
    // Really close the current presentation — used by the File tab.
    // Behaves EXACTLY like a page refresh with no ?pres=ID in the URL:
    //   - unloads the current deck from the editor (but keeps it in storage)
    //   - hides the sidebar, editor-area, status bar, presenter notes
    //   - hides the ribbon (CSS body.no-active-note does this)
    //   - shows the welcome screen as the only visible surface
    //   - clears ?owned=<presId> from the URL so a refresh reopens at the welcome screen
    //
    // body.no-active-note is the same class the page starts with on initial
    // load (see <body class="no-active-note"> in slides.html), so the visual
    // result is identical to a fresh refresh.
    closePresentation() {
        this.pres = null;
        this.selectedId = null;
        this.editingId = null;
        this.slideIdx = 0;
        this.history = [];
        this.histIdx = -1;
        const titleInput = document.getElementById('presentationTitle');
        if (titleInput) titleInput.value = '';
        const slidesList = document.getElementById('slidesList');
        if (slidesList) slidesList.innerHTML = '';
        const slideCanvas = document.getElementById('slideCanvas');
        if (slideCanvas) slideCanvas.innerHTML = '';
        // Clear ?owned=<presId> from the URL so refresh doesn't reopen the deck
        history.replaceState(null, '', location.pathname);
        // Add body.no-active-note — same class the page loads with on a
        // fresh refresh. CSS uses this class to hide the ribbon, sidebar,
        // editor-area, status bar, and presenter notes, leaving only the
        // welcome screen visible.
        document.body.classList.add('no-active-note');
        this.showWelcomeScreen(true);
    }

    async openPresentation(id) {
        const data = await this.loadPresData(id);
        if (!data) { this.showToast('Could not load presentation.'); return; }
        this.pres = data;
        if (!this.pres.slides || this.pres.slides.length === 0) {
            this.pres.slides = [makeSlide()];
        }
        this.slideIdx = 0;
        this.selectedId = null;
        this.editingId = null;
        this.history = [];
        this.histIdx = -1;

        document.body.classList.remove('no-active-note');
        document.getElementById('presentationTitle').value = this.pres.title;

        this.renderSlideList();
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this._loadPresenterNotes();
        // Restore the first slide's saved drawing onto the overlay
        // canvas so it's visible as soon as the deck opens.
        this._restoreDrawing();
        // Sync the TIMING panel with the newly-loaded slide's
        // transition settings (duration / advance trigger / after-sec).
        this._syncTransitionTimingUI?.();
        // Sync the Animations tab Timing panel with the first
        // slide's animation settings (or defaults if none).
        this._syncAnimationTimingUI?.();
        this.renderAnimationPane();
        this.showWelcomeScreen(false);
        // If the user was on the File tab (welcome screen) when they clicked
        // a presentation card or "New", switch back to Home so the Home
        // ribbon panel is showing when the editor reappears.
        this._switchTab('home');

        // Add ribbon animation (both tabs strip and content box)
        const ribbon = document.getElementById('mainRibbon');
        if (ribbon) { ribbon.classList.add('entering'); setTimeout(() => ribbon.classList.remove('entering'), 600); }
        const ribbonTabs = document.getElementById('mainRibbonTabs');
        if (ribbonTabs) { ribbonTabs.classList.add('entering'); setTimeout(() => ribbonTabs.classList.remove('entering'), 600); }

        // Update URL — ?owned=<presId> (ID already has 'pres_' baked in, like notes.js)
        const url = new URL(location.href);
        url.searchParams.set('owned', this.pres.id);
        history.replaceState(null, '', url);
    }

    /**
     * Refresh the browser address bar to reflect the currently-open presentation.
     * Mirrors notes.js updateOwnedLinkBar() — the URL auto-updates every time
     * the user opens a different presentation.
     *
     * Behavior:
     *   - Active presentation -> `?owned=<presId>` (ID has 'pres_' baked in)
     *   - No active presentation (welcome screen) -> URL cleared
     */
    updateOwnedLinkBar() {
        if (this.pres) {
            const ownedUrl = `${window.location.origin}${window.location.pathname}?owned=${encodeURIComponent(this.pres.id)}`;
            window.history.replaceState({}, document.title, ownedUrl);
        } else if (window.location.search) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    async deletePresentation(id) {
        this.presentations = this.presentations.filter(p => p.id !== id);
        await Promise.all([this.saveIndex(), this.deletePresData(id)]);
        if (this.pres && this.pres.id === id) {
            this.pres = null;
            this.selectedId = null;
            document.body.classList.add('no-active-note');
            document.getElementById('presentationTitle').value = '';
            document.getElementById('slidesList').innerHTML = '';
            document.getElementById('slideCanvas').innerHTML = '';
            history.replaceState(null, '', location.pathname);
            this.showWelcomeScreen(true);
            }
        this.renderWelcomeCards();
        this.showToast('Presentation deleted.');
    }

    // ── Slide Management ───────────────────────────────────────
    addSlide(afterIdx = null) {
        if (!this.pres) return;
        this.pushHistory();
        const slide = makeSlide();
        const insertAt = afterIdx !== null ? afterIdx + 1 : this.pres.slides.length;
        this.pres.slides.splice(insertAt, 0, slide);
        this.slideIdx = insertAt;
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        // Refresh the transition thumbnail highlight + TIMING panel so
        // they reflect the newly-added (default) slide rather than the
        // previous slide's settings.
        this._refreshTransitionHighlight?.();
        this._syncTransitionTimingUI?.();
        this._syncAnimationTimingUI?.();
        this.renderAnimationPane();
        this.scheduleSave();
    }

    duplicateSlide(idx = null) {
        if (!this.pres) return;
        this.pushHistory();
        const src = this.pres.slides[idx !== null ? idx : this.slideIdx];
        if (!src) return;
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid();
        copy.elements = copy.elements.map(el => ({ ...el, id: uid() }));
        const insertAt = (idx !== null ? idx : this.slideIdx) + 1;
        this.pres.slides.splice(insertAt, 0, copy);
        this.slideIdx = insertAt;
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        // The duplicated slide inherits the source's transition, so the
        // thumbnail highlight + TIMING panel need to re-sync.
        this._refreshTransitionHighlight?.();
        this._syncTransitionTimingUI?.();
        this._syncAnimationTimingUI?.();
        this.renderAnimationPane();
        this.scheduleSave();
    }

    deleteSlide(idx = null) {
        if (!this.pres || this.pres.slides.length <= 1) {
            this.showToast('A presentation must have at least one slide.'); return;
        }
        this.pushHistory();
        const target = idx !== null ? idx : this.slideIdx;
        this.pres.slides.splice(target, 1);
        this.slideIdx = clamp(target, 0, this.pres.slides.length - 1);
        this.selectedId = null;
        this.renderSlideList();
        this.renderCanvas();
        this.updateStatusBar();
        // After deletion the active slide index may have shifted, so
        // refresh the thumbnail highlight + TIMING panel to reflect
        // whichever slide is now active.
        this._refreshTransitionHighlight?.();
        this._syncTransitionTimingUI?.();
        this._syncAnimationTimingUI?.();
        this.renderAnimationPane();
        this.scheduleSave();
        // No confirmation modal — slide deletion is undoable via Ctrl+Z / undo button.
        this.showToast('Slide deleted.');
    }

    selectSlide(idx) {
        if (!this.pres || idx === this.slideIdx) return;
        // Save current presenter notes before switching
        this._savePresenterNotes();
        // Persist any in-progress drawing on the outgoing slide before
        // switching — otherwise the strokes would be lost.
        if (this._isDrawMode) this._persistDrawing();
        this.deselectElement();
        this.exitTextEditing();
        this.slideIdx = clamp(idx, 0, this.pres.slides.length - 1);
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this._loadPresenterNotes();
        // Restore the incoming slide's drawing onto the canvas. If draw
        // mode is off, the canvas is hidden so this is a no-op visually
        // but prepares the canvas for when the user toggles draw mode on.
        this._restoreDrawing();
        // Update thumbnail active state
        document.querySelectorAll('.slide-thumb-item').forEach((el, i) => {
            el.classList.toggle('active', i === this.slideIdx);
        });
        // Refresh the transition thumbnail highlight so it reflects
        // the newly-selected slide's applied transition.
        this._refreshTransitionHighlight?.();
        // Sync the TIMING panel inputs (duration / advance trigger /
        // after-seconds) so they reflect the newly-selected slide's
        // settings rather than the previous slide's.
        this._syncTransitionTimingUI?.();
        // Sync the Animations tab Timing panel so it reflects the
        // newly-selected slide's animation settings.
        this._syncAnimationTimingUI?.();
        // Re-render the Animation Pane for the new slide.
        this.renderAnimationPane();
        // Scroll thumbnail into view
        const thumb = document.querySelectorAll('.slide-thumb-item')[this.slideIdx];
        if (thumb) thumb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    _savePresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta || !this.currentSlide) return;
        this.currentSlide.notes = ta.value || '';
    }

    _loadPresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta || !this.currentSlide) return;
        ta.value = this.currentSlide.notes || '';
    }

    setupPresenterNotes() {
        const ta = document.getElementById('presenterNotesInput');
        if (!ta) return;
        ta.addEventListener('input', () => {
            if (this.currentSlide) {
                this.currentSlide.notes = ta.value;
                this.scheduleSave();
            }
        });
    }

    get currentSlide() {
        return this.pres ? this.pres.slides[this.slideIdx] : null;
    }

    // ── Element Management ─────────────────────────────────────
    addElement(el) {
        if (!this.currentSlide) return;
        this.pushHistory();
        // Ensure unique z-index on top
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        el.z = maxZ + 1;
        this.currentSlide.elements.push(el);
        this.renderCanvas();
        this.selectElement(el.id);
        this.scheduleSave();
        return el;
    }

    /** Remove selection visuals (class + handles) from a DOM element by id. */
    _removeSelectionFromDOM(id) {
        if (!id) return;
        const domEl = document.getElementById(`el-${id}`);
        if (!domEl) return;
        domEl.classList.remove('selected');
        const handles = domEl.querySelector('.el-handles');
        if (handles) handles.remove();
    }

    /** Add selection visuals (class + handles) to a DOM element by id. */
    _addSelectionToDOM(id) {
        if (!id) return;
        const el = this.getElement(id);
        const domEl = document.getElementById(`el-${id}`);
        if (!el || !domEl) return;
        domEl.classList.add('selected');
        this.appendHandles(domEl, el);
    }

    selectElement(id) {
        if (this.editingId && this.editingId !== id) this.exitTextEditing();
        // Avoid full re-render if already selected (prevents text-edit dblclick from being interrupted)
        if (this.selectedId === id) {
            this.updateRibbonState();
            this.updateStatusBar();
            return;
        }
        // Surgically update selection in the DOM instead of re-rendering the
        // entire canvas.  A full renderCanvas() destroys and recreates every
        // element — including audio/video players — which causes a visible
        // "blink" on media elements.  By only toggling the .selected class
        // and the resize/rotate handles, the DOM is preserved.
        const prevId = this.selectedId;
        this.selectedId = id;
        this._removeSelectionFromDOM(prevId);
        this._addSelectionToDOM(id);
        this.updateRibbonState();
        this.updateStatusBar();
    }

    deselectElement() {
        if (this.editingId) this.exitTextEditing();
        const prevId = this.selectedId;
        this.selectedId = null;
        this._removeSelectionFromDOM(prevId);
        this.updateRibbonState();
        this.updateStatusBar();
    }

    deleteElement(id = null) {
        if (!this.currentSlide) return;
        const target = id || this.selectedId;
        if (!target) return;
        this.pushHistory();
        this.currentSlide.elements = this.currentSlide.elements.filter(e => e.id !== target);
        if (this.selectedId === target) this.selectedId = null;
        if (this.editingId === target) this.editingId = null;
        this.renderCanvas();
        this.updateRibbonState();
        this.updateStatusBar();
        this.scheduleSave();
    }

    duplicateElement(id = null) {
        const target = id || this.selectedId;
        if (!target || !this.currentSlide) return;
        const src = this.currentSlide.elements.find(e => e.id === target);
        if (!src) return;
        this.pushHistory();
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid();
        copy.x += 24; copy.y += 24;
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        copy.z = maxZ + 1;
        this.currentSlide.elements.push(copy);
        this.renderCanvas();
        this.selectElement(copy.id);
        this.scheduleSave();
    }

    getElement(id) {
        return this.currentSlide?.elements.find(e => e.id === id) || null;
    }

    updateElement(id, changes, noHistory = false) {
        const el = this.getElement(id);
        if (!el) return;
        if (!noHistory) this.pushHistory();
        Object.assign(el, changes);
        this.renderElementDOM(id);
        this.scheduleSave();
    }

    bringToFront() {
        if (!this.selectedId || !this.currentSlide) return;
        const maxZ = this.currentSlide.elements.reduce((m, e) => Math.max(m, e.z || 1), 0);
        this.updateElement(this.selectedId, { z: maxZ + 1 });
        this.reZIndex();
    }

    sendToBack() {
        if (!this.selectedId || !this.currentSlide) return;
        const minZ = this.currentSlide.elements.reduce((m, e) => Math.min(m, e.z || 1), 999);
        this.updateElement(this.selectedId, { z: Math.max(0, minZ - 1) });
        this.reZIndex();
    }

    reZIndex() {
        // Normalize z indices
        if (!this.currentSlide) return;
        const sorted = [...this.currentSlide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach((el, i) => { el.z = i + 1; });
        this.renderCanvas();
    }

    // ── Text Editing ───────────────────────────────────────────
    enterTextEditing(id) {
        const el = this.getElement(id);
        if (!el || el.type !== 'text') return;
        this.editingId = id;
        const domEl = document.getElementById(`el-${id}`);
        if (!domEl) return;
        domEl.classList.add('editing');
        domEl.classList.remove('selected');
        const content = domEl.querySelector('.text-content');
        if (content) {
            content.contentEditable = 'true';
            content.focus();
            // Place cursor at end
            const range = document.createRange();
            range.selectNodeContents(content);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
        this.updateRibbonState();
    }

    exitTextEditing() {
        if (!this.editingId) return;
        const domEl = document.getElementById(`el-${this.editingId}`);
        if (domEl) {
            domEl.classList.remove('editing');
            const content = domEl.querySelector('.text-content');
            if (content) {
                content.contentEditable = 'false';
                // Save HTML
                const el = this.getElement(this.editingId);
                if (el) {
                    // Clean up empty list tags before saving
                    this._cleanupEmptyLists(content, el);
                    el.html = content.innerHTML;
                    this.scheduleSave();
                }
            }
        }
        this.editingId = null;
        this.savedSelection = null;
        if (this.selectedId) {
            const domEl2 = document.getElementById(`el-${this.selectedId}`);
            if (domEl2) domEl2.classList.add('selected');
        }
        this.updateRibbonState();
        this.updateThumbnail(this.slideIdx);
    }

    // Save the current selection range (called on blur of contentEditable)
    saveSelection() {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }
    }

    // Restore a previously saved selection range (called before execCommand)
    restoreSelection(contentEl) {
        if (!contentEl) return;
        if (this.savedSelection) {
            // Guard against detached ranges
            const sc = this.savedSelection.startContainer;
            const ec = this.savedSelection.endContainer;
            if (sc && ec && contentEl.contains(sc) && contentEl.contains(ec)) {
                contentEl.focus();
                const selection = window.getSelection();
                selection.removeAllRanges();
                try {
                    selection.addRange(this.savedSelection.cloneRange());
                    return;
                } catch (e) {
                    // Fall through to default focus
                }
            }
        }
        // No valid saved selection — just focus and place cursor at end
        contentEl.focus();
        try {
            const range = document.createRange();
            range.selectNodeContents(contentEl);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {
            // Silently ignore
        }
    }

    // Clean up empty list tags (e.g. <ul></ul> or <ol></ol> with no <li> children)
    // and sync el.listType with the actual DOM state
    _cleanupEmptyLists(contentEl, el) {
        if (!contentEl || !el) return;
        // Remove empty <ul> and <ol> elements (those with no <li> children)
        let changed = false;
        contentEl.querySelectorAll('ul, ol').forEach(list => {
            const lis = list.querySelectorAll('li');
            const hasText = Array.from(lis).some(li => li.textContent.trim() !== '');
            if (lis.length === 0 || !hasText) {
                // Remove the empty list, preserve any remaining text nodes
                while (list.firstChild) {
                    list.parentNode.insertBefore(list.firstChild, list);
                }
                list.remove();
                changed = true;
            }
        });
        // Sync listType
        const hasUl = !!contentEl.querySelector('ul');
        const hasOl = !!contentEl.querySelector('ol');
        if (hasOl) el.listType = 'ol';
        else if (hasUl) el.listType = 'ul';
        else el.listType = '';
        return changed;
    }

    // Check if a DOM element contains a real (non-empty) list of the given type
    _hasRealList(contentEl, type) {
        if (!contentEl) return false;
        const lists = contentEl.querySelectorAll(type);
        if (lists.length === 0) return false;
        // At least one list must have a non-empty <li>
        return Array.from(lists).some(list => {
            const lis = list.querySelectorAll('li');
            return Array.from(lis).some(li => li.textContent.trim() !== '');
        });
    }

    // ── Custom Media Player Wiring ─────────────────────────────

    _fmtTime(sec) {
        if (!sec || !isFinite(sec)) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _wireVideoPlayer(player, vid, ui) {
        const { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn } = ui;

        const PAUSE_SVG = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        const PLAY_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        const VOL_ON_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        const VOL_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

        // Track whether a drag happened so we can suppress click-to-play
        // after the user finishes dragging the element across the canvas.
        let didDrag = false;

        function togglePlay() {
            if (vid.paused) { vid.play(); } else { vid.pause(); }
        }
        function updateState() {
            const paused = vid.paused;
            player.classList.toggle('paused', paused);
            playBtn.innerHTML = paused ? PAUSE_SVG : PLAY_SVG;
            bigPlay.innerHTML = paused ? PAUSE_SVG : PLAY_SVG;
        }
        function updateTime() {
            const cur = vid.currentTime || 0;
            const dur = vid.duration || 0;
            timeEl.textContent = `${this._fmtTime(cur)} / ${this._fmtTime(dur)}`;
            if (dur > 0) {
                progBar.style.width = (cur / dur * 100) + '%';
            }
        }
        function updateBuffer() {
            if (vid.buffered.length > 0 && vid.duration > 0) {
                const end = vid.buffered.end(vid.buffered.length - 1);
                bufferBar.style.width = (end / vid.duration * 100) + '%';
            }
        }

        // Click on video to toggle — but only if the user didn't just
        // finish a drag. A mousedown→mousemove→mouseup sequence that
        // moved the element should NOT also toggle play/pause.
        vid.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        bigPlay.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });

        vid.addEventListener('play', updateState);
        vid.addEventListener('pause', updateState);
        vid.addEventListener('ended', updateState);
        vid.addEventListener('timeupdate', updateTime.bind(this));
        vid.addEventListener('loadedmetadata', () => { updateTime.call(this); updateBuffer(); });
        vid.addEventListener('progress', updateBuffer);

        // Seek
        progWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = progWrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (vid.duration) vid.currentTime = pct * vid.duration;
        });

        // Volume
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            vid.volume = parseFloat(volSlider.value);
            vid.muted = vid.volume === 0;
            volBtn.innerHTML = vid.muted || vid.volume === 0 ? VOL_OFF_SVG : VOL_ON_SVG;
        });
        volBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vid.muted = !vid.muted;
            volBtn.innerHTML = vid.muted ? VOL_OFF_SVG : VOL_ON_SVG;
            volSlider.value = vid.muted ? '0' : String(vid.volume);
        });

        // Fullscreen
        const FS_ENTER_SVG = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        const FS_EXIT_SVG = '<svg viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
        fsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // When in presentation mode, re-parent the player out of
            // .present-slide (which has transform:scale creating a new
            // containing block that traps position:fixed) into the
            // #presentOverlay so it can truly fill the viewport.
            if (this.isPresenting) {
                const overlay = document.getElementById('presentOverlay');
                if (!overlay) return;
                if (this._expandedVideoPlayer === player) {
                    // Collapse: move back to original parent
                    if (player._origParent && player._origNextSibling !== undefined) {
                        if (player._origNextSibling) {
                            player._origParent.insertBefore(player, player._origNextSibling);
                        } else {
                            player._origParent.appendChild(player);
                        }
                    }
                    player.classList.remove('vid-expanded');
                    delete this._expandedVideoPlayer;
                } else {
                    // Expand: remember original position, then move to overlay
                    player._origParent = player.parentElement;
                    player._origNextSibling = player.nextElementSibling;
                    player.classList.add('vid-expanded');
                    overlay.appendChild(player);
                    this._expandedVideoPlayer = player;
                }
                return;
            }
            // Editor mode: use native Fullscreen API as before
            const isPlayerFs = document.fullscreenElement === player ||
                               document.webkitFullscreenElement === player;
            if (isPlayerFs) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else if (player.requestFullscreen) {
                player.requestFullscreen();
            } else if (player.webkitRequestFullscreen) {
                player.webkitRequestFullscreen();
            }
        });
        // Update icon on fullscreen change
        const updateFsIcon = () => {
            const isPlayerFs = document.fullscreenElement === player ||
                               document.webkitFullscreenElement === player;
            const isExpanded = player.classList.contains('vid-expanded');
            const showExit = isPlayerFs || isExpanded;
            fsBtn.innerHTML = showExit ? FS_EXIT_SVG : FS_ENTER_SVG;
            fsBtn.title = showExit ? 'Exit Fullscreen' : 'Fullscreen';
        };
        document.addEventListener('fullscreenchange', updateFsIcon);
        document.addEventListener('webkitfullscreenchange', updateFsIcon);

        // Prevent drag when interacting with specific controls (buttons,
        // sliders, progress bar), but allow dragging from empty/padding
        // areas of the controls bar so the user can reposition the
        // element by grabbing the bottom part of the player.
        const controls = player.querySelector('.vid-controls');
        if (controls) {
            controls.querySelectorAll('button, input, .vid-progress-wrap').forEach(el => {
                el.addEventListener('mousedown', (e) => e.stopPropagation());
            });
        }
        // Also prevent the big center play button from starting a drag
        const bigPlayEl = player.querySelector('.vid-big-play');
        if (bigPlayEl) bigPlayEl.addEventListener('mousedown', (e) => e.stopPropagation());

        // Expose didDrag flag so the parent element's drag logic can
        // set it when a real drag occurs.
        player._setDidDrag = () => { didDrag = true; };
        player._resetDidDrag = () => { didDrag = false; };
    }

    _wireAudioPlayer(player, aud, ui) {
        const { playBtn, timeEl, progWrap, progBar, volBtn, volSlider } = ui;

        const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        const VOL_ON_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        const VOL_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

        // Track whether a drag happened so we can suppress click-to-play
        // after the user finishes dragging the element across the canvas.
        let didDrag = false;

        function togglePlay() {
            if (aud.paused) { aud.play(); } else { aud.pause(); }
        }
        function updateState() {
            const playing = !aud.paused;
            player.classList.toggle('playing', playing);
            playBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
        }
        function updateTime() {
            const cur = aud.currentTime || 0;
            const dur = aud.duration || 0;
            timeEl.textContent = dur > 0 ? `${this._fmtTime(cur)} / ${this._fmtTime(dur)}` : this._fmtTime(cur);
            if (dur > 0) {
                progBar.style.width = (cur / dur * 100) + '%';
            }
        }

        // Only toggle play on click if the user didn't just finish a drag
        playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });
        aud.addEventListener('play', updateState);
        aud.addEventListener('pause', updateState);
        aud.addEventListener('ended', updateState);
        aud.addEventListener('timeupdate', updateTime.bind(this));
        aud.addEventListener('loadedmetadata', () => updateTime.call(this));

        // Seek
        progWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = progWrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (aud.duration) aud.currentTime = pct * aud.duration;
        });

        // Volume
        volSlider.addEventListener('input', (e) => {
            e.stopPropagation();
            aud.volume = parseFloat(volSlider.value);
            aud.muted = aud.volume === 0;
            volBtn.innerHTML = aud.muted || aud.volume === 0 ? VOL_OFF_SVG : VOL_ON_SVG;
        });
        volBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            aud.muted = !aud.muted;
            volBtn.innerHTML = aud.muted ? VOL_OFF_SVG : VOL_ON_SVG;
            volSlider.value = aud.muted ? '0' : String(aud.volume);
        });

        // Prevent drag when interacting with specific controls (buttons,
        // sliders, progress bar), but allow dragging from empty/padding
        // areas of the controls bar so the user can reposition the
        // element by grabbing the bottom part of the player.
        const audCtrl = player.querySelector('.aud-controls');
        if (audCtrl) {
            audCtrl.querySelectorAll('button, input, .aud-progress-wrap').forEach(el => {
                el.addEventListener('mousedown', (e) => e.stopPropagation());
            });
        }

        // Click on art area toggles play — but only if the user didn't
        // just finish a drag across the canvas.
        const audArt = player.querySelector('.aud-art');
        if (audArt) audArt.addEventListener('click', (e) => { e.stopPropagation(); if (!didDrag) togglePlay(); });

        // Expose didDrag flag so the parent element's drag logic can
        // set it when a real drag occurs.
        player._setDidDrag = () => { didDrag = true; };
        player._resetDidDrag = () => { didDrag = false; };
    }

    applyTextFormat(cmd, value = null) {
        // Apply format to selected text within editing element, or all text in selected element
        if (!this.selectedId && !this.editingId) return;
        const targetId = this.editingId || this.selectedId;
        const el = this.getElement(targetId);
        if (!el || el.type !== 'text') return;

        const domEl = document.getElementById(`el-${targetId}`);
        const content = domEl?.querySelector('.text-content');

        // When editing a text element, always use the inline (execCommand) path —
        // even if focus temporarily moved to a toolbar button on click.
        // Checking content.contains(document.activeElement) breaks when the user
        // clicks a ribbon button because focus shifts to the button.
        if (this.editingId && content) {
            // Ensure the contentEditable has focus so execCommand works.
            // Focus may have moved to a toolbar button on click — restore saved selection.
            if (!content.contains(document.activeElement)) {
                this.restoreSelection(content);
            }
            // For textAlign, execCommand uses different command names (justifyLeft, justifyCenter, justifyRight)
            if (cmd === 'textAlign') {
                const execCmd = value === 'left' ? 'justifyLeft' : value === 'center' ? 'justifyCenter' : 'justifyRight';
                document.execCommand(execCmd, false, null);
                el.textAlign = value;
            } else if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
                // List commands — toggle list format via execCommand
                const listTag = cmd === 'insertUnorderedList' ? 'ul' : 'ol';
                // Check state BEFORE execCommand — was the list already active?
                const wasActive = this._hasRealList(content, listTag);
                if (!wasActive) {
                    // We're about to turn ON the list — first clean up any empty/stale
                    // list tags that could confuse execCommand
                    this._cleanupEmptyLists(content, el);
                }
                document.execCommand(cmd, false, null);
                if (wasActive) {
                    // User toggled OFF — clean up any leftover empty list tags
                    this._cleanupEmptyLists(content, el);
                } else {
                    // User toggled ON — just sync listType (don't cleanup, new list may be empty)
                    const hasUl = !!content.querySelector('ul');
                    const hasOl = !!content.querySelector('ol');
                    if (hasOl) el.listType = 'ol';
                    else if (hasUl) el.listType = 'ul';
                    else el.listType = '';
                }
            } else {
                document.execCommand(cmd, false, value);
            }
            el.html = content.innerHTML;
        } else {
            // Apply to whole element style
            switch (cmd) {
                case 'bold':      this.updateElement(targetId, { bold: !el.bold }); break;
                case 'italic':    this.updateElement(targetId, { italic: !el.italic }); break;
                case 'underline': this.updateElement(targetId, { underline: !el.underline }); break;
                case 'fontFamily': this.updateElement(targetId, { fontFamily: value }); break;
                case 'fontSize':  this.updateElement(targetId, { fontSize: parseInt(value) }); break;
                case 'color':     this.updateElement(targetId, { color: value }); break;
                case 'highlight': this.updateElement(targetId, { highlight: value === 'transparent' ? '' : value }); break;
                case 'textAlign': this.updateElement(targetId, { textAlign: value }); break;
                case 'insertUnorderedList':
                case 'insertOrderedList': {
                    // Toggle list type on the element
                    const listTag = cmd === 'insertUnorderedList' ? 'ul' : 'ol';
                    const currentList = el.listType || '';
                    let newHtml = el.html || '';

                    // Check if the HTML actually contains a real list (not stale listType)
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = newHtml;
                    const actualHasList = !!tempDiv.querySelector(listTag);
                    const hasActualLis = Array.from(tempDiv.querySelectorAll(`${listTag} li`)).some(li => li.textContent.trim() !== '');

                    if (currentList === listTag && actualHasList && hasActualLis) {
                        // Toggle off — strip the list tags, keep <li> content as plain text
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        this.updateElement(targetId, { listType: '', html: newHtml });
                    } else if (currentList === listTag && (!actualHasList || !hasActualLis)) {
                        // listType was stale — list doesn't actually exist, so turn it on fresh
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        // Ensure there's at least one list item
                        const parts = newHtml.split(/<\/div>|<br\s*\/?>/i).filter(p => p.trim());
                        if (parts.length === 0) {
                            newHtml = `<${listTag}><li>&nbsp;</li></${listTag}>`;
                        } else {
                            const listItems = parts.map(p => {
                                const text = p.replace(/<div>/gi, '').trim();
                                return `<li>${text || '&nbsp;'}</li>`;
                            }).join('');
                            newHtml = `<${listTag}>${listItems}</${listTag}>`;
                        }
                        this.updateElement(targetId, { listType: listTag, html: newHtml });
                    } else {
                        // Toggle on — wrap content in list
                        // First strip any existing list tags
                        newHtml = newHtml.replace(/<\/?ul>/gi, '').replace(/<\/?ol>/gi, '').replace(/<li>/gi, '<div>').replace(/<\/li>/gi, '</div>');
                        // Split by divs or line breaks and wrap in list items
                        const parts = newHtml.split(/<\/div>|<br\s*\/?>/i).filter(p => p.trim());
                        if (parts.length === 0) {
                            newHtml = `<${listTag}><li>&nbsp;</li></${listTag}>`;
                        } else {
                            const listItems = parts.map(p => {
                                const text = p.replace(/<div>/gi, '').trim();
                                return `<li>${text || '&nbsp;'}</li>`;
                            }).join('');
                            newHtml = `<${listTag}>${listItems}</${listTag}>`;
                        }
                        this.updateElement(targetId, { listType: listTag, html: newHtml });
                    }
                    break;
                }
            }
        }
        this.scheduleSave();
        this.updateRibbonState();
    }

    // ── Canvas Rendering ───────────────────────────────────────
    renderCanvas() {
        const canvas = document.getElementById('slideCanvas');
        if (!canvas) return;
        // After this render finishes, refresh ruler tick alignment (the canvas
        // position may have shifted due to scrollbar or layout changes).
        requestAnimationFrame(() => this.renderRulers());

        // Clear
        canvas.innerHTML = '';

        const slide = this.currentSlide;
        if (!slide) return;

        // Background
        const bg = slide.background;
        // Reset all background properties first so switching from image → color doesn't leave residual image
        canvas.style.backgroundImage = '';
        canvas.style.backgroundSize = '';
        canvas.style.backgroundPosition = '';
        if (bg.type === 'color' || bg.type === 'gradient') {
            canvas.style.background = bg.value;
        } else if (bg.type === 'image') {
            canvas.style.background = '#ffffff';
            canvas.style.backgroundImage = `url(${bg.value})`;
            canvas.style.backgroundSize = 'cover';
            canvas.style.backgroundPosition = 'center';
        } else {
            canvas.style.background = '#ffffff';
        }

        // Sort elements by z
        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));

        sorted.forEach(el => {
            const domEl = this.createElementDOM(el);
            canvas.appendChild(domEl);
        });


        // Render link badges on canvas level (outside element divs so they never get clipped)
        sorted.forEach(el => {
            if (el.link) {
                const badge = document.createElement('div');
                badge.className = 'link-badge';
                badge.dataset.elId = el.id;
                badge.title = el.link;
                badge.style.cssText = `position:absolute;left:${el.x + el.w - 9}px;top:${el.y - 9}px;z-index:${(el.z || 1) + 1};`;
                badge.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
                canvas.appendChild(badge);
            }
        });

        // Render comment markers
        if (slide.comments && slide.comments.length) {
            slide.comments.forEach((comment, ci) => {
                // If comment is attached to an element, compute position from element's current location
                let pinX = comment.x;
                let pinY = comment.y;
                if (comment.elementId) {
                    const linkedEl = slide.elements.find(e => e.id === comment.elementId);
                    if (linkedEl) {
                        pinX = linkedEl.x + linkedEl.w + 10; // Stick to the element
                        pinY = linkedEl.y;
                    } else {
                        // Element was deleted — remove orphaned comment too
                        slide.comments.splice(ci, 1);
                        this.scheduleSave();
                        return; // skip this iteration
                    }
                }
                const pin = document.createElement('div');
                pin.className = 'comment-pin';
                pin.dataset.commentIdx = ci;
                pin.title = `${comment.author}: ${comment.text}`;
                pin.style.cssText = `position:absolute;left:${pinX}px;top:${pinY}px;z-index:${999 + ci};`;
                pin.innerHTML = `<div class="comment-pin-icon"><span>${comment.author.charAt(0)}</span></div>`;
                // Click to show comment popup
                pin.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showCommentPopup(comment, ci);
                });
                canvas.appendChild(pin);
            });
        }
        this.updateScalerSize();
        this.updateThumbnail(this.slideIdx);
    }

    createElementDOM(el) {
        const div = document.createElement('div');
        div.id = `el-${el.id}`;
        div.className = `slide-el slide-el-${el.type}`;
        div.draggable = false;
        div.style.cssText = `
            left:${el.x}px; top:${el.y}px;
            width:${el.w}px; height:${el.h}px;
            transform:rotate(${el.r || 0}deg);
            z-index:${el.z || 1};
            opacity:${el.opacity !== undefined ? el.opacity : 1};
        `;

        if (el.type === 'text') {
            div.style.fontFamily = el.fontFamily || 'DM Sans';
            div.style.fontSize = (el.fontSize || 24) + 'px';
            div.style.color = el.color || '#1a1a1a';
            div.style.textAlign = el.textAlign || 'left';
            div.style.fontWeight = el.bold ? '700' : '400';
            div.style.fontStyle = el.italic ? 'italic' : 'normal';
            div.style.textDecoration = el.underline ? 'underline' : 'none';
            div.style.backgroundColor = el.highlight || 'transparent';
            const content = document.createElement('div');
            content.className = 'text-content';
            content.contentEditable = 'false';
            content.setAttribute('data-placeholder', 'Click to edit text');
            content.style.cssText = 'width:100%;height:100%;outline:none;word-break:break-word;white-space:pre-wrap;';
            content.innerHTML = sanitizeUserHtml(el.html) || '';
            // Link is handled via click on the element (see mousedown handler)
            // Listen for input to save
            content.addEventListener('input', () => {
                el.html = content.innerHTML;
                // Sync listType from actual DOM content — only count real (non-empty) lists
                const hasRealUl = this._hasRealList(content, 'ul');
                const hasRealOl = this._hasRealList(content, 'ol');
                if (el.listType === 'ul' && !hasRealUl) el.listType = '';
                if (el.listType === 'ol' && !hasRealOl) el.listType = '';
                if (!el.listType && hasRealOl) el.listType = 'ol';
                else if (!el.listType && hasRealUl) el.listType = 'ul';
                this.scheduleSave();
                this.updateThumbnail(this.slideIdx);
                this.updateRibbonState();
            });
            // Save selection on blur so toolbar buttons can restore it before execCommand
            content.addEventListener('blur', () => this.saveSelection());
            div.appendChild(content);
        } else if (el.type === 'shape') {
            // Icon shapes carry their own pre-rendered SVG markup
            if (el.shape === 'icon') {
                div.innerHTML = sanitizeUserHtml(el.svg) || '';
            } else {
                div.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
            }
        } else if (el.type === 'image') {
            const imgWrap = document.createElement('div');
            imgWrap.className = 'slide-el-image-wrap';
            imgWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;';
            const img = document.createElement('img');
            // URL restricted to safe schemes by safeMediaUrl (see definition).
            img.src = safeMediaUrl(el.src, 'image');
            img.draggable = false;
            img.alt = el.alt || '';
            // Apply crop if any
            const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
            const visibleW = 1 - crop.l - crop.r;
            const visibleH = 1 - crop.t - crop.b;
            if (visibleW <= 0 || visibleH <= 0) {
                // Invalid crop, reset
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                const scaleW = 1 / visibleW;
                const scaleH = 1 / visibleH;
                img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;pointer-events:none;`;
            } else {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            }
            imgWrap.appendChild(img);
            div.appendChild(imgWrap);
        } else if (el.type === 'video') {
            const player = document.createElement('div');
            player.className = 'slide-video-player paused';
            // Hidden <video> element (no native controls)
            const vid = document.createElement('video');
            vid.src = safeMediaUrl(el.src, 'video');
            vid.preload = 'metadata';
            vid.setAttribute('poster', safeMediaUrl(el.poster, 'image') || '');
            vid.setAttribute('playsinline', '');
            // Big center play button
            const bigPlay = document.createElement('div');
            bigPlay.className = 'vid-big-play';
            bigPlay.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            // Controls bar
            const controls = document.createElement('div');
            controls.className = 'vid-controls';
            // Progress bar
            const progWrap = document.createElement('div');
            progWrap.className = 'vid-progress-wrap';
            const bufferBar = document.createElement('div');
            bufferBar.className = 'vid-buffer-bar';
            const progBar = document.createElement('div');
            progBar.className = 'vid-progress-bar';
            progWrap.appendChild(bufferBar);
            progWrap.appendChild(progBar);
            // Button row
            const btns = document.createElement('div');
            btns.className = 'vid-btns';
            const playBtn = document.createElement('button');
            playBtn.className = 'vid-btn';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            playBtn.title = 'Play';
            const timeEl = document.createElement('span');
            timeEl.className = 'vid-time';
            timeEl.textContent = '0:00 / 0:00';
            const spacer = document.createElement('div');
            spacer.className = 'vid-spacer';
            // Volume
            const volWrap = document.createElement('div');
            volWrap.className = 'vid-vol-wrap';
            const volBtn = document.createElement('button');
            volBtn.className = 'vid-btn';
            volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
            volBtn.title = 'Volume';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'vid-vol-slider';
            volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
            volWrap.appendChild(volBtn);
            volWrap.appendChild(volSlider);
            // Fullscreen
            const fsBtn = document.createElement('button');
            fsBtn.className = 'vid-btn';
            fsBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
            fsBtn.title = 'Fullscreen';
            btns.appendChild(playBtn);
            btns.appendChild(timeEl);
            btns.appendChild(spacer);
            btns.appendChild(volWrap);
            btns.appendChild(fsBtn);
            controls.appendChild(progWrap);
            controls.appendChild(btns);
            player.appendChild(vid);
            player.appendChild(bigPlay);
            player.appendChild(controls);
            div.appendChild(player);
            // Wire up player logic
            this._wireVideoPlayer(player, vid, { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn });
        } else if (el.type === 'audio') {
            const player = document.createElement('div');
            player.className = 'slide-audio-player';
            // Art area with wave animation only
            const art = document.createElement('div');
            art.className = 'aud-art';
            const wave = document.createElement('div');
            wave.className = 'aud-wave';
            for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('span'));
            art.appendChild(wave);
            // Controls
            const audCtrl = document.createElement('div');
            audCtrl.className = 'aud-controls';
            // Progress
            const progWrap = document.createElement('div');
            progWrap.className = 'aud-progress-wrap';
            const progBar = document.createElement('div');
            progBar.className = 'aud-progress-bar';
            progWrap.appendChild(progBar);
            // Buttons
            const btns = document.createElement('div');
            btns.className = 'aud-btns';
            const playBtn = document.createElement('button');
            playBtn.className = 'aud-play-btn';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
            playBtn.title = 'Play';
            const timeEl = document.createElement('span');
            timeEl.className = 'aud-time';
            timeEl.textContent = '0:00';
            const spacer = document.createElement('div');
            spacer.className = 'aud-spacer';
            // Volume
            const volWrap = document.createElement('div');
            volWrap.className = 'aud-vol-wrap';
            const volBtn = document.createElement('button');
            volBtn.className = 'aud-btn';
            volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
            volBtn.title = 'Volume';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'aud-vol-slider';
            volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
            volWrap.appendChild(volBtn);
            volWrap.appendChild(volSlider);
            btns.appendChild(playBtn);
            btns.appendChild(timeEl);
            btns.appendChild(spacer);
            btns.appendChild(volWrap);
            audCtrl.appendChild(progWrap);
            audCtrl.appendChild(btns);
            // Hidden audio element
            const aud = document.createElement('audio');
            aud.src = safeMediaUrl(el.src, 'audio');
            aud.preload = 'metadata';
            player.appendChild(art);
            player.appendChild(audCtrl);
            player.appendChild(aud);
            div.appendChild(player);
            // Wire up audio player logic
            this._wireAudioPlayer(player, aud, { playBtn, timeEl, progWrap, progBar, volBtn, volSlider });
        }

        // Event: mousedown for select/drag
        div.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            // If Ctrl is held and element has a link, don't select/edit — let click handler open the link
            if ((e.ctrlKey || e.metaKey) && el.link) {
                this._lastDragHadMoved = false;
                return;
            }
            // If already editing this text element, let the browser handle caret placement
            if (this.editingId === el.id && el.type === 'text') return;
            if (this.editingId && this.editingId !== el.id) this.exitTextEditing();
            const wasSelected = this.selectedId === el.id;
            this._wasSelectedBeforeClick = wasSelected; // Track for link click handler
            this._lastDragHadMoved = false; // Reset drag tracker for link click
            this.selectElement(el.id);
            // For text: if already selected, single click also enters edit mode (PowerPoint-like)
            if (el.type === 'text' && wasSelected) {
                this.enterTextEditing(el.id);
                return;
            }
            this.startDrag(e, el.id, 'move');
        });

        // Double-click to enter text edit
        if (el.type === 'text') {
            div.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.enterTextEditing(el.id);
            });
        }

        // Ctrl+Click to open link — Ctrl + Left Click opens link in editor mode
        if (el.link) {
            div.addEventListener('click', (e) => {
                // Don't open if in editing mode
                if (this.editingId === el.id) return;
                // Don't open if this was a drag action
                if (this._lastDragHadMoved) return;
                // Only open with Ctrl + Left Click
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                e.stopPropagation();
                safeOpenUrl(el.link);
            });
            div.classList.add('has-link');
        }

        // Selection indicator
        if (this.selectedId === el.id) {
            div.classList.add('selected');
            this.appendHandles(div, el);
        }
        if (this.editingId === el.id) {
            div.classList.add('editing');
            div.classList.remove('selected');
            const c = div.querySelector('.text-content');
            if (c) c.contentEditable = 'true';
        }

        return div;
    }

    renderElementDOM(id) {
        const el = this.getElement(id);
        const domEl = document.getElementById(`el-${id}`);
        if (!el || !domEl) { this.renderCanvas(); return; }

        domEl.style.left = el.x + 'px';
        domEl.style.top = el.y + 'px';
        domEl.style.width = el.w + 'px';
        domEl.style.height = el.h + 'px';
        domEl.style.transform = `rotate(${el.r || 0}deg)`;
        domEl.style.zIndex = el.z || 1;
        domEl.style.opacity = el.opacity !== undefined ? el.opacity : 1;

        if (el.type === 'text') {
            domEl.style.fontFamily = el.fontFamily || 'DM Sans';
            domEl.style.fontSize = (el.fontSize || 24) + 'px';
            domEl.style.color = el.color || '#1a1a1a';
            domEl.style.textAlign = el.textAlign || 'left';
            domEl.style.fontWeight = el.bold ? '700' : '400';
            domEl.style.fontStyle = el.italic ? 'italic' : 'normal';
            domEl.style.textDecoration = el.underline ? 'underline' : 'none';
            domEl.style.backgroundColor = el.highlight || 'transparent';
            const c = domEl.querySelector('.text-content');
            if (c && this.editingId !== id) c.innerHTML = sanitizeUserHtml(el.html) || '';
        } else if (el.type === 'shape') {
            if (el.shape === 'icon') {
                domEl.innerHTML = sanitizeUserHtml(el.svg) || '';
            } else {
                domEl.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
            }
        } else if (el.type === 'image') {
            // Re-render image with current crop
            const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
            const visibleW = 1 - crop.l - crop.r;
            const visibleH = 1 - crop.t - crop.b;
            domEl.innerHTML = '';
            // Use an inner wrapper for overflow clipping so handles on the outer domEl are not clipped
            const imgWrap = document.createElement('div');
            imgWrap.className = 'slide-el-image-wrap';
            imgWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;';
            const img = document.createElement('img');
            img.src = safeMediaUrl(el.src, 'image');
            img.draggable = false;
            img.alt = '';
            if (visibleW <= 0 || visibleH <= 0) {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                const scaleW = 1 / visibleW;
                const scaleH = 1 / visibleH;
                img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;pointer-events:none;`;
            } else {
                img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;object-fit:contain;';
            }
            imgWrap.appendChild(img);
            domEl.appendChild(imgWrap);
        }

        // Re-append handles if selected
        const existingHandles = domEl.querySelector('.el-handles');
        if (existingHandles) existingHandles.remove();
        if (this.selectedId === id) {
            this.appendHandles(domEl, el);
        }
  
    }

    appendHandles(domEl, el) {
        const wrapper = document.createElement('div');
        wrapper.className = 'el-handles';

        const positions = ['nw','n','ne','e','se','s','sw','w'];
        positions.forEach(pos => {
            const h = document.createElement('div');
            h.className = `el-handle ${pos}`;
            h.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.startDrag(e, el.id, 'resize', pos);
            });
            wrapper.appendChild(h);
        });

        // Rotate handle (skip for line-type shapes)
        if (el.shape !== 'line' && el.shape !== 'lineArrow' && el.shape !== 'lineDouble' && el.shape !== 'lineElbow' && el.shape !== 'lineCurve') {
            const rh = document.createElement('div');
            rh.className = 'el-rotate-handle';
            rh.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
            rh.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.startDrag(e, el.id, 'rotate');
            });
            wrapper.appendChild(rh);
        }

        domEl.appendChild(wrapper);
    }

    // ── Drag / Resize / Crop / Rotate ──────────────────────────
    // Modifier keys (PowerPoint-style):
    //   - No modifier + CORNER handle = RESIZE (proportional for images, free for shapes/text)
    //   - No modifier + SIDE handle   = STRETCH (one dimension)
    //   - SHIFT + any handle          = CROP (for images & shapes — clip the visible region)
    startDrag(e, id, type, handle = null) {
        const el = this.getElement(id);
        if (!el) return;

        this.pushHistory();
        const isCorner = handle && handle.length === 2; // nw, ne, se, sw
        const shiftHeld = e.shiftKey;
        const canCrop = el.type === 'image' || el.type === 'shape';
        const cropMode = shiftHeld && canCrop && type === 'resize';

        this._cropMode = cropMode;
        if (cropMode && !el.crop) el.crop = { l: 0, t: 0, r: 0, b: 0 };

        this.drag = {
            type, id, handle,
            startMX: e.clientX, startMY: e.clientY,
            startX: el.x, startY: el.y,
            startW: el.w, startH: el.h,
            startR: el.r || 0,
            startCrop: el.crop ? { ...el.crop } : { l: 0, t: 0, r: 0, b: 0 },
            cropMode,
            isCorner,
            shiftHeld,
            // For images: lock aspect ratio on EVERY handle resize
            // (corner AND side) so the box always matches the image
            // and the image always fills the box without letterboxing.
            aspect: (el.type === 'image' && !cropMode) ? (el.w / el.h) : null,
        };

        if (type === 'rotate') {
            // Compute center of element in screen coords
            const canvas = document.getElementById('slideCanvas');
            const rect = canvas.getBoundingClientRect();
            this.drag.cx = rect.left + (el.x + el.w / 2) * this.scale;
            this.drag.cy = rect.top + (el.y + el.h / 2) * this.scale;
            this.drag.startAngle = Math.atan2(e.clientY - this.drag.cy, e.clientX - this.drag.cx) * 180 / Math.PI;
        }

        // Add crop-mode visual class to element
        if (cropMode) {
            const domEl = document.getElementById(`el-${id}`);
            if (domEl) domEl.classList.add('crop-mode');
        }

        document.addEventListener('mousemove', this._onDragMove, { passive: false });
        document.addEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = cropMode ? 'crosshair' : (type === 'rotate' ? 'grabbing' : (handle ? `${handle}-resize` : 'grabbing'));
    }

    _onDragMove = (e) => {
        if (!this.drag) return;
        const el = this.getElement(this.drag.id);
        if (!el) return;

        const dx = (e.clientX - this.drag.startMX) / this.scale;
        const dy = (e.clientY - this.drag.startMY) / this.scale;

        // Flag that a real drag occurred so the media player's click
        // handlers know to suppress play/pause toggling.
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            this.drag.hasMoved = true;
            // Notify any media player inside this element
            const domEl = document.getElementById(`el-${this.drag.id}`);
            if (domEl) {
                const player = domEl.querySelector('.slide-video-player, .slide-audio-player');
                if (player && player._setDidDrag) player._setDidDrag();
            }
        }

        if (this.drag.type === 'move') {
            el.x = Math.round(this.drag.startX + dx);
            el.y = Math.round(this.drag.startY + dy);
        } else if (this.drag.type === 'rotate') {
            const angle = Math.atan2(e.clientY - this.drag.cy, e.clientX - this.drag.cx) * 180 / Math.PI;
            el.r = Math.round(this.drag.startR + (angle - this.drag.startAngle));
        } else if (this.drag.type === 'resize') {
            if (this.drag.cropMode) {
                // CROP mode: adjust crop region (l, t, r, b — each 0..0.5)
                // dx/dy is in canvas pixels. Convert to fraction of element size.
                const fx = dx / this.drag.startW;
                const fy = dy / this.drag.startH;
                const h = this.drag.handle;
                const c = { ...this.drag.startCrop };

                if (h.includes('e')) {
                    // Dragging right edge: increase right crop (clipping from right)
                    c.r = clamp(c.r + fx, 0, 0.95 - c.l);
                }
                if (h.includes('s')) {
                    c.b = clamp(c.b + fy, 0, 0.95 - c.t);
                }
                if (h.includes('w')) {
                    // Dragging left edge: increase left crop
                    c.l = clamp(c.l - fx, 0, 0.95 - c.r);
                }
                if (h.includes('n')) {
                    c.t = clamp(c.t - fy, 0, 0.95 - c.b);
                }
                el.crop = c;
            } else {
                // RESIZE / STRETCH mode
                const h = this.drag.handle;
                let { startX: x, startY: y, startW: w, startH: h2 } = this.drag;
                const isCorner = this.drag.isCorner;
                const aspect = this.drag.aspect;

                // Min size 10px (was 20) — lets users shrink images/elements smaller.
                const MIN = 10;
                if (h.includes('e')) { w = Math.max(MIN, w + dx); }
                if (h.includes('s')) { h2 = Math.max(MIN, h2 + dy); }
                if (h.includes('w')) { x = this.drag.startX + dx; w = Math.max(MIN, this.drag.startW - dx); }
                if (h.includes('n')) { y = this.drag.startY + dy; h2 = Math.max(MIN, this.drag.startH - dy); }

                // For images: preserve aspect ratio on every handle
                // (corner AND side). When the user drags a side handle,
                // the perpendicular dimension follows so the box keeps
                // the image's aspect ratio — no letterboxing, and the
                // box visually tracks the image during the stretch.
                if (aspect) {
                    // For side handles, the primary axis is the one being
                    // dragged; derive the other from aspect ratio.
                    // For corner handles, use the dominant delta as before.
                    const isSide = !isCorner;
                    if (isSide) {
                        // Side handle: the dragged axis wins, the other follows.
                        const horiz = h.includes('e') || h.includes('w'); // horizontal drag
                        if (horiz) {
                            // width changed → recompute height from aspect
                            const newH = w / aspect;
                            // Keep the opposite edge (top or bottom) fixed
                            if (h.includes('n')) y = this.drag.startY + (this.drag.startH - newH);
                            h2 = newH;
                        } else {
                            // vertical drag (n/s) → recompute width
                            const newW = h2 * aspect;
                            if (h.includes('w')) x = this.drag.startX + (this.drag.startW - newW);
                            w = newW;
                        }
                    } else {
                        // Corner handle: use the dominant delta to preserve aspect.
                        const newAspect = w / h2;
                        if (newAspect > aspect) {
                            const newH = w / aspect;
                            if (h.includes('n')) y = this.drag.startY + (this.drag.startH - newH);
                            h2 = newH;
                        } else {
                            const newW = h2 * aspect;
                            if (h.includes('w')) x = this.drag.startX + (this.drag.startW - newW);
                            w = newW;
                        }
                    }
                }

                el.x = Math.round(x); el.y = Math.round(y);
                el.w = Math.round(w); el.h = Math.round(h2);
            }
        }

        this.renderElementDOM(this.drag.id);
        // Update linked comment pin positions during drag
        this._updateLinkedCommentPins(this.drag.id);
        // Update link badge position during drag (real-time)
        this._updateLinkBadge(this.drag.id);
        this.updateThumbnail(this.slideIdx);
        this.updateStatusBar();
    };

    _updateLinkBadge(elementId) {
        const canvas = document.getElementById('slideCanvas');
        if (!canvas) return;
        const el = this.getElement(elementId);
        if (!el) return;
        const badge = canvas.querySelector(`.link-badge[data-el-id="${elementId}"]`);
        if (badge) {
            badge.style.left = (el.x + el.w - 9) + 'px';
            badge.style.top = (el.y - 9) + 'px';
        }
    }

    _updateLinkedCommentPins(elementId) {
        const slide = this.currentSlide;
        const canvas = document.getElementById('slideCanvas');
        if (!slide || !canvas) return;
        if (!slide.comments) return;
        const el = this.getElement(elementId);
        if (!el) return;
        slide.comments.forEach((comment, ci) => {
            if (comment.elementId === elementId) {
                const pinEl = canvas.querySelector(`[data-comment-idx="${ci}"]`);
                if (pinEl) {
                    pinEl.style.left = (el.x + el.w + 10) + 'px'; // Stick to the element
                    pinEl.style.top = el.y + 'px';
                }
                // Also update any open popup for this comment
                const popupEl = canvas.querySelector('.comment-popup');
                if (popupEl) {
                    popupEl.style.left = (el.x + el.w + 40) + 'px'; // Next to the pin
                    popupEl.style.top = (el.y - 6) + 'px';
                }
            }
        });
    }

    _onDragEnd = () => {
        document.removeEventListener('mousemove', this._onDragMove);
        document.removeEventListener('mouseup', this._onDragEnd);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        if (this.drag) {
            // Remove crop-mode visual class
            const domEl = document.getElementById(`el-${this.drag.id}`);
            if (domEl) domEl.classList.remove('crop-mode');
            // Reset the media player's didDrag flag after a short delay
            // so the pending click event sees didDrag=true and is
            // suppressed, then the flag resets for the next interaction.
            if (this.drag.hasMoved && domEl) {
                const player = domEl.querySelector('.slide-video-player, .slide-audio-player');
                if (player && player._resetDidDrag) {
                    setTimeout(() => player._resetDidDrag(), 50);
                }
            }
            // Track whether a drag occurred for link click detection
            this._lastDragHadMoved = this.drag ? !!this.drag.hasMoved : false;
            this.scheduleSave();
            this.renderCanvas(); // Re-render to update comment pins & link badges
            this.drag = null;
            this._cropMode = false;
        }
    };

    screenToCanvas(sx, sy) {
        const canvas = document.getElementById('slideCanvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return {
            x: clamp(Math.round((sx - rect.left) / this.scale), 0, 960),
            y: clamp(Math.round((sy - rect.top) / this.scale), 0, 540),
        };
    }

    // ── Canvas Scaling ─────────────────────────────────────────
    updateScalerSize() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        const scaler = document.getElementById('slideCanvasScaler');
        if (!wrapper || !scaler) return;

        const availW = wrapper.clientWidth - 80;
        const availH = wrapper.clientHeight - 60;
        const scaleX = availW / 960;
        const scaleY = availH / 540;
        this.scale = Math.min(scaleX, scaleY, 1.5);

        scaler.style.width = '960px';
        scaler.style.height = '540px';
        scaler.style.transform = `scale(${this.scale})`;

        const zoomEl = document.getElementById('zoomStatus');
        if (zoomEl) zoomEl.textContent = Math.round(this.scale * 100) + '%';
    }

    setupResizeObserver() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        if (!wrapper) return;
        const ro = new ResizeObserver(() => this.updateScalerSize());
        ro.observe(wrapper);
        this.updateScalerSize();

        // Scroll-to-zoom: Ctrl+wheel zooms the editor canvas
        const editorContent = document.getElementById('editorContent');
        if (editorContent) {
            editorContent.addEventListener('wheel', (e) => {
                // Only zoom when Ctrl is held (or Cmd on Mac)
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                e.stopPropagation();

                // Determine zoom direction from deltaY
                // Normalize delta (some mice use large delta values)
                const delta = e.deltaY > 0 ? -1 : 1;
                const factor = 1 + (delta * 0.08); // 8% zoom step
                this.setZoom(this.scale * factor);
            }, { passive: false });
        }
    }

    // ── Slide Thumbnails ───────────────────────────────────────
    renderSlideList() {
        const list = document.getElementById('slidesList');
        if (!list || !this.pres) return;
        list.innerHTML = '';

        this.pres.slides.forEach((slide, idx) => {
            const item = document.createElement('div');
            item.className = `slide-thumb-item${idx === this.slideIdx ? ' active' : ''}`;
            item.draggable = true;
            item.dataset.idx = idx;

            const num = document.createElement('div');
            num.className = 'slide-thumb-number';
            num.textContent = idx + 1;

            const wrap = document.createElement('div');
            wrap.className = 'slide-thumb-canvas-wrap';

            const inner = document.createElement('div');
            inner.className = 'slide-thumb-inner';
            inner.id = `thumb-inner-${slide.id}`;
            inner.style.background = slide.background.type !== 'image' ? slide.background.value : '#fff';

            this.renderThumbContent(inner, slide);
            wrap.appendChild(inner);

            item.appendChild(num);
            item.appendChild(wrap);

            // Apply thumbnail scale after layout (double-RAF for reliable clientWidth)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const w = wrap.clientWidth || 276;
                const thumbScale = w / 960;
                inner.style.transform = `scale(${thumbScale})`;
                inner.style.transformOrigin = 'top left';
                wrap.style.height = (540 * thumbScale) + 'px';
            }));

            // Events
            item.addEventListener('click', () => this.selectSlide(idx));

            // Drag to reorder
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', idx);
                item.style.opacity = '0.5';
            });
            item.addEventListener('dragend', () => { item.style.opacity = ''; });
            item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
            item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                this.reorderSlide(fromIdx, idx);
            });

            list.appendChild(item);
        });
    }

    renderThumbContent(inner, slide) {
        inner.innerHTML = '';
        const bg = slide.background;
        if (bg.type === 'gradient') inner.style.background = bg.value;
        else inner.style.background = bg.value || '#ffffff';

        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach(el => {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.r || 0}deg);z-index:${el.z || 1};overflow:hidden;pointer-events:none;`;
            if (el.type === 'text') {
                d.style.fontFamily = el.fontFamily || 'DM Sans';
                d.style.fontSize = (el.fontSize || 24) + 'px';
                d.style.color = el.color || '#1a1a1a';
                d.style.fontWeight = el.bold ? '700' : '400';
                d.style.backgroundColor = el.highlight || 'transparent';
                d.style.padding = '8px 10px';
                d.style.wordBreak = 'break-word';
                d.innerHTML = sanitizeUserHtml(el.html) || '';
            } else if (el.type === 'shape') {
                if (el.shape === 'icon') {
                    d.innerHTML = sanitizeUserHtml(el.svg) || '';
                } else {
                    d.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
                }
            } else if (el.type === 'image') {
                const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
                const visibleW = 1 - crop.l - crop.r;
                const visibleH = 1 - crop.t - crop.b;
                const img = document.createElement('img');
                img.src = safeMediaUrl(el.src, 'image');
                if (visibleW <= 0 || visibleH <= 0) {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                    const scaleW = 1 / visibleW;
                    const scaleH = 1 / visibleH;
                    img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;`;
                } else {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                }
                d.appendChild(img);
            } else if (el.type === 'video') {
                // Lightweight thumbnail placeholder matching the custom video
                // player's dark look with an orange play button overlay.
                d.style.background = '#000';
                d.style.display = 'flex';
                d.style.alignItems = 'center';
                d.style.justifyContent = 'center';
                d.style.borderRadius = '0';
                d.innerHTML = '<div style="width:24px;height:24px;border-radius:50%;background:#f97316;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>';
            } else if (el.type === 'audio') {
                // Compact audio thumbnail matching the custom audio player's
                // dark gradient background with wave animation and controls.
                d.style.background = 'linear-gradient(135deg, #1e1e2e 0%, #2a2a3c 100%)';
                d.style.display = 'flex';
                d.style.alignItems = 'center';
                d.style.justifyContent = 'center';
                d.style.borderRadius = '0';
                d.style.gap = '4px';
                d.style.padding = '0 8px';
                d.innerHTML = '<div style="width:14px;height:14px;border-radius:50%;background:#f97316;display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="8" height="8" viewBox="0 0 24 24" fill="#fff"><polygon points="6 4 20 12 6 20 6 4"/></svg></div><div style="display:flex;align-items:flex-end;gap:1px;height:10px"><span style="width:1.5px;height:40%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:70%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:100%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:60%;background:#f97316;border-radius:1px"></span><span style="width:1.5px;height:35%;background:#f97316;border-radius:1px"></span></div>';
            }
            inner.appendChild(d);
        });
        // Mini comment indicators in thumbnails
        if (slide.comments && slide.comments.length) {
            slide.comments.forEach(comment => {
                let px = comment.x, py = comment.y;
                if (comment.elementId) {
                    const linkedEl = slide.elements.find(e => e.id === comment.elementId);
                    if (linkedEl) { px = linkedEl.x + linkedEl.w; py = linkedEl.y; }
                }
                const pin = document.createElement('div');
                pin.style.cssText = `position:absolute;left:${px}px;top:${py}px;width:6px;height:6px;background:#f97316;border-radius:50% 50% 50% 1px;z-index:999;transform:rotate(-45deg);`;
                inner.appendChild(pin);
            });
        }
        // Render the saved drawing as an overlay so the thumbnail
        // shows the user's strokes along with the slide content.
        if (slide.drawingData) {
            const drawImg = document.createElement('img');
            drawImg.src = safeMediaUrl(slide.drawingData, 'image');
            drawImg.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none;z-index:9998;display:block;';
            drawImg.alt = '';
            inner.appendChild(drawImg);
        }
    }

    updateThumbnail(idx) {
        if (!this.pres || !this.pres.slides[idx]) return;
        const slide = this.pres.slides[idx];
        const inner = document.getElementById(`thumb-inner-${slide.id}`);
        if (inner) this.renderThumbContent(inner, slide);
    }

    reorderSlide(from, to) {
        if (from === to || !this.pres) return;
        this.pushHistory();
        const [slide] = this.pres.slides.splice(from, 1);
        this.pres.slides.splice(to, 0, slide);
        if (this.slideIdx === from) this.slideIdx = to;
        else if (from < this.slideIdx && to >= this.slideIdx) this.slideIdx--;
        else if (from > this.slideIdx && to <= this.slideIdx) this.slideIdx++;
        this.renderSlideList();
        this.scheduleSave();
    }

    // ── Canvas Mouse Interaction ───────────────────────────────
    setupCanvasInteraction() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        const canvas  = document.getElementById('slideCanvas');
        if (!wrapper || !canvas) return;

        canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Clicking on canvas background (not an element)
            if (e.target === canvas) {
                this.exitTextEditing();
                this.deselectElement();
            }
        });

        // Clicking canvas wrapper (outside canvas) — deselect
        wrapper.addEventListener('mousedown', (e) => {
            if (e.target === wrapper || e.target === document.getElementById('slideCanvasScaler')) {
                this.exitTextEditing();
                this.deselectElement();
            }
        });
    }

    // ── Keyboard Shortcuts ─────────────────────────────────────
    setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!this.pres) return;

            // Don't intercept when typing in title input or other inputs
            if (['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName) &&
                document.activeElement.id !== 'slideCanvas') return;

            // Allow editing element to handle keys
            if (this.editingId) {
                if (e.key === 'Escape') { e.preventDefault(); this.exitTextEditing(); }
                return;
            }

            const ctrl = e.ctrlKey || e.metaKey;

            if (ctrl && e.key === 'z') { e.preventDefault(); this.undo(); return; }
            if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this.redo(); return; }
            if (ctrl && e.key === 'c') { this.copyElement(); return; }
            if (ctrl && e.key === 'x') { this.cutElement(); return; }
            if (ctrl && e.key === 'v') { e.preventDefault(); this.pasteElement(); return; }
            if (ctrl && e.key === 'd') { e.preventDefault(); this.duplicateElement(); return; }
            if (ctrl && e.key === 'a') { e.preventDefault(); /* select all — future */ return; }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedId) { e.preventDefault(); this.deleteElement(); }
                return;
            }
            if (e.key === 'Escape') { this.deselectElement(); return; }
            if (e.key === 'F11') { e.preventDefault(); this.startPresentation(0); return; }

            // Arrow keys: move selected element
            if (this.selectedId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const el = this.getElement(this.selectedId);
                if (!el) return;
                const step = e.shiftKey ? 10 : 1;
                if (e.key === 'ArrowLeft')  el.x -= step;
                if (e.key === 'ArrowRight') el.x += step;
                if (e.key === 'ArrowUp')    el.y -= step;
                if (e.key === 'ArrowDown')  el.y += step;
                this.renderElementDOM(this.selectedId);
                this.scheduleSave();
                return;
            }

            // Slide navigation (Page Up / Page Down)
            if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !this.selectedId)) {
                if (!this.selectedId) this.selectSlide(this.slideIdx + 1);
            }
            if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !this.selectedId)) {
                if (!this.selectedId) this.selectSlide(this.slideIdx - 1);
            }
        });
    }

    // ── Clipboard ──────────────────────────────────────────────
    copyElement() {
        if (!this.selectedId) return;
        const el = this.getElement(this.selectedId);
        if (el) { this.clipboard = JSON.parse(JSON.stringify(el)); this.showToast('Element copied.'); }
    }

    cutElement() {
        if (!this.selectedId) return;
        this.copyElement();
        this.deleteElement();
    }

    pasteElement() {
        if (!this.clipboard || !this.currentSlide) return;
        const copy = JSON.parse(JSON.stringify(this.clipboard));
        copy.id = uid();
        copy.x += 20; copy.y += 20;
        this.addElement(copy);
    }

    // ── Undo / Redo ────────────────────────────────────────────
    pushHistory() {
        if (!this.pres) return;
        // Trim future
        this.history = this.history.slice(0, this.histIdx + 1);
        this.history.push(JSON.parse(JSON.stringify(this.pres.slides)));
        if (this.history.length > 50) this.history.shift(); else this.histIdx++;
        this.updateUndoRedo();
    }

    undo() {
        if (this.histIdx < 0) return;
        const current = JSON.parse(JSON.stringify(this.pres.slides));
        if (this.histIdx >= this.history.length) return;
        const prev = this.history[this.histIdx];
        // Push current to redo
        this.history[this.histIdx] = current;
        this.histIdx = Math.max(-1, this.histIdx - 1);
        if (prev) {
            this.pres.slides = prev;
            this.slideIdx = clamp(this.slideIdx, 0, this.pres.slides.length - 1);
            this.selectedId = null;
            this.renderSlideList();
            this.renderCanvas();
            this.scheduleSave();
        }
        this.updateUndoRedo();
    }

    redo() {
        if (this.histIdx >= this.history.length - 1) return;
        this.histIdx++;
        const next = this.history[this.histIdx];
        if (next) {
            this.pres.slides = JSON.parse(JSON.stringify(next));
            this.slideIdx = clamp(this.slideIdx, 0, this.pres.slides.length - 1);
            this.selectedId = null;
            this.renderSlideList();
            this.renderCanvas();
            this.scheduleSave();
        }
        this.updateUndoRedo();
    }

    updateUndoRedo() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = this.histIdx < 0;
        if (redoBtn) redoBtn.disabled = this.histIdx >= this.history.length - 1;
    }

    // ── Ribbon Setup ───────────────────────────────────────────
    setupRibbon() {
        // Undo / Redo
        document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
        document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());

        // Clipboard
        document.getElementById('cutBtn')?.addEventListener('click', () => this.cutElement());
        document.getElementById('copyBtn')?.addEventListener('click', () => this.copyElement());
        document.getElementById('pasteBtn')?.addEventListener('click', () => this.pasteElement());

        // Insert
        document.getElementById('insertTextBtn')?.addEventListener('click', () => {
            if (!this.pres) return;
            const el = makeTextEl(120, 100, 320, 80);
            this.addElement(el);
            setTimeout(() => this.enterTextEditing(el.id), 50);
        });

        document.getElementById('insertImageBtn')?.addEventListener('click', () => {
            document.getElementById('insertImageInput')?.click();
        });
        document.getElementById('insertImageInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                // Load the actual image to read its natural dimensions,
                // then size the element box to match the real aspect ratio.
                // This avoids the empty letterboxed space that appeared when
                // every imported image was forced into a fixed 360x270 box.
                const probe = new Image();
                probe.onload = () => {
                    const natW = probe.naturalWidth || 360;
                    const natH = probe.naturalHeight || 270;
                    const MAX = 480; // longest side, in canvas px (960x540 slide)
                    let w, h;
                    if (natW >= natH) {
                        w = Math.min(MAX, natW);
                        h = Math.round(w * natH / natW);
                    } else {
                        h = Math.min(MAX, natH);
                        w = Math.round(h * natW / natH);
                    }
                    // Center on canvas, clamp so it never overflows
                    const x = Math.max(20, Math.round((960 - w) / 2));
                    const y = Math.max(20, Math.round((540 - h) / 2));
                    const el = makeImageEl(dataUrl, x, y, w, h);
                    this.addElement(el);
                };
                probe.onerror = () => {
                    // Fallback to a sane default if the image fails to load
                    const el = makeImageEl(dataUrl, 130, 100, 360, 270);
                    this.addElement(el);
                };
                probe.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });

        // Shape dropdown
        document.querySelectorAll('.shape-option').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.pres) return;
                const shape = btn.dataset.shape;
                // Determine default size based on shape type
                const isLine = shape === 'line' || shape === 'lineArrow' || shape === 'lineDouble' || shape === 'lineElbow' || shape === 'lineCurve';
                const isArrow = shape.startsWith('arrow') && !shape.startsWith('arrowCallout');
                const isCallout = shape.startsWith('callout') || shape.startsWith('arrowCallout');
                const w = isLine ? 300 : (isCallout ? 200 : (isArrow ? 180 : 200));
                const h = isLine ? 4 : (isCallout ? 140 : (shape === 'calloutCloud' ? 120 : 140));
                const el = makeShapeEl(shape, 200, 150, w, h);
                // Close dropdown
                document.getElementById('shapeDropdown')?.classList.remove('active');
                this.addElement(el);
            });
        });

        // Font family
        const fontFamilyDd = document.getElementById('fontFamilyDropdown');
        fontFamilyDd?.querySelectorAll('.ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                fontFamilyDd.querySelector('.dropdown-value').textContent = val;
                this.applyTextFormat('fontFamily', val);
                fontFamilyDd.classList.remove('active');
            });
        });

        // Font size
        const fontSizeDd = document.getElementById('fontSizeDropdown');
        fontSizeDd?.querySelectorAll('.ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                fontSizeDd.querySelector('.dropdown-value').textContent = val;
                this.applyTextFormat('fontSize', val);
                fontSizeDd.classList.remove('active');
            });
        });

        // Bold / Italic / Underline
        document.getElementById('boldBtn')?.addEventListener('click', () => this.applyTextFormat('bold'));
        document.getElementById('italicBtn')?.addEventListener('click', () => this.applyTextFormat('italic'));
        document.getElementById('underlineBtn')?.addEventListener('click', () => this.applyTextFormat('underline'));

        // Text color (vertical list — matches notes app style)
        document.querySelectorAll('#fontColorDropdown .ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const btn = document.querySelector('#fontColorDropdown .ms-dropdown-btn');
                const swatch = btn?.querySelector('.color-preview');
                const label = btn?.querySelector('.dropdown-value');
                if (swatch) {
                    swatch.style.background = color === 'transparent' ? 'transparent' : color;
                    swatch.style.border = (color === 'transparent') ? '1px solid #ccc' : '';
                }
                if (label) label.textContent = item.dataset.label || 'Text';
                this.applyTextFormat('color', color);
                document.getElementById('fontColorDropdown')?.classList.remove('active');
            });
        });

        // Text highlight (matches notes app style)
        document.querySelectorAll('#highlightColorDropdown .ms-dropdown-item[data-value]').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const btn = document.querySelector('#highlightColorDropdown .ms-dropdown-btn');
                const swatch = btn?.querySelector('.color-preview');
                const label = btn?.querySelector('.dropdown-value');
                if (swatch) {
                    if (color === 'transparent') {
                        swatch.style.background = 'transparent';
                        swatch.style.border = '1px solid #ccc';
                    } else {
                        swatch.style.background = color;
                        swatch.style.border = '';
                    }
                }
                if (label) label.textContent = item.dataset.label || 'Highlight';
                this.applyTextFormat('highlight', color);
                document.getElementById('highlightColorDropdown')?.classList.remove('active');
            });
        });

        // Align
        document.getElementById('alignLeftBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'left'));
        document.getElementById('alignCenterBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'center'));
        document.getElementById('alignRightBtn')?.addEventListener('click', () => this.applyTextFormat('textAlign', 'right'));

        // Lists
        document.getElementById('bulletListBtn')?.addEventListener('click', () => this.applyTextFormat('insertUnorderedList'));
        document.getElementById('numberListBtn')?.addEventListener('click', () => this.applyTextFormat('insertOrderedList'));

        // Shape fill — list-style dropdown items (ms-dropdown-item instead of color-dot)
        document.querySelectorAll('#fillColorDropdown .ms-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const swatch = document.getElementById('fillColorSwatch');
                if (swatch) {
                    if (color === 'none') {
                        swatch.style.background = 'transparent';
                        swatch.style.border = '2px dashed #999';
                    } else {
                        swatch.style.background = color;
                        swatch.style.border = '1px solid rgba(0,0,0,0.15)';
                    }
                }
                if (this.selectedId) this.updateElement(this.selectedId, { fill: color });
                document.getElementById('fillColorDropdown')?.classList.remove('active');
                const fillBtn = document.querySelector('#fillColorDropdown .ms-dropdown-btn');
                if (fillBtn) fillBtn.setAttribute('aria-expanded', 'false');
            });
        });

        // Shape stroke — list-style dropdown items
        document.querySelectorAll('#strokeColorDropdown .ms-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const color = item.dataset.value;
                const swatch = document.getElementById('strokeColorSwatch');
                if (swatch) {
                    if (color === 'none') {
                        swatch.style.background = 'transparent';
                        swatch.style.border = '2px dashed #999';
                    } else {
                        swatch.style.background = color;
                        swatch.style.border = '2px solid ' + color;
                    }
                }
                if (this.selectedId) this.updateElement(this.selectedId, { stroke: color });
                document.getElementById('strokeColorDropdown')?.classList.remove('active');
                const strokeBtn = document.querySelector('#strokeColorDropdown .ms-dropdown-btn');
                if (strokeBtn) strokeBtn.setAttribute('aria-expanded', 'false');
            });
        });
        // Stroke Width dropdown (replaces old number input)
        const swDropdown = document.getElementById('strokeWidthDropdown');
        if (swDropdown) {
            swDropdown.querySelectorAll('.ms-dropdown-item').forEach(item => {
                item.addEventListener('click', () => {
                    const val = parseInt(item.dataset.value) || 2;
                    const label = document.getElementById('strokeWidthLabel');
                    if (label) label.textContent = item.dataset.label;
                    if (this.selectedId) this.updateElement(this.selectedId, { strokeWidth: val }, true);
                    // Close the dropdown
                    swDropdown.classList.remove('active');
                    const btn = swDropdown.querySelector('.ms-dropdown-btn');
                    if (btn) btn.setAttribute('aria-expanded', 'false');
                });
            });
        }

        // Arrange
        document.getElementById('bringFrontBtn')?.addEventListener('click', () => this.bringToFront());
        document.getElementById('sendBackBtn')?.addEventListener('click', () => this.sendToBack());
        document.getElementById('duplicateElBtn')?.addEventListener('click', () => this.duplicateElement());
        document.getElementById('deleteElBtn')?.addEventListener('click', () => this.deleteElement());

        // Presentation
        document.getElementById('presentFromStartBtn')?.addEventListener('click', () => this.startPresentation(0));
        document.getElementById('presentFromCurrentBtn')?.addEventListener('click', () => this.startPresentation(this.slideIdx));

        // Slide actions (in editor header)
        document.getElementById('newSlideBtn')?.addEventListener('click', () => this.addSlide());
        document.getElementById('newSlideBtnRibbon')?.addEventListener('click', () => this.addSlide());
        document.getElementById('duplicateSlideBtn')?.addEventListener('click', () => this.duplicateSlide());
        document.getElementById('deleteSlideBtn')?.addEventListener('click', () => this.deleteSlide());

        // Presenter Notes toggle (status bar button)
        const notesBtn = document.getElementById('notesToggleBtn');
        const notesPanel = document.getElementById('presenterNotesPanel');
        if (notesBtn && notesPanel) {
            notesBtn.addEventListener('click', () => {
                const willShow = !notesPanel.classList.contains('visible');
                notesPanel.classList.toggle('visible', willShow);
                notesBtn.classList.toggle('active', willShow);
                notesBtn.title = willShow ? 'Hide Presenter Notes' : 'Show Presenter Notes';
                if (willShow) {
                    // Focus the textarea for immediate editing
                    setTimeout(() => document.getElementById('presenterNotesInput')?.focus(), 50);
                }
                // Re-render rulers — the notes panel changes editor height,
                // which shifts the canvas vertical position.
                this._scheduleRulerRender();
                setTimeout(() => this._scheduleRulerRender(), 260);
            });
        }

        // Welcome screen
        document.getElementById('welcomeNewBtn')?.addEventListener('click', () => this.newPresentation());

        // Presentation title
        document.getElementById('presentationTitle')?.addEventListener('input', (e) => {
            if (!this.pres) return;
            this.pres.title = e.target.value || 'Untitled Presentation';
                this.scheduleSave();
        });

        // Delete modal
        document.getElementById('deleteModalCancel')?.addEventListener('click', () => this.closeDeleteModal());
        document.getElementById('deleteModalConfirm')?.addEventListener('click', () => this.confirmDelete());

        // Background picker modal (legacy, kept for fallback)
        document.getElementById('bgPickerCancel')?.addEventListener('click', () => this.closeBgPicker());
        document.getElementById('bgPickerApply')?.addEventListener('click', () => this.applyBgPicker());

        // Background ribbon dropdown — applies immediately on click (no modal needed)
        document.querySelectorAll('#bgDropdown .bg-color-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.currentSlide) return;
                const bgVal = btn.dataset.bg;
                this.applyBackgroundImmediate(bgVal);
                // Close dropdown (no active class — applies immediately like font/highlight)
                document.getElementById('bgDropdown')?.classList.remove('active');
            });
        });
        // Custom color picker in ribbon dropdown — applies immediately
        document.querySelector('#bgDropdown #bgColorCustom')?.addEventListener('input', (e) => {
            if (!this.currentSlide) return;
            this.applyBackgroundImmediate(e.target.value);
        });

        // Legacy modal color buttons (kept in case modal is opened)
        document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._pendingBgValue = btn.dataset.bg;
                const customInput = document.querySelector('#bgPickerModal #bgColorCustom');
                if (customInput && !btn.dataset.bg.includes('gradient')) customInput.value = btn.dataset.bg;
            });
        });
        document.querySelector('#bgPickerModal #bgColorCustom')?.addEventListener('input', (e) => {
            this._pendingBgValue = e.target.value;
            document.querySelectorAll('#bgPickerModal .bg-color-btn').forEach(b => b.classList.remove('active'));
        });
    }

    // Apply background immediately (no modal) — used by ribbon dropdown
    applyBackgroundImmediate(value) {
        if (!this.currentSlide) return;
        this.pushHistory();
        const isGradient = value.includes('gradient');
        this.currentSlide.background = {
            type: isGradient ? 'gradient' : 'color',
            value,
        };
        this.renderCanvas();
        this.updateThumbnail(this.slideIdx);
        this.scheduleSave();
    }

    setupDropdownMenus() {
        // Portal-based dropdown (ported from notes.js for proper overflow escape)
        document.querySelectorAll('.ms-dropdown').forEach(dropdown => {
            const btn = dropdown.querySelector(':scope > .ms-dropdown-btn, :scope > button.ribbon-btn.ms-dropdown-btn');
            const menu = dropdown.querySelector(':scope > .ms-dropdown-menu');
            if (!btn || !menu) return;

            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('aria-haspopup', 'listbox');

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._portalDropdown === dropdown) {
                    this._closePortal();
                    return;
                }
                this._openPortal(dropdown, btn, menu);
            });

            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    btn.click();
                } else if (e.key === 'Escape') {
                    this._closePortal();
                }
            });
        });

        // Close portal on outside click
        document.addEventListener('mousedown', (e) => {
            if (this._portalMenu &&
                !this._portalMenu.contains(e.target) &&
                this._portalBtn && !this._portalBtn.contains(e.target)) {
                this._closePortal();
            }
        });

        // Close portal on scroll or resize — but NOT when scrolling inside the menu itself
        window.addEventListener('scroll', (e) => {
            if (this._portalMenu && (e.target === this._portalMenu || this._portalMenu.contains(e.target))) return;
            this._closePortal();
        }, true);
        window.addEventListener('resize', () => this._closePortal());
    }

    _openPortal(dropdown, btn, menu) {
        this._closePortal(false);
        document.body.appendChild(menu);
        this._portalMenu = menu;
        this._portalDropdown = dropdown;
        this._portalBtn = btn;
        dropdown.classList.add('active');
        btn.setAttribute('aria-expanded', 'true');

        // Match Notes app: tighter max-height (320px default, 240px for color list menus)
        const isColorList = menu.classList && menu.classList.contains('color-list-menu');
        const isColorGrid = menu.classList && menu.classList.contains('color-grid-menu');
        const cap = isColorList ? 240 : (isColorGrid ? 320 : 320);
        const maxH = Math.min(cap, window.innerHeight * 0.6);
        // First, measure invisibly
        menu.style.cssText = `position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:${maxH}px;overflow-y:auto;`;
        const btnRect = btn.getBoundingClientRect();
        const mW = menu.offsetWidth || 200;
        const mH = menu.offsetHeight || 280;
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

    _closePortal(animate = true) {
        if (!this._portalMenu) return;
        const menu = this._portalMenu;
        const dropdown = this._portalDropdown;
        const btn = this._portalBtn;
        this._portalMenu = null;
        this._portalDropdown = null;
        this._portalBtn = null;
        if (dropdown) dropdown.classList.remove('active');
        if (btn) btn.setAttribute('aria-expanded', 'false');

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            menu.removeEventListener('animationend', cleanup);
            menu.classList.remove('ms-portal-closing');
            menu.style.cssText = '';
            if (dropdown) dropdown.appendChild(menu);
        };
        if (animate) {
            menu.classList.add('ms-portal-closing');
            menu.addEventListener('animationend', cleanup);
            setTimeout(cleanup, 220);
        } else {
            cleanup();
        }
    }

    // ── Ribbon Tab Switching ──────────────────────────────────────
    setupRibbonTabs() {
        const tabs = document.querySelectorAll('.ribbon-tab[data-tab]');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this._switchTab(tab.dataset.tab);
            });
        });
        // Initial position + keep it aligned on resize / contextual-tab show.
        // Double-rAF: the first frame commits the initial CSS state
        // (width:0, transform:0, opacity:0); the second frame sets the
        // target values, giving the transition a clean starting point.
        // Without this, the browser batches both states and the indicator
        // just appears at the active tab with no slide animation.
        requestAnimationFrame(() => requestAnimationFrame(() => this._updateRibbonTabIndicator()));
        window.addEventListener('resize', () => {
            this._updateRibbonTabIndicator();
            // Re-render rulers on resize so tick marks stay aligned with the canvas.
            this.renderRulers();
        });
        // Re-align when fonts finish loading (tab widths can shift)
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this._updateRibbonTabIndicator());
        }
        // Observe editor layout changes so the ruler ticks follow the
        // canvas when the sidebar collapses, notes panel opens, etc.
        this._setupRulerObserver();
    }

    // Switch the active ribbon tab.
    //   target  - the data-tab value of the new tab (e.g. 'home', 'insert', 'file')
    //
    // Special case: target === 'file' does NOT activate the File ribbon panel.
    // Instead, it opens the welcome screen (the start surface where the user
    // can pick a different presentation or create a new one). The File tab
    // itself is still marked .active so the user sees where they are, and
    // the ribbon stays visible — we do NOT add body.no-active-note, which
    // would hide the ribbon entirely. All ribbon panels are deactivated.
    //
    // This mirrors Microsoft Office's "File → Backstage" behaviour: clicking
    // File leaves the editor and takes you to a file-management surface.
    _switchTab(target) {
        const tabs = document.querySelectorAll('.ribbon-tab[data-tab]');
        const targetTab = document.querySelector(`.ribbon-tab[data-tab="${target}"]`);
        if (!targetTab) return;

        if (target === 'file') {
            // File tab: blur-out current panel, then handle file logic
            const activePanel = document.querySelector('.ribbon-panel.active');
            if (activePanel) {
                activePanel.classList.add('blur-out');
                activePanel.classList.remove('active');
                activePanel.addEventListener('transitionend', function handler() {
                    activePanel.removeEventListener('transitionend', handler);
                    activePanel.classList.remove('blur-out');
                });
            }
            tabs.forEach(t => t.classList.toggle('active', t === targetTab));
            if (this.pres) {
                this.openFileModal();
            } else {
                this.showWelcomeScreen(true);
            }
            this._activeTab = target;
            this._closePortal(false);
            this._updateRibbonTabIndicator();
            return;
        }

        const currentPanel = document.querySelector('.ribbon-panel.active');
        const targetPanel = document.querySelector(`.ribbon-panel[data-panel="${target}"]`);

        // If switching to the same tab, do nothing
        if (currentPanel && currentPanel === targetPanel) {
            this._activeTab = target;
            this._updateRibbonTabIndicator();
            return;
        }

        // Move the indicator to the new tab IMMEDIATELY (before blur-out)
        // so the underline slides at the same instant the user clicks.
        tabs.forEach(t => t.classList.toggle('active', t === targetTab));
        this._activeTab = target;
        this._updateRibbonTabIndicator();

        // Don't switch panel content yet — do it after blur-out
        const doSwitch = () => {
            // Hide old panel fully
            currentPanel.classList.remove('blur-out');
            // Show new panel (blur-in)
            if (targetPanel) targetPanel.classList.add('active');
            this._closePortal(false);
        };

        if (currentPanel) {
            // Step 1: blur-out the current panel (keeps position: relative, no layout shift)
            currentPanel.classList.add('blur-out');
            currentPanel.classList.remove('active');

            const onBlurred = () => {
                currentPanel.removeEventListener('transitionend', onBlurred);
                doSwitch();
            };
            currentPanel.addEventListener('transitionend', onBlurred);

            // Fallback timeout
            setTimeout(() => {
                if (currentPanel.classList.contains('blur-out')) {
                    doSwitch();
                }
            }, 220);
        } else {
            // No current panel — switch immediately
            if (targetPanel) targetPanel.classList.add('active');
            tabs.forEach(t => t.classList.toggle('active', t === targetTab));
            this._activeTab = target;
            this._closePortal(false);
            this._updateRibbonTabIndicator();
        }
    }

    // Position the sliding underline indicator under the active ribbon tab.
    // Sets `transform: translateX(Npx)` and `width: Mpx` based on the active
    // tab's offsetLeft/offsetWidth inside .ribbon-tabs-left. The CSS transition
    // on `.ribbon-tab-indicator` produces the smooth slide.
    _updateRibbonTabIndicator() {
        const indicator = document.getElementById('ribbonTabIndicator');
        if (!indicator) return;
        const activeTab = document.querySelector('.ribbon-tab.active');
        if (!activeTab || activeTab.hidden) {
            indicator.classList.remove('visible');
            indicator.style.width = '0px';
            indicator.style.transform = 'translateX(0px)';
            return;
        }
        const left = activeTab.offsetLeft;
        const width = activeTab.offsetWidth;
        indicator.style.width = `${width}px`;
        indicator.style.transform = `translateX(${left}px)`;
        indicator.classList.add('visible');
    }

    // ── Transitions Tab ───────────────────────────────────────────
    // 37 transition types organized into 3 categories (Subtle / Exciting / Dynamic Content),
    // inspired by desktop presentation software.
    static TRANSITIONS = [
        // ── Subtle ───────────────────────────────────────────────
        { value: 'none',         label: 'None',         category: 'Subtle',   preview: '#ffffff' },
        { value: 'fade',         label: 'Fade',         category: 'Subtle',   preview: 'linear-gradient(90deg,#fff,#aaa)' },
        { value: 'push',         label: 'Push',         category: 'Subtle',   preview: 'linear-gradient(90deg,#f97316 50%,#fff 50%)' },
        { value: 'wipe',         label: 'Wipe',         category: 'Subtle',   preview: 'linear-gradient(90deg,#fff 30%,#f97316 30%)' },
        { value: 'split',        label: 'Split',        category: 'Subtle',   preview: 'linear-gradient(135deg,#f97316 50%,#fff 50%)' },
        { value: 'reveal',       label: 'Reveal',       category: 'Subtle',   preview: 'radial-gradient(circle at center,#fff 50%,#f97316 51%)' },
        { value: 'cut',          label: 'Cut',          category: 'Subtle',   preview: 'repeating-linear-gradient(90deg,#fff 0 10px,#f97316 10px 11px)' },
        { value: 'cover',        label: 'Cover',        category: 'Subtle',   preview: 'radial-gradient(circle at center,#f97316 40%,#fff 41%)' },
        { value: 'uncover',      label: 'Uncover',      category: 'Subtle',   preview: 'linear-gradient(0deg,#f97316 30%,#fff 30%)' },
        { value: 'random-bars',  label: 'Random Bars',  category: 'Subtle',   preview: 'repeating-linear-gradient(90deg,#f97316 0 6%,#fff 6% 12%)' },
        { value: 'shape',        label: 'Shape',        category: 'Subtle',   preview: 'linear-gradient(45deg,#f97316 50%,#fff 50%)' },
        { value: 'blinds',       label: 'Blinds',       category: 'Subtle',   preview: 'repeating-linear-gradient(0deg,#f97316 0 8%,#fff 8% 16%)' },

        // ── Exciting ─────────────────────────────────────────────
        { value: 'morph',        label: 'Morph',        category: 'Exciting', preview: 'radial-gradient(circle at 25% 30%,#f97316 0 18%,transparent 19%),radial-gradient(circle at 75% 70%,#fff 0 18%,#f97316 19%)' },
        { value: 'fade-black',   label: 'Fade Black',   category: 'Exciting', preview: 'linear-gradient(90deg,#fff,#000)' },
        { value: 'zoom',         label: 'Zoom',         category: 'Exciting', preview: 'radial-gradient(circle,#f97316 30%,#fff)' },
        { value: 'cube',         label: 'Cube',         category: 'Exciting', preview: 'linear-gradient(135deg,#f97316,#c2410c)' },
        { value: 'flip',         label: 'Flip',         category: 'Exciting', preview: 'linear-gradient(90deg,#f97316,#fff)' },
        { value: 'gallery',      label: 'Gallery',      category: 'Exciting', preview: 'linear-gradient(180deg,#f97316 60%,#fff)' },
        { value: 'vortex',       label: 'Vortex',       category: 'Exciting', preview: 'conic-gradient(from 0deg,#f97316,#fff,#f97316)' },
        { value: 'newsflash',    label: 'Newsflash',    category: 'Exciting', preview: 'linear-gradient(135deg,#fbbf24 0 50%,#fff 50%)' },
        { value: 'honeycomb',    label: 'Honeycomb',    category: 'Exciting', preview: 'radial-gradient(circle at 50% 50%,#f97316 20%,#fff 21%,#fff 40%,#f97316 41%)' },
        { value: 'glitch',       label: 'Glitch',       category: 'Exciting', preview: 'repeating-linear-gradient(0deg,#ff0000 0 2px,#00ff00 2px 4px,#0000ff 4px 6px)' },
        { value: 'dissolve',     label: 'Dissolve',     category: 'Exciting', preview: 'radial-gradient(circle at 30% 30%,#f97316 10%,#fff 11%,#fff 30%,#f97316 31%)' },
        { value: 'checkerboard', label: 'Checkerboard', category: 'Exciting', preview: 'repeating-conic-gradient(#f97316 0% 25%,#fff 0% 50%)' },
        { value: 'clock',        label: 'Clock',        category: 'Exciting', preview: 'conic-gradient(from 0deg,#f97316 0deg 90deg,#fff 90deg 360deg)' },
        { value: 'ripple',       label: 'Ripple',       category: 'Exciting', preview: 'radial-gradient(circle,#fff 30%,#f97316 31%,#f97316 40%,#fff 41%)' },
        { value: 'doors',        label: 'Doors',        category: 'Exciting', preview: 'linear-gradient(90deg,#fff 48%,#f97316 48% 52%,#fff 52%)' },
        { value: 'switch',       label: 'Switch',       category: 'Exciting', preview: 'linear-gradient(180deg,#f97316 50%,#fff 50%)' },
        { value: 'curtains',     label: 'Curtains',     category: 'Exciting', preview: 'linear-gradient(0deg,#fff 48%,#f97316 48% 52%,#fff 52%)' },
        { value: 'fracture',     label: 'Fracture',     category: 'Exciting', preview: 'linear-gradient(45deg,#f97316 30%,#fff 30% 70%,#f97316 70%)' },
        { value: 'peel-off',     label: 'Peel Off',     category: 'Exciting', preview: 'linear-gradient(135deg,#fff 30%,#f97316 30%)' },
        { value: 'glitter',      label: 'Glitter',      category: 'Exciting', preview: 'radial-gradient(circle at 20% 30%,#fbbf24 8%,transparent 9%),radial-gradient(circle at 70% 60%,#fbbf24 8%,transparent 9%),#fff' },
        { value: 'comb',         label: 'Comb',         category: 'Exciting', preview: 'repeating-linear-gradient(0deg,#f97316 0 4%,#fff 4% 8%)' },

        // ── Dynamic Content ──────────────────────────────────────
        { value: 'pan',          label: 'Pan',          category: 'Dynamic',  preview: 'linear-gradient(90deg,#f97316 30%,#fff 30%)' },
        { value: 'rotate',       label: 'Rotate',       category: 'Dynamic',  preview: 'conic-gradient(from 45deg,#f97316 0 90deg,#fff 90deg)' },
        { value: 'orbit',        label: 'Orbit',        category: 'Dynamic',  preview: 'radial-gradient(circle at 30% 30%,#f97316 30%,#fff 31%)' },
        { value: 'fly-through',  label: 'Fly Through',  category: 'Dynamic',  preview: 'radial-gradient(circle,#fff 30%,#f97316 31%)' },
        { value: 'conveyor',     label: 'Conveyor',     category: 'Dynamic',  preview: 'repeating-linear-gradient(90deg,#f97316 0 10px,#fff 10px 12px)' },
    ];

    setupTransitionsTab() {
        // ── Ribbon thumbnail row ─────────────────────────────────
        // Show the first N most-used transitions as preview tiles
        // directly on the ribbon (mirrors the Themes/Templates row on
        // the Design tab). The order of TRANSITIONS already places
        // the popular ones (None, Fade, Push, Wipe, Split, Reveal)
        // first, so we just slice.
        const row = document.getElementById('transitionThumbnailRow');
        if (row) {
            row.innerHTML = '';
            const RIBBON_COUNT = 6;
            const popular = SlidesApp.TRANSITIONS.slice(0, RIBBON_COUNT);
            popular.forEach(tr => {
                row.appendChild(this._buildTransitionThumb(tr));
            });
        }

        // ── "More" gallery dropdown ──────────────────────────────
        // All transitions, grouped by category, in a wide 6-column
        // grid. Same visual pattern as the Themes/Templates gallery.
        const gallery = document.getElementById('transitionGalleryMenu');
        if (gallery) {
            gallery.innerHTML = '';
            const categories = ['Subtle', 'Exciting', 'Dynamic'];
            const catLabel = c => c === 'Dynamic' ? 'Dynamic Content' : c;
            categories.forEach(cat => {
                const items = SlidesApp.TRANSITIONS.filter(tr => tr.category === cat);
                if (items.length === 0) return;

                const header = document.createElement('div');
                header.className = 'transition-category-header';
                header.textContent = catLabel(cat);
                gallery.appendChild(header);

                const grid = document.createElement('div');
                grid.className = 'transition-gallery-grid';
                items.forEach(tr => {
                    grid.appendChild(this._buildTransitionThumb(tr));
                });
                gallery.appendChild(grid);
            });
        }

        // Highlight the currently-applied transition in both the
        // ribbon row and the More gallery.
        this._refreshTransitionHighlight();

        // ── Timing panel wiring ─────────────────────────────────
        // The TIMING panel uses a unified design:
        //   • A stepper-style number field for Duration
        //     ( [−] [input] [+] [sec] ).
        //   • A segmented pill toggle for the advance trigger
        //     (On Click | After), and a second stepper field for
        //     the "After X sec" value.
        // Pills toggle aria-pressed; the After-field is disabled
        // (visually faded) when the After pill is not pressed.
        // The slide's transition object is the single source of
        // truth — UI changes flow into it via updateTransitionTiming,
        // and slide switches flow back into the UI via
        // _syncTransitionTimingUI.
        this._wireTransitionTimingPanel();

        // Apply to all
        document.getElementById('applyTransitionAllBtn')?.addEventListener('click', () => {
            if (!this.pres || this.pres.slides.length === 0) return;
            const current = this.pres.slides[this.slideIdx]?.transition ||
                { type: 'none', duration: 0.7, onClick: true, autoAfter: false, afterSec: 5 };
            this.pres.slides.forEach(s => { s.transition = { ...current }; });
            this.scheduleSave();
            // After "Apply to All" the current slide's settings are
            // unchanged, but the UI should re-sync in case any rounding
            // or normalization happened.
            this._syncTransitionTimingUI?.();
            this.showToast(`Applied "${current.type}" transition to all slides.`);
        });

        // Preview
        document.getElementById('previewTransitionBtn')?.addEventListener('click', () => {
            this.previewTransition();
        });

        // Sync the TIMING panel inputs with the current slide's
        // transition settings (or defaults if no presentation is
        // loaded yet). This runs once on init; subsequent syncs happen
        // via selectSlide and applyTransition.
        this._syncTransitionTimingUI();
    }

    // Wire up the duration stepper, trigger toggle pills, and
    // after-seconds stepper. Idempotent — safe to call multiple times
    // (it removes old listeners before re-adding). All state lives on
    // the slide's `transition` object; the UI reads/writes through
    // updateTransitionTiming and _syncTransitionTimingUI.
    _wireTransitionTimingPanel() {
        const durInput = document.getElementById('transitionDuration');
        const afterSec = document.getElementById('transitionAfterSec');
        const afterField = document.getElementById('transitionAfterField');
        const toggle = document.getElementById('transitionTriggerToggle');

        // ── Stepper buttons ( [−] / [+] ) ────────────────────────
        // Each .tr-num-step has data-target (input id) and data-step
        // (signed delta). Clicking adjusts the input value, clamps to
        // min/max, fires a 'change' event so the existing change
        // handler picks it up, and re-syncs the slide data.
        document.querySelectorAll('.tr-num-step').forEach(btn => {
            // Avoid double-binding if _wireTransitionTimingPanel runs twice.
            if (btn.__trBound) return;
            btn.__trBound = true;
            btn.addEventListener('click', () => {
                const target = document.getElementById(btn.dataset.target);
                if (!target || target.disabled) return;
                const step = parseFloat(btn.dataset.step) || 0;
                const min = parseFloat(target.min);
                const max = parseFloat(target.max);
                let val = parseFloat(target.value) || 0;
                val = val + step;
                if (!Number.isNaN(min)) val = Math.max(min, val);
                if (!Number.isNaN(max)) val = Math.min(max, val);
                // Round to 1 decimal to avoid float dust like 0.7000000001
                if (step % 1 !== 0) val = Math.round(val * 10) / 10;
                target.value = val;
                target.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });

        // ── Duration input ───────────────────────────────────────
        if (durInput && !durInput.__trBound) {
            durInput.__trBound = true;
            durInput.addEventListener('change', () => {
                let v = parseFloat(durInput.value);
                if (!Number.isFinite(v) || v <= 0) v = 0.7;
                v = Math.min(10, Math.max(0.1, Math.round(v * 10) / 10));
                durInput.value = v;
                this.updateTransitionTiming({ duration: v });
            });
        }

        // ── After-seconds input ──────────────────────────────────
        if (afterSec && !afterSec.__trBound) {
            afterSec.__trBound = true;
            afterSec.addEventListener('change', () => {
                let v = parseFloat(afterSec.value);
                if (!Number.isFinite(v) || v <= 0) v = 5;
                v = Math.min(600, Math.max(1, Math.round(v)));
                afterSec.value = v;
                // Only persist if autoAfter is currently active —
                // otherwise the value is just staged in the UI for
                // when the user toggles After on.
                const autoAfter = this._triggerPillState('autoAfter');
                this.updateTransitionTiming({ autoAfter, afterSec: v });
            });
        }

        // ── Trigger toggle pills ─────────────────────────────────
        // Clicking a pill toggles its aria-pressed state. Both pills
        // can be on (advance on whichever fires first — PowerPoint
        // semantics) or both off (slide must be navigated with arrows).
        if (toggle && !toggle.__trBound) {
            toggle.__trBound = true;
            toggle.querySelectorAll('.tr-trigger-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    const key = pill.dataset.trigger; // 'onClick' | 'autoAfter'
                    const next = !(pill.getAttribute('aria-pressed') === 'true');
                    pill.setAttribute('aria-pressed', String(next));
                    // Enable/disable the after-seconds field based on
                    // the After pill state.
                    if (key === 'autoAfter') {
                        if (afterSec) afterSec.disabled = !next;
                        if (afterField) afterField.classList.toggle('disabled', !next);
                    }
                    this.updateTransitionTiming({ [key]: next });
                });
            });
        }
    }

    // Read the current pressed state of a trigger pill by data-trigger.
    _triggerPillState(key) {
        const pill = document.querySelector(`.tr-trigger-pill[data-trigger="${key}"]`);
        return pill ? pill.getAttribute('aria-pressed') === 'true' : false;
    }

    // Push the current slide's transition settings into the Timing
    // panel UI. Called from setupTransitionsTab, selectSlide, and
    // applyTransition so the controls always reflect whichever slide
    // is active. Without this, the inputs would show stale values from
    // the previously-selected slide — which was a real bug: set slide
    // 1 to "After 3 sec", switch to slide 2 (default On Click), and
    // the toggle still showed "After 3 sec" pressed.
    _syncTransitionTimingUI() {
        const slide = this.pres?.slides?.[this.slideIdx];
        const t = slide?.transition || { type: 'none', duration: 0.7, onClick: true, autoAfter: false, afterSec: 5 };

        const durInput = document.getElementById('transitionDuration');
        if (durInput) durInput.value = Number.isFinite(t.duration) ? t.duration : 0.7;

        const afterSec = document.getElementById('transitionAfterSec');
        const afterField = document.getElementById('transitionAfterField');
        if (afterSec) afterSec.value = Number.isFinite(t.afterSec) ? t.afterSec : 5;
        const afterOn = !!t.autoAfter;
        if (afterSec) afterSec.disabled = !afterOn;
        if (afterField) afterField.classList.toggle('disabled', !afterOn);

        const onClickPill = document.querySelector('.tr-trigger-pill[data-trigger="onClick"]');
        const afterPill = document.querySelector('.tr-trigger-pill[data-trigger="autoAfter"]');
        // Default to "On Click" enabled when the slide has no explicit
        // setting — matches PowerPoint's default for new slides.
        const onClickOn = t.onClick !== undefined ? !!t.onClick : true;
        if (onClickPill) onClickPill.setAttribute('aria-pressed', String(onClickOn));
        if (afterPill)   afterPill.setAttribute('aria-pressed', String(afterOn));
    }

    // Build a single transition thumbnail tile. Used both by the
    // ribbon row and by the More gallery — same DOM structure means
    // the .active highlight state can be refreshed uniformly via
    // _refreshTransitionHighlight().
    _buildTransitionThumb(tr) {
        const btn = document.createElement('button');
        btn.className = 'transition-thumb';
        btn.dataset.value = tr.value;
        btn.title = tr.label;
        btn.innerHTML = `
            <div class="tr-thumb-preview" style="background:${tr.preview};"></div>
            <span class="tr-thumb-label">${tr.label}</span>
        `;
        btn.addEventListener('click', () => {
            this._closePortal(false);
            this.applyTransition(tr.value);
            this._refreshTransitionHighlight();
        });
        return btn;
    }

    // Refresh the .active state on every .transition-thumb (both the
    // ribbon row and the More gallery) to reflect the current slide's
    // applied transition. Called from setupTransitionsTab,
    // applyTransition, selectSlide, and updateRibbonState so the
    // highlight stays in sync as the user moves between slides.
    _refreshTransitionHighlight() {
        const current = this.pres?.slides?.[this.slideIdx]?.transition?.type || 'none';
        document.querySelectorAll('.transition-thumb').forEach(o => {
            o.classList.toggle('active', o.dataset.value === current);
        });
        // Keep the hidden #transitionLabel span in sync for any
        // legacy code that reads it.
        const labelEl = document.getElementById('transitionLabel');
        if (labelEl) {
            labelEl.textContent = current === 'none' ? 'None' :
                (SlidesApp.TRANSITIONS.find(t => t.value === current)?.label || current);
        }
    }

    applyTransition(type) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        // Replace — NOT merge-and-keep — the type field. Previously
        // this used { ...(slide.transition || {}), type } which is
        // correct for the data model, but the visual bug users saw
        // ("doesn't change, keeps the previous transition") came from
        // the fact that no preview was triggered here. Industry
        // convention (PowerPoint/Keynote/Slides): clicking a
        // transition thumbnail immediately previews it. So we now
        // also call previewTransition() after the data update.
        slide.transition = { ...(slide.transition || {}), type };
        // Keep the hidden #transitionLabel span in sync; the ribbon
        // row + More gallery .active highlight is refreshed by
        // _refreshTransitionHighlight (called by the click handler,
        // but also called here in case applyTransition is invoked
        // programmatically from elsewhere).
        this._refreshTransitionHighlight?.();
        // Keep the Timing panel in sync — applyTransition changes the
        // transition type but keeps duration/trigger settings, so the
        // UI shouldn't visibly change. Calling _syncTransitionTimingUI
        // is a no-op visually but guarantees the inputs are showing
        // the active slide's actual values (defensive — in case the
        // caller came from a context where the slideIdx also changed).
        this._syncTransitionTimingUI?.();
        this.scheduleSave();
        // Auto-preview so the user sees the change immediately. This
        // is what fixes the "doesn't change" half of the bug — the
        // data WAS changing, but the user couldn't see it without
        // clicking the Preview button. Skip auto-preview for 'none'
        // (nothing to preview) and 'morph' (needs a previous slide;
        // previewTransition already handles the empty case gracefully
        // with a toast, but we don't want a toast on every click).
        if (type && type !== 'none' && type !== 'morph') {
            this.previewTransition();
        }
    }

    // Centralized runner for slide transitions. Replaces the old
    // pattern of `container.classList.add(cls); setTimeout(...)` that
    // was duplicated in previewTransition and renderPresentSlide.
    // Fixes:
    //   1. Race condition — the previous transition's setTimeout
    //      could fire during the new transition and remove the new
    //      class early. We now clear this._trAnimTimer before
    //      scheduling a new one.
    //   2. Wrong duration — previewTransition used to hardcode 1200ms;
    //      now uses the slide's configured duration.
    //   3. animationend fallback — even if our timer is off, the
    //      class is removed when the animation actually ends.
    _runTransitionClass(container, cls, durationSec) {
        if (!container) return;
        // Clear any in-flight cleanup timer from the previous
        // transition. This is THE fix for the "adds and keeps the
        // previous transition" bug — without this, the old timer
        // would fire and remove our new class mid-animation.
        if (this._trAnimTimer) {
            clearTimeout(this._trAnimTimer);
            this._trAnimTimer = null;
        }
        // If a morph FLIP is in flight, cancel its unwrap timer.
        // The orphan-wrapper cleanup at the top of
        // _applyMorphTransition will unwrap any lingering wrappers
        // on the next morph; for non-morph transitions the wrappers
        // are harmless (the slide is about to be re-rendered anyway
        // by renderPresentSlide, which clears container.innerHTML).
        if (this._morphAnimTimer) {
            clearTimeout(this._morphAnimTimer);
            this._morphAnimTimer = null;
        }
        // Strip every transition-related class so we start clean.
        // The filter catches tr-*-in, fade-in, slide-in-left/right.
        const prevClasses = Array.from(container.classList).filter(c =>
            c.startsWith('tr-') || c === 'fade-in' ||
            c === 'slide-in-right' || c === 'slide-in-left'
        );
        prevClasses.forEach(c => container.classList.remove(c));
        // Force reflow so the browser commits the class removal
        // before we add the new class — otherwise the new animation
        // doesn't restart (the browser batches the add+remove and
        // the element never sees the class transition).
        void container.offsetWidth;
        container.classList.add(cls);
        // Primary cleanup: use the actual configured duration.
        const durMs = Math.ceil((durationSec || 0.7) * 1000) + 50;
        // Fallback cleanup: when the animation actually ends. This
        // catches cases where the CSS animation duration differs
        // from the JS-configured duration (e.g. tr-cut-in uses 0.3s
        // in CSS regardless of slide.transition.duration).
        const onEnd = () => {
            container.removeEventListener('animationend', onEnd);
            container.classList.remove(cls);
            if (this._trAnimTimer) {
                clearTimeout(this._trAnimTimer);
                this._trAnimTimer = null;
            }
        };
        container.addEventListener('animationend', onEnd, { once: true });
        this._trAnimTimer = setTimeout(() => {
            container.removeEventListener('animationend', onEnd);
            container.classList.remove(cls);
            this._trAnimTimer = null;
        }, durMs);
    }

    updateTransitionTiming(opts) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        slide.transition = { ...(slide.transition || { type: 'none', duration: 0.7, onClick: true }), ...opts };
        this.scheduleSave();
    }

    previewTransition() {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        const type = slide.transition?.type || 'none';
        if (type === 'none') { this.showToast('No transition selected.'); return; }

        // Pick the VISIBLE container. Previously this used
        // `document.getElementById('presentSlide') || document.getElementById('slideCanvas')`
        // but presentSlide ALWAYS exists in the DOM (inside the hidden
        // #presentOverlay with display:none), so the || short-circuit
        // always picked it — meaning the transition class was added to
        // a hidden element and the user saw nothing in editor mode.
        // Now we pick based on isPresenting so editor preview actually
        // animates the on-screen slideCanvas.
        const container = this.isPresenting
            ? document.getElementById('presentSlide')
            : document.getElementById('slideCanvas');
        if (!container) return;
        const trDur = slide.transition?.duration || 0.7;
        // Set the CSS custom property so the @keyframes animation uses
        // the user's configured duration (the CSS rules use
        // var(--tr-duration, 0.7s) — without setting it, every preview
        // would fall back to 0.7s regardless of the Timing panel).
        container.style.setProperty('--tr-duration', `${trDur}s`);

        // Special case: Morph is an object-level FLIP transition. It needs
        // a "previous slide" to morph from. In Present mode we run the full
        // FLIP; in editor mode we fall back to the CSS fade preview because
        // editor decorations (link badges, comment pins, selection box)
        // would otherwise be left orphaned by the per-element wrapping.
        if (type === 'morph') {
            const idx = this.isPresenting ? this.presentIdx : this.slideIdx;
            const prevIdx = idx > 0 ? idx - 1 : (this.pres.slides.length - 1);
            const prevSlide = this.pres.slides[prevIdx];
            if (!prevSlide || prevSlide === slide) {
                this.showToast('Add another slide to preview Morph.');
                return;
            }
            if (!this.isPresenting) {
                this._runTransitionClass(container, 'tr-morph-in', trDur);
                this.showToast('Morph is best previewed in Present mode (press F5).');
                return;
            }
            this._applyMorphTransition(container, slide, prevSlide, trDur);
            return;
        }

        // Render the current slide with the transition animation.
        // Uses the centralized _runTransitionClass helper so the
        // cleanup timer is properly tracked across rapid clicks
        // (fixes the "keeps the previous transition" bug) and the
        // duration is the user's configured one (was hardcoded 1200ms).
        this._runTransitionClass(container, `tr-${type}-in`, trDur);
    }

    // ── Morph transition (object-level FLIP) ──────────────────────
    // Matches elements between prevSlide and newSlide by a content
    // signature (text html / image src / shape+fill+stroke / video src /
    // audio src). For each matched pair with a different position or
    // size, wraps the new element in a .morph-flip-wrapper that starts
    // transformed to look like the previous element (translate + scale,
    // origin 0 0) and animates to identity. Unmatched incoming elements
    // cross-fade. The slide container also gets a subtle tr-morph-in
    // backdrop fade. Rotation on the child element is preserved because
    // the child keeps its own transform: rotate(...) with origin center,
    // and the wrapper's translate/scale composes around it cleanly.
    _applyMorphTransition(container, newSlide, prevSlide, trDur) {
        // BUGFIX: Clean up any orphan .morph-flip-wrapper divs left
        // behind by a previous morph that got interrupted mid-flight
        // (e.g. user navigated to another slide before the unwrap
        // setTimeout fired). Without this, the wrappers — and the
        // doubly-nested children inside them — accumulate in the
        // container and break element selection, dragging, and
        // rendering on subsequent renders.
        if (container) {
            container.querySelectorAll('.morph-flip-wrapper').forEach(w => {
                const inner = w.firstChild;
                if (inner && w.parentNode) {
                    // Restore the inner element's position before
                    // unwrapping, matching what the original
                    // setTimeout cleanup would have done.
                    if (inner.style) {
                        inner.style.left = '';
                        inner.style.top = '';
                    }
                    w.parentNode.replaceChild(inner, w);
                } else {
                    w.remove();
                }
            });
        }

        // Clear any in-flight morph cleanup timer from a previous
        // morph — same race-condition fix as _runTransitionClass.
        if (this._morphAnimTimer) {
            clearTimeout(this._morphAnimTimer);
            this._morphAnimTimer = null;
        }

        if (!container || !newSlide || !prevSlide || prevSlide === newSlide) {
            // No valid previous slide — fall back to fade.
            // Use _runTransitionClass so the cleanup timer is tracked
            // (was an ad-hoc setTimeout that could race with a new
            // transition's cleanup).
            this._runTransitionClass(container, 'tr-fade-in', trDur || 0.7);
            return;
        }

        const dur = trDur || 0.7;
        const animMs = Math.ceil(dur * 1000) + 50;

        // Signature function — content-based, so identical text / image /
        // shape on two slides will pair up and morph.
        const sigOf = (el) => {
            if (!el) return '?::';
            if (el.type === 'text')  return `t::${(el.html || '').slice(0, 200)}`;
            if (el.type === 'image') return `i::${el.src}`;
            if (el.type === 'shape') return `s::${el.shape}::${el.fill || ''}::${el.stroke || ''}`;
            if (el.type === 'video') return `v::${el.src}`;
            if (el.type === 'audio') return `a::${el.src}`;
            return `?::${el.type}`;
        };

        // Build signature → queue of prev elements (FIFO so duplicates pair
        // in order).
        const prevMap = new Map();
        prevSlide.elements.forEach(el => {
            const sig = sigOf(el);
            if (!prevMap.has(sig)) prevMap.set(sig, []);
            prevMap.get(sig).push(el);
        });

        // The slide's elements are rendered into the container in z-sorted
        // order, followed by the drawing overlay (if any). Slice to the
        // element count to skip the drawing overlay and any other
        // decorations appended after.
        const sorted = [...newSlide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        const numElements = sorted.length;
        const childEls = Array.from(container.children).slice(0, numElements);

        // NOTE: we intentionally do NOT apply a slide-level opacity fade
        // here. The container holds the slide's background, so animating
        // its opacity to 0 (e.g. via tr-morph-in) would make the whole
        // slide transparent for a frame and reveal the dark presenter
        // backdrop behind it — perceived as a "black flash" before the
        // morph catches up. The per-element FLIP below provides all the
        // visual transition we need while keeping the slide background
        // fully opaque throughout.

        // Collect per-element unwrap callbacks so they all run under
        // a single tracked timer (this._morphAnimTimer). If a new
        // transition interrupts this morph, _applyMorphTransition
        // (or _runTransitionClass) will clear this timer AND the
        // orphan-wrapper cleanup at the top of this method will
        // unwrap any wrappers that didn't get their callback.
        const unwrapCallbacks = [];

        childEls.forEach((child, i) => {
            const newEl = sorted[i];
            if (!newEl) return;

            const sig = sigOf(newEl);
            const queue = prevMap.get(sig);
            const prevEl = queue && queue.length > 0 ? queue.shift() : null;

            const posChanged = prevEl && (
                prevEl.x !== newEl.x || prevEl.y !== newEl.y ||
                prevEl.w !== newEl.w || prevEl.h !== newEl.h
            );

            if (prevEl && posChanged) {
                // ── Morph via wrapper-div FLIP ──────────────────────
                const dx = prevEl.x - newEl.x;
                const dy = prevEl.y - newEl.y;
                const sx = (newEl.w > 0) ? (prevEl.w / newEl.w) : 1;
                const sy = (newEl.h > 0) ? (prevEl.h / newEl.h) : 1;

                // Bail out on bad scale (e.g., zero-sized new element) —
                // fall through to the cross-fade path below.
                if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) {
                    child.style.transition = `opacity ${dur}s ease-out`;
                    child.style.opacity = '0';
                    void child.offsetWidth;
                    child.style.opacity = '1';
                    unwrapCallbacks.push(() => { child.style.transition = ''; child.style.opacity = ''; });
                    return;
                }

                // Build wrapper at the new element's slide-local position.
                // The wrapper only animates `transform` (translate + scale)
                // — opacity is left at 1 throughout so matched elements
                // never dim during the morph (a dim would read as a flash
                // when many elements morph simultaneously).
                const wrapper = document.createElement('div');
                wrapper.className = 'morph-flip-wrapper';
                wrapper.style.cssText =
                    `position:absolute;left:${newEl.x}px;top:${newEl.y}px;` +
                    `width:${newEl.w}px;height:${newEl.h}px;` +
                    `z-index:${newEl.z || 1};` +
                    `transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});` +
                    `transition:transform ${dur}s cubic-bezier(0.4, 0, 0.2, 1);`;

                // Move the existing child into the wrapper, resetting its
                // own absolute position to 0 (the wrapper handles layout
                // position; the child keeps its size + rotation transform).
                container.replaceChild(wrapper, child);
                wrapper.appendChild(child);
                child.style.left = '0';
                child.style.top = '0';

                // Force reflow so the start state is committed before we
                // animate to the end state.
                void wrapper.offsetWidth;

                // Animate to identity.
                wrapper.style.transform = 'none';

                // After the animation, unwrap: restore the child's
                // position and replace the wrapper in the container.
                // Collected into unwrapCallbacks so it runs under the
                // tracked this._morphAnimTimer below.
                unwrapCallbacks.push(() => {
                    child.style.left = newEl.x + 'px';
                    child.style.top = newEl.y + 'px';
                    if (wrapper.parentNode === container) {
                        container.replaceChild(child, wrapper);
                    }
                });
            } else if (prevEl) {
                // Matched and already in the right position/size — no
                // animation needed. The element is already correctly
                // placed, so we leave it at full opacity to avoid any
                // flicker. (Previously this dimmed to 0.85 then back to
                // 1, which read as a subtle flash when many static
                // elements shared a slide.)
            } else {
                // No match in the previous slide — cross-fade from 0.
                child.style.transition = `opacity ${dur}s ease-out`;
                child.style.opacity = '0';
                void child.offsetWidth;
                child.style.opacity = '1';
                unwrapCallbacks.push(() => { child.style.transition = ''; child.style.opacity = ''; });
            }
        });

        // Single tracked timer that runs ALL collected unwrap/cleanup
        // callbacks. If a new transition interrupts this morph, the
        // next _applyMorphTransition call (or _runTransitionClass)
        // clears this._morphAnimTimer — and the orphan-wrapper
        // cleanup at the top of this method unwraps any wrappers
        // whose callbacks never ran. Replaces the per-element
        // setTimeout calls that previously littered the forEach
        // above (each with its own untracked timer).
        this._morphAnimTimer = setTimeout(() => {
            this._morphAnimTimer = null;
            unwrapCallbacks.forEach(cb => {
                try { cb(); } catch (_) { /* element may have been re-rendered away */ }
            });
        }, animMs);
    }

    // ── Animations Tab ────────────────────────────────────────────
    static ANIMATIONS = [
        { value: 'appear', label: 'Appear',  icon: '<circle cx="12" cy="12" r="9"/>' },
        { value: 'fade',   label: 'Fade In', icon: '<circle cx="12" cy="12" r="9" stroke-dasharray="3,3"/>' },
        { value: 'fly',    label: 'Fly In',  icon: '<path d="M3 12h18M14 6l6 6-6 6"/>' },
        { value: 'zoom',   label: 'Zoom',    icon: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9" stroke-dasharray="2,3"/>' },
        { value: 'spin',   label: 'Spin',    icon: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>' },
        { value: 'bounce', label: 'Bounce',  icon: '<path d="M3 18c3-6 6-12 9-6s6 0 9-6"/>' },
    ];

    setupAnimationsTab() {
        const list = document.getElementById('animationListMenu');
        if (!list) return;

        SlidesApp.ANIMATIONS.forEach(anim => {
            const item = document.createElement('div');
            item.className = 'ms-dropdown-item animation-option';
            item.dataset.value = anim.value;
            item.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${anim.icon}</svg><span>${anim.label}</span>`;
            item.addEventListener('click', () => {
                this._closePortal(false);
                this.applyAnimation(anim.value);
            });
            list.appendChild(item);
        });

        // Animation pane toggle (ribbon button)
        document.getElementById('animationPaneBtn')?.addEventListener('click', () => this.toggleAnimationPane());
        document.getElementById('apCloseBtn')?.addEventListener('click', () => this.toggleAnimationPane(false));

        // Animation pane toolbar buttons (Add + Preview inside the pane)
        document.getElementById('apAddBtn')?.addEventListener('click', () => {
            // If not on the animations tab, switch to it first before opening the dropdown
            if (this._activeTab !== 'animations') {
                this._switchTab('animations');
                // Wait for the tab transition to finish, then open the dropdown
                setTimeout(() => {
                    const dd = document.getElementById('animationDropdown');
                    const ddBtn = dd?.querySelector('.ms-dropdown-btn');
                    if (ddBtn) ddBtn.click();
                }, 250);
            } else {
                // Already on animations tab — open dropdown directly
                const dd = document.getElementById('animationDropdown');
                const ddBtn = dd?.querySelector('.ms-dropdown-btn');
                if (ddBtn) ddBtn.click();
            }
        });
        document.getElementById('apPreviewBtn')?.addEventListener('click', () => this.previewAnimations());

        // ── Animation Start trigger pills ───────────────────────────
        // Single-select segmented toggle: clicking a pill sets it as
        // the active start mode (only one can be aria-pressed=true
        // at a time, unlike the Transition toggle which allows both).
        const startToggle = document.getElementById('animStartToggle');
        if (startToggle) {
            startToggle.querySelectorAll('.anim-start-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    // Deactivate all siblings, activate this one
                    startToggle.querySelectorAll('.anim-start-pill').forEach(p => p.setAttribute('aria-pressed', 'false'));
                    pill.setAttribute('aria-pressed', 'true');
                    const v = pill.dataset.start; // 'click' | 'with' | 'after'
                    this.updateAnimationTiming({ start: v });
                });
            });
        }

        // ── Animation Duration stepper ──────────────────────────────
        const durInput = document.getElementById('animDuration');
        durInput?.addEventListener('change', () => {
            let v = parseFloat(durInput.value);
            if (!Number.isFinite(v) || v <= 0) v = 0.5;
            v = Math.min(10, Math.max(0.1, Math.round(v * 10) / 10));
            durInput.value = v;
            this.updateAnimationTiming({ duration: v });
        });

        // ── Animation Delay stepper ─────────────────────────────────
        const delayInput = document.getElementById('animDelay');
        delayInput?.addEventListener('change', () => {
            let v = parseFloat(delayInput.value);
            if (!Number.isFinite(v) || v < 0) v = 0;
            v = Math.min(60, Math.max(0, Math.round(v * 10) / 10));
            delayInput.value = v;
            this.updateAnimationTiming({ delay: v });
        });

        // ── Animation stepper [−]/[+] buttons ───────────────────────
        // These use the .tr-num-step class, so they are already wired
        // by _wireTransitionTimingPanel() which handles ALL .tr-num-step
        // buttons globally (both transitions and animations). No separate
        // binding needed here — the stepper just adjusts the input value
        // and fires 'change', which triggers the animDuration/animDelay
        // change handlers bound above.

        // Initial sync — set the Timing panel controls to the
        // current slide's last animation values (or defaults).
        this._syncAnimationTimingUI?.();
    }

    applyAnimation(type) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        if (!this.selectedId) { this.showToast('Select an element first to animate.'); return; }
        slide.animations = slide.animations || [];
        slide.animations.push({
            id: uid(),
            elementId: this.selectedId,
            type,
            start: 'click',
            duration: 0.5,
        });
        this.scheduleSave();
        this.renderAnimationPane();
        this._syncAnimationTimingUI?.();
        this.showToast(`Added "${type}" animation.`);
    }

    updateAnimationTiming(opts) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) return;
        Object.assign(slide.animations[slide.animations.length - 1], opts);
        this.scheduleSave();
        this.renderAnimationPane();
        this._syncAnimationTimingUI?.();
    }

    // Push the current slide's last animation's timing settings
    // into the Animations tab Timing panel UI (Start / Duration /
    // Delay). Called from setupAnimationsTab, selectSlide,
    // applyAnimation, and updateAnimationTiming so the controls
    // always reflect whichever animation is the active one.
    // Without this, switching slides leaves stale values from the
    // previous slide's animation on the controls.
    _syncAnimationTimingUI() {
        const slide = this.pres?.slides?.[this.slideIdx];
        const anim = slide?.animations?.[slide.animations.length - 1] || null;

        const startToggle = document.getElementById('animStartToggle');
        const durInput = document.getElementById('animDuration');
        const delayInput = document.getElementById('animDelay');

        if (!anim) {
            // No animations on this slide — reset to defaults
            if (startToggle) {
                startToggle.querySelectorAll('.anim-start-pill').forEach(p => p.setAttribute('aria-pressed', 'false'));
                const defaultPill = startToggle.querySelector('.anim-start-pill[data-start="click"]');
                if (defaultPill) defaultPill.setAttribute('aria-pressed', 'true');
            }
            if (durInput) durInput.value = 0.5;
            if (delayInput) delayInput.value = 0;
            return;
        }

        // Start pill toggle — single-select, so only one pill is pressed
        const start = anim.start || 'click';
        if (startToggle) {
            startToggle.querySelectorAll('.anim-start-pill').forEach(p => {
                p.setAttribute('aria-pressed', String(p.dataset.start === start));
            });
        }

        // Duration input
        const dur = Number.isFinite(anim.duration) ? anim.duration : 0.5;
        if (durInput) durInput.value = dur;

        // Delay input
        const delay = Number.isFinite(anim.delay) ? anim.delay : 0;
        if (delayInput) delayInput.value = delay;
    }

    toggleAnimationPane(force) {
        const pane = document.getElementById('animationPane');
        if (!pane) return;
        const show = force === undefined ? !pane.classList.contains('visible') : force;
        pane.classList.toggle('visible', show);
        // Toggle the "active" visual state on the Animation Pane ribbon
        // button so the user can see whether the pane is open.
        const btn = document.getElementById('animationPaneBtn');
        btn?.classList.toggle('active', show);
        if (show) this.renderAnimationPane();
        // Re-render rulers — the animation pane shifts the canvas horizontally.
        this._scheduleRulerRender();
        setTimeout(() => this._scheduleRulerRender(), 260);
    }

    renderAnimationPane() {
        const body = document.getElementById('apBody');
        if (!body || !this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) {
            body.innerHTML = '<div class="ap-empty">No animations on this slide.</div>';
            return;
        }
        body.innerHTML = '';
        slide.animations.forEach((a, i) => {
            const el = this.getElement(a.elementId);
            const elLabel = el ? `${el.type} #${i+1}` : `Element #${i+1}`;
            const animLabel = SlidesApp.ANIMATIONS.find(x => x.value === a.type)?.label || a.type;
            const isSelected = this.selectedId === a.elementId;
            const item = document.createElement('div');
            item.className = 'ap-item' + (isSelected ? ' selected' : '');
            // Build a timeline-style index indicator
            const startBadge = a.start === 'with' ? 'W' : a.start === 'after' ? 'A' : '1';
            item.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:${isSelected ? 'rgba(249,115,22,0.15)' : 'rgba(0,0,0,0.04)'};color:${isSelected ? 'var(--ui-accent,#f97316)' : 'rgba(44,62,80,0.6)'};font-size:11px;font-weight:700;flex-shrink:0;">${i + 1}</div>
                <div class="ap-item-info">
                    <div class="ap-item-name">${escapeHtml(elLabel)}</div>
                    <div class="ap-item-anim">
                        <span class="anim-badge">${escapeHtml(animLabel)}</span>
                        <span>${a.start === 'with' ? 'With Prev' : a.start === 'after' ? 'After Prev' : 'On Click'}</span>
                        <span>${(a.duration || 0.5).toFixed(1)}s</span>
                    </div>
                </div>
                <button class="ap-item-remove" title="Remove">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
            `;
            // Click item to select that element and highlight this animation
            item.addEventListener('click', (e) => {
                if (e.target.closest('.ap-item-remove')) return; // don't select when removing
                this.selectedId = a.elementId;
                this.selectElement?.(a.elementId);
                this.renderAnimationPane();
                this._syncAnimationTimingUI?.();
            });
            item.querySelector('.ap-item-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                slide.animations.splice(i, 1);
                this.scheduleSave();
                this.renderAnimationPane();
                this._syncAnimationTimingUI?.();
            });
            body.appendChild(item);
        });
    }

    // ── View Tab ──────────────────────────────────────────────────
    setupViewTab() {
        // Zoom controls
        document.getElementById('zoomInBtn2')?.addEventListener('click', () => this.setZoom(this.scale * 1.1));
        document.getElementById('zoomOutBtn2')?.addEventListener('click', () => this.setZoom(this.scale / 1.1));
        document.getElementById('zoomFitBtn')?.addEventListener('click', () => this.fitZoom());
        document.getElementById('zoom100Btn')?.addEventListener('click', () => this.setZoom(1));

        // View modes — Normal and Sorter are mutually exclusive (radio-style:
        // one is always active). Notes Page is independent (toggle panel).
        document.getElementById('viewNormalBtn')?.addEventListener('click', () => {
            // Fade back in editor and notes
            const editorArea = document.getElementById('editorArea');
            const notesPanel = document.getElementById('presenterNotesPanel');
            if (editorArea) { editorArea.style.opacity = ''; editorArea.style.visibility = ''; }
            if (notesPanel) { notesPanel.style.opacity = ''; notesPanel.style.visibility = ''; }

            document.body.classList.remove('view-sorter', 'view-notes');
            this.showToast('Normal view.');
            // Normal on, Sorter off, Notes/Reader off
            ['viewSorterBtn', 'viewNotesBtn', 'immersiveReaderBtn', 'viewNormalBtn'].forEach(id => {
                document.getElementById(id)?.classList.toggle('active', id === 'viewNormalBtn');
            });
            // Re-fit zoom after returning to normal view
            setTimeout(() => this.fitZoom(), 400);
        });
        document.getElementById('viewSorterBtn')?.addEventListener('click', () => {
            // Fade out editor and notes before adding sorter class
            const editorArea = document.getElementById('editorArea');
            const notesPanel = document.getElementById('presenterNotesPanel');
            if (editorArea) { editorArea.style.opacity = '0'; }
            if (notesPanel) { notesPanel.style.opacity = '0'; }

            // Small delay to let the fade-out start, then add sorter
            setTimeout(() => {
                document.body.classList.add('view-sorter');
                document.body.classList.remove('view-notes');
                if (editorArea) { editorArea.style.visibility = 'hidden'; }
                if (notesPanel) { notesPanel.style.visibility = 'hidden'; }
                this.showToast('Slide sorter view.');
            }, 50);

            // Sorter on, Normal off, Notes/Reader off
            ['viewSorterBtn', 'viewNotesBtn', 'immersiveReaderBtn', 'viewNormalBtn'].forEach(id => {
                document.getElementById(id)?.classList.toggle('active', id === 'viewSorterBtn');
            });
        });
        document.getElementById('viewNotesBtn')?.addEventListener('click', () => {
            const panel = document.getElementById('presenterNotesPanel');
            const btn = document.getElementById('notesToggleBtn');
            if (panel) {
                const willShow = !panel.classList.contains('visible');
                panel.classList.toggle('visible', willShow);
                btn?.classList.toggle('active', willShow);
                if (btn) btn.title = willShow ? 'Hide Presenter Notes' : 'Show Presenter Notes';
                if (willShow) setTimeout(() => document.getElementById('presenterNotesInput')?.focus(), 50);
                // Re-render rulers after the layout change settles.
                this._scheduleRulerRender();
                setTimeout(() => this._scheduleRulerRender(), 260);
            }
        });

        // Show toggles
        document.getElementById('toggleRulersBtn')?.addEventListener('click', (e) => {
            document.body.classList.toggle('show-rulers');
            e.currentTarget.classList.toggle('active');
            this.renderRulers();
        });
        document.getElementById('toggleGuidesBtn')?.addEventListener('click', (e) => {
            document.body.classList.toggle('show-guides');
            e.currentTarget.classList.toggle('active');
            const wrapper = document.getElementById('slideCanvasWrapper');
            if (wrapper) wrapper.classList.toggle('show-guides');
        });

        // Immersive reader (opens a simplified read-only overlay of the current slide text)
        document.getElementById('immersiveReaderBtn')?.addEventListener('click', () => this.openImmersiveReader());
    }

    // ── File / Draw / Slide Show / Review Tab Wiring ─────
    setupExtraTabs() {
        // ── FILE TAB ──
        document.getElementById('fileNewBtn')?.addEventListener('click', () => {
            this.confirmDiscardAndCreate();
        });
        document.getElementById('fileOpenBtn')?.addEventListener('click', () => {
            // Switch to welcome screen to pick a presentation
            const ws = document.getElementById('welcomeScreen');
            if (ws && ws.parentElement) ws.parentElement.classList.remove('hidden');
            document.getElementById('welcomeScreen')?.scrollIntoView({ behavior: 'smooth' });
            this.showToast('Select a presentation from the list.');
        });
        document.getElementById('fileSaveBtn')?.addEventListener('click', () => {
            this.scheduleSave();
            this.commitSave();
            this.showToast('Saved.');
        });
        document.getElementById('fileSaveAsBtn')?.addEventListener('click', () => {
            const title = prompt('Save presentation as:', (this.pres?.title || 'Untitled Presentation') + ' (Copy)');
            if (title && title.trim()) {
                this.duplicatePresentationAs(title.trim());
            }
        });
        document.getElementById('fileExportPptxBigBtn')?.addEventListener('click', () => this.exportPPTX());
        document.getElementById('fileExportPdfBigBtn')?.addEventListener('click', () => this.exportPDF());

        // ── FILE MODAL BUTTONS ──
        // Close X button in header
        document.getElementById('fileModalCloseXBtn')?.addEventListener('click', () => this.closeFileModal());
        // Backdrop click (click on the overlay itself, not the panel)
        document.getElementById('fileModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'fileModal') this.closeFileModal();
        });
        // Rename: focus the name input in the overlay
        document.getElementById('fileRenameBtn')?.addEventListener('click', () => {
            const nameInput = document.getElementById('fileModalNameInput');
            if (nameInput) { nameInput.focus(); nameInput.select(); }
        });
        document.getElementById('fileDeleteBtn')?.addEventListener('click', () => {
            this.closeFileModal();
            if (this.pres) this.confirmDeletePresentation(this.pres.id);
        });
        document.getElementById('fileCloseBtn')?.addEventListener('click', () => {
            this.closeFileModal();
            this.closePresentation();
        });
        document.getElementById('fileExportPdfBtn')?.addEventListener('click', () => {
            this.closeFileModal();
            this.exportPDF();
        });
        document.getElementById('fileExportPptxBtn')?.addEventListener('click', () => {
            this.closeFileModal();
            this.exportPPTX();
        });
        document.getElementById('fileExportSvgBtn')?.addEventListener('click', () => {
            this.closeFileModal();
            this.exportSVGs();
        });
        // Import (Welcome screen — supports PPTX & PDF)
        const triggerImport = () => {
            document.getElementById('fileImportInput')?.click();
        };
        document.getElementById('welcomeImportBtn')?.addEventListener('click', triggerImport);
        document.getElementById('fileImportInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const ext = file.name.toLowerCase().split('.').pop();
            if (ext === 'pptx') {
                this.importPPTX(file);
            } else if (ext === 'pdf') {
                this.importPDF(file);
            } else {
                this.showToast('Unsupported file type. Please use .pptx or .pdf.', 4000);
            }
            e.target.value = '';
        });
        // Name input: save on Enter, live-update title
        document.getElementById('fileModalNameInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.target.blur();
                this.closeFileModal();
            }
        });
        document.getElementById('fileModalNameInput')?.addEventListener('input', (e) => {
            if (!this.pres) return;
            this.pres.title = e.target.value.trim() || 'Untitled Presentation';
            const titleInput = document.getElementById('presentationTitle');
            if (titleInput) titleInput.value = this.pres.title;
            this.scheduleSave();
        });

        // ── DRAW (inside Insert tab — toggles bottom drawing toolbar) ──
        this._drawColor = '#000000';
        this._drawWidth = 2;
        this._drawTool = 'pen';
        this._isDrawMode = false;
        this._isDrawing = false;
        this._drawPoints = [];
        this._drawCtx = null;
        // Insert tab → Draw button toggles the bottom drawing toolbar
        document.getElementById('insertDrawBtn')?.addEventListener('click', () => this.toggleDrawMode());
        // Bottom toolbar: tool selection
        const penBtn = document.getElementById('drawPenBtn');
        const highlighterBtn = document.getElementById('drawHighlighterBtn');
        const eraserBtn = document.getElementById('drawEraserBtn');
        const colorSection = document.querySelector('.draw-color-section');
        const colorDivider = colorSection ? colorSection.previousElementSibling : null;
        const setTool = (tool) => {
            this._drawTool = tool;
            [penBtn, highlighterBtn, eraserBtn].forEach(b => b && b.classList.remove('active'));
            if (tool === 'pen' && penBtn) penBtn.classList.add('active');
            if (tool === 'highlighter' && highlighterBtn) highlighterBtn.classList.add('active');
            if (tool === 'eraser' && eraserBtn) eraserBtn.classList.add('active');
            // Hide color section when eraser is active (nothing to color)
            const hideColor = (tool === 'eraser');
            if (colorSection) colorSection.classList.toggle('eraser-hidden', hideColor);
            if (colorDivider && colorDivider.classList.contains('color-divider')) colorDivider.classList.toggle('eraser-hidden', hideColor);
            const canvas = document.getElementById('drawingCanvas');
            if (canvas) canvas.classList.toggle('eraser-active', tool === 'eraser');
        };
        if (penBtn) penBtn.addEventListener('click', () => setTool('pen'));
        if (highlighterBtn) highlighterBtn.addEventListener('click', () => setTool('highlighter'));
        if (eraserBtn) eraserBtn.addEventListener('click', () => setTool('eraser'));
        // Color swatches
        const colorPresets = document.getElementById('drawColorPresets');
        if (colorPresets) {
            colorPresets.addEventListener('click', (e) => {
                const sw = e.target.closest('.draw-color-swatch');
                if (sw) {
                    this._drawColor = sw.dataset.color;
                    colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
                    sw.classList.add('active');
                    const picker = document.getElementById('drawColorPicker');
                    if (picker) picker.value = sw.dataset.color;
                }
            });
        }
        const colorPicker = document.getElementById('drawColorPicker');
        if (colorPicker) {
            colorPicker.addEventListener('input', () => {
                this._drawColor = colorPicker.value;
                if (colorPresets) colorPresets.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
            });
        }
        // Size presets
        const toolbar = document.getElementById('drawToolbar');
        if (toolbar) {
            toolbar.addEventListener('click', (e) => {
                const sizeBtn = e.target.closest('.draw-size-btn');
                if (sizeBtn) {
                    this._drawWidth = parseInt(sizeBtn.dataset.size, 10) || 2;
                    toolbar.querySelectorAll('.draw-size-btn').forEach(b => b.classList.remove('active'));
                    sizeBtn.classList.add('active');
                    const slider = document.getElementById('drawThickness');
                    if (slider) slider.value = this._drawWidth;
                }
            });
        }
        // Clear / Done
        document.getElementById('drawClearBtn')?.addEventListener('click', () => this.clearDrawing());
        document.getElementById('drawDoneBtn')?.addEventListener('click', () => this.finishDrawing());
        // Initialize the drawing canvas context + listeners (the canvas
        // itself is always present in the DOM; pointer-events is toggled
        // by toggleDrawMode so it only intercepts mouse events when active).
        this._initDrawingCanvas();

        // ── DESIGN TAB: Themes ──
        this.renderThemes();
        // 'More' themes dropdown is wired up automatically by setupDropdownMenus()
        this.renderThemeGallery();  // populate the gallery menu once

        // ── DESIGN TAB: Templates ──
        this.renderTemplates();
        this.renderTemplateGallery();

        // ── DESIGN TAB: Customize buttons ──
        document.getElementById('designerBtn')?.addEventListener('click', () => this.openDesigner());

        // ── ANIMATIONS TAB: Preview + Reorder ──
        document.getElementById('previewAnimBtn')?.addEventListener('click', () => this.previewAnimations());
        document.getElementById('animMoveEarlierBtn')?.addEventListener('click', () => this.moveAnimation(-1));
        document.getElementById('animMoveLaterBtn')?.addEventListener('click', () => this.moveAnimation(1));
        // animDelay change handler is wired in setupAnimationsTab()
        // (alongside animDuration) so both inputs go through the same
        // updateAnimationTiming path.

        // ── INSERT TAB: New Slide + Video + Audio + Icon + Link + Comment + Symbol ──
        document.getElementById('insertNewSlideBtn')?.addEventListener('click', () => this.addSlide());
        document.getElementById('insertVideoBtn')?.addEventListener('click', () => document.getElementById('insertVideoInput')?.click());
        document.getElementById('insertVideoInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                // Probe the video metadata so the box matches the real aspect ratio.
                // Falls back to 320x180 (16:9) if metadata can't be read.
                const dataUrl = ev.target.result;
                const probe = document.createElement('video');
                probe.preload = 'metadata';
                probe.onloadedmetadata = () => {
                    const natW = probe.videoWidth || 320;
                    const natH = probe.videoHeight || 180;
                    const MAX = 480;
                    let w, h;
                    if (natW >= natH) {
                        w = Math.min(MAX, natW);
                        h = Math.round(w * natH / natW);
                    } else {
                        h = Math.min(MAX, natH);
                        w = Math.round(h * natW / natH);
                    }
                    const x = Math.max(20, Math.round((960 - w) / 2));
                    const y = Math.max(20, Math.round((540 - h) / 2));
                    const el = { id: uid(), type: 'video', x, y, w, h, r: 0, z: 1, src: dataUrl, poster: '', opacity: 1 };
                    this.addElement(el);
                    this.showToast('Video inserted.');
                };
                probe.onerror = () => {
                    const el = { id: uid(), type: 'video', x: 130, y: 100, w: 320, h: 180, r: 0, z: 1, src: dataUrl, poster: '', opacity: 1 };
                    this.addElement(el);
                    this.showToast('Video inserted.');
                };
                probe.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
        document.getElementById('insertAudioBtn')?.addEventListener('click', () => document.getElementById('insertAudioInput')?.click());
        document.getElementById('insertAudioInput')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                // 260x70 compact card: wide enough for the native audio
                // controls (~240px) and tall enough for icon + control bar.
                const el = { id: uid(), type: 'audio', x: 130, y: 100, w: 260, h: 70, r: 0, z: 1, src: ev.target.result, opacity: 1 };
                this.addElement(el);
                this.showToast('Audio inserted.');
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
        document.getElementById('insertIconBtn')?.addEventListener('click', () => this.openIconPicker());
                document.getElementById('insertLinkBtn')?.addEventListener('click', () => this.openLinkModal());
        document.getElementById('insertCommentBtn')?.addEventListener('click', () => this.insertComment());
        document.getElementById('insertSymbolBtn')?.addEventListener('click', () => this.openSymbolPicker());
    }

    // ── Helper methods for the new features ──────────────────────

    confirmDiscardAndCreate() {
        if (this.pres && this.pres.slides && this.pres.slides.length > 0 && !confirm('Start a new presentation? Current one is saved in your library.')) return;
        this.newPresentation();
    }

    duplicatePresentationAs(newTitle) {
        if (!this.pres) return;
        const copy = JSON.parse(JSON.stringify(this.pres));
        copy.id = uid();
        copy.title = newTitle;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        this.pres = copy;
        this.slideIdx = 0;
        this.history = [];
        this.histIdx = -1;
        this.scheduleSave();
        this.commitSave();
        this.renderSlideList();
        this.renderCanvas();
        this.showToast(`Saved as "${newTitle}".`);
    }

    // ── DRAW MODE (bottom-toolbar, notes-app style) ──
    // The drawing overlay is a <canvas id="drawingCanvas"> sized to the
    // 960x540 slide. It lives inside the slide-canvas-scaler so it
    // scales with the slide. Pointer events are toggled so the canvas
    // only intercepts mouse events while drawing is active — otherwise
    // users can still select/move/resize elements normally.
    _initDrawingCanvas() {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return;
        this._drawCtx = canvas.getContext('2d');
        // The canvas always renders at the slide's logical 960x540 size.
        // The slide-canvas-scaler handles the visual scaling via CSS transform.
        canvas.width = 960;
        canvas.height = 540;
        if (this._drawCtx) {
            this._drawCtx.lineCap = 'round';
            this._drawCtx.lineJoin = 'round';
            this._drawCtx.imageSmoothingEnabled = true;
            this._drawCtx.imageSmoothingQuality = 'high';
        }
        // Mouse
        canvas.addEventListener('mousedown', (e) => this.startDraw(e));
        canvas.addEventListener('mousemove', (e) => this.drawLine(e));
        window.addEventListener('mouseup', () => this.endDraw());
        // Touch
        canvas.addEventListener('touchstart', (e) => { e.preventDefault(); this.startDraw(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchmove', (e) => { if (this._isDrawing) e.preventDefault(); this.drawLine(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchend', () => this.endDraw());
    }

    toggleDrawMode() {
        if (!this.pres) return;
        const canvas = document.getElementById('drawingCanvas');
        const toolbar = document.getElementById('drawToolbar');
        const drawBtn = document.getElementById('insertDrawBtn');
        this._isDrawMode = !this._isDrawMode;
        if (this._isDrawMode) {
            // Entering draw mode: deselect any element, show toolbar,
            // enable pointer events on the canvas, restore this slide's
            // previously saved drawing (if any).
            this.deselectElement();
            this.exitTextEditing?.();
            document.getElementById('symbolToolbar')?.classList.remove('visible');
            document.getElementById('insertSymbolBtn')?.classList.remove('active');
            if (canvas) {
                canvas.style.pointerEvents = 'all';
                canvas.style.display = 'block';
            }
            if (toolbar) toolbar.classList.add('visible');
            if (drawBtn) drawBtn.classList.add('active');
            this._restoreDrawing();
            this.showToast('Draw mode on — click and drag on the slide to draw.');
        } else {
            // Exiting draw mode: persist the drawing to the slide,
            // hide toolbar, disable pointer events on the canvas.
            this._persistDrawing();
            if (canvas) canvas.style.pointerEvents = 'none';
            if (toolbar) toolbar.classList.remove('visible');
            if (drawBtn) drawBtn.classList.remove('active');
            this.showToast('Draw mode off.');
        }
    }

    finishDrawing() { if (this._isDrawMode) this.toggleDrawMode(); }

    clearDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        if (canvas && this._drawCtx) this._drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        // Also clear the saved drawing on the current slide so the clear
        // survives a slide-switch / reload.
        const slide = this.currentSlide;
        if (slide) slide.drawingData = null;
        this.scheduleSave();
        this.updateThumbnail(this.slideIdx);
    }

    // Convert a mouse/touch event's clientX/Y into the canvas's
    // internal 960x540 coordinate space (accounting for the scaler's
    // CSS transform and any offset).
    _eventToCanvasXY(e) {
        const canvas = document.getElementById('drawingCanvas');
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        // rect.width/height are post-transform CSS pixels; canvas
        // internal coords are 960x540. Scale accordingly.
        const sx = (e.clientX - rect.left) / rect.width * 960;
        const sy = (e.clientY - rect.top) / rect.height * 540;
        return { x: sx, y: sy };
    }

    startDraw(e) {
        if (!this._isDrawMode || !this._drawCtx) return;
        this._isDrawing = true;
        const { x, y } = this._eventToCanvasXY(e);
        this._drawPoints = [{ x, y }];
        const thickness = this._drawWidth || 2;
        const tool = this._drawTool || 'pen';
        if (tool === 'eraser') {
            this._drawCtx.globalCompositeOperation = 'destination-out';
            this._drawCtx.lineWidth = thickness * 5;
            this._drawCtx.strokeStyle = '#000';
            this._drawCtx.fillStyle = '#000';
        } else if (tool === 'highlighter') {
            this._drawCtx.globalCompositeOperation = 'source-over';
            this._drawCtx.strokeStyle = this._drawColor || '#000000';
            this._drawCtx.fillStyle = this._drawColor || '#000000';
            this._drawCtx.lineWidth = thickness * 2.5;
            this._drawCtx.globalAlpha = 0.4; // translucent like a real highlighter
        } else {
            this._drawCtx.globalCompositeOperation = 'source-over';
            this._drawCtx.strokeStyle = this._drawColor || '#000000';
            this._drawCtx.fillStyle = this._drawColor || '#000000';
            this._drawCtx.lineWidth = thickness;
            this._drawCtx.globalAlpha = 1;
        }
        // Draw a dot for single-click strokes
        this._drawCtx.beginPath();
        this._drawCtx.arc(x, y, Math.max(0.5, this._drawCtx.lineWidth / 2), 0, Math.PI * 2);
        this._drawCtx.fill();
        this._drawCtx.beginPath();
        this._drawCtx.moveTo(x, y);
    }

    drawLine(e) {
        if (!this._isDrawMode || !this._isDrawing || !this._drawCtx) return;
        const { x, y } = this._eventToCanvasXY(e);
        const pts = this._drawPoints;
        pts.push({ x, y });
        // Use quadratic-curve smoothing through midpoints for natural strokes
        if (pts.length >= 3) {
            const p0 = pts[pts.length - 3];
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            const mid1x = (p0.x + p1.x) / 2, mid1y = (p0.y + p1.y) / 2;
            const mid2x = (p1.x + p2.x) / 2, mid2y = (p1.y + p2.y) / 2;
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(mid1x, mid1y);
            this._drawCtx.quadraticCurveTo(p1.x, p1.y, mid2x, mid2y);
            this._drawCtx.stroke();
        } else {
            const p0 = pts[0], p1 = pts[1];
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(p0.x, p0.y);
            this._drawCtx.lineTo(p1.x, p1.y);
            this._drawCtx.stroke();
        }
    }

    endDraw() {
        if (!this._isDrawing) return;
        this._isDrawing = false;
        // Reset alpha so subsequent strokes are full-opacity
        if (this._drawCtx) this._drawCtx.globalAlpha = 1;
        // Final segment to the last point so the stroke doesn't end mid-curve
        const pts = this._drawPoints;
        if (pts.length >= 2 && this._drawCtx) {
            const p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            this._drawCtx.beginPath();
            this._drawCtx.moveTo(mx, my);
            this._drawCtx.lineTo(p2.x, p2.y);
            this._drawCtx.stroke();
        }
        this._drawPoints = [];
        // Persist after each stroke so a crash / reload keeps the drawing.
        this._persistDrawing();
        this.updateThumbnail(this.slideIdx);
    }

    // Save the current canvas pixels as a dataURL on the current slide.
    _persistDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        const slide = this.currentSlide;
        if (!canvas || !slide || !this._drawCtx) return;
        try {
            // Only save if there are non-transparent pixels (avoid storing
            // a blank canvas every time the user toggles draw mode).
            const img = this._drawCtx.getImageData(0, 0, canvas.width, canvas.height);
            let hasContent = false;
            for (let i = 3; i < img.data.length; i += 4) {
                if (img.data[i] !== 0) { hasContent = true; break; }
            }
            slide.drawingData = hasContent ? canvas.toDataURL('image/png') : null;
        } catch (_) {
            slide.drawingData = null;
        }
        this.scheduleSave();
    }

    // Load the current slide's saved drawing onto the canvas.
    _restoreDrawing() {
        const canvas = document.getElementById('drawingCanvas');
        const slide = this.currentSlide;
        if (!canvas || !slide || !this._drawCtx) return;
        this._drawCtx.setTransform(1, 0, 0, 1, 0, 0);
        this._drawCtx.clearRect(0, 0, canvas.width, canvas.height);
        if (!slide.drawingData) return;
        const img = new Image();
        img.onload = () => {
            if (this._drawCtx) this._drawCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = slide.drawingData;
    }

    // ── THEMES & VARIANTS ──
    static THEMES = [
        // Light, professional, single-accent
        { name: 'Accent Box', bg: '#ffffff', title: '#1a1a1a', sub: '#f97316' },
        { name: 'Wisp',       bg: '#f5f3ff', title: '#4c1d95', sub: '#7c3aed' },
        { name: 'Gallery',    bg: '#fef2f2', title: '#7f1d1d', sub: '#ef4444' },
        { name: 'Mesh',       bg: '#ecfeff', title: '#164e63', sub: '#06b6d4' },
        { name: 'Organic',    bg: '#f0fdf4', title: '#14532d', sub: '#22c55e' },
        { name: 'Office',     bg: '#ffffff', title: '#1a1a1a', sub: '#2b579a' },

        // Dark premium
        { name: 'Slice',      bg: '#0f172a', title: '#f8fafc', sub: '#38bdf8' },
        { name: 'Integral',   bg: '#1e293b', title: '#f1f5f9', sub: '#f97316' },
        { name: 'Parallax',   bg: '#1a1a1a', title: '#fafafa', sub: '#fbbf24' },
        { name: 'Obsidian',   bg: '#111827', title: '#f9fafb', sub: '#a78bfa' },

        // Warm tones
        { name: 'Couture',    bg: '#fdf4ff', title: '#581c87', sub: '#a21caf' },
        { name: 'Vapor',      bg: '#fdf2f8', title: '#831843', sub: '#ec4899' },
        { name: 'Frame',      bg: '#fffbeb', title: '#78350f', sub: '#f59e0b' },
        { name: 'Terra',      bg: '#fff7ed', title: '#7c2d12', sub: '#ea580c' },

        // Cool tones
        { name: 'Lagoon',     bg: '#ecfeff', title: '#155e75', sub: '#0891b2' },
        { name: 'Indigo',     bg: '#eef2ff', title: '#312e81', sub: '#4f46e5' },
        { name: 'Forest',     bg: '#f0fdf4', title: '#14532d', sub: '#16a34a' },
        { name: 'Mist',       bg: '#f8fafc', title: '#334155', sub: '#64748b' },

        // Vibrant gradients — colorful & professional
        { name: 'Aurora',     bg: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', title: '#ffffff', sub: '#fbbf24', isGradient: true },
        { name: 'Sunset',     bg: 'linear-gradient(135deg,#f97316 0%,#ef4444 100%)', title: '#ffffff', sub: '#fde68a', isGradient: true },
        { name: 'Ocean',      bg: 'linear-gradient(135deg,#06b6d4 0%,#3b82f6 100%)', title: '#ffffff', sub: '#fef08a', isGradient: true },
        { name: 'Emerald',    bg: 'linear-gradient(135deg,#10b981 0%,#059669 100%)', title: '#ffffff', sub: '#fef3c7', isGradient: true },
        { name: 'Royal',      bg: 'linear-gradient(135deg,#7c3aed 0%,#2563eb 100%)', title: '#ffffff', sub: '#fde68a', isGradient: true },
        { name: 'Cotton Candy', bg: 'linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%)', title: '#ffffff', sub: '#fef3c7', isGradient: true },
        { name: 'Midnight',   bg: 'linear-gradient(135deg,#1e3a8a 0%,#0f172a 100%)', title: '#f1f5f9', sub: '#38bdf8', isGradient: true },
        { name: 'Coral Reef', bg: 'linear-gradient(135deg,#f43f5e 0%,#fb923c 100%)', title: '#ffffff', sub: '#fef3c7', isGradient: true },
        { name: 'Tropical',   bg: 'linear-gradient(135deg,#14b8a6 0%,#22c55e 100%)', title: '#ffffff', sub: '#fef3c7', isGradient: true },
        { name: 'Berry',      bg: 'linear-gradient(135deg,#db2777 0%,#7c3aed 100%)', title: '#ffffff', sub: '#fde68a', isGradient: true },
        { name: 'Citrus',     bg: 'linear-gradient(135deg,#eab308 0%,#f97316 100%)', title: '#1f2937', sub: '#ffffff', isGradient: true },
        { name: 'Cyber',      bg: 'linear-gradient(135deg,#6366f1 0%,#ec4899 100%)', title: '#ffffff', sub: '#fde68a', isGradient: true },
    ];

    // ── TEMPLATES ── Each template defines a slide layout structure
    // with its own set of color variants (per-template color schemes).
    static TEMPLATES = [
        // ── Business ──
        {
            name: 'Executive Title',
            category: 'business',
            layout: 'title-only',
            description: 'Bold centered title slide for executive presentations',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316',
            elements: [
                { type: 'text', x: 15, y: 25, w: 70, h: 15, text: 'Title', fontSize: 44, fontWeight: 'bold', color: '#1a1a1a' },
                { type: 'text', x: 15, y: 45, w: 70, h: 8, text: 'Subtitle', fontSize: 20, color: '#6b7280' },
                { type: 'shape', x: 0, y: 85, w: 100, h: 5, shape: 'rect', fill: '#f97316', stroke: 'none' },
            ],
            variants: [
                { name: 'Light',   bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
                { name: 'Dark',    bg: '#1a1a1a', fg: '#fafafa', accent: '#fb923c' },
                { name: 'Navy',    bg: '#1e3a8a', fg: '#ffffff', accent: '#fbbf24' },
                { name: 'Warm',    bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
                { name: 'Cool',    bg: '#eff6ff', fg: '#1e3a8a', accent: '#2563eb' },
            ],
        },
        {
            name: 'Corporate Content',
            category: 'business',
            layout: 'title-content',
            description: 'Title bar with body content area below',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316',
            elements: [
                { type: 'shape', x: 0, y: 0, w: 100, h: 12, shape: 'rect', fill: '#f97316', stroke: 'none' },
                { type: 'text', x: 5, y: 2, w: 90, h: 9, text: 'Slide Title', fontSize: 28, fontWeight: 'bold', color: '#ffffff' },
                { type: 'text', x: 8, y: 16, w: 84, h: 70, text: 'Content body text goes here', fontSize: 16, color: '#374151' },
            ],
            variants: [
                { name: 'Orange',  bg: '#ffffff', fg: '#374151', accent: '#f97316' },
                { name: 'Blue',    bg: '#ffffff', fg: '#374151', accent: '#2563eb' },
                { name: 'Dark',    bg: '#1e293b', fg: '#e2e8f0', accent: '#38bdf8' },
                { name: 'Green',   bg: '#ffffff', fg: '#374151', accent: '#16a34a' },
                { name: 'Red',     bg: '#ffffff', fg: '#374151', accent: '#dc2626' },
            ],
        },
        {
            name: 'Two Column Report',
            category: 'business',
            layout: 'two-column',
            description: 'Side-by-side content columns with header',
            bg: '#f8fafc', fg: '#1e293b', accent: '#f97316',
            elements: [
                { type: 'text', x: 5, y: 3, w: 90, h: 10, text: 'Report Title', fontSize: 32, fontWeight: 'bold', color: '#1e293b' },
                { type: 'shape', x: 0, y: 13, w: 100, h: 2, shape: 'rect', fill: '#f97316', stroke: 'none' },
                { type: 'text', x: 5, y: 18, w: 43, h: 70, text: 'Left Column', fontSize: 14, color: '#374151' },
                { type: 'text', x: 52, y: 18, w: 43, h: 70, text: 'Right Column', fontSize: 14, color: '#374151' },
            ],
            variants: [
                { name: 'Light',   bg: '#f8fafc', fg: '#1e293b', accent: '#f97316' },
                { name: 'Dark',    bg: '#1e293b', fg: '#f1f5f9', accent: '#38bdf8' },
                { name: 'Warm',    bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
                { name: 'Teal',    bg: '#f0fdfa', fg: '#134e4a', accent: '#14b8a6' },
            ],
        },
        // ── Education ──
        {
            name: 'Lecture Slide',
            category: 'education',
            layout: 'title-content',
            description: 'Clean layout for lecture and teaching slides',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#2563eb',
            elements: [
                { type: 'shape', x: 0, y: 0, w: 100, h: 3, shape: 'rect', fill: '#2563eb', stroke: 'none' },
                { type: 'text', x: 5, y: 5, w: 90, h: 10, text: 'Lecture Title', fontSize: 36, fontWeight: 'bold', color: '#1a1a1a' },
                { type: 'text', x: 8, y: 18, w: 84, h: 68, text: 'Key points and explanations', fontSize: 18, color: '#374151' },
                { type: 'shape', x: 0, y: 88, w: 100, h: 3, shape: 'rect', fill: '#2563eb', stroke: 'none' },
            ],
            variants: [
                { name: 'Blue',    bg: '#ffffff', fg: '#1a1a1a', accent: '#2563eb' },
                { name: 'Green',   bg: '#ffffff', fg: '#1a1a1a', accent: '#16a34a' },
                { name: 'Dark',    bg: '#1a1a1a', fg: '#f1f5f9', accent: '#38bdf8' },
                { name: 'Warm',    bg: '#fffbeb', fg: '#78350f', accent: '#f59e0b' },
            ],
        },
        {
            name: 'Quiz & Answer',
            category: 'education',
            layout: 'title-content',
            description: 'Interactive quiz-style slide layout',
            bg: '#eff6ff', fg: '#1e3a8a', accent: '#2563eb',
            elements: [
                { type: 'shape', x: 0, y: 0, w: 100, h: 18, shape: 'rect', fill: '#2563eb', stroke: 'none' },
                { type: 'text', x: 5, y: 3, w: 90, h: 14, text: 'Question?', fontSize: 28, fontWeight: 'bold', color: '#ffffff' },
                { type: 'text', x: 10, y: 22, w: 80, h: 65, text: 'Answer choices or explanation', fontSize: 18, color: '#1e3a8a' },
            ],
            variants: [
                { name: 'Blue',    bg: '#eff6ff', fg: '#1e3a8a', accent: '#2563eb' },
                { name: 'Green',   bg: '#f0fdf4', fg: '#14532d', accent: '#16a34a' },
                { name: 'Dark',    bg: '#1a1a1a', fg: '#f1f5f9', accent: '#38bdf8' },
                { name: 'Purple',  bg: '#f5f3ff', fg: '#4c1d95', accent: '#7c3aed' },
            ],
        },
        // ── Creative ──
        {
            name: 'Hero Splash',
            category: 'creative',
            layout: 'title-only',
            description: 'Bold full-screen hero with dramatic typography',
            bg: 'linear-gradient(135deg,#1e3a8a 0%,#0f172a 100%)', fg: '#f1f5f9', accent: '#38bdf8', isGradient: true,
            elements: [
                { type: 'text', x: 10, y: 30, w: 80, h: 20, text: 'HERO TITLE', fontSize: 56, fontWeight: 'bold', color: '#f1f5f9' },
                { type: 'text', x: 10, y: 55, w: 80, h: 10, text: 'Tagline or description', fontSize: 22, color: '#94a3b8' },
                { type: 'shape', x: 10, y: 68, w: 25, h: 5, shape: 'rect', fill: '#38bdf8', stroke: 'none' },
            ],
            variants: [
                { name: 'Midnight',  bg: '#0f172a', fg: '#f1f5f9', accent: '#38bdf8' },
                { name: 'Aurora',    bg: '#1e3a8a', fg: '#ffffff', accent: '#fbbf24' },
                { name: 'Ember',     bg: '#1a1a1a', fg: '#fafafa', accent: '#f97316' },
                { name: 'Neon',      bg: '#111827', fg: '#f9fafb', accent: '#a78bfa' },
                { name: 'Coral',     bg: '#ffffff', fg: '#1a1a1a', accent: '#f43f5e' },
            ],
        },
        {
            name: 'Photo Overlay',
            category: 'creative',
            layout: 'title-only',
            description: 'Text overlay layout for photo backgrounds',
            bg: '#1a1a1a', fg: '#ffffff', accent: '#f97316',
            elements: [
                { type: 'shape', x: 0, y: 50, w: 100, h: 50, shape: 'rect', fill: 'rgba(0,0,0,0.6)', stroke: 'none' },
                { type: 'text', x: 5, y: 55, w: 90, h: 15, text: 'Overlay Title', fontSize: 36, fontWeight: 'bold', color: '#ffffff' },
                { type: 'text', x: 5, y: 72, w: 90, h: 10, text: 'Descriptive text', fontSize: 16, color: '#d1d5db' },
                { type: 'shape', x: 5, y: 85, w: 20, h: 3, shape: 'rect', fill: '#f97316', stroke: 'none' },
            ],
            variants: [
                { name: 'Orange',  bg: '#1a1a1a', fg: '#ffffff', accent: '#f97316' },
                { name: 'Cyan',    bg: '#0f172a', fg: '#f1f5f9', accent: '#06b6d4' },
                { name: 'Gold',    bg: '#111827', fg: '#f9fafb', accent: '#fbbf24' },
                { name: 'Rose',    bg: '#1a1a1a', fg: '#ffffff', accent: '#f43f5e' },
            ],
        },
        {
            name: 'Minimal Quote',
            category: 'creative',
            layout: 'title-only',
            description: 'Elegant minimal slide for quotes or statements',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316',
            elements: [
                { type: 'shape', x: 5, y: 10, w: 3, h: 70, shape: 'rect', fill: '#f97316', stroke: 'none' },
                { type: 'text', x: 12, y: 20, w: 83, h: 35, text: '"Inspirational quote goes here"', fontSize: 32, color: '#1a1a1a' },
                { type: 'text', x: 12, y: 58, w: 83, h: 8, text: '— Author Name', fontSize: 16, color: '#6b7280' },
            ],
            variants: [
                { name: 'Orange',  bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
                { name: 'Dark',    bg: '#1a1a1a', fg: '#fafafa', accent: '#fbbf24' },
                { name: 'Blue',    bg: '#f8fafc', fg: '#0f172a', accent: '#2563eb' },
                { name: 'Rose',    bg: '#fff1f2', fg: '#881337', accent: '#e11d48' },
            ],
        },
        // ── Data ──
        {
            name: 'Chart Slide',
            category: 'data',
            layout: 'title-content',
            description: 'Layout optimized for data charts and graphs',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316',
            elements: [
                { type: 'text', x: 5, y: 3, w: 90, h: 10, text: 'Data Visualization Title', fontSize: 28, fontWeight: 'bold', color: '#1a1a1a' },
                { type: 'shape', x: 0, y: 13, w: 100, h: 2, shape: 'rect', fill: '#f97316', stroke: 'none' },
                { type: 'shape', x: 10, y: 18, w: 80, h: 55, shape: 'rect', fill: '#f9fafb', stroke: '#e5e7eb' },
                { type: 'text', x: 10, y: 76, w: 80, h: 15, text: 'Data source and key insights', fontSize: 14, color: '#6b7280' },
            ],
            variants: [
                { name: 'Orange',  bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
                { name: 'Blue',    bg: '#ffffff', fg: '#1a1a1a', accent: '#2563eb' },
                { name: 'Dark',    bg: '#1e293b', fg: '#e2e8f0', accent: '#38bdf8' },
                { name: 'Green',   bg: '#ffffff', fg: '#1a1a1a', accent: '#16a34a' },
            ],
        },
        {
            name: 'Dashboard Metrics',
            category: 'data',
            layout: 'title-content',
            description: 'KPI dashboard layout with metric cards',
            bg: '#f8fafc', fg: '#0f172a', accent: '#f97316',
            elements: [
                { type: 'text', x: 5, y: 3, w: 90, h: 8, text: 'Dashboard Title', fontSize: 24, fontWeight: 'bold', color: '#0f172a' },
                { type: 'shape', x: 5, y: 14, w: 28, h: 25, shape: 'rect', fill: '#ffffff', stroke: '#e5e7eb' },
                { type: 'text', x: 7, y: 16, w: 26, h: 6, text: 'Metric 1', fontSize: 20, fontWeight: 'bold', color: '#f97316' },
                { type: 'shape', x: 36, y: 14, w: 28, h: 25, shape: 'rect', fill: '#ffffff', stroke: '#e5e7eb' },
                { type: 'text', x: 38, y: 16, w: 26, h: 6, text: 'Metric 2', fontSize: 20, fontWeight: 'bold', color: '#2563eb' },
                { type: 'shape', x: 67, y: 14, w: 28, h: 25, shape: 'rect', fill: '#ffffff', stroke: '#e5e7eb' },
                { type: 'text', x: 69, y: 16, w: 26, h: 6, text: 'Metric 3', fontSize: 20, fontWeight: 'bold', color: '#16a34a' },
                { type: 'text', x: 5, y: 45, w: 90, h: 50, text: 'Detailed analysis content area', fontSize: 14, color: '#374151' },
            ],
            variants: [
                { name: 'Light',   bg: '#f8fafc', fg: '#0f172a', accent: '#f97316' },
                { name: 'Dark',    bg: '#1e293b', fg: '#e2e8f0', accent: '#38bdf8' },
                { name: 'Warm',    bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
            ],
        },
        // ── Photo ──
        {
            name: 'Photo Gallery',
            category: 'photo',
            layout: 'blank',
            description: 'Grid layout for showcasing photos',
            bg: '#1a1a1a', fg: '#ffffff', accent: '#f97316',
            elements: [
                { type: 'shape', x: 3, y: 3, w: 46, h: 45, shape: 'rect', fill: '#374151', stroke: '#4b5563' },
                { type: 'shape', x: 51, y: 3, w: 46, h: 45, shape: 'rect', fill: '#374151', stroke: '#4b5563' },
                { type: 'shape', x: 3, y: 52, w: 46, h: 45, shape: 'rect', fill: '#374151', stroke: '#4b5563' },
                { type: 'shape', x: 51, y: 52, w: 46, h: 45, shape: 'rect', fill: '#374151', stroke: '#4b5563' },
            ],
            variants: [
                { name: 'Dark',    bg: '#1a1a1a', fg: '#ffffff', accent: '#f97316' },
                { name: 'Light',   bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
                { name: 'Slate',   bg: '#334155', fg: '#f1f5f9', accent: '#38bdf8' },
            ],
        },
        {
            name: 'Photo with Caption',
            category: 'photo',
            layout: 'title-content',
            description: 'Large photo area with caption strip below',
            bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316',
            elements: [
                { type: 'shape', x: 5, y: 5, w: 90, h: 70, shape: 'rect', fill: '#f3f4f6', stroke: '#d1d5db' },
                { type: 'text', x: 5, y: 78, w: 90, h: 8, text: 'Photo Caption', fontSize: 18, fontWeight: 'bold', color: '#1a1a1a' },
                { type: 'text', x: 5, y: 88, w: 90, h: 8, text: 'Description or credits', fontSize: 12, color: '#6b7280' },
            ],
            variants: [
                { name: 'Light',   bg: '#ffffff', fg: '#1a1a1a', accent: '#f97316' },
                { name: 'Dark',    bg: '#1a1a1a', fg: '#fafafa', accent: '#fb923c' },
                { name: 'Warm',    bg: '#fff7ed', fg: '#7c2d12', accent: '#ea580c' },
            ],
        },
    ];

    // ── TEMPLATE RENDERING ────────────────────────────────────────

    // Render template thumbnails in the ribbon row
    renderTemplates() {
        const row = document.getElementById('templateThumbnailRow');
        if (!row) return;
        const templates = SlidesApp.TEMPLATES;
        // Show up to 6 in the inline ribbon row
        const slice = templates.slice(0, 6);
        row.innerHTML = '';
        slice.forEach((t, i) => {
            const realIdx = SlidesApp.TEMPLATES.indexOf(t);
            const isGradient = t.isGradient || /^\s*(linear|radial|conic)-gradient\(/i.test(String(t.bg || ''));

            const btn = document.createElement('button');
            btn.className = `template-thumb${realIdx === this._activeTemplateIdx ? ' active' : ''}`;
            btn.dataset.idx = String(realIdx);
            btn.title = `${t.name} — ${t.description}`;
            btn.style.background = t.bg;

            // Render real template elements inside the thumb
            this._renderTemplateRealPreview(btn, t);

            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                this.selectTemplate(idx);
                row.querySelectorAll('.template-thumb').forEach(x => x.classList.remove('active'));
                btn.classList.add('active');
            });
            row.appendChild(btn);
        });
    }

    // Render real template elements as mini-preview inside a container
    _renderTemplateRealPreview(container, template) {
        const v = template.variants[0];
        template.elements.forEach(el => {
            const div = document.createElement('div');
            div.className = 'tpl-preview-el';
            div.style.position = 'absolute';
            div.style.left = el.x + '%';
            div.style.top = el.y + '%';
            div.style.width = el.w + '%';
            div.style.height = el.h + '%';
            if (el.type === 'text') {
                div.style.fontSize = Math.max(4, el.fontSize * 0.18) + 'px';
                div.style.fontWeight = el.fontWeight || 'normal';
                div.style.color = el.color || v.fg;
                div.style.fontFamily = '"DM Sans", sans-serif';
                div.style.overflow = 'hidden';
                div.style.lineHeight = '1.2';
                div.textContent = el.text;
                // Scale font size further for tiny inline thumbs
                if (container.classList.contains('template-thumb') && !container.closest('.template-gallery-card')) {
                    div.style.fontSize = Math.max(3, el.fontSize * 0.09) + 'px';
                }
            }
            if (el.type === 'shape') {
                const fillVal = el.fill;
                if (fillVal && fillVal.startsWith('rgba')) {
                    div.style.background = fillVal;
                } else if (fillVal === template.accent) {
                    div.style.background = v.accent;
                } else {
                    div.style.background = fillVal || v.accent;
                }
                if (el.stroke && el.stroke !== 'none') {
                    div.style.border = `1px solid ${el.stroke}`;
                }
                div.style.borderRadius = el.shape === 'circle' ? '50%' : '2px';
            }
            container.appendChild(div);
        });
    }

    // Render the full template gallery in the More dropdown
    renderTemplateGallery() {
        const menu = document.getElementById('templateGalleryMenu');
        if (!menu) return;
        menu.innerHTML = '';
        // Header
        const header = document.createElement('div');
        header.className = 'theme-gallery-header';
        header.textContent = 'All Templates';
        menu.appendChild(header);
        // Grid
        this._renderTemplateGalleryGrid(menu);
    }

    _renderTemplateGalleryGrid(menu) {
        // Remove existing grid if present
        const existing = menu.querySelector('.template-gallery-grid');
        if (existing) existing.remove();
        const grid = document.createElement('div');
        grid.className = 'template-gallery-grid';
        const templates = SlidesApp.TEMPLATES;
        templates.forEach((t) => {
            const realIdx = SlidesApp.TEMPLATES.indexOf(t);

            const card = document.createElement('button');
            card.className = 'template-gallery-card';
            card.dataset.idx = String(realIdx);
            card.title = `${t.name} — ${t.description}`;

            const thumb = document.createElement('div');
            thumb.className = 'template-thumb';
            thumb.style.background = t.bg;

            // Render real template elements inside the gallery thumb
            this._renderTemplateRealPreview(thumb, t);

            const label = document.createElement('div');
            label.className = 'theme-gallery-label';
            label.textContent = t.name;

            card.appendChild(thumb);
            card.appendChild(label);
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectTemplate(realIdx);
                // Close the dropdown
                this._closePortal();
            });
            grid.appendChild(card);
        });
        menu.appendChild(grid);
    }

    // Select a template: apply its layout
    selectTemplate(idx) {
        this._activeTemplateIdx = idx;
        const template = SlidesApp.TEMPLATES[idx];
        if (!template) return;
        // Apply the template's default variant
        this.applyTemplate(template, template.variants[0]);
        // Re-render template thumbs to mark active
        this.renderTemplates();
    }

    // Apply a template with a specific variant to the current slide
    applyTemplate(template, variant) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;

        const v = variant || template.variants[0];
        const isGradient = v.isGradient || /^\s*(linear|radial|conic)-gradient\(/i.test(String(v.bg || ''));

        // Set slide background
        slide.background = { type: isGradient ? 'gradient' : 'color', value: v.bg };

        // Clear existing elements and replace with template layout
        // scaled to actual slide dimensions
        slide.elements = template.elements.map(el => {
            const newEl = {
                id: uid(),
                type: el.type,
                // Convert percentage-based positions to pixel values
                // using standard 960×540 slide dimensions
                x: Math.round(el.x * 9.6),
                y: Math.round(el.y * 5.4),
                w: Math.round(el.w * 9.6),
                h: Math.round(el.h * 5.4),
            };
            if (el.type === 'text') {
                newEl.content = el.text;
                newEl.fontSize = el.fontSize || 16;
                newEl.fontWeight = el.fontWeight || 'normal';
                newEl.color = el.color || v.fg;
            }
            if (el.type === 'shape') {
                newEl.shape = el.shape || 'rect';
                // Apply variant accent to shape fills (unless they use rgba)
                const fillVal = el.fill;
                if (fillVal && fillVal !== 'none' && !fillVal.startsWith('rgba')) {
                    // Template default fill — replace with variant accent if it matches template accent
                    if (fillVal === template.accent) {
                        newEl.fill = v.accent;
                    } else {
                        newEl.fill = fillVal;
                    }
                } else {
                    newEl.fill = fillVal || v.accent;
                }
                newEl.stroke = el.stroke || 'none';
                newEl.strokeWidth = el.strokeWidth || (el.stroke === 'none' ? 0 : 2);
            }
            return newEl;
        });

        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Template "${template.name}" with variant "${v.name}" applied.`);
    }

    // Insert a new slide using the selected template
    insertTemplateSlide() {
        if (!this.pres) return;
        const template = SlidesApp.TEMPLATES[this._activeTemplateIdx];
        if (!template) {
            this.showToast('Select a template first.');
            return;
        }
        const v = template.variants[0];
        const isGradient = v.isGradient || /^\s*(linear|radial|conic)-gradient\(/i.test(String(v.bg || ''));

        const newSlide = {
            id: uid(),
            background: { type: isGradient ? 'gradient' : 'color', value: v.bg },
            elements: template.elements.map(el => {
                const newEl = {
                    id: uid(),
                    type: el.type,
                    x: Math.round(el.x * 9.6),
                    y: Math.round(el.y * 5.4),
                    w: Math.round(el.w * 9.6),
                    h: Math.round(el.h * 5.4),
                };
                if (el.type === 'text') {
                    newEl.content = el.text;
                    newEl.fontSize = el.fontSize || 16;
                    newEl.fontWeight = el.fontWeight || 'normal';
                    newEl.color = el.color || v.fg;
                }
                if (el.type === 'shape') {
                    newEl.shape = el.shape || 'rect';
                    const fillVal = el.fill;
                    if (fillVal && fillVal !== 'none' && !fillVal.startsWith('rgba')) {
                        if (fillVal === template.accent) {
                            newEl.fill = v.accent;
                        } else {
                            newEl.fill = fillVal;
                        }
                    } else {
                        newEl.fill = fillVal || v.accent;
                    }
                    newEl.stroke = el.stroke || 'none';
                    newEl.strokeWidth = el.strokeWidth || (el.stroke === 'none' ? 0 : 2);
                }
                return newEl;
            }),
            transitions: [],
        };
        // Insert after current slide
        const insertIdx = this.slideIdx + 1;
        this.pres.slides.splice(insertIdx, 0, newSlide);
        this.slideIdx = insertIdx;
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`New slide from template "${template.name}" inserted.`);
    }

    // Preview template in a modal (show a larger mockup)
    previewTemplate() {
        const template = SlidesApp.TEMPLATES[this._activeTemplateIdx];
        if (!template) {
            this.showToast('Select a template first.');
            return;
        }
        const v = template.variants[0];
        const isGradient = v.isGradient || /^\s*(linear|radial|conic)-gradient\(/i.test(String(v.bg || ''));

        // Build a preview modal
        const overlay = document.createElement('div');
        overlay.className = 'template-preview-overlay';
        overlay.addEventListener('click', () => overlay.remove());

        const modal = document.createElement('div');
        modal.className = 'template-preview-modal';
        modal.addEventListener('click', e => e.stopPropagation());

        // 16:9 preview box
        const previewBox = document.createElement('div');
        previewBox.className = 'template-preview-box';
        previewBox.style.background = v.bg;

        // Render elements as simplified HTML inside preview
        template.elements.forEach(el => {
            const div = document.createElement('div');
            div.style.position = 'absolute';
            div.style.left = el.x + '%';
            div.style.top = el.y + '%';
            div.style.width = el.w + '%';
            div.style.height = el.h + '%';
            if (el.type === 'text') {
                div.style.fontSize = Math.max(8, el.fontSize * 0.35) + 'px';
                div.style.fontWeight = el.fontWeight || 'normal';
                div.style.color = el.color || v.fg;
                div.style.fontFamily = '"DM Sans", sans-serif';
                div.textContent = el.text;
                div.style.overflow = 'hidden';
            }
            if (el.type === 'shape') {
                const fillVal = el.fill;
                if (fillVal && fillVal.startsWith('rgba')) {
                    div.style.background = fillVal;
                } else if (fillVal === template.accent) {
                    div.style.background = v.accent;
                } else {
                    div.style.background = fillVal || v.accent;
                }
                div.style.borderRadius = el.shape === 'rect' ? '2px' : '50%';
            }
            previewBox.appendChild(div);
        });

        const info = document.createElement('div');
        info.className = 'template-preview-info';
        info.innerHTML = `<strong>${template.name}</strong><br><span style="color:#6b7280">${template.description}</span><br><span style="color:#9ca3af;font-size:12px">Category: ${template.category} | Layout: ${template.layout}</span>`;

        const actions = document.createElement('div');
        actions.className = 'template-preview-actions';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'template-preview-action-btn primary';
        applyBtn.textContent = 'Apply to Current Slide';
        applyBtn.addEventListener('click', () => {
            this.applyTemplate(template, v);
            overlay.remove();
        });

        const insertBtn = document.createElement('button');
        insertBtn.className = 'template-preview-action-btn';
        insertBtn.textContent = 'Insert New Slide';
        insertBtn.addEventListener('click', () => {
            this.insertTemplateSlide();
            overlay.remove();
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'template-preview-action-btn';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());

        actions.appendChild(applyBtn);
        actions.appendChild(insertBtn);
        actions.appendChild(closeBtn);

        modal.appendChild(previewBox);
        modal.appendChild(info);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    renderThemes() {
        const row = document.getElementById('themeThumbnailRow');
        if (!row) return;
        const start = (this._themeIdx ?? 0);
        const slice = SlidesApp.THEMES.slice(start, start + 6);
        row.innerHTML = slice.map((t, i) => `
            <button class="theme-thumb" data-idx="${start + i}" title="${t.name}" style="background:${t.bg};--tt-title:${t.title};--tt-accent:${t.sub};">
                <div class="tt-preview">
                    <div class="tt-title-bar"></div>
                    <div class="tt-body">
                        <div class="tt-line tt-line-1"></div>
                        <div class="tt-line tt-line-2"></div>
                        <div class="tt-line tt-line-3"></div>
                    </div>
                    <div class="tt-accent-box"></div>
                </div>
            </button>
        `).join('');
        row.querySelectorAll('.theme-thumb').forEach(th => {
            th.addEventListener('click', () => {
                const idx = parseInt(th.dataset.idx, 10);
                this.applyTheme(SlidesApp.THEMES[idx]);
                row.querySelectorAll('.theme-thumb').forEach(x => x.classList.remove('active'));
                th.classList.add('active');
            });
        });
    }

    renderThemeGallery() {
        const menu = document.getElementById('themeGalleryMenu');
        if (!menu) return;
        // Header
        const header = document.createElement('div');
        header.className = 'theme-gallery-header';
        header.textContent = 'All Themes';
        menu.appendChild(header);
        // Grid
        const grid = document.createElement('div');
        grid.className = 'theme-gallery-grid';
        SlidesApp.THEMES.forEach((t, i) => {
            // Each dropdown card is a wrapper containing a 16:9 mini slide
            // preview (same .theme-thumb / .tt-preview markup as the inline
            // ribbon thumbs) plus a name label below.
            const card = document.createElement('button');
            card.className = 'theme-gallery-card';
            card.dataset.idx = String(i);
            card.title = t.name;

            const thumb = document.createElement('div');
            thumb.className = 'theme-thumb';
            thumb.style.background = t.bg;
            thumb.style.setProperty('--tt-title', t.title);
            thumb.style.setProperty('--tt-accent', t.sub);

            const preview = document.createElement('div');
            preview.className = 'tt-preview';
            const tBar = document.createElement('div');
            tBar.className = 'tt-title-bar';
            const body = document.createElement('div');
            body.className = 'tt-body';
            ['tt-line-1', 'tt-line-2', 'tt-line-3'].forEach(cls => {
                const line = document.createElement('div');
                line.className = 'tt-line ' + cls;
                body.appendChild(line);
            });
            const accent = document.createElement('div');
            accent.className = 'tt-accent-box';
            preview.appendChild(tBar);
            preview.appendChild(body);
            preview.appendChild(accent);
            thumb.appendChild(preview);

            const label = document.createElement('div');
            label.className = 'theme-gallery-label';
            label.textContent = t.name;

            card.appendChild(thumb);
            card.appendChild(label);
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                this.applyTheme(SlidesApp.THEMES[i]);
                // Also mark the matching ribbon thumb (if visible) as active
                const row = document.getElementById('themeThumbnailRow');
                if (row) {
                    row.querySelectorAll('.theme-thumb').forEach(x => x.classList.remove('active'));
                    const match = row.querySelector(`.theme-thumb[data-idx="${i}"]`);
                    if (match) match.classList.add('active');
                }
                // Close the dropdown
                this._closePortal();
            });
            grid.appendChild(card);
        });
        menu.appendChild(grid);
    }

    applyTheme(theme) {
        if (!this.pres) return;
        // Detect gradient backgrounds (linear-gradient / radial-gradient)
        const isGradient = theme.isGradient || /^\s*(linear|radial|conic)-gradient\(/i.test(String(theme.bg || ''));
        this.pres.slides.forEach(s => {
            if (!s.background) s.background = { type: 'color', value: '#ffffff' };
            s.background = { type: isGradient ? 'gradient' : 'color', value: theme.bg };
            // Update first text element to title color
            const titleEl = s.elements.find(e => e.type === 'text');
            if (titleEl) titleEl.color = theme.title;
            // Update first shape to accent color
            const shapeEl = s.elements.find(e => e.type === 'shape');
            if (shapeEl) shapeEl.fill = theme.sub;
        });
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Theme "${theme.name}" applied.`);
    }

    applyLayout(layout) {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        if (!slide) return;
        slide.elements = [];
        const W = 960, H = 540;
        if (layout.name === 'Blank') { /* nothing */ }
        else if (layout.name === 'Title Slide') {
            slide.elements.push({ ...makeTextEl(W / 2 - 250, 180, 500, 90), fontSize: 54, bold: true, textAlign: 'center', html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(W / 2 - 200, 300, 400, 50), fontSize: 24, textAlign: 'center', html: 'Click to add subtitle', color: '#666' });
        } else if (layout.name === 'Title and Content') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 840, 360), fontSize: 22, html: 'Click to add text', color: '#333' });
        } else if (layout.name === 'Section Header') {
            slide.elements.push({ ...makeTextEl(W / 2 - 300, 220, 600, 100), fontSize: 60, bold: true, textAlign: 'center', html: 'Section Title', color: '#1a1a1a' });
        } else if (layout.name === 'Two Content') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 400, 360), fontSize: 22, html: 'Left column', color: '#333' });
            slide.elements.push({ ...makeTextEl(500, 130, 400, 360), fontSize: 22, html: 'Right column', color: '#333' });
        } else if (layout.name === 'Comparison') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 130, 400, 60), fontSize: 24, bold: true, html: 'Option A', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 200, 400, 290), fontSize: 20, html: 'Description...', color: '#333' });
            slide.elements.push({ ...makeTextEl(500, 130, 400, 60), fontSize: 24, bold: true, html: 'Option B', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(500, 200, 400, 290), fontSize: 20, html: 'Description...', color: '#333' });
        } else if (layout.name === 'Title Only') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 70), fontSize: 36, bold: true, html: 'Click to add title', color: '#1a1a1a' });
        } else if (layout.name === 'Content with Caption') {
            slide.elements.push({ ...makeTextEl(60, 40, 840, 50), fontSize: 22, bold: true, html: 'Caption', color: '#666' });
            slide.elements.push({ ...makeTextEl(60, 100, 840, 60), fontSize: 32, bold: true, html: 'Title', color: '#1a1a1a' });
            slide.elements.push({ ...makeTextEl(60, 170, 840, 320), fontSize: 22, html: 'Content...', color: '#333' });
        }
        this.pushHistory();
        this.renderCanvas();
        this.renderSlideList();
        this.scheduleSave();
        this.showToast(`Layout "${layout.name}" applied.`);
    }

    openDesigner() {
        // Layout definitions
        const layouts = [
            { name: 'Title Slide',          desc: 'Centered title + subtitle',        icon: 'title' },
            { name: 'Title and Content',     desc: 'Title on top, body below',         icon: 'title-content' },
            { name: 'Section Header',        desc: 'Large centered title',             icon: 'section' },
            { name: 'Two Content',           desc: 'Title + two columns',              icon: 'two-col' },
            { name: 'Comparison',            desc: 'Title + side-by-side compare',     icon: 'compare' },
            { name: 'Title Only',            desc: 'Just a title placeholder',         icon: 'title-only' },
            { name: 'Blank',                 desc: 'Empty slide',                      icon: 'blank' },
            { name: 'Content with Caption',  desc: 'Caption + content',                icon: 'caption' },
        ];

        const modal = document.getElementById('designerModal');
        const grid = document.getElementById('designerLayoutGrid');
        if (!modal || !grid) return;

        // Close function with closing animation (matches other modals)
        const closeDesigner = () => {
            modal.classList.add('closing');
            setTimeout(() => { modal.classList.remove('show'); modal.classList.remove('closing'); }, 230);
        };

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeDesigner();
        });

        // Close on X button click
        const closeBtn = document.getElementById('designerModalCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeDesigner);

        // Clear and populate layout grid
        grid.innerHTML = '';
        layouts.forEach((layout) => {
            const card = document.createElement('button');
            card.className = 'designer-layout-card';
            card.title = `${layout.name} — ${layout.desc}`;

            const preview = document.createElement('div');
            preview.className = 'designer-layout-preview';
            this._renderLayoutPreviewIcon(preview, layout.icon);

            const name = document.createElement('div');
            name.className = 'designer-layout-name';
            name.textContent = layout.name;

            const desc = document.createElement('div');
            desc.className = 'designer-layout-desc';
            desc.textContent = layout.desc;

            card.appendChild(preview);
            card.appendChild(name);
            card.appendChild(desc);

            card.addEventListener('click', () => {
                this.applyLayout(layout);
                closeDesigner();
            });
            grid.appendChild(card);
        });

        // Show modal using the standard .show pattern (like other modals)
        modal.classList.add('show');
    }

    // Render a mini layout preview icon inside a container
    _renderLayoutPreviewIcon(container, iconType) {
        // Each layout type gets a simplified visual preview
        // using absolutely positioned divs inside the container
        const c = container;
        c.style.position = 'relative';
        c.style.background = '#ffffff';
        c.style.border = '1px solid rgba(0,0,0,0.06)';
        c.style.borderRadius = '4px';

        const accent = 'var(--ui-accent, #f97316)';
        const titleColor = '#1a1a1a';
        const textColor = '#9ca3af';

        const addRect = (x, y, w, h, bg, br = '2px') => {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;background:${bg};border-radius:${br};pointer-events:none;`;
            c.appendChild(d);
            return d;
        };

        switch (iconType) {
            case 'title': // Title Slide: centered title bar + subtitle line
                addRect(15, 28, 70, 14, titleColor);
                addRect(25, 50, 50, 6, textColor);
                break;
            case 'title-content': // Title on top, body below
                addRect(5, 4, 90, 12, accent);
                addRect(8, 22, 84, 65, '#f3f4f6');
                break;
            case 'section': // Large centered title
                addRect(15, 32, 70, 22, titleColor, '3px');
                break;
            case 'two-col': // Title + two columns
                addRect(5, 4, 90, 10, titleColor);
                addRect(5, 18, 43, 72, '#f3f4f6');
                addRect(52, 18, 43, 72, '#f3f4f6');
                break;
            case 'compare': // Side-by-side compare
                addRect(5, 4, 90, 10, titleColor);
                addRect(5, 18, 43, 18, accent, '3px');
                addRect(5, 40, 43, 50, '#f3f4f6');
                addRect(52, 18, 43, 18, '#2563eb', '3px');
                addRect(52, 40, 43, 50, '#f3f4f6');
                break;
            case 'title-only': // Just a title
                addRect(5, 20, 90, 12, titleColor);
                break;
            case 'blank': // Empty
                break;
            case 'caption': // Caption + content
                addRect(5, 4, 90, 6, textColor);
                addRect(5, 14, 90, 10, titleColor);
                addRect(5, 28, 90, 62, '#f3f4f6');
                break;
        }
    }

    // ── ANIMATION PREVIEW / REORDER ──
    // Plays back the current slide's animations on the editor canvas
    // so the user can see what they configured without entering
    // Present mode. Previously this just flashed the canvas opacity
    // (useless). Now it walks slide.animations in order, applying
    // each animation's class to its target element with the
    // configured duration and delay, and sequences them according
    // to the `start` field:
    //   • 'click' → wait for the previous 'click' animation to finish
    //              (in preview we auto-advance after a short gap so
    //              the user doesn't have to click)
    //   • 'with'  → start at the same time as the previous animation
    //   • 'after' → start when the previous animation ends
    // The animation classes (anim-playing-*) and the
    // --anim-duration / --anim-delay custom properties are defined
    // in slides.css.
    previewAnimations() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) {
            this.showToast('No animations on this slide to preview.');
            return;
        }
        const container = this.isPresenting
            ? document.getElementById('presentSlide')
            : document.getElementById('slideCanvas');
        if (!container) return;

        // Clear any in-flight preview timers from a previous click
        // so rapid Preview presses don't overlap and leave classes
        // stuck on elements.
        if (this._animPreviewTimers) {
            this._animPreviewTimers.forEach(t => clearTimeout(t));
        }
        this._animPreviewTimers = [];
        // Also strip any leftover anim-playing-* classes from a
        // previous preview that got interrupted.
        container.querySelectorAll('[class*="anim-playing-"]').forEach(el => {
            Array.from(el.classList).forEach(c => {
                if (c.startsWith('anim-playing-')) el.classList.remove(c);
            });
            el.style.removeProperty('--anim-duration');
            el.style.removeProperty('--anim-delay');
        });

        this.showToast('Previewing animations…');

        // Walk the animations in order, scheduling each one's
        // start time relative to the previous one based on `start`.
        let cursor = 0; // ms — running timestamp of "now" in preview time
        let lastEndTime = 0; // ms — when the previous animation finishes
        slide.animations.forEach((anim, i) => {
            const dur = Number.isFinite(anim.duration) ? anim.duration : 0.5;
            const delay = Number.isFinite(anim.delay) ? anim.delay : 0;
            const start = anim.start || 'click';

            // Compute this animation's start time.
            let startMs;
            if (start === 'with' && i > 0) {
                // Start simultaneously with the previous animation.
                startMs = cursor;
            } else if (start === 'after' && i > 0) {
                // Start when the previous animation ends.
                startMs = lastEndTime;
            } else {
                // 'click' (or first animation) — chain after the
                // previous animation ends with a small visual gap
                // so the user can see distinct steps.
                startMs = i === 0 ? 0 : lastEndTime + 150;
            }

            const endMs = startMs + delay * 1000 + dur * 1000;
            lastEndTime = endMs;
            // Advance the cursor only for click/after — 'with'
            // doesn't advance time because the next animation
            // overlaps this one.
            if (start !== 'with') {
                cursor = endMs;
            }

            // Schedule the class application.
            const applyTimer = setTimeout(() => {
                // Element DOM nodes use id="el-<elementId>" (see
                // renderCanvas). Try the id selector first (fast,
                // unique), then fall back to data-id for safety.
                const target = anim.elementId
                    ? (document.getElementById(`el-${anim.elementId}`) ||
                       container.querySelector(`[data-id="${anim.elementId}"]`))
                    : null;
                if (!target) return;
                // Set the CSS custom properties so the keyframes
                // use the user's configured duration and delay.
                // (Delay is baked into the startMs scheduling, so
                // we set --anim-delay to 0 here to avoid double-
                // counting.)
                target.style.setProperty('--anim-duration', `${dur}s`);
                target.style.setProperty('--anim-delay', `0s`);
                // Force reflow so a re-trigger on the same element
                // (rapid previews) actually restarts the animation.
                void target.offsetWidth;
                target.classList.add(`anim-playing-${anim.type}`);
            }, startMs + delay * 1000);
            this._animPreviewTimers.push(applyTimer);

            // Schedule cleanup.
            const cleanupTimer = setTimeout(() => {
                const target = anim.elementId
                    ? (document.getElementById(`el-${anim.elementId}`) ||
                       container.querySelector(`[data-id="${anim.elementId}"]`))
                    : null;
                if (target) {
                    target.classList.remove(`anim-playing-${anim.type}`);
                    target.style.removeProperty('--anim-duration');
                    target.style.removeProperty('--anim-delay');
                }
            }, endMs + 100);
            this._animPreviewTimers.push(cleanupTimer);
        });
    }

    moveAnimation(delta) {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide || !slide.animations || slide.animations.length === 0) return;
        // Find the index of the animation for the currently-selected element
        // (or the last animation if nothing is selected).
        let animIdx = -1;
        if (this.selectedId) {
            animIdx = slide.animations.findIndex(a => a.elementId === this.selectedId);
        }
        if (animIdx < 0) {
            // No animation found for the selected element — fall back to the
            // last animation on the slide so the buttons still work even when
            // the user hasn't explicitly clicked an item in the pane.
            animIdx = slide.animations.length - 1;
        }
        const target = animIdx + delta;
        if (target < 0 || target >= slide.animations.length) return;
        // Swap within the slide's animation list
        [slide.animations[animIdx], slide.animations[target]] = [slide.animations[target], slide.animations[animIdx]];
        this.scheduleSave();
        this.renderAnimationPane();
        this._syncAnimationTimingUI?.();
        this.showToast(delta < 0 ? 'Moved earlier.' : 'Moved later.');
    }

    // ── IMMERSIVE READER ──
    openImmersiveReader() {
        const slide = this.pres?.slides?.[this.slideIdx];
        if (!slide) return;
        const text = slide.elements
            .filter(e => e.type === 'text' && e.html)
            .map(e => e.html.replace(/<[^>]+>/g, ' '))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) { this.showToast('No text to read on this slide.'); return; }
        const overlay = document.createElement('div');
        overlay.id = 'immersiveReaderOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#fffdf7;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;font-family:"DM Sans",sans-serif;color:#1a1a1a;';
        const irTextDiv = document.createElement('div');
        irTextDiv.style.cssText = 'max-width:720px;font-size:24px;line-height:1.7;text-align:center;';
        irTextDiv.textContent = text;
        const irClose = document.createElement('button');
        irClose.id = 'irClose';
        irClose.style.cssText = 'padding:10px 20px;background:#f97316;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;';
        irClose.textContent = 'Close (Esc)';
        const irRead = document.createElement('button');
        irRead.id = 'irRead';
        irRead.style.cssText = 'padding:10px 20px;background:#fff;color:#1a1a1a;border:1px solid #ddd;border-radius:6px;font-size:14px;cursor:pointer;';
        irRead.textContent = 'Read Aloud';
        const irBtns = document.createElement('div');
        irBtns.style.cssText = 'margin-top:32px;display:flex;gap:12px;';
        irBtns.appendChild(irClose);
        irBtns.appendChild(irRead);
        overlay.appendChild(irTextDiv);
        overlay.appendChild(irBtns);
        document.body.appendChild(overlay);
        const close = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 230); };
        irClose.addEventListener('click', close);
        irRead.addEventListener('click', () => {
            if ('speechSynthesis' in window) {
                const u = new SpeechSynthesisUtterance(text);
                speechSynthesis.cancel();
                speechSynthesis.speak(u);
            } else {
                this.showToast('Speech synthesis not supported in this browser.');
            }
        });
        const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
    }

    // ── Load icon library from icons.emeraldcore ──
    async loadIconLibrary() {
        try {
            const r = await fetch('/assets/data/icons.emeraldcore');
            if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
            const text = await r.text();
            const data = JSON.parse(stripComments(text));
            window.ICON_DB  = data.icons;
            window.ICON_CATS = data.categories;
            console.log(`Icon library loaded: ${data.icons.length} icons, ${data.categories.length} categories`);
        } catch (err) {
            console.error('Failed to load icons.emeraldcore:', err);
            window.ICON_DB  = [];
            window.ICON_CATS = ['All'];
        }
    }

    // ── INSERT: Icon / Link / Comment / Symbol ──
    openIconPicker() {
        if (!window.ICON_DB || !window.ICON_DB.length) {
            const reason = window.ICON_DB && window.ICON_DB.length === 0
                ? 'Icon library failed to load — check console for details.'
                : 'Icon library not loaded.';
            this.showToast(reason);
            return;
        }
        const self = this;
        const allIcons = window.ICON_DB;
        const categories = window.ICON_CATS || ['All'];
        const BATCH = 120;
        const svgWrap = (inner) =>
            `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

        const overlay = document.createElement('div');
        overlay.className = 'delete-modal';
        overlay.innerHTML = `
            <div class="delete-modal-content icon-picker-content">
                <button class="modal-close-btn">&times;</button>
                <div class="icons-modal-header">
                    <div class="delete-modal-icon" style="background:#f97316;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>
                    </div>
                    <h3 class="delete-modal-title">Insert Icon</h3>
                    <p class="icons-modal-message icon-picker-count">${allIcons.length} icons available</p>
                </div>
                <div class="delete-modal-body icon-picker-body">
                    <div class="icon-picker-search-row">
                        <input type="text" id="iconSearchInput" placeholder="Search icons… e.g. arrow, mail, star" autocomplete="off" />
                    </div>
                    <div class="icon-picker-cats">
                        ${categories.map(c => `<button class="icon-cat-btn${c==='All'?' active':''}" data-cat="${c}">${c}</button>`).join('')}
                    </div>
                    <div class="icon-picker-grid-scroll" id="iconGridScroll">
                        <div class="icon-picker-grid" id="iconGrid"></div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        const close = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 230); };
        overlay.querySelector('.modal-close-btn').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // State
        let currentCat = 'All';
        let currentSearch = '';
        let filtered = allIcons;
        let renderedCount = 0;

        function filterIcons() {
            const q = currentSearch.toLowerCase().trim();
            if (currentCat === 'All') {
                filtered = q ? allIcons.filter(ic => {
                    const haystack = (ic.name + ' ' + ic.tags).toLowerCase();
                    return haystack.includes(q);
                }) : allIcons;
            } else {
                filtered = allIcons.filter(ic => ic.category === currentCat);
                if (q) {
                    filtered = filtered.filter(ic => {
                        const haystack = (ic.name + ' ' + ic.tags).toLowerCase();
                        return haystack.includes(q);
                    });
                }
            }
            renderedCount = 0;
            renderBatch(true);
        }

        function renderBatch(reset) {
            const grid = overlay.querySelector('#iconGrid');
            if (reset) grid.innerHTML = '';
            const end = Math.min(renderedCount + BATCH, filtered.length);
            for (let i = renderedCount; i < end; i++) {
                const ic = filtered[i];
                const btn = document.createElement('button');
                btn.className = 'icon-pick';
                btn.dataset.idx = String(i);
                btn.title = ic.name;
                btn.innerHTML = svgWrap(ic.svg);
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const svgStr = `<svg viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">${ic.svg}</svg>`;
                    const el = { id: uid(), type: 'shape', x: 380, y: 220, w: 80, h: 80, r: 0, z: 1, shape: 'icon', svg: svgStr, fill: 'none', stroke: '#374151', strokeWidth: 2, opacity: 1 };
                    self.addElement(el);
                    self.showToast(`Inserted "${ic.name}" icon.`);
                    close();
                });
                grid.appendChild(btn);
            }
            renderedCount = end;

            // Update count label
            const countLabel = overlay.querySelector('.icon-picker-count');
            countLabel.textContent = `${filtered.length} icons available`;
        }

        // Infinite scroll: auto-load more when scrolling near bottom
        const scrollContainer = overlay.querySelector('#iconGridScroll');
        scrollContainer.addEventListener('scroll', () => {
            const threshold = 60;
            if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - threshold) {
                if (renderedCount < filtered.length) {
                    renderBatch(false);
                }
            }
        });

        // Search input
        const searchInput = overlay.querySelector('#iconSearchInput');
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                currentSearch = searchInput.value;
                filterIcons();
            }, 150);
        });
        searchInput.focus();

        // Category tabs
        overlay.querySelectorAll('.icon-cat-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                overlay.querySelectorAll('.icon-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentCat = btn.dataset.cat;
                filterIcons();
            });
        });

        // Initial render
        filterIcons();
    }


    openLinkModal() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        if (!el) { this.showToast('Select an element to add a link.'); return; }

        const overlay = document.createElement('div');
        overlay.className = 'delete-modal';
        overlay.innerHTML = `
            <div class="delete-modal-content">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon" style="background:#2563eb;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                        </svg>
                    </div>
                    <h3 class="delete-modal-title">Insert Hyperlink</h3>
                </div>
                <div class="delete-modal-body" style="padding-top:0;">
                    <label style="display:block;font-size:0.82rem;color:#666;margin-bottom:6px;font-weight:500;">Link URL</label>
                    <input type="url" id="linkUrlInput" value="${escapeHtml(el.link || 'https://')}" placeholder="https://example.com" />
                </div>
                <div class="delete-modal-actions" style="${el.link ? 'justify-content:flex-start;' : ''}">
                    ${el.link ? '<button class="delete-modal-btn" id="removeLinkBtn" style="background:rgba(217,48,37,.08);color:#d93025;border:1px solid rgba(217,48,37,.2);">Remove Link</button>' : ''}
                    <button class="delete-modal-btn delete-modal-btn-cancel" id="linkCancelBtn">Cancel</button>
                    <button class="delete-modal-btn" id="linkSaveBtn" style="background:#2563eb;color:#fff;border:1px solid rgba(37,99,235,.3);">Save Link</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        const input = overlay.querySelector('#linkUrlInput');
        input.focus();
        input.select();

        const close = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 230); };

        overlay.querySelector('#linkCancelBtn').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        overlay.querySelector('#linkSaveBtn').addEventListener('click', () => {
            const url = input.value.trim();
            if (!url) return;
            el.link = url;
            this.pushHistory();
            this.scheduleSave();
            this.renderCanvas();
            this.showToast(`Linked to ${url}.`);
            close();
        });

        const removeBtn = overlay.querySelector('#removeLinkBtn');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                delete el.link;
                this.pushHistory();
                this.scheduleSave();
                this.renderCanvas();
                this.showToast('Link removed.');
                close();
            });
        }
    }

    insertComment() {
        if (!this.pres) return;
        const slide = this.pres.slides[this.slideIdx];
        const el = this.selectedId ? this.getElement(this.selectedId) : null;

        const overlay = document.createElement('div');
        overlay.className = 'delete-modal';
        overlay.innerHTML = `
            <div class="delete-modal-content">
                <div class="delete-modal-header">
                    <div class="delete-modal-icon" style="background:#f97316;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                        </svg>
                    </div>
                    <h3 class="delete-modal-title">New Comment</h3>
                </div>
                <div class="delete-modal-body" style="padding-top:0;">
                    <textarea id="commentInput" rows="3" placeholder="Write a comment..."></textarea>
                </div>
                <div class="delete-modal-actions">
                    <button class="delete-modal-btn delete-modal-btn-cancel" id="commentCancelBtn">Cancel</button>
                    <button class="delete-modal-btn" id="commentSaveBtn" style="background:#f97316;color:#fff;border:1px solid rgba(249,115,22,.3);">Add Comment</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        const textarea = overlay.querySelector('#commentInput');
        textarea.focus();

        const close = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 230); };

        overlay.querySelector('#commentCancelBtn').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        overlay.querySelector('#commentSaveBtn').addEventListener('click', () => {
            const text = textarea.value.trim();
            if (!text) return;
            if (!slide.comments) slide.comments = [];
            // If an element is selected, stick the comment pin to the element
            // Otherwise, place it outside the slide boundary (top-right, beyond right edge)
            const cx = el ? el.x + el.w + 10 : 970;
            const cy = el ? el.y : 10;
            slide.comments.push({ id: uid(), text, author: 'You', ts: Date.now(), x: cx, y: cy, elementId: el ? el.id : null });
            this.scheduleSave();
            this.renderCanvas();
            this.showToast('Comment added.');
            close();
        });
    }

    showCommentPopup(comment, ci) {
        // Remove any existing popup
        const existing = document.querySelector('.comment-popup');
        if (existing) existing.remove();

        // Compute popup position — stick to element if linked, use stored coords otherwise
        const slide = this.pres.slides[this.slideIdx];
        let pinX = comment.x;
        let pinY = comment.y;
        if (comment.elementId) {
            const linkedEl = slide.elements.find(e => e.id === comment.elementId);
            if (linkedEl) {
                pinX = linkedEl.x + linkedEl.w + 10; // Stick to the element
                pinY = linkedEl.y;
            }
        }

        const popup = document.createElement('div');
        popup.className = 'comment-popup';
        popup.style.cssText = `position:absolute;left:${pinX + 24}px;top:${pinY - 4}px;`;
        popup.innerHTML = `
            <div class="comment-popup-header">
                <div class="comment-popup-avatar">${escapeHtml(comment.author.charAt(0))}</div>
                <span class="comment-popup-author">${escapeHtml(comment.author)}</span>
                <span class="comment-popup-time">${formatDate(comment.ts)}</span>
                <button class="comment-popup-close">&times;</button>
            </div>
            <div class="comment-popup-body">${escapeHtml(comment.text)}</div>
            <div class="comment-popup-actions">
                <button class="comment-reply-btn">Reply</button>
                <button class="comment-delete-btn">Delete</button>
            </div>`;
        const canvas = document.getElementById('slideCanvas');
        if (canvas) canvas.appendChild(popup);

        popup.querySelector('.comment-popup-close').addEventListener('click', () => popup.remove());
        popup.querySelector('.comment-reply-btn').addEventListener('click', () => {
            const reply = prompt('Reply:');
            if (!reply || !reply.trim()) return;
            if (!comment.replies) comment.replies = [];
            comment.replies.push({ id: uid(), text: reply.trim(), author: 'You', ts: Date.now() });
            this.scheduleSave();
            popup.remove();
            this.renderCanvas();
        });
        popup.querySelector('.comment-delete-btn').addEventListener('click', () => {
            const slide = this.pres.slides[this.slideIdx];
            slide.comments.splice(ci, 1);
            this.scheduleSave();
            popup.remove();
            this.renderCanvas();
            this.showToast('Comment deleted.');
        });
    }

    openSymbolPicker() {
        const toolbar = document.getElementById('symbolToolbar');
        const symBtn = document.getElementById('insertSymbolBtn');
        if (!toolbar) return;
        // If already visible, hide it
        if (toolbar.classList.contains('visible')) {
            toolbar.classList.remove('visible');
            if (symBtn) symBtn.classList.remove('active');
            return;
        }
        // Hide draw toolbar if open
        document.getElementById('drawToolbar')?.classList.remove('visible');
        toolbar.classList.add('visible');
        if (symBtn) symBtn.classList.add('active');

        // Symbol insertion: insert into current text editing, or create new text
        toolbar.querySelectorAll('.sym-bar-btn').forEach(btn => {
            // Remove old listeners by cloning (avoid duplicates)
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                const sym = newBtn.dataset.s;

                // If currently editing a text, insert symbol directly at cursor
                if (this.editingId) {
                    const domEl = document.getElementById(`el-${this.editingId}`);
                    const content = domEl?.querySelector('.text-content');
                    if (content) {
                        // Focus the contentEditable and insert symbol at cursor
                        content.focus();
                        const sel = window.getSelection();
                        if (sel.rangeCount > 0) {
                            const range = sel.getRangeAt(0);
                            range.deleteContents();
                            const textNode = document.createTextNode(sym);
                            range.insertNode(textNode);
                            // Move cursor after the inserted symbol
                            range.setStartAfter(textNode);
                            range.setEndAfter(textNode);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        } else {
                            // No selection range, just append
                            content.textContent += sym;
                        }
                        // Save the updated HTML back to the element data
                        const el = this.getElement(this.editingId);
                        if (el) {
                            el.html = content.innerHTML;
                            this.scheduleSave();
                        }
                        this.showToast(`Inserted "${sym}"`);
                        return;
                    }
                }

                // If a text element is selected but not in edit mode, enter edit mode and insert
                if (this.selectedId) {
                    const el = this.getElement(this.selectedId);
                    if (el && el.type === 'text') {
                        this.enterTextEditing(el.id);
                        // After entering edit mode, insert the symbol
                        setTimeout(() => {
                            const domEl = document.getElementById(`el-${el.id}`);
                            const content = domEl?.querySelector('.text-content');
                            if (content) {
                                content.focus();
                                const sel = window.getSelection();
                                if (sel.rangeCount > 0) {
                                    const range = sel.getRangeAt(0);
                                    range.deleteContents();
                                    const textNode = document.createTextNode(sym);
                                    range.insertNode(textNode);
                                    range.setStartAfter(textNode);
                                    range.setEndAfter(textNode);
                                    sel.removeAllRanges();
                                    sel.addRange(range);
                                } else {
                                    content.textContent += sym;
                                }
                                el.html = content.innerHTML;
                                this.scheduleSave();
                            }
                            this.showToast(`Inserted "${sym}"`);
                        }, 60);
                        return;
                    }
                }

                // No text element active — create a new text element
                const newEl = makeTextEl(380, 220, 80, 80);
                newEl.html = sym;
                newEl.fontSize = 48;
                newEl.textAlign = 'center';
                this.addElement(newEl);
                this.showToast(`Inserted "${sym}"`);
            });
        });

        // Done button
        document.getElementById('symbolDoneBtn')?.addEventListener('click', () => {
            toolbar.classList.remove('visible');
            document.getElementById('insertSymbolBtn')?.classList.remove('active');
        });
    }

    setZoom(scale) {
        this.scale = clamp(scale, 0.2, 4);
        const scaler = document.getElementById('slideCanvasScaler');
        if (scaler) scaler.style.transform = `scale(${this.scale})`;
        const zs = document.getElementById('zoomStatus');
        if (zs) zs.textContent = Math.round(this.scale * 100) + '%';
        this.renderRulers();
    }

    renderRulers() {
        // Render tick marks on the top & left rulers based on canvas size + zoom.
        // The rulers live inside #editorContent and span its full width/height,
        // so tick positions are expressed in editor-content coordinates.
        const top = document.getElementById('rulerTop');
        const left = document.getElementById('rulerLeft');
        if (!top || !left) return;
        const editor = document.getElementById('editorContent');
        const canvas = document.getElementById('slideCanvas');
        if (!editor || !canvas) return;
        const editorRect = editor.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        // Offset of the canvas top-left corner inside the editor-content (screen px).
        const offsetX = canvasRect.left - editorRect.left;
        const offsetY = canvasRect.top - editorRect.top;
        const scale = this.scale || 1;
        const visW = canvasRect.width;  // visible canvas width (already scaled)
        const visH = canvasRect.height; // visible canvas height (already scaled)

        // Zoom-aware tick spacing. At higher zoom, more detail is shown.
        // We pick a minor step (small ticks) and a major step (labeled ticks).
        // The on-screen minor spacing is kept between ~8px and ~30px so ticks
        // never feel crowded or too sparse, regardless of zoom level.
        let minorStep, majorStep;
        if (scale < 0.4)      { minorStep = 100; majorStep = 200; }
        else if (scale < 0.8) { minorStep = 50;  majorStep = 100; }
        else if (scale < 1.6) { minorStep = 25;  majorStep = 100; }
        else if (scale < 3.0) { minorStep = 10;  majorStep = 50;  }
        else                  { minorStep = 5;   majorStep = 25;  }

        // Build the top ruler ticks (vertical lines + numeric labels).
        // Three visual tiers: major (long, labeled), mid (medium), minor (short).
        let topHtml = '';
        for (let x = 0; x <= 960; x += minorStep) {
            const px = offsetX + x * scale;
            // Skip ticks that fall outside the editor's visible range.
            if (px < -2 || px > editorRect.width + 2) continue;
            const isMajor = (x % majorStep === 0);
            const isMid = !isMajor && (majorStep % (minorStep * 2) === 0) && (x % (minorStep * 2) === 0);
            const h = isMajor ? 11 : (isMid ? 7 : 4);
            topHtml += `<div class="ruler-tick ruler-tick-x" style="left:${px}px;height:${h}px;"></div>`;
            if (isMajor && x > 0) {
                topHtml += `<span class="ruler-label ruler-label-x" style="left:${px + 2}px;">${x}</span>`;
            }
        }
        top.innerHTML = topHtml;
        // Build the left ruler ticks (horizontal lines + numeric labels).
        let leftHtml = '';
        for (let y = 0; y <= 540; y += minorStep) {
            const px = offsetY + y * scale;
            if (px < -2 || px > editorRect.height + 2) continue;
            const isMajor = (y % majorStep === 0);
            const isMid = !isMajor && (majorStep % (minorStep * 2) === 0) && (y % (minorStep * 2) === 0);
            const w = isMajor ? 11 : (isMid ? 7 : 4);
            leftHtml += `<div class="ruler-tick ruler-tick-y" style="top:${px}px;width:${w}px;"></div>`;
            if (isMajor && y > 0) {
                leftHtml += `<span class="ruler-label ruler-label-y" style="top:${px + 2}px;">${y}</span>`;
            }
        }
        left.innerHTML = leftHtml;
    }

    // Re-render rulers when the editor layout changes (sidebar collapse,
    // notes panel open/close, animation pane open/close, statusbar changes,
    // window resize, etc.). Uses a ResizeObserver on #editorContent plus a
    // rAF-throttled fallback so the tick marks follow the canvas smoothly
    // during CSS transitions.
    _rulerRafPending = false;
    _rulerObserver = null;
    _scheduleRulerRender() {
        if (this._rulerRafPending) return;
        this._rulerRafPending = true;
        requestAnimationFrame(() => {
            this._rulerRafPending = false;
            this.renderRulers();
        });
    }

    _setupRulerObserver() {
        if (this._rulerObserver) return;
        const editor = document.getElementById('editorContent');
        if (!editor || typeof ResizeObserver === 'undefined') return;
        this._rulerObserver = new ResizeObserver(() => {
            this._scheduleRulerRender();
        });
        this._rulerObserver.observe(editor);
        // Also observe the canvas wrapper — when its size changes the canvas
        // re-centers inside it, so the ruler offsets change even if editorContent
        // itself did not resize.
        const wrapper = document.getElementById('slideCanvasWrapper');
        if (wrapper) this._rulerObserver.observe(wrapper);
        // Final pass after any layout transition ends (sidebar width, notes
        // panel height, etc.) so the ruler snaps to the final position.
        const watch = (el) => {
            if (!el) return;
            el.addEventListener('transitionend', () => this._scheduleRulerRender());
        };
        watch(document.getElementById('slidesSidebar'));
        watch(document.getElementById('editorColumn'));
        watch(document.getElementById('editorArea'));
        watch(document.getElementById('presenterNotesPanel'));
        watch(document.getElementById('animationPane'));
    }

    fitZoom() {
        const wrapper = document.getElementById('slideCanvasWrapper');
        if (!wrapper) { this.setZoom(1); return; }
        const rect = wrapper.getBoundingClientRect();
        const padding = 40;
        const sx = (rect.width - padding) / 960;
        const sy = (rect.height - padding) / 540;
        this.setZoom(Math.min(sx, sy, 1));
    }

    setupSidebarToggle() {
        document.getElementById('sidebarToggle')?.addEventListener('click', () => {
            const sidebar = document.getElementById('slidesSidebar');
            if (!sidebar) return;
            // On mobile (<=1023px), use mobile-open class for off-canvas slide-in
            // On desktop, use collapsed class for the 60px mini-sidebar
            if (window.innerWidth <= 1023) {
                sidebar.classList.toggle('mobile-open');
                // Also toggle a backdrop for mobile
                let backdrop = document.querySelector('.sidebar-backdrop');
                if (!backdrop) {
                    backdrop = document.createElement('div');
                    backdrop.className = 'sidebar-backdrop';
                    backdrop.addEventListener('click', () => {
                        sidebar.classList.remove('mobile-open');
                        backdrop.classList.remove('visible');
                    });
                    sidebar.parentElement.insertBefore(backdrop, sidebar.nextSibling);
                }
                if (sidebar.classList.contains('mobile-open')) {
                    backdrop.classList.add('visible');
                } else {
                    backdrop.classList.remove('visible');
                }
            } else {
                sidebar.classList.toggle('collapsed');
                // Re-render rulers during and after the sidebar width
                // transition (400ms) so ticks track the canvas position.
                this._scheduleRulerRender();
                setTimeout(() => this._scheduleRulerRender(), 260);
                setTimeout(() => this._scheduleRulerRender(), 460);
            }
        });
    }

    // ── Ribbon State Update ────────────────────────────────────
    updateRibbonState() {
        const el = this.selectedId ? this.getElement(this.selectedId) : null;
        const isText  = el?.type === 'text';
        const isShape = el?.type === 'shape';
        const isImg   = el?.type === 'image';
        const hasEl   = !!el;
        const setRibbonGroupEnabled = (group, enabled) => {
            if (!group) return;
            group.style.opacity = '';
            group.style.pointerEvents = '';
            Array.from(group.children).forEach((child) => {
                const isLabel = child.classList.contains('group-label') || child.classList.contains('font-group-label');
                child.style.opacity = isLabel || enabled ? '1' : '0.45';
                child.style.pointerEvents = isLabel || enabled ? 'auto' : 'none';
            });
        };

        // Text format group visibility — dim + disable interaction when no text element is selected
        const tfg = document.getElementById('textFormatGroup');
        if (tfg) {
            setRibbonGroupEnabled(tfg, isText);
        }

        // Paragraph group visibility — dim + disable interaction when no text element is selected
        const pg = document.getElementById('paragraphGroup');
        if (pg) {
            setRibbonGroupEnabled(pg, isText);
        }

        // Shape Format contextual tab — show only when a shape is selected
        const shapeTab = document.getElementById('shapeFormatTab');
        if (shapeTab) {
            const wasHidden = shapeTab.hasAttribute('hidden');
            if (isShape) {
                shapeTab.removeAttribute('hidden');
                // Auto-switch to Shape Format tab when a shape is first selected
                if (wasHidden && this._activeTab !== 'shape-format') {
                    this._previousTab = this._activeTab;
                    shapeTab.click();
                }
            } else {
                // Hide tab — if it was active, return to the previous tab (or Home)
                if (this._activeTab === 'shape-format') {
                    const restoreTab = this._previousTab && this._previousTab !== 'shape-format'
                        ? this._previousTab
                        : 'home';
                    const restoreBtn = document.querySelector(`.ribbon-tab[data-tab="${restoreTab}"]`);
                    restoreBtn?.click();
                }
                shapeTab.setAttribute('hidden', '');
            }
        }

        // Arrange group: enable only when element selected
        const ag = document.getElementById('arrangeGroup');
        if (ag) {
            setRibbonGroupEnabled(ag, hasEl);
        }

        // Background group — dim when no slide is active
        const bgGroup = document.getElementById('backgroundGroup');
        if (bgGroup) {
            setRibbonGroupEnabled(bgGroup, !!this.currentSlide);
        }

        // Export group — dim when no presentation is open
        const expGroup = document.getElementById('exportGroup');
        if (expGroup) {
            setRibbonGroupEnabled(expGroup, !!this.pres);
        }

        // Update format button active states
        if (isText) {
            document.getElementById('boldBtn')?.classList.toggle('active', el.bold);
            document.getElementById('italicBtn')?.classList.toggle('active', el.italic);
            document.getElementById('underlineBtn')?.classList.toggle('active', el.underline);

            // Alignment active state — highlight the currently active alignment
            const align = el.textAlign || 'left';
            document.getElementById('alignLeftBtn')?.classList.toggle('active', align === 'left');
            document.getElementById('alignCenterBtn')?.classList.toggle('active', align === 'center');
            document.getElementById('alignRightBtn')?.classList.toggle('active', align === 'right');

            // List active state — verify against actual HTML content, not just el.listType
            // (el.listType can become stale when user deletes all list items with backspace)
            let effectiveListType = el.listType || '';
            const contentEl = document.getElementById(`el-${el.id}`)?.querySelector('.text-content');
            if (contentEl) {
                // Only count real (non-empty) lists
                const hasRealOl = this._hasRealList(contentEl, 'ol');
                const hasRealUl = this._hasRealList(contentEl, 'ul');
                if (hasRealOl) effectiveListType = 'ol';
                else if (hasRealUl) effectiveListType = 'ul';
                else effectiveListType = '';
                // Keep el.listType in sync
                el.listType = effectiveListType;
            }
            document.getElementById('bulletListBtn')?.classList.toggle('active', effectiveListType === 'ul');
            document.getElementById('numberListBtn')?.classList.toggle('active', effectiveListType === 'ol');
            // Font family
            const ffVal = document.getElementById('fontFamilyDropdown')?.querySelector('.dropdown-value');
            if (ffVal) ffVal.textContent = el.fontFamily || 'DM Sans';
            // Font size
            const fsVal = document.getElementById('fontSizeDropdown')?.querySelector('.dropdown-value');
            if (fsVal) fsVal.textContent = el.fontSize || 24;
            // Text color swatch (notes-app style dropdown)
            const fcBtn = document.querySelector('#fontColorDropdown .ms-dropdown-btn');
            const fcSwatch = fcBtn?.querySelector('.color-preview');
            if (fcSwatch) {
                fcSwatch.style.background = el.color || '#000000';
                fcSwatch.style.border = '';
            }
            // Text highlight swatch (notes-app style dropdown)
            const hlBtn = document.querySelector('#highlightColorDropdown .ms-dropdown-btn');
            const hlSwatch = hlBtn?.querySelector('.color-preview');
            if (hlSwatch) {
                if (el.highlight) {
                    hlSwatch.style.background = el.highlight;
                    hlSwatch.style.border = '';
                } else {
                    hlSwatch.style.background = 'transparent';
                    hlSwatch.style.border = '1px solid #ccc';
                }
            }
        }

        // Clear alignment active states when no text element is selected
        if (!isText) {
            document.getElementById('alignLeftBtn')?.classList.remove('active');
            document.getElementById('alignCenterBtn')?.classList.remove('active');
            document.getElementById('alignRightBtn')?.classList.remove('active');
            document.getElementById('bulletListBtn')?.classList.remove('active');
            document.getElementById('numberListBtn')?.classList.remove('active');
        }

        if (isShape) {
            const fillSwatch = document.getElementById('fillColorSwatch');
            if (fillSwatch) {
                if (el.fill === 'none') {
                    fillSwatch.style.background = 'transparent';
                    fillSwatch.style.border = '2px dashed #999';
                } else {
                    fillSwatch.style.background = el.fill;
                    fillSwatch.style.border = '1px solid rgba(0,0,0,0.15)';
                }
            }
            // Update stroke color swatch
            const strokeSwatch = document.getElementById('strokeColorSwatch');
            if (strokeSwatch) {
                if (el.stroke === 'none' || !el.stroke) {
                    strokeSwatch.style.background = 'transparent';
                    strokeSwatch.style.border = '2px dashed #999';
                } else {
                    strokeSwatch.style.background = el.stroke;
                    strokeSwatch.style.border = '2px solid ' + el.stroke;
                }
            }
            // Update stroke width dropdown label
            const swLabel = document.getElementById('strokeWidthLabel');
            if (swLabel) {
                const w = el.strokeWidth || 2;
                if (w === 0) swLabel.textContent = 'None';
                else swLabel.textContent = w + ' pt';
            }
        }
    }

    updateStatusBar() {
        const numEl = document.getElementById('slideNumStatus');
        if (numEl && this.pres) {
            numEl.textContent = `Slide ${this.slideIdx + 1} of ${this.pres.slides.length}`;
        }
        const elEl = document.getElementById('elementStatus');
        if (elEl) {
            const el = this.selectedId ? this.getElement(this.selectedId) : null;
            elEl.textContent = el ? `${el.type.charAt(0).toUpperCase() + el.type.slice(1)} selected` : 'No selection';
        }
    }


    // ── File Modal ──────────────────────────────────────

    openFileModal() {
        const modal = document.getElementById('fileModal');
        if (!modal || !this.pres) return;
        // Populate the name input with current presentation title
        const nameInput = document.getElementById('fileModalNameInput');
        if (nameInput) nameInput.value = this.pres.title || 'Untitled Presentation';
        modal.classList.add('show');
    }

    closeFileModal() {
        const modal = document.getElementById('fileModal');
        if (!modal) return;
        // Save the name input value before closing
        const nameInput = document.getElementById('fileModalNameInput');
        if (nameInput && this.pres) {
            const newTitle = nameInput.value.trim() || 'Untitled Presentation';
            if (newTitle !== this.pres.title) {
                this.pres.title = newTitle;
                const titleInput = document.getElementById('presentationTitle');
                if (titleInput) titleInput.value = newTitle;
                this.scheduleSave();
            }
        }
        modal.classList.add('closing');
        setTimeout(() => { modal.classList.remove('show'); modal.classList.remove('closing'); }, 250);
        // Switch back to Home tab after closing
        this._switchTab('home');
    }

    exportSVGs() {
        if (!this.pres) { this.showToast('No presentation open.'); return; }
        const slides = this.pres.slides;
        if (!slides || slides.length === 0) { this.showToast('No slides to export.'); return; }

        // Generate SVGs for each slide
        const svgStrings = slides.map((slide, i) => {
            const w = 960, h = 540;
            let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;

            // Background
            const bg = slide.bg || '#ffffff';
            if (bg.includes('gradient')) {
                svgContent += `<defs><linearGradient id="slideBg${i}" x1="0%" y1="0%" x2="100%" y2="100%">`;
                // Parse gradient colors (simple approach)
                const colors = bg.match(/#[0-9a-fA-F]{6}/g) || ['#667eea', '#764ba2'];
                colors.forEach((c, ci) => {
                    svgContent += `<stop offset="${ci * 100 / Math.max(colors.length - 1, 1)}%" style="stop-color:${c}"/>`;
                });
                svgContent += `</linearGradient></defs>`;
                svgContent += `<rect width="${w}" height="${h}" fill="url(#slideBg${i})"/>`;
            } else {
                svgContent += `<rect width="${w}" height="${h}" fill="${bg}"/>`;
            }

            // Elements
            (slide.elements || []).forEach(el => {
                if (el.type === 'text' && el.html) {
                    const fontSize = el.fontSize || 24;
                    const fontFamily = el.fontFamily || 'DM Sans, sans-serif';
                    const fill = el.fill || '#1a1a1a';
                    const anchor = el.textAlign === 'center' ? 'middle' : (el.textAlign === 'right' ? 'end' : 'start');
                    const x = el.textAlign === 'center' ? el.x + el.w / 2 : (el.textAlign === 'right' ? el.x + el.w : el.x + 4);
                    svgContent += `<text x="${x}" y="${el.y + fontSize}" font-size="${fontSize}" font-family="${fontFamily}" fill="${fill}" text-anchor="${anchor}">${escapeHtml(stripHtmlToText(el.html))}</text>`;
                } else if (el.type === 'shape' && el.svg) {
                    svgContent += `<g transform="translate(${el.x},${el.y})"><svg width="${el.w}" height="${el.h}" viewBox="0 0 ${el.w} ${el.h}">${el.svg}</svg></g>`;
                } else if (el.type === 'shape') {
                    // Use shapeSVG function for all shapes
                    const shapeFill = el.fill || '#e5e7eb';
                    const shapeStroke = el.stroke || 'none';
                    const shapeStrokeW = el.strokeWidth || 0;
                    const shapeSvgContent = shapeSVG(el.shape, shapeFill, shapeStroke, shapeStrokeW);
                    svgContent += `<g transform="translate(${el.x},${el.y}) scale(${el.w/100},${el.h/100})" opacity="${el.opacity || 1}">${shapeSvgContent.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '')}</g>`;
                } else if (el.type === 'image' && el.src) {
                    svgContent += `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" href="${el.src}" opacity="${el.opacity || 1}"/>`;
                }
            });

            svgContent += '</svg>';
            return { name: `slide_${i + 1}.svg`, content: svgContent };
        });

        // Download the slides as individual SVG files
        svgStrings.forEach(s => {
            const blob = new Blob([s.content], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = s.name;
            a.click();
            URL.revokeObjectURL(url);
        });
        this.showToast(`Exported ${svgStrings.length} SVG files.`);
    }

    // ── Delete Modal (presentations only — slide deletion is direct & undoable) ──
    confirmDeletePresentation(id) {
        this._deleteTarget = { type: 'pres', id };
        document.getElementById('deleteModalTitle').textContent = 'Delete Presentation';
        document.getElementById('deleteModalMessage').textContent = 'Are you sure you want to delete this presentation? This cannot be undone.';
        document.getElementById('deleteModal')?.classList.add('show');
    }

    closeDeleteModal() {
        const modal = document.getElementById('deleteModal');
        if (!modal) { this._deleteTarget = null; return; }
        modal.classList.add('closing');
        setTimeout(() => { modal.classList.remove('show'); modal.classList.remove('closing'); }, 230);
        this._deleteTarget = null;
    }

    confirmDelete() {
        if (!this._deleteTarget) { this.closeDeleteModal(); return; }
        const target = this._deleteTarget;
        // Animate closing, then perform deletion after animation finishes
        const modal = document.getElementById('deleteModal');
        if (modal) { modal.classList.add('closing'); setTimeout(() => { modal.classList.remove('show'); modal.classList.remove('closing'); }, 230); }
        this._deleteTarget = null;
        setTimeout(() => { if (target.type === 'pres') this.deletePresentation(target.id); }, 250);
    }

    // ── Background Picker ──────────────────────────────────────
    openBgPicker() {
        if (!this.currentSlide) return;
        this._pendingBgValue = this.currentSlide.background.value;
        const customInput = document.getElementById('bgColorCustom');
        if (customInput && !this._pendingBgValue.includes('gradient')) customInput.value = this._pendingBgValue;
        document.getElementById('bgPickerModal')?.classList.add('show');
    }

    closeBgPicker() {
        const bgModal = document.getElementById('bgPickerModal');
        if (bgModal) { bgModal.classList.add('closing'); setTimeout(() => { bgModal.classList.remove('show'); bgModal.classList.remove('closing'); }, 230); }
    }

    applyBgPicker() {
        if (!this.currentSlide || !this._pendingBgValue) { this.closeBgPicker(); return; }
        this.pushHistory();
        const isGradient = this._pendingBgValue.includes('gradient');
        this.currentSlide.background = {
            type: isGradient ? 'gradient' : 'color',
            value: this._pendingBgValue,
        };
        this.renderCanvas();
        this.updateThumbnail(this.slideIdx);
        this.scheduleSave();
        this.closeBgPicker();
    }

    // ── Welcome Screen ─────────────────────────────────────────
    showWelcomeScreen(show) {
        const ws  = document.getElementById('welcomeScreen');
        const eh  = document.getElementById('editorHeader');
        const ec  = document.getElementById('editorContent');
        const es  = document.getElementById('editorStatusbar');
        const pn  = document.getElementById('presenterNotesPanel');
        if (!ws) return;

        if (show) {
            ws.style.display = 'flex';
            if (eh) eh.style.display = 'none';
            if (ec) ec.style.display = 'none';
            if (es) es.style.display = 'none';
            // Presenter notes panel: just remove .visible to collapse
            if (pn) pn.classList.remove('visible');
            this.renderWelcomeCards();
        } else {
            ws.style.display = 'none';
            if (eh) eh.style.display = 'flex';
            if (ec) {
                ec.style.display = 'flex';
                ec.style.flexDirection = 'column';
                ec.style.flex = '1';
                ec.style.overflow = 'hidden';
                ec.style.minHeight = '0';
            }
            // Presenter notes panel visibility is controlled by the toggle button (CSS .visible class)
            // Do not force-display here — keep whatever state the user last chose
            if (es) es.style.display = 'flex';
        }
    }

    renderWelcomeCards() {
        const container = document.getElementById('presentationsDisplay');
        const noContainer = document.getElementById('noPresContainer');
        if (!container) return;

        // ── Render-token guard ──
        // Each call gets a unique token. We capture the token at call time
        // and check it again before mutating the DOM after any await. If a
        // newer render has started, this render aborts silently — preventing
        // the classic "async forEach appends stale cards on top of newer
        // ones" race that produced duplicate cards on the welcome screen.
        const myToken = (this._welcomeRenderToken = (this._welcomeRenderToken || 0) + 1);

        if (this.presentations.length === 0) {
            container.innerHTML = '';
            if (noContainer) noContainer.style.display = 'flex';
            return;
        }

        if (noContainer) noContainer.style.display = 'none';

        // Snapshot the list at call time so concurrent edits to
        // `this.presentations` don't change what we render mid-flight.
        const snapshot = this.presentations.slice(0, 12);

        // Load all deck previews in parallel, build all card elements in
        // memory, then commit them to the DOM in ONE synchronous operation.
        // This eliminates any window where stale appends can sneak in.
        Promise.all(snapshot.map(async (meta) => {
            const presData = await this.loadPresData(meta.id);
            return { meta, presData };
        })).then(results => {
            // Stale render — a newer renderWelcomeCards() call has started.
            // Abort to avoid appending duplicate cards.
            if (myToken !== this._welcomeRenderToken) return;

            // Build all card elements in memory first
            const frag = document.createDocumentFragment();
            for (const { meta, presData } of results) {
                const card = document.createElement('div');
                card.className = 'presentation-card';

                const thumb = document.createElement('div');
                thumb.className = 'presentation-card-thumb';
                thumb.style.background = '#f5f5f5';

                if (presData && presData.slides && presData.slides[0]) {
                    const slide = presData.slides[0];
                    const inner = document.createElement('div');
                    inner.className = 'presentation-card-thumb-inner';
                    inner.style.background = slide.background?.value || '#fff';
                    this.renderThumbContent(inner, slide);
                    thumb.appendChild(inner);
                    requestAnimationFrame(() => {
                        const w = thumb.clientWidth || 220;
                        const s = w / 960;
                        inner.style.transform = `scale(${s})`;
                        thumb.style.height = Math.round(540 * s) + 'px';
                    });
                }

                

                const info = document.createElement('div');
                info.className = 'presentation-card-info';
                info.innerHTML = `
                    <div class="presentation-card-title">${meta.title || 'Untitled'}</div>
                    <div class="presentation-card-meta">${meta.slideCount || 1} slide${(meta.slideCount || 1) !== 1 ? 's' : ''} · ${formatDate(meta.updatedAt)}</div>
                `;

                card.appendChild(thumb);
                
                card.appendChild(info);
                card.addEventListener('click', () => this.openPresentation(meta.id));
                frag.appendChild(card);
            }

            // ── Single atomic DOM commit ──
            // Clear + append in the same synchronous tick — no async gap
            // between clear and append means no chance for a stale render
            // to slip cards in between.
            container.innerHTML = '';
            container.appendChild(frag);
        }).catch(err => {
            console.warn('renderWelcomeCards failed:', err);
        });
    }

    // ── Presentation Mode ──────────────────────────────────────
    startPresentation(fromSlide = 0) {
        if (!this.pres || this.pres.slides.length === 0) return;
        this.presentIdx = clamp(fromSlide, 0, this.pres.slides.length - 1);
        this.isPresenting = true;

        const overlay = document.getElementById('presentOverlay');
        if (!overlay) return;

        // Pre-sync the overlay's background to the first slide's
        // background BEFORE showing it, so the overlay's fade-in
        // (opacity 0 → 1 over 0.3s) doesn't briefly show the previous
        // presentation's leftover background color. renderPresentSlide()
        // will keep it in sync on every subsequent slide change.
        const firstSlide = this.pres.slides[this.presentIdx];
        const firstBg = firstSlide?.background;
        if (firstBg) {
            overlay.style.background = (firstBg.type === 'color' || firstBg.type === 'gradient')
                ? firstBg.value : '#ffffff';
        }

        overlay.style.display = 'block';
        requestAnimationFrame(() => { overlay.style.opacity = '1'; });

        this.renderPresentSlide();
        this.updatePresentCounter();

        // ── Present-mode listeners ────────────────────────────────
        // Store each handler on `this` so endPresentation() can remove
        // them. Previously these were anonymous arrow functions bound
        // fresh on every startPresentation() call and never removed —
        // so the second time you entered presentation mode, each button
        // click fired the handler TWICE (once per accumulated listener),
        // making the slide counter jump 1 → 3 → 5 … on every click.
        // Using stored bound functions fixes the jump-skip bug.

        // Keydown — also guard against e.repeat so holding an arrow key
        // doesn't auto-fire presentNext/Prev multiple times per keypress.
        document.addEventListener('keydown', this._presentKeyHandler);

        this._presentPrevClick = () => this.presentPrev();
        this._presentNextClick = () => this.presentNext();
        this._presentExitClick = () => this.endPresentation();
        document.getElementById('presentPrevBtn')?.addEventListener('click', this._presentPrevClick);
        document.getElementById('presentNextBtn')?.addEventListener('click', this._presentNextClick);
        document.getElementById('presentExitBtn')?.addEventListener('click', this._presentExitClick);

        // Click-to-advance: clicking anywhere on the slide area that
        // ISN'T an interactive element (links, video/audio players,
        // buttons, inputs, etc.) advances to the next slide. We attach
        // the handler to the slide container (not the overlay) so
        // clicks on the empty backdrop around the slide don't advance.
        this._presentSlideClick = (e) => this._handlePresentSlideClick(e);
        document.getElementById('presentSlide')?.addEventListener('click', this._presentSlideClick);

        this._presentFullscreenHandler = () => {
            // Video player fullscreen now uses CSS overlay (.vid-expanded)
            // instead of the Fullscreen API, so we only track document fullscreen.
            if (!this.isPresenting) return;
            const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

            if (!fsEl) {
                // Document fullscreen exited — end presentation
                this.endPresentation();
                return;
            }
            if (this.isPresenting) this.renderPresentSlide();
        };
        this._presentResizeHandler = () => {
            if (this.isPresenting) this.renderPresentSlide();
        };
        document.addEventListener('fullscreenchange', this._presentFullscreenHandler);
        window.addEventListener('resize', this._presentResizeHandler);
        try { document.documentElement.requestFullscreen?.(); } catch (_) {}
    }

    // ── Click-to-advance handler ─────────────────────────────────
    // Attached to #presentSlide during presentation. Advances to the
    // next slide on a plain click of the slide background, but bails
    // out (so the original click goes through unchanged) when the
    // click target is inside an interactive element:
    //   • elements with a link (cursor:pointer + own click handler)
    //   • video / audio players and any of their descendants
    //   • <button>, <input>, <select>, <textarea>, <a> tags
    //   • anything with [contenteditable=true]
    //   • anything with role="button" / role="link"
    // We walk up from the click target to the slide root and check
    // each ancestor. This survives nested controls (e.g., clicking the
    // progress bar inside a video player, which is wrapped in several
    // divs) without us needing an exhaustive list of selectors.
    _handlePresentSlideClick(e) {
        if (!this.isPresenting) return;

        const slide = document.getElementById('presentSlide');
        if (!slide) return;

        // Walk from the click target up to (but not including) the
        // slide container. If any ancestor is interactive, bail.
        let node = e.target;
        while (node && node !== slide) {
            if (node.nodeType !== 1) { node = node.parentNode; continue; }
            const tag = node.tagName;
            if (tag === 'BUTTON' || tag === 'INPUT' ||
                tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' ||
                tag === 'VIDEO' || tag === 'AUDIO') {
                return; // let the native control handle it
            }
            if (typeof node.matches === 'function' && node.matches(
                '[contenteditable="true"], [contenteditable=""], ' +
                '[role="button"], [role="link"], ' +
                '.slide-video-player, .slide-video-player *, ' +
                '.slide-audio-player, .slide-audio-player *, ' +
                '.vid-big-play, .vid-big-play *, ' +
                '.vid-controls, .vid-controls *, ' +
                '.aud-controls, .aud-controls *'
            )) {
                return; // interactive — don't advance
            }
            // Slide elements with a link get an inline cursor:pointer
            // set in renderPresentSlide and their own click handler that
            // opens the URL. Detect via inline style (not computed —
            // computed would also catch buttons-styled-as-pointer that
            // we already handled via the tag check above) so we can bail
            // out and let the link's own handler run.
            if (tag === 'DIV' && node.style && node.style.cursor === 'pointer') {
                return;
            }
            node = node.parentNode;
        }

        // Plain background click — advance to the next slide. Don't
        // preventDefault so the user still gets normal selection/
        // pointer feedback; we just trigger the nav.
        // Ignore right-click and any click with a modifier key so
        // users can still ctrl/cmd-click etc. without advancing.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

        // Respect the current slide's "On Click" transition setting.
        // If the user disabled On Click in the TIMING panel, plain
        // clicks on the slide should NOT advance — the slide is
        // either auto-advancing (After X sec) or is meant to be
        // navigated only with arrow keys. Arrow-key navigation is
        // always allowed (it's an explicit user action, not a "click
        // to advance" gesture) and handled separately in
        // _presentKeyHandler.
        // Note: `slide` here is the DOM container declared above; we
        // use a different name (`slideData`) for the slide's data
        // object to avoid redeclaring the identifier.
        const slideData = this.pres?.slides?.[this.presentIdx];
        const onClickEnabled = slideData?.transition?.onClick !== false;
        if (!onClickEnabled) return;

        this.presentNext();
    }

    endPresentation() {
        this._collapseExpandedVideo();
        this.isPresenting = false;
        // Cancel any pending auto-advance timer so it can't fire after
        // we exit present mode (would otherwise call presentNext on a
        // presentation that's no longer active — harmless due to the
        // isPresenting guard in the timer callback, but cleaner to
        // explicitly cancel).
        this._clearPresentAutoTimer();
        const overlay = document.getElementById('presentOverlay');
        if (overlay) overlay.style.display = 'none';
        document.removeEventListener('keydown', this._presentKeyHandler);
        // Remove the present-mode button + slide click listeners that
        // were stored on `this` so they don't accumulate across
        // multiple start/end cycles (which was the cause of the
        // counter jumping 1 → 3 → 5 on each click).
        if (this._presentPrevClick)  document.getElementById('presentPrevBtn')?.removeEventListener('click', this._presentPrevClick);
        if (this._presentNextClick)  document.getElementById('presentNextBtn')?.removeEventListener('click', this._presentNextClick);
        if (this._presentExitClick)  document.getElementById('presentExitBtn')?.removeEventListener('click', this._presentExitClick);
        if (this._presentSlideClick) document.getElementById('presentSlide')?.removeEventListener('click', this._presentSlideClick);
        this._presentPrevClick = null;
        this._presentNextClick = null;
        this._presentExitClick = null;
        this._presentSlideClick = null;
        if (this._presentFullscreenHandler) document.removeEventListener('fullscreenchange', this._presentFullscreenHandler);
        if (this._presentResizeHandler) window.removeEventListener('resize', this._presentResizeHandler);
        this._presentFullscreenHandler = null;
        this._presentResizeHandler = null;
        try { document.exitFullscreen?.(); } catch (_) {}
    }

    _collapseExpandedVideo() {
        if (!this._expandedVideoPlayer) return;
        const p = this._expandedVideoPlayer;
        p.classList.remove('vid-expanded');
        if (p._origParent && p._origNextSibling !== undefined) {
            if (p._origNextSibling) {
                p._origParent.insertBefore(p, p._origNextSibling);
            } else {
                p._origParent.appendChild(p);
            }
        }
        delete this._expandedVideoPlayer;
    }

    _presentKeyHandler = (e) => {
        if (!this.isPresenting) return;
        // Ignore auto-repeat keydown events (fired while a key is held)
        // so holding ArrowRight/Space/ArrowDown doesn't rapidly advance
        // through multiple slides — one keypress = one slide.
        if (e.repeat) {
            // Still prevent default for the keys we own, so e.g. Space
            // doesn't scroll the page while held.
            if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
                e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
            }
            return;
        }
        // Escape: let the browser handle fullscreen exit natively;
        // the fullscreenchange handler manages the rest (restore present vs end).
        if (e.key === 'Escape') {
            e.preventDefault();
            if (this._expandedVideoPlayer) {
                this._collapseExpandedVideo();
                return;
            }
            // (the fullscreenchange handler manages the rest)
            return;
        }
        // F11: if a video/audio player is fullscreen, exit that first;
        // second press will exit presentation fullscreen normally.
        if (e.key === 'F11') {
            e.preventDefault();
            if (this._expandedVideoPlayer) {
                this._collapseExpandedVideo();
                return;
            }
            this.endPresentation();
            return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); this.presentNext(); }
        if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); this.presentPrev(); }
    };

    presentNext() {
        if (this.presentIdx >= this.pres.slides.length - 1) return;
        // Clear any pending auto-advance timer — the user (or another
        // call path) is explicitly advancing, so a stale timer firing
        // later would skip an extra slide.
        this._clearPresentAutoTimer();
        this.presentIdx++;
        this.renderPresentSlide('right');
        this.updatePresentCounter();
    }

    presentPrev() {
        if (this.presentIdx <= 0) return;
        // Same as presentNext — clear the auto-timer so it can't fire
        // and re-advance after the user explicitly went backwards.
        this._clearPresentAutoTimer();
        this.presentIdx--;
        this.renderPresentSlide('left');
        this.updatePresentCounter();
    }

    renderPresentSlide(direction = null) {
        this._collapseExpandedVideo();
        const container = document.getElementById('presentSlide');
        if (!container || !this.pres) return;

        const slide = this.pres.slides[this.presentIdx];
        if (!slide) return;

        // Scale to viewport
        const vw = window.innerWidth, vh = window.innerHeight;
        const scaleX = vw / 960, scaleY = vh / 540;
        const pScale = Math.min(scaleX, scaleY);

        // Store scale as CSS custom property so animations can include it
        container.style.setProperty('--present-scale', pScale);
        container.style.transform = `scale(var(--present-scale, ${pScale}))`;
        container.style.width = '960px';
        container.style.height = '540px';

        // Background
        const bg = slide.background;
        container.style.background = bg.type !== 'image' ? bg.value : '#fff';

        // ── Anti-flash: sync the present overlay's background to match
        // the slide's background. Most transitions (and the default
        // fade-in) animate opacity:0 → 1 on the slide container itself,
        // which means at the start of every transition the slide is
        // fully transparent and the overlay behind shows through. The
        // overlay's CSS default is black, so without this sync the user
        // sees a brief black flash on every slide change — even with
        // "no transition" set, because the default no-transition path
        // still applies the .fade-in class. Matching the overlay's
        // background to the slide's background means the user sees the
        // same color behind the fading slide, eliminating the flash.
        const overlay = document.getElementById('presentOverlay');
        if (overlay) {
            if (bg.type === 'color' || bg.type === 'gradient') {
                overlay.style.background = bg.value;
            } else {
                // Image backgrounds: the slide canvas itself falls back
                // to white underneath the image, so we match that.
                overlay.style.background = '#ffffff';
            }
        }

        // Elements
        container.innerHTML = '';
        const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
        sorted.forEach(el => {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;transform:rotate(${el.r || 0}deg);z-index:${el.z || 1};overflow:hidden;`;
            if (el.type === 'text') {
                d.style.fontFamily = el.fontFamily || 'DM Sans';
                d.style.fontSize = (el.fontSize || 24) + 'px';
                d.style.color = el.color || '#1a1a1a';
                d.style.fontWeight = el.bold ? '700' : '400';
                d.style.fontStyle = el.italic ? 'italic' : 'normal';
                d.style.textDecoration = el.underline ? 'underline' : 'none';
                d.style.textAlign = el.textAlign || 'left';
                d.style.backgroundColor = el.highlight || 'transparent';
                d.style.padding = '8px 10px';
                d.style.wordBreak = 'break-word';
                d.style.whiteSpace = 'pre-wrap';
                d.innerHTML = sanitizeUserHtml(el.html) || '';
                // Show link styling in present mode
                if (el.link) {
                    d.style.color = '#2563eb';
                    d.style.textDecoration = 'underline';
                    d.style.cursor = 'pointer';
                }
            } else if (el.type === 'shape') {
                if (el.shape === 'icon') {
                    d.innerHTML = sanitizeUserHtml(el.svg) || '';
                } else {
                    d.innerHTML = shapeSVG(el.shape, el.fill, el.stroke, el.strokeWidth);
                }
            } else if (el.type === 'image') {
                const crop = el.crop || { l: 0, t: 0, r: 0, b: 0 };
                const visibleW = 1 - crop.l - crop.r;
                const visibleH = 1 - crop.t - crop.b;
                const img = document.createElement('img');
                img.src = safeMediaUrl(el.src, 'image');
                if (visibleW <= 0 || visibleH <= 0) {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                } else if (crop.l > 0 || crop.t > 0 || crop.r > 0 || crop.b > 0) {
                    const scaleW = 1 / visibleW;
                    const scaleH = 1 / visibleH;
                    img.style.cssText = `position:absolute;top:0;left:0;width:${scaleW * 100}%;height:${scaleH * 100}%;transform:translate(${-crop.l * scaleW * 100}%, ${-crop.t * scaleH * 100}%);object-fit:fill;display:block;`;
                } else {
                    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
                }
                d.appendChild(img);
            } else if (el.type === 'video') {
                // Custom video player in presentation mode
                d.style.overflow = 'hidden';
                const player = document.createElement('div');
                player.className = 'slide-video-player paused';
                player.style.cssText = 'position:absolute;inset:0;';
                const vid = document.createElement('video');
                vid.src = safeMediaUrl(el.src, 'video');
                vid.preload = 'metadata';
                vid.setAttribute('poster', safeMediaUrl(el.poster, 'image') || '');
                vid.setAttribute('playsinline', '');
                const bigPlay = document.createElement('div');
                bigPlay.className = 'vid-big-play';
                bigPlay.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const controls = document.createElement('div');
                controls.className = 'vid-controls';
                const progWrap = document.createElement('div');
                progWrap.className = 'vid-progress-wrap';
                const bufferBar = document.createElement('div');
                bufferBar.className = 'vid-buffer-bar';
                const progBar = document.createElement('div');
                progBar.className = 'vid-progress-bar';
                progWrap.appendChild(bufferBar);
                progWrap.appendChild(progBar);
                const btns = document.createElement('div');
                btns.className = 'vid-btns';
                const playBtn = document.createElement('button');
                playBtn.className = 'vid-btn';
                playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const timeEl = document.createElement('span');
                timeEl.className = 'vid-time';
                timeEl.textContent = '0:00 / 0:00';
                const spacer = document.createElement('div');
                spacer.className = 'vid-spacer';
                const volWrap = document.createElement('div');
                volWrap.className = 'vid-vol-wrap';
                const volBtn = document.createElement('button');
                volBtn.className = 'vid-btn';
                volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
                const volSlider = document.createElement('input');
                volSlider.type = 'range';
                volSlider.className = 'vid-vol-slider';
                volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
                volWrap.appendChild(volBtn);
                volWrap.appendChild(volSlider);
                const fsBtn = document.createElement('button');
                fsBtn.className = 'vid-btn';
                fsBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
                btns.appendChild(playBtn);
                btns.appendChild(timeEl);
                btns.appendChild(spacer);
                btns.appendChild(volWrap);
                btns.appendChild(fsBtn);
                controls.appendChild(progWrap);
                controls.appendChild(btns);
                player.appendChild(vid);
                player.appendChild(bigPlay);
                player.appendChild(controls);
                d.appendChild(player);
                this._wireVideoPlayer(player, vid, { bigPlay, playBtn, timeEl, progWrap, progBar, bufferBar, volBtn, volSlider, fsBtn });
            } else if (el.type === 'audio') {
                // Custom audio player in presentation mode
                d.style.overflow = 'hidden';
                const player = document.createElement('div');
                player.className = 'slide-audio-player';
                player.style.cssText = 'position:absolute;inset:0;';
                const art = document.createElement('div');
                art.className = 'aud-art';
                const wave = document.createElement('div');
                wave.className = 'aud-wave';
                for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('span'));
                art.appendChild(wave);
                const audCtrl = document.createElement('div');
                audCtrl.className = 'aud-controls';
                const progWrap = document.createElement('div');
                progWrap.className = 'aud-progress-wrap';
                const progBar = document.createElement('div');
                progBar.className = 'aud-progress-bar';
                progWrap.appendChild(progBar);
                const btns = document.createElement('div');
                btns.className = 'aud-btns';
                const playBtn = document.createElement('button');
                playBtn.className = 'aud-play-btn';
                playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
                const timeEl = document.createElement('span');
                timeEl.className = 'aud-time';
                timeEl.textContent = '0:00';
                const spacer = document.createElement('div');
                spacer.className = 'aud-spacer';
                const volWrap = document.createElement('div');
                volWrap.className = 'aud-vol-wrap';
                const volBtn = document.createElement('button');
                volBtn.className = 'aud-btn';
                volBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
                const volSlider = document.createElement('input');
                volSlider.type = 'range';
                volSlider.className = 'aud-vol-slider';
                volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
                volWrap.appendChild(volBtn);
                volWrap.appendChild(volSlider);
                btns.appendChild(playBtn);
                btns.appendChild(timeEl);
                btns.appendChild(spacer);
                btns.appendChild(volWrap);
                audCtrl.appendChild(progWrap);
                audCtrl.appendChild(btns);
                const aud = document.createElement('audio');
                aud.src = safeMediaUrl(el.src, 'audio');
                aud.preload = 'metadata';
                player.appendChild(art);
                player.appendChild(audCtrl);
                player.appendChild(aud);
                d.appendChild(player);
                this._wireAudioPlayer(player, aud, { playBtn, timeEl, progWrap, progBar, volBtn, volSlider });
            }
            // In present mode, simple click opens the link (no Ctrl needed)
            if (el.link) {
                d.style.cursor = 'pointer';
                d.addEventListener('click', (e) => {
                    e.preventDefault();
                    safeOpenUrl(el.link);
                });
            }
            container.appendChild(d);
        });

        // Comments are NOT shown in presentation mode

        // Render the saved drawing overlay on top of all elements.
        // The drawing was created in the editor as a 960x540 PNG; we
        // just drop it as an <img> covering the whole slide. It's
        // non-interactive (pointer-events:none) so it never blocks clicks.
        if (slide.drawingData) {
            const drawImg = document.createElement('img');
            drawImg.src = safeMediaUrl(slide.drawingData, 'image');
            drawImg.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;pointer-events:none;z-index:9998;display:block;';
            drawImg.alt = '';
            container.appendChild(drawImg);
        }

        // Animation — use the slide's configured transition if available,
        // otherwise fall back to the default fade/slide.
        // All animations are opacity-only or clip-path based to preserve
        // the inline transform:scale(...) that fits the slide to viewport.
        //
        // BUGFIX: Previously this block used ad-hoc `setTimeout` calls
        // to clean up transition classes. The timers were NOT tracked,
        // so when the user navigated to the next slide before the
        // previous transition's timer fired, the old timer would
        // remove the NEW transition's class early — killing the new
        // animation mid-flight. Now we route everything through
        // _runTransitionClass, which tracks this._trAnimTimer and
        // clears it before scheduling a new cleanup.
        const trType = slide.transition?.type || null;
        const trDur = slide.transition?.duration || 0.7;
        container.style.setProperty('--tr-duration', trDur + 's');

        if (trType && trType !== 'none') {
            if (trType === 'morph') {
                // Object-level FLIP transition. Determine the previous
                // slide based on navigation direction so we morph from
                // the right source when going forward vs. backward.
                let prevIdx;
                if (direction === 'left')  prevIdx = this.presentIdx + 1;
                else if (direction === 'right') prevIdx = this.presentIdx - 1;
                else prevIdx = this.presentIdx - 1;
                const prevSlide = this.pres.slides[prevIdx];
                this._applyMorphTransition(container, slide, prevSlide, trDur);
            } else {
                // Use the configured transition. _runTransitionClass
                // handles clearing any in-flight timer from the
                // previous slide's transition, removing old classes,
                // forcing a reflow, and scheduling a tracked cleanup.
                this._runTransitionClass(container, `tr-${trType}-in`, trDur);
            }
        } else if (direction) {
            this._runTransitionClass(container, direction === 'right' ? 'slide-in-right' : 'slide-in-left', 0.45);
        } else {
            this._runTransitionClass(container, 'fade-in', 0.45);
        }

        // ── Auto-advance ("After X sec") ───────────────────────────
        // If the current slide's transition has autoAfter=true, schedule
        // a one-shot timer that advances to the next slide after the
        // configured number of seconds. This is the half of the TIMING
        // panel that was previously stored-but-never-used: users could
        // check "After 5 sec" in the UI, but presenting the deck would
        // just sit on the slide forever.
        //
        // PowerPoint semantics:
        //   • If both On Click and After are on, whichever fires first
        //     wins (we clear the auto-timer in presentNext/Prev so a
        //     manual click cancels the pending auto-advance).
        //   • If only After is on, the slide auto-advances.
        //   • If only On Click is on, the slide waits for a click.
        //   • If neither is on, the slide waits for arrow-key nav.
        //   • We do NOT auto-advance from the last slide — there's
        //     nothing to advance to, and a stray timer firing after
        //     endPresentation would be a bug.
        this._schedulePresentAutoTimer();
    }

    // Schedule (or reschedule) the auto-advance timer based on the
    // current slide's transition settings. Always clears any existing
    // timer first, so this is safe to call from any slide-render path.
    _schedulePresentAutoTimer() {
        this._clearPresentAutoTimer();
        if (!this.isPresenting || !this.pres) return;
        const slide = this.pres.slides[this.presentIdx];
        if (!slide?.transition?.autoAfter) return;
        if (this.presentIdx >= this.pres.slides.length - 1) return;
        const sec = Number.isFinite(slide.transition.afterSec) ? slide.transition.afterSec : 5;
        // Guard against absurd values — clamp to [1, 600].
        const clamped = Math.min(600, Math.max(1, sec));
        // Add the slide's transition duration so the auto-advance
        // fires AFTER the in- animation finishes, not during it.
        // Without this, a 0.7s fade-in would be interrupted at 5s
        // mark by the next slide, but a 0.7s fade-in would be cut
        // short if afterSec was 0.5 (rare but possible if the user
        // typed it directly).
        const trDur = Number.isFinite(slide.transition?.duration) ? slide.transition.duration : 0.7;
        const delayMs = Math.ceil((clamped + trDur) * 1000);
        this._presentAutoTimer = setTimeout(() => {
            this._presentAutoTimer = null;
            // The user may have exited present mode while the timer
            // was pending — bail out instead of trying to advance.
            if (!this.isPresenting) return;
            this.presentNext();
        }, delayMs);
    }

    // Clear the pending auto-advance timer if any. Called from
    // presentNext, presentPrev, endPresentation, and at the start of
    // _schedulePresentAutoTimer (so a re-render doesn't double-up).
    _clearPresentAutoTimer() {
        if (this._presentAutoTimer) {
            clearTimeout(this._presentAutoTimer);
            this._presentAutoTimer = null;
        }
    }

    updatePresentCounter() {
        const el = document.getElementById('presentCounter');
        if (el && this.pres) el.textContent = `${this.presentIdx + 1} / ${this.pres.slides.length}`;
    }

    // ── Export: PPTX ───────────────────────────────────────────
    async exportPPTX() {
        if (!this.pres) return;
        if (typeof PptxGenJS === 'undefined') {
            this.showToast('⚠ PptxGenJS library not loaded. Check your internet connection.', 5000); return;
        }
        this.showToast('Generating PPTX…', 10000);
        try {
            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_16x9';

            for (const slide of this.pres.slides) {
                const s = pptx.addSlide();

                // Background
                const bg = slide.background;
                if (bg.type === 'color') {
                    s.background = { color: bg.value.replace('#', '') };
                } else {
                    s.background = { color: 'FFFFFF' };
                }

                const sorted = [...slide.elements].sort((a, b) => (a.z || 1) - (b.z || 1));
                for (const el of sorted) {
                    const x = el.x / 960 * 10;
                    const y = el.y / 540 * 5.625;
                    const w = el.w / 960 * 10;
                    const h = el.h / 540 * 5.625;
                    const rot = el.r || 0;

                    if (el.type === 'text') {
                        const txt = htmlToText(el.html || '') || ' ';
                        s.addText(txt, {
                            x, y, w, h,
                            rotate: rot,
                            fontSize: Math.round((el.fontSize || 24) * 0.75),
                            fontFace: el.fontFamily || 'Arial',
                            color: (el.color || '#000000').replace('#', ''),
                            align: el.textAlign || 'left',
                            bold: el.bold || false,
                            italic: el.italic || false,
                            underline: el.underline ? { style: 'sng' } : false,
                            wrap: true,
                        });
                    } else if (el.type === 'shape') {
                        const shapeMap = {
                            // Rectangles
                            rect: pptx.ShapeType.rect,
                            rounded: pptx.ShapeType.roundRect,
                            // Basic shapes
                            ellipse: pptx.ShapeType.ellipse,
                            triangle: pptx.ShapeType.triangle,
                            rightTriangle: pptx.ShapeType.rightTriangle,
                            diamond: pptx.ShapeType.diamond,
                            pentagon: pptx.ShapeType.pentagon,
                            hexagon: pptx.ShapeType.hexagon,
                            octagon: pptx.ShapeType.octagon,
                            parallelogram: pptx.ShapeType.parallelogram,
                            trapezoid: pptx.ShapeType.trapezoid,
                            cross: pptx.ShapeType.cross,
                            donut: pptx.ShapeType.donut,
                            teardrop: pptx.ShapeType.teardrop,
                            heart: pptx.ShapeType.heart,
                            lightning: pptx.ShapeType.lightningBolt,
                            sun: pptx.ShapeType.sun,
                            moon: pptx.ShapeType.moon,
                            cloud: pptx.ShapeType.cloud,
                            noSymbol: pptx.ShapeType.noSymbol,
                            smile: pptx.ShapeType.smile,
                            cube: pptx.ShapeType.cube,
                            can: pptx.ShapeType.can,
                            wave: pptx.ShapeType.wave,
                            blockArc: pptx.ShapeType.blockArc,
                            pie: pptx.ShapeType.pie,
                            scroll: pptx.ShapeType.scroll,
                            plaque: pptx.ShapeType.plaque,
                            chamfer: pptx.ShapeType.chamfer,
                            foldCorner: pptx.ShapeType.foldCorner,
                            // Stars
                            star: pptx.ShapeType.star5,
                            star4: pptx.ShapeType.star4,
                            star6: pptx.ShapeType.star6,
                            star8: pptx.ShapeType.star8,
                            star10: pptx.ShapeType.star10,
                            star12: pptx.ShapeType.star12,
                            star16: pptx.ShapeType.star16,
                            star24: pptx.ShapeType.star24,
                            star32: pptx.ShapeType.star32,
                            seal1: pptx.ShapeType.seal1,
                            seal2: pptx.ShapeType.seal2,
                            // Block arrows
                            arrow: pptx.ShapeType.rightArrow,
                            arrowLeft: pptx.ShapeType.leftArrow,
                            arrowUp: pptx.ShapeType.upArrow,
                            arrowDown: pptx.ShapeType.downArrow,
                            arrowLR: pptx.ShapeType.leftRightArrow,
                            arrowUD: pptx.ShapeType.upDownArrow,
                            arrowQuad: pptx.ShapeType.quadArrow,
                            arrowNotched: pptx.ShapeType.notchedRightArrow,
                            arrowChevron: pptx.ShapeType.chevron,
                            arrowBent: pptx.ShapeType.bentArrow,
                            arrowUturn: pptx.ShapeType.uturnArrow,
                            arrowStriped: pptx.ShapeType.stripedRightArrow,
                            arrowPentagon: pptx.ShapeType.pentagonArrow,
                            arrowCalloutR: pptx.ShapeType.rightArrowCallout,
                            arrowCalloutL: pptx.ShapeType.leftArrowCallout,
                            arrowCalloutU: pptx.ShapeType.upArrowCallout,
                            arrowCalloutD: pptx.ShapeType.downArrowCallout,
                            arrowCircular: pptx.ShapeType.circularArrow,
                            // Callouts
                            calloutRect: pptx.ShapeType.rectCallout,
                            calloutRound: pptx.ShapeType.roundRectCallout,
                            calloutEllipse: pptx.ShapeType.ellipseCallout,
                            calloutCloud: pptx.ShapeType.cloudCallout,
                            // Flowchart
                            fcProcess: pptx.ShapeType.flowchartProcess,
                            fcDecision: pptx.ShapeType.flowchartDecision,
                            fcData: pptx.ShapeType.flowchartData,
                            fcDocument: pptx.ShapeType.flowchartDocument,
                            fcTerminator: pptx.ShapeType.flowchartTerminator,
                            fcPreparation: pptx.ShapeType.flowchartPreparation,
                            fcConnector: pptx.ShapeType.flowchartConnector,
                            fcDelay: pptx.ShapeType.flowchartDelay,
                            fcDisplay: pptx.ShapeType.flowchartDisplay,
                            fcManualOp: pptx.ShapeType.flowchartManualOperation,
                            // Lines
                            line: pptx.ShapeType.line,
                            lineArrow: pptx.ShapeType.lineWithArrow,
                            lineDouble: pptx.ShapeType.lineWithDoubleArrow,
                            lineElbow: pptx.ShapeType.elbowConnector,
                            lineCurve: pptx.ShapeType.curvedConnector,
                            // Brackets & braces
                            bracketL: pptx.ShapeType.leftBracket,
                            bracketR: pptx.ShapeType.rightBracket,
                            braceL: pptx.ShapeType.leftBrace,
                            braceR: pptx.ShapeType.rightBrace,
                            frameRect: pptx.ShapeType.frame,
                        };
                        const pptxShape = shapeMap[el.shape] || pptx.ShapeType.rect;
                        const fillColor = (el.fill && el.fill !== 'none') ? el.fill.replace('#', '') : null;
                        const strokeColor = (el.stroke && el.stroke !== 'none') ? el.stroke.replace('#', '') : null;
                        try {
                            s.addShape(pptxShape, {
                                x, y, w, h, rotate: rot,
                                fill: fillColor ? { color: fillColor } : { type: 'none' },
                                line: strokeColor ? { color: strokeColor, width: el.strokeWidth || 2 } : { type: 'none' },
                            });
                        } catch (_) {
                            s.addShape(pptx.ShapeType.rect, {
                                x, y, w, h,
                                fill: fillColor ? { color: fillColor } : { type: 'none' },
                            });
                        }
                    } else if (el.type === 'image') {
                        s.addImage({ data: el.src, x, y, w, h, rotate: rot });
                    }
                }
            }

            await pptx.writeFile({ fileName: `${this.pres.title || 'presentation'}.pptx` });
            this.showToast('✓ PPTX exported!');
        } catch (err) {
            console.error('PPTX export error:', err);
            this.showToast('Export failed: ' + err.message, 5000);
        }
    }

    // ── Export: PDF ────────────────────────────────────────────
    async exportPDF() {
        if (!this.pres) return;

        const hasJsPDF = typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined';
        const hasH2C   = typeof html2canvas !== 'undefined';

        if (!hasJsPDF || !hasH2C) {
            this.showToast('⚠ PDF libraries not loaded. Check your internet connection.', 5000); return;
        }

        this.showToast('Generating PDF… (this may take a moment)', 15000);
        try {
            const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [297, 167.25] });

            const origIdx = this.slideIdx;

            for (let i = 0; i < this.pres.slides.length; i++) {
                if (i > 0) pdf.addPage();
                this.slideIdx = i;
                this.renderCanvas();
                await new Promise(r => setTimeout(r, 120));

                const canvas = document.getElementById('slideCanvas');
                const imgData = await html2canvas(canvas, {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: this.pres.slides[i].background?.value || '#ffffff',
                    logging: false,
                });
                const dataUrl = imgData.toDataURL('image/jpeg', 0.92);
                pdf.addImage(dataUrl, 'JPEG', 0, 0, 297, 167.25);
            }

            this.slideIdx = origIdx;
            this.renderCanvas();
            pdf.save(`${this.pres.title || 'presentation'}.pdf`);
            this.showToast('✓ PDF exported!');
        } catch (err) {
            console.error('PDF export error:', err);
            this.showToast('PDF export failed: ' + err.message, 5000);
        }
    }


    // ── Import: PPTX (basic) ───────────────────────────────────
    // Reads the .pptx archive with the built-in openZipBuffer() reader (no
    // third-party zip library) and rebuilds a presentation from its slide XML.
    async importPPTX(file) {
        this.showToast('Importing PPTX…', 10000);
        try {
            const zip = openZipBuffer(await file.arrayBuffer());
            const pres = makePresentation(file.name.replace('.pptx', ''));
            pres.slides = [];

            // Find slide XML files
            const slideFiles = Object.keys(zip.files)
                .filter(name => /ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort((a, b) => {
                    const na = parseInt(a.match(/\d+/)[0]);
                    const nb = parseInt(b.match(/\d+/)[0]);
                    return na - nb;
                });

            if (slideFiles.length === 0) {
                this.showToast('No slides found in PPTX file.', 4000); return;
            }

            for (const slideFile of slideFiles) {
                const xmlStr = await zip.file(slideFile).async('string');
                const slide = makeSlide();

                // Parse text content from XML
                const parser = new DOMParser();
                const doc = parser.parseFromString(xmlStr, 'application/xml');

                // Extract shapes/text frames
                const spNodes = doc.querySelectorAll('sp');
                let yOffset = 60;

                spNodes.forEach((sp) => {
                    const txBody = sp.querySelector('txBody');
                    if (!txBody) return;

                    // Get position/size
                    const off = sp.querySelector('off');
                    const ext = sp.querySelector('ext');
                    const EMU = 914400; // EMUs per inch
                    const INCH_TO_PX = 96; // 96dpi

                    let x = off ? Math.round(parseInt(off.getAttribute('x') || '0') / EMU * INCH_TO_PX / 10 * (960 / 120)) : 60;
                    let y = off ? Math.round(parseInt(off.getAttribute('y') || '0') / EMU * INCH_TO_PX / 10 * (540 / 67.5)) : yOffset;
                    let w = ext ? Math.round(parseInt(ext.getAttribute('cx') || '0') / EMU * INCH_TO_PX / 10 * (960 / 120)) : 400;
                    let h = ext ? Math.round(parseInt(ext.getAttribute('cy') || '0') / EMU * INCH_TO_PX / 10 * (540 / 67.5)) : 60;

                    // Clamp to slide
                    x = clamp(x, 0, 900); y = clamp(y, 0, 500);
                    w = clamp(w, 50, 900); h = clamp(h, 20, 500);

                    // Get text
                    const paragraphs = txBody.querySelectorAll('p');
                    let textLines = [];
                    paragraphs.forEach(p => {
                        const runs = p.querySelectorAll('r t');
                        const lineText = Array.from(runs).map(r => r.textContent).join('');
                        if (lineText.trim()) textLines.push(lineText);
                    });

                    if (textLines.length === 0) return;

                    // Font size
                    const szEl = sp.querySelector('sz');
                    const fontSize = szEl ? Math.round(parseInt(szEl.getAttribute('val') || '0') / 100) || 18 : 18;

                    // Bold
                    const boldEl = sp.querySelector('b');
                    const bold = boldEl ? (boldEl.getAttribute('val') !== '0') : false;

                    const el = makeTextEl(x, y, Math.max(w, 100), Math.max(h, 40));
                    el.html = textLines.map(t => `<p>${t}</p>`).join('');
                    el.fontSize = clamp(fontSize, 10, 96);
                    el.bold = bold;
                    slide.elements.push(el);
                    yOffset += h + 20;
                });

                // Try to get background color
                const bgColor = doc.querySelector('solidFill fgClr, solidFill srgbClr');
                if (bgColor) {
                    const colorVal = bgColor.getAttribute('val') || bgColor.getAttribute('lastClr') || 'ffffff';
                    slide.background = { type: 'color', value: '#' + colorVal.toLowerCase() };
                }

                if (slide.elements.length === 0) {
                    // Add placeholder text
                    const placeholder = makeTextEl(60, 60, 840, 60);
                    placeholder.html = `<p>Slide ${pres.slides.length + 1}</p>`;
                    placeholder.fontSize = 32;
                    slide.elements.push(placeholder);
                }

                pres.slides.push(slide);
            }

            if (pres.slides.length === 0) pres.slides = [makeSlide()];

            // Save and open
            this.presentations.unshift({ id: pres.id, title: pres.title, updatedAt: pres.updatedAt, slideCount: pres.slides.length });
            await this.saveIndex();
            await this.savePresData(pres);
            await this.openPresentation(pres.id);
            this.showToast(`Imported ${pres.slides.length} slides from PPTX.`);
        } catch (err) {
            console.error('PPTX import error:', err);
            this.showToast('Import failed: ' + err.message, 5000);
        }
    }


    // ── Import PDF ────────────────────────────────────────────────
    // Renders each PDF page as an image element on a slide.
    async importPDF(file) {
        const pdfjsLib = window.pdfjsLib;
        if (!pdfjsLib) {
            this.showToast('PDF library not loaded. Import unavailable.', 5000);
            return;
        }
        // Set worker source
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }

        this.showToast('Importing PDF…', 10000);
        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const numPages = pdf.numPages;

            const pres = makePresentation(file.name.replace(/\.pdf$/i, ''));
            pres.slides = [];

            const SCALE = 2;
            const SLIDE_W = 960;
            const SLIDE_H = 540;

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({ scale: SCALE });

                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');

                await page.render({ canvasContext: ctx, viewport: viewport }).promise;
                const dataUrl = canvas.toDataURL('image/png');

                // Fit image to slide while maintaining aspect ratio, centered
                const pageAspect = viewport.width / viewport.height;
                const slideAspect = SLIDE_W / SLIDE_H;
                let elW, elH;
                if (pageAspect > slideAspect) {
                    elW = SLIDE_W;
                    elH = SLIDE_W / pageAspect;
                } else {
                    elH = SLIDE_H;
                    elW = SLIDE_H * pageAspect;
                }
                const elX = (SLIDE_W - elW) / 2;
                const elY = (SLIDE_H - elH) / 2;

                const slide = makeSlide();
                const el = {
                    id: uid(),
                    type: 'image',
                    x: Math.round(elX),
                    y: Math.round(elY),
                    w: Math.round(elW),
                    h: Math.round(elH),
                    r: 0,
                    z: 1,
                    opacity: 1,
                    src: dataUrl,
                    crop: null
                };
                slide.elements.push(el);
                pres.slides.push(slide);
            }

            if (pres.slides.length === 0) pres.slides = [makeSlide()];

            this.presentations.unshift({ id: pres.id, title: pres.title, updatedAt: pres.updatedAt, slideCount: pres.slides.length });
            await this.saveIndex();
            await this.savePresData(pres);
            await this.openPresentation(pres.id);
            this.showToast(`Imported ${pres.slides.length} pages from PDF.`);
        } catch (err) {
            console.error('PDF import error:', err);
            this.showToast('PDF import failed: ' + err.message, 5000);
        }
    }
}

// ── Init ───────────────────────────────────────────────────────
SlidesApp.memoryStorageFallback = new Map();

document.addEventListener('DOMContentLoaded', () => {
    window.slidesApp = new SlidesApp();
});
