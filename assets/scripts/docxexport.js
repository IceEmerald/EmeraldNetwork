/* ============================================================
   EmeraldSuite DOCX writer — live Docs pages → .docx (OOXML)
   ============================================================
   Converts the REAL rendered .page-content DOM into Word's own
   format, so the exported .docx keeps what the editor measured:

     • Tables (the prime target, kept round-trip-safe with the
       importer in docs.js):
         – column widths from the live grid (px→twips, 1px = 15tw)
         – cell borders / shading / vertical alignment / padding
         – colspan → gridSpan, rowspan → vMerge restart + continue
         – rows in <thead> repeat on every Word page (tblHeader)
         – floating tables keep their "anywhere on the paper"
           position via w:tblpPr (page-anchored), which the importer
           reads back into an absolute-positioned table.
     • Paragraphs: alignment, margins/spacing, first-line indents,
       line-height (as an "auto" multiplier), shading, borders,
       keepNext + outlineLvl on h1..h6 so Word's TOC/navigation
       keeps working.
     • Runs: font family/size, bold, italic, underline, strike,
       caps/smallCaps, colors, letter-spacing, sup/sub.
     • Lists: real Word numbering (numbering.xml), one abstractNum
       per list instance so numbering restarts where the document
       restarts, and lists split across pages continue numbering.
     • Images: data-URL / CORS-fetched sources embedded in
       word/media + a w:drawing inline picture at its real size.
     • Hyperlinks as external relationships.
     • Page breaks: pages are joined with explicit page-break
       paragraphs (and .emdocs-page-break shards preserved).

   All of it is packed into a ZIP written here (deflate-raw via
   CompressionStream, stored fallback) — no dependencies.

   Usage:
     EMDocx.fromPages([pageEl, pageEl, ...], {
       title, pageW, pageH,
       margins: { top, right, bottom, left },   // CSS px
       bg: "#ffffff"
     }) → Promise<Blob>

   Everything is measured with getComputedStyle()/offsetWidth,
   which ignore the app's zoom transform, so exports are stable
   at any zoom level.
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- namespaces ---------------- */
  var RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  /* ---------------- XML helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cleanText(s) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }

  /* CSS px → OOXML units. 1px = 1/96in → 15 twips (1440tw/in), 9525 EMU. */
  function tw(px) { return Math.round(px * 15); }
  function halfPt(px) { return Math.max(6, Math.round(px * 1.5)); }
  function emu(px) { return Math.round(px * 9525); }

  function cssColorToHex(v) {
    if (!v) return null;
    var c = String(v).trim().toLowerCase();
    if (!c || c === "transparent" || c === "none" || c === "currentcolor" ||
        c.indexOf("color-mix(") === 0) return null;
    var m = /^(#)([0-9a-f]{3})$/.exec(c);
    if (m) {
      return m[2][0] + m[2][0] + m[2][1] + m[2][1] + m[2][2] + m[2][2];
    }
    m = /^#([0-9a-f]{6})$/.exec(c);
    if (m) return m[1].toUpperCase();
    m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      if (parts[3] !== undefined) {
        var alpha = parseFloat(parts[3]);
        if (isFinite(alpha) && alpha < 0.05) return null;
      }
      var hex = "";
      for (var i = 0; i < 3; i++) {
        var ch = Math.max(0, Math.min(255, Math.round(parseFloat(parts[i]))));
        hex += ("0" + ch.toString(16)).slice(-2);
      }
      return hex.toUpperCase();
    }
    return null; // named colors resolved by the browser before we get here
  }

  function firstFontFamily(stack) {
    if (!stack) return null;
    var parts = String(stack).split(",");
    for (var i = 0; i < parts.length; i++) {
      var f = parts[i].trim().replace(/^["']|["']$/g, "");
      if (!f) continue;
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|inherit)$/i.test(f)) continue;
      if (f === "-apple-system" || f === "BlinkMacSystemFont") continue;
      return f;
    }
    return null;
  }

  /* ---------------- ZIP writer ---------------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ -1) >>> 0;
  }

  function strBytes(s) { return new TextEncoder().encode(s); }

  /* deflate-raw through CompressionStream; null when unavailable */
  async function deflateAll(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      var respStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      var reader = respStream.getReader();
      var acc = [], total = 0;
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        acc.push(chunk.value);
        total += chunk.value.length;
      }
      var out = new Uint8Array(total), pos = 0;
      for (var i = 0; i < acc.length; i++) { out.set(acc[i], pos); pos += acc[i].length; }
      return out;
    } catch (e) { return null; }
  }

  /* Fixed DOS timestamp (2026-10-31 00:00) so the archive stays byte-stable. */
  var DOS_DATE = (46 << 9) | (10 << 5) | 31;

  async function buildZip(entries) {
    var parts = [], central = [], offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var raw = e.data instanceof Uint8Array ? e.data : strBytes(e.data);
      var crc = crc32(raw);
      var comp = await deflateAll(raw);
      var method = 0, stored = raw;
      if (comp && comp.length < raw.length) { method = 8; } else { comp = stored; }
      var name = strBytes(e.name);

      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);            // version needed
      lh.setUint16(6, 0x0800, true);        // flags: UTF-8 names
      lh.setUint16(8, method, true);
      lh.setUint16(10, 0, true);            // time
      lh.setUint16(12, DOS_DATE, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, comp.length, true);
      lh.setUint32(22, raw.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);            // extra len
      parts.push(new Uint8Array(lh.buffer), name, comp);
      offset += 30 + name.length + comp.length;

      central.push({ name: name, method: method, crc: crc, c: comp.length, u: raw.length, at: offset - (30 + name.length + comp.length) });
    }
    var cdSize = 0;
    for (var j = 0; j < central.length; j++) cdSize += 46 + central[j].name.length;
    var cdOffset = offset;

    for (var k = 0; k < central.length; k++) {
      var ce = central[k];
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);            // version made by
      ch.setUint16(6, 20, true);            // version needed
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, ce.method, true);
      ch.setUint16(12, 0, true);
      ch.setUint16(14, DOS_DATE, true);
      ch.setUint32(16, ce.crc, true);
      ch.setUint32(20, ce.c, true);
      ch.setUint32(24, ce.u, true);
      ch.setUint16(28, ce.name.length, true);
      ch.setUint16(30, 0, true);            // extra
      ch.setUint16(32, 0, true);            // comment
      ch.setUint16(34, 0, true);            // disk#
      ch.setUint16(36, 0, true);            // internal attrs
      ch.setUint32(38, 0, true);            // external attrs
      ch.setUint32(42, ce.at, true);
      parts.push(new Uint8Array(ch.buffer), ce.name);
      offset += 46 + ce.name.length;
    }

    var eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, central.length, true);
    eo.setUint16(10, central.length, true);
    eo.setUint32(12, cdSize, true);
    eo.setUint32(16, cdOffset, true);
    eo.setUint16(20, 0, true);
    parts.push(new Uint8Array(eo.buffer));

    var total = 0;
    for (var p = 0; p < parts.length; p++) total += parts[p].length;
    var outBytes = new Uint8Array(total), at = 0;
    for (var q = 0; q < parts.length; q++) { outBytes.set(parts[q], at); at += parts[q].length; }
    return outBytes;
  }

  /* ---------------- state ---------------- */
  var MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
    "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
    "image/bmp": "bmp", "image/x-icon": "ico", "image/tiff": "tiff"
  };

  function makeState(base) {
    return {
      rootRels: [],
      docRels: [],
      relId: 1,
      media: [],
      mediaSeen: {},
      hyperSeen: {},
      abstractNums: [],
      nums: [],
      listMap: new Map(),
      lastList: null,          // { tag, numId } while a list run continues
      docPr: 0,
      usedAbstract: false,
      baseFont: base.font || "Georgia",
      baseSize: base.size || 13,
      baseColor: base.color || null
    };
  }

  function addRel(list, state, type, target, external) {
    var id = "rId" + (state.relId++);
    list.push({ id: id, type: type, target: target, external: !!external });
    return id;
  }

  function nextRelIn(state, list, type, target, external) {
    // Returns the id of the FIRST matching existing rel, else registers a new one.
    if (!external) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].type === type && list[i].target === target) return list[i].id;
      }
    }
    return addRel(list, state, type, target, external);
  }

  /* ---------------- media / hyperlinks ---------------- */
  async function imageSource(state, src) {
    try {
      src = String(src || "").trim();
      if (/^data:/i.test(src)) {
        var comma = src.indexOf(",");
        if (comma < 0) return null;
        var head = src.slice(0, comma);
        var mime = /data:([^;,]+)/i.exec(head);
        mime = mime ? mime[1].toLowerCase() : "image/png";
        if (!/base64/i.test(head)) return null;
        var bin = atob(src.slice(comma + 1));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { mime: mime, bytes: bytes };
      }
      if (/^https?:/i.test(src) && typeof fetch === "function") {
        var resp = await fetch(src, { mode: "cors", credentials: "omit" });
        if (!resp || !resp.ok) return null;
        var blob = await resp.blob();
        var ab = await blob.arrayBuffer();
        return { mime: (blob.type || "image/png").toLowerCase(), bytes: new Uint8Array(ab) };
      }
    } catch (e) { return null; }
    return null;
  }

  async function imageRel(state, mime, bytes) {
    // Content-hash dedup: the same image referenced twice embeds once.
    var ckey = mime + "\u0000" + bytes.length + "\u0000" + crc32(bytes);
    if (state.mediaSeen[ckey]) return state.mediaSeen[ckey];
    var ext = MIME_EXT[mime] || "png";
    var name = "media/image" + (state.media.length + 1) + "." + ext;
    state.media.push({ name: name, mime: mime, bytes: bytes });
    var rid = nextRelIn(state, state.docRels, RELS_NS + "/image", name, false);
    state.mediaSeen[ckey] = rid;
    return rid;
  }

  function linkRel(state, href) {
    href = String(href || "").trim();
    if (!href || href.charAt(0) === "#") return null;
    var proto = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(href);
    if (proto && !/^(https?|mailto|tel|ftp|file|news)$/i.test(proto[1])) return null;
    if (!proto) href = /^\/|#|mailto:/i.test(href) ? href : "https://" + href;
    var key = href.toLowerCase();
    if (state.hyperSeen[key]) return state.hyperSeen[key];
    var id = nextRelIn(state, state.docRels, RELS_NS + "/hyperlink", href, true);
    state.hyperSeen[key] = id;
    return id;
  }

  /* ---------------- run property builders ---------------- */
  function weightIsBold(cssWeight) {
    var v = parseInt(cssWeight, 10);
    if (isFinite(v)) return v >= 600;
    return String(cssWeight) === "bold";
  }

  function runPrXml(state, style, host) {
    var rPr = "";
    var family = firstFontFamily(style.fontFamily);
    if (family && family !== state.baseFont) {
      var f = esc(family);
      rPr += '<w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:eastAsia="' + f + '" w:cs="' + f + '"/>';
    }
    if (weightIsBold(style.fontWeight)) rPr += "<w:b/>";
    if (style.fontStyle === "italic" || style.fontStyle === "oblique") rPr += "<w:i/>";
    if (style.textTransform === "uppercase" || style.textTransform === "capitalize") rPr += "<w:caps/>";
    else if (style.textTransform === "lowercase") { /* Word has no lowercase toggle */ }
    else if (style.fontVariant && /small-caps/i.test(style.fontVariant)) rPr += "<w:smallCaps/>";
    var deco = String(style.textDecorationLine || style.textDecoration || "");
    if (/line-through/i.test(deco)) rPr += "<w:strike/>";
    var col = cssColorToHex(style.color);
    if (col && col !== state.baseColor) rPr += '<w:color w:val="' + col + '"/>';
    var ls = parseFloat(style.letterSpacing);
    if (isFinite(ls) && Math.abs(ls) > 0.01) rPr += '<w:spacing w:val="' + tw(ls) + '"/>';
    var sz = parseFloat(style.fontSize);
    if (isFinite(sz)) {
      var hp = halfPt(sz);
      rPr += '<w:sz w:val="' + hp + '"/><w:szCs w:val="' + hp + '"/>';
    }
    if (/underline/i.test(deco)) rPr += '<w:u w:val="single"/>';
    var rBg = cssColorToHex(style.backgroundColor);
    if (rBg) rPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + rBg + '"/>';
    if (host) {
      var tag = host.tagName;
      if (tag === "SUP" || style.verticalAlign === "super") rPr += '<w:vertAlign w:val="superscript"/>';
      else if (tag === "SUB" || style.verticalAlign === "sub") rPr += '<w:vertAlign w:val="subscript"/>';
    }
    return rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "";
  }

  function textRunXml(state, textNode) {
    var text = cleanText(textNode.nodeValue);
    if (!text) return "";
    var host = textNode.parentElement;
    var style = host ? window.getComputedStyle(host) : null;
    var rPr = style ? runPrXml(state, style, host) : "";
    var out = "", re = /(\t|\n)/g, last = 0, m;
    while (re.lastIndex < text.length) {
      m = re.exec(text);
      if (m === null) break;
      if (m.index > last) out += plainRun(text.slice(last, m.index), rPr);
      out += m[1] === "\t" ? "<w:r><w:tab/></w:r>" : "<w:r><w:br/></w:r>";
      last = m.index + 1;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (last < text.length) out += plainRun(text.slice(last), rPr);
    return out;
  }

  function plainRun(text, rPr) {
    if (!text) return "";
    return "<w:r>" + rPr + '<w:t xml:space="preserve">' + esc(text) + "</w:t></w:r>";
  }

  async function imageRunXml(state, img) {
    var w = img.offsetWidth, h = img.offsetHeight;
    if (!w || !h) {
      var r = img.getBoundingClientRect();
      var zm = (r.width / Math.max(1, w || img.offsetWidth)) || 1;
      w = r.width / (zm || 1); h = r.height / (zm || 1);
    }
    w = Math.round(w); h = Math.round(h);
    if (w <= 0 || h <= 0) return "";
    var got = await imageSource(state, img.getAttribute("src") || img.src || "");
    if (!got) return "";
    var rid = await imageRel(state, got.mime, got.bytes);
    var id = ++state.docPr;
    return '<w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + emu(w) + '" cy="' + emu(h) + '"/>' +
      '<wp:docPr id="' + id + '" name="Image ' + id + '"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic>' +
      '<pic:nvPicPr><pic:cNvPr id="0" name="image' + id + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch/></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      "</pic:pic>" +
      "</a:graphicData></a:graphic>" +
      "</wp:inline></w:drawing></w:r>";
  }

  /* ---------------- inline content ---------------- */
  /* skipFn lets callers drop certain children while walking inline content
     (list items skip their nested lists/blocks, which are emitted after). */
  async function inlineXml(node, state, env, skipFn) {
    var out = "";
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType === 3) { out += textRunXml(state, k); continue; }
      if (k.nodeType !== 1) continue;
      if (skipFn && skipFn(k)) continue;
      var tag = k.tagName;
      if (tag === "BR") { out += "<w:r><w:br/></w:r>"; continue; }
      if (tag === "IMG") { out += await imageRunXml(state, k); continue; }
      if (tag === "TABLE") { out += await tableXml(k, state, env); continue; }
      if (tag === "A") {
        var inner = await inlineXml(k, state, env, skipFn);
        var rid = linkRel(state, k.getAttribute("href") || "");
        if (rid) out += '<w:hyperlink r:id="' + rid + '">' + inner + "</w:hyperlink>";
        else out += inner;
        continue;
      }
      out += await inlineXml(k, state, env, skipFn);
    }
    return out;
  }

  /* ---------------- paragraph properties ---------------- */
  function spacingXml(state, style, el) {
    var pt = parseFloat(style.marginTop) || 0;
    var pb = parseFloat(style.marginBottom) || 0;
    var lh = parseFloat(style.lineHeight);
    var fs = parseFloat(style.fontSize) || state.baseSize;
    var ratio = isFinite(lh) && fs > 0 ? lh / fs : 0;
    var sp = "";
    if (pt > 0.01) sp += ' w:before="' + tw(pt) + '"';
    sp += ' w:after="' + tw(pb) + '"';
    if (ratio >= 0.4 && ratio <= 3.2) sp += ' w:line="' + Math.round(ratio * 240) + '" w:lineRule="auto"';
    else if (isFinite(lh) && lh > 4) sp += ' w:line="' + tw(lh) + '" w:lineRule="atLeast"';
    return "<w:spacing" + sp + "/>";
  }

  /* Word indents are measured from the text-column edge. At the top level
     the element's offsetLeft already contains every ancestor indent (list
     levels, blockquotes, wrapper divs), so it IS the indent. Inside table
     cells indents restart at the cell margin box instead. */
  function indXml(style, el) {
    if (!el) return "";
    var left = parseFloat(style.marginLeft) || 0;
    var right = parseFloat(style.marginRight) || 0;
    var first = 0, hang = 0;
    var ti = parseFloat(style.textIndent);
    if (isFinite(ti)) { if (ti < 0) hang = -ti; else first = ti; }
    if (!el.closest("td, th")) {
      var measured = el.offsetLeft || 0;
      if (measured > left) left = measured;
    }
    var out = "";
    if (left > 0.01) out += ' w:left="' + tw(left) + '"';
    if (right > 0.01) out += ' w:right="' + tw(right) + '"';
    if (hang > 0.01) out += ' w:hanging="' + tw(hang) + '"';
    else if (first > 0.01) out += ' w:firstLine="' + tw(first) + '"';
    if (!out) return "";
    return "<w:ind" + out + "/>";
  }

  function paragraphPrXml(state, el, style) {
    var p = "";
    var tag = el ? el.tagName : "";
    if (/^H[1-6]$/.test(tag)) p += "<w:keepNext/>";
    if (style.breakBefore === "page" || (el && /page-break-before/i.test(el.getAttribute("style") || ""))) {
      p += "<w:pageBreakBefore/>";
    }

    var bg = cssColorToHex(style.backgroundColor);
    if (bg) p += '<w:shd w:val="clear" w:color="auto" w:fill="' + bg + '"/>';

    p += spacingXml(state, style, el);

    var ind = indXml(style, el);
    if (ind && ind !== "<w:ind/>") p += ind;

    var align = style.textAlign;
    if (align && align !== "start" && align !== "left" && align !== "unset") {
      p += '<w:jc w:val="' + (align === "justify" ? "both" : align) + '"/>';
    }
    if (/^H[1-6]$/.test(tag)) p += '<w:outlineLvl w:val="' + (parseInt(tag.charAt(1), 10) - 1) + '"/>';

    return p ? "<w:pPr>" + p + "</w:pPr>" : "";
  }

  /* ---------------- headings / paragraphs ---------------- */
  async function paragraphXml(el, state, env) {
    var style = window.getComputedStyle(el);
    var runs = await inlineXml(el, state, env);
    if (!runs) runs = '<w:r><w:t xml:space="preserve"></w:t></w:r>';
    var pPr = paragraphPrXml(state, el, style);
    return "<w:p>" + pPr + runs + "</w:p>";
  }

  /* ---------------- lists ---------------- */
  function relRank(depth) {
    var seq = ["decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman"];
    return seq[depth % seq.length];
  }
  function lvlTextFor(depth) {
    var t = ["%1.", "%2.", "%3.", "%4.", "%5.", "%6.", "%7.", "%8.", "%9."];
    return t[Math.min(8, depth)];
  }
  var BULLETS = [
    { text: "\uF0B7", font: "Symbol" },
    { text: "o", font: "Courier New" },
    { text: "\uF0A7", font: "Wingdings" }
  ];

  function listDepth(listEl) {
    var d = 0, a = listEl.parentElement;
    while (a) {
      if (a.tagName === "UL" || a.tagName === "OL") d++;
      a = a.parentElement;
    }
    return Math.min(8, d);
  }

  function numIdFor(state, listEl, depth) {
    var existing = state.listMap.get(listEl);
    if (existing) return existing;

    var tag = listEl.tagName;
    var prev = state.lastList;
    var nid;
    if (prev && prev.tag === tag && prev.depth === depth) {
      // Same visual list carried across a page/pagination split: Word restarts
      // numbering when a NEW numId is used, so the continuation reuses the
      // previous numId instead of getting its own.
      nid = prev.numId;
      state.listMap.set(listEl, nid);
    } else {
      var a = {
        id: state.abstractNums.length,
        type: tag === "OL" ? "ol" : "ul",
        depth: depth
      };
      state.abstractNums.push(a);
      state.usedAbstract = true;
      nid = state.nums.length + 1;
      state.nums.push({ abstractId: a.id, numId: nid });
      state.listMap.set(listEl, nid);
    }
    state.lastList = { tag: tag, numId: nid, depth: depth };
    return nid;
  }

  /* Block children that a list item must NOT swallow into its own paragraph:
     nested lists / real blocks become their own paragraphs after it. */
  var LI_BLOCK_TAGS = {
    UL: 1, OL: 1, TABLE: 1, P: 1, PRE: 1, BLOCKQUOTE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1
  };

  async function listXml(listEl, state, env) {
    var depth = listDepth(listEl);
    var numId = numIdFor(state, listEl, depth);
    var out = "";
    for (var i = 0; i < listEl.children.length; i++) {
      var li = listEl.children[i];
      if (li.tagName === "LI") out += await listItemXml(listEl, li, state, depth, numId, env);
    }
    return out;
  }

  async function listItemXml(listEl, li, state, depth, numId, env) {
    state.lastList = { tag: listEl.tagName, numId: numId, depth: depth };

    var style = window.getComputedStyle(li);
    var pPr = "";
    pPr += '<w:numPr><w:ilvl w:val="' + depth + '"/><w:numId w:val="' + numId + '"/></w:numPr>';
    pPr += spacingXml(state, style, li);
    var leftPx = Math.max(16, li.offsetLeft || 0);
    var hang = Math.max(15, Math.abs(parseFloat(style.textIndent) || 0) || 14);
    pPr += '<w:ind w:left="' + tw(leftPx) + '" w:hanging="' + tw(hang) + '"/>';
    var align = style.textAlign;
    if (align && align !== "start" && align !== "left" && align !== "unset") {
      pPr += '<w:jc w:val="' + (align === "justify" ? "both" : align) + '"/>';
    }

    // The li's own inline content comes from the LIVE li (so computed styles
    // resolve) while skipping nested lists and real block children.
    var runs = await inlineXml(li, state, env, function (el) { return LI_BLOCK_TAGS[el.tagName]; });
    if (!runs) runs = '<w:r><w:t xml:space="preserve"></w:t></w:r>';

    var out = "<w:p><w:pPr>" + pPr + "</w:pPr>" + runs + "</w:p>";
    // Nested lists and block children follow as their own paragraphs.
    var kids = li.children;
    for (var j = 0; j < kids.length; j++) {
      var t = kids[j].tagName;
      if (t === "UL" || t === "OL") out += await listXml(kids[j], state, env);
      else if (LI_BLOCK_TAGS[t]) out += await anyBlockXml(kids[j], state, env);
    }
    return out;
  }

  /* ---------------- tables ---------------- */
  function borderColor(side, style) {
    var v = cssColorToHex(style["border" + side + "Color"]) || "auto";
    return v;
  }

  function borderKind(style, side) {
    var st = String(style["border" + side + "Style"]).toLowerCase();
    var wpx = parseFloat(style["border" + side + "Width"]);
    if (!st || st === "none" || st === "hidden" || !(wpx > 0)) return null;
    if (st !== "single" && st !== "solid") {
      if (st === "dotted" || st === "dashed" || st === "double") { /* keep */ }
      else st = "single";
    }
    if (st === "solid") st = "single";
    return { val: st, sz: Math.max(2, Math.round(wpx * 6)), color: borderColor(side, style) };
  }

  function bordersXml(tag, sides) {
    var parts = "";
    var order = ["top", "left", "bottom", "right", "insideH", "insideV"];
    var used = false;
    for (var i = 0; i < order.length; i++) {
      var b = sides[order[i]];
      if (!b) continue;
      used = true;
      parts += '<w:' + order[i] + ' w:val="' + b.val + '" w:sz="' + b.sz + '" w:space="0" w:color="' + (b.color || "auto") + '"/>';
    }
    return used ? "<" + tag + ">" + parts + "</" + tag + ">" : "";
  }

  async function tableXml(tbl, state, env) {
    var rows = tbl.rows;
    if (!rows || !rows.length) return "";
    var style = window.getComputedStyle(tbl);
    var isFloat = tbl.style && tbl.style.position === "absolute";

    /* grid columns */
    var gridTw = [];
    var seen = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells;
      var cursor = 0;
      for (var ci = 0; ci < cells.length; ci++) {
        var span = Math.max(1, cells[ci].colSpan || 1);
        var w = cells[ci].offsetWidth || 0;
        for (var s = 0; s < span; s++) {
          var col = cursor + s;
          if (!seen[col]) {
            seen[col] = true;
            gridTw[col] = Math.max(64, tw(w / span));
          }
        }
        cursor += span;
      }
      if (cursor > gridTw.length) gridTw.length = cursor;
    }
    if (!gridTw.length) gridTw = [tw(tbl.offsetWidth || 200)];
    var totalTw = gridTw.reduce(function (a, b) { return a + (b || 0); }, 0);

    /* vertical merge bookkeeping */
    var conts = {};      // rowIdx → [ { start, span, tcw } ] sorted later
    var restarts = {};   // "r:c" → true
    for (var r2 = 0; r2 < rows.length; r2++) {
      var cells2 = rows[r2].cells, cur = 0;
      for (var c2 = 0; c2 < cells2.length; c2++) {
        var tc = cells2[c2];
        var spn = Math.max(1, tc.colSpan || 1);
        var rsp = Math.max(1, tc.rowSpan || 1);
        if (rsp > 1 && r2 + rsp <= rows.length) {
          for (var rr = r2 + 1; rr < r2 + rsp; rr++) {
            (conts[rr] = conts[rr] || []).push({
              start: cur, span: spn,
              tcw: Math.max(64, tw(tc.offsetWidth / spn))
            });
          }
          restarts[r2 + ":" + cur] = true;
        }
        cur += spn;
      }
    }
    for (var kk in conts) {
      if (Object.prototype.hasOwnProperty.call(conts, kk)) {
        conts[kk].sort(function (a, b) { return a.start - b.start; });
      }
    }

    /* table-level borders: sample the boundary cells */
    var tStyle = window.getComputedStyle(tbl);
    var firstRowCell = rows[0].cells[0];
    var lastRowCell = rows[rows.length - 1].cells[0];
    var sides = {};
    var fs = firstRowCell ? window.getComputedStyle(firstRowCell) : tStyle;
    var ls = lastRowCell ? window.getComputedStyle(lastRowCell) : tStyle;
    sides.top = borderKind(fs, "Top");
    sides.bottom = borderKind(ls, "Bottom");
    // left/right from the first column of any row / last column
    var midCell = rows[Math.min(1, rows.length - 1)].cells[0];
    var midStyle = midCell ? window.getComputedStyle(midCell) : tStyle;
    sides.left = borderKind(midStyle, "Left");
    sides.right = borderKind(midStyle, "Right");
    for (var ir = 1; ir < rows.length && !sides.insideH; ir++) {
      if (rows[ir].cells.length) sides.insideH = borderKind(window.getComputedStyle(rows[ir].cells[0]), "Top");
    }
    if (rows[0].cells.length > 1) {
      sides.insideV = borderKind(window.getComputedStyle(rows[0].cells[1]), "Left");
    }

    /* cell padding → table-level margins (first cell) */
    var padCell = rows[0].cells[0];
    var cellMar = "";
    if (padCell) {
      var pcs = window.getComputedStyle(padCell);
      var pt2 = tw(parseFloat(pcs.paddingTop) || 0);
      var pl2 = tw(parseFloat(pcs.paddingLeft) || 0);
      var pb2 = tw(parseFloat(pcs.paddingBottom) || 0);
      var pr2 = tw(parseFloat(pcs.paddingRight) || 0);
      cellMar = "<w:tblCellMar>" +
        '<w:top w:w="' + pt2 + '" w:type="dxa"/><w:left w:w="' + pl2 + '" w:type="dxa"/>' +
        '<w:bottom w:w="' + pb2 + '" w:type="dxa"/><w:right w:w="' + pr2 + '" w:type="dxa"/>' +
        "</w:tblCellMar>";
    }

    /* tblPr */
    var tblPr = "";
    if (isFloat) {
      var left3 = parseFloat(tbl.style.left) || 0;
      var top3 = parseFloat(tbl.style.top) || 0;
      var envM = (env && env.margins) || { top: 0, left: 0 };
      var tx = Math.round((envM.left + left3) * 15);
      var ty = Math.round((envM.top + top3) * 15);
      tblPr += '<w:tblpPr w:leftFromText="0" w:rightFromText="0" w:topFromText="0" w:bottomFromText="0"' +
        ' w:horzAnchor="page" w:vertAnchor="page" w:tblpX="' + tx + '" w:tblpY="' + ty + '"/>';
      tblPr += '<w:tblOverlap w:val="overlap"/>';
    }
    tblPr += '<w:tblW w:w="' + totalTw + '" w:type="dxa"/>';
    if (!isFloat && style.marginLeft === "auto" && style.marginRight === "auto") {
      tblPr += '<w:jc w:val="center"/>';
    }
    var tBorders = bordersXml("w:tblBorders", sides);
    if (tBorders) tblPr += tBorders;
    if ((tbl.style.tableLayout === "fixed") || isFloat) {
      tblPr += '<w:tblLayout w:type="fixed"/>';
    }
    if (cellMar) tblPr += cellMar;

    /* rows */
    var bodyXml = "";
    for (var r3 = 0; r3 < rows.length; r3++) {
      bodyXml += await rowXml(rows[r3], state, r3, gridTw, conts[r3], restarts, env);
    }

    return "<w:tbl><w:tblPr>" + tblPr + "</w:tblPr>" +
      "<w:tblGrid>" + gridTw.map(function (w2) { return '<w:gridCol w:w="' + (w2 || 64) + '"/>'; }).join("") + "</w:tblGrid>" +
      bodyXml + "</w:tbl>";
  }

  async function rowXml(row, state, rowIdx, gridTw, conts, restarts, env) {
    var trPr = "";
    var rh = row.offsetHeight;
    if (rh > 0) trPr += '<w:trHeight w:val="' + tw(rh) + '" w:hRule="atLeast"/>';
    // A <thead> row repeats on every Word page (CT_TrPr: trHeight, tblHeader).
    if (row.parentElement && row.parentElement.tagName === "THEAD") trPr += "<w:tblHeader/>";
    var trPrXml = trPr ? "<w:trPr>" + trPr + "</w:trPr>" : "";

    var domCells = Array.prototype.slice.call(row.cells);
    var totalCols = gridTw.length;
    var out = "";
    var cursor = 0, di = 0;

    function tcForContinuation(c) {
      var tcStyleW = '<w:tcW w:w="' + (c.tcw * c.span) + '" w:type="dxa"/>';
      var tcPr = "<w:tcPr>" + tcStyleW + (c.span > 1 ? '<w:gridSpan w:val="' + c.span + '"/>' : "") + "<w:vMerge/></w:tcPr>";
      return "<w:tc>" + tcPr + "<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr></w:p></w:tc>";
    }

    while (cursor < totalCols || di < domCells.length) {
      var cont = null;
      if (conts) {
        for (var i = 0; i < conts.length; i++) {
          if (conts[i].start === cursor) { cont = conts[i]; break; }
        }
      }
      if (cont) {
        out += tcForContinuation(cont);
        cursor += cont.span;
        continue;
      }
      if (di < domCells.length) {
        var cell = domCells[di];
        var span = Math.max(1, cell.colSpan || 1);
        out += await cellXml(cell, state, cursor, gridTw, restarts, rowIdx, span, env);
        cursor += span;
        di++;
        continue;
      }
      break;
    }

    return "<w:tr>" + trPrXml + out + "</w:tr>";
  }

  /* CT_TcPr order: tcW, gridSpan, vMerge, tcBorders, shd, tcMar, vAlign */
  async function cellXml(cell, state, colStart, gridTw, restarts, rowIdx, span, env) {
    var cs = window.getComputedStyle(cell);
    var tcPr = "";
    tcPr += '<w:tcW w:w="' + Math.max(64, tw(cell.offsetWidth || 0)) + '" w:type="dxa"/>';
    if (span > 1) tcPr += '<w:gridSpan w:val="' + span + '"/>';
    if (restarts[rowIdx + ":" + colStart]) tcPr += '<w:vMerge w:val="restart"/>';

    var sides = {
      top: borderKind(cs, "Top"), left: borderKind(cs, "Left"),
      bottom: borderKind(cs, "Bottom"), right: borderKind(cs, "Right")
    };
    var bXml = bordersXml("w:tcBorders", sides);
    if (bXml) tcPr += bXml;

    var bg = cssColorToHex(cs.backgroundColor);
    if (bg) tcPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + bg + '"/>';

    tcPr += "<w:tcMar>" +
      '<w:top w:w="' + tw(parseFloat(cs.paddingTop) || 0) + '" w:type="dxa"/>' +
      '<w:left w:w="' + tw(parseFloat(cs.paddingLeft) || 0) + '" w:type="dxa"/>' +
      '<w:bottom w:w="' + tw(parseFloat(cs.paddingBottom) || 0) + '" w:type="dxa"/>' +
      '<w:right w:w="' + tw(parseFloat(cs.paddingRight) || 0) + '" w:type="dxa"/></w:tcMar>';

    var va = cs.verticalAlign;
    if (va === "top" || va === "middle" || va === "bottom") {
      tcPr += '<w:vAlign w:val="' + (va === "middle" ? "center" : va) + '"/>';
    }

    var content = "";
    var blocks = cell.children;
    for (var i = 0; i < blocks.length; i++) {
      content += await anyBlockXml(blocks[i], state, env);
    }
    // A cell must contain at least one paragraph, and a table may not be the
    // last block in a cell (Word auto-inserts one after it).
    var lastIsTable = blocks.length && blocks[blocks.length - 1].tagName === "TABLE";
    if (!blocks.length || lastIsTable) content += EMPTY_P;

    return "<w:tc><w:tcPr>" + tcPr + "</w:tcPr>" + content + "</w:tc>";
  }

  /* ---------------- generic block dispatcher ---------------- */
  var EMPTY_P = '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>';
  var PAGE_BREAK_P = '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';

  var INLINE_PASSTHRU = {
    A: 1, SPAN: 1, FONT: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1,
    STRIKE: 1, SUB: 1, SUP: 1, MARK: 1, CODE: 1, BIG: 1, SMALL: 1, BR: 1
  };

  function isAppChrome(el) {
    return el.classList && (el.classList.contains("page-footnote-area") ||
      el.classList.contains("footnotes-section"));
  }

  function isPageBreakShard(el) {
    return el.classList && (el.classList.contains("emdocs-page-break") ||
      el.classList.contains("section-break"));
  }

  /* Render one block-level element (or container) as OOXML. */
  async function anyBlockXml(el, state, env) {
    if (!el) return "";
    if (isAppChrome(el)) return "";
    if (isPageBreakShard(el)) { state.lastList = null; return PAGE_BREAK_P; }
    state.lastList = null;

    var tag = el.tagName;
    if (tag === "UL" || tag === "OL") return listXml(el, state, env);
    if (tag === "TABLE") return tableXml(el, state, env);
    if (tag === "HR") return hrXml(el, state);
    if (tag === "IMG") {
      var style = window.getComputedStyle(el);
      return "<w:p><w:pPr>" + spacingXml(state, style, el) + "</w:pPr>" +
        (await imageRunXml(state, el)) + "</w:p>";
    }
    if (tag === "PRE") return preXml(el, state);
    if (tag === "BLOCKQUOTE") {
      // Quote boxes keep their look (indent + accent + italic) through the
      // computed styles of the paragraphs inside them.
      var innerQ = "";
      var qKids = el.children;
      for (var i = 0; i < qKids.length; i++) innerQ += await anyBlockXml(qKids[i], state, env);
      if (qKids.length) return innerQ;
      return paragraphXml(el, state, env);
    }
    if (tag === "P" || tag === "H1" || tag === "H2" || tag === "H3" ||
        tag === "H4" || tag === "H5" || tag === "H6") {
      return paragraphXml(el, state, env);
    }
    if (tag === "DIV" && el.querySelector &&
        el.querySelector("table,ul,ol,p,h1,h2,h3,h4,h5,h6,pre,blockquote,hr")) {
      return blocksXml(el, state, env);
    }
    if (!INLINE_PASSTHRU[tag] && el.querySelector &&
        el.querySelector("table,ul,ol,p,pre,blockquote,hr,h1,h2,h3,h4,h5,h6")) {
      return blocksXml(el, state, env);
    }
    return paragraphXml(el, state, env);
  }

  async function blocksXml(container, state, env) {
    if (!container) return "";
    var out = "";
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) out += await anyBlockXml(kids[i], state, env);
    return out;
  }

  function preXml(el, state) {
    var cs = window.getComputedStyle(el);
    var bg = cssColorToHex(cs.backgroundColor);
    var fill = bg ? '<w:shd w:val="clear" w:color="auto" w:fill="' + bg + '"/>' : "";
    var mono = firstFontFamily(cs.fontFamily) || "Courier New";
    var f = esc(mono);
    var sz = halfPt(parseFloat(cs.fontSize) || 12.5);
    var rPr = "<w:rPr>" +
      '<w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:eastAsia="' + f + '" w:cs="' + f + '"/>' +
      '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' +
      "</w:rPr>";
    var lines = cleanText(el.textContent).replace(/\r\n?/g, "\n").split("\n");
    var out = "";
    for (var i = 0; i < lines.length; i++) {
      var sp = '<w:spacing w:before="' + (i === 0 ? tw(8) : 0) + '" w:after="' +
        (i === lines.length - 1 ? tw(8) : 0) + '" w:line="276" w:lineRule="auto"/>';
      out += "<w:p><w:pPr>" + fill + sp + "</w:pPr><w:r>" + rPr +
        '<w:t xml:space="preserve">' + esc(lines[i]) + "</w:t></w:r></w:p>";
    }
    if (!out) out = "<w:p><w:pPr>" + fill + '<w:spacing w:after="0"/></w:pPr><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>';
    return out;
  }

  function hrXml(el, state) {
    var cs = window.getComputedStyle(el);
    var col = cssColorToHex(cs.borderTopColor) || cssColorToHex(cs.borderBottomColor) || "7E7E7E";
    var wt = Math.max(4, Math.round((parseFloat(cs.borderTopWidth) || 1) * 6));
    return "<w:p><w:pPr>" +
      '<w:pBdr><w:bottom w:val="single" w:sz="' + wt + '" w:space="1" w:color="' + col + '"/></w:pBdr>' +
      '<w:spacing w:before="120" w:after="120"/></w:pPr>' +
      '<w:r><w:t xml:space="preserve"></w:t></w:r></w:p>';
  }

  /* ---------------- package parts ---------------- */
  function sectPrXml(meta) {
    var w = tw(meta.pageW || 794), h = tw(meta.pageH || 1123);
    var orient = w > h ? ' w:orient="landscape"' : "";
    var m = meta.margins || { top: 72, right: 72, bottom: 72, left: 72 };
    return "<w:sectPr>" +
      '<w:pgSz w:w="' + w + '" w:h="' + h + '"' + orient + "/>" +
      '<w:pgMar w:top="' + tw(m.top) + '" w:right="' + tw(m.right) +
      '" w:bottom="' + tw(m.bottom) + '" w:left="' + tw(m.left) +
      '" w:header="0" w:footer="0" w:gutter="0"/>' +
      '<w:cols w:space="720"/>' +
      '<w:docGrid w:linePitch="360"/>' +
      "</w:sectPr>";
  }

  function documentXml(body, meta) {
    var bg = cssColorToHex(meta.bg);
    if (!body || !body.replace(/\s/g, "")) body = "<w:p/>";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="' + W_NS + '" xmlns:r="' + RELS_NS + '"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      (bg ? '<w:background w:color="' + bg + '"/>' : "") +
      "<w:body>" + body + sectPrXml(meta) + "</w:body></w:document>";
  }

  function contentTypesXml(state) {
    var mediaTypes = {};
    for (var i = 0; i < state.media.length; i++) {
      var ext = (state.media[i].name.split(".").pop() || "png").toLowerCase();
      mediaTypes[ext] = state.media[i].mime;
    }
    var defaults = "";
    for (var ext2 in mediaTypes) {
      if (Object.prototype.hasOwnProperty.call(mediaTypes, ext2)) {
        defaults += '<Default Extension="' + ext2 + '" ContentType="' + esc(mediaTypes[ext2]) + '"/>';
      }
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      defaults +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      (state.usedAbstract ?
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : "") +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      "</Types>";
  }

  function relsPartXml(rels) {
    var s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      s += '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + esc(r.target) + '"' +
        (r.external ? ' TargetMode="External"' : "") + "/>";
    }
    return s + "</Relationships>";
  }

  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + RELS_NS + '/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      "</Relationships>";
  }

  function docRelsXml(state) {
    var rels = [
      { id: "rId900", type: RELS_NS + "/styles", target: "styles.xml" },
      { id: "rId901", type: RELS_NS + "/settings", target: "settings.xml" }
    ].concat(state.docRels);
    if (state.usedAbstract) {
      rels.push({ id: "rId902", type: RELS_NS + "/numbering", target: "numbering.xml" });
    }
    return relsPartXml(rels);
  }

  function stylesXml(state) {
    var f = esc(state.baseFont);
    var sz = halfPt(state.baseSize);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="' + W_NS + '">' +
      "<w:docDefaults>" +
      '<w:rPrDefault><w:rPr><w:rFonts w:ascii="' + f + '" w:hAnsi="' + f +
      '" w:eastAsia="' + f + '" w:cs="' + f + '"/>' +
      '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="150" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      "</w:docDefaults>" +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      '<w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      "</w:styles>";
  }

  function settingsXml(meta) {
    // Only paint Word's page background when the paper really differs from
    // white (cssColorToHex resolves names/rgba/3-digit hex to 6-digit form).
    var hex = cssColorToHex(meta.bg);
    var showBg = hex && hex !== "FFFFFF";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:settings xmlns:w="' + W_NS + '">' +
      (showBg ? "<w:displayBackgroundShape/>" : "") +
      '<w:defaultTabStop w:val="720"/>' +
      '<w:characterSpacingControl w:val="doNotCompress"/>' +
      "</w:settings>";
  }

  function charRef(ch) {
    var code = ch.charCodeAt(0);
    if (code < 127) return esc(ch);
    return "&#x" + code.toString(16) + ";";
  }

  /* CT_Lvl order: start, numFmt, lvlText, lvlJc, pPr, rPr */
  function numberingXml(state) {
    var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:numbering xmlns:w="' + W_NS + '">';
    for (var i = 0; i < state.abstractNums.length; i++) {
      var a = state.abstractNums[i];
      out += '<w:abstractNum w:abstractNumId="' + a.id + '">' +
        '<w:multiLevelType w:val="hybridMultilevel"/>';
      for (var l = 0; l < 9; l++) {
        var entry, rPr = "";
        if (a.type === "ul") {
          var b = BULLETS[l % BULLETS.length];
          entry = '<w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
            '<w:lvlText w:val="' + charRef(b.text) + '"/>';
          rPr = '<w:rPr><w:rFonts w:ascii="' + esc(b.font) + '" w:hAnsi="' +
            esc(b.font) + '" w:hint="default"/></w:rPr>';
        } else {
          entry = '<w:start w:val="1"/><w:numFmt w:val="' + relRank(l) + '"/>' +
            '<w:lvlText w:val="' + esc(lvlTextFor(l)) + '"/>';
        }
        out += '<w:lvl w:ilvl="' + l + '">' + entry +
          '<w:lvlJc w:val="left"/>' +
          '<w:pPr><w:ind w:left="' + tw(720 + 360 * l) + '" w:hanging="360"/></w:pPr>' +
          rPr + "</w:lvl>";
      }
      out += "</w:abstractNum>";
    }
    for (var k = 0; k < state.nums.length; k++) {
      out += '<w:num w:numId="' + state.nums[k].numId + '">' +
        '<w:abstractNumId w:val="' + state.nums[k].abstractId + '"/></w:num>';
    }
    return out + "</w:numbering>";
  }

  function coreXml(meta) {
    var now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      "<dc:title>" + esc(meta.title || "Document") + "</dc:title>" +
      "<dc:creator>EmeraldSuite Docs</dc:creator>" +
      "<cp:lastModifiedBy>EmeraldSuite Docs</cp:lastModifiedBy>" +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + "</dcterms:created>" +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + "</dcterms:modified>" +
      "</cp:coreProperties>";
  }

  /* ---------------- page plumbing ---------------- */
  function pageContentOf(page) {
    if (!page) return null;
    if (page.classList && page.classList.contains("page-content")) return page;
    var c = page.querySelector && page.querySelector(".page-content");
    return c || page;
  }

  function baseStyleOf(el) {
    try {
      var cs = window.getComputedStyle(el || document.body);
      return {
        font: firstFontFamily(cs.fontFamily) || "Georgia",
        size: parseFloat(cs.fontSize) || 13,
        color: cssColorToHex(cs.color)
      };
    } catch (e) {
      return { font: "Georgia", size: 13, color: null };
    }
  }

  /* ---------------- entry points ---------------- */
  /* pages: live .page elements (or the .page-content they contain).
     meta:  { title, pageW, pageH, margins: {top,right,bottom,left}, bg } */
  async function fromPages(pages, meta) {
    if (!document.body) throw new Error("DOCX export needs a live DOM");
    meta = meta || {};
    pages = Array.prototype.slice.call(pages || []);
    if (!pages.length) throw new Error("Nothing to export — no pages open");

    var state = makeState(baseStyleOf(pageContentOf(pages[0])));
    var body = "";
    for (var i = 0; i < pages.length; i++) {
      var content = pageContentOf(pages[i]);
      if (!content) continue;
      var env = { margins: meta.margins || { top: 0, right: 0, bottom: 0, left: 0 } };
      body += await blocksXml(content, state, env);
      if (i < pages.length - 1) body += PAGE_BREAK_P;
    }

    var entries = [
      { name: "[Content_Types].xml", data: contentTypesXml(state) },
      { name: "_rels/.rels", data: rootRelsXml() },
      { name: "word/document.xml", data: documentXml(body, meta) },
      { name: "word/styles.xml", data: stylesXml(state) },
      { name: "word/settings.xml", data: settingsXml(meta) },
      { name: "docProps/core.xml", data: coreXml(meta) },
      { name: "word/_rels/document.xml.rels", data: docRelsXml(state) }
    ];
    if (state.usedAbstract) {
      entries.push({ name: "word/numbering.xml", data: numberingXml(state) });
    }
    for (var m = 0; m < state.media.length; m++) {
      entries.push({ name: "word/" + state.media[m].name, data: state.media[m].bytes });
    }
    var zip = await buildZip(entries);
    return new Blob([zip], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
  }

  /* Export an arbitrary HTML fragment by rendering it into a hidden
     measuring container with the document's content-column width. */
  async function fromHtml(html, meta) {
    if (!document.body) throw new Error("DOCX export needs a live DOM");
    meta = meta || {};
    var host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    var innerW = Math.max(80, Math.round((meta.pageW || 794) -
      (((meta.margins || {}).left || 0) + ((meta.margins || {}).right || 0))));
    host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;" +
      "box-sizing:border-box;width:" + innerW + "px;";
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      return await fromPages([host], meta);
    } finally {
      if (host.parentElement) host.parentElement.removeChild(host);
    }
  }

  window.EMDocx = {
    fromPages: fromPages,
    fromHtml: fromHtml,
    buildZip: buildZip
  };
})();

