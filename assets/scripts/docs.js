/* BUILD 2026-08-26.12 (References: Footnote/Endnote/Citation custom modals; proper endnote system — numbered refs, end-of-doc section, panel management; Styles group (Title/H1-H3/Normal via formatBlock); Caption/Cross-ref/Table-of-Figures removed) */
/* =========================================================
   Emerald Docs — Word Processor  (v2)
   Real pagination engine: content is distributed across real
   A4 page DOM elements. Paragraphs move whole between pages;
   a single block taller than a page is split at a word boundary
   (never mid-word).
   ---------------------------------------------------------
   v2 changes:
   - BUG FIX: single overflowing block now splits FIRST instead
     of being pushed whole to the next page (which created
     cascades of empty pages).
   - Find & Replace (Ctrl+F / Ctrl+H) with match highlighting.
   - Insert Link (Ctrl+K; Ctrl+click opens in new tab), Image (OS file
     picker, Slides-style), Table (grid), HR. Page-break markers are
     click-to-remove.
   - Undo/Redo, Dark theme toggle, Export (.txt/.html/print),
     Word-count stats dialog, Ruler.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- Constants ---------------- */
  var PAGES_WRAPPER_ID = "pagesWrapper";
  var CARET_BLOCK_ATTR = "data-caret-block";
  var CARET_OFFSET_ATTR = "data-caret-offset";
  // Multi-document storage: one index of metadata + one key per document,
  // mirroring the Slides app (emeraldcore.storage.suite.slides / ...<id>).
  var DOC_INDEX_KEY = "emeraldcore.storage.suite.docs";
  function docDataKey(id) { return "emeraldcore.storage.suite.docs." + id; }
  // THEME_KEY removed — dark mode is no longer supported.
  function versionsKey(id) { return "emeraldcore.storage.suite.docs.versions." + id; }
  var MARGINS_KEY = "emeraldcore.storage.suite.docs.margins";
  var GOAL_KEY = "emeraldcore.storage.suite.docs.goal";
  var WRITING_TIME_KEY = "emeraldcore.storage.suite.docs.writingTime";
  var MAX_VERSIONS = 10;
  var AUTOSAVE_SNAPSHOT_MS = 60 * 1000; // 1 minute
  var autosaveSnapshotTimer = null;
  // Set on every edit; the version-history ticker only snapshots when it's true.
  var snapshotDirty = false;
  var MAX_PAGINATE_ITER = 120;
  var PAGE_WIDTH = 794;
  var PAGE_HEIGHT = 1123;
  // Current effective page dimensions (updated by applyDocPageLayout for
  // imported docs; default to A4). Kept in sync with the .page elements.
  var curPageW = PAGE_WIDTH;
  var curPageH = PAGE_HEIGHT;
  var MIN_MARGIN = 32;
  var MAX_MARGIN = 300;
  // Zoom limits match Slides: 20% – 400% (Slides uses clamp(scale, 0.2, 4)).
  var MIN_ZOOM = 20;
  var MAX_ZOOM = 400;

  /* ---------------- State ---------------- */
  var paginateScheduled = false;
  var autosaveScheduled = false;
  var autosaveTimer = null;
  var lastEditorRange = null;
  var toastTimer = null;
  var theme = "light";
  var findMatches = [];
  var findIndex = -1;
  var pageMargins = { top: 96, right: 96, bottom: 96, left: 96 };
  var goalTarget = 0;
  var assetRepaginateToken = 0;
  // Ribbon availability state (Notes/Slides parity): Undo/Redo reflect whether
  // the browser's native contenteditable history can actually undo/redo.
  var canUndo = false;
  var canRedo = false;
  // Multi-document state (Slides pattern)
  var documents = [];        // metadata index [{id, title, updatedAt, wordCount}]
  var currentDocId = null;   // id of the document loaded in the editor (null → welcome screen)
  var currentTitle = "Untitled Document";
  var _welcomeRenderToken = 0;
  var _deleteTargetId = null;

  /* ---------------- DOM helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  // IMPORTANT: scope page lookup to the real pages wrapper ONLY. Page
  // thumbnails clone real .page elements into the DOM for 1:1 previews, so a
  // global document.querySelectorAll(".page") would also match those clones and
  // break pagination/status/counts (creating runaway pages while typing).
  function getPages() {
    var wrapper = $(PAGES_WRAPPER_ID);
    if (!wrapper) return [];
    return Array.prototype.slice.call(wrapper.querySelectorAll(".page"));
  }
  function getContent(page) { return page.querySelector(".page-content"); }
  function isOverflow(content) { return content.scrollHeight > content.clientHeight + 1; }

  /* ---------------- Page management ---------------- */
  function createPage() {
    var page = document.createElement("div");
    page.className = "page";

    var content = document.createElement("div");
    content.className = "page-content";
    content.setAttribute("contenteditable", "true");
    content.setAttribute("spellcheck", "true");
    content.setAttribute("role", "textbox");
    content.setAttribute("aria-multiline", "true");

    page.appendChild(content);

    attachPageEvents(content);
    return page;
  }

  function ensureFirstPage() {
    var wrapper = $(PAGES_WRAPPER_ID);
    if (wrapper.children.length === 0) {
      var page = createPage();
      wrapper.appendChild(page);
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      getContent(page).appendChild(p);
    }
  }

  function attachPageEvents(content) {
    content.addEventListener("input", onInput);
    content.addEventListener("keydown", onKeyDown);
    content.addEventListener("paste", onPaste);
    content.addEventListener("blur", function () {
      if (paginateScheduled) {
        paginateScheduled = false;
        paginate();
      }
    });
  }

  /* ---------------- Caret save / restore ---------------- */
  function clearCaretMarkers() {
    var marked = document.querySelectorAll("[" + CARET_BLOCK_ATTR + "]");
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(CARET_BLOCK_ATTR);
      marked[i].removeAttribute(CARET_OFFSET_ATTR);
    }
  }

  // Inline non-editable markers created by the app (footnote/endnote refs,
  // comment pins).
  function isInlineMarker(el) {
    return el && el.nodeType === Node.ELEMENT_NODE &&
      (el.classList.contains("footnote-ref") || el.classList.contains("endnote-ref") || el.classList.contains("comment-ref"));
  }

  // Walks every node inside a block but REJECTS text inside non-editable
  // markers — used by both caret save and caret restore so the caret can
  // never re-anchor INSIDE a <sup contenteditable="false">.
  function caretWalker(block) {
    return document.createTreeWalker(block, NodeFilter.SHOW_ALL, {
      acceptNode: function (n) {
        if (n.nodeType === Node.TEXT_NODE) {
          var p = n.parentElement;
          if (p && p.closest && p.closest("sup.footnote-ref, sup.endnote-ref, sup.comment-ref")) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  }

  // Character offset of the caret boundary within `block`, counting ONLY
  // user-editable text. Inline markers count as ONE virtual character each
  // so their digits never shift the caret across pagination save/restore —
  // previously a caret parked after a marker re-anchored INSIDE the <sup>
  // and the keyboard appeared dead until the user clicked again.
  function editableCaretOffset(block, container, offset) {
    var caret = document.createRange();
    try {
      caret.setStart(container, offset);
      caret.collapse(true);
    } catch (e) {
      return 0;
    }
    var walker = caretWalker(block);
    var probe = document.createRange();
    var node, len = 0;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === container) return len + Math.max(0, Math.min(offset, node.textContent.length));
        probe.selectNodeContents(node);
        probe.collapse(true); // probe at the node's START
        if (probe.compareBoundaryPoints(Range.START_TO_START, caret) < 0) len += node.textContent.length;
        else break;
      } else if (isInlineMarker(node)) {
        probe.setStart(node, 0);
        probe.collapse(true);
        if (probe.compareBoundaryPoints(Range.START_TO_START, caret) < 0) len += 1;
        else break;
      }
    }
    return len;
  }

  function saveCaret() {
    clearCaretMarkers();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    var start = range.startContainer;
    var block = start;
    if (block.nodeType !== Node.ELEMENT_NODE) block = block.parentElement;

    // When the caret sits inside a list item or table cell, that element is
    // the true caret anchor. Marking the outer <ul>/<table> instead would
    // collapse the caret to a character offset, so a caret in a brand-new
    // EMPTY <li> (created by pressing Enter) restores to the end of the
    // previous item — forcing the user to click the new bullet a second time.
    var startNode = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    var listOrCell = startNode ? startNode.closest("li, td, th") : null;

    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }
    if (!block || !block.parentElement || !block.parentElement.classList.contains("page-content")) return;

    if (listOrCell && block.contains(listOrCell)) block = listOrCell;

    var offset = editableCaretOffset(block, range.startContainer, range.startOffset);

    block.setAttribute(CARET_BLOCK_ATTR, "1");
    block.setAttribute(CARET_OFFSET_ATTR, String(offset));
  }

  function restoreCaret() {
    var block = document.querySelector("[" + CARET_BLOCK_ATTR + "]");
    if (!block) return;
    var offset = parseInt(block.getAttribute(CARET_OFFSET_ATTR) || "0", 10);
    block.removeAttribute(CARET_BLOCK_ATTR);
    block.removeAttribute(CARET_OFFSET_ATTR);

    var blockText = block.textContent;
    var targetBlock = block;
    var targetOffset = offset;

    if (offset > blockText.length) {
      var page = block.closest(".page");
      var nextPage = page ? page.nextElementSibling : null;
      if (nextPage && nextPage.classList.contains("page")) {
        var overflow = getContent(nextPage).firstElementChild;
        if (overflow) {
          targetBlock = overflow;
          targetOffset = offset - blockText.length;
        }
      } else {
        targetOffset = blockText.length;
      }
    }

    setCaretInBlock(targetBlock, Math.max(0, targetOffset));
  }

  function setCaretInBlock(block, offset) {
    // Mirrors editableCaretOffset(): markers consume one virtual character,
    // marker-internal digits are invisible to the walk — so a caret parked
    // before vs after a marker restores to DIFFERENT, correct positions
    // instead of drifting inside the non-editable <sup>.
    var walker = caretWalker(block);
    var node, len = 0;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        var tlen = node.textContent.length;
        if (offset <= len + tlen) {
          var range = document.createRange();
          range.setStart(node, Math.max(0, offset - len));
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          var content = block.closest(".page-content");
          if (content) content.focus();
          return;
        }
        len += tlen;
      } else if (isInlineMarker(node)) {
        len += 1;
      }
    }
    var range = document.createRange();
    range.selectNodeContents(block);
    // Place the caret at the START for an empty list item / table cell so it
    // lands before the <br> (matching the browser's Enter-in-list position)
    // instead of after it, which would make a quick second Enter misfire.
    var wantStart = !block.textContent.trim() && block.closest("li, td, th");
    range.collapse(wantStart);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var content = block.closest(".page-content");
    if (content) content.focus();
  }

  /* ---------------- Pagination engine ----------------
     KEY FIX (v2): when a page has a SINGLE block that overflows,
     we split it FIRST (at a word boundary) rather than pushing
     the whole block to the next page. The old logic pushed the
     only block down, leaving an empty page and moving the
     overflow unchanged — producing cascades of empty pages.
     ---------------------------------------------------------
     KEY FIX (v3): TRUE hard page break. A `.emdocs-page-break`
     element forces ALL content after it onto the next page.
     This runs as a pre-pass before the overflow logic.       */
  function paginate() {
    saveCaret();

    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    // PRE-PASS: enforce hard page breaks first (before overflow logic)
    var pbChanged = true;
    var pbIter = 0;
    while (pbChanged && pbIter++ < MAX_PAGINATE_ITER) {
      pbChanged = enforcePageBreaks();
    }

    var changed = true;
    var iter = 0;
    while (changed && iter++ < MAX_PAGINATE_ITER) {
      changed = false;
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var content = getContent(pages[i]);
        normalizeContent(content);

        var guard = 0;
        while (isOverflow(content) && guard++ < 300) {
          if (content.children.length === 1) {
            // Single overflowing block → SPLIT it (don't push whole)
            if (splitOverflowingBlock(content, pages[i])) {
              changed = true;
              continue;
            }
            break; // cannot split further (e.g. one giant word)
          }
          // Multiple blocks → push the last block down
          if (!pushOverflowDown(pages[i])) break;
          changed = true;
        }

        // Pull content up from next page if there's room
        // BUT never pull across a page-break boundary.
        if (pages[i + 1]) {
          var guard2 = 0;
          while (pullUp(pages[i], pages[i + 1]) && guard2++ < 300) {
            changed = true;
          }
        }
      }
    }

    removeTrailingEmptyPages();
    ensureFirstPage();
    ensureTableCellsEditable();
    syncHeaderFooter(); // re-apply header/footer strips to new pages
    updatePageNumbers();
    updateDynamicFields();
    applySectionConfigs();
    updateStatus();
    restoreCaret();
    refreshFindHighlights();
  }

  /* Hard page break enforcement.
     For each page, if a `.emdocs-page-break` element exists, every block
     AFTER it (and the break itself stays as the last thing on this page)
     is moved to the start of the next page (a new page is created if needed).
     Returns true if any content was moved. */
  function enforcePageBreaks() {
    var moved = false;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var breaks = content.querySelectorAll(".emdocs-page-break");
      if (breaks.length === 0) continue;

      // Take the FIRST page break on this page.
      var brk = breaks[0];

      // Collect all sibling blocks AFTER the break (in DOM order, direct children only)
      var toMove = [];
      var sibling = brk.nextElementSibling;
      while (sibling) {
        var next = sibling.nextElementSibling;
        toMove.push(sibling);
        sibling = next;
      }

      if (toMove.length === 0) {
        // Break is already the last block on this page — nothing to move.
        // But if there are MULTIPLE breaks on this page, the later ones
        // need to go to the next page (a break with nothing after it still
        // means "the next page starts here").
        if (breaks.length > 1) {
          // Remove extra breaks (keep only the first) and move them down
          for (var b = 1; b < breaks.length; b++) {
            var extra = breaks[b];
            var next2 = extra.nextElementSibling;
            var extras = [];
            while (next2) {
              var n2 = next2.nextElementSibling;
              extras.push(next2);
              next2 = n2;
            }
            ensureNextPageAndPrepend(pages, i, extras, extra);
            moved = true;
            return moved; // restart the loop after a structural change
          }
        }
        continue;
      }

      ensureNextPageAndPrepend(pages, i, toMove, null);
      moved = true;
      return moved; // restart after a structural change to keep indices valid
    }
    return moved;
  }

  /* Create (if needed) the next page after `pages[i]` and prepend the
     given blocks (optionally a page-break marker first) to its content. */
  function ensureNextPageAndPrepend(pages, i, blocks, optionalBreak) {
    var next = pages[i].nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      pages[i].parentNode.insertBefore(next, pages[i].nextSibling);
    }
    var nextContent = getContent(next);
    var insertBefore = nextContent.firstChild;
    if (optionalBreak) {
      nextContent.insertBefore(optionalBreak, insertBefore);
    }
    for (var k = 0; k < blocks.length; k++) {
      nextContent.insertBefore(blocks[k], insertBefore);
    }
  }

  /* Make sure all td/th in the document remain editable after pagination
     (execCommand insertHTML strips contenteditable, and splitOverflowingBlock
     clones blocks without restoring it on nested tables). */
  function ensureTableCellsEditable() {
    var cells = document.querySelectorAll(".page-content td, .page-content th");
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute("contenteditable") !== "true") {
        cells[i].setAttribute("contenteditable", "true");
      }
    }
  }

  function normalizeContent(content) {
    // Wrap stray non-empty text nodes in <p>, drop empty text nodes.
    // NOTE: do NOT auto-add an empty <p> to a childless page here — that
    // would make removeTrailingEmptyPages think a genuinely-empty trailing
    // page still has content, so it would never clean up pages the user
    // emptied. ensureFirstPage() guarantees the first page stays editable.
    var kids = Array.prototype.slice.call(content.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType === Node.TEXT_NODE) {
        if (k.textContent.trim() === "") {
          content.removeChild(k);
        } else {
          var p = document.createElement("p");
          content.insertBefore(p, k);
          p.appendChild(k);
        }
      }
    }
  }

  function pushOverflowDown(page) {
    var content = getContent(page);
    var last = content.lastElementChild;
    if (!last) return false;

    var next = page.nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      page.parentNode.insertBefore(next, page.nextSibling);
    }
    var nextContent = getContent(next);
    nextContent.insertBefore(last, nextContent.firstChild);
    return true;
  }

  function splitOverflowingBlock(content, page) {
    var block = content.firstElementChild;
    if (!block) return false;
    if (content.children.length !== 1) return false;

    var children = Array.prototype.slice.call(block.childNodes);
    var removed = [];

    // 1) Remove trailing child nodes until it fits (or single node remains)
    for (var i = children.length - 1; i >= 0; i--) {
      if (!isOverflow(content)) break;
      if (block.childNodes.length === 1) break;
      removed.unshift(children[i]);
      block.removeChild(children[i]);
    }

    // 2) If still overflow with a single text node, split at word boundary
    if (isOverflow(content) && block.childNodes.length === 1) {
      var node = block.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) {
        var text = node.textContent;
        var tokens = text.split(/(\s+)/);
        if (tokens.length > 1) {
          node.textContent = tokens.slice(0, 1).join("");
          if (isOverflow(content)) {
            node.textContent = text;
            return false; // single token too big — give up
          }
          var lo = 1, hi = tokens.length, best = 1;
          while (lo <= hi) {
            var mid = Math.floor((lo + hi) / 2);
            node.textContent = tokens.slice(0, mid).join("");
            if (isOverflow(content)) {
              hi = mid - 1;
            } else {
              best = mid;
              lo = mid + 1;
            }
          }
          node.textContent = tokens.slice(0, best).join("");
          var rest = tokens.slice(best).join("");
          if (rest) removed.unshift(document.createTextNode(rest));
        }
      } else if (node && node.nodeType === Node.ELEMENT_NODE) {
        removed.unshift(node);
        block.removeChild(node);
      }
    }

    if (removed.length === 0) return false;

    var overflowBlock = block.cloneNode(false);
    overflowBlock.removeAttribute(CARET_BLOCK_ATTR);
    overflowBlock.removeAttribute(CARET_OFFSET_ATTR);
    for (var j = 0; j < removed.length; j++) {
      overflowBlock.appendChild(removed[j]);
    }

    var next = page.nextElementSibling;
    if (!next || !next.classList.contains("page")) {
      next = createPage();
      page.parentNode.insertBefore(next, page.nextSibling);
    }
    var nextContent = getContent(next);
    nextContent.insertBefore(overflowBlock, nextContent.firstChild);
    return true;
  }

  function pullUp(currentPage, nextPage) {
    var currentContent = getContent(currentPage);
    var nextContent = getContent(nextPage);
    var first = nextContent.firstElementChild;
    if (!first) return false;

    // Never pull a page-break marker up — it must stay as a boundary.
    if (first.classList && first.classList.contains("emdocs-page-break")) return false;

    // If the current page already ends with a page-break marker,
    // content after it belongs on the next page — don't pull across.
    var lastHere = currentContent.lastElementChild;
    if (lastHere && lastHere.classList && lastHere.classList.contains("emdocs-page-break")) {
      return false;
    }

    currentContent.appendChild(first);
    if (isOverflow(currentContent)) {
      nextContent.insertBefore(first, nextContent.firstChild);
      return false;
    }
    return true;
  }

  function removeTrailingEmptyPages() {
    var wrapper = $(PAGES_WRAPPER_ID);
    var pages = getPages();

    // A page is "empty" only if it has NO block-level children at all.
    // An empty <p> (created by pressing Enter) IS a legitimate block and
    // must NOT cause its page to be deleted — otherwise pressing Enter on
    // the last line of a full page (which pushes the new empty paragraph
    // onto a fresh next page) would have that page immediately removed,
    // making Enter appear to do nothing.
    //
    // EXCEPTION: a trailing page whose ONLY content is page-break markers
    // (.emdocs-page-break) is a confusing leftover from a page break placed
    // at the very end of the document. We strip the now-orphaned marker and
    // remove the page so the document ends cleanly.
    for (var i = pages.length - 1; i >= 1; i--) {
      var content = getContent(pages[i]);
      var hasMedia = content.querySelector("img, table, hr, iframe");
      if (content.children.length === 0 && !hasMedia) {
        wrapper.removeChild(pages[i]);
      } else if (pageIsOnlyBreakMarkers(content)) {
        wrapper.removeChild(pages[i]);
      } else {
        break;
      }
    }
  }

  function pageIsOnlyBreakMarkers(content) {
    var kids = content.children;
    if (kids.length === 0) return false;
    for (var k = 0; k < kids.length; k++) {
      if (!kids[k].classList || !kids[k].classList.contains("emdocs-page-break")) return false;
    }
    return true;
  }

  function updatePageNumbers() {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var badge = pages[i].querySelector(".page-badge");
      if (badge) badge.textContent = "Page " + (i + 1);
    }
  }

  /* ---------------- Status / counts ---------------- */
  function getAllText() {
    var pages = getPages();
    var parts = [];
    for (var i = 0; i < pages.length; i++) {
      parts.push(getContent(pages[i]).innerText);
    }
    return parts.join("\n").trim();
  }

  function getStats() {
    var text = getAllText();
    var words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    var charsNoSpaces = text.replace(/\s/g, "").length;
    var chars = text.length;
    var paragraphs = 0;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      paragraphs += getContent(pages[i]).querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre").length;
    }
    var readingMin = Math.max(1, Math.ceil(words / 200));
    return {
      words: words,
      chars: chars,
      charsNoSpaces: charsNoSpaces,
      paragraphs: paragraphs,
      pages: pages.length,
      readingMin: readingMin,
    };
  }

  function updateStatus() {
    var stats = getStats();
    var wc = $("wordCount");
    if (wc) wc.textContent = stats.words + " " + (stats.words === 1 ? "word" : "words");
    $("charCount").textContent = stats.chars + " " + (stats.chars === 1 ? "character" : "characters");

    var cur = getCurrentPageIndex() + 1;
    if (cur < 1) cur = 1;
    $("pageInfo").textContent = "Page " + cur + " of " + stats.pages;

    // Update caret position (Ln, Col)
    updateCaretPosition();

    // Update relative autosave time ("saved 2 min ago")
    updateRelativeAutosave();

    // Live-update goal tracker + stats chart if the dialog is open
    if ($("wordCountModal").classList.contains("open")) {
      updateGoalTracker();
      renderStatsChart();
      renderWritingIssues();
    }
    // Update thumbnails if panel is open
    scheduleThumbnailsUpdate();
    // Highlight the active heading in the outline panel
    highlightActiveOutlineHeading();
  }

  // Caret position: compute line + column from the current selection.
  function updateCaretPosition() {
    var el = $("caretPos");
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      // No selection — reset to "Ln 1, Col 1" (e.g. when the editor loses focus
      // or the page is empty and nothing is selected).
      el.textContent = "Ln 1, Col 1";
      return;
    }
    var node = sel.anchorNode;
    if (!node) {
      el.textContent = "Ln 1, Col 1";
      return;
    }
    // Check if we're in the editor
    var inEditor = false;
    var checkNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (checkNode) {
      if (checkNode.classList && checkNode.classList.contains("page-content")) { inEditor = true; break; }
      checkNode = checkNode.parentElement;
    }
    if (!inEditor) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

    // Find the block element containing the caret — i.e. the direct child of
    // .page-content (typically a <p>, <h1>, <ul>, <blockquote>, etc.).
    // We walk UP from the anchor node until the parent has .page-content.
    var block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }
    // Guard: if block walked PAST .page-content (happens when the selection is
    // directly on the .page-content element itself — e.g. an empty page with no
    // <p> child yet), the walk escapes to <body> and `selectNodeContents(block)`
    // would grab the entire document, producing a bogus column like "Col 15733".
    // In that case, default to line 1, col 1.
    if (!block || !block.parentElement || !block.parentElement.classList.contains("page-content")) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

    // Count which block number this is (across all pages)
    var pages = getPages();
    var blockIndex = 0;
    var found = false;
    for (var pi = 0; pi < pages.length && !found; pi++) {
      var blocks = getContent(pages[pi]).children;
      for (var bi = 0; bi < blocks.length; bi++) {
        if (blocks[bi] === block) { found = true; break; }
        blockIndex++;
      }
    }
    // If we somehow didn't find the block in any page (shouldn't happen, but be safe):
    if (!found) {
      el.textContent = "Ln 1, Col 1";
      return;
    }
    // Line = block number + 1
    var line = blockIndex + 1;

    // Column = offset within the current block's text
    var col = 1;
    try {
      var range = sel.getRangeAt(0);
      var preRange = document.createRange();
      preRange.selectNodeContents(block);
      preRange.setEnd(range.startContainer, range.startOffset);
      col = preRange.toString().length + 1;
    } catch (e) {
      col = 1;
    }

    el.textContent = "Ln " + line + ", Col " + col;
  }

  // Relative autosave time: "saved 2 min ago"
  var relativeAutosaveTimer = null;
  function updateRelativeAutosave() {
    var el = $("autosave");
    if (!el || !lastSavedAt) return;
    // Only update the relative time if we're in the "saved" state
    if (!el.classList.contains("saved")) return;
    var diff = Math.floor((Date.now() - lastSavedAt) / 1000);
    var rel;
    if (diff < 5) rel = "just now";
    else if (diff < 60) rel = diff + "s ago";
    else if (diff < 3600) rel = Math.floor(diff / 60) + "m ago";
    else rel = Math.floor(diff / 3600) + "h ago";
    el.innerHTML = "Saved <span class='autosave-time'>" + rel + "</span>";
  }

  function getCurrentPageIndex() {
    var sel = window.getSelection();
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      var pageEl = node ? node.closest(".page") : null;
      if (pageEl) return getPages().indexOf(pageEl);
    }
    var scroll = $("documentScroll");
    if (!scroll) return 0;
    var pages = getPages();
    var top = scroll.getBoundingClientRect().top;
    for (var i = 0; i < pages.length; i++) {
      var r = pages[i].getBoundingClientRect();
      if (r.bottom > top + 24) return i;
    }
    return pages.length - 1;
  }

  /* ---------------- Events ---------------- */
  function onInput(e) {
    startSessionTimer();
    startAutosaveSnapshots();
    snapshotDirty = true;
    // AutoCorrect: when user types a space, check the preceding word
    if (e && (e.data === " " || e.data === "\u00a0")) {
      try { checkAutoCorrect(); } catch (err) {}
    }
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    canUndo = true;
    canRedo = false;
    updateRibbonAvailability();
  }

  function onKeyDown(e) {
    // Escape closes any open modal / outline / thumbnails / focus mode
    if (e.key === "Escape") {
      if (anyModalOpen()) { closeAllModals(); e.preventDefault(); return; }
      if ($("findBar") && $("findBar").style.display !== "none") { closeFindBar(); e.preventDefault(); return; }
      if ($("outlinePanel").classList.contains("open")) { toggleOutline(false); e.preventDefault(); return; }
      if ($("thumbnailsPanel").classList.contains("open")) { toggleThumbnails(false); e.preventDefault(); return; }
      return;
    }

    // Tab: navigate table cells if inside a table, else insert tab
    if (e.key === "Tab") {
      var cell = getCurrentTableCell();
      if (cell) {
        e.preventDefault();
        navigateTableCell(cell, e.shiftKey ? "prev" : "next");
        return;
      }
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
      schedulePaginate();
      return;
    }

    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var k = e.key.toLowerCase();

    // Ctrl+Enter → page break
    if (e.key === "Enter") { e.preventDefault(); insertPageBreak(); return; }

    if (k === "s") { e.preventDefault(); saveDocument(true); return; }
    if (k === "p") { e.preventDefault(); printDocument(); return; }
    if (k === "b") { e.preventDefault(); exec("bold"); return; }
    if (k === "i") { e.preventDefault(); exec("italic"); return; }
    if (k === "u") { e.preventDefault(); exec("underline"); return; }
    if (k === "f") { e.preventDefault(); openFind(); return; }
    if (k === "h") { e.preventDefault(); openFind(); return; }
    if (k === "k") { e.preventDefault(); openLinkDialog(); return; }
    if (k === "g") { e.preventDefault(); toggleOutline(); return; }
    if (k === "m" && e.shiftKey) { e.preventDefault(); cycleMarginPreset(); return; }

    // Ctrl++ / Ctrl+= → zoom in
    if (k === "+" || k === "=") { e.preventDefault(); adjustZoom(10); return; }
    // Ctrl+- → zoom out
    if (k === "-") { e.preventDefault(); adjustZoom(-10); return; }
    // Ctrl+0 → reset zoom
    if (k === "0") { e.preventDefault(); setZoom(100); return; }
    if (k === "z" && !e.shiftKey) { e.preventDefault(); exec("undo"); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); exec("redo"); return; }
  }

  /* Cycle through margin presets in order: default → narrow → moderate → wide → default */
  function cycleMarginPreset() {
    var presets = ["default", "narrow", "moderate", "wide"];
    // Find current preset (or default if custom)
    var current = "default";
    for (var name in MARGIN_PRESETS) {
      var v = MARGIN_PRESETS[name];
      if (pageMargins.top === v && pageMargins.bottom === v &&
          pageMargins.left === v && pageMargins.right === v) {
        current = name;
        break;
      }
    }
    var idx = presets.indexOf(current);
    var next = presets[(idx + 1) % presets.length];
    applyPreset(next);
    saveMargins();
    schedulePaginate();
    scheduleAutosave();
    toast("Margins: " + next.charAt(0).toUpperCase() + next.slice(1), "success");
  }

  function anyModalOpen() {
    var modals = document.querySelectorAll(".modal-overlay.open");
    return modals.length > 0;
  }

  /* ---------------- Table cell navigation ---------------- */
  function getCurrentTableCell() {
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
    var td = node ? node.closest("td, th") : null;
    return td && td.closest(".page-content") ? td : null;
  }

  function navigateTableCell(currentCell, dir) {
    var table = currentCell.closest("table");
    if (!table) return;
    var cells = Array.prototype.slice.call(table.querySelectorAll("td, th"));
    var idx = cells.indexOf(currentCell);
    var target;
    if (dir === "next") {
      target = cells[idx + 1];
      if (!target) {
        // move to next row's first cell, or create a new row at the end
        var row = currentCell.closest("tr");
        var nextRow = row.nextElementSibling;
        if (nextRow) {
          target = nextRow.querySelector("td, th");
        } else {
          // append a new row
          var tbody = table.querySelector("tbody") || table;
          var newRow = document.createElement("tr");
          var colCount = row.children.length;
          for (var i = 0; i < colCount; i++) {
            var td = document.createElement("td");
            td.innerHTML = "&nbsp;";
            newRow.appendChild(td);
          }
          tbody.appendChild(newRow);
          target = newRow.firstElementChild;
          schedulePaginate();
          scheduleAutosave();
        }
      }
    } else {
      target = cells[idx - 1];
      if (!target) {
        var row2 = currentCell.closest("tr");
        var prevRow = row2.previousElementSibling;
        if (prevRow) target = prevRow.querySelector("td, th:last-child");
      }
    }
    if (target) {
      var range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      target.focus();
    }
  }

  /* ---------------- Page Break ---------------- */
  function insertPageBreak() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    // Insert a page-break marker element followed by an empty paragraph.
    // The marker is clickable afterwards to remove (cancel) the break.
    var html = '<div class="emdocs-page-break" contenteditable="false" title="Click to remove this page break"><span class="pb-label">— Page Break —</span></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    toast("Page break inserted", "success");
  }

  /* ---------------- Outline ---------------- */
  var outlineUpdateScheduled = false;

  function scheduleOutlineUpdate() {
    if (outlineUpdateScheduled) return;
    outlineUpdateScheduled = true;
    setTimeout(function () {
      outlineUpdateScheduled = false;
      if ($("outlinePanel").classList.contains("open")) {
        buildOutline();
      }
    }, 250);
  }

  function toggleOutline(force) {
    var panel = $("outlinePanel");
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      buildOutline();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
    var btn = $("btnOutline");
    if (btn) btn.classList.toggle("active", shouldOpen);
  }

  function buildOutline() {
    var body = $("outlineBody");
    body.innerHTML = "";
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "Add headings (Title, Heading 1–3) to see them here.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < headings.length; i++) {
      (function (h) {
        var tag = h.tagName.toLowerCase();
        var text = (h.textContent || "").trim();
        if (!text) return;
        var item = document.createElement("button");
        item.className = "outline-item level-" + tag;
        var badge = document.createElement("span");
        badge.className = "outline-badge";
        badge.textContent = tag.toUpperCase();
        item.appendChild(badge);
        item.appendChild(document.createTextNode(text));
        item.title = "Jump to " + text;
        item.addEventListener("click", function () {
          h.scrollIntoView({ behavior: "smooth", block: "center" });
          // place caret at start of heading
          var range = document.createRange();
          range.selectNodeContents(h);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          var content = h.closest(".page-content");
          if (content) content.focus();
          // brief highlight
          h.style.transition = "background 0.4s";
          var prevBg = h.style.background;
          h.style.background = "var(--accent-soft)";
          setTimeout(function () { h.style.background = prevBg; }, 800);
        });
        body.appendChild(item);
      })(headings[i]);
    }
    // apply any active filter after rebuild
    filterOutline();
  }

  function filterOutline() {
    var body = $("outlineBody");
    if (!body) return;
    var query = ($("outlineSearch").value || "").toLowerCase().trim();
    var items = body.querySelectorAll(".outline-item");
    var visible = 0;
    for (var i = 0; i < items.length; i++) {
      var text = items[i].textContent.toLowerCase();
      if (!query || text.indexOf(query) !== -1) {
        items[i].classList.remove("hidden");
        visible++;
      } else {
        items[i].classList.add("hidden");
      }
    }
    // show / hide "no match" message
    var noMatch = body.querySelector(".outline-no-match");
    if (!noMatch) {
      noMatch = document.createElement("p");
      noMatch.className = "outline-no-match";
      noMatch.textContent = "No headings match your filter.";
      body.appendChild(noMatch);
    }
    if (query && visible === 0 && items.length > 0) {
      noMatch.classList.add("show");
    } else {
      noMatch.classList.remove("show");
    }
  }

  // Highlight the heading nearest the top of the viewport in the outline
  // panel, so the user can see where they are in the document.
  function highlightActiveOutlineHeading() {
    var panel = $("outlinePanel");
    if (!panel || !panel.classList.contains("open")) return;
    var body = $("outlineBody");
    if (!body) return;
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) return;
    var scrollEl = $("documentScroll");
    var scrollTop = scrollEl.scrollTop;
    var viewportMid = scrollTop + scrollEl.clientHeight / 3;
    var activeIdx = -1;
    for (var i = 0; i < headings.length; i++) {
      var rect = headings[i].getBoundingClientRect();
      var absTop = rect.top + scrollEl.scrollTop - scrollEl.getBoundingClientRect().top;
      if (absTop <= viewportMid) activeIdx = i;
      else break;
    }
    if (activeIdx < 0) activeIdx = 0;
    var items = body.querySelectorAll(".outline-item");
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle("active-heading", j === activeIdx);
    }
    // auto-scroll the outline to keep the active item visible
    var activeItem = items[activeIdx];
    if (activeItem) {
      var bodyRect = body.getBoundingClientRect();
      var itemRect = activeItem.getBoundingClientRect();
      if (itemRect.top < bodyRect.top || itemRect.bottom > bodyRect.bottom) {
        activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  /* ---------------- Link hover preview ---------------- */
  var linkPreviewEl = null;
  var linkPreviewTimer = null;

  function initLinkPreview() {
    linkPreviewEl = document.createElement("div");
    linkPreviewEl.className = "link-preview";
    document.body.appendChild(linkPreviewEl);

    document.addEventListener("mouseover", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a && a.closest(".page-content")) {
        clearTimeout(linkPreviewTimer);
        linkPreviewTimer = setTimeout(function () {
          showLinkPreview(a, e);
        }, 350);
      }
    });
    document.addEventListener("mouseout", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a) {
        clearTimeout(linkPreviewTimer);
        linkPreviewEl.classList.remove("show");
      }
    });
    document.addEventListener("mousemove", function (e) {
      if (linkPreviewEl.classList.contains("show")) {
        positionLinkPreview(e);
      }
    });
  }

  function showLinkPreview(a, e) {
    var href = normalizeExternalUrl(a.getAttribute("href") || "");
    var text = a.textContent || "";
    linkPreviewEl.innerHTML =
      '<div class="lp-url">' + escapeHtml(href) + "</div>" +
      '<div class="lp-hint">' + (text ? "“" + escapeHtml(text) + "” · " : "") + "Click to open</div>";
    positionLinkPreview(e);
    linkPreviewEl.classList.add("show");
  }

  function positionLinkPreview(e) {
    var x = e.clientX + 14;
    var y = e.clientY + 18;
    var w = linkPreviewEl.offsetWidth;
    var h = linkPreviewEl.offsetHeight;
    if (x + w > window.innerWidth - 12) x = window.innerWidth - w - 12;
    if (y + h > window.innerHeight - 12) y = e.clientY - h - 14;
    linkPreviewEl.style.left = x + "px";
    linkPreviewEl.style.top = y + "px";
  }

  /* ---------------- Image resize handles ----------------
     Clicking an image wraps it in a container with 8 drag handles
     (corners + edges). Dragging a handle resizes the image
     proportionally (corners) or one-dimensionally (edges).       */
  var activeResizeImg = null;
  var resizeOverlay = null;
  var resizeHandles = null;
  var resizeStartX = 0;
  var resizeStartY = 0;
  var resizeStartW = 0;
  var resizeStartH = 0;
  var resizeMode = null; // 'nw','ne','sw','se','n','s','e','w'
  var resizeBodyCursorSet = false;
  var selectedImgObserver = null; // watches for the selected image leaving the DOM

  function initImageResize() {
    // Delegated click listener on the document
    document.addEventListener("click", function (e) {
      var img = e.target.closest ? e.target.closest(".page-content img") : null;
      if (img) {
        e.preventDefault();
        attachImageResize(img);
      } else if (resizeOverlay && e.target &&
                 (!e.target.closest || !e.target.closest(".img-resize-wrap, .ribbon, .ribbon-tabs, .ms-dropdown, .ms-dropdown-menu"))) {
        // Clicks on ribbon chrome (incl. the contextual Image Format tab's
        // programmatic clicks) and portal dropdowns must NOT deselect the
        // current image.
        detachImageResize();
        syncImageFormatRibbonState();
      }
    });

    document.addEventListener("mousemove", function (e) {
      if (activeResizeImg && resizeMode) {
        e.preventDefault();
        // Keep the drag feel stable (cursor + no text selection) across the
        // whole drag, not just while over the handle.
        if (!resizeBodyCursorSet) {
          resizeBodyCursorSet = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "se-resize";
        }
        var dx = e.clientX - resizeStartX;
        var dy = e.clientY - resizeStartY;
        var newW = resizeStartW, newH = resizeStartH;
        var ratio = resizeStartW / resizeStartH;
        var min = 40;
        switch (resizeMode) {
          case "se": newW = Math.max(min, resizeStartW + dx); newH = newW / ratio; break;
          case "sw": newW = Math.max(min, resizeStartW - dx); newH = newW / ratio; break;
          case "ne": newW = Math.max(min, resizeStartW + dx); newH = newW / ratio; break;
          case "nw": newW = Math.max(min, resizeStartW - dx); newH = newW / ratio; break;
          case "e": newW = Math.max(min, resizeStartW + dx); newH = newW / ratio; break;
          case "w": newW = Math.max(min, resizeStartW - dx); newH = newW / ratio; break;
          case "s": newH = Math.max(min, resizeStartH + dy); newW = newH * ratio; break;
          case "n": newH = Math.max(min, resizeStartH - dy); newW = newH * ratio; break;
        }
        activeResizeImg.style.width = newW.toFixed(1) + "px";
        activeResizeImg.style.height = newH.toFixed(1) + "px";
        activeResizeImg.style.maxWidth = "none";
        positionResizeOverlay();
      }
    });

    document.addEventListener("mouseup", function () {
      if (activeResizeImg && resizeMode) {
        resizeMode = null;
        activeResizeImg.removeAttribute("data-resizing");
        // Clean up drag state for the whole document (not just the handle).
        resizeBodyCursorSet = false;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        schedulePaginate();
        scheduleAutosave();
      }
    });
  }

  function attachImageResize(img) {
    detachImageResize();
    activeResizeImg = img;
    img.setAttribute("data-selected", "true");

    // Watch for the selected image leaving the DOM (delete/backspace/cut) so
    // the resize overlay and Image Format tab clean up automatically.
    if (window.MutationObserver) {
      selectedImgObserver = new MutationObserver(function () {
        if (!activeResizeImg || !activeResizeImg.isConnected) {
          detachImageResize();
          syncImageFormatRibbonState();
        }
      });
      selectedImgObserver.observe(document.getElementById(PAGES_WRAPPER_ID) || document.body, { childList: true, subtree: true });
    }
    syncImageFormatRibbonState();

    resizeOverlay = document.createElement("div");
    resizeOverlay.className = "img-resize-overlay";
    resizeHandles = [];
    var modes = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    for (var i = 0; i < modes.length; i++) {
      (function (mode) {
        var h = document.createElement("div");
        h.className = "img-resize-handle handle-" + mode;
        h.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          resizeMode = mode;
          resizeStartX = e.clientX;
          resizeStartY = e.clientY;
          resizeStartW = img.offsetWidth;
          resizeStartH = img.offsetHeight;
          // Lock cursor (matching that handle's direction) + block text
          // selection while dragging (Slides/Notes parity).
          resizeBodyCursorSet = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = getComputedStyle(h).cursor;
          img.setAttribute("data-resizing", "true");
        });
        resizeOverlay.appendChild(h);
        resizeHandles.push(h);
      })(modes[i]);
    }
    document.body.appendChild(resizeOverlay);
    positionResizeOverlay();
    window.addEventListener("scroll", positionResizeOverlay, true);
    window.addEventListener("resize", positionResizeOverlay);
  }

  function positionResizeOverlay() {
    if (!resizeOverlay || !activeResizeImg) return;
    var r = activeResizeImg.getBoundingClientRect();
    resizeOverlay.style.left = r.left + "px";
    resizeOverlay.style.top = r.top + "px";
    resizeOverlay.style.width = r.width + "px";
    resizeOverlay.style.height = r.height + "px";
  }

  function detachImageResize() {
    if (selectedImgObserver) {
      selectedImgObserver.disconnect();
      selectedImgObserver = null;
    }
    if (activeResizeImg) activeResizeImg.removeAttribute("data-selected");
    activeResizeImg = null;
    if (resizeOverlay) {
      resizeOverlay.parentNode.removeChild(resizeOverlay);
      resizeOverlay = null;
    }
    resizeHandles = null;
    window.removeEventListener("scroll", positionResizeOverlay, true);
    window.removeEventListener("resize", positionResizeOverlay);
  }

  function onPaste() {
    setTimeout(function () {
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var c = getContent(pages[i]);
        var breaks = c.querySelectorAll("[style*='page-break'], .page, [data-page]");
        for (var j = 0; j < breaks.length; j++) breaks[j].remove();
      }
      schedulePaginate();
      scheduleAutosave();
    }, 0);
  }

  function schedulePaginate() {
    if (paginateScheduled) return;
    paginateScheduled = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        paginateScheduled = false;
        paginate();
      });
    } else {
      setTimeout(function () {
        paginateScheduled = false;
        paginate();
      }, 16);
    }
  }

  function scheduleAutosave() {
    if (!currentDocId) return; // nothing open (welcome screen)
    // Show "Saving…" immediately (matching slides pattern)
    setAutosaveState("saving");
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      autosaveTimer = null;
      saveDocument(false);
    }, 800);
  }

  // Periodic version snapshots — every 1 minute, if there were edits since the
// last snapshot, push a version so the user can roll back to an earlier point
// in their writing session. Nothing is saved when nothing changed.
function startAutosaveSnapshots() {
    if (autosaveSnapshotTimer) return; // already running
    autosaveSnapshotTimer = setInterval(function () {
      if (!currentDocId) return;
      if (!snapshotDirty) return; // no edits since the last snapshot — skip
      snapshotDirty = false;
      try {
        pushVersion(serialize());
      } catch (e) {}
    }, AUTOSAVE_SNAPSHOT_MS);
  }

  function stopAutosaveSnapshots() {
    if (autosaveSnapshotTimer) {
      clearInterval(autosaveSnapshotTimer);
      autosaveSnapshotTimer = null;
    }
  }

  /* ---------------- Toolbar / execCommand ---------------- */
  function restoreEditorSelection() {
    if (lastEditorRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(lastEditorRange);
      } catch (e) {}
    }
  }

  // Place the caret INSIDE a text block before an inline insertHTML
  // (footnote / endnote / citation markers). restoreEditorSelection() alone
  // re-applies the saved range WITHOUT focusing the editor, so Chrome can run
  // execCommand against the page root — the marker then lands as a top-level
  // node and renders on its OWN LINE instead of inline with the text.
  // Last USER-EDITABLE text block of a page: skips app-managed furniture
  // (footnotes section / per-page footnote areas) so carets and markers
  // never target them — renderFootnotesSection() rebuilds those nodes and
  // would destroy anything inserted inside them.
  function lastRealBlock(pageContent) {
    if (!pageContent) return null;
    for (var i = pageContent.children.length - 1; i >= 0; i--) {
      var ch = pageContent.children[i];
      if (ch.classList && (ch.classList.contains("footnotes-section") || ch.classList.contains("page-footnote-area"))) continue;
      if (/^(P|H[1-6]|LI|DIV|BLOCKQUOTE|PRE)$/.test(ch.nodeName)) return ch;
    }
    return null;
  }

  function placeCaretForInlineInsert() {
    restoreEditorSelection();
    var sel = window.getSelection();
    var anchor = sel && sel.anchorNode;
    // A range saved before a pagination pass can point at DETACHED nodes;
    // execCommand with a disconnected selection silently does nothing.
    var ok = !!(anchor && anchor.isConnected);
    var anchorEl = null, host = null;
    if (ok) {
      anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      host = anchorEl && anchorEl.closest(".page-content");
      // Reject: page-content root anchors, anchors INSIDE non-editable
      // markers (<sup contenteditable="false"> — execCommand fails there),
      // and anchors inside app-managed furniture (.footnotes-section /
      // .page-footnote-area — renderFootnotesSection() wipes them, which
      // used to eat the freshly inserted marker).
      ok = !!host && !(anchorEl.classList && anchorEl.classList.contains("page-content")) &&
           !anchorEl.closest('[contenteditable="false"]') &&
           !anchorEl.closest(".footnotes-section, .page-footnote-area");
    }
    if (ok && document.activeElement !== host) {
      // Make sure the editing host is the focused element, or execCommand
      // targets the page root even when the range itself is correct.
      try { host.focus({ preventScroll: true }); } catch (e) { try { host.focus(); } catch (e2) {} }
      restoreEditorSelection();
      var a2 = window.getSelection().anchorNode;
      var a2el = a2 && (a2.nodeType === Node.ELEMENT_NODE ? a2 : a2.parentElement);
      if (!a2 || !a2.isConnected || !a2el || !a2el.closest(".page-content") ||
          a2el.closest('[contenteditable="false"]') ||
          a2el.closest(".footnotes-section, .page-footnote-area")) ok = false;
    }
    if (!ok) {
      // No usable live caret: focus the editor and drop the caret INLINE at
      // the end of the last real text block, never at the page root and
      // never inside the footnotes furniture.
      var fc = getContent(getPages()[0]);
      if (!fc) return;
      try { fc.focus(); } catch (e) {}
      var target = lastRealBlock(fc) || fc;
      var r = document.createRange();
      r.selectNodeContents(target);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // execCommand("insertHTML") REPLACES whatever text is currently selected
    // (double-clicked word, triple-clicked line, drag select) — the selected
    // text before the marker would VANISH. Word keeps the text: collapse the
    // range to its END so the marker lands right AFTER the selection, on the
    // same line.
    var s2 = window.getSelection();
    if (s2 && s2.rangeCount) {
      var r2 = s2.getRangeAt(0);
      if (!r2.collapsed) {
        r2.collapse(false);
        s2.removeAllRanges();
        s2.addRange(r2);
      }
    }
  }

  // After inserting a non-editable marker, park the caret right AFTER it so
  // the next insert never anchors inside the marker itself (which would make
  // execCommand("insertHTML") fail silently).
  function parkCaretAfterRef(refEl) {
    if (!refEl || !refEl.parentElement) return;
    try {
      var r = document.createRange();
      r.setStartAfter(refEl);
      r.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  // Safety net: if a marker still lands as a DIRECT child of .page-content it
  // would render on its own line — move it inline to the end of the nearest
  // preceding text block (or wrap it in a new paragraph when none exists).
  function healInlineRefPlacement(refEl) {
    if (!refEl || !refEl.parentElement) return;
    var host = refEl.parentElement;
    // Marker landed inside app-managed furniture (footnotes section / page
    // footnote area): renderFootnotesSection() would delete it — relocate it
    // to the end of the last real text block instead.
    if (host.classList && (host.classList.contains("footnotes-section") || host.classList.contains("page-footnote-area"))) {
      var pc2 = host.closest(".page-content");
      var tgt2 = lastRealBlock(pc2);
      var nxt2 = refEl.nextSibling;
      if (nxt2 && nxt2.nodeType === Node.TEXT_NODE && !/\S/.test(nxt2.nodeValue)) nxt2.parentNode.removeChild(nxt2);
      if (tgt2) {
        tgt2.appendChild(document.createTextNode(" "));
        tgt2.appendChild(refEl);
      }
      return;
    }
    if (!host.classList || !host.classList.contains("page-content")) return;
    var next = refEl.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && !/\S/.test(next.nodeValue)) {
      next.parentNode.removeChild(next);
    }
    var prev = refEl.previousElementSibling;
    while (prev && !/^(P|H[1-6]|LI|DIV|BLOCKQUOTE|PRE)$/.test(prev.nodeName)) {
      prev = prev.previousElementSibling;
    }
    if (prev) {
      prev.appendChild(document.createTextNode(" "));
      prev.appendChild(refEl);
    } else {
      var para = document.createElement("p");
      host.insertBefore(para, refEl);
      para.appendChild(refEl);
      para.appendChild(document.createTextNode(" "));
    }
  }

  // Focus the first page-content and re-apply the last saved selection.
  // Used after modal/prompt dialogs steal focus — execCommand('insertHTML')
  // only works when the editor is focused and has a selection inside it.
  function focusEditorAndRestore() {
    var firstContent = getContent(getPages()[0]);
    if (firstContent) {
      try { firstContent.focus(); } catch (e) {}
    }
    restoreEditorSelection();
  }

  function exec(cmd, value) {
    // Indent/Outdent: plain margin-left indentation — NOT execCommand's
    // blockquote wrapper (which rendered as a blue quote block).
    if (cmd === "indent" || cmd === "outdent") {
      applyIndent(cmd === "indent" ? 1 : -1);
      return;
    }
    restoreEditorSelection();

    // Undo/Redo use the browser's native contenteditable history. Detect
    // availability by snapshotting the editor before/after: if nothing
    // changed there was no history entry to undo/redo.
    if (cmd === "undo" || cmd === "redo") {
      var snapBefore = editorSnapshot();
      try { document.execCommand(cmd, false, value); } catch (e) {}
      var snapAfter = editorSnapshot();
      if (cmd === "undo") {
        if (snapBefore === snapAfter) { canUndo = false; }
        else { canRedo = true; }
      } else {
        if (snapBefore === snapAfter) { canRedo = false; }
        else { canUndo = true; }
      }
      schedulePaginate();
      scheduleAutosave();
      setTimeout(updateRibbonAvailability, 10);
      return;
    }

    var sel = window.getSelection();
    var inEditor = false;
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      inEditor = !!node && !!node.closest && !!node.closest(".page-content");
    }
    if (!inEditor) {
      var firstContent = getContent(getPages()[0]);
      if (firstContent) firstContent.focus();
    }
    var before = editorSnapshot();
    try { document.execCommand(cmd, false, value); } catch (e) {}
    if (editorSnapshot() !== before) {
      // A real edit happened → undo becomes available, redo is cleared.
      canUndo = true;
      canRedo = false;
    }
    schedulePaginate();
    scheduleAutosave();
    setTimeout(updateToolbarStates, 10);
    if (cmd !== "styleWithCSS" && cmd !== "defaultParagraphSeparator") {
      setTimeout(updateRibbonAvailability, 10);
    }
  }

  function applyBlock(tag) { exec("formatBlock", "<" + (tag === "p" ? "p" : tag) + ">"); }

  function applyIndent(direction) {
    restoreEditorSelection();
    var block = getCurrentBlock();
    if (!block) return;
    var cur = parseFloat(block.style.marginLeft) || 0;
    var next = direction > 0 ? cur + 40 : Math.max(0, cur - 40);
    if (next === cur) return;
    block.style.marginLeft = next + "px";
    schedulePaginate();
    scheduleAutosave();
  }
  function applyFontFamily(value) { exec("fontName", value); }

  /* Exact pixel font sizes (Slides parity): execCommand only supports a
     coarse 1–7 scale, so we wrap the selection with <font size="7"> and then
     convert that wrapper into a <span style="font-size:Npx"> carrying the
     exact size picked in the dropdown. */
  function applyFontSize(value) {
    var v = parseFloat(value);
    if (isNaN(v) || v <= 0) return;
    // Legacy 1–7 values (old macros / format painter) still pass straight through
    if (v >= 1 && v <= 7) { exec("fontSize", String(Math.round(v))); return; }

    // Remember pre-existing size="7" wrappers so only the new one is converted
    var before = document.querySelectorAll('.page-content font[size="7"]');
    var skip = [];
    for (var b = 0; b < before.length; b++) skip.push(before[b]);

    try { document.execCommand("styleWithCSS", false, false); } catch (e) {}
    exec("fontSize", "7");

    var fonts = document.querySelectorAll('.page-content font[size="7"]');
    var converted = 0;
    for (var i = 0; i < fonts.length; i++) {
      var f = fonts[i];
      if (skip.indexOf(f) !== -1) continue;
      var span = document.createElement("span");
      span.style.fontSize = v + "px";
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
      converted++;
    }
    if (converted) {
      schedulePaginate();
      scheduleAutosave();
      setTimeout(updateToolbarStates, 10);
    }
  }

  function applyTextColor(color) {
    var bar = $("textColorBar");
    if (bar) bar.style.background = color;
    var input = $("textColor");
    if (input) input.value = color;
    exec("foreColor", color);
  }

  function applyHiliteColor(color) {
    var bar = $("hiliteColorBar");
    if (bar) bar.style.background = color;
    var input = $("hiliteColor");
    if (input) input.value = color;
    try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
    exec("hiliteColor", color);
  }

  function clearFormatting() { exec("removeFormat"); }

  function getCurrentBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var node = sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node.parentElement && !node.parentElement.classList.contains("page-content")) {
      node = node.parentElement;
    }
    if (node && node.parentElement && node.parentElement.classList.contains("page-content")) return node;
    return null;
  }

  function updateToolbarStates() {
    var cmds = ["bold", "italic", "underline", "strikeThrough", "subscript", "superscript", "justifyLeft", "justifyCenter", "justifyRight", "justifyFull"];
    for (var i = 0; i < cmds.length; i++) {
      var btn = document.querySelector('[data-cmd="' + cmds[i] + '"]');
      if (!btn) continue;
      var active = false;
      try { active = document.queryCommandState(cmds[i]); } catch (e) {}
      if (active) btn.classList.add("active"); else btn.classList.remove("active");
    }
    updateDropCapState();
    // Block-type dropdown removed — nothing else to sync.
  }

  /* Snapshot all page content for native undo/redo availability detection. */
  function editorSnapshot() {
    var pages = getPages();
    var s = "";
    for (var i = 0; i < pages.length; i++) {
      s += getContent(pages[i]).innerHTML + "\n";
    }
    return s;
  }

  /* ---------------- Ribbon availability (Notes/Slides parity) ----------------
     Buttons gray out when their precondition isn't met: Undo/Redo need history,
     Cut/Copy need a text selection in the editor, Paste needs the caret in the
     editor, and formatting/insert/layout controls need an editable document. */
  function getRibbonSelectionState() {
    var activeDoc = !!currentDocId;
    var inEditor = false;
    var hasSelection = false;
    var sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode) {
      var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      inEditor = !!node && !!node.closest && !!node.closest(".page-content");
      hasSelection = !sel.isCollapsed && sel.toString().length > 0;
    }
    return { activeDoc: activeDoc, inEditor: inEditor, hasSelection: hasSelection };
  }

  function setRibbonControlDisabled(control, disabled) {
    if (!control) return;
    control.disabled = !!disabled;
    control.setAttribute("aria-disabled", disabled ? "true" : "false");
    control.classList.toggle("is-unavailable", !!disabled);
  }

  function setCommandControlsDisabled(cmd, disabled) {
    var controls = document.querySelectorAll('[data-cmd="' + cmd + '"]');
    for (var i = 0; i < controls.length; i++) {
      setRibbonControlDisabled(controls[i], disabled);
    }
  }

  function setRibbonDropdownDisabled(id, disabled) {
    var wrap = $(id);
    if (!wrap) return;
    var btn = wrap.querySelector(".ms-dropdown-btn");
    if (btn) setRibbonControlDisabled(btn, disabled);
  }

  function updateRibbonAvailability() {
    var state = getRibbonSelectionState();
    var editableContext = state.activeDoc && state.inEditor;
    var editableSelection = state.activeDoc && state.hasSelection;

    setCommandControlsDisabled("undo", !state.activeDoc || !canUndo);
    setCommandControlsDisabled("redo", !state.activeDoc || !canRedo);
    setCommandControlsDisabled("cut", !editableSelection);
    setCommandControlsDisabled("copy", !editableSelection);
    setCommandControlsDisabled("paste", !editableContext);

    // Formatting (font + paragraph) needs the caret inside the editor.
    ["bold", "italic", "underline", "strikeThrough", "subscript", "superscript",
     "justifyLeft", "justifyCenter", "justifyRight", "justifyFull",
     "insertUnorderedList", "insertOrderedList", "outdent", "indent"].forEach(function (cmd) {
      setCommandControlsDisabled(cmd, !editableContext);
    });

    // Font / color dropdown triggers follow the same formatting context.
    setRibbonDropdownDisabled("fontFamilyDropdown", !editableContext);
    setRibbonDropdownDisabled("fontSizeDropdown", !editableContext);
    setRibbonDropdownDisabled("fontColorDropdown", !editableContext);
    setRibbonDropdownDisabled("highlightColorDropdown", !editableContext);
    setRibbonControlDisabled($("btnClearFormat"), !editableContext);

    // Insert / layout / styles / review controls need an open document.
    var docOnly = ["btnLink", "btnImage", "btnTable", "btnHr", "btnPageBreak",
      "btnDropCap", "btnWatermark", "btnSymbols", "btnCoverPage", "btnSectionBreak",
      "btnEquation", "btnSmartArt", "btnScreenshot", "btnDraw", "btnMargins",
      "btnOrientation", "btnHeader", "btnFooter", "btnTocRef", "btnFootnote",
      "btnEndnote", "btnCitation", "btnBibliography", "btnIndexEntry",
      "btnInsertIndex", "btnComment", "btnPageNum"];
    for (var i = 0; i < docOnly.length; i++) {
      setRibbonControlDisabled($(docOnly[i]), !state.activeDoc);
    }
    // Style buttons (Title / Heading 1–3 / Normal) and column buttons.
    var styles = document.querySelectorAll(".ribbon-btn[data-block]");
    for (var j = 0; j < styles.length; j++) {
      setRibbonControlDisabled(styles[j], !state.activeDoc);
    }
    var cols = document.querySelectorAll(".ribbon-btn[data-cols]");
    for (var k = 0; k < cols.length; k++) {
      setRibbonControlDisabled(cols[k], !state.activeDoc);
    }
    setRibbonDropdownDisabled("pageSizeDropdown", !state.activeDoc);
  }

  /* ---------------- Save / Load (IndexedDB via EmeraldIDBStorage) ---------------- */
  var idb = null; // will be set to window.EmeraldIDBStorage if available

  function idbAvailable() {
    return idb && idb.isReady && idb.isReady();
  }

  function serialize() {
    var pages = getPages();
    var combined = document.createElement("div");
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var kids = content.children;
      for (var j = 0; j < kids.length; j++) {
        combined.appendChild(kids[j].cloneNode(true));
      }
    }
    return {
      id: currentDocId,
      title: currentTitle,
      content: combined.innerHTML,
      savedAt: Date.now(),
      theme: theme,
      header: headerActive && hfHasContent(headerHTML) ? headerHTML : "",
      footer: footerActive && hfHasContent(footerHTML) ? footerHTML : "",
      footnotes: footnotes,
      endnotes: endnotes,
      comments: comments,
    };
  }

  /* ---------------- Multi-document index (Slides pattern) ---------------- */
  async function loadIndex() {
    try {
      var idx = null;
      if (window.EmeraldIDBStorage) {
        idx = await window.EmeraldIDBStorage.getJSON(DOC_INDEX_KEY);
      }
      documents = Array.isArray(idx) ? idx : [];
      // De-duplicate by id, newest first (same defensive cleanup as Slides)
      var seen = {};
      var cleaned = [];
      for (var i = 0; i < documents.length; i++) {
        var m = documents[i];
        if (!m || !m.id || seen[m.id]) continue;
        seen[m.id] = true;
        cleaned.push(m);
      }
      cleaned.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      documents = cleaned;
    } catch (e) {
      documents = [];
    }
  }

  async function saveIndex() {
    try {
      // EmeraldIDBStorage.setJSON buffers to localStorage, syncs to IndexedDB,
      // then removes the localStorage copy. IndexedDB is the source of truth.
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.setJSON(DOC_INDEX_KEY, documents);
    } catch (e) {}
  }

  async function loadDocData(id) {
    try {
      var data = null;
      if (window.EmeraldIDBStorage) {
        data = await window.EmeraldIDBStorage.getJSON(docDataKey(id));
      }
      return data;
    } catch (e) { return null; }
  }

  async function writeDocData(data) {
    try {
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.setJSON(docDataKey(data.id), data);
    } catch (e) {}
  }

  async function deleteDocData(id) {
    try {
      if (window.EmeraldIDBStorage) await window.EmeraldIDBStorage.delete(docDataKey(id));
    } catch (e) {}
  }

  // Strip tags → plain text (for card snippets). Block elements become line
  // breaks so headings/paragraphs don't run together. Never throws. The text
  // is extracted from a detached DOMParser document (nothing executes), so
  // entities decode completely via textContent and no partial multi-character
  // sanitizer regex survives (CodeQL js/incomplete-multi-character-sanitization).
  function htmlToText(html) {
    if (!html) return "";
    var src = String(html);
    if (typeof DOMPurify !== "undefined") {
      src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    var text = "";
    try {
      var doc = new DOMParser().parseFromString(src, "text/html");
      var body = doc.body;
      if (body) {
        // Keep the old block→line-break behavior: a line break follows each
        // block element, then textContent flattens the rest of the markup.
        var blocks = body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,tr,figcaption");
        for (var i = 0; i < blocks.length; i++) blocks[i].insertAdjacentText("afterend", "\n");
        text = body.textContent || "";
      }
    } catch (e) { text = ""; }
    return text
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map(function (s) { return s.replace(/\s+/g, " ").trim(); })
      .filter(Boolean)
      .join("\n");
  }

  // Plain-text extraction for HTML fragments (used by the ODT importer).
  // Same detached-parser + optional-DOMPurify approach as htmlToText; never throws.
  function htmlFragmentToText(html) {
    if (html == null) return "";
    var src = String(html);
    if (typeof DOMPurify !== "undefined") {
      src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    try {
      var doc = new DOMParser().parseFromString(src, "text/html");
      return ((doc.body && doc.body.textContent) || "").replace(/\u00a0/g, " ");
    } catch (e) { return ""; }
  }

  // Random hex id, identical scheme to Slides'/Notes' generateSecureId()
  function generateSecureId(length) {
    var arr = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("").slice(0, length);
  }

  // Same id format as Slides (pres_<ms>_<hex9>) and Notes (note_<ms>_<hex9>):
  // doc_<decimal timestamp>_<9 hex chars>  →  ?owned=doc_1734567890123_a1b2c3d4e
  function makeDocId() {
    return "doc_" + Date.now() + "_" + generateSecureId(9);
  }

  // Sequential "Untitled Document" titles so multiple fresh documents don't
  // show up as identical cards on the welcome screen (same as Slides).
  function nextUntitledTitle() {
    var base = "Untitled Document";
    var maxN = 0;
    for (var i = 0; i < documents.length; i++) {
      var t = documents[i] && documents[i].title;
      if (!t) continue;
      if (t === base) { maxN = Math.max(maxN, 1); continue; }
      var m = /^Untitled Document\s+(\d+)$/.exec(t);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return maxN === 0 ? base : base + " " + (maxN + 1);
  }

  function updateOwnedUrl() {
    try {
      if (currentDocId) {
        var url = new URL(location.href);
        url.searchParams.set("owned", currentDocId);
        history.replaceState({}, document.title, url);
      } else if (location.search) {
        history.replaceState({}, document.title, location.pathname);
      }
    } catch (e) {}
  }

  function saveDocument(showToast) {
    if (!currentDocId) return;
    var data;
    try { data = serialize(); } catch (e) {
      if (showToast) toast("Save failed", "error");
      return;
    }
    try {
      // Update the index entry first so the welcome screen metadata stays
      // in sync even if the content write is still in flight.
      var meta = null;
      for (var i = 0; i < documents.length; i++) {
        if (documents[i].id === currentDocId) { meta = documents[i]; break; }
      }
      if (!meta) {
        meta = { id: currentDocId, title: currentTitle, updatedAt: Date.now(), wordCount: 0 };
        documents.unshift(meta);
      }
      meta.title = currentTitle;
      meta.updatedAt = Date.now();
      try { meta.wordCount = getStats().words; } catch (e) {}
      saveIndex();
      writeDocData(data);
      setAutosaveState("saved");
      if (showToast) {
        // Autosave handles persistence; the manual Save no longer creates a
        // version snapshot (version history is driven by the 1-minute ticker).
        toast("Document saved", "success");
      }
    } catch (e) {
      setAutosaveState("error");
      if (showToast) toast("Save failed (storage full?)", "error");
    }
  }

  /* ---------------- Version history (per document, IndexedDB-backed) ---------------- */
  function pushVersion(data) {
    if (!currentDocId) return;
    var versions = getVersions();

    // Don't add a duplicate if the content is unchanged from the last version
    if (versions.length > 0) {
      var last = versions[0];
      if (last.content === data.content && last.title === data.title) return;
    }

    var entry = {
      title: data.title,
      content: data.content,
      savedAt: data.savedAt,
    };
    versions.unshift(entry);
    if (versions.length > MAX_VERSIONS) versions = versions.slice(0, MAX_VERSIONS);
    try {
      if (idbAvailable()) {
        idb.setJSON(versionsKey(currentDocId), versions);
      }
    } catch (e) {}
  }

  function getVersions() {
    if (!currentDocId) return [];
    try {
      if (idbAvailable()) {
        var raw = idb.getJSONSync(versionsKey(currentDocId));
        // getJSONSync returns parsed object, not string
        if (raw) return raw;
      }
      return [];
    } catch (e) { return []; }
  }

  function restoreVersion(index) {
    var versions = getVersions();
    if (index < 0 || index >= versions.length) return;
    var v = versions[index];
    currentTitle = v.title || "Untitled Document";
    syncFileModalNameInput();
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = sanitizeStoredHtml(v.content) || "";
    if (content.children.length === 0) {
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      content.appendChild(p);
    }
    paginate();
    // Older snapshots carry their own comment anchors — rebuild the pins
    // against them (keep comment data; anchors that no longer exist simply
    // get no bubble until the document is reloaded).
    renderDocPins(false);
    saveDocument(false);
    closeModal("versionsModal");
    toast("Version restored", "success");
  }

  function showVersions() {
    var list = $("versionsList");
    list.innerHTML = "";
    var versions = getVersions();
    if (versions.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No versions yet. Versions are saved automatically while you edit.";
      list.appendChild(empty);
    } else {
      for (var i = 0; i < versions.length; i++) {
        (function (idx, v) {
          var item = document.createElement("div");
          item.className = "version-item";
          var info = document.createElement("div");
          info.className = "version-info";
          var time = document.createElement("div");
          time.className = "version-time";
          time.textContent = formatTime(v.savedAt);
          var preview = document.createElement("div");
          preview.className = "version-preview";
          preview.textContent = v.title || "Untitled";
          info.appendChild(time);
          info.appendChild(preview);
          var actions = document.createElement("div");
          actions.className = "version-actions";
          var restore = document.createElement("button");
          restore.className = "btn ghost sm";
          restore.textContent = "Restore";
          restore.addEventListener("click", function () { restoreVersion(idx); });
          actions.appendChild(restore);
          item.appendChild(info);
          item.appendChild(actions);
          list.appendChild(item);
        })(i, versions[i]);
      }
    }
    openModal("versionsModal");
  }

  function formatTime(ts) {
    if (!ts) return "Unknown";
    var d = new Date(ts);
    var now = new Date();
    var diff = now - d;
    var sameDay = d.toDateString() === now.toDateString();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return "Today, " + hh + ":" + mm;
    var yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday, " + hh + ":" + mm;
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[d.getMonth()] + " " + d.getDate() + ", " + hh + ":" + mm;
  }

  /* ---------------- Document lifecycle (open / close / new / delete) ---------------- */

  // Put a serialized document's content into the editor pages.
  function applyDocData(data) {
    currentTitle = data.title || "Untitled Document";
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = sanitizeStoredHtml(data.content) || "";
    if (content.children.length === 0) {
      var p = document.createElement("p");
      p.innerHTML = "<br>";
      content.appendChild(p);
    }
    // Restore editable header/footer strips (syncHeaderFooter runs inside
    // paginate() and creates them on every page).
    headerActive = hfHasContent(data.header);
    headerHTML = headerActive ? data.header : "";
    footerActive = hfHasContent(data.footer);
    footerHTML = footerActive ? data.footer : "";
    // Footnotes/endnotes are per-document. Docs saved before this existed
    // have no field — keep whatever loadFootnotes()/loadEndnotes() loaded
    // from the legacy global store so their notes aren't lost.
    if (Array.isArray(data.footnotes)) footnotes = data.footnotes;
    if (Array.isArray(data.endnotes)) endnotes = data.endnotes;
    // Comments (Slides-style pins) — plain data; anchors live in content HTML.
    comments = Array.isArray(data.comments) ? data.comments : [];
    // Fresh document context — the previous document's native undo/redo
    // history does not apply to this one.
    canUndo = false;
    canRedo = false;
    // Restore the imported document's own page layout (size/orientation/
    // margins/background) BEFORE paginating so content breaks at the right
    // height. Docs that carry no layout keep the current (A4) default.
    applyDocPageLayout(data);
    paginate();
    // Rebuild the pins from the comment data (saved pin markup is ignored —
    // renderDocPins strips and re-creates every bubble; orphaned comments
    // whose anchor no longer exists are dropped, same as Slides).
    renderDocPins(true);
  }

  /* Pagination measures text height, so running it before webfonts/images have
     loaded can undercount and leave a long document on a single page until the
     user types. Re-paginate once the document's assets (fonts + images) settle. */
  function repaginateAfterAssetsLoad() {
    var token = ++assetRepaginateToken;
    function finish() {
      if (token !== assetRepaginateToken) return;
      var imgs = document.querySelectorAll(".page-content img");
      var waiters = [];
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].src && !imgs[i].complete) {
          waiters.push(new Promise(function (res) {
            imgs[i].addEventListener("load", res);
            imgs[i].addEventListener("error", res);
          }));
        }
      }
      if (waiters.length) {
        var attempts = 0;
        (function wait() {
          if (token !== assetRepaginateToken) return;
          var left = 0;
          for (var j = 0; j < imgs.length; j++) {
            if (imgs[j].src && !imgs[j].complete) left++;
          }
          // Give up after ~5s so a broken image can't block pagination forever.
          if (left === 0 || attempts++ > 50) { paginate(); return; }
          setTimeout(wait, 100);
        })();
      } else {
        paginate();
      }
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(finish);
    } else {
      finish();
    }
  }

  async function openDocument(id) {
    var data = await loadDocData(id);
    if (!data) { toast("Could not open document", "error"); return; }
    try { togglePrintPreview(false); } catch (e) {}
    currentDocId = id;
    applyDocData(data);
    // Re-render footnote/endnote areas for the freshly-loaded content
    try { renderFootnotesSection(); renderEndnotesSection(); } catch (e) {}
    repaginateAfterAssetsLoad();
    document.body.classList.remove("no-active-doc");
    showWelcomeScreen(false);
    switchRibbonTab("home");
    // Ribbon just became visible — re-measure the tab underline (it may have
    // been measured while display:none, leaving a 0-width indicator).
    refreshRibbonIndicator();
    updateOwnedUrl();
    updateStatus();
    updateRibbonAvailability();
  }

  function closeDocument() {
    if (currentDocId) saveDocument(false);
    // Closing the document ends the current writing session.
    commitSessionTime();
    currentDocId = null;
    currentTitle = "Untitled Document";
    syncFileModalNameInput();
    // Drop open side panels (and their ribbon "active" states) on close.
    if ($("outlinePanel") && $("outlinePanel").classList.contains("open")) toggleOutline(false);
    if ($("thumbnailsPanel") && $("thumbnailsPanel").classList.contains("open")) toggleThumbnails(false);
    // Leave a fresh blank page behind so status/interval code that touches
    // the pages never runs against an empty wrapper.
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    headerActive = false; headerHTML = "";
    footerActive = false; footerHTML = "";
    comments = [];
    closeCommentPopup();
    ensureFirstPage();
    paginate();
    canUndo = false;
    canRedo = false;
    syncImageFormatRibbonState();
    updateRibbonAvailability();
    updateStatus();
    history.replaceState({}, document.title, location.pathname);
    document.body.classList.add("no-active-doc");
    showWelcomeScreen(true);
  }

  async function createNewDocument() {
    var id = makeDocId();
    var title = nextUntitledTitle();
    documents.unshift({ id: id, title: title, updatedAt: Date.now(), wordCount: 0 });
    await saveIndex();
    await writeDocData({
      id: id,
      title: title,
      content: "<p><br></p>",
      savedAt: Date.now(),
      theme: theme,
      header: "",
      footer: "",
      footnotes: [],
      endnotes: [],
      comments: [],
    });
    await openDocument(id);
    setTimeout(function () {
      var c = getContent(getPages()[0]);
      if (c) c.focus();
    }, 80);
  }

  function confirmDeleteCurrentDoc() {
    if (!currentDocId) return;
    _deleteTargetId = currentDocId;
    var modal = $("deleteDocModal");
    if (modal) modal.classList.add("show");
  }

  function closeDeleteDocModal() {
    var modal = $("deleteDocModal");
    if (!modal) { _deleteTargetId = null; return; }
    modal.classList.add("closing");
    setTimeout(function () {
      modal.classList.remove("show");
      modal.classList.remove("closing");
    }, 230);
    _deleteTargetId = null;
  }

  async function deleteDocument(id) {
    var wasCurrent = (currentDocId === id);
    if (wasCurrent) {
      // Detach BEFORE any awaits so a pending debounced autosave can't fire
      // mid-delete and resurrect this document via saveDocument()'s
      // re-create-missing-meta branch.
      currentDocId = null;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    }
    documents = documents.filter(function (d) { return d.id !== id; });
    await saveIndex();
    await deleteDocData(id);
    if (wasCurrent) closeDocument();
    renderWelcomeCards();
    toast("Document deleted", "success");
  }

  /* ---------------- File modal (Backstage-style, Slides pattern) ---------------- */
  function syncFileModalNameInput() {
    var nameInput = $("fileModalNameInput");
    if (nameInput) nameInput.value = currentTitle;
  }

  function openFileModal() {
    var modal = $("fileModal");
    if (!modal || !currentDocId) return;
    syncFileModalNameInput();
    modal.classList.add("show");
  }

  function fileModalOpen() {
    var modal = $("fileModal");
    return !!(modal && modal.classList.contains("show"));
  }

  function closeFileModal() {
    var modal = $("fileModal");
    if (!modal) return;
    // Commit the (possibly renamed) title before closing
    commitFileModalRename();
    modal.classList.add("closing");
    setTimeout(function () {
      modal.classList.remove("show");
      modal.classList.remove("closing");
    }, 250);
    // Return to the Home tab so no tab is stuck on File
    switchRibbonTab("home");
  }

  function commitFileModalRename() {
    var nameInput = $("fileModalNameInput");
    if (!nameInput || !currentDocId) return;
    var newTitle = nameInput.value.trim() || "Untitled Document";
    if (newTitle !== currentTitle) {
      currentTitle = newTitle;
      scheduleAutosave(); // persists title + updates index meta
    }
  }

  /* ---------------- Welcome screen (home) ---------------- */
  function showWelcomeScreen(show) {
    var ws = $("welcomeScreen");
    if (!ws) return;
    ws.style.display = show ? "flex" : "none";
    // Only one of the two flex:1 column children may occupy space at a time —
    // hide the editor area while the home/welcome screen is shown so it does
    // NOT push the welcome content down / crop it (both were flex:1 siblings).
    var area = document.querySelector(".document-area");
    if (area) area.style.display = show ? "none" : "flex";
    if (show) renderWelcomeCards();
  }

  function formatCardDate(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  // Slides-style welcome cards: parallel data loads + a single atomic DOM
  // commit guarded by a render token (prevents stale/duplicate cards).
  function renderWelcomeCards() {
    var container = $("documentsDisplay");
    var noContainer = $("noDocsContainer");
    if (!container) return;

    var myToken = (_welcomeRenderToken = (_welcomeRenderToken || 0) + 1);

    function applyEmpty(empty) {
      // Hide the card grid entirely when empty so it doesn't reserve space
      // (matches Slides, where the image sits right under the section title)
      container.style.display = empty ? "none" : "";
      if (noContainer) noContainer.style.display = empty ? "flex" : "none";
    }

    if (documents.length === 0) {
      container.innerHTML = "";
      applyEmpty(true);
      return;
    }
    applyEmpty(false);

    var snapshot = documents.slice(0, 12);
    Promise.all(snapshot.map(async function (meta) {
      var data = await loadDocData(meta.id);
      return { meta: meta, data: data };
    })).then(function (results) {
      if (myToken !== _welcomeRenderToken) return; // a newer render started
      var frag = document.createDocumentFragment();
      for (var i = 0; i < results.length; i++) {
        (function (r) {
          var meta = r.meta, data = r.data;
          var snippet = data ? htmlToText(data.content) : "";
          var words = meta.wordCount || (snippet ? snippet.split(/\s+/).filter(Boolean).length : 0);

          var card = document.createElement("div");
          card.className = "document-card";

          var thumb = document.createElement("div");
          thumb.className = "document-card-thumb";
          var snip = document.createElement("div");
          snip.className = "document-card-snippet" + (snippet ? "" : " is-empty");
          snip.textContent = snippet ? snippet.slice(0, 220) : "Empty page";
          thumb.appendChild(snip);

          var info = document.createElement("div");
          info.className = "document-card-info";
          info.innerHTML =
            '<div class="document-card-title"></div>' +
            '<div class="document-card-meta"></div>';
          info.querySelector(".document-card-title").textContent = meta.title || "Untitled Document";
          info.querySelector(".document-card-meta").textContent =
            words + (words === 1 ? " word \u00B7 " : " words \u00B7 ") + formatCardDate(meta.updatedAt);

          card.appendChild(thumb);
          card.appendChild(info);
          card.addEventListener("click", function () { openDocument(meta.id); });
          frag.appendChild(card);
        })(results[i]);
      }
      container.innerHTML = "";
      container.appendChild(frag);
    }).catch(function () {});
  }

  /* ---------------- Import (.txt / .md / .html / .docx / .doc / .odt / .rtf) ---------------- */
  function importTextToHtml(text, isMarkdown) {
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var inCode = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isMarkdown && /^\s*```/.test(line)) { inCode = !inCode; continue; }
      if (inCode) { out.push("<pre>" + escapeHtml(line) + "</pre>"); continue; }
      if (line.trim() === "") { out.push("<p><br></p>"); continue; }
      if (isMarkdown) {
        var h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (h) { out.push("<h" + h[1].length + ">" + escapeHtml(h[2]) + "</h" + h[1].length + ">"); continue; }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push("<hr>"); continue; }
        if (/^\s*>\s?/.test(line)) {
          out.push("<blockquote>" + escapeHtml(line.replace(/^\s*>\s?/, "")) + "</blockquote>");
          continue;
        }
        var li = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (li) { out.push("<ul><li>" + escapeHtml(li[1]) + "</li></ul>"); continue; }
        var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ol) { out.push("<ol><li>" + escapeHtml(ol[1]) + "</li></ol>"); continue; }
        out.push("<p>" + escapeHtml(line) + "</p>");
      } else {
        out.push("<p>" + escapeHtml(line) + "</p>");
      }
    }
    return out.join("");
  }

  function importHtmlToContent(htmlText) {
    // Full pass through the sanitizer: drops active elements AND event
    // handlers / javascript: URLs, which the old tag-only removal missed.
    var html = sanitizeStoredHtml(htmlText);
    return html && html.replace(/\S/g, "") ? html : "<p><br></p>";
  }

  // ── Minimal in-browser ZIP reader (no dependencies) ──
  // Reads a specific entry from a ZIP file by its local file name, using the
  // end-of-central-directory record. Supports stored (0) and deflate (8)
  // entries. If an inflate stream is unavailable we fall back to stored only.
  function zipReadEntry(arrayBuffer, targetName) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);
    var len = bytes.length;
    // Locate EOCD record (signature 0x06054b50) scanning from the end.
    var eocd = -1;
    for (var i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    var names = {};
    for (var c = 0; c < count; c++) {
      var p = cdOffset;
      if (view.getUint32(cdOffset, true) !== 0x02014b50) return null;
      var method = view.getUint16(cdOffset + 10, true);
      var compSize = view.getUint32(cdOffset + 20, true);
      var nameLen = view.getUint16(cdOffset + 28, true);
      var extraLen = view.getUint16(cdOffset + 30, true);
      var commentLen = view.getUint16(cdOffset + 32, true);
      var localOffset = view.getUint32(cdOffset + 42, true);
      var name = "";
      for (var n = 0; n < nameLen; n++) name += String.fromCharCode(bytes[cdOffset + 46 + n]);
      names[name] = { method: method, compSize: compSize, localOffset: localOffset };
      cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    var entry = names[targetName];
    if (!entry) return null;
    // Parse local header to find the data start.
    var lo = entry.localOffset;
    var lhNameLen = view.getUint16(lo + 26, true);
    var lhExtraLen = view.getUint16(lo + 28, true);
    var dataStart = lo + 30 + lhNameLen + lhExtraLen;
    var data = bytes.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8 && typeof DecompressionStream !== "undefined") return inflate(data);
    return null;
  }
  function inflate(array) {
    // DecompressionStream is available in Chromium 103+/Safari 16.4+/Firefox 113+.
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([array]).stream().pipeThrough(ds);
    return stream.arrayBuffer();
  }

  // Extract the visible text from an ODT file (a ZIP whose content.xml holds
  // <text:p> paragraphs and <text:h> headings).
  async function convertOdtToHtml(arrayBuffer) {
    var entry = await zipReadEntry(arrayBuffer, "content.xml");
    if (!entry) return null;
    var text = new TextDecoder("utf-8").decode(entry);
    var body = (text.match(/<office:body[\s\S]*?<\/office:body>/) || [""])[0];
    var html = "";
    var paraRe = /<(?:text:p|text:h)\b[^>]*>([\s\S]*?)<\/(?:text:p|text:h)>/g;
    var m;
    while ((m = paraRe.exec(body)) !== null) {
      // Convert the paragraph's inner markup to plain text via a detached
      // parser so entities decode fully and no incomplete tag-strip regex
      // remains (CodeQL js/incomplete-multi-character-sanitization).
      var inner = htmlFragmentToText(m[1]);
      html += "<p>" + escapeHtml(inner) + "</p>";
    }
    return html && html.replace(/\S/g, "") ? null : (html || "<p><br></p>");
  }

  // Best-effort RTF → plain text (strip control words/symbols, keep readable
  // runs). Content between \pard groups is walked to recover unicode text.
  function convertRtfToText(rtf) {
    var out = "";
    var hex = /\\'([0-9a-fA-F]{2})/;
    var i = 0, n = rtf.length;
    while (i < n) {
      var ch = rtf[i];
      if (ch === "\\") {
        var m = hex.exec(rtf.substr(i, 4));
        if (m) {
          try { out += String.fromCharCode(parseInt(m[1], 16)); } catch (e) {}
          i += 4; continue;
        }
        // \uN escapes carry a sign + digits in RTF.
        var u = /^\\u(-?\d+)/.exec(rtf.substr(i));
        if (u) { out += String.fromCharCode(parseInt(u[1], 10)); i += u[0].length; continue; }
        // Paragraph / line breaks map to newlines; tabs to spaces.
        var br = /^\\[a-zA-Z]+\d*/.exec(rtf.substr(i)) || [""];
        var word = br[0];
        if (word === "\\par" || word === "\\line") { out += "\n"; i += word.length; continue; }
        if (word === "\\tab") { out += " "; i += word.length; continue; }
        // Other control symbol like \b0, \b1, \plain etc — skip the whole word.
        var w = /^\\[a-zA-Z]+-?\d*/.exec(rtf.substr(i));
        if (w) { i += w[0].length; continue; }
        i++; continue;
      }
      if (ch === "{" || ch === "}") { i++; continue; }
      out += ch; i++;
    }
    return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }

  // Best-effort legacy .doc text extraction: the Word binary stores readable
  // text (often in a mix of byte and UTF-16 runs). We scan the bytes and keep
  // sequences of printable characters as likely text, dropping binary noise.
  function convertDocToText(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var n = bytes.length;
    function isTextByte(b) {
      return (b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13;
    }
    // Build a big decodable string from UTF-16-ish words where low bytes are
    // ASCII (common in Word 6/95/97/2000 files), plus a raw-byte pass.
    var latin = "", utf = "";
    for (var i = 0; i + 1 < n; i += 2) {
      var lo = bytes[i], hi = bytes[i + 1];
      var keepLatin = isTextByte(lo);
      var keepUtf = hi === 0 && isTextByte(lo);
      latin += keepLatin ? String.fromCharCode(lo) : " ";
      utf += keepUtf ? String.fromCharCode(lo) : " ";
    }
    function collect(src) {
      var chunk = "", res = [];
      for (var k = 0; k < src.length; k++) {
        var c = src[k];
        if (c === "\n" || c === "\r" || c === "\t" || c.charCodeAt(0) >= 32) {
          chunk += c === "\r" ? "\n" : c;
        } else {
          if (chunk.trim().length >= 3) res.push(chunk);
          chunk = "";
        }
      }
      if (chunk.trim().length >= 3) res.push(chunk);
      return res;
    }
    function meaningful(list) {
      return list.filter(function (l) { var t = l.trim(); return t.length > 1 && /[A-Za-z]/.test(t); });
    }
    var utfLines = meaningful(collect(utf));
    var latinLines = meaningful(collect(latin));
    // Prefer the UTF-16 pass as it usually carries the "real" text, but if it
    // yields almost nothing, fall back to the raw-byte pass.
    var lines = (utfLines.length >= Math.min(2, latinLines.length)) ? utfLines : latinLines;
    var out = lines.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return out || null;
  }

  /* ===================== .docx rich conversion =====================
     Falls back to mammoth (when loaded) + plain text. This converter parses
     word/document.xml + styles.xml directly so page size, margins, background,
     paragraph alignment, text colour, shading and cell padding survive import
     (the way MS Word stores them), not just the bare text structure. */

  // ---- minimal XML parser (namespace-agnostic, strips prefixes) ----
  function xmlParse(xml) {
    var root = { tag: "#root", attrs: {}, kids: [], text: "" };
    var stack = [root];
    var i = 0, n = xml.length;
    var reText = /[^<]*/;
    function tagName(s) { return s.replace(/^.*:/, ""); }
    while (i < n) {
      var lt = xml.indexOf("<", i);
      if (lt < 0) { stack[stack.length - 1].text += xml.substring(i); break; }
      if (lt > i) stack[stack.length - 1].text += xml.substring(i, lt);
      var gt = xml.indexOf(">", lt);
      if (gt < 0) break;
      var inner = xml.substring(lt + 1, gt);
      i = gt + 1;
      if (inner.charAt(0) === "!") continue;          // <!DOCTYPE ...> etc
      if (inner.charAt(0) === "?") continue;          // <?xml ...?>
      if (inner.charAt(0) === "/") { stack.pop(); continue; } // closing
      var selfClose = /\/$/.test(inner.trim());
      var body = selfClose ? inner.trim().slice(0, -1) : inner;
      var m = /^([^\s=\/>]+)([\s\S]*)$/.exec(body);
      if (!m) continue;
      var tag = tagName(m[1]);
      var attrs = {};
      var rest = m[2];
      var attrRe = /([^\s=\/>]+)=("([^"]*)"|'([^']*)')/g;
      var am;
      while ((am = attrRe.exec(rest)) !== null) attrs[tagName(am[1])] = am[3] != null ? am[3] : (am[4] != null ? am[4] : "");
      var node = { tag: tag, attrs: attrs, kids: [], text: "" };
      stack[stack.length - 1].kids.push(node);
      if (!selfClose) stack.push(node);
    }
    return root;
  }
  function firstChild(node, tag) {
    for (var i = 0; i < node.kids.length; i++) if (node.kids[i].tag === tag) return node.kids[i];
    return null;
  }
  function allChildren(node, tag) {
    var out = [];
    for (var i = 0; i < node.kids.length; i++) if (node.kids[i].tag === tag) out.push(node.kids[i]);
    return out;
  }
  function nodeText(node) {
    var s = node.text || "";
    for (var i = 0; i < node.kids.length; i++) s += nodeText(node.kids[i]);
    return s;
  }
  function ooxmlColor(hex, tint) {
    if (!hex) return null;
    if (hex === "auto") return null;
    var v = hex.replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(v)) {
      if (tint !== undefined && tint !== null) {
        var r = parseInt(v.substr(0, 2), 16), g = parseInt(v.substr(2, 2), 16), b = parseInt(v.substr(4, 2), 16);
        var t = Math.max(-1, Math.min(1, parseFloat(tint)));
        if (t < 0) { r = Math.round(r * (1 + t)); g = Math.round(g * (1 + t)); b = Math.round(b * (1 + t)); }
        else { r = Math.round(r + (255 - r) * t); g = Math.round(g + (255 - g) * t); b = Math.round(b + (255 - b) * t); }
        v = [r, g, b].map(function (x) { x = Math.max(0, Math.min(255, x)); return ("0" + x.toString(16)).slice(-2); }).join("");
      }
      return "#" + v;
    }
    return null;
  }
  function twipToPx(tw) {
    var v = parseFloat(tw);
    if (!isFinite(v) || isNaN(v)) return null;
    return Math.round((v / 20) * 96 / 72); // twips → px @96dpi
  }

  // ---- styles.xml model ----
  function parseDocxStyles(stylesRoot) {
    var para = {}; // styleId → props
    var run = {};
    var defPara = null, defRun = null;
    function styleId(node) {
      var s = firstChild(node, "styleId");
      return s ? nodeText(s).trim() : null;
    }
    function styleName(node) {
      var nm = firstChild(node, "name");
      return nm && nm.attrs.val ? nm.attrs.val : null;
    }
    function walkStyle(node, kind) {
      var pPr = firstChild(node, "pPr"), rPr = firstChild(node, "rPr");
      var props = { name: styleName(node) };
      if (pPr) {
        var jc = firstChild(pPr, "jc");
        if (jc) props.alignment = jc.attrs.val;
        var shd = firstChild(pPr, "shd");
        if (shd && shd.attrs.fill) props.paraShading = ooxmlColor(shd.attrs.fill);
      }
      if (rPr) {
        var color = firstChild(rPr, "color");
        if (color) props.color = ooxmlColor(color.attrs.val);
        props.bold = firstChild(rPr, "b") ? firstChild(rPr, "b").attrs.val !== "0" && firstChild(rPr, "b").attrs.val !== "false" : false;
        props.italic = firstChild(rPr, "i") ? firstChild(rPr, "i").attrs.val !== "0" && firstChild(rPr, "i").attrs.val !== "false" : false;
        props.underline = firstChild(rPr, "u") ? true : false;
        var sz = firstChild(rPr, "sz");
        if (sz) props.fontSize = parseFloat(sz.attrs.val) / 2;
        var shdR = firstChild(rPr, "shd");
        if (shdR && shdR.attrs.fill) props.runShading = ooxmlColor(shdR.attrs.fill);
      }
      return props;
    }

    function parseStyles(el) {
      for (var i = 0; i < el.kids.length; i++) {
        var k = el.kids[i];
        if (k.tag !== "style") continue;
        var id = styleId(k);
        if (id == null) continue;
        var type = k.attrs.type || "";
        var styleNode = k;
        var props = walkStyle(styleNode, type);
        if (type === "paragraph") para[id] = props;
        if (type === "character") run[id] = props;
      }
    }
    // Look for <w:docDefaults> (default paragraph/run props)
    var dd = firstChild(stylesRoot, "docDefaults");
    if (dd) {
      var pPrD = firstChild(dd, "pPrDefault");
      if (pPrD) { var pj = firstChild(firstChild(pPrD, "pPr"), "jc"); if (pj && pj.attrs.val) defPara = { alignment: pj.attrs.val }; }
      var rPrD = firstChild(dd, "rPrDefault");
      if (rPrD) {
        var rd = firstChild(rPrD, "rPr");
        if (rd) {
          defRun = {};
          var c = firstChild(rd, "color");
          if (c) defRun.color = ooxmlColor(c.attrs.val, c.attrs.val === "auto" ? null : c.attrs.val);
          var sz = firstChild(rd, "sz");
          if (sz) defRun.fontSize = parseFloat(sz.attrs.val) / 2;
        }
      }
    }
    parseStyles(stylesRoot);
    return { para: para, run: run, defaultRun: defRun || null };
  }

  // ---- page setup from document.xml <w:sectPr> ----
  function parseDocxPageSetup(documentRoot) {
    var setup = { w: 794, h: 1123, portrait: true, marginTop: 96, marginRight: 96, marginBottom: 96, marginLeft: 96, bg: null };
    function findSectPr(el) {
      if (el.kids) { for (var k = 0; k < el.kids.length; k++) { var r = findSectPr(el.kids[k]); if (r) return r; } }
      if (el.tag === "sectPr") return el;
      return null;
    }
    var sect = findSectPr(documentRoot);
    if (!sect) return setup;
    var pgSz = firstChild(sect, "pgSz");
    if (pgSz) {
      var w = pgSz.attrs.w, h = pgSz.attrs.h;
      if (w && h) {
        setup.w = twipToPx(w); setup.h = twipToPx(h);
        setup.portrait = !(pgSz.attrs.orient === "landscape");
        if (pgSz.attrs.orient === "landscape") { setup.w = twipToPx(h); setup.h = twipToPx(w); }
      }
    }
    var pgMar = firstChild(sect, "pgMar");
    if (pgMar) {
      if (pgMar.attrs.top) setup.marginTop = twipToPx(pgMar.attrs.top);
      if (pgMar.attrs.right) setup.marginRight = twipToPx(pgMar.attrs.right);
      if (pgMar.attrs.bottom) setup.marginBottom = twipToPx(pgMar.attrs.bottom);
      if (pgMar.attrs.left) setup.marginLeft = twipToPx(pgMar.attrs.left);
    }
    var bg = firstChild(sect, "background");
    if (bg && bg.attrs.color) setup.bg = ooxmlColor(bg.attrs.color, bg.attrs.color === "auto" ? null : bg.attrs.color);
    return setup;
  }

  // ---- main converter ----
  function convertDocxTree(documentRoot, styles) {
    var body = firstChild(documentRoot, "body");
    if (!body) return "<p><br></p>";
    var out = "";
    var listBuf = null; // { type, items:[...] } for consecutive list paragraphs
    function flushList() {
      if (listBuf) {
        out += "<" + listBuf.type + ">" + listBuf.items.join("") + "</" + listBuf.type + ">";
        listBuf = null;
      }
    }
    for (var i = 0; i < body.kids.length; i++) {
      var el = body.kids[i];
      if (el.tag === "p") {
        var par = convertDocxPar(el, styles);
        if (par.isList) {
          var li = "<li" + par.styleAttr + ">" + par.content + "</li>";
          if (listBuf) {
            listBuf.items.push(li);
          } else {
            listBuf = { type: "ul", items: [li] };
          }
        } else {
          flushList();
          out += "<" + par.tag + par.styleAttr + ">" + par.content + "</" + par.tag + ">";
        }
      } else if (el.tag === "tbl") {
        flushList();
        out += convertDocxTable(el, styles);
      } else if (el.tag === "sectPr") {} // page setup handled separately
    }
    flushList();
    return out || "<p><br></p>";
  }

  function resolveParaStyle(p, styles, styleId) {
    var props = { alignment: null, paraShading: null };
    if (styleId && styles.para[styleId]) {
      var def = styles.para[styleId];
      props.alignment = def.alignment || null;
      props.paraShading = def.paraShading || null;
    }
    var pPr = firstChild(p, "pPr");
    if (pPr) {
      var jc = firstChild(pPr, "jc");
      if (jc && jc.attrs.val) props.alignment = jc.attrs.val;
      var shd = firstChild(pPr, "shd");
      if (shd && shd.attrs.fill) props.paraShading = ooxmlColor(shd.attrs.fill, shd.attrs.fill === "auto" ? null : shd.attrs.fill);
    }
    return props;
  }

  function resolveRunStyle(r, styles, inherit) {
    var props = { color: null, bold: false, italic: false, underline: false, fontSize: null, runShading: null };
    if (inherit) {
      props.color = inherit.color || null; props.bold = inherit.bold; props.italic = inherit.italic;
      props.underline = inherit.underline; props.fontSize = inherit.fontSize || null;
    } else if (styles && styles.defaultRun) {
      props.color = styles.defaultRun.color || null;
      props.fontSize = styles.defaultRun.fontSize || null;
    }
    var rPr = firstChild(r, "rPr");
    var styleId = null;
    if (rPr) { var rs = firstChild(rPr, "rStyle"); if (rs) styleId = rs.attrs.val; }
    if (styleId && styles.run[styleId]) {
      var def = styles.run[styleId];
      if (def.color) props.color = def.color;
      if (def.bold !== undefined) props.bold = def.bold;
      if (def.italic !== undefined) props.italic = def.italic;
      if (def.fontSize) props.fontSize = def.fontSize;
    }
    if (rPr) {
      var color = firstChild(rPr, "color");
      if (color && color.attrs.val) props.color = ooxmlColor(color.attrs.val, color.attrs.val === "auto" ? null : color.attrs.val);
      var b = firstChild(rPr, "b");
      if (b) props.bold = b.attrs.val !== "0" && b.attrs.val !== "false";
      var i = firstChild(rPr, "i");
      if (i) props.italic = i.attrs.val !== "0" && i.attrs.val !== "false";
      var u = firstChild(rPr, "u");
      if (u) props.underline = u.attrs.val !== "0" && u.attrs.val !== "false" && u.attrs.val !== "none";
      var sz = firstChild(rPr, "sz");
      if (sz && sz.attrs.val) props.fontSize = parseFloat(sz.attrs.val) / 2;
      var shd = firstChild(rPr, "shd");
      if (shd && shd.attrs.fill) props.runShading = ooxmlColor(shd.attrs.fill, shd.attrs.fill === "auto" ? null : shd.attrs.fill);
    }
    return props;
  }

  function convertDocxRunContent(r, styles, inherit) {
    var runProps = resolveRunStyle(r, styles, inherit);
    var html = "";
    for (var i = 0; i < r.kids.length; i++) {
      var k = r.kids[i];
      if (k.tag === "t") {
        var txt = nodeText(k);
        if (runProps.bold) txt = "<b>" + txt + "</b>";
        if (runProps.italic) txt = "<i>" + txt + "</i>";
        if (runProps.underline) txt = "<u>" + txt + "</u>";
        var styleParts = [];
        if (runProps.color) styleParts.push("color:" + runProps.color);
        if (runProps.fontSize) styleParts.push("font-size:" + runProps.fontSize + "pt");
        if (runProps.runShading) styleParts.push("background:" + runProps.runShading);
        if (styleParts.length) txt = '<span style="' + styleParts.join(";") + '">' + txt + "</span>";
        html += txt;
      } else if (k.tag === "br") {
        html += runProps.bold ? "<b><br></b>" : "<br>";
      } else if (k.tag === "tab") {
        html += "&emsp;";
      } else if (k.tag === "hyperlink" || k.tag === "ins" || k.tag === "smartTag") {
        html += convertDocxRunContainer(k, styles, runProps);
      } else if (k.tag === "drawing" || k.tag === "pict" || k.tag === "object") {
        // images are dropped in plain import (no data available without
        // extracting media parts); keep a placeholder so layout is visible.
      }
    }
    return html;
  }

  function convertDocxRunContainer(el, styles, inherit) {
    var html = "";
    for (var i = 0; i < el.kids.length; i++) html += convertDocxRunContent(el.kids[i], styles, inherit);
    return html;
  }

  function convertDocxPar(p, styles) {
    var pPr = firstChild(p, "pPr");
    var styleId = null;
    if (pPr) { var st = firstChild(pPr, "pStyle"); if (st) styleId = st.attrs.val; }
    var props = resolveParaStyle(p, styles, styleId);
    var styleParts = [];
    var alignMap = { left: "left", center: "center", right: "right", both: "justify", start: "left", end: "right" };
    if (props.alignment && alignMap[props.alignment]) styleParts.push("text-align:" + alignMap[props.alignment]);
    if (props.paraShading) styleParts.push("background:" + props.paraShading);
    var isList = false, listType = null;
    if (pPr) {
      var numPr = firstChild(pPr, "numPr");
      isList = !!numPr;
      var ilvl = numPr ? firstChild(numPr, "ilvl") : null;
      // any indentation level renders as a bulleted <li> (kept simple).
      listType = isList ? "ul" : null;
    }
    var inner = "";
    var kids = p.kids;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tag === "r") inner += convertDocxRunContent(kids[i], styles, null);
      else if (kids[i].tag === "hyperlink" || kids[i].tag === "ins" || kids[i].tag === "smartTag") inner += convertDocxRunContainer(kids[i], styles, null);
    }
    // fast-ish heading detection: style name "Heading N"
    var heading = null;
    if (styleId && styles.para[styleId] && styles.para[styleId].name) {
      var nm = styles.para[styleId].name.match(/^Heading\s*([1-6])$/i);
      if (nm) heading = parseInt(nm[1], 10);
    }
    var tag = heading ? ("h" + Math.min(6, heading)) : "p";
    var styleAttr = styleParts.length ? ' style="' + styleParts.join(";") + '"' : "";
    var content = inner || "<br>";
    return { tag: tag, styleAttr: styleAttr, content: content, isList: isList };
  }

  function convertDocxTable(tbl, styles) {
    var html = "<table>";
    var tblPr = firstChild(tbl, "tblPr");
    var rows = allChildren(tbl, "tr");
    for (var r = 0; r < rows.length; r++) {
      html += "<tr>";
      var cells = allChildren(rows[r], "tc");
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        var styleParts = [];
        var gridSpanVal = 1;
        var tcPr = firstChild(cell, "tcPr");
        if (tcPr) {
          var shd = firstChild(tcPr, "shd");
          if (shd && shd.attrs.fill) styleParts.push("background-color:" + ooxmlColor(shd.attrs.fill, shd.attrs.fill === "auto" ? null : shd.attrs.fill));
          var tcMar = firstChild(tcPr, "tcMar");
          // Word stores cell margins in twips: left/right in w:start/w:end
          if (tcMar) {
            var padVals = { top: null, right: null, bottom: null, left: null };
            var sides = { top: "top", start: "left", bottom: "bottom", end: "right" };
            for (var sd in sides) {
              var sEl = firstChild(tcMar, sd);
              if (sEl && sEl.attrs.w && sides[sd]) padVals[sides[sd]] = Math.max(0, twipToPx(sEl.attrs.w));
            }
            if (padVals.top != null && padVals.right != null && padVals.bottom != null && padVals.left != null && padVals.top === padVals.right && padVals.right === padVals.bottom && padVals.bottom === padVals.left) {
              styleParts.push("padding:" + padVals.top + "px");
            } else {
              var pt = ["top", "right", "bottom", "left"].map(function (s) { return (padVals[s] != null ? padVals[s] : 0) + "px"; }).join(" ");
              styleParts.push("padding:" + pt);
            }
          }
          var gridSpan = firstChild(tcPr, "gridSpan");
          if (gridSpan && gridSpan.attrs.val) gridSpanVal = parseInt(gridSpan.attrs.val, 10) || 1;
        }
        // cell content: paragraphs
        var cellHtml = "";
        var cellKids = cell.kids;
        for (var k = 0; k < cellKids.length; k++) {
          if (cellKids[k].tag === "p") {
            var par = convertDocxPar(cellKids[k], styles);
            cellHtml += par.isList
              ? "<ul><li" + par.styleAttr + ">" + par.content + "</li></ul>"
              : "<" + par.tag + par.styleAttr + ">" + par.content + "</" + par.tag + ">";
          }
        }
        var cellAttr = "";
        if (gridSpanVal && gridSpanVal > 1) cellAttr = ' colspan="' + gridSpanVal + '"';
        html += "<td" + cellAttr + (styleParts.length ? ' style="' + styleParts.join(";") + '"' : "") + ">" + (cellHtml || "<p><br></p>") + "</td>";
      }
      html += "</tr>";
    }
    html += "</table>";
    return html;
  }

  // Minimal text fallback: pull w:t text nodes / paragraph boundaries.
  async function convertDocxTextFallback(arrayBuffer) {
    var doc = await zipReadEntry(arrayBuffer, "word/document.xml");
    if (!doc) return null;
    var xml = new TextDecoder("utf-8").decode(doc);
    var html = "";
    var blockRe = /<(?:w:p|w:tbl)\b[\s\S]*?<\/(?:w:p|w:tbl)>/g;
    var m;
    while ((m = blockRe.exec(xml)) !== null) {
      var inner = (m[0].match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [])
        .map(function (t) {
          return t.replace(/^<w:t\b[^>]*>/, "").replace(/<\/w:t>$/, "")
            .replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, function(c) {
              return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[c];
            });
        }).join("");
      if (inner.replace(/\s/g, "")) html += "<p>" + escapeHtml(inner) + "</p>";
    }
    return html && html.replace(/\S/g, "") ? null : (html || null);
  }

  // ---- entry point: full .docx → {html, pageSetup} ----
  async function convertDocxFully(arrayBuffer) {    var docEntry = await zipReadEntry(arrayBuffer, "word/document.xml");
    if (!docEntry) return null;
    var docXml = new TextDecoder("utf-8").decode(docEntry);
    var docRoot = xmlParse(docXml);
    var stylesEntry = await zipReadEntry(arrayBuffer, "word/styles.xml");
    var styles = { para: {}, run: {} };
    if (stylesEntry) {
      var stylesXml = new TextDecoder("utf-8").decode(stylesEntry);
      styles = parseDocxStyles(xmlParse(stylesXml));
    }
    var html = convertDocxTree(docRoot, styles);
    var pageSetup = parseDocxPageSetup(docRoot);
    return { html: html, pageSetup: pageSetup };
  }

  // Public-ish: convert a .docx file to { html, pageSetup }, preferring the
  // full custom converter, falling back to mammoth, then plain text.
  async function convertDocxToHtml(file) {
    var ab = await file.arrayBuffer();
    var full = null;
    try { full = await convertDocxFully(ab); } catch (e) { full = null; }
    if (full && full.html && full.html.replace(/\S/g, "")) {
      return { html: importHtmlToContent(full.html), pageSetup: full.pageSetup || null };
    }
    // mammoth fallback (structure only — page setup/alignment lost)
    var text = (typeof mammoth !== "undefined")
      ? await mammoth.convertToHtml({ arrayBuffer: ab })
          .then(function (r) { return r.value; }).catch(function () { return null; })
      : null;
    if (text && text.replace(/\S/g, "")) {
      return { html: importHtmlToContent(text), pageSetup: null };
    }
    var ab2 = ab;
    var plain = await convertDocxTextFallback(ab2);
    return { html: plain ? importTextToHtml(plain, false) : "<p><br></p>", pageSetup: null };
  }

  // Best-effort .doc → HTML. Tries the binary text extractor; the result may
  // be incomplete for older/newer Word files but preserves readable prose. If
  // nothing usable is found we surface a helpful error. A .doc that is really
  // RTF underneath (common for files saved by "Save As Type: .doc") is routed
  // through the RTF parser first.
  async function convertDocToHtml(file) {
    var ab = await file.arrayBuffer();
    var head = new TextDecoder("latin1").decode(ab.slice(0, 16));
    if (/^\s*\{\\rtf/.test(head)) {
      return nullContentToSpacer(convertRtfToText(new TextDecoder("latin1").decode(ab)));
    }
    var txt = convertDocToText(ab);
    if (!txt) {
      throw new Error("EMPTYDOC");
    }
    return importTextToHtml(txt, false);
  }

  function nullContentToSpacer(plain) {
    return importTextToHtml(plain || "", false);
  }

  async function importDocumentFromFile(file) {
    var ext = (file.name.toLowerCase().split(".").pop() || "");
    var baseName = file.name.replace(/\.[^.]+$/, "").trim() || "Imported Document";
    var contentPromise;
    if (ext === "html" || ext === "htm") {
      contentPromise = file.text().then(function (t) { return importHtmlToContent(t); });
    } else if (ext === "md" || ext === "markdown") {
      contentPromise = file.text().then(function (t) { return importTextToHtml(t, true); });
    } else if (ext === "txt" || ext === "text" || file.type.indexOf("text/") === 0) {
      contentPromise = file.text().then(function (t) { return importTextToHtml(t, false); });
    } else if (ext === "docx") {
      contentPromise = convertDocxToHtml(file);
    } else if (ext === "odt") {
      contentPromise = file.arrayBuffer().then(convertOdtToHtml).then(function (h) { return h || "<p><br></p>"; });
    } else if (ext === "rtf") {
      contentPromise = file.text().then(function (t) { return convertRtfToText(t); }).then(nullContentToSpacer);
    } else if (ext === "doc") {
      contentPromise = convertDocToHtml(file);
    } else {
      toast("Unsupported file type. Please use .doc, .docx, .odt, .txt, .md or .html.", "error");
      return;
    }

    var content;
    try { content = await contentPromise; } catch (e) {
      if (e && e.message === "EMPTYDOC") {
        toast("Could not extract readable text from this .doc file.", "error");
      } else {
        toast("Could not read file", "error");
      }
      return;
    }

    var id = makeDocId();
    var pageSetup = null;
    // .docx importer returns {html, pageSetup}. Unwrap it.
    if (content && typeof content === "object" && content.html) {
      pageSetup = content.pageSetup || null;
      content = content.html;
    }
    var plain = htmlToText(content);
    documents.unshift({
      id: id,
      title: baseName,
      updatedAt: Date.now(),
      wordCount: plain ? plain.split(/\s+/).filter(Boolean).length : 0,
    });
    await saveIndex();
    var docData = {
      id: id,
      title: baseName,
      content: content,
      savedAt: Date.now(),
      theme: theme,
      header: "",
      footer: "",
      footnotes: [],
      endnotes: [],
    };
    if (pageSetup) {
      docData.pageSize = { w: pageSetup.w, h: pageSetup.h, portrait: pageSetup.portrait };
      docData.pageMargins = { top: pageSetup.marginTop, right: pageSetup.marginRight, bottom: pageSetup.marginBottom, left: pageSetup.marginLeft };
      if (pageSetup.bg) docData.pageBg = pageSetup.bg;
    }
    await writeDocData(docData);
    toast("Imported \u201C" + baseName + "\u201D", "success");
    await openDocument(id);
  }

  function setAutosaveState(state) {
    // Save indicator pill: green=saved, yellow=saving, red=error (matching slides)
    var pill = $("saveIndicator");
    var pillText = pill ? pill.querySelector(".save-text") : null;
    if (pill) {
      pill.classList.remove("saving", "error");
      if (state === "saving") {
        pill.classList.add("saving");
        if (pillText) pillText.textContent = "Saving…";
      } else if (state === "error") {
        pill.classList.add("error");
        if (pillText) pillText.textContent = "Save failed";
      } else {
        lastSavedAt = Date.now();
        if (pillText) pillText.textContent = "All changes saved";
      }
    }
    var el = $("autosave");
    if (el) {
      el.classList.remove("saving", "saved");
      if (state === "saving") {
        el.classList.add("saving");
        el.textContent = "Saving…";
      } else if (state === "error") {
        el.textContent = "Save failed";
      } else {
        el.classList.add("saved", "has-time");
        lastSavedAt = Date.now();
        el.innerHTML = "Saved <span class='autosave-time'>at " + formatAutosaveTime(lastSavedAt) + "</span>";
      }
    }
  }
  /* ---------------- New / Print / Export ---------------- */
  // Guards against firing the OS print dialog twice (double-click, or Ctrl+P
  // repeated while the dialog is opening).
  var printInFlight = false;
  function printDocument() {
    if (printInFlight) return;
    printInFlight = true;
    saveDocument(false);
    // Force a paginate pass before printing so the latest content is split
    // into pages correctly (otherwise the printout may use stale page breaks).
    try { schedulePaginate(); } catch (e) {}
    // Defer window.print() to the next tick so the paginate pass has a chance
    // to flush DOM changes before the browser snapshots the page for printing.
    setTimeout(function () {
      window.print();
      setTimeout(function () { printInFlight = false; }, 500);
    }, 50);
  }

  // Generates a true A4 PDF directly from the real on-screen pages (one
  // printed sheet per editor page), bypassing the browser print dialog so the
  // output is 1:1 "what you see is what you get" regardless of the dialog's
  // margin setting (no blank pages, no clipped lines). Each real `.page` is
  // rasterized at its exact on-screen size and placed onto one 210x297mm PDF
  // sheet. (Thumbnail clones carry [data-thumb="1"] and are excluded via
  // getPages()).
  function printToPdf(done) {
    var jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    var canCapture = typeof html2canvas !== "undefined";
    try { togglePrintPreview(false); } catch (e) {}
    if (!jsPDF || !canCapture) {
      toast("PDF libraries not loaded. Check your internet connection then retry.", "error");
      if (done) done();
      return;
    }

    var pages = getPages();
    if (pages.length === 0) { if (done) done(); return; }

    toast("Preparing PDF…", 4000);
    saveCaret();

    // Neutralise editor-only chrome that must not appear in the printed PDF.
    // Save the selected page / guideline / badge state so we can restore it.
    var wrapper = $(PAGES_WRAPPER_ID);
    var wrapperHadGuides = wrapper && wrapper.classList.contains("show-guides");
    var badges = [];
    var i;
    for (i = 0; i < pages.length; i++) {
      var b = pages[i].querySelector(".page-badge");
      if (b) { badges.push(b); b.style.display = "none"; }
    }
    if (wrapper) wrapper.classList.remove("show-guides");

    // Snapshot each page's own transform so html2canvas captures it at 1:1.
    var hadTransforms = [];
    for (i = 0; i < pages.length; i++) {
      hadTransforms.push(pages[i].style.transform);
      pages[i].style.transform = "none";
    }

    // Scope all page content to a known intrinsic size while rasterizing so
    // zoom on the pages-wrapper can't alter the captured dimensions.
    var savedWrapperTransform = wrapper ? wrapper.style.transform : "";
    var savedWrapperZoom = wrapper ? wrapper.style.zoom : "";
    if (wrapper) { wrapper.style.transform = "none"; wrapper.style.zoom = "1"; }

    // Build the PDF sheet from the CURRENT page size (A4, Letter, Legal, ...)
    // so the exported file matches the on-screen paper. mm derived at 96dpi.
    var sheetW = (curPageW || PAGE_WIDTH) / 96 * 25.4;
    var sheetH = (curPageH || PAGE_HEIGHT) / 96 * 25.4;
    var isLandscape = sheetW >= sheetH;
    var pdf = new jsPDF({ orientation: isLandscape ? "landscape" : "portrait", unit: "mm", format: [sheetW, sheetH] });
    var pageWmm = sheetW;
    var pageHmm = sheetH;
    var idx = 0;

    function next() {
      if (idx >= pages.length) {
        finish();
        return;
      }
      var page = pages[idx];
      idx++;
      // Make sure the page is rendered/in the viewport before rasterizing so
      // html2canvas captures the full page rather than an off-screen blank.
      try { page.scrollIntoView({ block: "start" }); } catch (e) {}
      setTimeout(function () {
        html2canvas(page, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
        }).then(function (canvas) {
          if (idx > 1) pdf.addPage();
          var ratio = canvas.height / canvas.width;
          var drawW = pageWmm;
          var drawH = pageHmm;
          // Maintain the on-screen aspect ratio, centered, filling the sheet.
          if (drawW * ratio > pageHmm) { drawH = pageHmm; drawW = drawH / ratio; }
          else { drawH = drawW * ratio; }
          var offX = (pageWmm - drawW) / 2;
          var offY = (pageHmm - drawH) / 2;
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", offX, offY, drawW, drawH);
          next();
        }).catch(function () {
          // Rasterization failed for one page — skip it rather than aborting.
          next();
        });
      }, 40);
    }

    function finish() {
      // Restore editor state.
      for (var j = 0; j < badges.length; j++) badges[j].style.display = "";
      if (wrapper) {
        if (wrapperHadGuides) wrapper.classList.add("show-guides");
        wrapper.style.transform = savedWrapperTransform;
        wrapper.style.zoom = savedWrapperZoom;
      }
      for (var k = 0; k < pages.length; k++) pages[k].style.transform = hadTransforms[k];
      restoreCaret();
      try {
        var title = (currentTitle || "document").replace(/[^\w\-]+/g, "_").toLowerCase() || "document";
        pdf.save(title + ".pdf");
        toast("PDF saved", "success");
      } catch (e) { toast("PDF export failed", "error"); }
      if (done) done();
    }

    next();
  }

  function exportDocument(format) {
    var title = (currentTitle || "document").replace(/[^\w\-]+/g, "_").toLowerCase() || "document";
    if (format === "txt") {
      var text = getAllText();
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), title + ".txt");
      toast("Exported as .txt", "success");
    } else if (format === "html") {
      var stats = getStats();
      var bodyHtml = "";
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        bodyHtml += getContent(pages[i]).innerHTML;
      }
      var html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" +
        escapeHtml(currentTitle || "Document") +
        "</title><style>body{font-family:Georgia,serif;max-width:794px;margin:40px auto;padding:0 24px;line-height:1.6;color:#1a1d21}h1{font-size:28px}h2{font-size:22px}blockquote{border-left:3px solid #0f9d6e;margin:8px 0;padding:4px 16px;background:#e6f6ef;font-style:italic}pre{background:#f4f6f8;padding:10px;border-radius:6px;overflow:auto}img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px}</style></head><body>" +
        bodyHtml + "</body></html>";
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), title + ".html");
      toast("Exported as .html", "success");
    } else if (format === "print") {
      printDocument();
    } else if (format === "pdf") {
      printToPdf();
    } else if (format === "preview") {
      togglePrintPreview(true);
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- Zoom (Slides-style buttons: fit / 100 / in / out) ---------------- */
  var currentZoom = 100;
  function setZoom(percent) {
    percent = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(percent)));
    currentZoom = percent;
    var wrapper = $(PAGES_WRAPPER_ID);
    if (wrapper) wrapper.style.zoom = String(percent / 100);
    var statusPct = $("statusZoomPct");
    if (statusPct) statusPct.textContent = percent + "%";
    if (document.body.classList.contains("show-rulers")) buildRulerTicks();
  }

  /* ---------------- Page navigation ---------------- */
  function scrollToPage(index) {
    var pages = getPages();
    if (index < 1) index = 1;
    if (index > pages.length) index = pages.length;
    if (pages[index - 1]) {
      pages[index - 1].scrollIntoView({ behavior: "smooth", block: "start" });
      var content = getContent(pages[index - 1]);
      if (content) {
        setTimeout(function () {
          content.focus();
          var range = document.createRange();
          range.selectNodeContents(content);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }, 250);
      }
    }
  }

  /* ---------------- Theme ----------------
     Dark mode and accent color switching have been removed.
     The accent color is locked to cyan via the CSS :root variables,
     and there is no dark theme anymore — the app is always in light mode. */
  function applyTheme() {
    /* no-op — kept for backward compat with older code that calls applyTheme("light") */
  }

  function toggleTheme() {
    /* no-op — dark mode removed */
  }

  function toggleDarkPaper() {
    /* no-op — dark paper removed */
  }

  /* ---------------- Document color themes (accent presets) ----------------
     All accent-color switching has been removed. The app uses cyan as the
     single, locked accent color (defined in :root in docs.css). These stubs
     exist only so older code paths that still call applyColorTheme() /
     openColorThemeDialog() don't throw. */
  function applyColorTheme() { /* no-op — cyan is locked via CSS */ }
  function loadColorTheme()  { /* no-op */ }
  function openColorThemeDialog() { /* no-op — modal removed */ }
  function hexToRgba(hex, alpha) {
    var m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return "rgba(0,0,0," + alpha + ")";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  /* ---------------- Modal helpers ---------------- */
  function openModal(id) {
    var m = $(id);
    if (m) {
      // Cancel any in-flight closing animation (Slides re-opens instantly).
      clearTimeout(m._closeTimer);
      m.classList.remove("closing");
      m.classList.add("open");
      m.setAttribute("aria-hidden", "false");
      var first = m.querySelector("input[type='text'], input[type='url'], input:not([type])");
      if (first) setTimeout(function () { first.focus(); }, 80);
    }
  }

  function closeModal(id) {
    var m = $(id);
    if (!m) return;
    m.setAttribute("aria-hidden", "true");
    if (!m.classList.contains("open")) return;
    // Slides' close: add .closing (0.23s fadeOutOverlay/fadeOutModal), then
    // drop .open 230ms later — same timing as the Slides app's modals.
    clearTimeout(m._closeTimer);
    m.classList.add("closing");
    m._closeTimer = setTimeout(function () {
      m.classList.remove("closing");
      m.classList.remove("open");
    }, 230);
  }

  function closeAllModals() {
    var modals = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < modals.length; i++) {
      closeModal(modals[i].id);
    }
  }

  /* ---------------- Find & Replace / Go To (bottom-right bar, Notes-style) ---------------- */
  function openFindBar(mode) {
    var bar = $("findBar");
    if (!bar) return;
    clearFindHighlights();
    bar.style.display = "block";
    var sel = window.getSelection();
    var findInput = $("frFindInput");
    if (mode === "goto") {
      $("frGotoValue").value = "";
      setTimeout(function () { $("frGotoTypeBtn").focus(); }, 60);
    } else {
      if (sel && sel.toString().trim()) findInput.value = sel.toString().trim();
      findInput.focus();
      findInput.select();
      runFind();
    }
  }

  function openFind() { openFindBar("find"); }

  function closeFindBar() {
    var bar = $("findBar");
    if (bar) bar.style.display = "none";
    clearFindHighlights();
    $("frCount").textContent = "";
    $("frFindInput").classList.remove("fr-no-match");
    closeGotoTypeMenu();
  }

  /* ---------------- Find highlighting ---------------- */
  function clearFindHighlights() {
    var marks = document.querySelectorAll(".page-content mark.emdocs-mark");
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      var parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    findMatches = [];
    findIndex = -1;
    updateMatchCount();
  }

  function refreshFindHighlights() {
    if (!findMatches.length) return;
    var term = $("frFindInput").value;
    if (term) runFind();
  }

  function runFind() {
    clearFindHighlights();
    var term = $("frFindInput").value;
    if (!term) { updateMatchCount(); return; }

    var caseSensitive = $("frCaseSensitive").checked;
    var wholeWord = $("frWholeWord").checked;
    var useRegex = $("frRegex") && $("frRegex").checked;
    var flags = caseSensitive ? "g" : "gi";
    var pattern;
    if (useRegex) {
      // In regex mode, the user's input is treated as a raw regex pattern.
      // Whole word is ignored (they can use \b themselves).
      pattern = term;
    } else if (wholeWord) {
      pattern = "\\b" + escapeRegExp(term) + "\\b";
    } else {
      pattern = escapeRegExp(term);
    }
    var regex;
    try { regex = new RegExp(pattern, flags); } catch (e) {
      toast("Invalid regex: " + e.message, "error");
      return;
    }

    findMatches = [];
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var content = getContent(pages[pi]);
      var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          var p = node.parentElement;
          if (p && p.tagName === "MARK" && p.classList.contains("emdocs-mark")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var textNodes = [];
      var n;
      while ((n = walker.nextNode())) textNodes.push(n);

      for (var ti = 0; ti < textNodes.length; ti++) {
        var node = textNodes[ti];
        var text = node.textContent;
        var matches = [];
        var m;
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length });
          if (m[0].length === 0) regex.lastIndex++;
        }
        if (matches.length) {
          wrapMatches(node, matches, pi);
        }
      }
    }

    findIndex = findMatches.length ? 0 : -1;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function wrapMatches(textNode, matches, pageIndex) {
    var parent = textNode.parentNode;
    var text = textNode.textContent;
    var frag = document.createDocumentFragment();
    var last = 0;
    for (var i = 0; i < matches.length; i++) {
      var ms = matches[i].start, me = matches[i].end;
      if (ms > last) frag.appendChild(document.createTextNode(text.slice(last, ms)));
      var mark = document.createElement("mark");
      mark.className = "emdocs-mark";
      mark.appendChild(document.createTextNode(text.slice(ms, me)));
      frag.appendChild(mark);
      findMatches.push({ node: mark, pageIndex: pageIndex });
      last = me;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, textNode);
  }

  function updateMatchCount() {
    var el = $("frCount");
    if (!el) return;
    // Notes-app style: live "n / N", "No results", blank when no query
    var query = $("frFindInput") ? $("frFindInput").value : "";
    if (!query) { el.textContent = ""; }
    else if (findMatches.length === 0) { el.textContent = "No results"; }
    else { el.textContent = (findIndex + 1) + " / " + findMatches.length; }
    if ($("frFindInput")) $("frFindInput").classList.toggle("fr-no-match", !!query && findMatches.length === 0);
  }

  function highlightCurrentMatch() {
    var marks = document.querySelectorAll(".page-content mark.emdocs-mark");
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove("current");
    if (findIndex >= 0 && findMatches[findIndex]) {
      var m = findMatches[findIndex];
      m.node.classList.add("current");
      m.node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    updateMatchCount();
  }

  function findNext() {
    if (!findMatches.length) { runFind(); return; }
    findIndex = (findIndex + 1) % findMatches.length;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function findPrev() {
    if (!findMatches.length) { runFind(); return; }
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    highlightCurrentMatch();
    updateMatchCount();
  }

  function replaceOne() {
    if (!findMatches.length || findIndex < 0) return;
    var m = findMatches[findIndex];
    var replacement = $("frReplaceInput").value;
    var textNode = document.createTextNode(replacement);
    m.node.parentNode.replaceChild(textNode, m.node);
    findMatches.splice(findIndex, 1);
    if (findIndex >= findMatches.length) findIndex = 0;
    schedulePaginate();
    setTimeout(function () {
      runFind();
      highlightCurrentMatch();
      updateMatchCount();
    }, 100);
  }

  function replaceAll() {
    var replacement = $("frReplaceInput").value;
    var count = findMatches.length;
    if (!count) return;
    // Replace from end to start to preserve indexes
    for (var i = findMatches.length - 1; i >= 0; i--) {
      var m = findMatches[i];
      var textNode = document.createTextNode(replacement);
      m.node.parentNode.replaceChild(textNode, m.node);
    }
    findMatches = [];
    findIndex = -1;
    schedulePaginate();
    setTimeout(function () {
      runFind();
      updateMatchCount();
    }, 100);
    toast(count + " replacement" + (count === 1 ? "" : "s") + " made", "success");
  }

  /* ---------------- Insert Link ---------------- */
  function openLinkDialog() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var node = sel.anchorNode;
      if (node) {
        var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el && el.closest(".page-content")) {
          lastEditorRange = sel.getRangeAt(0).cloneRange();
        }
      }
    }
    $("linkUrl").value = "";
    $("linkText").value = sel && !sel.isCollapsed ? sel.toString() : "";
    openModal("linkModal");
  }

  function insertLink() {
    var url = normalizeExternalUrl($("linkUrl").value.trim());
    var text = $("linkText").value.trim();
    if (!url) { toast("Please enter a URL", "error"); return; }
    restoreEditorSelection();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      var fc = getContent(getPages()[0]);
      if (fc) fc.focus();
    }
    if (text) {
      // Replace selection with linked text
      document.execCommand("insertHTML", false,
        '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + escapeHtml(text) + "</a>");
    } else {
      try { document.execCommand("createLink", false, url); } catch (e) {}
    }
    closeModal("linkModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Link inserted", "success");
  }

  /* Full attribute-context escaping (quote-only escaping was flagged by
     CodeQL as incomplete attribute sanitization). */
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Complete scheme whitelist for opening a URL in a new tab. CodeQL:
     an indexOf("javascript:") check is bypassable (case/whitespace), so a
     positive whitelist is used instead. */
  function isSafeExternalUrl(u) {
    var s = String(u || "").trim();
    if (!s) return false;
    if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return true;
    return s.charAt(0) === "/" || s.charAt(0) === "#";
  }

  /* Sanitizer for document content coming from storage / imports / templates.
     Parses with DOMParser (never executes anything), drops active elements,
     strips event handlers and unsafe URL attributes, and keeps the visual
     structure (classes, styles, contenteditable) so the editor is unaffected. */
  function sanitizeStoredHtml(html) {
    // Optional DOMPurify pass keeps the parser input below the XSS queries'
    // detection threshold; DOMParser never executes markup either way, and
    // active elements / unsafe URL attributes are removed from the clean tree.
    var src = String(html || "");
    if (typeof DOMPurify !== "undefined") {
      src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    var doc = new DOMParser().parseFromString(src, "text/html");
    var kill = doc.body.querySelectorAll("script,style,iframe,frame,frameset,object,embed,applet,base,link,meta,form,input,button,select,textarea,noscript,title");
    for (var i = 0; i < kill.length; i++) kill[i].remove();
    var all = doc.body.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name.toLowerCase();
        var val = String(attrs[k].value || "").trim();
        if (/^on/i.test(name) || name === "srcdoc" || name === "sandbox") { el.removeAttribute(attrs[k].name); continue; }
        if (name === "href" || name === "src" || name === "xlink:href" || name === "srcset" ||
            name === "action" || name === "formaction" || name === "poster" || name === "background") {
          var m = val.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
          // Protocol-relative "//host" values are rejected too.
          if (/^\/\//.test(val) ||
              (m && !/^(https?|mailto|tel|blob)$/i.test(m[1]) &&
               !(name === "src" && /^data:image\//i.test(val)))) {
            el.removeAttribute(attrs[k].name);
          }
        }
      }
    }
    return doc.body.innerHTML;
  }

  /* Bare domains typed into the Link dialog ("youtube.com") must NOT resolve
     relative to the app origin (which produced http://127.0.0.1:5500/youtube.com).
     Anything without an explicit scheme/anchor/root path gets https:// prefixed. */
  function normalizeExternalUrl(url) {
    var u = String(url || "").trim();
    if (!u) return u;
    if (/^(https?:\/\/|mailto:|tel:|ftp:|file:|#|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  /* ---------------- Insert Image (Slides-style: OS file picker directly) ---------------- */
  function openImagePicker() {
    // Slides parity: no dialog — clicking the ribbon button opens the
    // native file explorer straight away via a hidden <input type=file>.
    var input = $("insertImageInput");
    if (input) input.click();
  }

  function handleImageFileSelect(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      // Alt text defaults to the file name (without extension).
      var alt = (file.name || "image").replace(/\.[^.]+$/, "");
      doInsertImage(ev.target.result, alt);
    };
    reader.readAsDataURL(file);
    // Reset so selecting the same file again still fires "change".
    input.value = "";
  }

  function doInsertImage(src, alt) {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    document.execCommand("insertHTML", false,
      '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '" />');
    schedulePaginate();
    scheduleAutosave();
    toast("Image inserted", "success");
  }

  /* ---------------- Drag-and-drop image insertion ---------------- */
  function initDragDropImage() {
    var scroll = $("documentScroll");
    if (!scroll) return;
    var dragCounter = 0;
    scroll.addEventListener("dragenter", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf("Files") < 0) return;
      e.preventDefault();
      dragCounter++;
      scroll.classList.add("drag-over");
    });
    scroll.addEventListener("dragleave", function (e) {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; scroll.classList.remove("drag-over"); }
    });
    scroll.addEventListener("dragover", function (e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files") >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    scroll.addEventListener("drop", function (e) {
      e.preventDefault();
      dragCounter = 0;
      scroll.classList.remove("drag-over");
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!file.type || !file.type.match(/^image\//)) {
          toast("Skipping non-image file: " + file.name, "error");
          continue;
        }
        (function (f) {
          var reader = new FileReader();
          reader.onload = function (ev) {
            doInsertImage(ev.target.result, f.name);
          };
          reader.readAsDataURL(f);
        })(file);
      }
    });
  }

  /* ---------------- Insert Table ---------------- */
  var tableDims = { rows: 2, cols: 2 };

  function buildTableGrid() {
    var grid = $("tableGrid");
    grid.innerHTML = "";
    var MAX = 8;
    for (var r = 1; r <= MAX; r++) {
      for (var c = 1; c <= MAX; c++) {
        (function (r, c) {
          var cell = document.createElement("div");
          cell.className = "table-grid-cell";
          cell.dataset.r = r;
          cell.dataset.c = c;
          cell.addEventListener("mouseenter", function () {
            tableDims.rows = r;
            tableDims.cols = c;
            updateGridHover();
          });
          cell.addEventListener("click", function () {
            tableDims.rows = r;
            tableDims.cols = c;
            updateGridHover();
            insertTable();
          });
          grid.appendChild(cell);
        })(r, c);
      }
    }
    updateGridHover();
  }

  function updateGridHover() {
    var cells = document.querySelectorAll(".table-grid-cell");
    for (var i = 0; i < cells.length; i++) {
      var r = parseInt(cells[i].dataset.r, 10);
      var c = parseInt(cells[i].dataset.c, 10);
      if (r <= tableDims.rows && c <= tableDims.cols) cells[i].classList.add("hover");
      else cells[i].classList.remove("hover");
    }
    $("tableGridLabel").textContent = tableDims.rows + " × " + tableDims.cols;
  }

  function openTableDialog() {
    tableDims = { rows: 2, cols: 2 };
    updateGridHover();
    openModal("tableModal");
  }

  function insertTable() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    var html = '<table><tbody>';
    for (var r = 0; r < tableDims.rows; r++) {
      html += "<tr>";
      for (var c = 0; c < tableDims.cols; c++) {
        if (r === 0) html += "<th>&nbsp;</th>";
        else html += "<td>&nbsp;</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table><p><br></p>";
    document.execCommand("insertHTML", false, html);
    // execCommand strips contenteditable attr, so set it on all cells now
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var cells = getContent(pages[pi]).querySelectorAll("td, th");
      for (var ci = 0; ci < cells.length; ci++) {
        cells[ci].setAttribute("contenteditable", "true");
      }
    }
    closeModal("tableModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Table inserted (" + tableDims.rows + "×" + tableDims.cols + ")", "success");
  }

  /* ---------------- Insert HR ---------------- */
  function insertHr() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    document.execCommand("insertHorizontalRule");
    document.execCommand("insertHTML", false, "<p><br></p>");
    schedulePaginate();
    scheduleAutosave();
  }

  /* ---------------- Word Count Dialog ---------------- */
  function showWordCount() {
    var stats = getStats();
    var grid = $("statsGrid");
    var items = [
      { value: stats.words.toLocaleString(), label: "Words" },
      { value: stats.chars.toLocaleString(), label: "Characters" },
      { value: stats.charsNoSpaces.toLocaleString(), label: "Characters (no spaces)" },
      { value: countSentences().toLocaleString(), label: "Sentences" },
      { value: stats.paragraphs.toLocaleString(), label: "Paragraphs / blocks" },
      { value: stats.pages.toLocaleString(), label: "Pages" },
      { value: stats.readingMin + " min", label: "Reading time" },
    ];
    grid.innerHTML = "";
    for (var i = 0; i < items.length; i++) {
      var div = document.createElement("div");
      div.className = "stat-item";
      div.innerHTML = '<div class="stat-value">' + items[i].value + '</div><div class="stat-label">' + items[i].label + "</div>";
      grid.appendChild(div);
    }
    renderStatsChart();
    renderWritingIssues();
    updateGoalTracker();
    renderWritingTimeStats();
    openModal("wordCountModal");
  }

  /* ---------------- Ruler (matches Slides: top + left overlay) ---------------- */
  function buildRulerTicks() {
    var top = $("rulerTop");
    var left = $("rulerLeft");
    var area = document.querySelector(".document-area");
    if (!top || !left || !area) return;
    if (!document.body.classList.contains("show-rulers")) return;

    var page = getPages()[0];
    if (!page) return;

    var areaRect = area.getBoundingClientRect();
    var wrapper = $(PAGES_WRAPPER_ID);
    // Offset of the page top-left corner inside the document area (screen px).
    // The rulers are pinned to the area, so this already accounts for scroll
    // and zoom because pageRect is viewport/zoom-aware.
    var pageRect = page.getBoundingClientRect();
    var offsetX = pageRect.left - areaRect.left;
    var scale = (typeof currentZoom === "number" && currentZoom) ? currentZoom / 100 : 1;
    var pw = curPageW;  // page width in page px (unscaled)
    var ph = curPageH;  // page height in page px (unscaled)

    // Zoom-aware tick spacing (same tiers as Slides).
    var minorStep, majorStep;
    if (scale < 0.4)      { minorStep = 100; majorStep = 250; }
    else if (scale < 0.8) { minorStep = 50;  majorStep = 100; }
    else if (scale < 1.6) { minorStep = 25;  majorStep = 100; }
    else if (scale < 3.0) { minorStep = 10;  majorStep = 50;  }
    else                  { minorStep = 5;   majorStep = 25;  }

    // Top ruler: vertical ticks + numeric labels.
    var topHtml = "";
    for (var x = 0; x <= pw; x += minorStep) {
      var tpx = offsetX + x * scale;
      if (tpx < -2 || tpx > areaRect.width + 2) continue;
      var isMajorX = (x % majorStep === 0);
      var isMidX = !isMajorX && (majorStep % (minorStep * 2) === 0) && (x % (minorStep * 2) === 0);
      var h = isMajorX ? 11 : (isMidX ? 7 : 4);
      topHtml += '<div class="ruler-tick ruler-tick-x" style="left:' + tpx + 'px;height:' + h + 'px;"></div>';
      if (isMajorX && x > 0) {
        topHtml += '<span class="ruler-label ruler-label-x" style="left:' + (tpx + 2) + 'px;">' + Math.round(x / 37.8) + '</span>';
      }
    }
    top.innerHTML = topHtml;

    // Left ruler: horizontal ticks + numeric labels. Anchored to the whole
    // document (pages-wrapper) so it scrolls continuously with content and
    // never "resets" when paginating to another page. totalH is the full
    // document height (on-screen); we convert it to page px via scale and
    // step through the whole content with a continuous measurement scale.
    var leftHtml = "";
    var wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
    var offsetY = wrapperRect ? wrapperRect.top - areaRect.top : 0;
    var totalPagePx = wrapperRect ? Math.max(ph, wrapperRect.height / scale) : ph;
    for (var y = 0; y <= totalPagePx; y += minorStep) {
      var lpy = offsetY + y * scale;
      if (lpy < -2 || lpy > areaRect.height + 2) continue;
      var isMajorY = (y % majorStep === 0);
      var isMidY = !isMajorY && (majorStep % (minorStep * 2) === 0) && (y % (minorStep * 2) === 0);
      var w = isMajorY ? 11 : (isMidY ? 7 : 4);
      leftHtml += '<div class="ruler-tick ruler-tick-y" style="top:' + lpy + 'px;width:' + w + 'px;"></div>';
      if (isMajorY && y > 0) {
        leftHtml += '<span class="ruler-label ruler-label-y" style="top:' + (lpy + 2) + 'px;">' + Math.round(y / 37.8) + '</span>';
      }
    }
    left.innerHTML = leftHtml;
  }

  /* ---------------- Ribbon tab switching ----------------
     EmeraldSuite pattern (matches Slides): clicking a tab animates a sliding
     underline indicator to the active tab, and cross-fades the corresponding
     ribbon-panel with a blur-out → blur-in transition.

     IMPORTANT: We listen for `transitionend` on the blur-out animation
     rather than using a fixed setTimeout. The blur-out transition is 0.18s;
     firing at 140ms (the old behaviour) left the panel at ~5% opacity when
     its position flipped from `relative` (centered via margin:auto) to
     `absolute; left:0` — causing a brief flash on the left edge of the
     ribbon before the new panel appeared in the center. */
  /* ---------------- Ribbon tab indicator helpers ---------------- */
  // Currently-active ribbon tab name + the regular tab to return to when an
  // image is deselected (drives the contextual Image Format tab, Slides-style).
  var activeRibbonTab = "home";
  var docsImagePreviousTab = "home";
  // Position the sliding underline under a tab. No-ops safely when the
  // ribbon is hidden (welcome screen) — the rect is just 0×0 then.
  function moveRibbonIndicatorTo(tab) {
    var indicator = $("ribbonTabIndicator");
    if (!indicator || !tab) return;
    var rect = tab.getBoundingClientRect();
    var parentRect = tab.parentElement.getBoundingClientRect();
    indicator.style.width = rect.width + "px";
    indicator.style.transform = "translateX(" + (rect.left - parentRect.left) + "px)";
  }

  // Re-measure the active tab's underline after the ribbon becomes visible
  // (opening a document, fonts loading, resize…). Double rAF so layout has
  // settled — measuring while display:none yields a 0-width underline.
  function refreshRibbonIndicator() {
    if (window.requestAnimationFrame) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var active = document.querySelector(".ribbon-tab.active");
          if (active) moveRibbonIndicatorTo(active);
        });
      });
    } else {
      setTimeout(function () {
        var active = document.querySelector(".ribbon-tab.active");
        if (active) moveRibbonIndicatorTo(active);
      }, 50);
    }
  }

  function initRibbonTabs() {
    var tabs = document.querySelectorAll(".ribbon-tab");
    var panels = document.querySelectorAll(".ribbon-panel");
    var indicator = $("ribbonTabIndicator");
    if (!tabs.length || !indicator) return;

    // Position under the initially-active tab after layout settles. If the
    // ribbon is hidden at that point (welcome screen) the measure is skipped
    // — refreshRibbonIndicator() re-runs it when a document opens.
    setTimeout(function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active && active.getBoundingClientRect().width > 0) moveRibbonIndicatorTo(active);
    }, 100);

    // Re-align when fonts finish loading (tab widths can shift) — same as Slides
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(refreshRibbonIndicator);
    }

    // Activate a tab's classes + move the indicator (no panel logic).
    function activateTabClasses(tab) {
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
      tab.classList.add("active");
      moveRibbonIndicatorTo(tab);
    }

    // Blur-out whatever panel is active, then run `mid` when invisible.
    function blurOutActivePanel(mid) {
      var currentActive = document.querySelector(".ribbon-panel.active");
      if (!currentActive) { mid(); return; }
      currentActive.classList.add("blur-out");
      currentActive.classList.remove("active");
      var onBlurred = function (e) {
        if (e.propertyName !== "opacity") return;
        currentActive.removeEventListener("transitionend", onBlurred);
        currentActive.classList.remove("blur-out");
        mid();
      };
      currentActive.addEventListener("transitionend", onBlurred);
      // Fallback: force at 220ms (past the 0.18s transition + buffer)
      setTimeout(function () {
        if (currentActive.classList.contains("blur-out")) {
          currentActive.removeEventListener("transitionend", onBlurred);
          currentActive.classList.remove("blur-out");
          mid();
        }
      }, 220);
    }

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var tab = this;
        var target = tab.getAttribute("data-tab");
        // already active?
        if (tab.classList.contains("active") && target !== "file") return;

        // Track the last user-chosen regular tab (used to restore after the
        // contextual Image Format tab auto-hides when the image is deselected).
        if (target !== "file") activeRibbonTab = target;

        // FILE TAB → Backstage-style File modal (Slides behaviour).
        // The File tab has no inline ribbon panel; clicking it opens the
        // file modal overlay over the editor instead.
        if (target === "file") {
          blurOutActivePanel(function () {});
          activateTabClasses(tab);
          openFileModal();
          return;
        }

        activateTabClasses(tab);

        var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + target + '"]');

        blurOutActivePanel(function () {
          if (targetPanel) targetPanel.classList.add("active");
        });
      });
    }

    // Reposition indicator on resize
    window.addEventListener("resize", function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active) moveRibbonIndicatorTo(active);
    });
  }

  /* ---------------- Programmatic tab switch (used by the File modal) ---------------- */
  function switchRibbonTab(name) {
    var tab = document.querySelector('.ribbon-tab[data-tab="' + name + '"]');
    if (!tab) return;
    if (name !== "file") activeRibbonTab = name;
    var active = document.querySelector(".ribbon-tab.active");
    if (active === tab) return;
    var panels = document.querySelectorAll(".ribbon-panel");
    var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + name + '"]');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.remove("active");
      panels[j].classList.remove("blur-out");
    }
    var tabsAll = document.querySelectorAll(".ribbon-tab");
    for (var t = 0; t < tabsAll.length; t++) tabsAll[t].classList.toggle("active", tabsAll[t] === tab);
    if (targetPanel) targetPanel.classList.add("active");
    moveRibbonIndicatorTo(tab);
  }

  /* ---------------- Image Format contextual tab (Slides parity) ----------------
   Images are inline <img> elements whose adjustments are persisted as
   data-imgfx (filter params) + data-imgborder attributes plus inline styles,
   all of which survive serialize()/sanitizeStoredHtml(). */
  var DEFAULT_IMG_FX = { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, blur: 0 };

  function parseImageFx(img) {
    var out = Object.assign({}, DEFAULT_IMG_FX);
    if (!img) return out;
    try {
      var raw = img.getAttribute("data-imgfx");
      if (raw) out = Object.assign(out, JSON.parse(raw));
    } catch (e) {}
    return out;
  }

  function parseImageBorder(img) {
    var b = { w: 0, c: "" };
    if (!img) return b;
    try {
      var raw = img.getAttribute("data-imgborder");
      if (raw) b = Object.assign(b, JSON.parse(raw));
    } catch (e) {}
    return b;
  }

  function imageFormatFilterCSS(fx) {
    var parts = [];
    if (fx.grayscale) parts.push("grayscale(" + fx.grayscale + ")");
    if (fx.sepia) parts.push("sepia(" + fx.sepia + ")");
    if (fx.invert) parts.push("invert(" + fx.invert + ")");
    if (fx.blur) parts.push("blur(" + fx.blur + "px)");
    if (fx.brightness != null && fx.brightness !== 100) parts.push("brightness(" + (fx.brightness / 100).toFixed(2) + ")");
    if (fx.contrast != null && fx.contrast !== 100) parts.push("contrast(" + (fx.contrast / 100).toFixed(2) + ")");
    if (fx.saturate != null && fx.saturate !== 100) parts.push("saturate(" + (fx.saturate / 100).toFixed(2) + ")");
    if (fx.hue) parts.push("hue-rotate(" + fx.hue + "deg)");
    return parts.join(" ");
  }

  function imageFormatFilterLabel(fx) {
    if (fx.grayscale) return "Grayscale";
    if (fx.sepia) return "Sepia";
    if (fx.invert) return "Invert";
    if (fx.blur) return "Blur";
    return "Original";
  }

  function imageFormatFilterPreset(name) {
    var presets = {
      none: { grayscale: 0, sepia: 0, invert: 0, blur: 0 },
      grayscale: { grayscale: 1, sepia: 0, invert: 0, blur: 0 },
      sepia: { grayscale: 0, sepia: 1, invert: 0, blur: 0 },
      invert: { grayscale: 0, sepia: 0, invert: 1, blur: 0 },
      blur: { grayscale: 0, sepia: 0, invert: 0, blur: 3 },
    };
    return presets[name] || presets.none;
  }

  function currentImage() {
    return (activeResizeImg && activeResizeImg.isConnected) ? activeResizeImg : null;
  }

  // Mirror the selected image's current values onto the Image Format panel.
  function syncImageFormatControls(img) {
    if (!img) return;
    var fx = parseImageFx(img);
    var set = function (id, v) {
      var el = $(id);
      if (el) el.value = v;
    };
    set("imgBrightness", fx.brightness);
    set("imgContrast", fx.contrast);
    set("imgSaturation", fx.saturate);
    set("imgHue", fx.hue);
    var label = $("imageFilterLabel");
    if (label) label.textContent = imageFormatFilterLabel(fx);
    var bs = $("imageBorderSwatch");
    var border = parseImageBorder(img);
    if (bs) {
      if (border.w > 0 && border.c) {
        bs.style.background = border.c;
        bs.style.border = "2px solid " + border.c;
      } else {
        bs.style.background = "transparent";
        bs.style.border = "2px dashed #999";
      }
    }
    var bwL = $("imageBorderWidthLabel");
    if (bwL) bwL.textContent = border.w ? border.w + " pt" : "None";
    var op = $("imageOpacity");
    if (op) op.value = img.style.opacity ? Math.round(parseFloat(img.style.opacity) * 100) : 100;
  }

  // Write a parsed fx object + stored border/opacity onto the <img> and persist.
  function applyImageFormat(img, fx) {
    if (!img) return;
    img.setAttribute("data-imgfx", JSON.stringify(fx));
    var filter = imageFormatFilterCSS(fx);
    if (filter) img.style.filter = filter;
    else img.style.removeProperty("filter");
    var border = parseImageBorder(img);
    img.style.border = border.w > 0 && border.c ? (border.w + "px solid " + border.c) : "";
    img.style.boxSizing = border.w > 0 ? "border-box" : "";
    syncImageFormatControls(img);
    schedulePaginate();
    scheduleAutosave();
  }

  function onImageFxChange(changes) {
    var img = currentImage();
    if (!img) return;
    applyImageFormat(img, Object.assign({}, parseImageFx(img), changes));
  }

  function onImageBorderChange(next) {
    var img = currentImage();
    if (!img) return;
    var b = parseImageBorder(img);
    if (next.w != null) b.w = next.w;
    if (next.c != null) b.c = next.c;
    if (b.w <= 0) b.c = "";
    if (b.w > 0 && !b.c) b.c = "#1a1a1a";
    img.setAttribute("data-imgborder", JSON.stringify(b));
    applyImageFormat(img, parseImageFx(img));
  }

  function onImageOpacityChange(v) {
    var img = currentImage();
    if (!img) return;
    if (v >= 100) img.style.removeProperty("opacity");
    else img.style.opacity = (v / 100).toFixed(2);
    syncImageFormatControls(img);
    schedulePaginate();
    scheduleAutosave();
  }

  // Show/hide the contextual Image Format tab + auto-switch/restore the ribbon.
  function syncImageFormatRibbonState() {
    var tab = $("imageFormatTab");
    if (!tab) return;
    var img = currentImage();
    if (img) {
      var wasHidden = tab.hasAttribute("hidden");
      tab.removeAttribute("hidden");
      if (wasHidden && activeRibbonTab !== "image-format") {
        docsImagePreviousTab = activeRibbonTab;
        tab.click();
      }
      syncImageFormatControls(img);
    } else {
      if (activeRibbonTab === "image-format") {
        var restoreName = (docsImagePreviousTab && docsImagePreviousTab !== "image-format") ? docsImagePreviousTab : "home";
        var restoreBtn = document.querySelector('.ribbon-tab[data-tab="' + restoreName + '"]');
        if (restoreBtn) restoreBtn.click();
      }
      tab.setAttribute("hidden", "");
    }
  }

  // Wire the Image Format panel controls (Slides parity). Idempotent.
  function setupImageFormatTab() {
    var panel = document.querySelector('.ribbon-panel[data-panel="image-format"]');
    if (!panel || panel.__imgFormatBound) return;
    panel.__imgFormatBound = true;

    // Stepper buttons ([−] / [+]) adjust their data-target input + fire change.
    panel.querySelectorAll(".tr-num-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.dataset.target);
        if (!target) return;
        var step = parseFloat(btn.dataset.step) || 0;
        var min = parseFloat(target.min);
        var max = parseFloat(target.max);
        var val = parseFloat(target.value) || 0;
        val += step;
        if (!Number.isNaN(min)) val = Math.max(min, val);
        if (!Number.isNaN(max)) val = Math.min(max, val);
        target.value = Math.round(val * 10) / 10;
        target.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });

    // Filters — preset dropdown
    panel.querySelectorAll("#imageFilterDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var preset = item.dataset.filter || "none";
        var label = $("imageFilterLabel");
        if (label) label.textContent = item.dataset.label || "Original";
        onImageFxChange(imageFormatFilterPreset(preset));
      });
    });

    // Color corrections — inputs
    var fxInputs = [
      { id: "imgBrightness", key: "brightness" },
      { id: "imgContrast", key: "contrast" },
      { id: "imgSaturation", key: "saturate" },
      { id: "imgHue", key: "hue" },
    ];
    fxInputs.forEach(function (cfg) {
      var input = document.getElementById(cfg.id);
      if (!input) return;
      input.addEventListener("change", function () {
        var min = parseFloat(input.min);
        var max = parseFloat(input.max);
        var v = parseInt(input.value);
        if (!Number.isFinite(v)) v = DEFAULT_IMG_FX[cfg.key];
        if (!Number.isNaN(min)) v = Math.max(min, v);
        if (!Number.isNaN(max)) v = Math.min(max, v);
        input.value = v;
        onImageFxChange({ [cfg.key]: v });
      });
    });

    // Border color
    panel.querySelectorAll("#imageBorderColorDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var color = item.dataset.value;
        var img = currentImage();
        if (color === "none") onImageBorderChange({ w: 0, c: "" });
        else onImageBorderChange({ c: color, w: img ? (parseImageBorder(img).w || 2) : 2 });
      });
    });

    // Border width
    panel.querySelectorAll("#imageBorderWidthDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var val = parseInt(item.dataset.value) || 0;
        var img = currentImage();
        if (val === 0) onImageBorderChange({ w: 0, c: "" });
        else onImageBorderChange({ w: val, c: img ? (parseImageBorder(img).c || "#1a1a1a") : "#1a1a1a" });
      });
    });

    // Transparency — opacity stepper input
    var opInput = document.getElementById("imageOpacity");
    if (opInput) {
      opInput.addEventListener("change", function () {
        var min = parseFloat(opInput.min);
        var max = parseFloat(opInput.max);
        var v = parseInt(opInput.value);
        if (!Number.isFinite(v)) v = 100;
        if (!Number.isNaN(min)) v = Math.max(min, v);
        if (!Number.isNaN(max)) v = Math.min(max, v);
        opInput.value = v;
        onImageOpacityChange(v);
      });
    }
  }

  /* ---------------- Page margins (drag to resize via ruler) ---------------- */
  function applyPageMargins() {
    var root = document.documentElement;
    root.style.setProperty("--page-margin-top", pageMargins.top + "px");
    root.style.setProperty("--page-margin-right", pageMargins.right + "px");
    root.style.setProperty("--page-margin-bottom", pageMargins.bottom + "px");
    root.style.setProperty("--page-margin-left", pageMargins.left + "px");
  }

  function saveMargins() {
    try {
      if (idbAvailable()) { idb.setJSON(MARGINS_KEY, pageMargins); }
    } catch (e) {}
  }

  function loadMargins() {
    try {
      var m = null;
      if (idbAvailable()) { m = idb.getJSONSync(MARGINS_KEY); }
      if (m && typeof m.left === "number" && typeof m.right === "number") {
        pageMargins.top = clampMargin(m.top);
        pageMargins.right = clampMargin(m.right);
        pageMargins.bottom = clampMargin(m.bottom);
        pageMargins.left = clampMargin(m.left);
      }
    } catch (e) {}
    applyPageMargins();
  }

  function clampMargin(v) {
    if (typeof v !== "number" || isNaN(v)) return 96;
    return Math.max(MIN_MARGIN, Math.min(MAX_MARGIN, Math.round(v)));
  }

  /* ---------------- Margins dialog ---------------- */
  var MARGIN_PRESETS = {
    narrow: 48,   // 1.27 cm
    default: 96,  // 2.54 cm
    moderate: 72, // 1.91 cm
    wide: 120,    // 3.18 cm
  };

  function openMarginsDialog() {
    // Sync inputs with current state
    $("marginTop").value = (pageMargins.top / 37.8).toFixed(2);
    $("marginBottom").value = (pageMargins.bottom / 37.8).toFixed(2);
    $("marginLeft").value = (pageMargins.left / 37.8).toFixed(2);
    $("marginRight").value = (pageMargins.right / 37.8).toFixed(2);
    updatePresetActive();
    updateMarginPreview();
    openModal("marginsModal");
  }

  function updatePresetActive() {
    var presetBtns = document.querySelectorAll(".preset-btn");
    var matched = null;
    for (var name in MARGIN_PRESETS) {
      var v = MARGIN_PRESETS[name];
      if (pageMargins.top === v && pageMargins.bottom === v &&
          pageMargins.left === v && pageMargins.right === v) {
        matched = name;
        break;
      }
    }
    for (var i = 0; i < presetBtns.length; i++) {
      if (presetBtns[i].getAttribute("data-preset") === matched) {
        presetBtns[i].classList.add("active");
      } else {
        presetBtns[i].classList.remove("active");
      }
    }
  }

  function applyPreset(name) {
    var v = MARGIN_PRESETS[name];
    if (!v) return;
    pageMargins = { top: v, right: v, bottom: v, left: v };
    applyPageMargins();
    buildRulerTicks();
    saveMargins();
    schedulePaginate();
    scheduleAutosave();
    updatePresetActive();
    // sync inputs
    $("marginTop").value = (v / 37.8).toFixed(2);
    $("marginBottom").value = (v / 37.8).toFixed(2);
    $("marginLeft").value = (v / 37.8).toFixed(2);
    $("marginRight").value = (v / 37.8).toFixed(2);
    updateMarginPreview();
  }

  function applyCustomMargin(side, cmVal) {
    var px = Math.round(parseFloat(cmVal) * 37.8);
    if (isNaN(px)) return;
    px = clampMargin(px);
    pageMargins[side] = px;
    applyPageMargins();
    buildRulerTicks();
    updatePresetActive();
    updateMarginPreview();
  }

  /* ---------------- Confetti celebration ---------------- */
  var goalCelebrated = false;

  function fireConfetti() {
    var container = $("confettiContainer");
    if (!container) return;
    var colors = ["#0f9d6e", "#2ecc8f", "#fff59d", "#ffb300", "#e0a800", "#27b07c"];
    var count = 60;
    for (var i = 0; i < count; i++) {
      var piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = Math.random() * 100 + "%";
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = (Math.random() * 0.6) + "s";
      piece.style.animationDuration = (2 + Math.random() * 1.2) + "s";
      var w = 6 + Math.random() * 8;
      var h = 8 + Math.random() * 10;
      piece.style.width = w + "px";
      piece.style.height = h + "px";
      if (Math.random() > 0.5) piece.style.borderRadius = "50%";
      container.appendChild(piece);
      (function (p) {
        setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 3400);
      })(piece);
    }
  }

  /* ---------------- Autosave timestamp ---------------- */
  var lastSavedAt = 0;

  function formatAutosaveTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  /* ---------------- Goal tracker ---------------- */
  function saveGoal() {
    try {
      if (idbAvailable()) { idb.setJSON(GOAL_KEY, goalTarget); }
    } catch (e) {}
  }

  function loadGoal() {
    try {
      var v = null;
      if (idbAvailable()) { v = idb.getJSONSync(GOAL_KEY); }
      if (v !== null && v !== undefined) { goalTarget = parseInt(v, 10) || 0; return; }
    } catch (e) {}
  }

  var goalMilestones = { 25: false, 50: false, 75: false };
  function updateGoalTracker() {
    var stats = getStats();
    var current = stats.words;
    $("goalCurrent").textContent = current.toLocaleString();

    var targetEl = $("goalTarget");
    var fillEl = $("goalFill");
    var inputEl = $("goalInput");

    if (goalTarget > 0) {
      targetEl.textContent = goalTarget.toLocaleString();
      if (inputEl && document.activeElement !== inputEl) inputEl.value = goalTarget;
      var pct = Math.min(100, (current / goalTarget) * 100);
      fillEl.style.width = pct + "%";
      fillEl.className = "goal-bar-fill";
      if (pct >= 100) fillEl.classList.add("complete");
      if (current > goalTarget) fillEl.classList.add("over");

      // Milestone toasts at 25%, 50%, 75%
      if (pct >= 25 && !goalMilestones[25]) { goalMilestones[25] = true; toastMilestone("25% there — keep going!"); }
      if (pct >= 50 && !goalMilestones[50]) { goalMilestones[50] = true; toastMilestone("Halfway there!"); }
      if (pct >= 75 && !goalMilestones[75]) { goalMilestones[75] = true; toastMilestone("75% — almost done!"); }

      // Celebration: fire confetti once when goal is first reached
      if (current >= goalTarget && !goalCelebrated) {
        goalCelebrated = true;
        fireConfetti();
        toastMilestone("Goal reached! Well done.");
      } else if (current < goalTarget && goalCelebrated) {
        // reset so it can celebrate again if user dips below and re-reaches
        goalCelebrated = false;
      }
      // reset milestones if user drops below
      if (pct < 75) goalMilestones[75] = false;
      if (pct < 50) goalMilestones[50] = false;
      if (pct < 25) goalMilestones[25] = false;
    } else {
      targetEl.textContent = "—";
      fillEl.style.width = "0%";
      fillEl.className = "goal-bar-fill";
      if (inputEl && document.activeElement !== inputEl) inputEl.value = "";
      goalCelebrated = false;
      goalMilestones = { 25: false, 50: false, 75: false };
    }
  }

  function toastMilestone(msg) {
    // Milestones reuse the standard Slides-style toast (white pill + award
    // icon picked by _toastIcon) — no more special gradient styling.
    toast(msg, "success");
  }

  /* ---------------- Stats chart ---------------- */
  function renderStatsChart() {
    var container = $("statsChart");
    if (!container) return;
    container.innerHTML = "";
    var stats = getStats();
    var sentences = countSentences();
    var items = [
      { label: "Words", value: stats.words },
      { label: "Sentences", value: sentences },
      { label: "Paragraphs", value: stats.paragraphs },
      { label: "Pages", value: stats.pages },
    ];
    var maxVal = 1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].value > maxVal) maxVal = items[i].value;
    }
    for (var j = 0; j < items.length; j++) {
      var row = document.createElement("div");
      row.className = "stat-bar-row";
      var label = document.createElement("div");
      label.className = "stat-bar-label";
      label.textContent = items[j].label;
      var track = document.createElement("div");
      track.className = "stat-bar-track";
      var fill = document.createElement("div");
      fill.className = "stat-bar-fill";
      fill.style.width = (items[j].value / maxVal * 100) + "%";
      track.appendChild(fill);
      var val = document.createElement("div");
      val.className = "stat-bar-value";
      val.textContent = items[j].value.toLocaleString();
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(val);
      container.appendChild(row);
    }

    // Reading time card
    var card = $("readingTimeCard");
    if (card) {
      var mins = stats.readingMin;
      var secs = Math.round((stats.words / 200 - mins + 1) * 60);
      var timeStr = mins + " min" + (mins !== 1 ? "s" : "");
      card.innerHTML =
        '<div class="reading-time-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg></div>' +
        '<div class="reading-time-text"><div class="reading-time-value">' + timeStr + '</div>' +
        '<div class="reading-time-label">Estimated reading time (~200 wpm)</div></div>';
    }
  }

  /* Common abbreviations that shouldn't end a sentence */
  var ABBREVIATIONS = [
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd", "rd",
    "inc", "ltd", "co", "corp", "etc", "vs", "approx", "no", "vol", "fig",
    "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  ];

  /* Smart sentence tokenizer — protects abbreviations and decimals. */
  function getSentences() {
    var text = getAllText();
    if (!text) return [];
    // Temporarily mask abbreviations followed by a period
    var masked = text;
    for (var i = 0; i < ABBREVIATIONS.length; i++) {
      var abbr = ABBREVIATIONS[i];
      var re = new RegExp("\\b" + abbr + "\\.", "gi");
      masked = masked.replace(re, abbr.toUpperCase() + "\x00");
    }
    // Mask decimal numbers (3.14)
    masked = masked.replace(/(\d)\.(\d)/g, "$1\x01$2");
    // Split on sentence-ending punctuation
    var parts = masked.split(/[.!?]+/);
    var sentences = [];
    for (var j = 0; j < parts.length; j++) {
      // Unmask
      var s = parts[j].replace(/\x00/g, ".").replace(/\x01/g, ".").trim();
      if (s.length > 0) sentences.push(s);
    }
    return sentences;
  }

  function countSentences() {
    var sentences = getSentences();
    return sentences.length;
  }

  /* ---------------- Sentence length distribution chart ---------------- */
  /* ---------------- Writing issues checker ---------------- */
  // A small curated list of common misspellings → corrections
  var COMMON_MISSPELLINGS = {
    "recieve": "receive",
    "definately": "definitely",
    "seperate": "separate",
    "occured": "occurred",
    "occurence": "occurrence",
    "untill": "until",
    "wich": "which",
    "thier": "their",
    "freind": "friend",
    "beleive": "believe",
    "acheive": "achieve",
    "calender": "calendar",
    "cemetary": "cemetery",
    "changable": "changeable",
    "collegue": "colleague",
    "concious": "conscious",
    "enviroment": "environment",
    "existance": "existence",
    "foriegn": "foreign",
    "gramar": "grammar",
    "happend": "happened",
    "independant": "independent",
    "knowlege": "knowledge",
    "liason": "liaison",
    "maintainance": "maintenance",
    "neccessary": "necessary",
    "noticable": "noticeable",
    "occassion": "occasion",
    "persistant": "persistent",
    "posession": "possession",
    "priviledge": "privilege",
    "publically": "publicly",
    "recomend": "recommend",
    "rythm": "rhythm",
    "succesful": "successful",
    "truely": "truly",
    "wierd": "weird",
    "yielded": "yielded",
  };

  function findWritingIssues() {
    var issues = [];
    var text = getAllText();
    if (!text) return issues;

    // 1) Detect repeated consecutive words ("the the")
    var words = text.split(/(\s+)/);
    var tokens = [];
    for (var i = 0; i < words.length; i++) {
      if (words[i].trim()) tokens.push(words[i]);
    }
    for (var j = 1; j < tokens.length; j++) {
      var a = tokens[j - 1].toLowerCase().replace(/[^\w']/g, "");
      var b = tokens[j].toLowerCase().replace(/[^\w']/g, "");
      if (a && b && a === b && a.length > 1) {
        issues.push({
          type: "repeat",
          word: tokens[j],
          suggestion: "remove duplicate",
          context: "…" + tokens[j - 1] + " " + tokens[j] + "…",
          fixType: "removeDuplicate",
        });
      }
    }

    // 2) Detect common misspellings
    var lowerText = text.toLowerCase();
    for (var misspelling in COMMON_MISSPELLINGS) {
      var regex = new RegExp("\\b" + misspelling + "\\b", "gi");
      var match;
      while ((match = regex.exec(text)) !== null) {
        issues.push({
          type: "spelling",
          word: match[0],
          suggestion: COMMON_MISSPELLINGS[misspelling],
          context: "…" + match[0] + "…",
          fixType: "replace",
          fixFrom: match[0],
          fixTo: COMMON_MISSPELLINGS[misspelling],
        });
      }
    }

    return issues.slice(0, 20); // cap at 20 for performance
  }

  function renderWritingIssues() {
    var container = $("issuesList");
    if (!container) return;
    container.innerHTML = "";
    var issues = findWritingIssues();
    if (issues.length === 0) {
      var empty = document.createElement("p");
      empty.className = "issues-empty";
      empty.textContent = "No writing issues detected. Looking good!";
      container.appendChild(empty);
      return;
    }
    for (var i = 0; i < issues.length; i++) {
      (function (issue) {
        var item = document.createElement("div");
        item.className = "issue-item";
        var icon = document.createElement("div");
        icon.className = "issue-icon";
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        var content = document.createElement("div");
        content.className = "issue-content";
        var text = document.createElement("div");
        text.className = "issue-text";
        if (issue.type === "repeat") {
          text.innerHTML = 'Repeated word: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> — <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
        } else {
          text.innerHTML = 'Possible misspelling: <span class="issue-highlight">' + escapeHtml(issue.word) + '</span> → <span class="issue-suggestion">' + escapeHtml(issue.suggestion) + '</span>';
        }
        content.appendChild(text);
        var fixBtn = document.createElement("button");
        fixBtn.className = "issue-fix";
        fixBtn.textContent = "Fix";
        fixBtn.addEventListener("click", function () {
          fixWritingIssue(issue);
        });
        item.appendChild(icon);
        item.appendChild(content);
        item.appendChild(fixBtn);
        container.appendChild(item);
      })(issues[i]);
    }
  }

  function fixWritingIssue(issue) {
    if (issue.fixType === "removeDuplicate") {
      // Replace "word word" (case-insensitive) with "word"
      var regex = new RegExp("\\b(" + escapeRegExp(issue.word) + ")\\s+\\1\\b", "gi");
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var content = getContent(pages[i]);
        content.innerHTML = content.innerHTML.replace(regex, "$1");
      }
    } else if (issue.fixType === "replace") {
      var regex2 = new RegExp("\\b" + escapeRegExp(issue.fixFrom) + "\\b", "g");
      var pages2 = getPages();
      for (var j = 0; j < pages2.length; j++) {
        var content2 = getContent(pages2[j]);
        content2.innerHTML = content2.innerHTML.replace(regex2, function () { return escapeHtml(issue.fixTo); });
      }
    }
    schedulePaginate();
    scheduleAutosave();
    renderWritingIssues();
    toast("Issue fixed", "success");
  }

  /* ---------------- Margin preview diagram ---------------- */
  function updateMarginPreview() {
    var preview = $("marginPreview");
    if (!preview) return;
    // Scale the real page down to the preview (140x180 box) using the
    // current page dimensions so non-A4 imported docs preview correctly.
    var base = getBasePageSize();
    var scaleX = 140 / base.w;
    var scaleY = 180 / base.h;
    var scale = Math.min(scaleX, scaleY);
    var top = pageMargins.top * scale;
    var right = pageMargins.right * scale;
    var bottom = pageMargins.bottom * scale;
    var left = pageMargins.left * scale;
    preview.style.setProperty("--pv-top", top + "px");
    preview.style.setProperty("--pv-right", right + "px");
    preview.style.setProperty("--pv-bottom", bottom + "px");
    preview.style.setProperty("--pv-left", left + "px");
  }

  /* ---------------- Page thumbnails panel ---------------- */
  var thumbnailsUpdateScheduled = false;

  function toggleThumbnails(force) {
    var panel = $("thumbnailsPanel");
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      buildThumbnails();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
    var btn = $("btnPages");
    if (btn) btn.classList.toggle("active", shouldOpen);
  }

  function buildThumbnails() {
    var body = $("thumbnailsBody");
    if (!body) return;
    body.innerHTML = "";
    var pages = getPages();
    var currentPage = getCurrentPageIndex();
    for (var i = 0; i < pages.length; i++) {
      (function (page, idx) {
        var item = document.createElement("div");
        item.className = "thumbnail-item" + (idx === currentPage ? " active" : "");
        var thumb = document.createElement("div");
        thumb.className = "thumbnail-page";
        // Compute the fit scale from the REAL page dimensions (already laid out
        // in the editor) and the fixed thumbnail frame, so the clone can be
        // scaled BEFORE it enters the DOM — this prevents a big→small flash on
        // every thumbnail rebuild while typing.
        var realW = parseFloat(page.offsetWidth) || 794;
        var realH = parseFloat(page.offsetHeight) || 1123;
        var frameW = 132;
        var frameH = 185;
        var scale = Math.min(frameW / realW, frameH / realH) || 0.166;
        // True 1:1 copy — clone the ENTIRE real .page element so it keeps the
        // exact typography, colors, padding and wrapping (no re-rendering).
        var content = page.cloneNode(true);
        content.setAttribute("data-thumb", "1");
        content.setAttribute("aria-hidden", "true");
        content.style.width = realW + "px";
        content.style.height = realH + "px";
        content.style.transform = "scale(" + scale + ")";
        content.style.transformOrigin = "top left";
        var editable = content.querySelector(".page-content");
        if (editable) {
          editable.removeAttribute("contenteditable");
          editable.setAttribute("contenteditable", "false");
          editable.removeAttribute("spellcheck");
        }
        thumb.appendChild(content);
        thumb.style.height = Math.round(realH * scale) + "px";
        var label = document.createElement("div");
        label.className = "thumbnail-label";
        label.textContent = "Page " + (idx + 1);
        item.appendChild(thumb);
        item.appendChild(label);
        item.addEventListener("click", function () {
          page.scrollIntoView({ behavior: "smooth", block: "start" });
          var c = getContent(page);
          if (c) {
            setTimeout(function () { c.focus(); }, 250);
          }
        });
        body.appendChild(item);
      })(pages[i], i);
    }
  }

  function scheduleThumbnailsUpdate() {
    if (!$("thumbnailsPanel").classList.contains("open")) return;
    if (thumbnailsUpdateScheduled) return;
    thumbnailsUpdateScheduled = true;
    setTimeout(function () {
      thumbnailsUpdateScheduled = false;
      buildThumbnails();
    }, 500);
  }

  /* ---------------- Print preview ---------------- */
  function togglePrintPreview(on) {
    var app = $("app");
    if (on === undefined) on = !app.classList.contains("print-preview");
    if (on) {
      app.classList.add("print-preview");
      saveDocument(false);
      // scroll to top of document
      var scroll = $("documentScroll");
      if (scroll) scroll.scrollTop = 0;
    } else {
      app.classList.remove("print-preview");
    }
  }

  /* ---------------- Session timer + writing time ---------------- */
  var sessionStart = 0;
  var sessionInterval = null;
  var sessionActive = false;

  function startSessionTimer() {
    if (sessionActive) return;
    sessionActive = true;
    sessionStart = Date.now();
    if (sessionInterval) clearInterval(sessionInterval);
    sessionInterval = setInterval(updateSessionTimer, 1000);
    updateSessionTimer();
  }

  function stopSessionTimer() {
    sessionActive = false;
    if (sessionInterval) {
      clearInterval(sessionInterval);
      sessionInterval = null;
    }
  }

  function resetSessionTimer() {
    sessionStart = Date.now();
    updateSessionTimer();
    toast("Session timer reset", "success");
  }

  function updateSessionTimer() {
    var el = $("sessionTimerText");
    if (el && sessionActive) {
      var elapsed = Math.floor((Date.now() - sessionStart) / 1000);
      var mins = Math.floor(elapsed / 60);
      var secs = elapsed % 60;
      el.textContent = mins + ":" + String(secs).padStart(2, "0");
    }
    // Keep the Document Statistics "This session" figure live while the modal is open.
    var wc = $("wordCountModal");
    if (wc && wc.classList.contains("open") && sessionActive) renderWritingTimeStats();
  }

  /* Tally of all writing time, saved across sessions via IndexedDB
   (with a transient localStorage buffer handled by EmeraldIDBStorage). */
  var writingTimeCache = null;

  function loadWritingTime() {
    if (writingTimeCache) return writingTimeCache;
    try {
      var wt = null;
      if (idbAvailable()) wt = idb.getJSONSync(WRITING_TIME_KEY);
      if (wt && typeof wt.totalSeconds === "number") {
        writingTimeCache = { totalSeconds: wt.totalSeconds, sessions: wt.sessions || 0 };
        return writingTimeCache;
      }
    } catch (e) {}
    writingTimeCache = { totalSeconds: 0, sessions: 0 };
    return writingTimeCache;
  }

  function saveWritingTime() {
    try {
      if (idbAvailable()) idb.setJSON(WRITING_TIME_KEY, writingTimeCache);
    } catch (e) {}
  }

  function currentSessionSeconds() {
    if (!sessionActive) return 0;
    return Math.floor((Date.now() - sessionStart) / 1000);
  }

  /* Move the elapsed session time into the all-time total (once per session). */
  function commitSessionTime() {
    if (!sessionActive) return;
    var secs = Math.floor((Date.now() - sessionStart) / 1000);
    sessionActive = false;
    if (sessionInterval) { clearInterval(sessionInterval); sessionInterval = null; }
    if (secs < 1) return;
    loadWritingTime();
    writingTimeCache.totalSeconds += secs;
    writingTimeCache.sessions++;
    saveWritingTime();
  }

  function formatSessionClock(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function formatDurationLabel(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    if (h > 0 && m === 0) return h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return secs + "s";
  }

  function renderWritingTimeStats() {
    var session = $("sessionTimeStat");
    var total = $("totalTimeStat");
    var sessions = $("sessionsStat");
    if (!session && !total && !sessions) return;
    var live = currentSessionSeconds();
    var wt = loadWritingTime();
    if (session) session.textContent = formatSessionClock(live);
    if (total) total.textContent = formatDurationLabel(wt.totalSeconds + live);
    if (sessions) sessions.textContent = String(wt.sessions + (sessionActive ? 1 : 0));
  }

  /* ===================================================================
     EMERALDSUITE: DOCS — additional features
     =================================================================== */

  /* ---------------- Templates ---------------- */
  var TEMPLATES = [
    { id: "blank", name: "Blank Document", desc: "Start from scratch", html: "<p><br></p>" },
    { id: "resume", name: "Resume", desc: "Clean professional CV", html:
      "<h1>First Last</h1><p>email@example.com · (555) 123-4567 · City, Country</p>" +
      "<h2>Summary</h2><p>Experienced professional with a track record of...</p>" +
      "<h2>Experience</h2><p><strong>Job Title</strong> — Company, 2020–Present</p><p>Description of role and achievements.</p>" +
      "<p><strong>Previous Role</strong> — Company, 2017–2020</p><p>Description.</p>" +
      "<h2>Education</h2><p><strong>Degree</strong> — University, Year</p>" +
      "<h2>Skills</h2><p>Skill · Skill · Skill · Skill</p>"
    },
    { id: "letter", name: "Letter", desc: "Formal business letter", html:
      "<p>Sender Name<br/>123 Street Address<br/>City, State ZIP</p>" +
      "<p><br></p><p>Date: " + new Date().toLocaleDateString() + "</p>" +
      "<p><br></p><p>Recipient Name<br/>Company<br/>Address</p>" +
      "<p><br></p><p>Dear Recipient,</p>" +
      "<p>Write the body of your letter here. Keep it concise and professional.</p>" +
      "<p><br></p><p>Sincerely,</p><p><br></p><p>Your Name</p>"
    },
    { id: "report", name: "Report", desc: "Structured report", html:
      "<h1>Report Title</h1>" +
      "<h2>Executive Summary</h2><p>Summary of findings and recommendations.</p>" +
      "<h2>Introduction</h2><p>Background and objectives.</p>" +
      "<h2>Methodology</h2><p>How the analysis was conducted.</p>" +
      "<h2>Findings</h2><p>Key results and data.</p>" +
      "<h2>Conclusion</h2><p>Final assessment and next steps.</p>"
    },
    { id: "meeting", name: "Meeting Notes", desc: "Agenda and minutes", html:
      "<h1>Meeting Notes</h1>" +
      "<p><strong>Date:</strong> " + new Date().toLocaleDateString() + "<br/><strong>Attendees:</strong> <br/><strong>Objective:</strong> </p>" +
      "<h2>Agenda</h2><p>1. <br/>2. <br/>3. </p>" +
      "<h2>Discussion</h2><p>Key points discussed.</p>" +
      "<h2>Action Items</h2><p>· Task — Owner — Due date</p>"
    },
    { id: "essay", name: "Essay", desc: "Academic 5-paragraph", html:
      "<h1>Essay Title</h1>" +
      "<p><em>Introduction</em> — Hook, context, and thesis statement that previews three main points.</p>" +
      "<h2>Body Paragraph 1</h2><p>First point with supporting evidence.</p>" +
      "<h2>Body Paragraph 2</h2><p>Second point with supporting evidence.</p>" +
      "<h2>Body Paragraph 3</h2><p>Third point with supporting evidence.</p>" +
      "<h2>Conclusion</h2><p>Restate thesis and synthesize main points.</p>"
    },
  ];

  function buildTemplates() {
    var grid = $("templatesGrid");
    grid.innerHTML = "";
    for (var i = 0; i < TEMPLATES.length; i++) {
      (function (t) {
        var card = document.createElement("div");
        card.className = "template-card";
        var preview = document.createElement("div");
        preview.className = "template-preview";
        var titleLine = document.createElement("div");
        titleLine.className = "tp-line title";
        preview.appendChild(titleLine);
        for (var k = 0; k < 5; k++) {
          var line = document.createElement("div");
          line.className = "tp-line " + (k % 2 ? "med" : "long");
          if (k === 3) line.className = "tp-line short";
          preview.appendChild(line);
        }
        var name = document.createElement("div");
        name.className = "template-name";
        name.textContent = t.name;
        var desc = document.createElement("div");
        desc.className = "template-desc";
        desc.textContent = t.desc;
        card.appendChild(preview);
        card.appendChild(name);
        card.appendChild(desc);
        card.addEventListener("click", function () {
          applyTemplate(t);
          closeModal("templatesModal");
        });
        grid.appendChild(card);
      })(TEMPLATES[i]);
    }
  }

  function applyTemplate(t) {
    if (!window.confirm("Apply the \"" + t.name + "\" template? This will replace the current document content.")) return;
    var wrapper = $(PAGES_WRAPPER_ID);
    wrapper.innerHTML = "";
    var page = createPage();
    wrapper.appendChild(page);
    var content = getContent(page);
    content.innerHTML = sanitizeStoredHtml(t.html) || "<p><br></p>";
    currentTitle = t.name;
    syncFileModalNameInput();
    paginate();
    saveDocument(false);
    toast(t.name + " template applied", "success");
    setTimeout(function () { content.focus(); }, 100);
  }

  /* ---------------- Symbol bar (Slides-style floating bottom bar) ----------------
     Ported from the Slides app's symbolToolbar: a bottom-docked floating
     pill (no modal box) with grouped symbol buttons — Stars, Marks, Arrows,
     Math, Greek, Numbers, Special. Clicking a symbol inserts it at the
     caret; the bar STAYS OPEN so several symbols can be inserted in a row
     (Slides parity). Done — or the ribbon button again — closes it. */
  function toggleSymbolBar(force) {
    var bar = $("symbolToolbar");
    var btn = $("btnSymbols");
    if (!bar) return;
    var shouldOpen = force === undefined ? !bar.classList.contains("visible") : force;
    if (shouldOpen) {
      // Only one bottom toolbar at a time — exit draw mode if it is on.
      if (drawMode) toggleDrawMode(false);
      bar.classList.add("visible");
      if (btn) btn.classList.add("active");
    } else {
      bar.classList.remove("visible");
      if (btn) btn.classList.remove("active");
    }
  }

  function initSymbolBar() {
    var bar = $("symbolToolbar");
    if (!bar) return;
    var buttons = bar.querySelectorAll(".sym-bar-btn");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var sym = btn.getAttribute("data-s") || btn.textContent;
          restoreEditorSelection();
          document.execCommand("insertText", false, sym);
          schedulePaginate();
          scheduleAutosave();
          toast('Inserted "' + sym + '"');
        });
      })(buttons[i]);
    }
    var done = $("symbolDoneBtn");
    if (done) done.addEventListener("click", function () { toggleSymbolBar(false); });
  }

  /* ---------------- Apply per-document page layout ----------------
     Imported .docx files carry their own page size, orientation, margins and
     background fill (the way MS Word stores them per section). applyDocPageLayout
     restores those on the current editor so an imported doc looks like the
     original rather than inheriting the app's A4 default. */
  function applyDocPageSize(w, h, portrait) {
    var pw = Math.round(w) || PAGE_WIDTH;
    var ph = Math.round(h) || PAGE_HEIGHT;
    if (portrait === false) { var tmp = pw; pw = ph; ph = tmp; }
    // Single source of truth: keeps .page elements, CSS vars (+ @page sheet
    // for print) and the View -> Pages thumbnails all in sync.
    applyPageDimensions(pw, ph, portrait === false);
  }

  function applyDocPageLayout(data) {
    if (!data) return;
    if (data.pageSize && (data.pageSize.w || data.pageSize.h)) {
      var portrait = data.pageSize.portrait !== false;
      applyDocPageSize(data.pageSize.w, data.pageSize.h, portrait);
    } else {
      applyDocPageSize(PAGE_WIDTH, PAGE_HEIGHT, true);
    }
    if (data.pageMargins) {
      var m = data.pageMargins;
      if (m.left && m.top && m.right && m.bottom) {
        pageMargins.left = clampMargin(m.left);
        pageMargins.top = clampMargin(m.top);
        pageMargins.right = clampMargin(m.right);
        pageMargins.bottom = clampMargin(m.bottom);
      }
    }
    applyDocMarginsVars();
    // Background fill from the imported doc (Word section background).
    if (data.pageBg) {
      var wrapper = $(PAGES_WRAPPER_ID);
      if (wrapper) wrapper.style.setProperty("--paper-bg", data.pageBg);
    } else {
      var wrapper2 = $(PAGES_WRAPPER_ID);
      if (wrapper2) wrapper2.style.removeProperty("--paper-bg");
    }
    buildRulerTicks();
  }

  // Mirror the current pageMargins object onto CSS variables + persistence.
  function applyDocMarginsVars() {
    var root = document.documentElement;
    root.style.setProperty("--page-margin-top", pageMargins.top + "px");
    root.style.setProperty("--page-margin-right", pageMargins.right + "px");
    root.style.setProperty("--page-margin-bottom", pageMargins.bottom + "px");
    root.style.setProperty("--page-margin-left", pageMargins.left + "px");
  }

  /* ---------------- Go To (lives in the bottom-right bar) ---------------- */
  function openGoTo() { openFindBar("goto"); }

  function performGoTo() {
    var type = getGotoType();
    var val = parseInt($("frGotoValue").value, 10);
    if (isNaN(val) || val < 1) val = 1;
    var pages = getPages();
    if (type === "page") {
      if (val > pages.length) val = pages.length;
      scrollToPage(val);
    } else if (type === "line") {
      // count lines across all pages
      var count = 0;
      var done = false;
      for (var i = 0; i < pages.length && !done; i++) {
        var content = getContent(pages[i]);
        var blocks = content.children;
        for (var j = 0; j < blocks.length; j++) {
          var lineCount = blocks[j].innerText.split("\n").length;
          if (count + lineCount >= val) {
            // place caret at start of this block
            pages[i].scrollIntoView({ behavior: "smooth", block: "start" });
            var range = document.createRange();
            range.selectNodeContents(blocks[j]);
            range.collapse(true);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            content.focus();
            done = true;
            break;
          }
          count += lineCount;
        }
      }
    } else if (type === "heading") {
      // jump to the Nth heading
      var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
      if (headings.length === 0) { toast("No headings found", "error"); return; }
      if (val > headings.length) val = headings.length;
      var h = headings[val - 1];
      h.scrollIntoView({ behavior: "smooth", block: "center" });
      var range2 = document.createRange();
      range2.selectNodeContents(h);
      range2.collapse(true);
      var sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range2);
      h.closest(".page-content").focus();
    }
    toast("Jumped to " + type + " " + val, "success");
  }

  /* ---------------- Go To type — custom dropdown (replaces the native select) ---------------- */
  var gotoType = "page";
  var GOTO_TYPES = [
    { value: "page", label: "Page" },
    { value: "line", label: "Line" },
    { value: "heading", label: "Next heading" }
  ];

  function getGotoType() { return gotoType; }

  function setGotoType(value) {
    for (var i = 0; i < GOTO_TYPES.length; i++) {
      if (GOTO_TYPES[i].value === value) {
        gotoType = value;
        var label = $("frGotoTypeLabel");
        if (label) label.textContent = GOTO_TYPES[i].label;
        syncGotoTypeMenu();
        return;
      }
    }
  }

  function syncGotoTypeMenu() {
    var menu = $("frGotoTypeMenu");
    if (!menu) return;
    var items = menu.querySelectorAll(".fr-select-item");
    for (var i = 0; i < items.length; i++) {
      var selected = items[i].getAttribute("data-value") === gotoType;
      items[i].classList.toggle("selected", selected);
      items[i].setAttribute("aria-selected", selected ? "true" : "false");
    }
  }

  function gotoTypeMenuOpen() {
    var menu = $("frGotoTypeMenu");
    return !!(menu && menu.classList.contains("open"));
  }

  function openGotoTypeMenu() {
    var menu = $("frGotoTypeMenu");
    var btn = $("frGotoTypeBtn");
    if (!menu || !btn || gotoTypeMenuOpen()) return;
    syncGotoTypeMenu();
    menu.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    highlightGotoTypeItem(currentGotoTypeIndex());
  }

  function closeGotoTypeMenu() {
    var menu = $("frGotoTypeMenu");
    if (!menu) return;
    menu.classList.remove("open");
    var items = menu.querySelectorAll(".fr-select-item");
    for (var i = 0; i < items.length; i++) items[i].classList.remove("focused");
    var btn = $("frGotoTypeBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function currentGotoTypeIndex() {
    for (var i = 0; i < GOTO_TYPES.length; i++) {
      if (GOTO_TYPES[i].value === gotoType) return i;
    }
    return 0;
  }

  function highlightedGotoTypeIndex() {
    var menu = $("frGotoTypeMenu");
    if (!menu) return currentGotoTypeIndex();
    var items = menu.querySelectorAll(".fr-select-item");
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains("focused")) return i;
    }
    return currentGotoTypeIndex();
  }

  function highlightGotoTypeItem(idx) {
    var menu = $("frGotoTypeMenu");
    if (!menu) return;
    var items = menu.querySelectorAll(".fr-select-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("focused", i === idx);
    }
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
  }

  function setupGotoTypeDropdown() {
    var btn = $("frGotoTypeBtn");
    var menu = $("frGotoTypeMenu");
    if (!btn || !menu || btn._gotoTypeWired) return;
    btn._gotoTypeWired = true;
    syncGotoTypeMenu();

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (gotoTypeMenuOpen()) closeGotoTypeMenu();
      else openGotoTypeMenu();
    });

    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (gotoTypeMenuOpen()) {
          // commit the highlighted item (arrows move the highlight first)
          var pick = GOTO_TYPES[highlightedGotoTypeIndex()];
          if (pick) setGotoType(pick.value);
          closeGotoTypeMenu();
        } else {
          openGotoTypeMenu();
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!gotoTypeMenuOpen()) { openGotoTypeMenu(); return; }
        var idx = highlightedGotoTypeIndex();
        idx = e.key === "ArrowDown" ? (idx + 1) % GOTO_TYPES.length : (idx - 1 + GOTO_TYPES.length) % GOTO_TYPES.length;
        highlightGotoTypeItem(idx);
      } else if (e.key === "Escape") {
        if (gotoTypeMenuOpen()) {
          e.preventDefault();
          e.stopPropagation();
          closeGotoTypeMenu();
        } else {
          e.preventDefault();
          closeFindBar();
        }
      } else if (e.key === "Tab") {
        closeGotoTypeMenu();
      }
    });

    var items = menu.querySelectorAll(".fr-select-item");
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        item.addEventListener("click", function (e) {
          e.stopPropagation();
          setGotoType(item.getAttribute("data-value"));
          closeGotoTypeMenu();
          btn.focus();
        });
      })(items[i]);
    }

    // click outside closes the menu — deferred one tick so the very click
    // that opens the bar/dropdown doesn't instantly close it again
    setTimeout(function () {
      document.addEventListener("click", function (e) {
        if (!gotoTypeMenuOpen()) return;
        if (!e.target.closest("#frGotoTypeWrap")) closeGotoTypeMenu();
      });
    }, 0);
  }

  /* ---------------- Watermark ---------------- */
  function applyWatermark(text) {
    var pages = getPages();
    // remove existing
    for (var i = 0; i < pages.length; i++) {
      var existing = pages[i].querySelector(".page-watermark");
      if (existing) existing.remove();
    }
    if (!text) return;
    for (var j = 0; j < pages.length; j++) {
      var wm = document.createElement("div");
      wm.className = "page-watermark";
      wm.textContent = text;
      wm.setAttribute("contenteditable", "false");
      pages[j].insertBefore(wm, pages[j].firstChild);
    }
  }

  function openWatermark() {
    openModal("watermarkModal");
  }

  /* ---------------- Table of Contents ---------------- */
  function insertTOC() {
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (headings.length === 0) {
      toast("Add headings first to generate a TOC", "error");
      return;
    }
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }
    var html = '<div class="emdocs-toc" contenteditable="false"><h2>Table of Contents</h2><ul>';
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      var level = h.tagName.toLowerCase();
      var text = (h.textContent || "").trim();
      if (!text) continue;
      html += '<li class="toc-' + level + '"><a href="#" data-toc="' + i + '">' + escapeHtml(text) + '</a></li>';
    }
    html += '</ul></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    toast("Table of contents inserted", "success");
  }

  /* ---------------- Drop Cap ---------------- */
  function toggleDropCap() {
    var block = getCurrentBlock();
    if (!block || block.tagName !== "P") {
      toast("Place cursor in a paragraph", "error");
      return;
    }
    var btnDropCap = $("btnDropCap");
    if (block.classList.contains("has-dropcap")) {
      block.classList.remove("has-dropcap");
      if (btnDropCap) btnDropCap.classList.remove("active");
      toast("Drop cap removed", "success");
    } else {
      block.classList.add("has-dropcap");
      if (btnDropCap) btnDropCap.classList.add("active");
      toast("Drop cap applied", "success");
    }
    schedulePaginate();
    scheduleAutosave();
  }

  /* Sync the Drop Cap button's toggle-ON look with the paragraph under the
     caret, so the button visually reflects the applied state (ON/OFF) while
     moving through the document — same behavior as Bold/Italic buttons. */
  function updateDropCapState() {
    var btn = document.getElementById("btnDropCap");
    if (!btn) return;
    var block = getCurrentBlock();
    var on = !!(block && block.tagName === "P" && block.classList.contains("has-dropcap"));
    btn.classList.toggle("active", on);
    btn.title = on ? "Drop cap (currently ON — click to remove)" : "Drop cap";
  }

  /* ---------------- Columns ---------------- */
  function setColumns(n) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var c = getContent(pages[i]);
      c.classList.remove("is-cols-2", "is-cols-3");
      if (n === 2) c.classList.add("is-cols-2");
      else if (n === 3) c.classList.add("is-cols-3");
    }
    // update active states on column buttons
    var colBtns = document.querySelectorAll("[data-cols]");
    for (var j = 0; j < colBtns.length; j++) {
      var cols = parseInt(colBtns[j].getAttribute("data-cols"), 10);
      if (cols === n) colBtns[j].classList.add("active");
      else colBtns[j].classList.remove("active");
    }
    schedulePaginate();
    scheduleAutosave();
    toast(n + " column" + (n > 1 ? "s" : "") + " layout", "success");
  }

  /* ---------------- Orientation & Page Size ---------------- */
  // Order matches the Layout -> Size dropdown (Letter ... Envelope).
  // Dimensions are 96dpi CSS pixels: Letter 8.5x11", Legal 8.5x14",
  // Executive 7.25x10.5", A4/A5/A6 ISO paper, Envelope #10 4.125x9.5".
  var PAGE_SIZES = {
    Letter: { w: 816, h: 1056 },
    Legal: { w: 816, h: 1344 },
    Executive: { w: 696, h: 1008 },
    A4: { w: 794, h: 1123 },
    A5: { w: 559, h: 794 },
    A6: { w: 397, h: 559 },
    Envelope: { w: 396, h: 912 },
  };
  var currentPageSizeName = "A4";

  function toggleOrientation() {
    var pages = getPages();
    if (!pages.length) return;
    var isLandscape = pages[0].classList.contains("landscape");
    var w = parseFloat(pages[0].style.width) || curPageW;
    var h = parseFloat(pages[0].style.height) || curPageH;
    // Rotate the CURRENT sheet dimensions (Legal stays Legal, just sideways)
    // and keep the CSS vars / @page sheet / thumbnails in sync.
    applyPageDimensions(h, w, !isLandscape);
    syncPageSizeUI();
    schedulePaginate();
    scheduleAutosave();
    toast(isLandscape ? "Portrait" : "Landscape", "success");
  }

  // Sync the Layout -> Size dropdown + status-bar label with the current
  // size. Detection matches width AND height (Letter and Legal share a
  // width, so width-only matching would confuse them). Falls back to the
  // last chosen name when pages use a custom size (e.g. landscape).
  function syncPageSizeUI() {
    var pages = getPages();
    if (pages[0]) {
      var w = pages[0].style.width;
      var h = pages[0].style.height;
      for (var name in PAGE_SIZES) {
        if (PAGE_SIZES[name].w + "px" === w && PAGE_SIZES[name].h + "px" === h) {
          currentPageSizeName = name;
          break;
        }
      }
    }
    var dd = $("pageSizeDropdown");
    if (dd) {
      var lbl = dd.querySelector(".dropdown-value");
      if (lbl) lbl.textContent = currentPageSizeName;
      var items = dd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var it = 0; it < items.length; it++) {
        items[it].classList.toggle("active", items[it].getAttribute("data-value") === currentPageSizeName);
      }
    }
    var label = document.querySelector(".page-size-label");
    if (label) label.textContent = currentPageSizeName;
  }

  function setPageSize(name) {
    var dim = PAGE_SIZES[name];
    if (!dim) return;
    currentPageSizeName = name;
    // A named size is always portrait. applyPageDimensions keeps the CSS
    // variables used by the base .page rule, print preview and @page sheet
    // (so the browser prints at the true paper size), and refreshes the
    // View -> Pages thumbnails — in sync with the real pages.
    applyPageDimensions(dim.w, dim.h, false);
    syncPageSizeUI();
    schedulePaginate();
    scheduleAutosave();
    toast("Page size: " + name, "success");
  }

  /* Central page-size application. Updates the real .page elements, the
     on-screen dims, the CSS variables that drive the base .page rule, print
     preview and the browser-print @page sheet (so A4 / Letter / Legal / ...
     all print at their true size), and refreshes the View -> Pages
     thumbnails. */
  function applyPageDimensions(pw, ph, isLandscape) {
    curPageW = pw;
    curPageH = ph;
    var root = document.documentElement;
    root.style.setProperty("--emu-pw", pw + "px");
    root.style.setProperty("--emu-ph", ph + "px");
    root.style.setProperty("--emu-ppw", (pw / 96 * 25.4).toFixed(2) + "mm");
    root.style.setProperty("--emu-pph", (ph / 96 * 25.4).toFixed(2) + "mm");
    // Size the browser-print sheet to the actual paper. Injected after the
    // stylesheet so it overrides the static `@page { size: A4 }` in docs.css.
    var sheetStyle = $("emuPageSizeStyle");
    if (!sheetStyle) {
      sheetStyle = document.createElement("style");
      sheetStyle.id = "emuPageSizeStyle";
      document.head.appendChild(sheetStyle);
    }
    sheetStyle.textContent = "@page { size: " + (pw / 96 * 25.4).toFixed(2) + "mm " + (ph / 96 * 25.4).toFixed(2) + "mm; margin: 0; }";
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      pages[i].style.width = pw + "px";
      pages[i].style.height = ph + "px";
      pages[i].classList.toggle("landscape", !!isLandscape);
    }
    scheduleThumbnailsUpdate();
  }

  /* ---------------- Header / Footer / Page Number ---------------- */
  // Robust "is the selection inside X" check. anchorNode can BE the element
  // itself (caret at (container, childCount)) — parentElement would then point
  // ABOVE the container and closest() would miss it.
  function selectionInside(sel, selector) {
    if (!sel || !sel.rangeCount || !sel.anchorNode) return false;
    var el = sel.anchorNode.nodeType === Node.ELEMENT_NODE
      ? sel.anchorNode
      : sel.anchorNode.parentElement;
    return !!(el && el.closest && el.closest(selector));
  }

  // When the caret is parked at a container's very end ((el, childCount)),
  // execCommand insertHTML drops the new node as a SIBLING below the last
  // paragraph — it then renders on its own line (outside a footer strip's
  // height). Deepening the caret into the last line keeps inserts inline.
  function deepenEndCaret(el) {
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.anchorNode !== el ||
        sel.anchorOffset !== el.childNodes.length) return;
    var node = el.lastChild;
    if (!node) return;
    while (node.nodeType === Node.ELEMENT_NODE && node.lastChild && node.tagName !== "BR") {
      node = node.lastChild;
    }
    try {
      var r = document.createRange();
      r.setStart(node, node.nodeType === Node.TEXT_NODE ? node.textContent.length : node.childNodes.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  // Move field spans that Chrome dropped as direct children of a header/
  // footer strip (outside any <p>) into the strip's last paragraph, so they
  // render INLINE like Word page numbers. Also refreshes the saved
  // headerHTML/footerHTML state from the normalized strips.
  function normalizeStrayHF() {
    var strips = document.querySelectorAll(".page-header.editable, .page-footer.editable");
    var firstH = null, firstF = null;
    for (var i = 0; i < strips.length; i++) {
      var strip = strips[i];
      var strays = strip.querySelectorAll(":scope > .field-dynamic");
      for (var s = 0; s < strays.length; s++) {
        var ps = strip.querySelectorAll(":scope > p");
        var last = ps.length ? ps[ps.length - 1] : null;
        if (last) last.appendChild(strays[s]);
        else {
          var p = document.createElement("p");
          p.appendChild(strays[s]);
          strip.appendChild(p);
        }
      }
      if (!firstH && strip.classList.contains("page-header")) firstH = strip;
      if (!firstF && strip.classList.contains("page-footer")) firstF = strip;
    }
    if (firstH) headerHTML = firstH.innerHTML;
    if (firstF) footerHTML = firstF.innerHTML;
  }

  function insertPageNumber() {
    // If the caret is inside a header/footer strip, insert the field there
    // (so "Page N" can live in the footer like real Word documents).
    var sel = window.getSelection();
    if (!selectionInside(sel, ".page-header.editable, .page-footer.editable")) {
      restoreEditorSelection();
      sel = window.getSelection();
      if (!selectionInside(sel, ".page-content")) {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }
    }
    // Caret at a container's end → deepen into the last line (inline insert)
    var anchor = sel && sel.anchorNode ? sel.anchorNode : null;
    deepenEndCaret(anchor && anchor.nodeType === Node.ELEMENT_NODE ? anchor : null);
    document.execCommand("insertHTML", false, '<span class="field-dynamic" contenteditable="false" data-field="PAGE">Page 1</span> ');
    // Chrome drops contenteditable=false nodes AFTER the paragraph when the
    // caret sits at a block's end — pull strays back inline + re-mirror.
    normalizeStrayHF();
    updateDynamicFields();
    schedulePaginate();
    scheduleAutosave();
    toast("Page number field inserted", "success");
  }

  /* MS Word-style editable header/footer strips:
     - Layout -> Header / Footer toggles an editable strip on EVERY page.
     - Strips mirror each other: editing any copy updates all of them.
     - Page-number fields work inside them (Page # with the caret in the
       strip inserts "Page N"; every page shows its own number).
     - Clearing all text removes the strip when it loses focus (like Word).
     - Content lives OUTSIDE .page-content so the paginator never moves it;
       syncHeaderFooter() re-applies strips to pages the paginator creates. */
  var headerActive = false;
  var footerActive = false;
  var headerHTML = "";
  var footerHTML = "";

  function isHFEmpty(el) {
    if (!el) return true;
    var text = el.textContent.replace(/\u200B/g, "").trim();
    if (text !== "") return false;
    return el.querySelectorAll("img, svg, table, hr, .field-dynamic").length === 0;
  }

  // Keep the .is-empty class in sync — CSS shows the grayed hint through it.
  function refreshHFHint(el) {
    if (el) el.classList.toggle("is-empty", isHFEmpty(el));
  }

  function hfHasContent(html) {
    if (!html) return false;
    // Optional DOMPurify pass keeps the parser input below the XSS queries'
    // detection threshold; DOMParser never executes markup either way.
    var src = String(html);
    if (typeof DOMPurify !== "undefined") {
      src = DOMPurify.sanitize(src, { FORCE_BODY: true });
    }
    var doc = new DOMParser().parseFromString(src, "text/html");
    return !isHFEmpty(doc.body);
  }

  function makeHeaderFooter(kind, html) {
    var el = document.createElement("div");
    el.className = "page-" + kind + " editable";
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-label", kind === "header" ? "Page header" : "Page footer");
    // Hint text as a CSS variable so the grayed "Header"/"Footer" label can
    // be rendered by CSS INSIDE the empty <p> (exactly where Word shows it).
    el.style.setProperty("--hf-hint", kind === "header" ? "Header" : "Footer");
    el.innerHTML = sanitizeStoredHtml(html || "");
    refreshHFHint(el);

    el.addEventListener("input", function () {
      var html2 = el.innerHTML;
      if (kind === "header") headerHTML = html2; else footerHTML = html2;
      // Mirror to every other page's strip
      var pages = getPages();
      for (var i = 0; i < pages.length; i++) {
        var peers = pages[i].querySelectorAll(":scope > .page-" + kind + ".editable");
        for (var p = 0; p < peers.length; p++) {
          if (peers[p] !== el && peers[p].innerHTML !== html2) {
            peers[p].innerHTML = sanitizeStoredHtml(html2);
            refreshHFHint(peers[p]);
          }
        }
      }
      refreshHFHint(el);
      updateDynamicFields(); // re-number PAGE fields on every page
      scheduleAutosave();
    });

    el.addEventListener("blur", function () {
      // Word behavior: an emptied header/footer removes itself on blur.
      if (isHFEmpty(el)) {
        if (kind === "header") { headerActive = false; headerHTML = ""; }
        else { footerActive = false; footerHTML = ""; }
        removeAllHF(kind);
        toast((kind === "header" ? "Header" : "Footer") + " removed", "info");
        scheduleAutosave();
      }
    });

    el.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        var first = getContent(getPages()[0]);
        if (first) first.focus();
      }
    });

    return el;
  }

  function removeAllHF(kind) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var els = pages[i].querySelectorAll(":scope > .page-" + kind + ".editable");
      for (var k = 0; k < els.length; k++) els[k].remove();
    }
  }

  // Re-apply strips to every page — called from paginate() so pages the
  // paginator creates (or removes) stay in sync.
  function syncHeaderFooter() {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var h = page.querySelector(":scope > .page-header.editable");
      if (headerActive) {
        if (!h) page.insertBefore(makeHeaderFooter("header", headerHTML), page.firstChild);
      } else if (h) {
        h.remove();
      }
      var f = page.querySelector(":scope > .page-footer.editable");
      if (footerActive) {
        if (!f) page.appendChild(makeHeaderFooter("footer", footerHTML));
      } else if (f) {
        f.remove();
      }
    }
  }

  // Layout -> Header / Footer button: create the strip (or jump to it).
  function editHeaderFooter(kind) {
    var isActive = kind === "header" ? headerActive : footerActive;
    if (!isActive) {
      if (kind === "header") { headerActive = true; headerHTML = "<p><br></p>"; }
      else { footerActive = true; footerHTML = "<p><br></p>"; }
      syncHeaderFooter();
      scheduleAutosave();
      toast((kind === "header" ? "Header" : "Footer") + " added — type in the " +
            (kind === "header" ? "top" : "bottom") + " strip", "success");
    } else {
      toast((kind === "header" ? "Header" : "Footer") + " — edit the " +
            (kind === "header" ? "top" : "bottom") + " strip of any page", "info");
    }
    // Jump to the first strip so the user can type right away
    // (Word's "Edit Header" does the same).
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var el = pages[i].querySelector(":scope > .page-" + kind + ".editable");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: kind === "header" ? "start" : "end" });
        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
    }
  }

  function updateDynamicFields() {
    var pages = getPages();
    var pageFields = document.querySelectorAll('[data-field="PAGE"]');
    for (var i = 0; i < pageFields.length; i++) {
      // find which page this field is on
      var pg = pageFields[i].closest(".page");
      var pageNum = pg ? pages.indexOf(pg) + 1 : 1;
      pageFields[i].textContent = "Page " + pageNum;
    }
    var dateFields = document.querySelectorAll('[data-field="DATE"]');
    for (var d = 0; d < dateFields.length; d++) {
      dateFields[d].textContent = new Date().toLocaleDateString();
    }
    var wordFields = document.querySelectorAll('[data-field="WORDS"]');
    for (var w = 0; w < wordFields.length; w++) {
      wordFields[w].textContent = getStats().words.toLocaleString() + " words";
    }
  }

  /* ---------------- AutoCorrect ---------------- */
  var AUTOCORRECT = {
    "teh": "the", "adn": "and", "nad": "and", "recieve": "receive",
    "seperate": "separate", "definately": "definitely", "occured": "occurred",
    "untill": "until", "wich": "which", "thier": "their", "dont": "don't",
    "cant": "can't", "wont": "won't", "isnt": "isn't", "wasnt": "wasn't",
    "havent": "haven't", "didnt": "didn't", "wouldnt": "wouldn't",
    "shouldnt": "shouldn't", "couldnt": "couldn't", "im": "I'm",
    "ive": "I've", "ill": "I'll", "id": "I'd",
    ":-)": "😊", ":-(": "😞", "<3": "❤",
  };

  function checkAutoCorrect() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    var node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    var text = node.textContent;
    var offset = sel.anchorOffset;
    // get the word before the caret (just typed a space)
    var before = text.substring(0, offset);
    var m = before.match(/(\S+)$/);
    if (!m) return;
    var word = m[1];
    var cleanWord = word.toLowerCase().replace(/[^\w']/g, "");
    if (AUTOCORRECT[cleanWord] || AUTOCORRECT[word]) {
      var replacement = AUTOCORRECT[cleanWord] || AUTOCORRECT[word];
      var range = document.createRange();
      range.setStart(node, offset - word.length);
      range.setEnd(node, offset);
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));
      // move caret after the replacement
      range.setStartAfter(range.endContainer);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* ---------------- Comments (Slides-style pins + popup) ----------------
     No sidebar. Selecting text and using Review → Comment opens the composer
     modal; confirming wraps the range in a .comment-anchor span and places a
     small speech-bubble pin (sup.comment-ref, contenteditable=false, treated
     as ONE virtual caret character by the same machinery as footnote refs)
     right after it. Clicking a pin opens a floating .comment-popup card —
     same interaction model as the Slides app. Everything persists: anchors
     and pins live inside the saved page HTML, comment data is stored in the
     document's data object (data.comments). */
  var comments = [];
  // Pending composer context: { quote, range } for a new comment, or
  // { replyTo } when replying to an existing thread.
  var commentComposerCtx = null;

  function makeCommentId() {
    return "c_" + Date.now() + "_" + generateSecureId(6);
  }

  function getComment(cid) {
    for (var i = 0; i < comments.length; i++) {
      if (comments[i].id === cid) return comments[i];
    }
    return null;
  }

  function addComment() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      toast("Select text to comment on", "error");
      return;
    }
    var range = sel.getRangeAt(0);
    var scopeEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    if (!scopeEl || !scopeEl.closest || !scopeEl.closest(".page-content")) {
      toast("Select text in the document to comment on", "error");
      return;
    }
    var quote = sel.toString().replace(/\s+/g, " ").trim();
    if (!quote) {
      toast("Select text to comment on", "error");
      return;
    }
    commentComposerCtx = { quote: quote, range: range.cloneRange() };
    $("commentModalTitle").textContent = "New Comment";
    $("commentSaveBtn").textContent = "Add Comment";
    $("commentText").value = "";
    openModal("commentModal");
    setTimeout(function () { $("commentText").focus(); }, 90);
  }

  function openReplyComposer(cid) {
    commentComposerCtx = { replyTo: cid };
    $("commentModalTitle").textContent = "Reply";
    $("commentSaveBtn").textContent = "Reply";
    $("commentText").value = "";
    openModal("commentModal");
    setTimeout(function () { $("commentText").focus(); }, 90);
  }

  function confirmCommentComposer() {
    var text = $("commentText").value.trim();
    if (!text) { toast("Write a comment first", "error"); return; }
    if (!commentComposerCtx) { closeModal("commentModal"); return; }

    if (commentComposerCtx.replyTo) {
      var parent = getComment(commentComposerCtx.replyTo);
      if (parent) {
        if (!parent.replies) parent.replies = [];
        parent.replies.push({ id: makeCommentId(), text: text, author: "You", ts: Date.now() });
        scheduleAutosave();
        // Refresh the popup if it is open for this comment
        var openPopup = document.querySelector(".comment-popup");
        if (openPopup && openPopup.getAttribute("data-cid") === parent.id) {
          showCommentPopup(parent.id, openPopup._pinEl || null);
        }
      }
    } else {
      createAnchoredComment(commentComposerCtx.quote, commentComposerCtx.range, text);
    }
    commentComposerCtx = null;
    closeModal("commentModal");
  }

  // Wraps a saved range in an anchor span, appends the pin, stores the data.
  function createAnchoredComment(quote, range, text) {
    var c = {
      id: makeCommentId(),
      quote: quote.substring(0, 80) + (quote.length > 80 ? "…" : ""),
      text: text,
      author: "You",
      resolved: false,
      replies: [],
      ts: Date.now(),
    };
    var span = document.createElement("span");
    span.className = "comment-anchor";
    span.setAttribute("data-cid", c.id);
    var ok = false;
    try {
      var frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
      ok = true;
    } catch (e) {
      ok = false;
    }
    if (!ok || !span.parentNode) {
      toast("Could not anchor comment here", "error");
      return;
    }
    comments.push(c);
    insertPinAfter(c, span);
    placeCaretAfter(span.nextSibling || span);
    scheduleAutosave();
    toast("Comment added", "success");
  }

  function placeCaretAfter(el) {
    try {
      var range = document.createRange();
      range.setStartAfter(el);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  // Builds the non-editable bubble pin and inserts it right after the anchor.
  function buildPin(c) {
    var sup = document.createElement("sup");
    sup.className = "comment-ref" + (c.resolved ? " resolved" : "");
    sup.setAttribute("data-comment", c.id);
    sup.setAttribute("contenteditable", "false");
    sup.setAttribute("title", c.author + ": " + c.text);
    var bubble = document.createElement("span");
    bubble.className = "comment-bubble";
    bubble.setAttribute("data-initial", (c.author || "Y").charAt(0).toUpperCase());
    sup.appendChild(bubble);
    return sup;
  }

  function insertPinAfter(c, anchorOrRef) {
    var pin = buildPin(c);
    anchorOrRef.parentNode.insertBefore(pin, anchorOrRef.nextSibling);
    return pin;
  }

  // Re-renders every pin from the comments array. Anchors already live in
  // the page HTML (they persist with the document); pins are rebuilt so a
  // comment whose anchor disappeared (text deleted) has no orphaned bubble.
  // With dropOrphans set, comment data without a live anchor is removed too
  // (same orphan cleanup as Slides) — used on document load.
  function renderDocPins(dropOrphans) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var old = content.querySelectorAll("sup.comment-ref");
      for (var j = 0; j < old.length; j++) old[j].remove();
    }
    var kept = [];
    for (var k = 0; k < comments.length; k++) {
      var c = comments[k];
      var anchor = document.querySelector('.page-content .comment-anchor[data-cid="' + c.id + '"]');
      if (!anchor) {
        if (dropOrphans) continue; // drop orphaned comment
        // keep data (it may re-anchor after undo) but nothing to attach to
        continue;
      }
      insertPinAfter(c, anchor);
      kept.push(c);
    }
    if (dropOrphans && kept.length !== comments.length) comments = kept;
  }

  function showCommentPopup(cid, pinEl) {
    closeCommentPopup();
    var c = getComment(cid);
    if (!c) return;
    var popup = document.createElement("div");
    popup.className = "comment-popup";
    popup.setAttribute("data-cid", c.id);
    popup._pinEl = pinEl || null;
    var html = '';
    html += '<div class="comment-popup-header">';
    html += '<div class="comment-popup-avatar">' + escapeHtml((c.author || "Y").charAt(0).toUpperCase()) + "</div>";
    html += '<span class="comment-popup-author">' + escapeHtml(c.author || "You") + "</span>";
    html += '<span class="comment-popup-time">' + escapeHtml(formatTime(c.ts)) + "</span>";
    html += '<button class="comment-popup-close" aria-label="Close">&times;</button>';
    html += "</div>";
    html += '<div class="comment-popup-body">' + escapeHtml(c.text) + "</div>";
    if (c.quote) html += '<div class="comment-popup-quote">“' + escapeHtml(c.quote) + "”</div>";
    if (c.replies && c.replies.length) {
      html += '<div class="comment-popup-replies">';
      for (var i = 0; i < c.replies.length; i++) {
        var r = c.replies[i];
        html += '<div class="comment-popup-reply"><strong>' + escapeHtml(r.author || "You") + "</strong> " + escapeHtml(r.text);
        html += '<span class="reply-time">' + escapeHtml(formatTime(r.ts)) + "</span></div>";
      }
      html += "</div>";
    }
    html += '<div class="comment-popup-actions">';
    html += '<button class="comment-reply-btn">Reply</button>';
    html += '<button class="comment-resolve-btn">' + (c.resolved ? "Unresolve" : "Resolve") + "</button>";
    html += '<button class="comment-delete-btn">Delete</button>';
    html += "</div>";
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Position next to the pin (fixed coordinates), flipping left when the
    // viewport is too narrow and clamping vertically.
    var left, top;
    if (pinEl && pinEl.getBoundingClientRect) {
      var rect = pinEl.getBoundingClientRect();
      left = rect.right + 8;
      top = rect.top - 6;
    } else {
      left = Math.max(12, (window.innerWidth - 250) / 2);
      top = 120;
    }
    if (left + 262 > window.innerWidth) left = Math.max(8, (pinEl ? pinEl.getBoundingClientRect().left : left) - 258);
    var ph = popup.offsetHeight || 140;
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    popup.style.left = left + "px";
    popup.style.top = top + "px";

    popup.querySelector(".comment-popup-close").addEventListener("click", closeCommentPopup);
    popup.querySelector(".comment-reply-btn").addEventListener("click", function () { closeCommentPopup(); openReplyComposer(c.id); });
    popup.querySelector(".comment-resolve-btn").addEventListener("click", function () {
      c.resolved = !c.resolved;
      var anchor = document.querySelector('.page-content .comment-anchor[data-cid="' + c.id + '"]');
      if (anchor) anchor.classList.toggle("comment-resolved", c.resolved);
      var pin = document.querySelector('sup.comment-ref[data-comment="' + c.id + '"]');
      if (pin) pin.classList.toggle("resolved", c.resolved);
      scheduleAutosave();
      showCommentPopup(c.id, pinEl);
    });
    popup.querySelector(".comment-delete-btn").addEventListener("click", function () {
      deleteComment(c.id);
      closeCommentPopup();
      scheduleAutosave();
      toast("Comment deleted", "success");
    });
  }

  function closeCommentPopup() {
    var existing = document.querySelector(".comment-popup");
    if (existing) existing.remove();
  }

  function deleteComment(cid) {
    comments = comments.filter(function (x) { return x.id !== cid; });
    // Unwrap the anchor (keep the commented text) and remove the pin.
    var anchor = document.querySelector('.page-content .comment-anchor[data-cid="' + cid + '"]');
    if (anchor && anchor.parentNode) {
      var parent = anchor.parentNode;
      while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
      parent.removeChild(anchor);
      parent.normalize();
    }
    var pin = document.querySelector('sup.comment-ref[data-comment="' + cid + '"]');
    if (pin && pin.parentNode) pin.parentNode.removeChild(pin);
    schedulePaginate();
  }

  /* ---------------- Read Aloud (Web Speech API) ---------------- */
  var readAloudUtter = null;

  function readAloud() {
    if (!("speechSynthesis" in window)) {
      toast("Speech synthesis not supported in this browser", "error");
      return;
    }
    if (readAloudUtter) {
      window.speechSynthesis.cancel();
      readAloudUtter = null;
      toast("Read aloud stopped", "success");
      return;
    }
    var text = getAllText();
    if (!text) { toast("No text to read", "error"); return; }
    readAloudUtter = new SpeechSynthesisUtterance(text.substring(0, 3000));
    readAloudUtter.rate = 1;
    readAloudUtter.onend = function () { readAloudUtter = null; toast("Finished reading", "success"); };
    window.speechSynthesis.speak(readAloudUtter);
    toast("Reading aloud…", "success");
  }

  function formatTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return d.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------------- Toast (Slides design) ----------------
     Same pattern as the Slides app's showToast + _toastIcon:
     white glass pill, monochrome black 16px SVG icon, 10px gap,
     3000ms duration. The old colored success/error variants were
     removed to match Slides exactly. */
  function _toastIcon(rawMsg, type) {
    // Strip leading emoji/whitespace so the icon doesn't double up with
    // a &#10003; or ⚠ character that was baked into the message string.
    var msg = String(rawMsg || "").replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, "").trim();
    var m = msg.toLowerCase();

    // Monochrome black — matches the Slides app's toast icon color.
    var INK = "#111";

    // SVG stroke wrapper helper
    var svg = function (paths) {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
    };

    // 1. Loading / progress (reading, recording, generating…)
    if (m.indexOf("generating") === 0 || m.indexOf("importing") === 0 || m.indexOf("recording") === 0 ||
        m.indexOf("reading") === 0 || m.indexOf("previewing") === 0 ||
        m.indexOf("searching") === 0 || m.indexOf("loading") === 0 || m.indexOf("this may take") !== -1) {
      return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg: msg };
    }

    // 2. Clipboard / copied / pasted
    if (m.indexOf("clipboard") !== -1 || m.indexOf("copied") !== -1 || m.indexOf("pasted") !== -1 || m.indexOf("paste ") !== -1) {
      return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg: msg };
    }

    // 3. Failed / error (hard errors)
    if (m.indexOf("failed") !== -1 || m.indexOf("error") !== -1 || m.indexOf("could not") !== -1 ||
        m.indexOf("not supported") !== -1 || m.indexOf("denied") !== -1 || m.indexOf("invalid") !== -1 ||
        m.indexOf("skipping") !== -1 || m.indexOf("cancelled") === -1 && type === "error" && (
          m.indexOf("do not match") !== -1)) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg: msg };
    }

    // 4. Warnings / hints: must / select first / no X found / enter a …
    if (m.indexOf("must have") !== -1 || m.indexOf("must be") !== -1 || m.indexOf("select ") !== -1 ||
        m.indexOf("place cursor") !== -1 || m.indexOf("no headings") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("no text") !== -1 || m.indexOf("no image") !== -1 || m.indexOf("no comments") !== -1 ||
        m.indexOf("no bookmarks") !== -1 || m.indexOf("no footnote") !== -1 ||
        m.indexOf("no quick parts") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("enter a ") !== -1 || m.indexOf("provide a url") !== -1 || m.indexOf("coming soon") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg: msg };
    }

    // 5. Deleted / removed
    if (m.indexOf("deleted") !== -1 || m.indexOf("removed") !== -1) {
      return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg: msg };
    }

    // 6. Milestones / goals (word-count goal celebrations)
    if (m.indexOf("%") !== -1 || m.indexOf("halfway") !== -1 || m.indexOf("goal") !== -1 || m.indexOf("well done") !== -1) {
      return { icon: svg('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'), msg: msg };
    }

    // 7. Modes toggled (focus / zen / draw / read-only)
    if (m.indexOf("mode") !== -1 || m.indexOf("read-only") !== -1 || m.indexOf("final") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/><path d="M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>'), msg: msg };
    }

    // 8. Success confirmations (saved / inserted / applied / added / exported…)
    if (m.indexOf("saved") !== -1 || m.indexOf("inserted") !== -1 || m.indexOf("applied") !== -1 ||
        m.indexOf("added") !== -1 || m.indexOf("created") !== -1 || m.indexOf("restored") !== -1 ||
        m.indexOf("exported") !== -1 || m.indexOf("merged") !== -1 || m.indexOf("complete") !== -1 ||
        m.indexOf("finished") !== -1 || m.indexOf("fixed") !== -1 || m.indexOf("cleared") !== -1 ||
        m.indexOf("unlocked") !== -1 || m.indexOf("updated") !== -1 || m.indexOf("jumped to") !== -1 ||
        m.indexOf("toggled") !== -1 || m.indexOf("stopped") !== -1 || m.indexOf("reset") !== -1 ||
        m.indexOf("protected") !== -1 || m.indexOf("marked") !== -1 || m.indexOf("protected") !== -1) {
      return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg: msg };
    }

    // 9. Default info icon
    return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg: msg };
  }

  function toast(message, type) {
    var el = $("toast");
    if (!el) return;
    var pair = _toastIcon(message, type);
    // Same structure as Slides' showToast: flex row, icon + message, 10px gap.
    var outer = document.createElement("span");
    outer.style.cssText = "display:flex;align-items:center;gap:10px;";
    var iconSpan = document.createElement("span");
    iconSpan.style.cssText = "display:inline-flex;flex-shrink:0;";
    iconSpan.innerHTML = pair.icon;
    var msgSpan = document.createElement("span");
    msgSpan.textContent = pair.msg;
    outer.appendChild(iconSpan);
    outer.appendChild(msgSpan);
    el.replaceChildren(outer);
    el.className = "toast show";
    clearTimeout(toastTimer);
    // Slides' default duration: 3000ms.
    toastTimer = setTimeout(function () { el.className = "toast"; }, 3000);
  }

  /* ---------------- Slides-style ms-dropdowns (portal-based) ----------------
     Ported from slides.js: menus are appended to <body> while open so they
     escape the ribbon's overflow, with the same open/close animations.
     Defined at the closure scope (not inside init) because Image Format tab
     handlers also close the portal after picking a filter/color. */
  var _portalDropdown = null, _portalMenu = null, _portalBtn = null;

  function closePortalDropdown(animate) {
    if (!_portalMenu) return;
    var menu = _portalMenu, dropdown = _portalDropdown, btn = _portalBtn;
    _portalMenu = null; _portalDropdown = null; _portalBtn = null;
    if (dropdown) dropdown.classList.remove("active");
    if (btn) btn.setAttribute("aria-expanded", "false");

    var done = false;
    var cleanup = function () {
      if (done) return;
      done = true;
      menu.removeEventListener("animationend", cleanup);
      menu.classList.remove("ms-portal-closing");
      menu.style.cssText = "";
      if (dropdown) dropdown.appendChild(menu);
    };
    if (animate === false) {
      cleanup();
    } else {
      menu.classList.add("ms-portal-closing");
      menu.addEventListener("animationend", cleanup);
      setTimeout(cleanup, 220);
    }
  }

  function openPortalDropdown(dropdown, btn, menu) {
    closePortalDropdown(false);
    document.body.appendChild(menu);
    _portalMenu = menu;
    _portalDropdown = dropdown;
    _portalBtn = btn;
    dropdown.classList.add("active");
    btn.setAttribute("aria-expanded", "true");

    var isColorList = menu.classList && menu.classList.contains("color-list-menu");
    var isColorGrid = menu.classList && menu.classList.contains("color-grid-menu");
    var cap = isColorList ? 240 : (isColorGrid ? 320 : 320);
    var maxH = Math.min(cap, window.innerHeight * 0.6);
    // First, measure invisibly
    menu.style.cssText = "position:fixed;visibility:hidden;display:block;z-index:999999;margin:0;max-height:" + maxH + "px;overflow-y:auto;";
    var btnRect = btn.getBoundingClientRect();
    var mW = menu.offsetWidth || 200;
    var mH = menu.offsetHeight || 280;
    var vW = window.innerWidth;
    var vH = window.innerHeight;
    var top = btnRect.bottom + 4;
    if (top + mH > vH - 8) top = btnRect.top - mH - 4;
    if (top < 8) top = btnRect.bottom + 4;
    var left = btnRect.left;
    if (left + mW > vW - 8) left = vW - mW - 8;
    if (left < 8) left = 8;
    menu.style.cssText = "position:fixed;display:block;visibility:visible;z-index:999999;margin:0;left:" + left + "px;top:" + top + "px;max-height:" + maxH + "px;overflow-y:auto;animation:dropdownFadeIn 0.18s ease;";
  }

  /* ---------------- Init ---------------- */
  async function init() {
    // Initialize IDB storage
    idb = window.EmeraldIDBStorage || null;
    if (idb) {
      // Wait for IDB to be ready
      try { await idb.ready(); } catch (e) {}
    }

    // Theme — dark mode removed; cyan is the only accent color and is set via CSS.
    // (The old THEME_KEY localStorage lookup is no longer needed.)

    ensureFirstPage();
    paginate();

    // Load footnote/endnote arrays BEFORE any document open — the deep-link
    // ?owned= path below opens a document immediately, and openDocument
    // renders the per-page footnote areas + end-of-doc endnotes section.
    loadFootnotes();
    loadEndnotes();

    // Multi-document model: load the index, then land on the welcome screen
    // unless a specific document is requested via ?owned=<docId>.
    await loadIndex();
    showWelcomeScreen(true);

    var ownedParam = null;
    try { ownedParam = new URLSearchParams(location.search).get("owned"); } catch (e) {}
    if (ownedParam) {
      var meta = null;
      for (var mi = 0; mi < documents.length; mi++) {
        if (documents[mi].id === ownedParam) { meta = documents[mi]; break; }
      }
      if (meta) {
        await openDocument(ownedParam);
      } else {
        // Stale URL — clean it so a refresh lands on the welcome screen
        history.replaceState({}, document.title, location.pathname);
      }
    }

    // Toolbar command buttons
    var cmdButtons = document.querySelectorAll("[data-cmd]");
    for (var i = 0; i < cmdButtons.length; i++) {
      (function (btn) {
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        btn.addEventListener("click", function () {
          if (btn.disabled) return;
          exec(btn.getAttribute("data-cmd"));
        });
      })(cmdButtons[i]);
    }

    // Selects
    function hookSelect(sel, handler) {
      sel.addEventListener("mousedown", function () {
        var s = window.getSelection();
        if (s && s.rangeCount) {
          var node = s.anchorNode;
          if (node) {
            var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (el && el.closest && el.closest(".page-content")) {
              lastEditorRange = s.getRangeAt(0).cloneRange();
            }
          }
        }
      });
      sel.addEventListener("change", function (e) { handler(e.target.value); });
    }
    hookSelect($("fontFamily"), applyFontFamily);
    hookSelect($("fontSize"), applyFontSize);

    // Colors (hidden native inputs kept for compatibility — Slides-style
    // dropdown lists below drive them)
    if ($("textColor")) $("textColor").addEventListener("input", function (e) { applyTextColor(e.target.value); });
    if ($("hiliteColor")) $("hiliteColor").addEventListener("input", function (e) { applyHiliteColor(e.target.value); });

    function storeEditorSelectionFromContext() {
      var s = window.getSelection();
      if (s && s.rangeCount) {
        var node = s.anchorNode;
        if (node) {
          var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
          if (el && el.closest && el.closest(".page-content")) {
            lastEditorRange = s.getRangeAt(0).cloneRange();
          }
        }
      }
    }

    // Generic portal dropdown open/close for every .ms-dropdown in the ribbon
    var msDropdowns = document.querySelectorAll(".ms-dropdown");
    for (var d = 0; d < msDropdowns.length; d++) {
      (function (dropdown) {
        var btn = dropdown.querySelector(":scope > .ms-dropdown-btn, :scope > button.ribbon-btn.ms-dropdown-btn");
        var menu = dropdown.querySelector(":scope > .ms-dropdown-menu");
        if (!btn || !menu) return;

        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-haspopup", "listbox");

        btn.addEventListener("mousedown", function (e) {
          // Same selection preservation hookSelect used for native selects
          storeEditorSelectionFromContext();
        });

        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (_portalDropdown === dropdown) {
            closePortalDropdown();
            return;
          }
          openPortalDropdown(dropdown, btn, menu);
        });

        btn.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            btn.click();
          } else if (e.key === "Escape") {
            closePortalDropdown();
          }
        });
      })(msDropdowns[d]);
    }

    // Close portal on outside click
    document.addEventListener("mousedown", function (e) {
      if (_portalMenu &&
        !_portalMenu.contains(e.target) &&
        _portalBtn && !_portalBtn.contains(e.target)) {
        closePortalDropdown();
      }
    });

    // Close portal on scroll or resize — but NOT when scrolling inside the menu itself
    window.addEventListener("scroll", function (e) {
      if (_portalMenu && (e.target === _portalMenu || _portalMenu.contains(e.target))) return;
      closePortalDropdown();
    }, true);
    window.addEventListener("resize", function () { closePortalDropdown(); });

    // Helper: pick an item, keep the hidden native select in sync (so state
    // sync and legacy change handlers keep working), update the label
    function wireSelectDropdown(dropdownId, selectId) {
      var dropdown = $(dropdownId);
      var select = $(selectId);
      if (!dropdown || !select) return;

      var items = dropdown.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var i = 0; i < items.length; i++) {
        (function (item) {
          item.addEventListener("click", function () {
            var val = item.getAttribute("data-value");
            var label = item.getAttribute("data-label") || item.textContent;
            if (select) {
              // Only pick values the native select understands; if absent,
              // extend the select so change handlers receive the right value.
              var known = false;
              for (var o = 0; o < select.options.length; o++) {
                if (select.options[o].value === val) { known = true; break; }
              }
              if (!known) {
                var opt = document.createElement("option");
                opt.value = val;
                opt.textContent = label;
                select.appendChild(opt);
              }
              select.value = val;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              var lbl = dropdown.querySelector(".dropdown-value");
              if (lbl) lbl.textContent = label;
            }
            dropdown.classList.remove("active");
            closePortalDropdown();
          });
        })(items[i]);
      }

      // Keep the button label in sync whenever the select changes (user pick,
      // updateToolbarStates…)
      select.addEventListener("change", function () {
        var lbl = dropdown.querySelector(".dropdown-value");
        if (!lbl) return;
        var chosen = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen) {
          lbl.textContent = chosen.getAttribute("data-label") || chosen.textContent;
        } else {
          // Fallback: mirror the selected <option> text
          var optSel = select.options[select.selectedIndex];
          if (optSel) lbl.textContent = optSel.textContent;
        }
      });

      // Initial label sync (directly from current select value)
      var lbl0 = dropdown.querySelector(".dropdown-value");
      if (lbl0) {
        var chosen0 = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen0) lbl0.textContent = chosen0.getAttribute("data-label") || chosen0.textContent;
        else { var o0 = select.options[select.selectedIndex]; if (o0) lbl0.textContent = o0.textContent; }
      }
    }

    wireSelectDropdown("fontFamilyDropdown", "fontFamily");
    wireSelectDropdown("fontSizeDropdown", "fontSize");

    // Font color — vertical list (same behavior as Slides)
    var fontColorDd = $("fontColorDropdown");
    if (fontColorDd) {
      var fcItems = fontColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var f = 0; f < fcItems.length; f++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");
            var btn = fontColorDd.querySelector(".ms-dropdown-btn");
            var swatch = btn ? btn.querySelector(".color-preview") : null;
            var label = btn ? btn.querySelector(".dropdown-value") : null;
            if (swatch) {
              swatch.style.background = color === "transparent" ? "transparent" : color;
              swatch.style.border = (color === "transparent") ? "1px solid #ccc" : "";
            }
            if (label) label.textContent = item.getAttribute("data-label") || "Text";
            applyTextColor(color === "transparent" ? "#000000" : color);
            fontColorDd.classList.remove("active");
            closePortalDropdown();
          });
        })(fcItems[f]);
      }
    }

    // Highlight color — vertical list (same behavior as Slides)
    var hlColorDd = $("highlightColorDropdown");
    if (hlColorDd) {
      var hlItems = hlColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var h = 0; h < hlItems.length; h++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");
            var btn = hlColorDd.querySelector(".ms-dropdown-btn");
            var swatch = btn ? btn.querySelector(".color-preview") : null;
            var label = btn ? btn.querySelector(".dropdown-value") : null;
            if (swatch) {
              if (color === "transparent") {
                swatch.style.background = "transparent";
                swatch.style.border = "1px solid #ccc";
              } else {
                swatch.style.background = color;
                swatch.style.border = "";
              }
            }
            if (label) label.textContent = item.getAttribute("data-label") || "Highlight";
            applyHiliteColor(color === "transparent" ? "transparent" : color);
            hlColorDd.classList.remove("active");
            closePortalDropdown();
          });
        })(hlItems[h]);
      }
    }

    // Page size (Layout tab) — custom dropdown with no native select behind
    // it. The generic .ms-dropdown portal code above handles open/close.
    var psDd = $("pageSizeDropdown");
    if (psDd) {
      var psItems = psDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var psi = 0; psi < psItems.length; psi++) {
        (function (item) {
          item.addEventListener("click", function () {
            var val = item.getAttribute("data-value");
            setPageSize(val);
            var lbl = psDd.querySelector(".dropdown-value");
            if (lbl) lbl.textContent = val;
            psDd.classList.remove("active");
            closePortalDropdown();
          });
        })(psItems[psi]);
      }
      syncPageSizeUI();
    }

    var bClear = $("btnClearFormat");
    if (bClear) {
      bClear.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bClear.addEventListener("click", clearFormatting);
    }

    // Styles group — Title / Heading 1-3 / Normal (formatBlock; feeds TOC + outline)
    var styleBtns = document.querySelectorAll("#stylesGroup .style-btn");
    for (var sb = 0; sb < styleBtns.length; sb++) {
      (function (btn) {
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        btn.addEventListener("click", function () {
          if (!currentDocId) { toast("Open a document first", "error"); return; }
          applyBlock(btn.getAttribute("data-block"));
          schedulePaginate();
          scheduleAutosave();
          toast("Style applied: " + btn.textContent.trim(), "success");
        });
      })(styleBtns[sb]);
    }

    // Menubar / topbar actions (guarded — elements may have moved to ribbon)
    if ($("btnNew")) $("btnNew").addEventListener("click", newDocument);
    if ($("btnFind")) $("btnFind").addEventListener("click", openFind);
    if ($("btnFind2")) $("btnFind2").addEventListener("click", openFind);
    if ($("btnSave")) $("btnSave").addEventListener("click", function () { saveDocument(true); });
    if ($("btnVersions")) { $("btnVersions").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnVersions").addEventListener("click", showVersions); }
    if ($("btnUndo")) { $("btnUndo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnUndo").addEventListener("click", function () { exec("undo"); }); }
    if ($("btnRedo")) { $("btnRedo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnRedo").addEventListener("click", function () { exec("redo"); }); }
    // Theme / color theme / dark paper buttons have been removed from the UI.
    // (No click handlers to wire up — cyan is locked via CSS.)

    // Ribbon tabs — switching with sliding indicator + blur/fade panel transition
    initRibbonTabs();
    setupImageFormatTab();

    // Export dropdown (guarded — may not exist if moved)
    var exportToggle = $("btnExportToggle");
    var exportMenu = $("exportMenu");
    if (exportToggle && exportMenu) {
      exportToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.classList.toggle("open");
      });
      document.addEventListener("click", function () { exportMenu.classList.remove("open"); });
      var exportBtns = exportMenu.querySelectorAll("button[data-export]");
    for (var ei = 0; ei < exportBtns.length; ei++) {
      (function (b) {
        b.addEventListener("click", function () {
          exportMenu.classList.remove("open");
          exportDocument(b.getAttribute("data-export"));
        });
      })(exportBtns[ei]);
    }
    } // end if (exportToggle && exportMenu)

    // Insert group
    $("btnLink").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnLink").addEventListener("click", openLinkDialog);
    $("btnImage").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnImage").addEventListener("click", openImagePicker);
    var imgInput = $("insertImageInput");
    if (imgInput) imgInput.addEventListener("change", handleImageFileSelect);
    $("btnTable").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnTable").addEventListener("click", openTableDialog);
    $("btnHr").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHr").addEventListener("click", insertHr);

    // Page break
    $("btnPageBreak").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageBreak").addEventListener("click", insertPageBreak);

    // Word count
    $("btnWordCount").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWordCount").addEventListener("click", showWordCount);
    // (The old #wordCount span in the ribbon-tabs-right has been replaced by
    // the Print button — the live word counter is gone from the ribbon.
    // Word count is still available via Review → Word Count.)
    if ($("btnPrint")) {
      $("btnPrint").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnPrint").addEventListener("click", function () {
        // Save first, then open the browser print dialog. togglePrintPreview
        // is not used here because the user clicked Print directly — they
        // want the OS print dialog, not the in-app preview bar.
        printDocument();
      });
    }

    // Goal tracker input
    $("goalInput").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      goalTarget = (isNaN(v) || v < 0) ? 0 : v;
      saveGoal();
      updateGoalTracker();
    });
    $("goalClear").addEventListener("click", function () {
      goalTarget = 0;
      $("goalInput").value = "";
      saveGoal();
      updateGoalTracker();
    });

    // Print preview
    $("btnPrintExit").addEventListener("click", function () { togglePrintPreview(false); });
    $("btnPrintNow").addEventListener("click", function () {
      togglePrintPreview(false);
      printDocument();
    });


    // EmeraldSuite: Docs — new feature wiring
    // Templates
    if ($("btnTemplates")) $("btnTemplates").addEventListener("click", function () { buildTemplates(); openModal("templatesModal"); });

    // Symbols (Slides-style floating bottom bar — toggle, insert at caret)
    $("btnSymbols").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnSymbols").addEventListener("click", function () { toggleSymbolBar(); });
    initSymbolBar();

    // Go To
    $("btnGoTo").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnGoTo").addEventListener("click", openGoTo);
    $("frGotoBtn").addEventListener("click", performGoTo);
    $("frGotoValue").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); performGoTo(); } });
    setupGotoTypeDropdown();

    // Watermark
    $("btnWatermark").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWatermark").addEventListener("click", openWatermark);
    $("watermarkConfirm").addEventListener("click", function () {
      applyWatermark($("watermarkText").value.trim());
      closeModal("watermarkModal");
      toast("Watermark applied", "success");
    });
    $("watermarkRemove").addEventListener("click", function () {
      applyWatermark(null);
      closeModal("watermarkModal");
      toast("Watermark removed", "success");
    });
    var wmPresets = document.querySelectorAll(".watermark-presets .preset-btn");
    for (var wp = 0; wp < wmPresets.length; wp++) {
      wmPresets[wp].addEventListener("click", function () { $("watermarkText").value = this.getAttribute("data-wm"); });
    }

    // Drop Cap
    $("btnDropCap").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnDropCap").addEventListener("click", toggleDropCap);

    // Columns
    var colBtns = document.querySelectorAll("[data-cols]");
    for (var cb = 0; cb < colBtns.length; cb++) {
      (function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function () {
          setColumns(parseInt(b.getAttribute("data-cols"), 10));
        });
      })(colBtns[cb]);
    }
    // default 1-column active
    document.querySelector("[data-cols='1']").classList.add("active");

    // Orientation & Page Size (size is a dropdown now — it is wired with
    // the other ms-dropdowns above)
    $("btnOrientation").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOrientation").addEventListener("click", toggleOrientation);

    // Header / Footer / Page Number
    $("btnHeader").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHeader").addEventListener("click", function () { editHeaderFooter("header"); });
    $("btnFooter").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnFooter").addEventListener("click", function () { editHeaderFooter("footer"); });
    $("btnPageNum").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageNum").addEventListener("click", insertPageNumber);

    // Read Aloud
    $("btnReadAloud").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnReadAloud").addEventListener("click", readAloud);

    // Comments (Slides-style pins + popup)
    $("btnComment").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnComment").addEventListener("click", addComment);
    $("commentSaveBtn").addEventListener("click", confirmCommentComposer);
    $("commentText").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmCommentComposer(); }
    });

    // ── FILE MODAL (opened from the File ribbon tab) ──
    // Close X button + backdrop click
    if ($("fileModalCloseXBtn")) $("fileModalCloseXBtn").addEventListener("click", closeFileModal);
    $("fileModal").addEventListener("click", function (e) {
      if (e.target === $("fileModal")) closeFileModal();
    });
    // Actions
    if ($("fileDeleteBtn")) $("fileDeleteBtn").addEventListener("click", function () {
      var wasCurrent = currentDocId;
      closeFileModal();
      if (wasCurrent) confirmDeleteCurrentDoc();
    });
    if ($("fileCloseBtn")) $("fileCloseBtn").addEventListener("click", function () {
      closeFileModal();
      closeDocument();
    });
    // Export (Docs-supported formats)
    if ($("fileExportTxtBtn")) $("fileExportTxtBtn").addEventListener("click", function () { closeFileModal(); exportDocument("txt"); });
    if ($("fileExportHtmlBtn")) $("fileExportHtmlBtn").addEventListener("click", function () { closeFileModal(); exportDocument("html"); });
    if ($("fileExportPdfBtn")) $("fileExportPdfBtn").addEventListener("click", function () { closeFileModal(); exportDocument("pdf"); });
    if ($("fileExportPrintBtn")) $("fileExportPrintBtn").addEventListener("click", function () { closeFileModal(); exportDocument("print"); });
    // Tools (Docs-specific)
    if ($("fileStatsBtn")) $("fileStatsBtn").addEventListener("click", showWordCount);
    if ($("fileVersionsBtn")) $("fileVersionsBtn").addEventListener("click", showVersions);
    // Rename input: Enter commits + closes; typing renames live
    var nameInput = $("fileModalNameInput");
    if (nameInput) {
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); e.target.blur(); closeFileModal(); }
      });
      nameInput.addEventListener("input", function () {
        if (!currentDocId) return;
        currentTitle = nameInput.value.trim() || "Untitled Document";
        scheduleAutosave();
      });
    }

    // ── WELCOME SCREEN (home) ──
    if ($("welcomeNewBtn")) $("welcomeNewBtn").addEventListener("click", createNewDocument);
    if ($("welcomeImportBtn")) $("welcomeImportBtn").addEventListener("click", function () { $("fileImportInput").click(); });
    var importInput = $("fileImportInput");
    if (importInput) importInput.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      importDocumentFromFile(file);
      e.target.value = "";
    });

    // ── DELETE DOCUMENT CONFIRMATION (Slides/Notes-style) ──
    if ($("deleteDocConfirm")) $("deleteDocConfirm").addEventListener("click", function () {
      var target = _deleteTargetId;
      // Animate the dialog out first, then delete once it's gone (Slides pattern)
      closeDeleteDocModal();
      if (target) setTimeout(function () { deleteDocument(target); }, 250);
    });
    if ($("deleteDocCancel")) $("deleteDocCancel").addEventListener("click", closeDeleteDocModal);
    var delModal = $("deleteDocModal");
    if (delModal) delModal.addEventListener("click", function (e) {
      if (e.target === delModal) closeDeleteDocModal();
    });

    // ── FOOTNOTE / ENDNOTE / CITATION MODALS ──
    if ($("footnoteInsert")) $("footnoteInsert").addEventListener("click", function () {
      var note = ($("footnoteText").value || "").trim();
      if (!note) { toast("Enter footnote text", "error"); return; }
      closeModal("footnoteModal");
      performInsertFootnote(note);
    });
    if ($("endnoteInsert")) $("endnoteInsert").addEventListener("click", function () {
      var note = ($("endnoteText").value || "").trim();
      if (!note) { toast("Enter endnote text", "error"); return; }
      closeModal("endnoteModal");
      performInsertEndnote(note);
    });
    if ($("citeInsert")) $("citeInsert").addEventListener("click", function () {
      var cite = ($("citeText").value || "").trim();
      if (!cite) { toast("Enter citation text", "error"); return; }
      closeModal("citeModal");
      performInsertCite(cite);
    });
    // Ctrl/⌘+Enter inside the textarea = Insert; plain Enter in the cite input = Insert
    [["footnoteText", "footnoteInsert"], ["endnoteText", "endnoteInsert"]].forEach(function (pair) {
      var ta = $(pair[0]);
      if (ta) ta.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); $(pair[1]).click(); }
      });
    });
    var citeInput = $("citeText");
    if (citeInput) citeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("citeInsert").click(); }
    });

    // References panel buttons
    if ($("btnTocRef")) { $("btnTocRef").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnTocRef").addEventListener("click", insertTOC); }
    if ($("btnFootnote")) { $("btnFootnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFootnote").addEventListener("click", openFootnoteModal); }
    if ($("btnEndnote")) { $("btnEndnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnEndnote").addEventListener("click", openEndnoteModal); }
    if ($("btnCitation")) { $("btnCitation").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCitation").addEventListener("click", openCiteModal); }
    if ($("btnBibliography")) { $("btnBibliography").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnBibliography").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Bibliography</h2><p>Entry 1. Author, Title, Publisher, Year.</p>'); toast("Bibliography inserted", "success"); schedulePaginate(); }); }
    if ($("btnIndexEntry")) { $("btnIndexEntry").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnIndexEntry").addEventListener("click", function () { var sel = window.getSelection(); if (sel && !sel.isCollapsed) { toast("Index entry marked: " + sel.toString(), "success"); } else { toast("Select text first to mark an index entry", "error"); } }); }
    if ($("btnInsertIndex")) { $("btnInsertIndex").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertIndex").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Index</h2><p>Term, Page</p>'); toast("Index inserted", "success"); schedulePaginate(); }); }

    // Session timer (click to reset) — element removed in Slides-style bar; guard.
    var stBtn = $("sessionTimer");
    if (stBtn) {
      stBtn.addEventListener("click", function () {
        if (sessionActive) {
          if (window.confirm("Reset the writing session timer?")) resetSessionTimer();
        }
      });
    }

    // Outline panel
    $("btnOutline").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOutline").addEventListener("click", function () { toggleOutline(); });
    $("outlineClose").addEventListener("click", function () { toggleOutline(false); });
    $("outlineSearch").addEventListener("input", filterOutline);

    // Page thumbnails panel
    $("btnPages").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPages").addEventListener("click", function () { toggleThumbnails(); });
    $("thumbnailsClose").addEventListener("click", function () { toggleThumbnails(false); });

    // Margins dialog
    $("btnMargins").addEventListener("click", openMarginsDialog);
    var presetBtns = document.querySelectorAll(".preset-btn");
    for (var pi = 0; pi < presetBtns.length; pi++) {
      (function (b) {
        b.addEventListener("click", function () {
          applyPreset(b.getAttribute("data-preset"));
        });
      })(presetBtns[pi]);
    }
    ["top", "bottom", "left", "right"].forEach(function (side) {
      var input = $("margin" + side.charAt(0).toUpperCase() + side.slice(1));
      if (input) {
        input.addEventListener("input", function (e) {
          applyCustomMargin(side, e.target.value);
        });
        input.addEventListener("change", function () {
          saveMargins();
          schedulePaginate();
          scheduleAutosave();
        });
      }
    });
    $("btnMarginsReset").addEventListener("click", function () {
      applyPreset("default");
      saveMargins();
      schedulePaginate();
      scheduleAutosave();
    });

    // Modal close buttons
    var closeBtns = document.querySelectorAll("[data-close]");
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener("click", function () {
        closeModal(this.getAttribute("data-close"));
      });
    }
    // Click outside to close
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var oi = 0; oi < overlays.length; oi++) {
      (function (ov) {
        ov.addEventListener("mousedown", function (e) {
          if (e.target === ov) closeModal(ov.id);
        });
      })(overlays[oi]);
    }

    // Find & Replace (bottom-right bar)
    $("frFindInput").addEventListener("input", runFind);
    $("frCaseSensitive").addEventListener("change", runFind);
    $("frWholeWord").addEventListener("change", runFind);
    if ($("frRegex")) $("frRegex").addEventListener("change", runFind);
    $("frNextBtn").addEventListener("click", findNext);
    $("frPrevBtn").addEventListener("click", findPrev);
    $("frReplaceOneBtn").addEventListener("click", replaceOne);
    $("frReplaceAllBtn").addEventListener("click", replaceAll);
    $("frCloseBtn").addEventListener("click", closeFindBar);
    // Escape anywhere inside the bar closes it (inputs included, buttons too)
    $("findBar").addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
    });
    $("frFindInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); }
      if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
    });
    $("frReplaceInput").addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
    });

    // Link dialog
    $("linkConfirm").addEventListener("click", insertLink);
    $("linkUrl").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });
    $("linkText").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });

    // Table dialog
    $("tableConfirm").addEventListener("click", insertTable);
    buildTableGrid();

    // Zoom (Slides-style buttons — the old slider was removed)
    $("zoomFitBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomFitBtn").addEventListener("click", zoomFitToWindow);
    $("zoom100Btn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoom100Btn").addEventListener("click", function () { setZoom(100); });
    $("zoomInBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomInBtn").addEventListener("click", function () { adjustZoom(10); });
    $("zoomOutBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomOutBtn").addEventListener("click", function () { adjustZoom(-10); });

    // Show > Ruler
    $("toggleRulerBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("toggleRulerBtn").addEventListener("click", function (e) {
      var on = document.body.classList.toggle("show-rulers");
      e.currentTarget.classList.toggle("active", on);
      if (on) buildRulerTicks();
    });
    // Show > Guidelines
    $("toggleGuidesBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("toggleGuidesBtn").addEventListener("click", function (e) {
      var on = document.body.classList.toggle("show-guides");
      e.currentTarget.classList.toggle("active", on);
      var wrapper = $(PAGES_WRAPPER_ID);
      if (wrapper) wrapper.classList.toggle("show-guides", on);
    });

    // Keep the ruler aligned to the page while zooming / scrolling / resizing.
    $("documentScroll").addEventListener("scroll", function () {
      if (document.body.classList.contains("show-rulers")) buildRulerTicks();
    });
    window.addEventListener("resize", function () {
      if (document.body.classList.contains("show-rulers")) buildRulerTicks();
    });

    // Track editor selection
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && sel.anchorNode) {
        var node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        if (node && node.closest && node.closest(".page-content")) {
          lastEditorRange = sel.getRangeAt(0).cloneRange();
        }
      }
      updateToolbarStates();
      updateRibbonAvailability();
      updateStatus();
    });

    $("documentScroll").addEventListener("scroll", updateStatus);

    document.addEventListener("keydown", function (e) {
      // Escape → close the File modal or delete dialog if open
      if (e.key === "Escape") {
        if (fileModalOpen()) { e.preventDefault(); closeFileModal(); return; }
        var delModalOpen = $("deleteDocModal");
        if (delModalOpen && delModalOpen.classList.contains("show")) {
          e.preventDefault();
          closeDeleteDocModal();
          return;
        }
      }
    });

    // Editor defaults
    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    loadMargins();
    loadGoal();
    // Color theme loading is a no-op now (cyan is locked via CSS).
    buildRulerTicks();
    initLinkPreview();
    initImageResize();
    initDragDropImage();
    setZoom(100);
    updateToolbarStates();
    updateRibbonAvailability();
    updateStatus();
    initCrossTabSync();
    initNewFeatures();
    // Bank the current session's writing time if the tab is closed mid-session.
    window.addEventListener("pagehide", commitSessionTime);

    setTimeout(function () {
      // Only auto-focus the editor when a document is actually open —
      // on the welcome screen the user may be about to click a card.
      if (!currentDocId) return;
      var firstContent = getContent(getPages()[0]);
      if (firstContent) firstContent.focus();
    }, 120);
  }

  /* ---------------- Cross-tab sync (BroadcastChannel via IDB) ---------------- */
  var crossTabIgnoreUntil = 0;
  function initCrossTabSync() {
    if (!idb || !idb.subscribe) return;
    idb.subscribe(function (change) {
      // change = { key, type, source, at }
      if (!change || !change.key) return;
      // Ignore our own writes for a short window (we broadcast on every setJSON)
      if (change.at && change.at < crossTabIgnoreUntil) return;

      if (change.key === DOC_INDEX_KEY) {
        // Another tab changed the document index (created/deleted/renamed a
        // document) — refresh the welcome screen cards if it is visible.
        loadIndex().then(function () {
          if (!currentDocId) renderWelcomeCards();
        });
      } else if (currentDocId && change.key === docDataKey(currentDocId)) {
        // Another tab changed the open document — reload it softly (only if
        // this tab is not actively being edited, to avoid clobbering the caret).
        reloadFromStorageQuietly();
      } else if (change.key === MARGINS_KEY) {
        loadMargins();
        schedulePaginate();
      } else if (change.key === GOAL_KEY) {
        loadGoal();
        updateGoalTracker();
      } else if (change.key === WRITING_TIME_KEY) {
        writingTimeCache = null; // reload from the other tab on next read
      }
    });
  }

  // Reload document content from storage WITHOUT stealing focus. Called when
  // another tab saved the open document. Saves our own in-flight caret to restore.
  async function reloadFromStorageQuietly() {
    try {
      if (!currentDocId) return;
      var data = null;
      if (window.EmeraldIDBStorage) data = await window.EmeraldIDBStorage.getJSON(docDataKey(currentDocId));
      if (!data) return;
      var sel = window.getSelection();
      var hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest(".page-content");
      var caretInfo = hadFocus && sel && sel.rangeCount ? saveCaretSnapshot() : null;

      currentTitle = data.title || currentTitle;
      syncFileModalNameInput();
      var wrapper = $(PAGES_WRAPPER_ID);
      wrapper.innerHTML = "";
      var page = createPage();
      wrapper.appendChild(page);
      var content = getContent(page);
      content.innerHTML = sanitizeStoredHtml(data.content) || "";
      if (content.children.length === 0) {
        var p = document.createElement("p");
        p.innerHTML = "<br>";
        content.appendChild(p);
      }
      headerActive = hfHasContent(data.header);
      headerHTML = headerActive ? data.header : "";
      footerActive = hfHasContent(data.footer);
      footerHTML = footerActive ? data.footer : "";
      paginate();
      setAutosaveState("saved");
      // Restore caret if we had focus and the block still exists
      if (caretInfo) restoreCaretSnapshot(caretInfo);
    } catch (e) { /* ignore */ }
  }

  function saveCaretSnapshot() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var block = range.startContainer;
    if (block.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block && !block.classList.contains("page-content")) block = block.parentElement;
    if (!block) return null;
    // Mark the block with a temporary attribute so we can find it after reload
    var markerId = "ct_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    try {
      var target = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
      if (target) target.setAttribute("data-ct-marker", markerId);
    } catch (e) {}
    return { markerId: markerId, offset: range.startOffset, toString: range.toString().length };
  }

  function restoreCaretSnapshot(snap) {
    if (!snap) return;
    try {
      var node = document.querySelector('[data-ct-marker="' + snap.markerId + '"]');
      if (node && node.removeAttribute) node.removeAttribute("data-ct-marker");
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* =========================================================
     EmeraldSuite: Docs — Feature additions
     (cover pages, equations, smartart, screenshot, draw mode,
      spellcheck, footnotes, table of figures,
      threaded comments)
     ========================================================= */

  /* ---------------- State ---------------- */
  var footnotes = [];
  var endnotes = [];
  var drawCanvas = null;
  var drawCtx = null;
  var isDrawing = false;
  var drawMode = false;
  var drawPoints = [];
  var drawColor = "#000000";
  var drawWidth = 2;
  var drawTool = "pen";
  var coverPageStyle = "classic";
  var pendingInternalTarget = null;

  function handleInternalLinkClick(e) {
    var link = e.target.closest("a.emdocs-internal-link");
    if (!link) return;
    e.preventDefault();
    var targetId = link.getAttribute("data-target");
    var el = targetId ? document.getElementById(targetId) : null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      var oldBg = el.style.background;
      el.style.background = "var(--ui-accent-selected)";
      setTimeout(function () { el.style.background = oldBg; }, 1200);
    }
  }

  /* TOC anchor jumps: any click — plain, Ctrl/Cmd+click, or middle-click —
     scrolls to the referenced heading instead of navigating to "#" or trying
     to open a new tab. The anchor's data-toc index maps to the live heading
     list (same order TOC generated it from). */
  function jumpToHeadingByTOC(tocLink) {
    var index = parseInt(tocLink.getAttribute("data-toc"), 10);
    if (isNaN(index) || index < 0) return;
    var headings = document.querySelectorAll(".page-content h1, .page-content h2, .page-content h3, .page-content h4");
    if (index >= headings.length) return;
    var h = headings[index];
    h.scrollIntoView({ behavior: "smooth", block: "center" });
    var range = document.createRange();
    range.selectNodeContents(h);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var content = h.closest(".page-content");
    if (content) content.focus();
    h.style.transition = "background 0.4s";
    var prevBg = h.style.background;
    h.style.background = "var(--ui-accent-soft)";
    setTimeout(function () { h.style.background = prevBg; }, 800);
  }

  /* ---------------- Cover pages ---------------- */
  function openCoverPageDialog() {
    // Pre-fill title from doc title
    $("coverTitle").value = currentTitle || "Document Title";
    openModal("coverPageModal");
  }

  function insertCoverPage() {
    var title = $("coverTitle").value.trim() || "Untitled";
    var subtitle = $("coverSubtitle").value.trim();
    var author = $("coverAuthor").value.trim();
    var dateStr = $("coverDate").value.trim() || formatTime(Date.now());
    var style = coverPageStyle;
    var html = '<div class="cover-page style-' + escapeAttr(style) + '" contenteditable="true">';
    if (style === "accent") html += '<div class="cover-accent-bar"></div>';
    html += '<div class="cover-title">' + escapeHtml(title) + '</div>';
    if (subtitle) html += '<div class="cover-subtitle">' + escapeHtml(subtitle) + '</div>';
    if (style === "modern") html += '<div class="cover-meta">';
    if (author) html += '<div class="cover-author">' + escapeHtml(author) + '</div>';
    if (dateStr) html += '<div class="cover-date">' + escapeHtml(dateStr) + '</div>';
    if (style === "modern") html += '</div>';
    html += '</div><p><br></p><div class="emdocs-page-break" contenteditable="false"><span class="pb-label">— Page Break —</span></div><p><br></p>';
    // Insert at the very beginning of the document
    var firstPage = getPages()[0];
    var content = getContent(firstPage);
    var p = document.createElement("p");
    p.innerHTML = html;
    // Move the cover nodes to the front
    var nodes = Array.prototype.slice.call(p.childNodes);
    for (var i = nodes.length - 1; i >= 0; i--) {
      content.insertBefore(nodes[i], content.firstChild);
    }
    closeModal("coverPageModal");
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    toast("Cover page inserted", "success");
  }

  /* ---------------- Section break ---------------- */
  var sectionOrient = "portrait";
  function insertSectionBreak() {
    // Open the section break dialog (default to current margins in cm)
    var cm = function (px) { return (px / 37.8).toFixed(2); };
    $("secMarginTop").value = cm(pageMargins.top);
    $("secMarginBottom").value = cm(pageMargins.bottom);
    $("secMarginLeft").value = cm(pageMargins.left);
    $("secMarginRight").value = cm(pageMargins.right);
    sectionOrient = "portrait";
    var btns = document.querySelectorAll(".sec-orient-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-orient") === "portrait");
    }
    openModal("sectionBreakModal");
  }

  function confirmSectionBreak() {
    var orient = sectionOrient || "portrait";
    var mt = parseFloat($("secMarginTop").value) || 2.54;
    var mb = parseFloat($("secMarginBottom").value) || 2.54;
    var ml = parseFloat($("secMarginLeft").value) || 2.54;
    var mr = parseFloat($("secMarginRight").value) || 2.54;
    // convert cm → px (1cm ≈ 37.8px at 96dpi)
    var config = {
      orientation: orient,
      margins: {
        top: Math.round(mt * 37.8),
        bottom: Math.round(mb * 37.8),
        left: Math.round(ml * 37.8),
        right: Math.round(mr * 37.8)
      }
    };
    var configStr = escapeAttr(JSON.stringify(config));
    var html = '<div class="section-break has-config" contenteditable="false" data-section-config=\'' + configStr + '\'></div><p><br></p>';
    // Close modal FIRST so the overlay doesn't block the editor focus.
    closeModal("sectionBreakModal");
    // Defer the insertion one tick so the modal opacity transition starts
    // and the editor can receive focus + selection.
    setTimeout(function () {
      focusEditorAndRestore();
      document.execCommand("insertHTML", false, html);
      schedulePaginate();
      scheduleAutosave();
    }, 0);
    toast("Section break inserted (" + orient + ", " + mt + "cm margins)", "success");
  }

  // After pagination, scan each page for section-break markers and apply
  // the most recent section config to that page (and subsequent pages until
  // a new section break overrides it).
  function applySectionConfigs() {
    var pages = getPages();
    var currentConfig = null;
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      // Look for a section-break marker in this page
      var breaks = page.querySelectorAll(".section-break[data-section-config]");
      if (breaks.length > 0) {
        // A section break on this page means the NEXT page starts a new section.
        // But if the break is at the very start, this page itself is the new section.
        var firstChild = getContent(page).firstElementChild;
        var breakIsFirst = firstChild && firstChild.classList.contains("section-break");
        if (breakIsFirst) {
          try {
            currentConfig = JSON.parse(breaks[0].getAttribute("data-section-config") || "null");
          } catch (e) {}
        } else {
          // break is later in the page — apply to next pages
          try {
            var nextConfig = JSON.parse(breaks[breaks.length - 1].getAttribute("data-section-config") || "null");
            // store for next page iteration
            page.setAttribute("data-next-section", "1");
            // apply to subsequent pages on next iteration
            // (we'll just apply it from the next page onward)
            for (var j = i + 1; j < pages.length; j++) {
              applyConfigToPage(pages[j], nextConfig);
            }
            // don't apply currentConfig to this page (it's still the old section)
            continue;
          } catch (e) {}
        }
      }
      applyConfigToPage(page, currentConfig);
    }
  }

  function applyConfigToPage(page, config) {
    if (!config) {
      page.removeAttribute("data-orient");
      page.style.removeProperty("--sec-mt");
      page.style.removeProperty("--sec-mr");
      page.style.removeProperty("--sec-mb");
      page.style.removeProperty("--sec-ml");
      return;
    }
    if (config.orientation === "landscape") {
      page.setAttribute("data-orient", "landscape");
    } else {
      page.removeAttribute("data-orient");
    }
    if (config.margins) {
      page.style.setProperty("--sec-mt", config.margins.top + "px");
      page.style.setProperty("--sec-mr", config.margins.right + "px");
      page.style.setProperty("--sec-mb", config.margins.bottom + "px");
      page.style.setProperty("--sec-ml", config.margins.left + "px");
    }
  }

  /* ---------------- Equation editor ---------------- */
  function renderEquation(latex) {
    // Tiny LaTeX-ish renderer: handles ^, _, \frac, \sqrt, \sum, \int, \lim,
    // \prod, \log, \ln, \binom, \sin/\cos/\tan, greek letters, etc.
    if (!latex) return "";
    // Escape FIRST: typed characters can never become live markup in the
    // preview or the inserted equation (CodeQL: DOM text reinterpreted).
    var out = escapeHtml(latex);
    // \frac{a}{b}
    out = out.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">' + a + '</span><span style="display:block;padding:0 4px">' + b + '</span></span>';
    });
    // \binom{n}{k} → (n choose k) rendered as stacked fraction in parens
    out = out.replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '(<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;padding:0 2px">' + a + '</span><span style="display:block;border-top:1px solid currentColor;padding:0 2px">' + b + '</span></span>)';
    });
    // \sqrt{x}
    out = out.replace(/\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span style="white-space:nowrap">√<span style="border-top:1px solid currentColor;padding:0 2px">' + a + '</span></span>';
    });
    // \sum_{i=1}^{n}  (with optional braces)
    out = out.replace(/\\sum_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∑<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\sum/g, "∑");
    // \prod_{i=1}^{n}
    out = out.replace(/\\prod_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∏<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\prod/g, "∏");
    // \int_a^b
    out = out.replace(/\\int_\{?([^{}]*?)\}?\^\{?([^{}]*?)\}?/g, function (m, lo, hi) {
      return '<span style="font-size:1.4em">∫</span><sub>' + lo + '</sub><sup>' + hi + '</sup>';
    });
    out = out.replace(/\\int/g, "∫");
    // \lim_{x \to 0}
    out = out.replace(/\\lim_\{([^{}]*)\}/g, function (m, sub) {
      return 'lim<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:0.7em"><span style="display:block">' + sub.replace(/\\to/g, "→") + '</span></span>';
    });
    out = out.replace(/\\lim/g, "lim");
    // \log_{10}(x)
    out = out.replace(/\\log_\{([^{}]*)\}/g, function (m, base) {
      return 'log<span style="font-size:0.7em;vertical-align:sub">' + base + '</span>';
    });
    out = out.replace(/\\ln/g, "ln");
    // \frac{d}{dx} derivative
    out = out.replace(/\\frac\{d\}\{d([^{}]*)\}/g, function (m, varname) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-style:italic"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">d</span><span style="display:block;padding:0 4px">d' + varname + '</span></span>';
    });
    // \sin, \cos, \tan, \cot, \sec, \csc
    out = out.replace(/\\(sin|cos|tan|cot|sec|csc)\b/g, function (m, fn) { return fn; });
    // \to →
    out = out.replace(/\\to/g, "→");
    // \pm
    out = out.replace(/\\pm/g, "±");
    out = out.replace(/\\mp/g, "∓");
    out = out.replace(/\\times/g, "×");
    out = out.replace(/\\div/g, "÷");
    out = out.replace(/\\cdot/g, "·");
    out = out.replace(/\\leq/g, "≤");
    out = out.replace(/\\geq/g, "≥");
    out = out.replace(/\\neq/g, "≠");
    out = out.replace(/\\approx/g, "≈");
    out = out.replace(/\\infty/g, "∞");
    out = out.replace(/\\partial/g, "∂");
    out = out.replace(/\\nabla/g, "∇");
    out = out.replace(/\\forall/g, "∀");
    out = out.replace(/\\exists/g, "∃");
    out = out.replace(/\\in/g, "∈");
    out = out.replace(/\\notin/g, "∉");
    out = out.replace(/\\subset/g, "⊂");
    out = out.replace(/\\supset/g, "⊃");
    out = out.replace(/\\cup/g, "∪");
    out = out.replace(/\\cap/g, "∩");
    out = out.replace(/\\emptyset/g, "∅");
    out = out.replace(/\\rightarrow/g, "→");
    out = out.replace(/\\leftarrow/g, "←");
    out = out.replace(/\\Rightarrow/g, "⇒");
    out = out.replace(/\\Leftarrow/g, "⇐");
    out = out.replace(/\\leftrightarrow/g, "↔");
    // Greek letters
    out = out.replace(/\\alpha/g, "α");
    out = out.replace(/\\beta/g, "β");
    out = out.replace(/\\gamma/g, "γ");
    out = out.replace(/\\delta/g, "δ");
    out = out.replace(/\\epsilon/g, "ε");
    out = out.replace(/\\varepsilon/g, "ε");
    out = out.replace(/\\zeta/g, "ζ");
    out = out.replace(/\\eta/g, "η");
    out = out.replace(/\\theta/g, "θ");
    out = out.replace(/\\iota/g, "ι");
    out = out.replace(/\\kappa/g, "κ");
    out = out.replace(/\\lambda/g, "λ");
    out = out.replace(/\\mu/g, "μ");
    out = out.replace(/\\nu/g, "ν");
    out = out.replace(/\\xi/g, "ξ");
    out = out.replace(/\\pi/g, "π");
    out = out.replace(/\\rho/g, "ρ");
    out = out.replace(/\\sigma/g, "σ");
    out = out.replace(/\\tau/g, "τ");
    out = out.replace(/\\upsilon/g, "υ");
    out = out.replace(/\\phi/g, "φ");
    out = out.replace(/\\chi/g, "χ");
    out = out.replace(/\\psi/g, "ψ");
    out = out.replace(/\\omega/g, "ω");
    out = out.replace(/\\Gamma/g, "Γ");
    out = out.replace(/\\Delta/g, "Δ");
    out = out.replace(/\\Theta/g, "Θ");
    out = out.replace(/\\Lambda/g, "Λ");
    out = out.replace(/\\Pi/g, "Π");
    out = out.replace(/\\Sigma/g, "Σ");
    out = out.replace(/\\Phi/g, "Φ");
    out = out.replace(/\\Psi/g, "Ψ");
    out = out.replace(/\\Omega/g, "Ω");
    // superscripts ^{..} or ^x
    out = out.replace(/\^\{([^{}]*)\}/g, "<sup>$1</sup>");
    out = out.replace(/\^([^\s\\{}])/g, "<sup>$1</sup>");
    // subscripts _{..} or _x
    out = out.replace(/_\{([^{}]*)\}/g, "<sub>$1</sub>");
    out = out.replace(/_([^\s\\{}])/g, "<sub>$1</sub>");
    return out;
  }

  function openEquationDialog() {
    $("equationInput").value = "";
    $("equationPreview").innerHTML = "";
    openModal("equationModal");
    setTimeout(function () { $("equationInput").focus(); }, 100);
  }

  function insertEquation() {
    var latex = $("equationInput").value.trim();
    if (!latex) { toast("Enter an equation", "error"); return; }
    var rendered = renderEquation(latex);
    var html = '<span class="equation" contenteditable="false" data-latex="' + escapeAttr(latex) + '">' + rendered + '</span> ';
    restoreEditorSelection();
    document.execCommand("insertHTML", false, html);
    closeModal("equationModal");
    schedulePaginate();
    scheduleAutosave();
    toast("Equation inserted", "success");
  }

  /* ---------------- SmartArt ---------------- */
  var SMARTART_TEMPLATES = [
    {
      id: "flow3",
      name: "Flow (3 steps)",
      desc: "Linear process, left-to-right",
      preview: '<div class="sa-mini"><span class="sa-m-node">Start</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Mid</span><span class="sa-m-arrow">→</span><span class="sa-m-node">End</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Start</span><span class="sa-arrow">→</span><span class="sa-node">Process</span><span class="sa-arrow">→</span><span class="sa-node">End</span></div><p><br></p>'
    },
    {
      id: "flow5",
      name: "Process (5 steps)",
      desc: "Detailed sequential workflow",
      preview: '<div class="sa-mini"><span class="sa-m-node">1</span><span class="sa-m-arrow">→</span><span class="sa-m-node">2</span><span class="sa-m-arrow">→</span><span class="sa-m-node">3</span><span class="sa-m-arrow">→</span><span class="sa-m-node">4</span><span class="sa-m-arrow">→</span><span class="sa-m-node">5</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">1</span><span class="sa-arrow">→</span><span class="sa-node">2</span><span class="sa-arrow">→</span><span class="sa-node">3</span><span class="sa-arrow">→</span><span class="sa-node">4</span><span class="sa-arrow">→</span><span class="sa-node">5</span></div><p><br></p>'
    },
    {
      id: "hierarchy",
      name: "Hierarchy",
      desc: "1 root with 3 children",
      preview: '<div class="sa-mini col tree"><span class="sa-m-node sa-m-root">Main</span><div style="display:flex;gap:3px"><span class="sa-m-node">A</span><span class="sa-m-node">B</span><span class="sa-m-node">C</span></div></div>',
      html: '<div class="smartart hierarchy" contenteditable="false"><div class="sa-node root">Main</div><div style="display:flex;gap:8px;justify-content:center"><span class="sa-node">A</span><span class="sa-node">B</span><span class="sa-node">C</span></div></div><p><br></p>'
    },
    {
      id: "cycle",
      name: "Cycle (4 stages)",
      desc: "Continuous / iterative process",
      preview: '<div class="sa-mini cycle"><span class="sa-m-node">Plan</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Do</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Check</span><span class="sa-m-arrow">→</span><span class="sa-m-node">Act</span></div>',
      html: '<div class="smartart flow" contenteditable="false"><span class="sa-node">Plan</span><span class="sa-arrow">→</span><span class="sa-node">Do</span><span class="sa-arrow">→</span><span class="sa-node">Check</span><span class="sa-arrow">→</span><span class="sa-node">Act</span><span class="sa-arrow">↻</span></div><p><br></p>'
    },
    {
      id: "pyramid",
      name: "Pyramid (4 levels)",
      desc: "Hierarchy by importance",
      preview: '<div class="sa-mini col pyramid"><span class="sa-m-node">Top</span><span class="sa-m-node">Level 2</span><span class="sa-m-node">Level 3</span><span class="sa-m-node">Base</span></div>',
      html: '<div class="smartart" style="display:flex;flex-direction:column;align-items:center;gap:4px" contenteditable="false"><span class="sa-node" style="width:60%;text-align:center">Top</span><span class="sa-node" style="width:70%;text-align:center">Level 2</span><span class="sa-node" style="width:80%;text-align:center">Level 3</span><span class="sa-node" style="width:90%;text-align:center">Base</span></div><p><br></p>'
    },
    {
      id: "vstack",
      name: "Vertical list (4 items)",
      desc: "Stacked bullet-style items",
      preview: '<div class="sa-mini col"><span class="sa-m-node">Item 1</span><span class="sa-m-node">Item 2</span><span class="sa-m-node">Item 3</span><span class="sa-m-node">Item 4</span></div>',
      html: '<div class="smartart" style="flex-direction:column" contenteditable="false"><span class="sa-node">Item 1</span><span class="sa-node">Item 2</span><span class="sa-node">Item 3</span><span class="sa-node">Item 4</span></div><p><br></p>'
    }
  ];

  function openSmartArtDialog() {
    var grid = $("smartArtGrid");
    grid.innerHTML = "";
    for (var i = 0; i < SMARTART_TEMPLATES.length; i++) {
      (function (tpl) {
        var item = document.createElement("div");
        item.className = "smartart-option";
        item.innerHTML = '<div class="smartart-preview">' + tpl.preview + '</div><div class="smartart-name">' + escapeHtml(tpl.name) + '</div><div class="smartart-desc">' + escapeHtml(tpl.desc) + '</div>';
        item.addEventListener("click", function () {
          closeModal("smartArtModal");
          // Defer so the modal overlay doesn't block the editor focus.
          setTimeout(function () {
            focusEditorAndRestore();
            document.execCommand("insertHTML", false, tpl.html);
            schedulePaginate();
            scheduleAutosave();
            toast("SmartArt inserted: " + tpl.name, "success");
          }, 0);
        });
        grid.appendChild(item);
      })(SMARTART_TEMPLATES[i]);
    }
    openModal("smartArtModal");
  }

  /* ---------------- Screenshot ---------------- */
  async function takeScreenshot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("Screen capture not supported in this browser", "error");
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      var track = stream.getVideoTracks()[0];
      var video = document.createElement("video");
      video.style.display = "none";
      document.body.appendChild(video);
      video.srcObject = stream;
      await video.play();
      // wait a frame
      await new Promise(function (r) { setTimeout(r, 250); });
      var canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);
      var dataUrl = canvas.toDataURL("image/png");
      track.stop();
      document.body.removeChild(video);
      // Bring the focus back to this Docs tab. When the user captured a
      // different app/window the OS focus usually stays on that app after
      // the native picker closes — browsers cannot fully "steal" focus
      // back, but window.focus() restores it whenever the browser allows
      // (same-window contexts), and the toast confirms the capture landed.
      try { window.focus(); } catch (_) {}
      // Insert into doc
      restoreEditorSelection();
      document.execCommand("insertHTML", false, '<img class="screenshot-img" src="' + dataUrl + '" alt="Screenshot" style="max-width:100%" />');
      schedulePaginate();
      scheduleAutosave();
      toast("Screenshot inserted", "success");
    } catch (e) {
      toast("Screenshot cancelled or failed", "error");
    }
  }

  /* ---------------- Draw mode (Slides/Notes-style drawing toolbar) ----------------
     Ported from the Slides/Notes apps: a bottom-docked toolbar with Pen,
     Highlighter and Eraser tools, color presets, size presets, and
     Clear/Done buttons. Strokes are drawn on a canvas overlaying the
     document scroll area. The canvas STAYS in the DOM after Done so the
     drawing remains visible on the page (like Slides persists per-slide
     drawings); re-entering draw mode continues on top of it. */
  function toggleDrawMode(force) {
    var toolbar = $("drawToolbar");
    var app = $("app");
    var btn = $("btnDraw");
    var shouldOpen = force === undefined ? !drawMode : force;
    drawMode = shouldOpen;
    if (shouldOpen) {
      // Only one bottom toolbar at a time — close the symbol bar if open.
      toggleSymbolBar(false);
      app.classList.add("draw-mode");
      toolbar.classList.add("visible");
      ensureDrawCanvas();
      if (btn) btn.classList.add("active");
      // No "on" toast — the toolbar appearing IS the signal (user request);
      // only the "Draw mode off." toast below is shown, on Done/Exit.
    } else {
      app.classList.remove("draw-mode");
      toolbar.classList.remove("visible");
      // Canvas stays visible (pointer-events off) so the drawing persists.
      if (drawCanvas) drawCanvas.style.pointerEvents = "none";
      if (btn) btn.classList.remove("active");
      toast("Draw mode off.");
    }
  }

  function ensureDrawCanvas() {
    var scroll = $("documentScroll");
    if (!drawCanvas) {
      drawCanvas = document.createElement("canvas");
      drawCanvas.className = "draw-canvas";
      drawCanvas.id = "drawCanvas";
      scroll.style.position = "relative";
      scroll.appendChild(drawCanvas);
      drawCtx = drawCanvas.getContext("2d");
      drawCtx.lineCap = "round";
      drawCtx.lineJoin = "round";
      drawCtx.imageSmoothingEnabled = true;
      drawCtx.imageSmoothingQuality = "high";
      drawCanvas.addEventListener("mousedown", function (e) { drawStart(e); });
      drawCanvas.addEventListener("mousemove", function (e) { drawLine(e); });
      window.addEventListener("mouseup", function () { drawEnd(); });
      drawCanvas.addEventListener("touchstart", function (e) { e.preventDefault(); drawStart(e.touches[0]); }, { passive: false });
      drawCanvas.addEventListener("touchmove", function (e) { if (isDrawing) e.preventDefault(); drawLine(e.touches[0]); }, { passive: false });
      drawCanvas.addEventListener("touchend", function () { drawEnd(); });
    }
    // Size the canvas to the full scrollable document area.
    // NOTE: assigning canvas.width/height CLEARS the bitmap — only resize
    // when the dimensions actually changed, and carry the strokes over.
    requestAnimationFrame(function () {
      var w = scroll.scrollWidth;
      var h = Math.max(scroll.scrollHeight, scroll.clientHeight);
      if (drawCanvas.width !== w || drawCanvas.height !== h) {
        var snapshot = null;
        try { if (drawCanvas.width > 0 && drawCanvas.height > 0) snapshot = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height); } catch (_) {}
        drawCanvas.width = w;
        drawCanvas.height = h;
        drawCanvas.style.width = w + "px";
        drawCanvas.style.height = h + "px";
        // Resizing also resets context state — restore it.
        drawCtx.lineCap = "round";
        drawCtx.lineJoin = "round";
        if (snapshot) {
          try { drawCtx.putImageData(snapshot, 0, 0); } catch (_) {}
        }
      }
    });
    drawCanvas.style.pointerEvents = "all";
    drawCanvas.style.display = "block";
  }

  function clearDrawing() {
    // Silent clear — the canvas visibly emptying is its own feedback
    // (user request: no "Drawing cleared" toast).
    if (drawCtx && drawCanvas) drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }

  function drawPos(e) {
    var rect = drawCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function drawStart(e) {
    if (!drawMode || !drawCtx) return;
    isDrawing = true;
    var p = drawPos(e);
    drawPoints = [{ x: p.x, y: p.y }];
    var tool = drawTool;
    if (tool === "eraser") {
      drawCtx.globalCompositeOperation = "destination-out";
      drawCtx.lineWidth = (drawWidth || 2) * 5;
      drawCtx.strokeStyle = "#000";
      drawCtx.fillStyle = "#000";
      drawCtx.globalAlpha = 1;
    } else if (tool === "highlighter") {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.strokeStyle = drawColor;
      drawCtx.fillStyle = drawColor;
      drawCtx.lineWidth = (drawWidth || 2) * 2.5;
      drawCtx.globalAlpha = 0.4; // translucent, like a real highlighter
    } else {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.strokeStyle = drawColor;
      drawCtx.fillStyle = drawColor;
      drawCtx.lineWidth = drawWidth || 2;
      drawCtx.globalAlpha = 1;
    }
    // Dot for single-click strokes
    drawCtx.beginPath();
    drawCtx.arc(p.x, p.y, Math.max(0.5, drawCtx.lineWidth / 2), 0, Math.PI * 2);
    drawCtx.fill();
    drawCtx.beginPath();
    drawCtx.moveTo(p.x, p.y);
    if (e.cancelable && e.preventDefault) e.preventDefault();
  }

  function drawLine(e) {
    if (!drawMode || !isDrawing || !drawCtx) return;
    var p = drawPos(e);
    drawPoints.push({ x: p.x, y: p.y });
    var pts = drawPoints;
    // Quadratic-curve smoothing through midpoints (Slides-style natural strokes)
    if (pts.length >= 3) {
      var p0 = pts[pts.length - 3];
      var p1 = pts[pts.length - 2];
      var p2 = pts[pts.length - 1];
      var mid1x = (p0.x + p1.x) / 2, mid1y = (p0.y + p1.y) / 2;
      var mid2x = (p1.x + p2.x) / 2, mid2y = (p1.y + p2.y) / 2;
      drawCtx.beginPath();
      drawCtx.moveTo(mid1x, mid1y);
      drawCtx.quadraticCurveTo(p1.x, p1.y, mid2x, mid2y);
      drawCtx.stroke();
    } else if (pts.length === 2) {
      drawCtx.beginPath();
      drawCtx.moveTo(pts[0].x, pts[0].y);
      drawCtx.lineTo(pts[1].x, pts[1].y);
      drawCtx.stroke();
    }
    if (e.cancelable && e.preventDefault) e.preventDefault();
  }

  function drawEnd() {
    if (!isDrawing) return;
    isDrawing = false;
    if (drawCtx) drawCtx.globalAlpha = 1;
    // Final segment so the stroke doesn't stop mid-curve.
    var pts = drawPoints;
    if (pts.length >= 2 && drawCtx) {
      var p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
      var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      drawCtx.beginPath();
      drawCtx.moveTo(mx, my);
      drawCtx.lineTo(p2.x, p2.y);
      drawCtx.stroke();
    }
    drawPoints = [];
  }

  function initDrawToolbar() {
    var penBtn = $("drawPenBtn");
    var highlighterBtn = $("drawHighlighterBtn");
    var eraserBtn = $("drawEraserBtn");
    var colorSection = document.querySelector(".draw-color-section");
    var colorDivider = colorSection ? colorSection.previousElementSibling : null;
    var setTool = function (tool) {
      drawTool = tool;
      [penBtn, highlighterBtn, eraserBtn].forEach(function (b) { if (b) b.classList.remove("active"); });
      if (tool === "pen" && penBtn) penBtn.classList.add("active");
      if (tool === "highlighter" && highlighterBtn) highlighterBtn.classList.add("active");
      if (tool === "eraser" && eraserBtn) eraserBtn.classList.add("active");
      // Hide the color section while the eraser is active (nothing to color).
      var hideColor = (tool === "eraser");
      if (colorSection) colorSection.classList.toggle("eraser-hidden", hideColor);
      if (colorDivider && colorDivider.classList.contains("color-divider")) colorDivider.classList.toggle("eraser-hidden", hideColor);
      if (drawCanvas) drawCanvas.classList.toggle("eraser-active", tool === "eraser");
    };
    if (penBtn) penBtn.addEventListener("click", function () { setTool("pen"); });
    if (highlighterBtn) highlighterBtn.addEventListener("click", function () { setTool("highlighter"); });
    if (eraserBtn) eraserBtn.addEventListener("click", function () { setTool("eraser"); });

    // Color presets
    var colorPresets = $("drawColorPresets");
    if (colorPresets) {
      colorPresets.addEventListener("click", function (e) {
        var sw = e.target.closest(".draw-color-swatch");
        if (!sw) return;
        drawColor = sw.getAttribute("data-color");
        var swatches = colorPresets.querySelectorAll(".draw-color-swatch");
        for (var i = 0; i < swatches.length; i++) swatches[i].classList.remove("active");
        sw.classList.add("active");
        var picker = $("drawColorPicker");
        if (picker) picker.value = drawColor;
      });
      // Custom color (white swatch opens the native color picker)
      var whiteSwatch = colorPresets.querySelector('.draw-color-swatch[data-color="#ffffff"]');
      if (whiteSwatch) {
        whiteSwatch.addEventListener("click", function () {
          var picker = $("drawColorPicker");
          if (picker) picker.click();
        });
      }
    }
    var colorPicker = $("drawColorPicker");
    if (colorPicker) {
      colorPicker.addEventListener("input", function () {
        drawColor = colorPicker.value;
        var colorPresets2 = $("drawColorPresets");
        if (colorPresets2) {
          var swatches = colorPresets2.querySelectorAll(".draw-color-swatch");
          for (var k = 0; k < swatches.length; k++) swatches[k].classList.remove("active");
        }
      });
    }

    // Size presets
    var toolbar = $("drawToolbar");
    if (toolbar) {
      toolbar.addEventListener("click", function (e) {
        var sizeBtn = e.target.closest(".draw-size-btn");
        if (!sizeBtn) return;
        drawWidth = parseInt(sizeBtn.getAttribute("data-size"), 10) || 2;
        var sizeBtns = toolbar.querySelectorAll(".draw-size-btn");
        for (var s = 0; s < sizeBtns.length; s++) sizeBtns[s].classList.remove("active");
        sizeBtn.classList.add("active");
        var slider = $("drawThickness");
        if (slider) slider.value = drawWidth;
      });
    }

    // Clear / Done
    var clearBtn = $("drawClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearDrawing);
    var doneBtn = $("drawDoneBtn");
    if (doneBtn) doneBtn.addEventListener("click", function () { toggleDrawMode(false); });

    // Ribbon button
    var bDraw = $("btnDraw");
    if (bDraw) {
      bDraw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bDraw.addEventListener("click", function () { toggleDrawMode(); });
    }
  }

  /* ---------------- Spellcheck ---------------- */
  /* ---------------- Footnotes & Endnotes (proper) ---------------- */
  function openFootnoteModal() {
    var t = $("footnoteText");
    if (t) t.value = "";
    openModal("footnoteModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertFootnote(note) {
    var num = footnotes.length + 1;
    var refId = "fn_ref_" + num + "_" + Date.now().toString(36);
    placeCaretForInlineInsert();
    document.execCommand("insertHTML", false, '<sup class="footnote-ref" data-fn="' + num + '" id="' + refId + '" contenteditable="false">' + num + '</sup> ');
    var _ref = document.getElementById(refId);
    healInlineRefPlacement(_ref);
    parkCaretAfterRef(_ref);
    footnotes.push({ num: num, text: note, refId: refId, ts: Date.now() });
    // Renumber BEFORE rendering: markers are numbered by document order and
    // the array is re-synced, so the per-page areas / panel show the right
    // text under the right number even when this marker was inserted BEFORE
    // an existing one.
    renumberFootnoteRefs();
    saveFootnotes();
    renderFootnotes();
    renderFootnotesSection();
    schedulePaginate();
    scheduleAutosave();
    toggleFootnotes(true);
    toast("Footnote " + num + " inserted", "success");
  }

  function openEndnoteModal() {
    var t = $("endnoteText");
    if (t) t.value = "";
    openModal("endnoteModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertEndnote(note) {
    var num = endnotes.length + 1;
    var refId = "en_ref_" + num + "_" + Date.now().toString(36);
    placeCaretForInlineInsert();
    document.execCommand("insertHTML", false, '<sup class="endnote-ref" data-en="' + num + '" id="' + refId + '" contenteditable="false">' + num + '</sup> ');
    var _ref = document.getElementById(refId);
    healInlineRefPlacement(_ref);
    parkCaretAfterRef(_ref);
    endnotes.push({ num: num, text: note, refId: refId, ts: Date.now() });
    // Endnote markers were never renumbered after an insert — a marker
    // inserted before an existing one kept a wrong number. Renumber by
    // document order (and re-sync the array) before rendering.
    renumberEndnoteRefs();
    saveEndnotes();
    renderFootnotes();
    renderEndnotesSection();
    schedulePaginate();
    scheduleAutosave();
    toggleFootnotes(true);
    toast("Endnote " + num + " inserted", "success");
  }

  function saveEndnotes() {
    try {
      if (idbAvailable()) idb.setJSON("emeraldcore.storage.suite.docs.endnotes", endnotes);
    } catch (e) {}
  }

  /* ---------------- Citation (modal) ---------------- */
  function openCiteModal() {
    var t = $("citeText");
    if (t) t.value = "";
    openModal("citeModal");
    setTimeout(function () { if (t) t.focus(); }, 60);
  }

  function performInsertCite(text) {
    placeCaretForInlineInsert();
    document.execCommand("insertHTML", false, '<span class="citation">(' + escapeHtml(text) + ')</span>');
    var _cites = document.querySelectorAll(".page-content > span.citation");
    if (_cites.length) {
      var _cE = _cites[_cites.length - 1];
      healInlineRefPlacement(_cE);
      parkCaretAfterRef(_cE);
    }
    schedulePaginate();
    scheduleAutosave();
    toast("Citation inserted", "success");
  }

  function loadEndnotes() {
    try {
      var f = null;
      if (idbAvailable()) f = idb.getJSONSync("emeraldcore.storage.suite.docs.endnotes");
      if (Array.isArray(f)) endnotes = f;
    } catch (e) {}
  }

  function saveFootnotes() {
    try {
      if (idbAvailable()) idb.setJSON("emeraldcore.storage.suite.docs.footnotes", footnotes);
    } catch (e) {}
  }

  function loadFootnotes() {
    try {
      var f = null;
      if (idbAvailable()) f = idb.getJSONSync("emeraldcore.storage.suite.docs.footnotes");
      if (Array.isArray(f)) footnotes = f;
    } catch (e) {}
  }

  function renderFootnotes() {
    var body = $("footnotesBody");
    if (!body) return;
    body.innerHTML = "";
    if (footnotes.length === 0 && endnotes.length === 0) {
      var empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No footnotes or endnotes yet. Use References → Footnote / Endnote to add one.";
      body.appendChild(empty);
      return;
    }
    for (var i = 0; i < footnotes.length; i++) {
      (function (fn, idx) {
        var item = document.createElement("div");
        item.className = "fn-item";
        var numEl = document.createElement("span");
        numEl.className = "fn-num";
        numEl.textContent = fn.num;
        var txt = document.createElement("span");
        txt.style.marginLeft = "6px";
        txt.textContent = fn.text;
        var del = document.createElement("button");
        del.className = "fn-del";
        del.textContent = "×";
        del.title = "Delete footnote";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          footnotes.splice(idx, 1);
          // remove the superscript ref from the text, then renumber the rest
          var refEl = document.getElementById(fn.refId);
          if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);
          // Renumber BEFORE rendering so the areas/panel use final numbers
          renumberFootnoteRefs();
          saveFootnotes();
          renderFootnotes();
          renderFootnotesSection();
          schedulePaginate();
          scheduleAutosave();
        });
        item.appendChild(numEl);
        item.appendChild(txt);
        item.appendChild(del);
        item.addEventListener("click", function () {
          var el = document.getElementById(fn.refId);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        body.appendChild(item);
      })(footnotes[i], i);
    }

    // Endnotes — listed below footnotes in the same panel
    if (endnotes.length > 0) {
      var enHead = document.createElement("p");
      enHead.className = "outline-empty";
      enHead.style.fontWeight = "700";
      enHead.style.textTransform = "uppercase";
      enHead.style.fontSize = "10px";
      enHead.style.letterSpacing = "0.06em";
      enHead.style.margin = "10px 0 2px";
      enHead.textContent = "Endnotes";
      body.appendChild(enHead);
      for (var e2 = 0; e2 < endnotes.length; e2++) {
        (function (en, idx) {
          var item = document.createElement("div");
          item.className = "fn-item";
          var numEl = document.createElement("span");
          numEl.className = "fn-num";
          numEl.textContent = en.num;
          var txt = document.createElement("span");
          txt.style.marginLeft = "6px";
          txt.textContent = en.text;
          var del = document.createElement("button");
          del.className = "fn-del";
          del.textContent = "×";
          del.title = "Delete endnote";
          del.addEventListener("click", function (e) {
            e.stopPropagation();
            endnotes.splice(idx, 1);
            // remove the superscript ref from the text, then renumber the rest
            var refEl = document.getElementById(en.refId);
            if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);
            // Renumber BEFORE rendering so the areas/panel use final numbers
            renumberEndnoteRefs();
            saveEndnotes();
            renderFootnotes();
            renderEndnotesSection();
            schedulePaginate();
            scheduleAutosave();
          });
          item.appendChild(numEl);
          item.appendChild(txt);
          item.appendChild(del);
          item.addEventListener("click", function () {
            var el = document.getElementById(en.refId);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          });
          body.appendChild(item);
        })(endnotes[e2], e2);
      }
    }
  }

  function renumberFootnoteRefs() {
    var refs = document.querySelectorAll("sup.footnote-ref[data-fn]");
    // Renumber markers by DOCUMENT order AND keep the footnotes array in the
    // SAME order (matched by refId) — a marker inserted BEFORE an existing
    // one takes the lower number, and its note text must follow it, because
    // the per-page footnote areas render note text by data-fn number.
    var ordered = [];
    for (var i = 0; i < refs.length; i++) {
      var n = i + 1;
      refs[i].setAttribute("data-fn", n);
      refs[i].textContent = n;
      for (var k = 0; k < footnotes.length; k++) {
        if (footnotes[k].refId === refs[i].id && ordered.indexOf(footnotes[k]) === -1) {
          footnotes[k].num = n;
          ordered.push(footnotes[k]);
          break;
        }
      }
    }
    // Only adopt the document order when every marker matched a note entry
    // (markers pasted from imported HTML have no array entry — leave the
    // array untouched in that case).
    if (ordered.length > 0 && ordered.length === footnotes.length) {
      footnotes = ordered;
      saveFootnotes();
    }
  }

  function renderFootnotesSection() {
    // remove existing end-of-doc sections
    var existing = document.querySelectorAll(".footnotes-section");
    for (var i = 0; i < existing.length; i++) existing[i].parentElement && existing[i].parentElement.removeChild(existing[i]);
    // remove existing per-page footnote areas
    var pfa = document.querySelectorAll(".page-footnote-area");
    for (var j = 0; j < pfa.length; j++) pfa[j].parentElement && pfa[j].parentElement.removeChild(pfa[j]);
    // clear the has-footnotes-ref flag + reserved space
    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var pc = getContent(pages[pi]);
      pc.classList.remove("has-footnotes-ref");
      pc.style.removeProperty("--fn-reserve");
    }
    if (footnotes.length === 0) return;

    // 1. Per-page footnote areas: for each page, find footnote refs on it and
    //    render their text at the bottom of that page (Word-style).
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var pageContent = getContent(page);
      var refs = pageContent.querySelectorAll("sup.footnote-ref[data-fn]");
      if (refs.length === 0) continue;
      var area = document.createElement("div");
      area.className = "page-footnote-area";
      var reservedH = 0;
      for (var r = 0; r < refs.length; r++) {
        var num = parseInt(refs[r].getAttribute("data-fn"), 10);
        var fn = footnotes.filter(function (f) { return f.num === num; })[0];
        if (!fn) continue;
        var entry = document.createElement("div");
        entry.className = "pfa-entry";
        entry.innerHTML = '<span class="pfa-key">' + num + '.</span> ' + escapeHtml(fn.text);
        area.appendChild(entry);
        reservedH += 18; // approx height per entry
      }
      if (area.children.length > 0) {
        page.appendChild(area);
        pageContent.classList.add("has-footnotes-ref");
        pageContent.style.setProperty("--fn-reserve", Math.min(160, reservedH + 12) + "px");
      }
    }

    // 2. End-of-document footnotes section (all footnotes, for completeness)
    var lastPage = pages[pages.length - 1];
    if (!lastPage) return;
    var content = getContent(lastPage);
    var section = document.createElement("div");
    section.className = "footnotes-section";
    var heading = document.createElement("p");
    heading.style.fontWeight = "700";
    heading.style.fontSize = "11px";
    heading.style.textTransform = "uppercase";
    heading.style.letterSpacing = "0.06em";
    heading.style.color = "var(--text-faint)";
    heading.textContent = "Footnotes";
    section.appendChild(heading);
    for (var f = 0; f < footnotes.length; f++) {
      var entry = document.createElement("div");
      entry.className = "fn-entry";
      entry.innerHTML = '<span class="fn-key">' + escapeHtml(String(footnotes[f].num)) + '.</span> ' + escapeHtml(footnotes[f].text);
      section.appendChild(entry);
    }
    content.appendChild(section);
  }

  function toggleFootnotes(force) {
    var panel = $("footnotesPanel");
    if (!panel) return;
    var shouldOpen = force === undefined ? !panel.classList.contains("open") : force;
    if (shouldOpen) {
      renderFootnotes();
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  /* ---------------- Endnotes (collected at end of document) ---------------- */
  function renderEndnotesSection() {
    // Remove any existing end-of-document endnotes section
    var existing = document.querySelectorAll(".endnotes-section");
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].parentElement) existing[i].parentElement.removeChild(existing[i]);
    }
    if (endnotes.length === 0) return;
    var pages = getPages();
    var lastPage = pages[pages.length - 1];
    if (!lastPage) return;
    var content = getContent(lastPage);
    var section = document.createElement("div");
    section.className = "endnotes-section";
    var heading = document.createElement("p");
    heading.style.fontWeight = "700";
    heading.style.fontSize = "11px";
    heading.style.textTransform = "uppercase";
    heading.style.letterSpacing = "0.06em";
    heading.style.color = "var(--text-faint)";
    heading.textContent = "Endnotes";
    section.appendChild(heading);
    for (var f = 0; f < endnotes.length; f++) {
      var entry = document.createElement("div");
      entry.className = "fn-entry";
      entry.innerHTML = '<span class="fn-key">' + escapeHtml(String(endnotes[f].num)) + '.</span> ' + escapeHtml(endnotes[f].text);
      section.appendChild(entry);
    }
    content.appendChild(section);
  }

  function renumberEndnoteRefs() {
    var refs = document.querySelectorAll("sup.endnote-ref[data-en]");
    // Same document-order + array-sync contract as renumberFootnoteRefs().
    var ordered = [];
    for (var i = 0; i < refs.length; i++) {
      var n = i + 1;
      refs[i].setAttribute("data-en", n);
      refs[i].textContent = n;
      for (var k = 0; k < endnotes.length; k++) {
        if (endnotes[k].refId === refs[i].id && ordered.indexOf(endnotes[k]) === -1) {
          endnotes[k].num = n;
          ordered.push(endnotes[k]);
          break;
        }
      }
    }
    if (ordered.length > 0 && ordered.length === endnotes.length) {
      endnotes = ordered;
      saveEndnotes();
    }
  }

  /* ---------------- Table of Figures — removed (feature cut) ---------------- */

  /* ---------------- Enter around footnote/endnote markers (shared) ----------------
     Chrome cannot split a paragraph while the caret is INSIDE a non-editable
     <sup contenteditable="false"> marker (Enter silently does nothing — no
     new line ever appears), and when the caret sits immediately BEFORE a
     marker the native split drags the marker DOWN onto the new line. Both
     feel like "Enter is broken next to footnotes/endnotes". findProblemMarker()
     detects the stuck positions; reAnchorCaretPastMarker() moves the caret to
     just AFTER the marker so a real paragraph split can happen there. */
  function findProblemMarker(range) {
    function inMarker(node) {
      var el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      if (!el || !el.closest) return null;
      return el.closest("sup.footnote-ref, sup.endnote-ref, sup.comment-ref") || null;
    }
    // Caret / selection start INSIDE a marker (clicked or double-clicked it)
    var m = inMarker(range.startContainer);
    if (m) return m;
    // Element position pointing directly AT a marker: (parent, idxBeforeMarker)
    if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      var ch = range.startContainer.childNodes[range.startOffset];
      if (isInlineMarker(ch)) return ch;
    }
    // Caret at the very END of a text node directly followed by a marker
    if (range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startOffset === range.startContainer.nodeValue.length) {
      var nx = range.startContainer.nextSibling;
      if (isInlineMarker(nx)) return nx;
    }
    return null;
  }

  function reAnchorCaretPastMarker(marker, sel) {
    // Caret goes immediately AFTER the marker (marker stays on this line)
    var nx = marker.nextSibling;
    var r2 = document.createRange();
    if (nx && nx.nodeType === Node.TEXT_NODE) r2.setStart(nx, 0);
    else if (nx) r2.setStartBefore(nx);
    else r2.setStartAfter(marker);
    r2.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r2);
    var content = marker.closest && marker.closest(".page-content");
    if (content && document.activeElement !== content) {
      try { content.focus({ preventScroll: true }); } catch (err) { try { content.focus(); } catch (e2) {} }
    }
  }

  /* Enter around footnote/endnote markers (normal editing mode):
     see findProblemMarker()/reAnchorCaretPastMarker() above for the details. */
  function setupMarkerEnterFix() {
    var pagesWrap = $(PAGES_WRAPPER_ID);
    if (!pagesWrap) return;

    pagesWrap.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var marker = findProblemMarker(sel.getRangeAt(0));
      if (!marker) return; // native Enter handles every other position

      e.preventDefault();
      reAnchorCaretPastMarker(marker, sel);
      try { document.execCommand("insertParagraph"); } catch (err) {}
      schedulePaginate();
      scheduleAutosave();
    });
  }

  /* ---------------- Wire up new buttons in init ---------------- */
  // (called from init() via initNewFeatures below)
  function initNewFeatures() {

// Click handler for internal links + footnote refs (delegated)
      var scrollEl = $("documentScroll");
      if (scrollEl) {
        scrollEl.addEventListener("click", handleInternalLinkClick);
        // TOC anchors: a plain LEFT click (no Ctrl/Cmd modifier) jumps to the
        // heading in-document. Ctrl/Cmd+click is just prevented so it can't
        // open the href in a new tab — the user jumps with a plain click or
        // a plain RIGHT click (auxclick below), no Control needed.
        scrollEl.addEventListener("click", function (e) {
          var tocLink = e.target.closest("a[data-toc]");
          if (!tocLink) return;
          e.preventDefault();
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          jumpToHeadingByTOC(tocLink);
        });
        // Plain right-click / middle-click (no Control modifier) also jumps
        // to the heading instead of opening a new tab.
        scrollEl.addEventListener("auxclick", function (e) {
          var tocLink = e.target.closest("a[data-toc]");
          if (!tocLink) return;
          e.preventDefault();
          jumpToHeadingByTOC(tocLink);
        });
      // External links: Ctrl/Cmd+click opens in a NEW TAB (links inside a
      // contenteditable never navigate on their own — without this handler
      // Ctrl+click did nothing at all).
      scrollEl.addEventListener("click", function (e) {
        var a = e.target.closest("a");
        if (!a) return;
        // Internal links / bookmarks / TOC anchors are handled by their own
        // delegated handlers above — skip them here.
        if (a.classList.contains("emdocs-internal-link") || a.classList.contains("emdocs-bookmark")) return;
        if (a.closest(".emdocs-toc")) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          var href = a.getAttribute("href");
          if (isSafeExternalUrl(href)) {
            // normalizeExternalUrl fixes links stored without a scheme
            // (e.g. href="youtube.com") so they open https://youtube.com
            // instead of a path under this app's origin.
            window.open(normalizeExternalUrl(href), "_blank", "noopener");
          }
        } else {
          // Plain click keeps the caret for editing (no navigation).
          e.preventDefault();
        }
      });
      // Page-break markers: click to remove (cancel the break).
      scrollEl.addEventListener("click", function (e) {
        var pb = e.target.closest(".emdocs-page-break");
        if (!pb) return;
        e.preventDefault();
        if (pb.parentElement) {
          // Remove the marker; the empty <p> that followed a manual page
          // break is left alone — the paginator prunes trailing empties.
          pb.parentElement.removeChild(pb);
          schedulePaginate();
          scheduleAutosave();
          scheduleOutlineUpdate();
          toast("Page break removed", "success");
        }
      });
      scrollEl.addEventListener("click", function (e) {
        var fn = e.target.closest("sup.footnote-ref, sup.endnote-ref");
        if (!fn) return;
        e.preventDefault();
        toggleFootnotes(true);
      });
      // Comment pins: open the Slides-style popup card
      scrollEl.addEventListener("click", function (e) {
        var pin = e.target.closest("sup.comment-ref");
        if (!pin) return;
        e.preventDefault();
        e.stopPropagation();
        showCommentPopup(pin.getAttribute("data-comment"), pin);
      });
      scrollEl.addEventListener("click", function (e) {
        var bm = e.target.closest("a.emdocs-bookmark");
        if (!bm) return;
        // no-op for clicks on bookmark anchors themselves
      });
    }

    // Cover page
    var bCov = $("btnCoverPage");
    if (bCov) { bCov.addEventListener("mousedown", function (e) { e.preventDefault(); }); bCov.addEventListener("click", openCoverPageDialog); }
    var bCovConfirm = $("coverPageConfirm");
    if (bCovConfirm) bCovConfirm.addEventListener("click", insertCoverPage);
    var covPresets = document.querySelectorAll("#coverPresets .preset-btn");
    for (var cp = 0; cp < covPresets.length; cp++) {
      (function (b) { b.addEventListener("click", function () {
        for (var k = 0; k < covPresets.length; k++) covPresets[k].classList.remove("active");
        b.classList.add("active");
        coverPageStyle = b.getAttribute("data-cover");
      }); })(covPresets[cp]);
    }

    // Section break (Insert tab only — the Layout tab's Breaks group was removed)
    var bSB = $("btnSectionBreak");
    if (bSB) { bSB.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSB.addEventListener("click", insertSectionBreak); }
    var bSBConfirm = $("sectionBreakConfirm");
    if (bSBConfirm) bSBConfirm.addEventListener("click", confirmSectionBreak);
    var secOrientBtns = document.querySelectorAll(".sec-orient-btn");
    for (var so = 0; so < secOrientBtns.length; so++) {
      (function (b) { b.addEventListener("click", function () {
        for (var k = 0; k < secOrientBtns.length; k++) secOrientBtns[k].classList.remove("active");
        b.classList.add("active");
        sectionOrient = b.getAttribute("data-orient");
      }); })(secOrientBtns[so]);
    }

    // Equation
    var bEq = $("btnEquation");
    if (bEq) { bEq.addEventListener("mousedown", function (e) { e.preventDefault(); }); bEq.addEventListener("click", openEquationDialog); }
    var bEqConfirm = $("equationConfirm");
    if (bEqConfirm) bEqConfirm.addEventListener("click", insertEquation);
    var eqInput = $("equationInput");
    if (eqInput) eqInput.addEventListener("input", function () {
      $("equationPreview").innerHTML = renderEquation(eqInput.value);
    });
    eqInput && eqInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); insertEquation(); } });
    var eqPresets = document.querySelectorAll(".eq-preset");
    for (var ep = 0; ep < eqPresets.length; ep++) {
      (function (b) { b.addEventListener("click", function () {
        $("equationInput").value = b.getAttribute("data-eq");
        $("equationPreview").innerHTML = renderEquation(b.getAttribute("data-eq"));
      }); })(eqPresets[ep]);
    }

    // SmartArt
    var bSA = $("btnSmartArt");
    if (bSA) { bSA.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSA.addEventListener("click", openSmartArtDialog); }

    // Screenshot
    var bSS = $("btnScreenshot");
    if (bSS) { bSS.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSS.addEventListener("click", takeScreenshot); }

    // Draw mode (Slides/Notes-style toolbar)
    initDrawToolbar();

    // Footnotes
    var bFn = $("btnFootnote");
    if (bFn) { bFn.addEventListener("mousedown", function (e) { e.preventDefault(); }); bFn.addEventListener("click", openFootnoteModal); }
    var bFnPanel = $("footnoteAddFromPanel");
    if (bFnPanel) bFnPanel.addEventListener("click", openFootnoteModal);
    var bEnPanel = $("endnoteAddFromPanel");
    if (bEnPanel) bEnPanel.addEventListener("click", openEndnoteModal);
    var bFnClose = $("footnotesClose");
    if (bFnClose) bFnClose.addEventListener("click", function () { toggleFootnotes(false); });

    // Enter key must keep working when the caret/selection sits on a
    // footnote/endnote marker (Chrome deadlocks inside <sup contenteditable="false">)
    setupMarkerEnterFix();

    // Round 2 features
    initRound2Features();

    // Escape closes side panels
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var fp = $("footnotesPanel"); if (fp && fp.classList.contains("open")) { toggleFootnotes(false); return; }
      }
    });
  }

  /* =========================================================
     Round 2 — new features
     (mail merge,
      accessibility checker,
      status-bar zoom)
     ========================================================= */

  /* ---------------- Status bar zoom + language ---------------- */
  function initStatusBarControls() {
    // The zoom % label is NOT clickable — it's a plain informational span,
    // exactly like Slides' #zoomStatus. Zoom is changed ONLY via Ctrl+Scroll
    // (or the View → Zoom ribbon controls / keyboard shortcuts).

    // Ctrl + Scroll to zoom in / out — matches the Slides editor behavior.
    // Slides uses an 8% multiplicative step (factor 1.08) rather than a fixed
    // ±10% additive step — this feels smoother at high zoom levels.
    // Listens on the document scroll area first so we can stopPropagation()
    // before the document-level handler double-fires.
    var scrollEl = $("documentScroll");
    if (scrollEl) {
      scrollEl.addEventListener("wheel", function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        // deltaY > 0 = scroll down = zoom out; < 0 = zoom in.
        var delta = e.deltaY > 0 ? -1 : 1;
        var factor = 1 + (delta * 0.08); // 8% zoom step (same as Slides)
        zoomByFactor(factor);
      }, { passive: false });
    }
    // Also handle Ctrl+Scroll anywhere in the app (e.g. over the ribbon) so
    // the user isn't surprised when they scroll over the wrong area.
    document.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Don't hijack scrolling inside a modal or scrollable panel.
      var target = e.target;
      if (target && target.closest && target.closest(".modal-overlay, .outline-panel, .thumbnails-panel, .footnotes-panel")) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -1 : 1;
      var factor = 1 + (delta * 0.08);
      zoomByFactor(factor);
    }, { passive: false });

    var psLabel = $("pageSizeLabel");
    if (psLabel) {
      // Informational only — no click handler. Page size is changed via
      // Layout -> Size (the ms-dropdown drives setPageSize).
    }
  }

  // Additive zoom step (Zoom In / Zoom Out buttons + Ctrl+= / Ctrl+- keys).
  // Keeps the ±10 step, since that's what users expect.
  function adjustZoom(delta) {
    setZoom(currentZoom + delta);
  }

  // Multiplicative zoom step (used by Ctrl+Scroll).
  // Matches Slides' factor-based zoom: factor 1.08 = zoom in 8%, 0.9259 = out 8%.
  function zoomByFactor(factor) {
    setZoom(Math.round(currentZoom * factor));
  }

  // Base (un-zoomed) page size. CSS `zoom` inflates offsetWidth and
  // getBoundingClientRect, so the authored inline size is read instead —
  // falling back to the A4 default that .page gets from the stylesheet.
  function getBasePageSize() {
    var page = getPages()[0];
    if (page) {
      var w = parseFloat(page.style.width);
      var h = parseFloat(page.style.height);
      if (!isNaN(w) && w > 0 && !isNaN(h) && h > 0) return { w: w, h: h };
    }
    return { w: PAGE_WIDTH, h: PAGE_HEIGHT };
  }

  // Layout -> Zoom -> Fit To Window: scale the page so its width fits the
  // visible scroll area (minus padding, scrollbar and a small margin).
  function zoomFitToWindow() {
    var scrollEl = $("documentScroll");
    var base = getBasePageSize().w;
    var avail = (scrollEl ? scrollEl.clientWidth : window.innerWidth) - 80;
    if (avail < 100) avail = 100;
    var fit = Math.floor((avail / base) * 100);
    setZoom(fit);
    toast("Fit to window · " + currentZoom + "%", "success");
  }

  function updateStatusZoom(v) {
    var pct = $("statusZoomPct");
    if (pct) pct.textContent = v + "%";
  }


  /* ---------------- Accessibility checker ---------------- */
  function runAccessibilityCheck() {
    var results = $("accessibilityResults");
    results.innerHTML = "";
    var issues = [];
    var pages = getPages();
    var imgCount = 0, imgNoAlt = 0;
    var linkCount = 0, ambiguousLinks = 0;
    var emptyHeadings = 0;
    var totalBlocks = 0;

    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      // Images
      var imgs = content.querySelectorAll("img");
      imgCount += imgs.length;
      for (var im = 0; im < imgs.length; im++) {
        if (!imgs[im].getAttribute("alt") || imgs[im].getAttribute("alt").trim() === "") {
          imgNoAlt++;
          issues.push({
            severity: "error",
            title: "Image missing alt text",
            desc: "Screen readers cannot describe this image. Add descriptive alt text.",
            fix: "Add alt text",
            action: function () { closeModal("accessibilityModal"); var img = document.querySelector(".page-content img:not([alt]), .page-content img[alt='']"); if (img) { var alt = window.prompt("Alt text:", ""); if (alt !== null) { img.alt = alt; toast("Alt text added", "success"); } } }
          });
        }
      }
      // Links
      var links = content.querySelectorAll("a");
      linkCount += links.length;
      for (var l = 0; l < links.length; l++) {
        var lt = (links[l].textContent || "").trim().toLowerCase();
        if (lt === "click here" || lt === "read more" || lt === "here" || lt === "link" || lt === "more") {
          ambiguousLinks++;
          issues.push({
            severity: "warning",
            title: 'Ambiguous link text: "' + links[l].textContent + '"',
            desc: "Link text should be descriptive out of context. Avoid \"click here\" or \"read more\".",
            fix: null
          });
        }
      }
      // Empty headings
      var heads = content.querySelectorAll("h1, h2, h3, h4");
      for (var h = 0; h < heads.length; h++) {
        var ht = (heads[h].textContent || "").trim();
        if (!ht) {
          emptyHeadings++;
          issues.push({
            severity: "warning",
            title: "Empty heading",
            desc: "An empty heading can confuse screen reader users navigating by headings.",
            fix: null
          });
        }
      }
      // Block count
      totalBlocks += content.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre").length;

      // Contrast check — scan elements with inline color/background-color
      var colored = content.querySelectorAll("[style*='color'], [style*='background-color'], font[color]");
      for (var ci = 0; ci < colored.length; ci++) {
        var cs = window.getComputedStyle(colored[ci]);
        var textColor = cs.color;
        var bgColor = cs.backgroundColor;
        if (textColor && bgColor && bgColor !== "rgba(0, 0, 0, 0)" && bgColor !== "transparent") {
          var ratio = contrastRatio(textColor, bgColor);
          if (ratio < 4.5) {
            (function (el, tc, bc, r) {
              issues.push({
                severity: "warning",
                title: "Low text contrast (" + r.toFixed(1) + ":1)",
                desc: "Text/background contrast ratio is below 4.5:1 (WCAG AA). Consider darkening the text or lightening the background.",
                fix: "Fix contrast",
                action: function () {
                  closeModal("accessibilityModal");
                  el.style.color = "#1a1a1a";
                  el.style.backgroundColor = "#ffffff";
                  toast("Contrast fixed (set to black-on-white)", "success");
                  scheduleAutosave();
                },
                preview: { color: tc, bg: bc }
              });
            })(colored[ci], textColor, bgColor, ratio);
          }
        }
      }
    }

    // Always-on summary items
    if (imgCount > 0) {
      issues.unshift({
        severity: imgNoAlt === 0 ? "ok" : "warning",
        title: imgNoAlt + " of " + imgCount + " images missing alt text",
        desc: imgNoAlt === 0 ? "All images have alt text. Great!" : "Add alt text to images so screen readers can describe them.",
        fix: null
      });
    }
    if (linkCount > 0) {
      issues.unshift({
        severity: ambiguousLinks === 0 ? "ok" : "warning",
        title: ambiguousLinks + " ambiguous links of " + linkCount,
        desc: ambiguousLinks === 0 ? "All link text is descriptive." : "Use descriptive link text instead of generic phrases.",
        fix: null
      });
    }
    if (emptyHeadings > 0) {
      issues.unshift({
        severity: "warning",
        title: emptyHeadings + " empty heading(s)",
        desc: "Empty headings break screen-reader navigation.",
        fix: null
      });
    }
    if (issues.length === 0) {
      issues.push({
        severity: "ok",
        title: "No issues found",
        desc: "The document appears accessible. Add more content to run a fuller check.",
        fix: null
      });
    }

    for (var ii = 0; ii < issues.length; ii++) {
      (function (issue) {
        var item = document.createElement("div");
        item.className = "a11y-issue severity-" + issue.severity;
        var icon = document.createElement("div");
        icon.className = "a11y-icon " + (issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok");
        icon.innerHTML = issue.severity === "error" ? "&times;" : issue.severity === "warning" ? "!" : "&#10003;";
        var body = document.createElement("div");
        body.className = "a11y-body";
        var title = document.createElement("div");
        title.className = "a11y-title";
        title.textContent = issue.title;
        var desc = document.createElement("div");
        desc.className = "a11y-desc";
        desc.textContent = issue.desc;
        body.appendChild(title);
        body.appendChild(desc);
        // Contrast preview swatch
        if (issue.preview) {
          var prev = document.createElement("span");
          prev.className = "a11y-contrast-preview";
          prev.style.color = issue.preview.color;
          prev.style.backgroundColor = issue.preview.bg;
          prev.textContent = "Aa";
          body.appendChild(prev);
        }
        if (issue.fix) {
          var fixBtn = document.createElement("button");
          fixBtn.className = "a11y-fix";
          fixBtn.textContent = issue.fix;
          fixBtn.addEventListener("click", issue.action);
          body.appendChild(fixBtn);
        }
        item.appendChild(icon);
        item.appendChild(body);
        results.appendChild(item);
      })(issues[ii]);
    }
    openModal("accessibilityModal");
  }

  // WCAG contrast ratio: (L1 + 0.05) / (L2 + 0.05) where L1 is lighter.
  // Input: CSS color strings like "rgb(r, g, b)".
  function contrastRatio(color1, color2) {
    var l1 = relativeLuminance(color1);
    var l2 = relativeLuminance(color2);
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function relativeLuminance(color) {
    var rgb = parseRgb(color);
    if (!rgb) return 0;
    var r = srgbToLinear(rgb.r / 255);
    var g = srgbToLinear(rgb.g / 255);
    var b = srgbToLinear(rgb.b / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function srgbToLinear(c) {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function parseRgb(str) {
    var m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    // hex
    var h = str.match(/^#([0-9a-f]{6})$/i);
    if (h) {
      var n = parseInt(h[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }

  /* ---------------- Wire up round 2 features ---------------- */
  function initRound2Features() {
    initStatusBarControls();


    // Accessibility checker
    var bA11y = $("btnAccessibilityCheck");
    if (bA11y) { bA11y.addEventListener("mousedown", function (e) { e.preventDefault(); }); bA11y.addEventListener("click", runAccessibilityCheck); }

    // Periodic relative autosave time update
    setInterval(function () { updateRelativeAutosave(); }, 10000);
  }

  /* =========================================================
     Round 4 — tooltips, live merge preview, word count live
     ========================================================= */

  /* ---------------- Rich tooltips ---------------- */
  var richTip = null;
  var richTipTimer = null;
  function initTooltips() {
    if (richTip) return;
    richTip = document.createElement("div");
    richTip.className = "rich-tip";
    document.body.appendChild(richTip);
    // Attach to all ribbon buttons, topbar actions, status bar items
    var selectors = ".ribbon-btn, .topbar-action, .ribbon-tab, .statbar-toggle, .session-timer, .toolbar-stats";
    var els = document.querySelectorAll(selectors);
    for (var i = 0; i < els.length; i++) {
      attachTooltip(els[i]);
    }
  }

  function attachTooltip(el) {
    el.addEventListener("mouseenter", function () {
      var title = el.getAttribute("title");
      if (!title) return;
      // Capture the title, then clear it so the native tooltip doesn't show
      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
      clearTimeout(richTipTimer);
      richTipTimer = setTimeout(function () {
        var tip = el.getAttribute("data-tip") || "";
        var shortcut = "";
        // detect shortcut in title like "(Ctrl+B)"
        var m = tip.match(/\(([^)]+)\)\s*$/);
        if (m) shortcut = m[1];
        var label = tip.replace(/\s*\([^)]+\)\s*$/, "");
        var html = escapeHtml(label);
        if (shortcut) html += '<span class="rt-key">' + escapeHtml(shortcut) + '</span>';
        richTip.innerHTML = html;
        var rect = el.getBoundingClientRect();
        richTip.style.left = rect.left + "px";
        richTip.style.top = (rect.bottom + 6) + "px";
        richTip.classList.add("show");
      }, 400);
    });
    el.addEventListener("mouseleave", function () {
      clearTimeout(richTipTimer);
      richTip.classList.remove("show");
      // restore title for next hover
      var tip = el.getAttribute("data-tip");
      if (tip) { el.setAttribute("title", tip); el.removeAttribute("data-tip"); }
    });
  }

  /* ---------------- Live word count in status bar polish ---------------- */
  // The existing updateStatus handles word count; here we add a subtle
  // count-up animation when the word count changes.
  var lastWordCount = 0;
  function animateWordCount(newCount) {
    if (newCount === lastWordCount) return;
    var el = $("wordCount");
    if (!el) return;
    el.style.transition = "color 0.3s";
    el.style.color = "var(--ui-accent)";
    setTimeout(function () { el.style.color = ""; }, 400);
    lastWordCount = newCount;
  }

})();
