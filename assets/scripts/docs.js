

(function () {
  "use strict";

  var PAGES_WRAPPER_ID = "pagesWrapper";
  var CARET_BLOCK_ATTR = "data-caret-block";
  var CARET_OFFSET_ATTR = "data-caret-offset";

  var DOC_INDEX_KEY = "emeraldcore.storage.suite.docs";
  function docDataKey(id) { return "emeraldcore.storage.suite.docs." + id; }

  function versionsKey(id) { return "emeraldcore.storage.suite.docs.versions." + id; }
  var MARGINS_KEY = "emeraldcore.storage.suite.docs.margins";
  var GOAL_KEY = "emeraldcore.storage.suite.docs.goal";
  var WRITING_TIME_KEY = "emeraldcore.storage.suite.docs.writingTime";
  var MAX_VERSIONS = 10;
  var AUTOSAVE_SNAPSHOT_MS = 60 * 1000;
  var autosaveSnapshotTimer = null;

  var snapshotDirty = false;
  var MAX_PAGINATE_ITER = 120;
  var PAGE_WIDTH = 794;
  var PAGE_HEIGHT = 1123;

  var curPageW = PAGE_WIDTH;
  var curPageH = PAGE_HEIGHT;
  var MIN_MARGIN = 32;
  var MAX_MARGIN = 300;

  var MIN_ZOOM = 20;
  var MAX_ZOOM = 400;

  var paginateScheduled = false;
  var autosaveScheduled = false;
  var autosaveTimer = null;
  var pendingExternalReload = false;
  var lastEditorRange = null;
  var toastTimer = null;
  var theme = "light";
  var findMatches = [];
  var findIndex = -1;
  var pageMargins = { top: 96, right: 96, bottom: 96, left: 96 };
  var goalTarget = 0;
  var assetRepaginateToken = 0;

  var canUndo = false;
  var canRedo = false;

  var documents = [];
  var currentDocId = null;
  var currentTitle = "Untitled Document";
  var _welcomeRenderToken = 0;
  var _deleteTargetId = null;

  function $(id) { return document.getElementById(id); }

  function getPages() {
    var wrapper = $(PAGES_WRAPPER_ID);
    if (!wrapper) return [];
    return Array.prototype.slice.call(wrapper.querySelectorAll(".page"));
  }
  function getContent(page) { return page.querySelector(".page-content"); }

  function isFloatingTable(el) {
    return !!(el && el.nodeType === 1 && el.tagName === "TABLE" &&
      el.style && el.style.position === "absolute");
  }

  function isOverflow(content) {
    if (!content.querySelector || !content.querySelector("table")) {
      return content.scrollHeight > content.clientHeight + 1;
    }
    var tables = content.querySelectorAll("table");
    var hasFloating = false;
    for (var ti = 0; ti < tables.length; ti++) {
      if (isFloatingTable(tables[ti])) { hasFloating = true; break; }
    }
    if (!hasFloating) return content.scrollHeight > content.clientHeight + 1;

    var maxBottom = 0;
    for (var i = 0; i < content.children.length; i++) {
      var k = content.children[i];
      if (isFloatingTable(k)) continue;
      maxBottom = Math.max(maxBottom, k.offsetTop + k.offsetHeight);
    }
    return maxBottom > content.clientHeight + 1;
  }

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
      if (pendingExternalReload) {

        setTimeout(function () { reloadFromStorageQuietly(); }, 900);
      }
    });
  }

  function clearCaretMarkers() {
    var marked = document.querySelectorAll("[" + CARET_BLOCK_ATTR + "]");
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(CARET_BLOCK_ATTR);
      marked[i].removeAttribute(CARET_OFFSET_ATTR);
    }
  }

  function isInlineMarker(el) {
    return el && el.nodeType === Node.ELEMENT_NODE &&
      (el.classList.contains("footnote-ref") || el.classList.contains("endnote-ref") || el.classList.contains("comment-ref"));
  }

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
        probe.collapse(true);
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
        while (overflow && isFloatingTable(overflow)) overflow = overflow.nextElementSibling;
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

    var wantStart = !block.textContent.trim() && block.closest("li, td, th");
    range.collapse(wantStart);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var content = block.closest(".page-content");
    if (content) content.focus();
  }

  function paginate() {
    saveCaret();

    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    applyPdfPageSizes();
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
        unstretchImages(content);

        var guard = 0;
        while (isOverflow(content) && guard++ < 300) {
          if (content.children.length === 1) {

            if (splitOverflowingBlock(content, pages[i])) {
              changed = true;
              continue;
            }
            break;
          }

          if (!pushOverflowDown(pages[i])) break;
          changed = true;
        }

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
    syncHeaderFooter();
    updatePageNumbers();
    updateDynamicFields();
    applySectionConfigs();
    updateStatus();
    restoreCaret();
    refreshFindHighlights();
  }

  function enforcePageBreaks() {
    var moved = false;
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var content = getContent(pages[i]);
      var breaks = content.querySelectorAll(".emdocs-page-break");
      if (breaks.length === 0) continue;

      var brk = breaks[0];

      var toMove = [];
      var sibling = brk.nextElementSibling;
      while (sibling) {
        var next = sibling.nextElementSibling;
        if (!isFloatingTable(sibling)) toMove.push(sibling);
        sibling = next;
      }

      if (toMove.length === 0) {

        if (breaks.length > 1) {

          for (var b = 1; b < breaks.length; b++) {
            var extra = breaks[b];
            var next2 = extra.nextElementSibling;
            var extras = [];
            while (next2) {
              var n2 = next2.nextElementSibling;
              if (!isFloatingTable(next2)) extras.push(next2);
              next2 = n2;
            }
            ensureNextPageAndPrepend(pages, i, extras, extra);
            moved = true;
            return moved;
          }
        }
        continue;
      }

      ensureNextPageAndPrepend(pages, i, toMove, null);
      moved = true;
      return moved;
    }
    return moved;
  }

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

  function ensureTableCellsEditable() {
    var cells = document.querySelectorAll(".page-content td, .page-content th");
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].getAttribute("contenteditable") !== "true") {
        cells[i].setAttribute("contenteditable", "true");
      }
    }
  }

  function unstretchImages(content) {
    var imgs = content.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.closest && img.closest(".emdocs-pdf-page")) continue;
      if (!img.style.width || !img.style.height) continue;
      if (img.style.aspectRatio) continue;
      var want = parseFloat(img.style.width);
      var wantH = parseFloat(img.style.height);
      if (!(want > 0) || !(wantH > 0)) continue;
      var got = img.offsetWidth;
      if (!got || got >= want - 1) continue;
      img.style.height = "auto";
      img.style.aspectRatio = Math.round(want) + " / " + Math.round(wantH);
    }
  }

  function normalizeContent(content) {

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

    while (last && isFloatingTable(last)) last = last.previousElementSibling;
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
    if (!block || isFloatingTable(block)) return false;
    if (content.children.length !== 1) return false;

    var children = Array.prototype.slice.call(block.childNodes);
    var removed = [];

    for (var i = children.length - 1; i >= 0; i--) {
      if (!isOverflow(content)) break;
      if (block.childNodes.length === 1) break;
      removed.unshift(children[i]);
      block.removeChild(children[i]);
    }

    if (isOverflow(content) && block.childNodes.length === 1) {
      var node = block.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) {
        var text = node.textContent;
        var tokens = text.split(/(\s+)/);
        if (tokens.length > 1) {
          node.textContent = tokens.slice(0, 1).join("");
          if (isOverflow(content)) {
            node.textContent = text;
            return false;
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

    while (first && isFloatingTable(first)) first = first.nextElementSibling;
    if (!first) return false;

    if (first.classList && first.classList.contains("emdocs-page-break")) return false;

    var lastHere = currentContent.lastElementChild;
    if (lastHere && lastHere.classList && lastHere.classList.contains("emdocs-page-break")) {
      return false;
    }

    var anchor = first.nextElementSibling;
    currentContent.appendChild(first);
    if (isOverflow(currentContent)) {
      if (anchor && anchor.parentNode === nextContent) {
        nextContent.insertBefore(first, anchor);
      } else {
        nextContent.appendChild(first);
      }
      return false;
    }
    return true;
  }

  var aggressiveEmptyPageCleanup = false;

  function removeTrailingEmptyPages() {
    var wrapper = $(PAGES_WRAPPER_ID);
    var changed = true;
    while (changed) {
      changed = false;
      var pages = getPages();
      for (var i = pages.length - 1; i >= 1; i--) {
        var content = getContent(pages[i]);
        var hasMedia = content.querySelector("img, table, hr, iframe, .emdocs-pdf-page");
        var isEmpty = (content.children.length === 0 && !hasMedia);
        if (aggressiveEmptyPageCleanup && !isEmpty && !hasMedia) {
          if ((content.textContent || "").replace(/\s/g, "") === "") isEmpty = true;
        }
        if (isEmpty) {
          wrapper.removeChild(pages[i]);
          changed = true;
        } else if (pageIsOnlyBreakMarkers(content)) {
          wrapper.removeChild(pages[i]);
          changed = true;
        }
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

    updateCaretPosition();

    updateRelativeAutosave();

    if ($("wordCountModal").classList.contains("open")) {
      updateGoalTracker();
      renderStatsChart();
      renderWritingIssues();
    }

    scheduleThumbnailsUpdate();

    highlightActiveOutlineHeading();
  }

  function updateCaretPosition() {
    var el = $("caretPos");
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) {

      el.textContent = "Ln 1, Col 1";
      return;
    }
    var node = sel.anchorNode;
    if (!node) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

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

    var block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (block && block.parentElement && !block.parentElement.classList.contains("page-content")) {
      block = block.parentElement;
    }

    if (!block || !block.parentElement || !block.parentElement.classList.contains("page-content")) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

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

    if (!found) {
      el.textContent = "Ln 1, Col 1";
      return;
    }

    var line = blockIndex + 1;

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

  var relativeAutosaveTimer = null;
  function updateRelativeAutosave() {
    var el = $("autosave");
    if (!el || !lastSavedAt) return;

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

  var PRUNABLE_RUNS = "span,font,b,strong,i,em,u,s,strike,sub,sup,code,mark,small,big";
  function pruneEmptyRuns(root) {
    if (!root || !root.querySelectorAll) return 0;

    var sel = window.getSelection();
    var caret = sel && sel.rangeCount ? (sel.getRangeAt(0).startContainer) : null;
    var removed = 0;

    for (var pass = 0; pass < 8; pass++) {
      var els = root.querySelectorAll(PRUNABLE_RUNS);
      var hit = null;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.getAttribute("contenteditable") === "false") continue;
        if (el.childNodes.length !== 0) continue;
        if (el === caret || (caret && el.contains && el.contains(caret))) continue;
        hit = el;
        break;
      }
      if (!hit || !hit.parentNode) break;
      hit.parentNode.removeChild(hit);
      removed++;
    }
    return removed;
  }

  function onInput(e) {
    startSessionTimer();
    startAutosaveSnapshots();
    snapshotDirty = true;

    if (e && (e.data === " " || e.data === "\u00a0")) {
      try { checkAutoCorrect(); } catch (err) {}
    }

    if (!e || !e.inputType || e.inputType.indexOf("delete") === 0) {
      try {
        var block = getCurrentBlock();
        var host = block && block.closest ? block.closest(".page-content") : null;
        if (host) pruneEmptyRuns(host);
      } catch (err) {}
    }
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    canUndo = true;
    canRedo = false;
    updateRibbonAvailability();
  }

  function onKeyDown(e) {

    if (e.key === "Escape") {
      if (anyModalOpen()) { closeAllModals(); e.preventDefault(); return; }
      if ($("findBar") && $("findBar").style.display !== "none") { closeFindBar(); e.preventDefault(); return; }
      if ($("outlinePanel").classList.contains("open")) { toggleOutline(false); e.preventDefault(); return; }
      if ($("thumbnailsPanel").classList.contains("open")) { toggleThumbnails(false); e.preventDefault(); return; }
      return;
    }

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

    if (k === "+" || k === "=") { e.preventDefault(); adjustZoom(10); return; }

    if (k === "-") { e.preventDefault(); adjustZoom(-10); return; }

    if (k === "0") { e.preventDefault(); setZoom(100); return; }
    if (k === "z" && !e.shiftKey) { e.preventDefault(); exec("undo"); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); exec("redo"); return; }
  }

  function cycleMarginPreset() {
    var presets = ["default", "narrow", "moderate", "wide"];

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

        var row = currentCell.closest("tr");
        var nextRow = row.nextElementSibling;
        if (nextRow) {
          target = nextRow.querySelector("td, th");
        } else {

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

  function insertPageBreak() {
    restoreEditorSelection();
    var fc = getContent(getPages()[0]);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement.closest(".page-content")) {
      if (fc) fc.focus();
    }

    var html = '<div class="emdocs-page-break" contenteditable="false" title="Click to remove this page break"><span class="pb-label">— Page Break —</span></div><p><br></p>';
    document.execCommand("insertHTML", false, html);
    schedulePaginate();
    scheduleAutosave();
    scheduleOutlineUpdate();
    toast("Page break inserted", "success");
  }

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
          h.style.background = "var(--accent-soft)";
          setTimeout(function () { h.style.background = prevBg; }, 800);
        });
        body.appendChild(item);
      })(headings[i]);
    }

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

    var activeItem = items[activeIdx];
    if (activeItem) {
      var bodyRect = body.getBoundingClientRect();
      var itemRect = activeItem.getBoundingClientRect();
      if (itemRect.top < bodyRect.top || itemRect.bottom > bodyRect.bottom) {
        activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

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

  var activeResizeImg = null;
  var resizeOverlay = null;
  var resizeHandles = null;
  var resizeStartX = 0;
  var resizeStartY = 0;
  var resizeStartW = 0;
  var resizeStartH = 0;
  var resizeMode = null;
  var resizeBodyCursorSet = false;
  var selectedImgObserver = null;

  function initImageResize() {

    document.addEventListener("click", function (e) {
      var img = e.target.closest ? e.target.closest(".page-content img") : null;
      if (img) {
        e.preventDefault();
        attachImageResize(img);
      } else if (resizeOverlay && e.target &&
                 (!e.target.closest || !e.target.closest(".img-resize-wrap, .ribbon, .ribbon-tabs, .ms-dropdown, .ms-dropdown-menu"))) {

        detachImageResize();
        syncImageFormatRibbonState();
      }
    });

    document.addEventListener("mousemove", function (e) {
      if (activeResizeImg && resizeMode) {
        e.preventDefault();

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
    if (!currentDocId) return;

    setAutosaveState("saving");
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      autosaveTimer = null;
      saveDocument(false);
    }, 800);
  }

function startAutosaveSnapshots() {
    if (autosaveSnapshotTimer) return;
    autosaveSnapshotTimer = setInterval(function () {
      if (!currentDocId) return;
      if (!snapshotDirty) return;
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

  function restoreEditorSelection() {
    if (lastEditorRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(lastEditorRange);
      } catch (e) {}
    }
  }

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

    var ok = !!(anchor && anchor.isConnected);
    var anchorEl = null, host = null;
    if (ok) {
      anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      host = anchorEl && anchorEl.closest(".page-content");

      ok = !!host && !(anchorEl.classList && anchorEl.classList.contains("page-content")) &&
           !anchorEl.closest('[contenteditable="false"]') &&
           !anchorEl.closest(".footnotes-section, .page-footnote-area");
    }
    if (ok && document.activeElement !== host) {

      try { host.focus({ preventScroll: true }); } catch (e) { try { host.focus(); } catch (e2) {} }
      restoreEditorSelection();
      var a2 = window.getSelection().anchorNode;
      var a2el = a2 && (a2.nodeType === Node.ELEMENT_NODE ? a2 : a2.parentElement);
      if (!a2 || !a2.isConnected || !a2el || !a2el.closest(".page-content") ||
          a2el.closest('[contenteditable="false"]') ||
          a2el.closest(".footnotes-section, .page-footnote-area")) ok = false;
    }
    if (!ok) {

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

  function healInlineRefPlacement(refEl) {
    if (!refEl || !refEl.parentElement) return;
    var host = refEl.parentElement;

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

  function focusEditorAndRestore() {
    var firstContent = getContent(getPages()[0]);
    if (firstContent) {
      try { firstContent.focus(); } catch (e) {}
    }
    restoreEditorSelection();
  }

  function exec(cmd, value) {

    if (cmd === "indent" || cmd === "outdent") {
      applyIndent(cmd === "indent" ? 1 : -1);
      return;
    }
    restoreEditorSelection();

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

  function applyFontSize(value) {
    var v = parseFloat(value);
    if (isNaN(v) || v <= 0) return;

    if (v >= 1 && v <= 7) { exec("fontSize", String(Math.round(v))); return; }

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

  function cssColorToHex(value) {
    var v = String(value == null ? "" : value).trim().toLowerCase();
    if (!v || v === "transparent" || v === "none" || v === "currentcolor" || v === "inherit") return "";
    if (v.charAt(0) === "#") {
      if (v.length === 7) return v;
      if (v.length === 4) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      return "";
    }
    var m = /^rgba?\(([^)]*)\)$/.exec(v);
    if (!m) return "";
    var parts = m[1].split(/[,\s\/]+/).filter(Boolean);
    if (parts.length < 3) return "";
    if (parts.length > 3 && parseFloat(parts[3]) === 0) return "";
    var hex = "#";
    for (var i = 0; i < 3; i++) {
      var n = Math.round(parseFloat(parts[i]));
      if (isNaN(n)) return "";
      hex += ("0" + Math.max(0, Math.min(255, n)).toString(16)).slice(-2);
    }
    return hex;
  }

  function selectionTint(prop) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    var range = sel.getRangeAt(0);
    var host = range.commonAncestorContainer;
    var hostEl = host.nodeType === Node.TEXT_NODE ? host.parentElement : host;
    if (!hostEl || !hostEl.closest || !hostEl.closest(".page-content")) return "";

    var nodes = [];
    var walker = document.createTreeWalker(hostEl, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.length) continue;
      if (range.intersectsNode ? range.intersectsNode(n) : true) nodes.push(n);
      if (nodes.length >= 60) break;
    }

    if (!nodes.length) nodes = [range.startContainer];

    var first = "";
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i].nodeType === Node.TEXT_NODE ? nodes[i].parentElement : nodes[i];
      if (!el || !el.closest || !el.closest(".page-content")) continue;
      var raw = String(window.getComputedStyle(el)[prop] || "").trim().toLowerCase();
      if (!first) first = raw;
      else if (raw !== first) return "";
    }
    if (!first || first === "rgba(0, 0, 0, 0)" || first === "transparent") return "";
    return cssColorToHex(first) || first;
  }

  function syncColorDropdown(ddId, current) {
    var dd = $(ddId);
    if (!dd) return;
    var btn = dd.querySelector(".ms-dropdown-btn");
    if (!btn) return;
    var swatch = btn.querySelector(".color-preview");
    var label = btn.querySelector(".dropdown-value");

    if (!dd.hasAttribute("data-rest-label")) {
      dd.setAttribute("data-rest-label", label ? label.textContent : "");
      dd.setAttribute("data-rest-bg", swatch ? swatch.style.background : "");
      dd.setAttribute("data-rest-border", swatch ? swatch.style.border : "");
    }
    var items = dd.querySelectorAll(".ms-dropdown-item[data-value]");

    var cur = cssColorToHex(current).toLowerCase();
    var match = null;
    for (var i = 0; i < items.length; i++) {
      var v = cssColorToHex(items[i].getAttribute("data-value"));
      if (v && cur && v.toLowerCase() === cur) { match = items[i]; break; }
    }
    dd.setAttribute("data-current", match ? cur : "");
    if (match) {
      var raw = match.getAttribute("data-value");
      if (swatch) { swatch.style.background = raw === "transparent" ? "transparent" : raw; swatch.style.border = ""; }
      if (label) label.textContent = match.getAttribute("data-label") || "";
      return;
    }
    if (current) {

      if (swatch) { swatch.style.background = cur || current; swatch.style.border = ""; }
      if (label) label.textContent = dd.getAttribute("data-rest-label") || label.textContent;
      return;
    }

    if (swatch) {
      swatch.style.background = dd.getAttribute("data-rest-bg") || "";
      swatch.style.border = dd.getAttribute("data-rest-border") || "";
    }
    if (label) label.textContent = dd.getAttribute("data-rest-label") || label.textContent;
  }

  function isCurrentSwatch(dd, value) {
    var v = cssColorToHex(value);
    var cur = dd ? String(dd.getAttribute("data-current") || "") : "";
    return !!(v && cur && v === cur);
  }

  function syncColorRibbon() {
    syncColorDropdown("fontColorDropdown", selectionTint("color"));
    syncColorDropdown("highlightColorDropdown", selectionTint("backgroundColor"));
  }

  function clearSelectionTint(prop, unwrapFontColor) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var host = range.commonAncestorContainer;
    var hostEl = host.nodeType === Node.TEXT_NODE ? host.parentElement : host;
    var scope = hostEl && hostEl.closest ? hostEl.closest(".page-content") : null;
    if (!scope) return;

    var styled = scope.querySelectorAll("[style]");
    for (var i = 0; i < styled.length; i++) {
      var el = styled[i];
      if (range.intersectsNode && !range.intersectsNode(el)) continue;
      if (prop === "color") {
        el.style.removeProperty("color");
        continue;
      }

      var cs = window.getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") continue;
      el.style.removeProperty("background-color");
      el.style.removeProperty("background");
    }

    if (unwrapFontColor) {
      var fonts = scope.querySelectorAll("font[color]");
      for (var j = 0; j < fonts.length; j++) {
        if (range.intersectsNode && !range.intersectsNode(fonts[j])) continue;
        var parent = fonts[j].parentNode;
        while (fonts[j].firstChild) parent.insertBefore(fonts[j].firstChild, fonts[j]);
        parent.removeChild(fonts[j]);
      }
    }

    restoreEditorSelection();
    schedulePaginate();
    scheduleAutosave();
    setTimeout(function () { updateToolbarStates(); updateRibbonAvailability(); }, 10);
  }

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

    syncColorRibbon();

  }

  function editorSnapshot() {
    var pages = getPages();
    var s = "";
    for (var i = 0; i < pages.length; i++) {
      s += getContent(pages[i]).innerHTML + "\n";
    }
    return s;
  }

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

    ["bold", "italic", "underline", "strikeThrough", "subscript", "superscript",
     "justifyLeft", "justifyCenter", "justifyRight", "justifyFull",
     "insertUnorderedList", "insertOrderedList", "outdent", "indent"].forEach(function (cmd) {
      setCommandControlsDisabled(cmd, !editableContext);
    });

    setRibbonDropdownDisabled("fontFamilyDropdown", !editableContext);
    setRibbonDropdownDisabled("fontSizeDropdown", !editableContext);
    setRibbonDropdownDisabled("fontColorDropdown", !editableContext);
    setRibbonDropdownDisabled("highlightColorDropdown", !editableContext);
    setRibbonControlDisabled($("btnClearFormat"), !editableContext);

    var docOnly = ["btnLink", "btnImage", "btnTable", "btnHr", "btnPageBreak",
      "btnDropCap", "btnWatermark", "btnSymbols", "btnCoverPage", "btnSectionBreak",
      "btnEquation", "btnSmartArt", "btnScreenshot", "btnDraw", "btnMargins",
      "btnOrientation", "btnHeader", "btnFooter", "btnTocRef", "btnFootnote",
      "btnEndnote", "btnCitation", "btnBibliography", "btnIndexEntry",
      "btnInsertIndex", "btnComment", "btnPageNum"];
    for (var i = 0; i < docOnly.length; i++) {
      setRibbonControlDisabled($(docOnly[i]), !state.activeDoc);
    }

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

  var idb = null;

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

      watermark: watermarkText,
      footnotes: footnotes,
      endnotes: endnotes,
      comments: comments,
    };
  }

  async function loadIndex() {
    try {
      var idx = null;
      if (window.EmeraldIDBStorage) {
        idx = await window.EmeraldIDBStorage.getJSON(DOC_INDEX_KEY);
      }
      documents = Array.isArray(idx) ? idx : [];

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

  function generateSecureId(length) {
    var arr = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("").slice(0, length);
  }

  function makeDocId() {
    return "doc_" + Date.now() + "_" + generateSecureId(9);
  }

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

        toast("Document saved", "success");
        try { window.EmeraldHistory.action("Saved document \u201C" + (currentTitle || "Untitled Document") + "\u201D"); } catch (_) {}
      }
    } catch (e) {
      setAutosaveState("error");
      if (showToast) toast("Save failed (storage full?)", "error");
    }
  }

  function pushVersion(data) {
    if (!currentDocId) return;
    var versions = getVersions();

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

    renderDocPins(false);
    saveDocument(false);
    closeModal("versionsModal");
    toast("Version restored", "success");
    try { window.EmeraldHistory.action("Restored a version of \u201C" + (currentTitle || "Untitled Document") + "\u201D"); } catch (_) {}
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

    headerActive = hfHasContent(data.header);
    headerHTML = headerActive ? data.header : "";
    footerActive = hfHasContent(data.footer);
    footerHTML = footerActive ? data.footer : "";

    applyWatermark(data.watermark || "");

    if (Array.isArray(data.footnotes)) footnotes = data.footnotes;
    if (Array.isArray(data.endnotes)) endnotes = data.endnotes;

    comments = Array.isArray(data.comments) ? data.comments : [];

    canUndo = false;
    canRedo = false;

    applyDocPageLayout(data);
    paginate();

    renderDocPins(true);
  }

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

  async function openDocument(id, logOpen) {
    var data = await loadDocData(id);
    if (!data) { toast("Could not open document", "error"); return; }
    try { togglePrintPreview(false); } catch (e) {}
    currentDocId = id;
    applyDocData(data);

    try { renderFootnotesSection(); renderEndnotesSection(); } catch (e) {}
    repaginateAfterAssetsLoad();
    document.body.classList.remove("no-active-doc");
    showWelcomeScreen(false);
    switchRibbonTab("home");

    refreshRibbonIndicator();
    updateOwnedUrl();
    updateStatus();
    updateRibbonAvailability();
    if (logOpen !== false) {
      try { window.EmeraldHistory.action("Opened document \u201C" + (data.title || "Untitled Document") + "\u201D"); } catch (_) {}
    }
  }

  function closeDocument() {
    if (currentDocId) saveDocument(false);

    commitSessionTime();
    currentDocId = null;
    currentTitle = "Untitled Document";
    syncFileModalNameInput();

    if ($("outlinePanel") && $("outlinePanel").classList.contains("open")) toggleOutline(false);
    if ($("thumbnailsPanel") && $("thumbnailsPanel").classList.contains("open")) toggleThumbnails(false);

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
    await openDocument(id, false);
    try { window.EmeraldHistory.action("Created document \u201C" + title + "\u201D"); } catch (_) {}
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
    var deletedTitle = "";
    for (var di = 0; di < documents.length; di++) {
      if (documents[di] && documents[di].id === id) { deletedTitle = documents[di].title; break; }
    }
    if (wasCurrent) {

      currentDocId = null;
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    }
    documents = documents.filter(function (d) { return d.id !== id; });
    await saveIndex();
    await deleteDocData(id);
    if (wasCurrent) closeDocument();
    renderWelcomeCards();
    toast("Document deleted", "success");
    try { window.EmeraldHistory.action("Deleted document \u201C" + (deletedTitle || "Untitled Document") + "\u201D"); } catch (_) {}
  }

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

    commitFileModalRename();
    modal.classList.add("closing");
    setTimeout(function () {
      modal.classList.remove("show");
      modal.classList.remove("closing");
    }, 250);

    switchRibbonTab("home");
  }

  function commitFileModalRename() {
    var nameInput = $("fileModalNameInput");
    if (!nameInput || !currentDocId) return;
    var newTitle = nameInput.value.trim() || "Untitled Document";
    if (newTitle !== currentTitle) {
      currentTitle = newTitle;
      scheduleAutosave();
    }
  }

  function showWelcomeScreen(show) {
    var ws = $("welcomeScreen");
    if (!ws) return;
    ws.style.display = show ? "flex" : "none";

    var area = document.querySelector(".document-area");
    if (area) area.style.display = show ? "none" : "flex";
    if (show) renderWelcomeCards();
  }

  function formatCardDate(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function renderWelcomeCards() {
    var container = $("documentsDisplay");
    var noContainer = $("noDocsContainer");
    if (!container) return;

    var myToken = (_welcomeRenderToken = (_welcomeRenderToken || 0) + 1);

    function applyEmpty(empty) {

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
      if (myToken !== _welcomeRenderToken) return;
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

    var html = sanitizeStoredHtml(htmlText);
    return html && html.replace(/\S/g, "") ? html : "<p><br></p>";
  }

  function zipReadEntry(arrayBuffer, targetName) {
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);
    var len = bytes.length;

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

    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([array]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }

  async function convertOdtToHtml(arrayBuffer) {
    var contentEntry = await zipReadEntry(arrayBuffer, "content.xml");
    if (!contentEntry) return null;
    var contentText = new TextDecoder("utf-8").decode(contentEntry);
    var stylesEntry = await zipReadEntry(arrayBuffer, "styles.xml");
    var stylesText = stylesEntry ? new TextDecoder("utf-8").decode(stylesEntry) : "";

    var NS = {
      office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
      style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
      text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
      table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
      draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
      fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
      svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
      xlink: "http://www.w3.org/1999/xlink"
    };
    function gns(parent, nsKey, tag) {
      if (!parent) return [];
      return Array.prototype.slice.call(parent.getElementsByTagNameNS(NS[nsKey], tag));
    }
    function attr(el, nsKey, name) {
      if (!el) return null;
      var v = el.getAttributeNS(NS[nsKey], name);
      if (v == null) v = el.getAttribute(name);
      return v;
    }
    function odtLenPx(v) {
      if (v == null) return null;
      var s = String(v).trim();
      var m = s.match(/^([\d.]+)\s*(cm|mm|pt|px|in)?$/);
      if (!m) return null;
      var n = parseFloat(m[1]);
      var u = m[2] || "px";
      if (u === "cm") return Math.round(n * 96 / 2.54);
      if (u === "mm") return Math.round(n * 96 / 25.4);
      if (u === "pt") return Math.round(n * 96 / 72);
      if (u === "in") return Math.round(n * 96);
      return Math.round(n);
    }
    function odtColor(v) {
      if (!v) return null;
      return String(v).trim();
    }

    var parser = new DOMParser();
    var cdoc = parser.parseFromString(contentText, "application/xml");
    var sdoc = stylesText ? parser.parseFromString(stylesText, "application/xml") : null;

    var styles = {};
    function parseProps(el) {
      var p = {}, t = {}, cell = {}, table = {};
      if (!el) return { p: p, t: t, cell: cell, table: table };
      var pp = gns(el, "style", "paragraph-properties")[0];
      if (pp) {
        var a = pp.attributes;
        for (var i = 0; i < a.length; i++) {
          var at = a[i];
          if (at.namespaceURI !== NS.fo && at.namespaceURI !== NS.style) continue;
          var n = at.localName, v = at.value;
          if (at.namespaceURI === NS.fo) {
            if (n === "text-align") p.align = v;
            else if (n === "margin-left") p.ml = odtLenPx(v);
            else if (n === "margin-right") p.mr = odtLenPx(v);
            else if (n === "margin-top") p.mt = odtLenPx(v);
            else if (n === "margin-bottom") p.mb = odtLenPx(v);
            else if (n === "text-indent") p.ti = odtLenPx(v);
            else if (n === "line-height") p.lh = v;
            else if (n === "background-color") p.bg = odtColor(v);
            else if (n === "break-before") p.breakBefore = v;
          }
        }
      }
      var tp = gns(el, "style", "text-properties")[0];
      if (tp) {
        var a2 = tp.attributes;
        for (var j = 0; j < a2.length; j++) {
          var at2 = a2[j];
          if (at2.namespaceURI !== NS.fo && at2.namespaceURI !== NS.style) continue;
          var n2 = at2.localName, v2 = at2.value;
          if (at2.namespaceURI === NS.fo) {
            if (n2 === "font-weight") t.bold = (v2 === "bold");
            else if (n2 === "font-style") t.italic = (v2 === "italic" || v2 === "oblique");
            else if (n2 === "font-size") t.sz = odtLenPx(v2);
            else if (n2 === "color") t.color = odtColor(v2);
            else if (n2 === "background-color") t.bg = odtColor(v2);
            else if (n2 === "font-variant") t.smallCaps = (v2 === "small-caps");
            else if (n2 === "text-transform") t.caps = (v2 === "uppercase");
            else if (n2 === "letter-spacing") t.tracking = odtLenPx(v2);
          } else {
            if (n2 === "font-name") t.font = v2;
            else if (n2 === "text-underline-type") t.underline = (v2 && v2 !== "none");
            else if (n2 === "text-line-through-type") t.strike = (v2 && v2 !== "none");
            else if (n2 === "text-position") { if (/super/.test(v2)) t.vert = "super"; if (/sub/.test(v2)) t.vert = "sub"; }
          }
        }
      }
      var cp = gns(el, "style", "table-cell-properties")[0];
      if (cp) {
        var a3 = cp.attributes;
        for (var k = 0; k < a3.length; k++) {
          var at3 = a3[k];
          if (at3.namespaceURI === NS.fo) {
            var n3 = at3.localName, v3 = at3.value;
            if (n3 === "background-color") cell.bg = odtColor(v3);
            else if (n3.indexOf("border-") === 0) cell[n3] = v3;
            else if (n3 === "padding") cell.padding = v3;
          } else if (at3.namespaceURI === NS.style) {
            if (at3.localName === "vertical-align") cell.valign = at3.value;
          }
        }
      }
      var tp2 = gns(el, "style", "table-properties")[0];
      if (tp2) {
        var a4 = tp2.attributes;
        for (var l = 0; l < a4.length; l++) {
          var at4 = a4[l];
          if (at4.namespaceURI === NS.style && at4.localName === "width") table.width = at4.value;
        }
      }
      return { p: p, t: t, cell: cell, table: table };
    }

    function addStyleEl(el) {
      var name = attr(el, "style", "name");
      if (!name) return;
      var family = attr(el, "style", "family");
      var parent = attr(el, "style", "parent-style-name");
      var parsed = parseProps(el);
      var prev = styles[name] || { family: family, p: {}, t: {}, cell: {}, table: {} };
      var p = Object.assign({}, prev.p, parsed.p);
      var t = Object.assign({}, prev.t, parsed.t);
      var cell = Object.assign({}, prev.cell, parsed.cell);
      var table = Object.assign({}, prev.table, parsed.table);
      if (parent && styles[parent]) {
        p = Object.assign({}, styles[parent].p, p);
        t = Object.assign({}, styles[parent].t, t);
        cell = Object.assign({}, styles[parent].cell, cell);
        table = Object.assign({}, styles[parent].table, table);
      }
      styles[name] = { family: family, p: p, t: t, cell: cell, table: table };
    }

    function collectStyles(doc) {
      if (!doc) return;
      var autos = gns(doc, "office", "automatic-styles")[0];
      if (autos) {
        var kids = autos.childNodes;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].nodeType === 1 && kids[i].localName === "style" && kids[i].namespaceURI === NS.style) addStyleEl(kids[i]);
        }
      }
      var named = gns(doc, "office", "styles")[0];
      if (named) {
        var kids2 = named.childNodes;
        for (var j = 0; j < kids2.length; j++) {
          if (kids2[j].nodeType === 1) {
            if (kids2[j].localName === "style" && kids2[j].namespaceURI === NS.style) addStyleEl(kids2[j]);
            if (kids2[j].localName === "default-style" && kids2[j].namespaceURI === NS.style) {
              var fam = attr(kids2[j], "style", "family");
              var parsed = parseProps(kids2[j]);
              styles["__default__" + fam] = { family: fam, p: parsed.p, t: parsed.t, cell: parsed.cell, table: parsed.table };
            }
          }
        }
      }
    }
    collectStyles(cdoc);
    collectStyles(sdoc);

    function resolveStyle(name, family) {
      if (!name) return styles["__default__" + family] || null;
      if (styles[name]) return styles[name];
      return styles["__default__" + family] || null;
    }

    function pPropsToCss(p) {
      if (!p) return "";
      var css = "";
      if (p.align) css += "text-align:" + p.align + ";";
      if (p.ml != null) css += "margin-left:" + p.ml + "px;";
      if (p.mr != null) css += "margin-right:" + p.mr + "px;";
      if (p.mt != null) css += "margin-top:" + p.mt + "px;";
      if (p.mb != null) css += "margin-bottom:" + p.mb + "px;";
      if (p.ti != null) css += "text-indent:" + p.ti + "px;";
      if (p.lh) {
        if (String(p.lh).indexOf("%") !== -1) css += "line-height:" + p.lh + ";";
        else {
          var px = odtLenPx(p.lh);
          if (px != null) css += "line-height:" + px + "px;";
          else css += "line-height:" + p.lh + ";";
        }
      }
      if (p.bg) css += "background-color:" + p.bg + ";";
      return css;
    }
    function tPropsToCss(t) {
      if (!t) return "";
      var css = "";
      if (t.bold) css += "font-weight:700;";
      if (t.italic) css += "font-style:italic;";
      if (t.underline) css += "text-decoration:underline;";
      if (t.strike) css += "text-decoration:line-through;";
      if (t.color) css += "color:" + t.color + ";";
      if (t.bg) css += "background-color:" + t.bg + ";";
      if (t.sz != null) css += "font-size:" + t.sz + "px;";
      if (t.font) css += "font-family:" + t.font + ";";
      if (t.vert === "super") css += "vertical-align:super;font-size:smaller;";
      if (t.vert === "sub") css += "vertical-align:sub;font-size:smaller;";
      if (t.caps) css += "text-transform:uppercase;";
      if (t.smallCaps) css += "font-variant:small-caps;";
      if (t.tracking != null) css += "letter-spacing:" + t.tracking + "px;";
      return css;
    }

    var ctx = { noteCounters: { fn: 0, en: 0 }, notes: { fn: [], en: [] } };

    function renderInline(node, inheritedT) {
      var out = "";
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { out += escapeHtml(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        var ln = c.localName, ns = c.namespaceURI;
        if (ns === NS.text) {
          if (ln === "span") {
            var sn = attr(c, "text", "style-name");
            var st = resolveStyle(sn, "text");
            var merged = Object.assign({}, inheritedT || {}, st ? st.t : {});
            var css = tPropsToCss(merged);
            var inner = renderInline(c, merged);
            out += css ? '<span style="' + css + '">' + (inner || "") + "</span>" : inner;
          } else if (ln === "a") {
            var href = attr(c, "xlink", "href");
            out += '<a href="' + escapeAttr(href || "") + '">' + renderInline(c, inheritedT) + "</a>";
          } else if (ln === "note") {
            var cls = attr(c, "text", "note-class") || "footnote";
            var kind = (cls === "endnote") ? "en" : "fn";
            ctx.noteCounters[kind]++;
            var num = ctx.noteCounters[kind];
            var noteBody = gns(c, "text", "note-body")[0];
            var noteText = noteBody ? (noteBody.textContent || "") : "";
            ctx.notes[kind].push({ num: num, text: noteText });
            out += '<sup class="' + (kind === "fn" ? "footnote-ref" : "endnote-ref") + '" data-' + (kind === "fn" ? "fn" : "en") + '="' + num + '" contenteditable="false">' + num + "</sup> ";
          } else if (ln === "line-break") {
            out += "<br>";
          } else if (ln === "tab") {
            out += "\t";
          } else if (ln === "s") {
            var cnt = parseInt(attr(c, "text", "c") || "1", 10);
            out += new Array(cnt + 1).join(" ");
          } else {
            out += renderInline(c, inheritedT);
          }
        } else if (ns === NS.draw) {

        } else {
          out += renderInline(c, inheritedT);
        }
      }
      return out;
    }

    function renderPara(el, ctx) {
      var styleName = attr(el, "text", "style-name");
      var st = resolveStyle(styleName, "paragraph");
      var defaultSt = styles["__default__paragraph"];
      var pProps = Object.assign({}, defaultSt ? defaultSt.p : {}, st ? st.p : {});
      var tProps = Object.assign({}, defaultSt ? defaultSt.t : {}, st ? st.t : {});
      var css = pPropsToCss(pProps);
      var inner = renderInline(el, tProps);
      var breakHtml = pProps.breakBefore === "page" ? '<div class="emdocs-page-break emdocs-page-break--pdf" contenteditable="false"></div>' : "";
      return breakHtml + "<p" + (css ? ' style="' + css + '"' : "") + ">" + (inner.trim() ? inner : "<br>") + "</p>";
    }

    function renderHeading(el, ctx) {
      var level = parseInt(attr(el, "text", "outline-level") || "1", 10);
      if (level < 1) level = 1; if (level > 3) level = 3;
      var styleName = attr(el, "text", "style-name");
      var st = resolveStyle(styleName, "paragraph");
      var defaultSt = styles["__default__paragraph"];
      var pProps = Object.assign({}, defaultSt ? defaultSt.p : {}, st ? st.p : {});
      var tProps = Object.assign({}, defaultSt ? defaultSt.t : {}, st ? st.t : {});
      var css = pPropsToCss(pProps);
      var inner = renderInline(el, tProps);
      return "<h" + level + (css ? ' style="' + css + '"' : "") + ">" + (inner.trim() ? inner : "<br>") + "</h" + level + ">";
    }

    function findListStyle(name) {
      var docs = [cdoc, sdoc].filter(Boolean);
      for (var d = 0; d < docs.length; d++) {
        var autos = gns(docs[d], "office", "automatic-styles")[0];
        if (autos) {
          var ls = gns(autos, "text", "list-style");
          for (var i = 0; i < ls.length; i++) if (attr(ls[i], "style", "name") === name) return ls[i];
        }
        var named = gns(docs[d], "office", "styles")[0];
        if (named) {
          var ls2 = gns(named, "text", "list-style");
          for (var i2 = 0; i2 < ls2.length; i2++) if (attr(ls2[i2], "style", "name") === name) return ls2[i2];
        }
      }
      return null;
    }

    function renderList(el, ctx) {
      var styleName = attr(el, "text", "style-name");
      var ls = styleName ? findListStyle(styleName) : null;
      var ordered = false;
      if (ls) {
        if (gns(ls, "text", "list-level-style-number").length > 0) ordered = true;
      }
      var tag = ordered ? "ol" : "ul";
      var out = "<" + tag + ">";
      var items = gns(el, "text", "list-item");
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        var itemHtml = "";
        for (var c = li.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          var ln = c.localName, ns = c.namespaceURI;
          if (ns === NS.text) {
            if (ln === "p") itemHtml += renderPara(c, ctx);
            else if (ln === "h") itemHtml += renderHeading(c, ctx);
            else if (ln === "list") itemHtml += renderList(c, ctx);
            else itemHtml += renderInline(c, {});
          } else if (ns === NS.table && ln === "table") {
            itemHtml += renderTable(c, ctx);
          }
        }
        if (!itemHtml.trim()) itemHtml = "<p><br></p>";
        out += "<li>" + itemHtml + "</li>";
      }
      out += "</" + tag + ">";
      return out;
    }

    function renderTable(el, ctx) {
      var rows = gns(el, "table", "table-row");
      var html = '<table style="border-collapse:collapse;">';
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var cells = [];
        for (var c = row.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 1 && c.localName === "table-cell" && c.namespaceURI === NS.table) cells.push(c);
        }
        html += "<tr>";
        for (var ci = 0; ci < cells.length; ci++) {
          var cell = cells[ci];
          var colspan = attr(cell, "table", "number-columns-spanned");
          var rowspan = attr(cell, "table", "number-rows-spanned");
          var styleName = attr(cell, "table", "style-name");
          var st = resolveStyle(styleName, "table-cell");
          var cellProps = st ? st.cell : {};
          var css = "";
          if (cellProps.bg) css += "background-color:" + cellProps.bg + ";";
          if (cellProps.valign) css += "vertical-align:" + (cellProps.valign === "middle" ? "middle" : cellProps.valign) + ";";
          for (var side in { top: 1, left: 1, bottom: 1, right: 1 }) {
            var b = cellProps["border-" + side];
            if (b) css += "border-" + side + ":" + b + ";";
          }
          if (cellProps.padding) css += "padding:" + cellProps.padding + ";";
          html += "<td" +
            (colspan && colspan !== "1" ? ' colspan="' + colspan + '"' : "") +
            (rowspan && rowspan !== "1" ? ' rowspan="' + rowspan + '"' : "") +
            (css ? ' style="' + css + '"' : "") + ">";
          var cellHtml = "";
          for (var cc = cell.firstChild; cc; cc = cc.nextSibling) {
            if (cc.nodeType !== 1) continue;
            var ln = cc.localName, ns = cc.namespaceURI;
            if (ns === NS.text) {
              if (ln === "p") cellHtml += renderPara(cc, ctx);
              else if (ln === "h") cellHtml += renderHeading(cc, ctx);
              else if (ln === "list") cellHtml += renderList(cc, ctx);
              else if (ln === "table") cellHtml += renderTable(cc, ctx);
            }
          }
          if (!cellHtml.trim()) cellHtml = "<p><br></p>";
          html += cellHtml + "</td>";
        }
        html += "</tr>";
      }
      html += "</table>";
      return html;
    }

    var bodyEl = gns(cdoc, "office", "body")[0];
    var textEl = bodyEl ? gns(bodyEl, "office", "text")[0] : null;
    var out = [];
    if (textEl) {
      for (var c = textEl.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var ln = c.localName, ns = c.namespaceURI;
        if (ln === "h" && ns === NS.text) out.push(renderHeading(c, ctx));
        else if (ln === "p" && ns === NS.text) out.push(renderPara(c, ctx));
        else if (ln === "list" && ns === NS.text) out.push(renderList(c, ctx));
        else if (ln === "table" && ns === NS.table) out.push(renderTable(c, ctx));
        else if (ln === "section" && ns === NS.text) {
          for (var sc = c.firstChild; sc; sc = sc.nextSibling) {
            if (sc.nodeType !== 1) continue;
            if (sc.localName === "h" && sc.namespaceURI === NS.text) out.push(renderHeading(sc, ctx));
            else if (sc.localName === "p" && sc.namespaceURI === NS.text) out.push(renderPara(sc, ctx));
            else if (sc.localName === "list" && sc.namespaceURI === NS.text) out.push(renderList(sc, ctx));
            else if (sc.localName === "table" && sc.namespaceURI === NS.table) out.push(renderTable(sc, ctx));
          }
        }
      }
    }
    var html = out.join("");
    if (!html.trim()) html = "<p><br></p>";

    var footnotes = ctx.notes.fn.map(function (n) {
      return { num: n.num, text: n.text, refId: "fn_ref_" + n.num + "_" + Date.now().toString(36), ts: Date.now() };
    });
    var endnotes = ctx.notes.en.map(function (n) {
      return { num: n.num, text: n.text, refId: "en_ref_" + n.num + "_" + Date.now().toString(36), ts: Date.now() };
    });

    if (footnotes.length || endnotes.length) {
      return { html: html, footnotes: footnotes, endnotes: endnotes };
    }
    return html;
  }

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

        var u = /^\\u(-?\d+)/.exec(rtf.substr(i));
        if (u) { out += String.fromCharCode(parseInt(u[1], 10)); i += u[0].length; continue; }

        var br = /^\\[a-zA-Z]+\d*/.exec(rtf.substr(i)) || [""];
        var word = br[0];
        if (word === "\\par" || word === "\\line") { out += "\n"; i += word.length; continue; }
        if (word === "\\tab") { out += " "; i += word.length; continue; }

        var w = /^\\[a-zA-Z]+-?\d*/.exec(rtf.substr(i));
        if (w) { i += w[0].length; continue; }
        i++; continue;
      }
      if (ch === "{" || ch === "}") { i++; continue; }
      out += ch; i++;
    }
    return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
  function convertRtfToHtml(rtf) {
    var colors = ["#000000"];
    var ct = rtf.match(/\{\\colortbl[^}]*\}/);
    if (ct) {
      var parts = ct[0].replace(/^\{\\colortbl/, "").replace(/\}$/, "").split(";");
      for (var i = 0; i < parts.length; i++) {
        var m = parts[i].match(/\\red(\d+)\\green(\d+)\\blue(\d+)/);
        if (m) {
          var r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
          colors.push("#" + (r < 16 ? "0" : "") + r.toString(16) + (g < 16 ? "0" : "") + g.toString(16) + (b < 16 ? "0" : "") + b.toString(16));
        } else if (parts[i].trim() === "") {
          colors.push(null);
        }
      }
    }

    var out = [];
    var para = "";
    var bold = false, italic = false, underline = false, strike = false;
    var superSub = null;
    var sizePt = null;
    var colorIdx = 0;
    var i = 0, n = rtf.length;
    function flushPara() {
      var p = para.trim();
      if (p) out.push("<p>" + p + "</p>");
      else out.push("<p><br></p>");
      para = "";
    }
    function spanOpen() {
      var css = "";
      if (bold) css += "font-weight:700;";
      if (italic) css += "font-style:italic;";
      if (underline) css += "text-decoration:underline;";
      if (strike) css += "text-decoration:line-through;";
      if (sizePt) css += "font-size:" + sizePt + "pt;";
      var col = colors[colorIdx];
      if (col) css += "color:" + col + ";";
      if (superSub === "super") css += "vertical-align:super;font-size:smaller;";
      if (superSub === "sub") css += "vertical-align:sub;font-size:smaller;";
      return css ? '<span style="' + css + '">' : "";
    }
    var textBuf = "";
    function flushText() {
      if (!textBuf) return;
      var s = spanOpen();
      var t = escapeHtml(textBuf);
      if (s) para += s + t + "</span>";
      else para += t;
      textBuf = "";
    }
    while (i < n) {
      var ch = rtf[i];
      if (ch === "{" || ch === "}") { i++; continue; }
      if (ch === "\\") {
        if (i + 1 < n && rtf[i + 1] === "'") {
          var hex = rtf.substr(i + 2, 2);
          try { textBuf += String.fromCharCode(parseInt(hex, 16)); } catch (e) {}
          i += 4; continue;
        }
        var um = /^\\u(-?\d+)/.exec(rtf.substr(i));
        if (um) {
          var cp = parseInt(um[1], 10);
          if (cp < 0) cp += 65536;
          try { textBuf += String.fromCharCode(cp); } catch (e) {}
          i += um[0].length;
          if (i < n && rtf[i] !== "\\" && rtf[i] !== "{" && rtf[i] !== "}") i++;
          continue;
        }
        var cw = /^\\([a-zA-Z]+)(-?\d+)?/.exec(rtf.substr(i));
        if (cw) {
          var word = cw[1];
          var param = cw[2] != null ? parseInt(cw[2], 10) : null;
          i += cw[0].length;
          if (i < n && rtf[i] === " ") i++;
          switch (word) {
            case "par": case "pard": flushText(); flushPara(); bold = false; italic = false; underline = false; strike = false; superSub = null; sizePt = null; colorIdx = 0; break;
            case "line": flushText(); para += "<br>"; break;
            case "tab": flushText(); para += "\t"; break;
            case "page": flushText(); para += '<div class="emdocs-page-break emdocs-page-break--pdf" contenteditable="false"></div>'; break;
            case "b": bold = (param !== 0); break;
            case "i": italic = (param !== 0); break;
            case "ul": case "ulnone": underline = (word === "ul" && param !== 0); break;
            case "strike": strike = (param !== 0); break;
            case "super": superSub = "super"; break;
            case "sub": superSub = "sub"; break;
            case "nosupersub": superSub = null; break;
            case "fs": if (param != null) sizePt = (param / 2); break;
            case "cf": if (param != null && param >= 0 && param < colors.length) colorIdx = param; break;
            case "s":
              if (param != null && param >= 1 && param <= 3) {
                flushText();
                para += "\u0001H" + param + "\u0001";
              }
              break;
            default: break;
          }
          continue;
        }
        if (i + 1 < n) { i++; continue; }
        i++; continue;
      }
      if (ch === "\n" || ch === "\r") { i++; continue; }
      textBuf += ch;
      i++;
    }
    flushText();
    var finalOut = [];
    for (var o = 0; o < out.length; o++) {
      var p = out[o];
      var m = p.match(/\u0001H(\d)\u0001/);
      if (m) {
        var lvl = parseInt(m[1], 10);
        if (lvl > 3) lvl = 3;
        p = p.replace(/\u0001H\d\u0001/, "");
        var inner = p.replace(/^<p>/, "").replace(/<\/p>$/, "");
        finalOut.push("<h" + lvl + ">" + inner + "</h" + lvl + ">");
      } else {
        finalOut.push(p);
      }
    }
    var html = finalOut.join("");
    if (!html.trim()) html = "<p><br></p>";
    return html;
  }

  function convertDocToText(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var n = bytes.length;
    function isTextByte(b) {
      return (b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13;
    }

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

    var lines = (utfLines.length >= Math.min(2, latinLines.length)) ? utfLines : latinLines;
    var out = lines.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return out || null;
  }

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
      if (inner.charAt(0) === "!") continue;
      if (inner.charAt(0) === "?") continue;
      if (inner.charAt(0) === "/") { stack.pop(); continue; }
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

  function xmlTop(root) {
    if (!root) return null;
    if (root.tag !== "#root") return root;
    return root.kids.length ? root.kids[0] : null;
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
    return Math.round((v / 20) * 96 / 72);
  }

  var DOCX_HIGHLIGHTS = {
    yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff",
    blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080",
    darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
    darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0",
    black: "#000000", white: "#ffffff", none: null,
  };

  function docxOn(node) {

    var el = firstChild(node, arguments[1]);
    if (!el) return false;
    var v = el.attrs.val;
    return !(v === "0" || v === "false" || v === "off");
  }

  function docxTw(v) { return twipToPx(v); }
  function docxHalfPtPx(v) { var hp = parseFloat(v); return isFinite(hp) ? hp * 2 / 3 : null; }
  function docxEmuPx(v) { var e = parseFloat(v); return isFinite(e) ? e / 9525 : null; }

  function docxReadStyles(root) {
    var out = { para: {}, run: {}, link: {}, defPara: {}, defRun: {}, table: {}, theme: {} };
    root = xmlTop(root);
    if (!root) return out;

    function collect(node) {
      var pPr = firstChild(node, "pPr"), rPr = firstChild(node, "rPr");
      var props = { id: node.attrs.styleId || null };
      var based = firstChild(node, "basedOn");
      if (based) props.basedOn = based.attrs.val;
      if (pPr) Object.assign(props, docxParaProps(pPr));
      if (rPr) Object.assign(props, docxRunProps(rPr));
      return props;
    }

    function collectTableStyle(node) {
      var props = { id: node.attrs.styleId || null, conds: {} };
      var based = firstChild(node, "basedOn");
      if (based) props.basedOn = based.attrs.val;
      var stPr = firstChild(node, "tblPr");
      if (stPr) {
        var sb = firstChild(stPr, "tblBorders");
        props.borders = sb ? {
          top: borderDescriptor(firstChild(sb, "top")),
          left: borderDescriptor(firstChild(sb, "left")),
          bottom: borderDescriptor(firstChild(sb, "bottom")),
          right: borderDescriptor(firstChild(sb, "right")),
          insideH: borderDescriptor(firstChild(sb, "insideH")),
          insideV: borderDescriptor(firstChild(sb, "insideV"))
        } : null;
      }
      var wSibs = allChildren(node, "tblStylePr");
      for (var s = 0; s < wSibs.length; s++) {
        var wNode = wSibs[s];
        var cond = {};
        var ctcPr = firstChild(wNode, "tcPr");
        if (ctcPr) {
          var cb = firstChild(ctcPr, "tcBorders");
          if (cb) cond.borders = {
            top: borderDescriptor(firstChild(cb, "top")),
            left: borderDescriptor(firstChild(cb, "left")),
            bottom: borderDescriptor(firstChild(cb, "bottom")),
            right: borderDescriptor(firstChild(cb, "right"))
          };
          var cshd = firstChild(ctcPr, "shd");
          if (cshd) {
            var v = cshd.attrs.val;
            if (v !== "nil" && cshd.attrs.fill && cshd.attrs.fill !== "auto") {
              cond.fill = ooxmlColor(cshd.attrs.fill) || null;
            }
          }
        }
        var crPr = firstChild(wNode, "rPr");
        var cprops = crPr ? docxRunProps(crPr) : {};
        if (cprops.bold) cond.bold = true;
        if (cond.borders || cond.fill || cond.bold) props.conds[wNode.attrs.type || ""] = cond;
      }
      return props;
    }

    var dd = firstChild(root, "docDefaults");
    if (dd) {
      var pd = firstChild(dd, "pPrDefault");
      if (pd) {
        var pnode = firstChild(pd, "pPr");
        if (pnode) out.defPara = docxParaProps(pnode);
      }
      var rd = firstChild(dd, "rPrDefault");
      if (rd) {
        var rnode = firstChild(rd, "rPr");
        if (rnode) out.defRun = docxRunProps(rnode);
      }
    }
    for (var i = 0; i < root.kids.length; i++) {
      var st = root.kids[i];
      if (st.tag !== "style") continue;
      var type = st.attrs.type || "";
      var id = st.attrs.styleId;
      if (!id) continue;
      var props = collect(st);
      if (type === "paragraph") out.para[id] = props;
      else if (type === "character") out.run[id] = props;
      else if (type === "numbering") out.link[id] = props;
      else if (type === "table") out.table[id] = collectTableStyle(st);
    }
    return out;
  }

  function docxResolve(styles, id, kind, seen) {
    var table = kind === "run" ? styles.run : styles.para;
    var chain = [];
    var cur = id;
    seen = seen || {};
    while (cur && table[cur] && !seen[cur]) {
      seen[cur] = true;
      chain.unshift(table[cur]);
      cur = table[cur].basedOn;
    }
    var props = {};
    var base = kind === "run" ? styles.defRun : styles.defPara;
    if (base) Object.assign(props, base);
    for (var i = 0; i < chain.length; i++) Object.assign(props, chain[i]);
    return props;
  }

  function docxParaProps(pPr) {
    var p = {};
    var jc = firstChild(pPr, "jc");
    if (jc && jc.attrs.val) p.align = jc.attrs.val;
    var ind = firstChild(pPr, "ind");
    if (ind) {
      if (ind.attrs.left != null) p.marginLeft = docxTw(ind.attrs.left);
      if (ind.attrs.right != null) p.marginRight = docxTw(ind.attrs.right);
      if (ind.attrs.firstLine != null) p.textIndent = docxTw(ind.attrs.firstLine);
      if (ind.attrs.hanging != null) p.textIndent = -docxTw(ind.attrs.hanging);
    }
    var sp = firstChild(pPr, "spacing");
    if (sp) {
      if (sp.attrs.before != null) p.marginTop = docxTw(sp.attrs.before);
      if (sp.attrs.after != null) p.marginBottom = docxTw(sp.attrs.after);
      if (sp.attrs.line != null) {
        var line = parseFloat(sp.attrs.line);
        var rule = sp.attrs.lineRule || "auto";
        if (isFinite(line)) {
          if (rule === "auto") p.lineHeight = line / 240;
          else p.lineHeight = docxTw(String(line));
        }
      }
    }
    var shd = firstChild(pPr, "shd");
    if (shd && shd.attrs.fill && shd.attrs.val !== "nil") {
      var fill = ooxmlColor(shd.attrs.fill);
      if (fill) p.background = fill;
    }
    var bdr = firstChild(pPr, "pBdr");
    if (bdr) {
      var sides = ["top", "left", "bottom", "right"];
      for (var i = 0; i < sides.length; i++) {
        var b = firstChild(bdr, sides[i]);
        if (!b) continue;
        var color = b.attrs.color && b.attrs.color !== "auto" ? ooxmlColor(b.attrs.color) : "#000000";
        var sz = b.attrs.sz ? Math.max(1, Math.round(parseFloat(b.attrs.sz) / 8)) : 1;
        var style = b.attrs.val && b.attrs.val !== "nil" && b.attrs.val !== "none" ? "solid" : "none";
        p["border" + sides[i].charAt(0).toUpperCase() + sides[i].slice(1)] = style + " " + sz + "px " + color;
      }
    }
    if (docxOn(pPr, "pageBreakBefore")) p.pageBreakBefore = true;
    if (docxOn(pPr, "keepNext")) p.keepNext = true;
    var numPr = firstChild(pPr, "numPr");
    if (numPr) {
      var ilvl = firstChild(numPr, "ilvl"), numId = firstChild(numPr, "numId");
      p.numId = numId ? parseInt(numId.attrs.val, 10) : null;
      p.ilvl = ilvl ? parseInt(ilvl.attrs.val, 10) || 0 : 0;
    }
    var outline = firstChild(pPr, "outlineLvl");
    if (outline) p.outlineLvl = parseInt(outline.attrs.val, 10);
    var tabs = firstChild(pPr, "tabs");
    if (tabs) {
      var stops = [];
      for (var t = 0; t < tabs.kids.length; t++) {
        var tab = tabs.kids[t];
        if (tab.tag !== "tab") continue;
        var pos = docxTw(tab.attrs.pos);
        if (pos != null) stops.push({ pos: pos, val: tab.attrs.val || "left" });
      }
      if (stops.length) p.tabs = stops;
    }
    return p;
  }

  function docxRunProps(rPr, theme) {
    var r = {};
    if (!rPr) return r;
    var fonts = firstChild(rPr, "rFonts");
    if (fonts) {
      var name = fonts.attrs.ascii || fonts.attrs.hAnsi || fonts.attrs.cs || fonts.attrs.eastAsia;
      var themeAttr = fonts.attrs.asciiTheme || fonts.attrs.hAnsiTheme;

      if (themeAttr) r.fontTheme = themeAttr;
      if (!name && themeAttr && theme) {
        var key = String(themeAttr).replace(/^(major|minor)/, "");
        name = theme[key] || theme[String(themeAttr)] || null;
      }
      if (name) r.fontFamily = name;
    }
    var sz = firstChild(rPr, "sz");
    if (sz) { var px = docxHalfPtPx(sz.attrs.val); if (px) r.fontSize = px; }
    var szCs = firstChild(rPr, "szCs");
    if (!sz && szCs) { var px2 = docxHalfPtPx(szCs.attrs.val); if (px2) r.fontSize = px2; }
    if (docxOn(rPr, "b")) r.bold = true;
    if (docxOn(rPr, "i")) r.italic = true;
    var u = firstChild(rPr, "u");
    if (u && u.attrs.val !== "none") {
      r.underline = u.attrs.val === "single" || !u.attrs.val ? "underline" : "underline";
    }
    if (docxOn(rPr, "strike")) r.strike = true;
    if (docxOn(rPr, "dstrike")) r.strike = true;
    if (docxOn(rPr, "caps")) r.caps = true;
    if (docxOn(rPr, "smallCaps")) r.smallCaps = true;
    var color = firstChild(rPr, "color");
    if (color && color.attrs.val && color.attrs.val !== "auto") {
      var c = ooxmlColor(color.attrs.val);
      if (c) r.color = c;
    }
    var hl = firstChild(rPr, "highlight");
    if (hl && hl.attrs.val && DOCX_HIGHLIGHTS[hl.attrs.val]) r.background = DOCX_HIGHLIGHTS[hl.attrs.val];
    var shd = firstChild(rPr, "shd");
    if (shd && shd.attrs.fill && shd.attrs.val !== "nil") {
      var rf = ooxmlColor(shd.attrs.fill);
      if (rf) r.background = rf;
    }
    var sp = firstChild(rPr, "spacing");
    if (sp && sp.attrs.val != null) { var ls = docxTw(sp.attrs.val); if (ls) r.letterSpacing = ls; }
    var va = firstChild(rPr, "vertAlign");
    if (va && va.attrs.val === "superscript") r.vertAlign = "super";
    else if (va && va.attrs.val === "subscript") r.vertAlign = "sub";
    return r;
  }

  function docxRunStyle(styles, rPr, rStyleId, theme, inherited) {
    var props = {};
    var base = docxResolve(styles, null, "run");
    Object.assign(props, base);

    if (inherited) Object.assign(props, inherited);
    if (rStyleId && styles.run[rStyleId]) {
      var chain = [];
      var cur = rStyleId, seen = {};
      while (cur && styles.run[cur] && !seen[cur]) { seen[cur] = true; chain.unshift(styles.run[cur]); cur = styles.run[cur].basedOn; }
      for (var i = 0; i < chain.length; i++) Object.assign(props, chain[i]);
    }
    Object.assign(props, docxRunProps(rPr, theme));
    return props;
  }

  var DOCX_PARA_CSS_PX = {
    "font-size": 1, "margin-left": 1, "margin-right": 1, "margin-top": 1,
    "margin-bottom": 1, "text-indent": 1, "letter-spacing": 1,
  };
  var DOCX_PARA_CSS = {
    align: "text-align", indentLeft: "margin-left", indentRight: "margin-right",
    indentFirstLine: "text-indent", spaceBefore: "margin-top", spaceAfter: "margin-bottom",
    lineHeight: "line-height", fontFamily: "font-family", fontSize: "font-size",
    bold: "font-weight", italic: "font-style", underline: "text-decoration",
    strike: "text-decoration", color: "color", background: "background-color",
    letterSpacing: "letter-spacing", caps: "text-transform", smallCaps: "font-variant",
    pageBreakBefore: "page-break-before", keepNext: "break-after", keepLines: "break-inside",
  };
  function docxStyleAttr(props, skip) {
    var out = "";
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (skip && skip[key]) continue;
      var css = DOCX_PARA_CSS[key];
      if (!css) continue;
      var v = props[key];
      if (v == null || v === false || v === "") continue;
      if (v === true) {
        if (css === "font-weight") v = "700";
        else if (css === "font-style") v = "italic";
        else if (css === "text-decoration") v = "underline";
        else continue;
      }

      if (typeof v === "number" && DOCX_PARA_CSS_PX[css]) v = Math.round(v * 1000) / 1000 + "px";
      out += css + ":" + v + ";";
    }

    if (!skip || !skip.underline) {
      if (props.underline && props.strike) out += "text-decoration:underline line-through;";
      else if (props.strike) out += "text-decoration:line-through;";
    }
    return out;
  }
  function docxFontStack(name) {
    if (!name) return null;
    var clean = String(name).replace(/["',]/g, "").trim();
    if (!clean) return null;
    return "'" + clean + "'," + clean + ",sans-serif";
  }

  function docxReadNumbering(root) {
    var abstract = {}, nums = {};
    root = xmlTop(root);
    if (!root) return { abstract: abstract, nums: nums };
    var as = allChildren(root, "abstractNum");
    for (var i = 0; i < as.length; i++) {
      var lvls = {};
      var lv = allChildren(as[i], "lvl");
      for (var j = 0; j < lv.length; j++) {
        var fmt = firstChild(lv[j], "numFmt"), txt = firstChild(lv[j], "lvlText");
        var pPr = firstChild(lv[j], "pPr"), rPr = firstChild(lv[j], "rPr");
        lvls[j] = {
          fmt: fmt ? fmt.attrs.val : "decimal",
          text: txt ? txt.attrs.val : "",
          start: (function () { var st = firstChild(lv[j], "start"); return st ? parseInt(st.attrs.val, 10) || 1 : 1; })(),
          font: rPr ? (firstChild(rPr, "rFonts") || {}).attrs : null,
          ind: pPr ? docxParaProps(pPr) : null,
        };
      }
      abstract[as[i].attrs.abstractNumId] = lvls;
    }
    var ns = allChildren(root, "num");
    for (var n = 0; n < ns.length; n++) {
      var ref = firstChild(ns[n], "abstractNumId");
      if (ref) nums[ns[n].attrs.numId] = ref.attrs.val;
    }
    return { abstract: abstract, nums: nums };
  }

  function docxListMarker(numbering, numId, ilvl, counters) {
    var abstractId = numbering.nums[numId];
    var lvls = abstractId ? numbering.abstract[abstractId] : null;
    if (!lvls || !lvls[ilvl]) return "";
    var lvl = lvls[ilvl];
    counters[abstractId + ":" + ilvl] = (counters[abstractId + ":" + ilvl] || lvl.start - 1) + 1;
    var n = counters[abstractId + ":" + ilvl];
    if (lvl.fmt === "bullet") {
      var glyph = (lvl.text || "•").replace(/^[^%]*$/, "").trim() || "•";
      return glyph;
    }
    return String(lvl.text || "%1.").replace(/%(\d)/g, function (m, d) {
      var idx = parseInt(d, 10) - 1;
      var key = abstractId + ":" + idx;
      return String(counters[key] || (lvls[idx] ? lvls[idx].start : 1));
    }).replace(new RegExp("^%" + (ilvl + 1) + "\\.?$"), String(n));
  }

  function docxReadRels(root) {
    var rels = {};
    root = xmlTop(root);
    if (!root) return rels;
    for (var i = 0; i < root.kids.length; i++) {
      var r = root.kids[i];
      if (r.tag === "Relationship" && r.attrs.Id) rels[r.attrs.Id] = r.attrs.Target;
    }
    return rels;
  }

  function docxThemeFonts(root) {
    var fonts = {};
    root = xmlTop(root);
    if (!root) return fonts;
    var scheme = (function findScheme(el) {
      for (var i = 0; i < el.kids.length; i++) {
        if (el.kids[i].tag === "fontScheme") return el.kids[i];
        var r = findScheme(el.kids[i]);
        if (r) return r;
      }
      return null;
    })(root);
    if (!scheme) return fonts;
    ["majorFont", "minorFont"].forEach(function (which) {
      var node = firstChild(scheme, which);
      if (!node) return;
      var latin = firstChild(node, "latin");
      if (!latin) return;
      var prefix = which === "majorFont" ? "major" : "minor";
      fonts[prefix + "HAnsi"] = latin.attrs.typeface;
      fonts[prefix + "Ascii"] = latin.attrs.typeface;
    });
    return fonts;
  }

  function docxDrawingImage(node, ctx) {
    var blip = (function findBlip(el) {
      for (var i = 0; i < el.kids.length; i++) {
        if (el.kids[i].tag === "blip") return el.kids[i];
        var r = findBlip(el.kids[i]);
        if (r) return r;
      }
      return null;
    })(node);
    if (blip && ctx.rels[blip.attrs.embed]) {
      var media = docxMedia(ctx.rels[blip.attrs.embed]);
      if (media) {
        var extent = (function findExtent(el) {
          for (var i = 0; i < el.kids.length; i++) {
            if (el.kids[i].tag === "extent") return el.kids[i];
            var r = findExtent(el.kids[i]);
            if (r) return r;
          }
          return null;
        })(node);
        var w = extent ? docxEmuPx(extent.attrs.cx) : null;
        var h = extent ? docxEmuPx(extent.attrs.cy) : null;
        var name = (function findName(el) {
          for (var i = 0; i < el.kids.length; i++) {
            if (el.kids[i].tag === "docPr") return el.kids[i].attrs.name || "";
            var r = findName(el.kids[i]);
            if (r) return r;
          }
          return null;
        })(node) || "";
        return { src: media, w: w, h: h, alt: name };
      }
    }

    var imagedata = (function find(el) {
      for (var i = 0; i < el.kids.length; i++) {
        if (el.kids[i].tag === "imagedata") return el.kids[i];
        var r = find(el.kids[i]);
        if (r) return r;
      }
      return null;
    })(node);
    if (imagedata && ctx.rels[imagedata.attrs.id]) {
      var m = docxMedia(ctx.rels[imagedata.attrs.id]);
      if (m) {

        var shape = (function find(el) {
          for (var i = 0; i < el.kids.length; i++) {
            if (el.kids[i].tag === "shape") return el.kids[i];
            var r = find(el.kids[i]);
            if (r) return r;
          }
          return null;
        })(node);
        var st = {};
        var src2 = (shape && shape.attrs && shape.attrs.style) || "";
        src2.replace(/([-a-z]+)\s*:\s*([^;]+)/gi, function (_m, k, v) { st[String(k).toLowerCase()] = v.trim(); return _m; });
        var w = parseFloat(st.width) * (96 / 72);
        var h = parseFloat(st.height) * (96 / 72);
        var rot = ((parseFloat(st.rotation) || 0) % 360 + 360) % 360;
        var swap = rot === 90 || rot === 270;
        return {
          src: m, alt: "",
          w: isFinite(w) && w > 0 ? (swap ? h : w) : null,
          h: isFinite(h) && h > 0 ? (swap ? w : h) : null,
          rotation: rot,
        };
      }
    }
    return null;
  }

  var docxMediaCache = null;
  async function docxPrimeMedia(arrayBuffer, rels) {
    docxMediaCache = {};
    var targets = [];
    for (var id in rels) {
      if (!Object.prototype.hasOwnProperty.call(rels, id)) continue;
      var t = String(rels[id] || "");
      if (!/^\.\.\/|^\//.test(t) && !/media\//i.test(t)) continue;
      targets.push(t.replace(/^\.\.\//, "").replace(/^\//, ""));
    }
    for (var i = 0; i < targets.length; i++) {
      var name = targets[i];
      var candidates = [name, "word/" + name];
      var url = null;
      for (var c = 0; c < candidates.length && !url; c++) {
        var bytes = await zipReadEntry(arrayBuffer, candidates[c]);
        if (!bytes) continue;
        var type = /png$/i.test(candidates[c]) ? "image/png"
          : /gif$/i.test(candidates[c]) ? "image/gif"
          : /svg$/i.test(candidates[c]) ? "image/svg+xml" : "image/jpeg";
        try { url = URL.createObjectURL(new Blob([bytes], { type: type })); } catch (e) { url = null; }
      }
      docxMediaCache[name] = url;
      docxMediaCache["word/" + name] = url;
      docxMediaCache[name.split("/").pop()] = url;
    }
    return docxMediaCache;
  }
  function docxMedia(target) {
    if (!docxMediaCache || !target) return null;
    var name = String(target).replace(/^\.\.\//, "").replace(/^\//, "");
    if (docxMediaCache[name]) return docxMediaCache[name];
    if (docxMediaCache["word/" + name]) return docxMediaCache["word/" + name];
    return docxMediaCache[name.split("/").pop()] || null;
  }

  function docxRunText(node) {
    var out = "";
    for (var i = 0; i < node.kids.length; i++) {
      var k = node.kids[i];
      if (k.tag === "t") out += k.text || "";
      else if (k.tag === "tab") out += "\t";
      else if (k.tag === "noBreakHyphen") out += "\u2011";
      else if (k.tag === "softHyphen") continue;
      else if (k.tag === "br" || k.tag === "cr" || k.tag === "drawing" || k.tag === "pict" || k.tag === "object") continue;
      else if (k.tag === "r") out += docxRunText(k);
    }
    return out;
  }

  function docxFindDrawing(el) {
    for (var i = 0; i < el.kids.length; i++) {
      var k = el.kids[i];
      if (k.tag === "drawing" || k.tag === "pict" || k.tag === "object") return k;
      var r = docxFindDrawing(k);
      if (r) return r;
    }
    return null;
  }
  function docxRunHtml(run, ctx, inherited) {
    var rPr = firstChild(run, "rPr");
    var rStyle = rPr ? firstChild(rPr, "rStyle") : null;
    var props = docxRunStyle(ctx.styles, rPr, rStyle ? rStyle.attrs.val : null, ctx.theme, inherited);
    var text = docxRunText(run);
    var img = docxFindDrawing(run);
    if (img) {
      var pic = docxDrawingImage(img, ctx);
      if (pic) {

        var w = pic.w ? Math.round(pic.w) : null;
        var h = pic.h ? Math.round(pic.h) : null;
        var style = "margin:0;";
        if (w) style += "width:" + w + "px;";
        if (h) {
          if (w) style += "height:auto;aspect-ratio:" + w + " / " + h + ";";
          else style += "height:" + h + "px;";
        }

        if (pic.rotation) style += "transform:rotate(" + pic.rotation + "deg);";
        return '<img src="' + pic.src + '" alt="' + escapeAttr(pic.alt || "") + '" style="' + style + '" />';
      }
    }
    if (!text.replace(/\S/g, "")) return text ? " " : "";
    var skip = {};
    var family = docxFontStack(props.fontFamily);
    var css = "";
    if (family) css += "font-family:" + family + ";";
    if (props.fontSize) css += "font-size:" + props.fontSize + "px;";
    if (props.bold) css += "font-weight:700;";
    if (props.italic) css += "font-style:italic;";
    if (props.underline) css += "text-decoration:underline;";
    if (props.strike) css += "text-decoration:line-through;";
    if (props.color) css += "color:" + props.color + ";";
    if (props.background) css += "background-color:" + props.background + ";";
    if (props.letterSpacing) css += "letter-spacing:" + props.letterSpacing + "px;";
    if (props.caps) css += "text-transform:uppercase;";
    if (props.smallCaps) css += "font-variant:small-caps;";
    var body = escapeHtml(text);
    if (props.vertAlign === "super") body = "<sup>" + body + "</sup>";
    else if (props.vertAlign === "sub") body = "<sub>" + body + "</sub>";
    return css ? '<span style="' + css + '">' + body + "</span>" : body;
  }

  function docxInlineHtml(p, ctx, inherited) {
    var html = "";
    for (var i = 0; i < p.kids.length; i++) {
      var kid = p.kids[i];
      if (kid.tag === "pPr") continue;
      if (kid.tag === "r") {
        html += docxRunHtml(kid, ctx, inherited);
        continue;
      }
      if (kid.tag === "hyperlink") {
        var target = kid.attrs.id ? ctx.rels[kid.attrs.id] : null;
        var inner = "";
        for (var h = 0; h < kid.kids.length; h++) {
          if (kid.kids[h].tag === "r") inner += docxRunHtml(kid.kids[h], ctx);
        }
        var href = target && /^(https?:|mailto:|tel:|#)/i.test(target) ? normalizeExternalUrl(target) : null;
        html += href ? '<a href="' + escapeAttr(href) + '" style="color:#2563eb;text-decoration:underline">' + inner + "</a>" : inner;
        continue;
      }
      if (kid.tag === "smartTag" || kid.tag === "ins" || kid.tag === "sdt" || kid.tag === "sdtContent") {
        var fake = { tag: "p", kids: kid.tag === "sdt" ? (firstChild(kid, "sdtContent") ? firstChild(kid, "sdtContent").kids : []) : kid.kids };
        html += docxInlineHtml(fake, ctx, inherited);
        continue;
      }
      if (kid.tag === "bookmarkStart" || kid.tag === "bookmarkEnd" || kid.tag === "proofErr") continue;
      if (kid.tag === "del") continue;
    }
    return html;
  }

  function docxParaHtml(p, ctx, tagName) {
    var pPr = firstChild(p, "pPr");
    var props = {};
    var base = docxResolve(ctx.styles, null, "para");
    Object.assign(props, base);
    var styleNode = pPr ? firstChild(pPr, "pStyle") : null;
    if (styleNode && styleNode.attrs.val) Object.assign(props, docxResolve(ctx.styles, styleNode.attrs.val, "para"));
    if (pPr) Object.assign(props, docxParaProps(pPr));

    var inner = docxInlineHtml(p, ctx, props);

    var breaks = (function countBreaks(el) {
      var n = 0;
      for (var i = 0; i < el.kids.length; i++) {
        var k = el.kids[i];

        if (k.tag === "br" && k.attrs.type === "page") n++;
        else n += countBreaks(k);
      }
      return n;
    })(p);

    var marker = "";
    if (props.numId != null && ctx.numbering) {
      marker = docxListMarker(ctx.numbering, props.numId, props.ilvl || 0, ctx.counters);
      if (marker) {
        if (!props.textIndent || props.textIndent >= 0) props.textIndent = -Math.max(18, (props.marginLeft || 36) * 0.5);
      }
    }

    var skip = { align: 1, marginLeft: 1, marginRight: 1, textIndent: 1, marginTop: 1, marginBottom: 1, lineHeight: 1, numId: 1, ilvl: 1, tabs: 1, outlineLvl: 1, keepNext: 1, pageBreakBefore: 1, indent: 1 };
    var css = docxStyleAttr(props, skip);
    if (props.align && props.align !== "start") {
      var map = { both: "justify", left: "left", right: "right", center: "center", distribute: "justify", start: "left", end: "right" };
      css += "text-align:" + (map[props.align] || "left") + ";";
    }
    if (props.marginLeft != null) css += "margin-left:" + props.marginLeft + "px;";
    if (props.marginRight != null) css += "margin-right:" + props.marginRight + "px;";
    if (props.textIndent) css += "text-indent:" + props.textIndent + "px;";
    if (props.marginTop != null) css += "margin-top:" + props.marginTop + "px;";
    if (props.marginBottom != null) css += "margin-bottom:" + props.marginBottom + "px;";
    if (props.lineHeight != null) {
      css += "line-height:" + (typeof props.lineHeight === "number" ? props.lineHeight : props.lineHeight + "px") + ";";
    }

    var tag = tagName || "p";
    if (!tagName && props.outlineLvl != null && props.outlineLvl >= 0 && props.outlineLvl < 3) {
      tag = "h" + (props.outlineLvl + 1);
    }
    var content = marker ? escapeHtml(marker) + " " + inner : inner;
    if (!content.trim() && !marker) content = "<br>";

    var out = "";
    for (var b = 0; b < breaks; b++) out += PDF_BREAK_HTML;
    if (props.pageBreakBefore) out += PDF_BREAK_HTML;
    out += "<" + tag + (css ? ' style="' + css + '"' : "") + ">" + content + "</" + tag + ">";
    return out;
  }

  function borderDescriptor(b) {

    if (!b || !b.attrs) return null;
    var style = b.attrs.val;
    if (!style || style === "nil" || style === "none") return null;
    if (style === "hidden") style = "none";
    else if (style !== "solid" && style !== "double" && style !== "dotted" && style !== "dashed") style = "solid";
    var sz = b.attrs.sz ? Math.max(1, Math.round(parseFloat(b.attrs.sz) / 8)) : 1;
    var color = b.attrs.color && b.attrs.color !== "auto" && b.attrs.color !== "nil"
      ? (ooxmlColor(b.attrs.color) || "#000") : "#000";
    return style + " " + sz + "px " + color;
  }

  function docxTableStyleChain(id, tableStyles) {
    if (!id || !tableStyles || !tableStyles[id]) return null;
    var chain = [], cur = id, seen = {};
    while (cur && tableStyles[cur] && !seen[cur]) {
      seen[cur] = true;
      chain.unshift(tableStyles[cur]);
      cur = tableStyles[cur].basedOn;
    }
    var borders = null, conds = {};
    for (var i = 0; i < chain.length; i++) {
      var sb = chain[i].borders;
      if (sb) {
        if (!borders) borders = {};
        for (var k in sb) {
          if (Object.prototype.hasOwnProperty.call(sb, k) && sb[k]) borders[k] = sb[k];
        }
      }
      var sc = chain[i].conds;
      for (var k2 in sc) {
        if (Object.prototype.hasOwnProperty.call(sc, k2)) conds[k2] = sc[k2];
      }
    }
    return { id: id, borders: borders, conds: conds };
  }
  function docxChainBorder(chain, side) {
    return chain && chain.borders ? chain.borders[side] : null;
  }

  function docxTableHtml(tbl, ctx) {
    var tblPr = firstChild(tbl, "tblPr");

    var styleRef = tblPr ? firstChild(tblPr, "tblStyle") : null;
    var stChain = docxTableStyleChain(
      styleRef ? styleRef.attrs.val : null,
      ctx.styles && ctx.styles.table
    );
    var stConds = stChain ? stChain.conds : null;
    var stFirstRow = stConds && stConds.firstRow;
    var stLastRow = stConds && stConds.lastRow;
    var stFirstCol = stConds && stConds.firstCol;
    var stLastCol = stConds && stConds.lastCol;
    var stBand = stConds && stConds.band2Horz;
    var stAccent = (stFirstRow && stFirstRow.fill) || null;

    var grid = firstChild(tbl, "tblGrid");
    var cols = [];
    if (grid) {
      var gcs = allChildren(grid, "gridCol");
      for (var g = 0; g < gcs.length; g++) {
        var px = docxTw(gcs[g].attrs.w);
        if (px) cols.push(Math.max(8, Math.round(px)));
      }
    }
    var css = "border-collapse:collapse;";
    var tblW = tblPr ? firstChild(tblPr, "tblW") : null;
    if (tblW && tblW.attrs.type === "pct" && tblW.attrs.w) {
      css += "width:" + Math.round(parseFloat(tblW.attrs.w) / 50) + "%;";
    } else if (cols.length) {
      css += "width:" + cols.reduce(function (a, b) { return a + b; }, 0) + "px;";
    }

    var tblp = tblPr ? firstChild(tblPr, "tblpPr") : null;
    if (tblp && (tblp.attrs.tblpX != null || tblp.attrs.tblpY != null)) {
      var mx = (ctx.margins && ctx.margins.left) || 0;
      var my = (ctx.margins && ctx.margins.top) || 0;
      var lp = tblp.attrs.tblpX != null ? docxTw(tblp.attrs.tblpX) : null;
      var tp = tblp.attrs.tblpY != null ? docxTw(tblp.attrs.tblpY) : null;
      if (lp != null) {
        if (tblp.attrs.horzAnchor === "page") lp -= mx;
        lp = Math.max(-mx, lp);
        css += "position:absolute;left:" + lp + "px;margin:0;z-index:5;";
      }
      if (tp != null) {
        if (tblp.attrs.vertAnchor === "page") tp -= my;
        tp = Math.max(-my, tp);
        css += "top:" + tp + "px;";
      }
    } else if (tblPr) {
      var jc = firstChild(tblPr, "jc");
      if (jc && jc.attrs.val === "center") css += "margin-left:auto;margin-right:auto;";
    }

    var tblBorders = tblPr ? firstChild(tblPr, "tblBorders") : null;
    var tB = {};
    if (tblBorders) {
      var bSides = ["top", "left", "bottom", "right", "insideH", "insideV"];
      for (var bi = 0; bi < bSides.length; bi++) {
        tB[bSides[bi]] = borderDescriptor(firstChild(tblBorders, bSides[bi]));
      }
    } else if (stChain && stChain.borders) {
      tB = {
        top: docxChainBorder(stChain, "top"), left: docxChainBorder(stChain, "left"),
        bottom: docxChainBorder(stChain, "bottom"), right: docxChainBorder(stChain, "right"),
        insideH: docxChainBorder(stChain, "insideH"), insideV: docxChainBorder(stChain, "insideV")
      };
    } else {

      css += "border:none;";
    }

    var rows = allChildren(tbl, "tr");
    var gridRows = [];
    var contAt = {};
    var rowCount = rows.length;
    var totalCols = 0;
    for (var r = 0; r < rowCount; r++) {
      var tcs = allChildren(rows[r], "tc");
      var rowImm = [], cursor = 0;
      for (var ci = 0; ci < tcs.length; ci++) {
        var tcPr0 = firstChild(tcs[ci], "tcPr");
        var span0 = 1;
        var spanEl = tcPr0 ? firstChild(tcPr0, "gridSpan") : null;
        if (spanEl && spanEl.attrs.val) span0 = parseInt(spanEl.attrs.val, 10) || 1;
        rowImm.push({ tc: tcs[ci], tcPr: tcPr0, colStart: cursor, span: span0 });
        var vm0 = tcPr0 ? firstChild(tcPr0, "vMerge") : null;
        if (vm0 && vm0.attrs.val !== "restart") contAt[r + ":" + cursor] = true;
        cursor += span0;
      }
      if (cursor > totalCols) totalCols = cursor;
      gridRows.push(rowImm);
    }

    var html = "";
    var colgroup = "";
    if (cols.length) {
      colgroup += "<colgroup>";
      for (var c = 0; c < cols.length; c++) colgroup += '<col style="width:' + cols[c] + 'px" />';
      colgroup += "</colgroup>";
    }

    var headerCount = 0;
    for (var h = 0; h < rowCount; h++) {
      var htrPr = firstChild(rows[h], "trPr");
      if (htrPr && firstChild(htrPr, "tblHeader")) headerCount++;
      else break;
    }

    var designAttr = "";
    var TS = window.EMTableStyles;
    if (TS && stConds && (stFirstRow || stBand || stLastRow || stFirstCol || stLastCol)) {
      var wPreset = TS.presetForWord(styleRef ? styleRef.attrs.val : null, stAccent);
      if (wPreset) {
        designAttr = " data-table-style=\"" + wPreset.id + "\" data-table-opts='" +
          JSON.stringify({
            header: !!(stFirstRow || headerCount > 0),
            total: !!stLastRow,
            bandedRows: !!stBand,
            bandedCols: !!(stConds.band2Vert || stConds.band1Vert),
            firstCol: !!stFirstCol,
            lastCol: !!stLastCol
          }) + "'";
      }
    }
    var html = '<table style="' + css + '"' + designAttr + ">" + colgroup;
    for (var r2 = 0; r2 < rowCount; r2++) {
      var cells2 = gridRows[r2];
      if (!cells2.length) continue;
      if (r2 === 0 && headerCount > 0) html += "<thead>";
      if (r2 === headerCount) {
        if (headerCount > 0) html += "</thead>";
        html += "<tbody>";
      }
      var rowHtml = "";
      for (var k2 = 0; k2 < cells2.length; k2++) {
        var it = cells2[k2];
        if (contAt[r2 + ":" + it.colStart]) continue;
        var tcPr = it.tcPr;
        var cellCss = "";
        var colspan = it.span, rowspan = 1;
        var vm = tcPr ? firstChild(tcPr, "vMerge") : null;
        if (vm && vm.attrs.val === "restart") {

          for (var f = r2 + 1; f < rowCount; f++) {
            var cont = false;
            for (var fk = 0; fk < gridRows[f].length; fk++) {
              if (gridRows[f][fk].colStart === it.colStart &&
                  gridRows[f][fk].tcPr && firstChild(gridRows[f][fk].tcPr, "vMerge")) {
                cont = true;
                break;
              }
            }
            if (cont) rowspan++;
            else break;
          }
        }
        var tcW = tcPr ? firstChild(tcPr, "tcW") : null;
        if (tcW && tcW.attrs.type === "dxa" && tcW.attrs.w) {
          var w = docxTw(tcW.attrs.w);
          if (w) cellCss += "width:" + Math.round(w) + "px;";
        } else if (tcW && tcW.attrs.type === "pct" && tcW.attrs.w) {
          cellCss += "width:" + Math.min(100, Math.round(parseFloat(tcW.attrs.w) / 50)) + "%;";
        }
        var shd = tcPr ? firstChild(tcPr, "shd") : null;
        var explicitFill = shd && shd.attrs.fill && shd.attrs.val !== "nil"
          ? ooxmlColor(shd.attrs.fill) : null;
        if (explicitFill) cellCss += "background-color:" + explicitFill + ";";

        if (stConds && !explicitFill) {
          var isHdr = r2 < headerCount;
          var bodyIdx = r2 - headerCount;
          var condFill = null, condBold = false;
          var isVisLastRow = r2 === rowCount - 1;
          if (isHdr) {
            if (stFirstRow) { condFill = stFirstRow.fill; if (stFirstRow.bold) condBold = true; }
          } else if (isVisLastRow && stLastRow) {
            condFill = stLastRow.fill; if (stLastRow.bold) condBold = true;
          } else {
            if (stBand && bodyIdx >= 0 && bodyIdx % 2 === 1) {
              condFill = stBand.fill; if (stBand.bold) condBold = true;
            }
            if (stFirstCol && it.colStart === 0) { condFill = stFirstCol.fill; if (stFirstCol.bold) condBold = true; }
            if (stLastCol && it.colStart + it.span === totalCols) { condFill = stLastCol.fill; if (stLastCol.bold) condBold = true; }
          }
          if (condFill) cellCss += "background-color:" + condFill + ";";
          if (condBold) cellCss += "font-weight:700;";
        }
        var valign = tcPr ? firstChild(tcPr, "vAlign") : null;
        if (valign && valign.attrs.val) cellCss += "vertical-align:" + valign.attrs.val + ";";

        var tcBorders = tcPr ? firstChild(tcPr, "tcBorders") : null;
        var sides = ["top", "left", "bottom", "right"];
        var lastCol = cells2.length - 1;
        for (var si = 0; si < sides.length; si++) {
          var side = sides[si];
          var d = tcBorders ? borderDescriptor(firstChild(tcBorders, side)) : null;
          if (!d) {

            var isHdrRow = r2 < headerCount;
            var roleBorders = null;
            if (stConds) {
              if (isHdrRow && stFirstRow && stFirstRow.borders) roleBorders = stFirstRow.borders;
              else if (r2 === rowCount - 1 && stLastRow && stLastRow.borders) roleBorders = stLastRow.borders;
              else if (it.colStart === 0 && stFirstCol && stFirstCol.borders) roleBorders = stFirstCol.borders;
              else if (it.colStart + it.span === totalCols && stLastCol && stLastCol.borders) roleBorders = stLastCol.borders;
            }
            if (roleBorders && roleBorders[side]) d = roleBorders[side];
            if (!d) {
              if (side === "top") d = r2 === 0 ? tB.top : tB.insideH;
              else if (side === "bottom") d = r2 === rowCount - 1 ? tB.bottom : tB.insideH;
              else if (side === "left") d = k2 === 0 ? tB.left : tB.insideV;
              else if (side === "right") d = k2 === lastCol ? tB.right : tB.insideV;
            }
          }
          if (d) cellCss += "border-" + side + ":" + d + ";";
        }

        var inner = "";
        for (var b2 = 0; b2 < it.tc.kids.length; b2++) {
          var blk = it.tc.kids[b2];
          if (blk.tag === "p") inner += docxParaHtml(blk, ctx);
          else if (blk.tag === "tbl") inner += docxTableHtml(blk, ctx);
          else if (blk.tag === "br") inner += "<br>";
        }
        if (!inner) inner = "<p><br></p>";
        rowHtml += "<td" + (colspan > 1 ? ' colspan="' + colspan + '"' : "") +
          (rowspan > 1 ? ' rowspan="' + rowspan + '"' : "") +
          (cellCss ? ' style="' + cellCss + '"' : "") + ">" + inner + "</td>";
      }
      if (rowHtml) html += "<tr>" + rowHtml + "</tr>";
    }
    if (headerCount > 0 && headerCount < rowCount) html += "</tbody>";
    return html + "</table>";
  }

  function docxDocumentNode(root) {
    return xmlTop(root);
  }
  function docxBodyHtml(root, ctx) {

    var doc = docxDocumentNode(root);
    var body = firstChild(doc, "body");
    if (!body) body = (doc.tag === "hdr" || doc.tag === "ftr") ? doc : null;
    if (!body) return "";
    var html = "";
    for (var i = 0; i < body.kids.length; i++) {
      var node = body.kids[i];
      if (node.tag === "p") html += docxParaHtml(node, ctx);
      else if (node.tag === "tbl") {

        html += docxTableHtml(node, ctx);
      } else if (node.tag === "sdt") {
        var content = firstChild(node, "sdtContent");
        if (content) {
          for (var s = 0; s < content.kids.length; s++) {
            if (content.kids[s].tag === "p") html += docxParaHtml(content.kids[s], ctx);
            else if (content.kids[s].tag === "tbl") html += docxTableHtml(content.kids[s], ctx);
          }
        }
      }
    }
    return html;
  }

  function docxBodyHtmlWithSections(root, ctx) {
    var sections = docxCollectSections(root);
    var html = "";
    for (var si = 0; si < sections.length; si++) {
      var section = sections[si];
      if (si > 0) {
        html += docxSectionBreakHtml(section.setup);
      }
      if (section.setup.columns > 1) {
        html += '<div style="column-count:' + section.setup.columns + ';column-gap:36px">';
      }
      for (var pi = 0; pi < section.paragraphs.length; pi++) {
        var item = section.paragraphs[pi];
        if (item.isTable) {
          html += docxTableHtml(item.node, ctx);
        } else {
          html += docxParaHtml(item.node, ctx);
        }
      }
      if (section.setup.columns > 1) {
        html += "</div>";
      }
    }
    return html;
  }

  function docxSection(root) {
    root = docxDocumentNode(root);
    var setup = { w: 794, h: 1123, portrait: true, marginTop: 96, marginRight: 96, marginBottom: 96, marginLeft: 96, bg: null, columns: 1, headerRefs: [], footerRefs: [] };
    function findSectPr(el) {
      for (var i = 0; i < el.kids.length; i++) {
        if (el.kids[i].tag === "sectPr") return el.kids[i];
        var r = findSectPr(el.kids[i]);
        if (r) return r;
      }
      return null;
    }
    var sect = findSectPr(root);
    if (!sect) return setup;
    var pgSz = firstChild(sect, "pgSz");
    if (pgSz) {
      var w = docxTw(pgSz.attrs.w), h = docxTw(pgSz.attrs.h);
      if (w && h) {
        setup.portrait = pgSz.attrs.orient !== "landscape";
        setup.w = setup.portrait ? w : h;
        setup.h = setup.portrait ? h : w;
      }
    }
    var pgMar = firstChild(sect, "pgMar");
    if (pgMar) {
      if (pgMar.attrs.top) setup.marginTop = docxTw(pgMar.attrs.top);
      if (pgMar.attrs.right) setup.marginRight = docxTw(pgMar.attrs.right);
      if (pgMar.attrs.bottom) setup.marginBottom = docxTw(pgMar.attrs.bottom);
      if (pgMar.attrs.left) setup.marginLeft = docxTw(pgMar.attrs.left);
    }
    var cols = firstChild(sect, "cols");
    if (cols && cols.attrs.num) setup.columns = parseInt(cols.attrs.num, 10) || 1;
    var hrefs = allChildren(sect, "headerReference");
    for (var i = 0; i < hrefs.length; i++) setup.headerRefs.push({ type: hrefs[i].attrs.type, id: hrefs[i].attrs.id });
    var frefs = allChildren(sect, "footerReference");
    for (var f = 0; f < frefs.length; f++) setup.footerRefs.push({ type: frefs[f].attrs.type, id: frefs[f].attrs.id });
    return setup;
  }

  function docxSectionFromNode(sect) {
    var setup = { w: 794, h: 1123, portrait: true, marginTop: 96, marginRight: 96, marginBottom: 96, marginLeft: 96, bg: null, columns: 1, headerRefs: [], footerRefs: [] };
    if (!sect) return setup;
    var pgSz = firstChild(sect, "pgSz");
    if (pgSz) {
      var w = docxTw(pgSz.attrs.w), h = docxTw(pgSz.attrs.h);
      if (w && h) {
        setup.portrait = pgSz.attrs.orient !== "landscape";
        setup.w = setup.portrait ? w : h;
        setup.h = setup.portrait ? h : w;
      }
    }
    var pgMar = firstChild(sect, "pgMar");
    if (pgMar) {
      if (pgMar.attrs.top) setup.marginTop = docxTw(pgMar.attrs.top);
      if (pgMar.attrs.right) setup.marginRight = docxTw(pgMar.attrs.right);
      if (pgMar.attrs.bottom) setup.marginBottom = docxTw(pgMar.attrs.bottom);
      if (pgMar.attrs.left) setup.marginLeft = docxTw(pgMar.attrs.left);
    }
    var cols = firstChild(sect, "cols");
    if (cols && cols.attrs.num) setup.columns = parseInt(cols.attrs.num, 10) || 1;
    var hrefs = allChildren(sect, "headerReference");
    for (var i = 0; i < hrefs.length; i++) setup.headerRefs.push({ type: hrefs[i].attrs.type, id: hrefs[i].attrs.id });
    var frefs = allChildren(sect, "footerReference");
    for (var f = 0; f < frefs.length; f++) setup.footerRefs.push({ type: frefs[f].attrs.type, id: frefs[f].attrs.id });
    return setup;
  }

  function docxCollectSections(root) {
    root = docxDocumentNode(root);
    var body = firstChild(root, "body");
    if (!body) return [{ setup: docxSection(root), startIdx: 0, paragraphs: [] }];

    var defaultSetup = docxSection(root);
    var sections = [];
    var currentSection = { setup: defaultSetup, startIdx: 0, paragraphs: [] };
    var paraIndex = 0;

    function processNode(node) {
      if (node.tag === "p") {
        currentSection.paragraphs.push({ node: node, index: paraIndex });
        var pPr = firstChild(node, "pPr");
        var sectPr = pPr ? firstChild(pPr, "sectPr") : null;
        if (sectPr) {
          var nextSetup = docxSectionFromNode(sectPr);
          sections.push(currentSection);
          currentSection = { setup: nextSetup, startIdx: paraIndex + 1, paragraphs: [] };
        }
        paraIndex++;
      } else if (node.tag === "tbl") {
        currentSection.paragraphs.push({ node: node, index: paraIndex, isTable: true });
        paraIndex++;
      } else if (node.tag === "sdt") {
        var content = firstChild(node, "sdtContent");
        if (content) {
          for (var s = 0; s < content.kids.length; s++) {
            processNode(content.kids[s]);
          }
        }
      }
    }

    for (var i = 0; i < body.kids.length; i++) {
      processNode(body.kids[i]);
    }

    var bodySectPr = firstChild(body, "sectPr");
    if (bodySectPr) {
      var finalSetup = docxSectionFromNode(bodySectPr);
      currentSection.setup = finalSetup;
    }

    sections.push(currentSection);
    return sections;
  }

  function docxSectionConfigToJson(setup) {
    return JSON.stringify({
      orientation: setup.portrait ? "portrait" : "landscape",
      margins: {
        top: setup.marginTop, right: setup.marginRight,
        bottom: setup.marginBottom, left: setup.marginLeft
      },
      columns: setup.columns || 1
    });
  }

  function docxSectionBreakHtml(setup) {
    var configStr = docxSectionConfigToJson(setup).replace(/'/g, "&apos;");
    return '<div class="section-break has-config" contenteditable="false" data-section-config=\'' + configStr + '\'></div><p><br></p>';
  }

  async function convertDocxDocument(file) {
    docxMediaCache = null;
    var ab = await file.arrayBuffer();
    var docEntry = await zipReadEntry(ab, "word/document.xml");
    if (!docEntry) {
      console.warn("[docs] docx: word/document.xml not found in the archive");
      return null;
    }
    var docRoot = xmlParse(new TextDecoder("utf-8").decode(docEntry));
    var stylesEntry = await zipReadEntry(ab, "word/styles.xml");
    var styles = stylesEntry ? docxReadStyles(xmlParse(new TextDecoder("utf-8").decode(stylesEntry))) : { para: {}, run: {}, link: {}, defPara: {}, defRun: {}, table: {}, theme: {} };
    var themeEntry = await zipReadEntry(ab, "word/theme/theme1.xml");
    styles.theme = themeEntry ? docxThemeFonts(xmlParse(new TextDecoder("utf-8").decode(themeEntry))) : {};

    [styles.para, styles.run, styles.link, styles.defPara, styles.defRun].forEach(function (table) {
      for (var id in table) {
        if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
        var pr = table[id];
        if (!pr || !pr.fontTheme || pr.fontFamily) continue;
        var key = String(pr.fontTheme).replace(/^(major|minor)/, "");
        var resolved = styles.theme[key] || styles.theme[String(pr.fontTheme)];
        if (resolved) pr.fontFamily = resolved;
      }
    });
    var numberingEntry = await zipReadEntry(ab, "word/numbering.xml");
    var numbering = numberingEntry ? docxReadNumbering(xmlParse(new TextDecoder("utf-8").decode(numberingEntry))) : null;
    var relsEntry = await zipReadEntry(ab, "word/_rels/document.xml.rels");
    var rels = relsEntry ? docxReadRels(xmlParse(new TextDecoder("utf-8").decode(relsEntry))) : {};

    await docxPrimeMedia(ab, rels);
    var ctx = {
      styles: styles, theme: styles.theme, numbering: numbering, rels: rels,
      arrayBuffer: ab, counters: {},
    };
    var sections = docxCollectSections(docRoot);
    var firstSection = sections[0] || { setup: docxSection(docRoot) };

    var fs = firstSection.setup || {};
    ctx.margins = {
      left: fs.marginLeft || 0, top: fs.marginTop || 0,
      right: fs.marginRight || 0, bottom: fs.marginBottom || 0
    };
    var html = docxBodyHtmlWithSections(docRoot, ctx);
    if (!html.replace(/\s/g, "")) html = "<p><br></p>";

    var header = "", footer = "";
    async function readPart(refs, kind) {
      for (var i = 0; i < refs.length; i++) {
        if (refs[i].type && refs[i].type !== "default") continue;
        var target = rels[refs[i].id];
        if (!target) continue;
        var entry = await zipReadEntry(ab, "word/" + String(target).replace(/^\.\.\//, ""));
        if (!entry) continue;
        var root = xmlParse(new TextDecoder("utf-8").decode(entry));
        var partCtx = { styles: styles, theme: styles.theme, numbering: numbering, rels: rels, arrayBuffer: ab, counters: {} };
        return docxBodyHtml(root, partCtx);
      }
      return "";
    }
    header = await readPart(firstSection.setup.headerRefs, "header");
    footer = await readPart(firstSection.setup.footerRefs, "footer");

    return {
      html: html,
      pageSetup: {
        w: firstSection.setup.w, h: firstSection.setup.h, portrait: firstSection.setup.portrait,
        marginTop: firstSection.setup.marginTop, marginRight: firstSection.setup.marginRight,
        marginBottom: firstSection.setup.marginBottom, marginLeft: firstSection.setup.marginLeft,
        bg: firstSection.setup.bg || "#ffffff",
      },
      sections: sections.map(function (s) { return s.setup; }),
      header: header,
      footer: footer,
    };
  }

  async function convertDocxToHtml(file) {
    var ab = await file.arrayBuffer();
    var full = null;
    try { full = await convertDocxDocument(file); }
    catch (e) {
      full = null;
      console.warn("[docs] .docx converter fell back to Mammoth:", (e && e.stack) || e);
    }
    if (full && full.html && full.html.replace(/\S/g, "")) {
      return {
        html: importHtmlToContent(full.html),
        pageSetup: full.pageSetup || null,
        header: full.header || "",
        footer: full.footer || "",
        sections: full.sections || null,
      };
    }
    var text = (typeof mammoth !== "undefined")
      ? await mammoth.convertToHtml({ arrayBuffer: ab })
          .then(function (r) { return r.value; }).catch(function () { return null; })
      : null;
    if (text && text.replace(/\S/g, "")) {
      return { html: importHtmlToContent(text), pageSetup: null, header: "", footer: "", sections: null };
    }
    var plain = await convertDocxTextFallback(ab);
    return { html: plain ? importTextToHtml(plain, false) : "<p><br></p>", pageSetup: null, header: "", footer: "", sections: null };
  }

  async function convertDocToHtml(file) {
    var ab = await file.arrayBuffer();

    var bytes = new Uint8Array(ab);
    var head = new TextDecoder("latin1").decode(bytes.slice(0, 16));
    var headText = new TextDecoder("latin1").decode(bytes.slice(0, 2048));

    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      var asDocx = await convertDocxDocument(file);
      if (asDocx && asDocx.html && asDocx.html.replace(/\S/g, "")) {
        return {
          html: importHtmlToContent(asDocx.html),
          pageSetup: asDocx.pageSetup || null,
          header: asDocx.header || "",
          footer: asDocx.footer || "",
        };
      }
    }
    if (/^\s*\{\\rtf/.test(head)) {
      return { html: importHtmlToContent(convertRtfToText(new TextDecoder("latin1").decode(ab))), pageSetup: null, header: "", footer: "" };
    }
    if (/<\s*(!doctype html|html|body|p|div|table|h[1-6])/i.test(headText)) {
      var doc = xmlParse(headText);
      return { html: importHtmlToContent(new TextDecoder("utf-8").decode(ab)), pageSetup: null, header: "", footer: "" };
    }

    var txt = convertDocToText(ab);
    if (!txt || !txt.replace(/\s/g, "")) {
      throw new Error("EMPTYDOC");
    }
    console.warn("[docs] .doc: recovered text only — this is the binary Word 97-2003 format, which carries its layout in a table this app cannot read. Re-save it as .docx for a faithful import.");
    return { html: importTextToHtml(txt, false), pageSetup: null, header: "", footer: "" };
  }

  function nullContentToSpacer(plain) {
    return importTextToHtml(plain || "", false);
  }

  var PDF_WORKER_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var PDF_MAX_RENDER_PX = 2400;
  var PDF_EXACT_MARGIN = 0;

  var PDF_EMOJI_FONT = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji'," +
    "'Twemoji Mozilla','Segoe UI Symbol','Arial Unicode MS',sans-serif";

  var PDF_EMOJI_RE = /[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2934-\u2935\u2B00-\u2BFF\u3030\u303D\u3297\u3299\uFE0F\u{1F000}-\u{1FAFF}]/u;
  function pdfIsEmojiRun(run) {
    if (!run) return false;
    if (/emoji|symbol|marlett|wingding|webding/i.test(run.family || "")) return true;
    try { return PDF_EMOJI_RE.test(run.text || ""); } catch (e) { return false; }
  }

  var PDF_BREAK_HTML = '<div class="emdocs-page-break emdocs-page-break--pdf" contenteditable="false"></div>';

  function pdfRound(n) { return Math.round(n * 100) / 100; }
  function pdfClamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function pdfRgb(c) { return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"; }

  function pdfCssFontFamily(rawName, generic) {

    var g = String(generic || "").toLowerCase();
    var gen = /mono/.test(g) ? "monospace" : (/serif/.test(g) && !/sans/.test(g) ? "serif" : "sans-serif");
    var name = String(rawName || "")
      .replace(/^[A-Z]{6}\+/, "")
      .replace(/[-_,]\s*(BoldMT|ItalicMT|BoldItalicMT|Bold|Italic|Oblique|Black|Light|Medium|Semibold|Semilight|Demi|ExtraLight|Regular|Roman|Thin|Heavy|Ultra|PS|MT|MS|Book|Text|Display)\s*$/i, "")
      .replace(/\s+(Bold|Italic|Oblique|Black|Light|Medium|Semibold|Demi|Regular|Roman|Thin|Heavy|Ultra)\s*$/i, "")
      .replace(/["',()]/g, "")
      .trim();

    if (!name || /^g_?d\d+_f\d+$/i.test(name) || /^pdfjs/i.test(name)) return gen;

    if (/emoji|emojimono|symbol|marlett|wingding|webding|opensymbol|applecolor/i.test(name)) {
      return PDF_EMOJI_FONT;
    }

    if (/courier|mono|consol/i.test(name)) return "'" + name + "', 'Courier New', monospace";
    if (/times|georgia|garamond|cambria|bookman|palatino|baskerville|didot|minion|century/i.test(name)) {
      return "'" + name + "', 'Times New Roman', Times, serif";
    }
    if (/helvetica|arial/i.test(name)) return "'" + name + "', Helvetica, Arial, sans-serif";
    return "'" + name + "', " + gen;
  }

  function pdfNormText(s) { return String(s == null ? "" : s).replace(/\s+/g, ""); }

  function pdfPageOps(page) {
    if (!page.__emuOps) page.__emuOps = page.getOperatorList();
    return page.__emuOps;
  }

  function pdfShowTextString(args) {
    try {
      var items = args && args[0];
      if (typeof items === "string") return items;
      if (!Array.isArray(items)) return "";
      if (items.length && typeof items[0] === "object" && items[0] &&
          ("unicode" in items[0] || "fontChar" in items[0])) return pdfGlyphsToText(items);
      var out = "";
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (typeof it === "string") { out += it; continue; }
        if (Array.isArray(it)) { out += pdfGlyphsToText(it); continue; }
        if (it && typeof it.str === "string") { out += it.str; continue; }
        if (it && Array.isArray(it.glyphs)) { out += pdfGlyphsToText(it.glyphs); continue; }
      }
      return out;
    } catch (e) { return ""; }
  }
  function pdfGlyphsToText(glyphs) {
    var out = "";
    for (var i = 0; i < glyphs.length; i++) {
      var g = glyphs[i];
      if (!g) continue;
      if (typeof g === "string") { out += g; continue; }
      var ch = (typeof g.unicode === "string" && g.unicode) ? g.unicode
        : (typeof g.fontChar === "string" ? g.fontChar : "");
      if (!ch && g.isSpace) ch = " ";
      out += ch;
    }
    return out;
  }

  async function pdfPageRuns(page, viewport) {
    var lib = window.pdfjsLib;
    var tc = await page.getTextContent();

    var ops = await pdfPageOps(page);
    var styles = tc.styles || {};

    var entries = [];
    var curFont = null, curColor = [0, 0, 0];
    for (var i = 0; i < ops.fnArray.length; i++) {
      var fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === lib.OPS.setFont) curFont = args[0];
      else if (fn === lib.OPS.setFillRGBColor) curColor = [args[0] || 0, args[1] || 0, args[2] || 0];
      else if (fn === lib.OPS.setFillGray) curColor = [args[0] || 0, args[0] || 0, args[0] || 0];
      else if (fn === lib.OPS.showText || fn === lib.OPS.showSpacedText) {
        entries.push({ font: curFont, color: curColor, norm: pdfNormText(pdfShowTextString(args)), off: 0 });
      }
    }

    var entryIdx = 0, lastEntry = null;
    function entryFor(text) {
      var norm = pdfNormText(text);
      while (entryIdx < entries.length) {
        var e = entries[entryIdx];
        var rest = e.norm.slice(e.off);
        if (!rest) { entryIdx++; continue; }
        if (rest.indexOf(norm) === 0) { e.off += norm.length; lastEntry = e; return e; }
        if (norm.indexOf(rest) === 0) { entryIdx++; lastEntry = e; return e; }
        entryIdx++;
      }
      return lastEntry;
    }

    var fontCache = {};
    async function fontInfo(fontName) {
      var info = fontCache[fontName];
      if (!info) info = fontCache[fontName] = { bold: false, italic: false, family: "" };
      var fo = null;
      try { fo = await page.commonObjs.get(fontName); } catch (e) { fo = null; }
      if (fo) {
        info.bold = info.bold || !!fo.bold;
        info.italic = info.italic || !!fo.italic;
        info.family = fo.loadedName || fo.name || info.family;
      }

      var src = String((fo && fo.name) || info.family || "").replace(/^[A-Z]{6}\+/, "");
      if (/bold|black|heavy|semibold|demibold|extrabold|[_-]bd$/i.test(src)) info.bold = true;
      if (/italic|oblique/i.test(src)) info.italic = true;
      return info;
    }

    var items = [];
    for (var k = 0; k < tc.items.length; k++) {
      var it = tc.items[k];
      if (!it || typeof it.str !== "string") continue;
      if (!it.str.replace(/\s/g, "")) continue;
      var style = entryFor(it.str);

      var tx = lib.Util.transform(viewport.transform, it.transform);
      var size = Math.hypot(tx[2], tx[3]);
      if (!(size > 0.4)) continue;
      var st = styles[it.fontName] || {};
      var ascent = typeof st.ascent === "number" ? st.ascent : 0.8;
      var fontName = (style && style.font) || it.fontName;
      var finfo = await fontInfo(fontName);
      items.push({
        text: it.str,
        x: tx[4],
        baseline: tx[5],
        top: tx[5] - size * ascent,
        bottom: tx[5] + size * Math.abs(typeof st.descent === "number" ? st.descent : 0.2),
        width: (typeof it.width === "number" && it.width > 0) ? it.width : it.str.length * size * 0.5,
        size: size,
        fontKey: fontName || "",
        family: pdfCssFontFamily(finfo.family, st.fontFamily),
        bold: !!finfo.bold,
        italic: !!finfo.italic,
        color: (style && style.color) ? style.color : [0, 0, 0],
      });
    }
    return pdfMergeRuns(items);
  }

  function pdfMergeRuns(items) {
    var runs = [];

    items.sort(function (a, b) {
      return (Math.round(a.baseline * 2) - Math.round(b.baseline * 2)) || (a.x - b.x);
    });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var last = runs[runs.length - 1];
      var sameLine = last && Math.abs(last.baseline - it.baseline) <= Math.max(last.size, it.size) * 0.4;
      var sameStyle = last && last.fontKey === it.fontKey && last.bold === it.bold &&
        last.italic === it.italic && last.family === it.family &&
        last.color[0] === it.color[0] && last.color[1] === it.color[1] && last.color[2] === it.color[2];
      if (sameLine && sameStyle) {
        var gap = it.x - (last.x + last.width);
        if (gap > Math.max(last.size, it.size) * 0.6) {
          runs.push({
            text: it.text, x: it.x, baseline: it.baseline, top: it.top, bottom: it.bottom,
            width: it.width, size: it.size, fontKey: it.fontKey,
            family: it.family, bold: it.bold, italic: it.italic, color: it.color,
          });
          continue;
        }
        if (gap > it.size * 0.14 && !/\s$/.test(last.text) && !/^\s/.test(it.text)) last.text += " ";
        last.text += it.text;
        last.width = Math.max(last.width, it.x + it.width - last.x);
        last.size = Math.max(last.size, it.size);
        last.bottom = Math.max(last.bottom, it.bottom);
      } else {
        runs.push({
          text: it.text, x: it.x, baseline: it.baseline, top: it.top, bottom: it.bottom,
          width: it.width, size: it.size, fontKey: it.fontKey,
          family: it.family, bold: it.bold, italic: it.italic, color: it.color,
        });
      }
    }
    var out = [];
    for (var r = 0; r < runs.length; r++) {
      runs[r].text = runs[r].text.replace(/\s+$/, "");
      if (runs[r].text) out.push(runs[r]);
    }
    return out;
  }

  function pdfRingColor(d, W, H, x0, y0, x1, y1) {
    var counts = {}, bestIdx = -1, bestN = 0, total = 0;
    function add(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      var i = (y * W + x) * 4;
      var key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      counts[key] = (counts[key] || 0) + 1;
      total++;
      if (counts[key] > bestN) { bestN = counts[key]; bestIdx = i; }
    }
    for (var t = 0; t < 2; t++) {
      for (var x = x0 - 2 + t; x <= x1 + 1 - t; x++) { add(x, y0 - 2 + t); add(x, y1 + 1 - t); }
      for (var y = y0 - 1 + t; y <= y1 - t; y++) { add(x0 - 2 + t, y); add(x1 + 1 - t, y); }
    }
    if (bestIdx < 0 || total < 6) return null;
    return [d[bestIdx], d[bestIdx + 1], d[bestIdx + 2]];
  }

  function pdfEraseText(canvas, runs, pxPerUnit, keepEmoji) {
    var ctx;
    try { ctx = canvas.getContext("2d", { willReadFrequently: true }); } catch (e) { return; }
    if (!ctx) return;
    var img;
    try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch (e) { return; }
    var d = img.data, W = canvas.width, H = canvas.height;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];

      if (keepEmoji && pdfIsEmojiRun(run)) continue;
      var x0 = pdfClamp(Math.floor(run.x * pxPerUnit) - 1, 0, W);
      var y0 = pdfClamp(Math.floor(run.top * pxPerUnit), 0, H);
      var x1 = pdfClamp(Math.ceil((run.x + run.width) * pxPerUnit) + 1, 0, W);
      var y1 = pdfClamp(Math.ceil(run.bottom * pxPerUnit) - 2, 0, H);
      if (y1 <= y0) y1 = Math.min(H, y0 + 1);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      var bg = pdfRingColor(d, W, H, x0, y0, x1, y1);
      if (!bg) continue;
      var dr = run.color[0] - bg[0], dg = run.color[1] - bg[1], db = run.color[2] - bg[2];
      var dLen2 = dr * dr + dg * dg + db * db;
      if (dLen2 < 900) continue;
      var dLen = Math.sqrt(dLen2);
      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
          var i = (y * W + x) * 4;
          var vr = d[i] - bg[0], vg = d[i + 1] - bg[1], vb = d[i + 2] - bg[2];

          var t = (vr * dr + vg * dg + vb * db) / dLen2;
          if (t <= 0.02 || t >= 1.2) continue;
          var pr = vr - t * dr, pg = vg - t * dg, pb = vb - t * db;
          if (pr * pr + pg * pg + pb * pb > dLen2 * 0.20) continue;

          if (x > 3 && x < W - 4) {
            var il = (y * W + (x - 4)) * 4;
            var ir = (y * W + (x + 4)) * 4;
            var dl = Math.abs(d[il] - d[i]) + Math.abs(d[il + 1] - d[i + 1]) + Math.abs(d[il + 2] - d[i + 2]);
            var dr2 = Math.abs(d[ir] - d[i]) + Math.abs(d[ir + 1] - d[i + 1]) + Math.abs(d[ir + 2] - d[i + 2]);
            if (dl < 30 && dr2 < 30) continue;
          }
          d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  async function pdfRenderPage(page, scale) {
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas;
  }

  var pdfMetricsCache = {};
  function pdfDomFontMetrics(family, bold, italic) {
    var key = family + "|" + (bold ? 700 : 400) + "|" + (italic ? "i" : "n");
    if (pdfMetricsCache[key]) return pdfMetricsCache[key];
    var m = { a: 0.9, d: 0.22 };
    try {
      var ctx = document.createElement("canvas").getContext("2d");
      ctx.font = (italic ? "italic " : "") + (bold ? "700 " : "400 ") + "100px " + family;
      var t = ctx.measureText("Hxg");
      if (t.fontBoundingBoxAscent > 0 && t.fontBoundingBoxDescent >= 0) {
        m = { a: t.fontBoundingBoxAscent / 100, d: t.fontBoundingBoxDescent / 100 };
      }
    } catch (e) {}
    pdfMetricsCache[key] = m;
    return m;
  }
  function pdfTextBox(size, family, bold, italic) {
    var m = pdfDomFontMetrics(family, bold, italic);
    var lineHeight = Math.max(size * 0.95, size * (1.2 - m.a + m.d));
    return {
      lineHeight: lineHeight,
      baseline: (lineHeight - (m.a + m.d) * size) / 2 + m.a * size,
    };
  }

  function pdfExactPageHtml(dataUrl, runs, fit, boxW, boxH, sheetW, sheetH) {
    var artW = Math.round(sheetW * fit);
    var artH = Math.round(sheetH * fit);

    var offX = Math.round((boxW - artW) / 2);
    var offY = Math.round((boxH - artH) / 2);
    var html = '<div class="emdocs-pdf-page" data-pdf-w="' + Math.round(sheetW) +
      '" data-pdf-h="' + Math.round(sheetH) + '" style="width:' + pdfRound(boxW) +
      'px;height:' + pdfRound(boxH) + 'px">' +
      '<img class="emdocs-pdf-bg" src="' + dataUrl + '" alt="" style="left:' + offX +
      'px;top:' + offY + 'px;width:' + pdfRound(artW) + 'px;height:' + pdfRound(artH) + 'px" />';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var size = r.size * fit;
      var box = pdfTextBox(size, r.family, r.bold, r.italic);
      html += '<span class="emdocs-pdf-run" style="left:' + pdfRound(offX + r.x * fit) + "px;top:" +
        pdfRound(offY + r.baseline * fit - box.baseline) + "px;font-size:" + pdfRound(size) +
        "px;line-height:" + pdfRound(box.lineHeight) + "px;font-family:" + r.family + ";" +
        (r.bold ? "font-weight:700;" : "") + (r.italic ? "font-style:italic;" : "") +
        'color:' + pdfRgb(r.color) + '">' + escapeHtml(r.text) + "</span>";
    }
    return html + "</div>";
  }

  async function convertPdfToDoc(file, onProgress) {
    var lib = window.pdfjsLib;
    if (!lib) throw new Error("PDFLIB");
    if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    var pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    var total = pdf.numPages;
    if (!total) throw new Error("EMPTYPDF");

    var firstViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    var portrait = firstViewport.height >= firstViewport.width;

    var out = [];
    for (var n = 1; n <= total; n++) {
      var page = await pdf.getPage(n);
      var viewport = page.getViewport({ scale: 1 });
      var sheetW = Math.round(viewport.width);
      var sheetH = Math.round(viewport.height);

      var scale = Math.max(1, Math.min(2.4, PDF_MAX_RENDER_PX / Math.max(sheetW, sheetH)));
      var runs = await pdfPageRuns(page, viewport);
      var canvas = await pdfRenderPage(page, scale);
      pdfEraseText(canvas, runs, scale, true);
      var url = canvas.toDataURL("image/jpeg", 0.92);
      canvas.width = 0;
      canvas.height = 0;

      var boxW = sheetW - PDF_EXACT_MARGIN * 2;
      var boxH = sheetH - PDF_EXACT_MARGIN * 2;
      var fit = Math.min(boxW / sheetW, boxH / sheetH);
      out.push(pdfExactPageHtml(url, runs, fit, boxW, boxH, sheetW, sheetH));

      if (n < total) out.push(PDF_BREAK_HTML);
      if (onProgress) onProgress(n, total);
    }
    try { await pdf.destroy(); } catch (e) {}

    return {
      html: out.join(""),
      pageSetup: {
        w: Math.round(firstViewport.width), h: Math.round(firstViewport.height),
        portrait: portrait,
        marginTop: PDF_EXACT_MARGIN, marginRight: PDF_EXACT_MARGIN,
        marginBottom: PDF_EXACT_MARGIN, marginLeft: PDF_EXACT_MARGIN,
        bg: "#ffffff",
      },
    };
  }

  function toastSticky(message, type) {
    toast(message, type);
    var el = $("toast");
    if (!el) return;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 60000);
  }

  async function importDocumentFromFile(file) {
    aggressiveEmptyPageCleanup = true;
    setTimeout(function () { aggressiveEmptyPageCleanup = false; }, 3000);
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
      toastSticky("Importing DOCX…");
      contentPromise = convertDocxToHtml(file);
    } else if (ext === "odt") {
      contentPromise = file.arrayBuffer().then(convertOdtToHtml).then(function (h) { return h || "<p><br></p>"; });
    } else if (ext === "rtf") {
      toastSticky("Importing RTF…");
      contentPromise = file.text().then(convertRtfToHtml);
    } else if (ext === "doc") {
      contentPromise = convertDocToHtml(file);
    } else if (ext === "pdf" || file.type === "application/pdf") {
      toastSticky("Importing PDF…");
      contentPromise = convertPdfToDoc(file, function (done, total) {
        toastSticky("Importing PDF… page " + done + " of " + total);
      });
    } else {
      toast("Unsupported file type. Please use .pdf, .doc, .docx, .odt, .txt, .md or .html.", "error");
      return;
    }

    var content;
    try { content = await contentPromise; } catch (e) {
      if (e && e.message === "EMPTYDOC") {
        toast("Could not extract readable text from this .doc file.", "error");
      } else if (e && e.message === "PDFLIB") {
        toast("PDF library not loaded. Check your internet connection and try again.", "error");
      } else if (e && e.message === "EMPTYPDF") {
        toast("This PDF has no pages.", "error");
      } else if (e && /password/i.test(String(e && e.message))) {
        toast("This PDF is password protected. Remove the password and try again.", "error");
      } else {
        toast("Could not read file", "error");
      }
      return;
    }

    var id = makeDocId();
    var pageSetup = null;
    var header = "";
    var footer = "";
    var sections = null;

    if (content && typeof content === "object" && content.html) {
      pageSetup = content.pageSetup || null;
      header = content.header || "";
      footer = content.footer || "";
      sections = content.sections || null;
      content = content.html;
    }

    if (ext !== "pdf") {
      if (typeof content === "string") {
        content = content.replace(/<div\b[^>]*emdocs-page-break[^>]*>(?:[\s\S]*?)<\/div>/gi, "");
      }
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
      header: header,
      footer: footer,
      footnotes: [],
      endnotes: [],
    };
    if (pageSetup) {
      docData.pageSize = { w: pageSetup.w, h: pageSetup.h, portrait: pageSetup.portrait };
      docData.pageMargins = { top: pageSetup.marginTop, right: pageSetup.marginRight, bottom: pageSetup.marginBottom, left: pageSetup.marginLeft };
      if (pageSetup.bg) docData.pageBg = pageSetup.bg;
    }
    if (sections) {
      docData.sections = sections;
    }
    await writeDocData(docData);
    toast("Imported \u201C" + baseName + "\u201D", "success");
    try { window.EmeraldHistory.action("Imported document \u201C" + baseName + "\u201D"); } catch (_) {}
    await openDocument(id, false);
  }

  function setAutosaveState(state) {

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

  var printInFlight = false;
  function printDocument() {
    if (printInFlight) return;
    printInFlight = true;
    saveDocument(false);

    try { schedulePaginate(); } catch (e) {}

    setTimeout(function () {
      window.print();
      setTimeout(function () { printInFlight = false; }, 500);
    }, 50);
  }

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

    var wrapper = $(PAGES_WRAPPER_ID);
    var wrapperHadGuides = wrapper && wrapper.classList.contains("show-guides");
    var badges = [];
    var i;
    for (i = 0; i < pages.length; i++) {
      var b = pages[i].querySelector(".page-badge");
      if (b) { badges.push(b); b.style.display = "none"; }
    }
    if (wrapper) wrapper.classList.remove("show-guides");

    var hadTransforms = [];
    for (i = 0; i < pages.length; i++) {
      hadTransforms.push(pages[i].style.transform);
      pages[i].style.transform = "none";
    }

    var savedWrapperTransform = wrapper ? wrapper.style.transform : "";
    var savedWrapperZoom = wrapper ? wrapper.style.zoom : "";
    if (wrapper) { wrapper.style.transform = "none"; wrapper.style.zoom = "1"; }

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

          if (drawW * ratio > pageHmm) { drawH = pageHmm; drawW = drawH / ratio; }
          else { drawH = drawW * ratio; }
          var offX = (pageWmm - drawW) / 2;
          var offY = (pageHmm - drawH) / 2;
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", offX, offY, drawW, drawH);
          next();
        }).catch(function () {

          next();
        });
      }, 40);
    }

    function finish() {

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
        try { window.EmeraldHistory.action("Exported document as PDF"); } catch (_) {}
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
      try { window.EmeraldHistory.action("Exported document as TXT"); } catch (_) {}
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
      try { window.EmeraldHistory.action("Exported document as HTML"); } catch (_) {}
    } else if (format === "print") {
      printDocument();
    } else if (format === "pdf") {
      printToPdf();
    } else if (format === "docx") {
      exportDocxDocument();
    } else if (format === "preview") {
      togglePrintPreview(true);
    }
  }

  async function exportDocxDocument() {
    var writer = window.EMDocx;
    if (!writer) { toast("Word export library not loaded", "error"); return; }
    var pages = getPages();
    if (!pages.length) { toast("Nothing to export", "error"); return; }
    toast("Preparing .docx…", 4000);
    saveCaret();
    var meta = {
      title: currentTitle || "Document",
      pageW: curPageW || PAGE_WIDTH,
      pageH: curPageH || PAGE_HEIGHT,
      margins: {
        top: pageMargins.top, right: pageMargins.right,
        bottom: pageMargins.bottom, left: pageMargins.left
      },
      bg: "#ffffff"
    };
    try {
      var wrapper = $(PAGES_WRAPPER_ID);
      var paperBg = wrapper && getComputedStyle(wrapper).getPropertyValue("--paper-bg");
      if (paperBg && paperBg.trim()) meta.bg = paperBg.trim();
    } catch (e) {  }
    try {
      var blob = await writer.fromPages(pages, meta);
      var name = (currentTitle || "document").replace(/[^\w\-]+/g, "_").toLowerCase() || "document";
      downloadBlob(blob, name + ".docx");
      toast("Exported as .docx", "success");
      try { window.EmeraldHistory.action("Exported document as DOCX"); } catch (_) {}
    } catch (e) {
      console.error("[docs] docx export failed:", e);
      toast("DOCX export failed: " + (e && e.message || e), "error");
    } finally {
      restoreCaret();
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

  function applyTheme() {

  }

  function toggleTheme() {

  }

  function toggleDarkPaper() {

  }

  function applyColorTheme() {  }
  function loadColorTheme()  {  }
  function openColorThemeDialog() {  }
  function hexToRgba(hex, alpha) {
    var m = hex.match(/^#([0-9a-f]{6})$/i);
    if (!m) return "rgba(0,0,0," + alpha + ")";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function openModal(id) {
    var m = $(id);
    if (m) {

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

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isSafeExternalUrl(u) {
    var s = String(u || "").trim();
    if (!s) return false;
    if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return true;
    return s.charAt(0) === "/" || s.charAt(0) === "#";
  }

  function sanitizeStoredHtml(html) {

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

  function normalizeExternalUrl(url) {
    var u = String(url || "").trim();
    if (!u) return u;
    if (/^(https?:\/\/|mailto:|tel:|ftp:|file:|#|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  function openImagePicker() {

    var input = $("insertImageInput");
    if (input) input.click();
  }

  function handleImageFileSelect(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {

      var alt = (file.name || "image").replace(/\.[^.]+$/, "");
      doInsertImage(ev.target.result, alt);
    };
    reader.readAsDataURL(file);

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
        var isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
        if (isPdf) {

          (function (f) { importDocumentFromFile(f); })(file);
          continue;
        }
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

  function setupTableToolbar() {
    var toolbar = $("tableToolbar");
    if (!toolbar) return;
    var activeCell = null;

    toolbar.addEventListener("mousedown", function (e) { e.preventDefault(); });

    function hide() {
      toolbar.style.display = "none";
      activeCell = null;
    }
    function show(cell) {
      activeCell = cell;
      toolbar.style.display = "flex";
      var table = cell.closest("table");
      if (!table) return;
      var rect = table.getBoundingClientRect();
      var tbHeight = 48;
      var top = rect.top - tbHeight - 8;
      if (top < 4) top = rect.bottom + 8;
      toolbar.style.top = top + "px";
      var toolbarW = toolbar.offsetWidth || 280;
      var left = Math.max(4, rect.left);
      if (left + toolbarW > window.innerWidth - 4) left = window.innerWidth - toolbarW - 4;
      toolbar.style.left = left + "px";
    }

    document.addEventListener("click", function (e) {
      if (!currentDocId) { if (toolbar.style.display !== "none") hide(); return; }
      var cell = e.target && e.target.closest ? e.target.closest("td, th") : null;
      if (cell && cell.closest(".page-content") && cell.closest("table")) {
        show(cell);
        return;
      }
      if (!toolbar.contains(e.target) && toolbar.style.display !== "none") hide();
    }, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toolbar.style.display !== "none") hide();
    });

    function cellAtCols(r, target) {
      var col = 0;
      for (var i = 0; i < r.cells.length; i++) {
        var span = Math.max(1, r.cells[i].colSpan || 1);
        if (target >= col && target < col + span) {
          return { cell: r.cells[i], kid: i, start: col, span: span };
        }
        col += span;
      }
      return null;
    }

    function makeRow(colCount, tag) {
      var tr = document.createElement("tr");
      for (var i = 0; i < colCount; i++) {
        var td = document.createElement(tag);
        td.innerHTML = "<br>";
        tr.appendChild(td);
      }
      return tr;
    }

    toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest(".tbl-btn");
      if (!btn || !activeCell || !currentDocId) return;
      var row = activeCell.parentElement;
      var table = row ? row.closest("table") : null;
      if (!table || !table.rows.length) return;

      var colIndex = 0;
      for (var xi = 0; xi < row.cells.length; xi++) {
        if (row.cells[xi] === activeCell) break;
        colIndex += Math.max(1, row.cells[xi].colSpan || 1);
      }
      var headerRow = table.rows[0];
      var action = btn.getAttribute("data-tbl");

      if (action === "addRowAbove") {

        var tagUp = row.cells[0] && row.cells[0].tagName === "TH" ? "th" : "td";
        table.insertBefore(makeRow(row.cells.length, tagUp), row);
      } else if (action === "addRowBelow") {
        table.insertBefore(makeRow(row.cells.length, "td"), row.nextSibling);
      } else if (action === "deleteRow") {
        if (table.rows.length > 1) {
          row.remove();
        } else {

          var p = document.createElement("p");
          p.innerHTML = "<br>";
          if (table.parentNode) table.parentNode.insertBefore(p, table);
          table.remove();
        }
        hide();
      } else if (action === "addColLeft" || action === "addColRight") {
        Array.prototype.forEach.call(table.rows, function (r, ri) {
          var at = cellAtCols(r, colIndex);
          if (!at) return;
          var c = document.createElement(ri === 0 && headerRow && headerRow.cells.length && headerRow.cells[0].tagName === "TH" ? "th" : "td");
          c.innerHTML = "<br>";
          if (action === "addColLeft") {
            r.insertBefore(c, at.cell);
          } else {
            var next = at.cell.nextSibling;
            if (next) r.insertBefore(c, next); else r.appendChild(c);
          }

          if (ri === 0 && at.cell.style.width) c.style.width = at.cell.style.width;
        });
      } else if (action === "deleteCol") {
        var atRow = cellAtCols(row, colIndex);
        if (!atRow || row.cells.length <= 1) return;

        Array.prototype.forEach.call(table.rows, function (r) {
          var at = cellAtCols(r, colIndex);
          if (!at) return;
          if (at.span > 1) {
            at.cell.colSpan = at.span - 1;
          } else {
            at.cell.remove();
          }
        });
        hide();
      }

      ensureTableCellsEditable();
      schedulePaginate();
      scheduleAutosave();
      if (activeCell && !document.contains(activeCell)) hide();
    });

    function repositionToolbar() {
      if (!activeCell || toolbar.style.display === "none") return;
      var table = activeCell.closest("table");
      if (!table) { hide(); return; }
      var rect = table.getBoundingClientRect();
      var tbHeight = 48;
      var top = rect.top - tbHeight - 8;
      if (top < 4) top = rect.bottom + 8;
      toolbar.style.top = top + "px";
      var toolbarW = toolbar.offsetWidth || 280;
      var left = Math.max(4, rect.left);
      if (left + toolbarW > window.innerWidth - 4) left = window.innerWidth - toolbarW - 4;
      toolbar.style.left = left + "px";
    }

    window._docsTableToolbar = {
      reposition: repositionToolbar,
      hide: hide,
      get activeCell() { return activeCell; }
    };
  }

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

    var pageRect = page.getBoundingClientRect();
    var offsetX = pageRect.left - areaRect.left;
    var scale = (typeof currentZoom === "number" && currentZoom) ? currentZoom / 100 : 1;
    var pw = curPageW;
    var ph = curPageH;

    var minorStep, majorStep;
    if (scale < 0.4)      { minorStep = 100; majorStep = 250; }
    else if (scale < 0.8) { minorStep = 50;  majorStep = 100; }
    else if (scale < 1.6) { minorStep = 25;  majorStep = 100; }
    else if (scale < 3.0) { minorStep = 10;  majorStep = 50;  }
    else                  { minorStep = 5;   majorStep = 25;  }

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

  var activeRibbonTab = "home";
  var docsImagePreviousTab = "home";

  function moveRibbonIndicatorTo(tab) {
    var indicator = $("ribbonTabIndicator");
    if (!indicator || !tab) return;
    var rect = tab.getBoundingClientRect();
    var parentRect = tab.parentElement.getBoundingClientRect();
    indicator.style.width = rect.width + "px";
    indicator.style.transform = "translateX(" + (rect.left - parentRect.left) + "px)";
  }

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

    setTimeout(function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active && active.getBoundingClientRect().width > 0) moveRibbonIndicatorTo(active);
    }, 100);

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(refreshRibbonIndicator);
    }

    function activateTabClasses(tab) {
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("active");
      tab.classList.add("active");
      moveRibbonIndicatorTo(tab);
    }

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

        if (tab.classList.contains("active") && target !== "file") return;

        if (target !== "file") activeRibbonTab = target;

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

    window.addEventListener("resize", function () {
      var active = document.querySelector(".ribbon-tab.active");
      if (active) moveRibbonIndicatorTo(active);
    });
  }

  var ribbonSwitchPending = null;
  function switchRibbonTab(name) {
    var tab = document.querySelector('.ribbon-tab[data-tab="' + name + '"]');
    if (!tab) return;
    var leavingTableDesign = (activeRibbonTab === "table-design" && name !== "table-design");
    if (name !== "file") activeRibbonTab = name;

    if (ribbonSwitchPending) {
      clearTimeout(ribbonSwitchPending.timer);
      ribbonSwitchPending.panel.removeEventListener("transitionend", ribbonSwitchPending.listener);
      ribbonSwitchPending = null;
    }

    var tabsAll = document.querySelectorAll(".ribbon-tab");
    for (var t = 0; t < tabsAll.length; t++) {
      tabsAll[t].classList.toggle("active", tabsAll[t] === tab);
    }
    moveRibbonIndicatorTo(tab);

    var panels = document.querySelectorAll(".ribbon-panel");
    var targetPanel = document.querySelector('.ribbon-panel[data-panel="' + name + '"]');
    var currentPanel = document.querySelector(".ribbon-panel.active");

    function doSwitch() {
      ribbonSwitchPending = null;
      for (var j = 0; j < panels.length; j++) {
        panels[j].classList.remove("active");
        panels[j].classList.remove("blur-out");
      }
      if (targetPanel) targetPanel.classList.add("active");
    }

    if (currentPanel && currentPanel !== targetPanel) {
      currentPanel.classList.add("blur-out");
      currentPanel.classList.remove("active");
      var done = false;
      var onBlurred = function (e) {
        if (e.propertyName !== "opacity") return;
        finishSwitch();
      };
      var timer = setTimeout(finishSwitch, 220);
      function finishSwitch() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        currentPanel.removeEventListener("transitionend", onBlurred);
        if (currentPanel.classList.contains("blur-out")) {
          currentPanel.classList.remove("blur-out");
        }
        doSwitch();
      }
      ribbonSwitchPending = { panel: currentPanel, listener: onBlurred, timer: timer };
    } else {

      doSwitch();
    }

    if (leavingTableDesign) closeTdGallery();
  }

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

  function syncImageFormatRibbonState() {
    var tab = $("imageFormatTab");
    if (!tab) return;
    var img = currentImage();
    if (img) {
      var wasHidden = tab.hasAttribute("hidden");
      tab.removeAttribute("hidden");
      if (wasHidden && activeRibbonTab !== "image-format") {
        docsImagePreviousTab = activeRibbonTab;
        switchRibbonTab("image-format");
      }
      syncImageFormatControls(img);
    } else {
      if (activeRibbonTab === "image-format") {
        var restoreName = (docsImagePreviousTab && docsImagePreviousTab !== "image-format") ? docsImagePreviousTab : "home";
        switchRibbonTab(restoreName);
      }
      tab.setAttribute("hidden", "");
    }
  }

  function setupImageFormatTab() {
    var panel = document.querySelector('.ribbon-panel[data-panel="image-format"]');
    if (!panel || panel.__imgFormatBound) return;
    panel.__imgFormatBound = true;

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

    panel.querySelectorAll("#imageFilterDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var preset = item.dataset.filter || "none";
        var label = $("imageFilterLabel");
        if (label) label.textContent = item.dataset.label || "Original";
        onImageFxChange(imageFormatFilterPreset(preset));
      });
    });

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

    panel.querySelectorAll("#imageBorderColorDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var color = item.dataset.value;
        var img = currentImage();
        if (color === "none") onImageBorderChange({ w: 0, c: "" });
        else onImageBorderChange({ c: color, w: img ? (parseImageBorder(img).w || 2) : 2 });
      });
    });

    panel.querySelectorAll("#imageBorderWidthDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var val = parseInt(item.dataset.value) || 0;
        var img = currentImage();
        if (val === 0) onImageBorderChange({ w: 0, c: "" });
        else onImageBorderChange({ w: val, c: img ? (parseImageBorder(img).c || "#1a1a1a") : "#1a1a1a" });
      });
    });

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

  var emTableKitInstance = null;
  var docsTablePreviousTab = null;

  function currentDesignTable() {
    return emTableKitInstance ? emTableKitInstance.engagedTable() : null;
  }

  function syncTableDesignTab(table) {
    var tab = $("tableDesignTab");
    if (!tab) return;
    if (table) {
      var wasHidden = tab.hasAttribute("hidden");
      tab.removeAttribute("hidden");
      if (wasHidden && activeRibbonTab !== "table-design") {
        docsTablePreviousTab = activeRibbonTab;
        switchRibbonTab("table-design");
      }
      syncTableDesignControls(table);

    } else {
      closeTdGallery();
      if (activeRibbonTab === "table-design") {
        var rn = (docsTablePreviousTab && docsTablePreviousTab !== "table-design") ? docsTablePreviousTab : "home";
        switchRibbonTab(rn);
      }
      tab.setAttribute("hidden", "");
    }
  }

  function syncTableDesignControls(table) {
    var TS = window.EMTableStyles;
    if (!TS || !table) return;
    var d = TS.readDesign(table);

    document.querySelectorAll(".td-pill").forEach(function (pill) {
      var key = pill.getAttribute("data-td-opt");
      pill.setAttribute("aria-pressed", d.opts[key] ? "true" : "false");
    });
    document.querySelectorAll(".td-style-thumb.current").forEach(function (el) {
      el.classList.remove("current");
    });
    document.querySelectorAll('.td-style-thumb[data-preset="' + d.style + '"]').forEach(function (el) {
      el.classList.add("current");
    });

    var prim = tdPrimaryCell(table);
    var sw = $("tdShadingSwatch"), lbl = $("tdShadingLabel");
    if (sw && lbl) {
      var hex = prim ? (d.shade && d.shade[cellKeyFor(table, prim)]) : null;
      var rgb = prim ? (prim.style.backgroundColor || "") : "";
      var shown = hex || (rgb && rgb !== "transparent" ? rgb : "");
      if (shown) {
        sw.style.background = shown;
        sw.style.border = "1px solid rgba(0,0,0,0.2)";
        lbl.textContent = "Fill";
      } else {
        sw.style.background = "transparent";
        sw.style.border = "2px dashed #999";
        lbl.textContent = "No Fill";
      }
    }
  }

  function cellKeyFor(table, cell) {
    var TS = window.EMTableStyles;
    if (!TS) return null;
    for (var r = 0; r < table.rows.length; r++) {
      var rowCells = table.rows[r].cells;
      for (var c = 0; c < rowCells.length; c++) {
        if (rowCells[c] === cell) return TS.shadeKeyOf(cell, r, c);
      }
    }
    return null;
  }

  function tdRangeTouches(table, range) {
    if (!range || !range.intersectsNode) return false;
    for (var r = 0; r < table.rows.length; r++) {
      var rowCells = table.rows[r].cells;
      for (var c = 0; c < rowCells.length; c++) {
        if (range.intersectsNode(rowCells[c])) return true;
      }
    }
    return false;
  }

  function tdCellsIntersecting(table, range) {
    var out = [];
    for (var r = 0; r < table.rows.length; r++) {
      var rowCells = table.rows[r].cells;
      for (var c = 0; c < rowCells.length; c++) {
        if (range.intersectsNode(rowCells[c])) out.push(rowCells[c]);
      }
    }
    return out;
  }

  function tdSelectedCells(table) {
    if (!table) return [];
    var sel = window.getSelection();
    var live = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (tdRangeTouches(table, live)) return tdCellsIntersecting(table, live);

    if (tdRangeTouches(table, lastEditorRange)) {
      return tdCellsIntersecting(table, lastEditorRange);
    }
    var out = [];
    for (var all = 0; all < table.rows.length; all++) {
      for (var ac = 0; ac < table.rows[all].cells.length; ac++) {
        out.push(table.rows[all].cells[ac]);
      }
    }
    return out;
  }

  function tdCellOfRange(table, range) {
    if (!range || !range.startContainer) return null;
    var node = range.startContainer;
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var cell = el && el.closest ? el.closest("td, th") : null;
    return (cell && table.contains(cell)) ? cell : null;
  }

  function tdPrimaryCell(table) {
    if (!table) return null;
    var sel = window.getSelection();
    var live = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var cell = tdCellOfRange(table, live);
    if (cell) return cell;
    return tdCellOfRange(table, lastEditorRange);
  }

  function designMutated() {
    schedulePaginate();
    scheduleAutosave();
  }

  function tdApplyPreset(presetId) {
    var TS = window.EMTableStyles;
    var table = currentDesignTable();
    if (!TS || !table) return;
    var d = TS.readDesign(table);
    d.style = presetId;
    TS.writeDesign(table, d);
    TS.applyDesign(table);
    syncTableDesignControls(table);
    designMutated();
  }

  function tdApplyOpts() {
    var TS = window.EMTableStyles;
    var table = currentDesignTable();
    if (!TS || !table) return;
    var d = TS.readDesign(table);
    document.querySelectorAll(".td-pill").forEach(function (pill) {
      d.opts[pill.getAttribute("data-td-opt")] = pill.getAttribute("aria-pressed") === "true";
    });
    TS.writeDesign(table, d);
    TS.applyDesign(table);
    designMutated();
  }

  function tdBuildThumb(presetId, asDiv) {
    var card = document.createElement(asDiv ? "div" : "button");
    if (!asDiv) card.type = "button";
    card.className = "td-style-thumb";
    card.setAttribute("data-preset", presetId);

    var t = document.createElement("table");
    t.className = "td-mini";
    t.setAttribute("contenteditable", "false");
    for (var r = 0; r < 4; r++) {
      var tr = document.createElement("tr");
      for (var c = 0; c < 3; c++) {
        var td = document.createElement("td");
        td.textContent = "\u00a0";
        tr.appendChild(td);
      }
      if (r === 0) {
        var th = document.createElement("thead");
        th.appendChild(tr);
        t.appendChild(th);
      } else {
        var tb = document.createElement("tbody");
        tb.appendChild(tr);
        t.appendChild(tb);
      }
    }
    window.EMTableStyles.applyDesign(t, {
      style: presetId,
      opts: { header: true, total: false, bandedRows: true, bandedCols: false, firstCol: false, lastCol: false },
      shade: {}
    });
    card.appendChild(t);
    return card;
  }

  function buildTdGallery() {
    var TS = window.EMTableStyles;
    if (!TS) return;
    var strip = $("tdGalleryStrip");
    var popup = $("tdGalleryPopup");
    if (!strip || strip.__built) return;
    strip.__built = true;

    var gridPresets = TS.PRESETS.filter(function (p) { return p.id !== "none"; });
    for (var i = 0; i < 6 && i < gridPresets.length; i++) {
      strip.appendChild(tdBuildThumb(gridPresets[i].id));
    }
    var more = document.createElement("button");
    more.className = "td-more";
    more.type = "button";
    more.title = "Browse all table styles";
    more.setAttribute("aria-haspopup", "true");
    more.setAttribute("aria-expanded", "false");
    more.innerHTML =
      '<span class="td-more-preview">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
          '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
          '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
          '<rect x="14" y="14" width="7" height="7" rx="1"/>' +
        '</svg>' +
      '</span>' +
      '<span class="td-more-label">More</span>';
    more.addEventListener("click", function (e) { e.stopPropagation(); tdToggleGallery(); });
    strip.appendChild(more);

    popup.innerHTML = "";
    var header = document.createElement("div");
    header.className = "td-gallery-header";
    header.textContent = "All Table Styles";
    popup.appendChild(header);

    var grid = document.createElement("div");
    grid.className = "td-style-grid";
    TS.PRESETS.forEach(function (p) {
      var cellW = document.createElement("button");
      cellW.type = "button";
      cellW.className = "td-style-cell";
      cellW.appendChild(tdBuildThumb(p.id, true));
      var name = document.createElement("div");
      name.className = "td-style-name";
      name.textContent = p.name;
      cellW.appendChild(name);
      cellW.addEventListener("click", function () {
        tdToggleGallery(false);
        tdApplyPreset(p.id);
      });
      grid.appendChild(cellW);
    });
    popup.appendChild(grid);

    popup.addEventListener("mousedown", function (e) {
      if (e.target.closest && e.target.closest("button")) e.preventDefault();
    });

    document.addEventListener("mousedown", function (e) {
      if (!tdGalleryOpen) return;
      var wrap = $("tdGalleryWrap");
      if (popup.contains(e.target) || (wrap && wrap.contains(e.target))) return;
      tdToggleGallery(false);
    });
  }

  var tdGalleryOpen = false;

  function tdToggleGallery(force) {
    var popup = $("tdGalleryPopup");
    var stripWrap = $("tdGalleryWrap");
    if (!popup || !stripWrap) return;
    var want = force !== undefined ? !!force : !tdGalleryOpen;
    if (want === tdGalleryOpen) return;
    tdGalleryOpen = want;
    var moreBtn = stripWrap.querySelector(".td-more");
    if (moreBtn) moreBtn.setAttribute("aria-expanded", want ? "true" : "false");
    if (want) {
      closePortalDropdown(false);

      var anchor = moreBtn || $("tdGalleryStrip");
      var r = anchor.getBoundingClientRect();
      document.body.appendChild(popup);
      var w = popup.offsetWidth;
      var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      popup.style.cssText = "position:fixed;display:block;z-index:900;left:" + left + "px;top:" +
        (r.bottom + 6) + "px;animation:dropdownFadeIn 0.18s ease;";
      syncTableDesignControls(currentDesignTable());
    } else {
      popup.style.cssText = "";
      stripWrap.appendChild(popup);
    }
  }

  function closeTdGallery() {
    if (tdGalleryOpen) tdToggleGallery(false);
  }

  function setupTableDesignTab() {
    var panel = document.querySelector('.ribbon-panel[data-panel="table-design"]');
    if (!panel || panel.__tdBound) return;
    panel.__tdBound = true;
    buildTdGallery();

    panel.addEventListener("mousedown", function (e) {
      if (e.target.closest && e.target.closest("button")) e.preventDefault();
    });

    panel.querySelectorAll(".td-pill").forEach(function (pill) {
      pill.addEventListener("click", function () {
        var on = pill.getAttribute("aria-pressed") !== "true";
        pill.setAttribute("aria-pressed", on ? "true" : "false");
        tdApplyOpts();
      });
    });

    if ($("tdGalleryStrip")) {
      $("tdGalleryStrip").addEventListener("click", function (e) {
        var thumb = e.target.closest ? e.target.closest(".td-style-thumb") : null;
        if (!thumb) return;
        tdApplyPreset(thumb.getAttribute("data-preset") || "none");
      });
    }

    panel.querySelectorAll("#tdShadingDropdown .ms-dropdown-item").forEach(function (item) {
      item.addEventListener("click", function () {
        closePortalDropdown(false);
        var table = currentDesignTable();
        var TS = window.EMTableStyles;
        if (!table || !TS) return;
        TS.shadeCells(table, tdSelectedCells(table), item.getAttribute("data-value") || null);
        syncTableDesignControls(table);
        designMutated();
      });
    });
  }

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

  function clampImportedMargin(v) {
    if (typeof v !== "number" || isNaN(v)) return 96;
    return Math.max(0, Math.min(MAX_MARGIN, Math.round(v)));
  }

  var MARGIN_PRESETS = {
    narrow: 48,
    default: 96,
    moderate: 72,
    wide: 120,
  };

  function openMarginsDialog() {

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

  var lastSavedAt = 0;

  function formatAutosaveTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

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

      if (pct >= 25 && !goalMilestones[25]) { goalMilestones[25] = true; toastMilestone("25% there — keep going!"); }
      if (pct >= 50 && !goalMilestones[50]) { goalMilestones[50] = true; toastMilestone("Halfway there!"); }
      if (pct >= 75 && !goalMilestones[75]) { goalMilestones[75] = true; toastMilestone("75% — almost done!"); }

      if (current >= goalTarget && !goalCelebrated) {
        goalCelebrated = true;
        fireConfetti();
        toastMilestone("Goal reached! Well done.");
      } else if (current < goalTarget && goalCelebrated) {

        goalCelebrated = false;
      }

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

    toast(msg, "success");
  }

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

  var ABBREVIATIONS = [
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd", "rd",
    "inc", "ltd", "co", "corp", "etc", "vs", "approx", "no", "vol", "fig",
    "e.g", "i.e", "a.m", "p.m", "u.s", "u.k", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  ];

  function getSentences() {
    var text = getAllText();
    if (!text) return [];

    var masked = text;
    for (var i = 0; i < ABBREVIATIONS.length; i++) {
      var abbr = ABBREVIATIONS[i];
      var re = new RegExp("\\b" + abbr + "\\.", "gi");
      masked = masked.replace(re, abbr.toUpperCase() + "\x00");
    }

    masked = masked.replace(/(\d)\.(\d)/g, "$1\x01$2");

    var parts = masked.split(/[.!?]+/);
    var sentences = [];
    for (var j = 0; j < parts.length; j++) {

      var s = parts[j].replace(/\x00/g, ".").replace(/\x01/g, ".").trim();
      if (s.length > 0) sentences.push(s);
    }
    return sentences;
  }

  function countSentences() {
    var sentences = getSentences();
    return sentences.length;
  }

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

    return issues.slice(0, 20);
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

  function updateMarginPreview() {
    var preview = $("marginPreview");
    if (!preview) return;

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

        var realW = parseFloat(page.offsetWidth) || 794;
        var realH = parseFloat(page.offsetHeight) || 1123;
        var frameW = 132;
        var frameH = 185;
        var scale = Math.min(frameW / realW, frameH / realH) || 0.166;

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

  function togglePrintPreview(on) {
    var app = $("app");
    if (on === undefined) on = !app.classList.contains("print-preview");
    if (on) {
      app.classList.add("print-preview");
      saveDocument(false);

      var scroll = $("documentScroll");
      if (scroll) scroll.scrollTop = 0;
    } else {
      app.classList.remove("print-preview");
    }
  }

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

    var wc = $("wordCountModal");
    if (wc && wc.classList.contains("open") && sessionActive) renderWritingTimeStats();
  }

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

  function toggleSymbolBar(force) {
    var bar = $("symbolToolbar");
    var btn = $("btnSymbols");
    if (!bar) return;
    var shouldOpen = force === undefined ? !bar.classList.contains("visible") : force;
    if (shouldOpen) {

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

  function applyDocPageSize(w, h, portrait) {
    var pw = Math.round(w) || PAGE_WIDTH;
    var ph = Math.round(h) || PAGE_HEIGHT;
    if (portrait === false) { var tmp = pw; pw = ph; ph = tmp; }

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

      if (typeof m.left === "number" && typeof m.top === "number" &&
          typeof m.right === "number" && typeof m.bottom === "number") {
        pageMargins.left = clampImportedMargin(m.left);
        pageMargins.top = clampImportedMargin(m.top);
        pageMargins.right = clampImportedMargin(m.right);
        pageMargins.bottom = clampImportedMargin(m.bottom);
      }
    }
    applyDocMarginsVars();

    if (data.pageBg) {
      var wrapper = $(PAGES_WRAPPER_ID);
      if (wrapper) wrapper.style.setProperty("--paper-bg", data.pageBg);
    } else {
      var wrapper2 = $(PAGES_WRAPPER_ID);
      if (wrapper2) wrapper2.style.removeProperty("--paper-bg");
    }
    buildRulerTicks();
  }

  function applyDocMarginsVars() {
    var root = document.documentElement;
    root.style.setProperty("--page-margin-top", pageMargins.top + "px");
    root.style.setProperty("--page-margin-right", pageMargins.right + "px");
    root.style.setProperty("--page-margin-bottom", pageMargins.bottom + "px");
    root.style.setProperty("--page-margin-left", pageMargins.left + "px");
  }

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

      var count = 0;
      var done = false;
      for (var i = 0; i < pages.length && !done; i++) {
        var content = getContent(pages[i]);
        var blocks = content.children;
        for (var j = 0; j < blocks.length; j++) {
          var lineCount = blocks[j].innerText.split("\n").length;
          if (count + lineCount >= val) {

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

    setTimeout(function () {
      document.addEventListener("click", function (e) {
        if (!gotoTypeMenuOpen()) return;
        if (!e.target.closest("#frGotoTypeWrap")) closeGotoTypeMenu();
      });
    }, 0);
  }

  var watermarkText = "";

  function applyWatermark(text) {
    watermarkText = String(text == null ? "" : text).trim();
    var pages = getPages();

    for (var i = 0; i < pages.length; i++) {
      var existing = pages[i].querySelector(".page-watermark");
      if (existing) existing.remove();
    }
    if (!watermarkText) return;
    for (var j = 0; j < pages.length; j++) {
      var wm = document.createElement("div");
      wm.className = "page-watermark";
      wm.textContent = watermarkText;
      wm.setAttribute("contenteditable", "false");
      pages[j].insertBefore(wm, pages[j].firstChild);
    }
  }

  function getWatermark() { return watermarkText; }

  function openWatermark() {
    openModal("watermarkModal");
  }

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

  function updateDropCapState() {
    var btn = document.getElementById("btnDropCap");
    if (!btn) return;
    var block = getCurrentBlock();
    var on = !!(block && block.tagName === "P" && block.classList.contains("has-dropcap"));
    btn.classList.toggle("active", on);
    btn.title = on ? "Drop cap (currently ON — click to remove)" : "Drop cap";
  }

  function setColumns(n) {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var c = getContent(pages[i]);
      c.classList.remove("is-cols-2", "is-cols-3");
      if (n === 2) c.classList.add("is-cols-2");
      else if (n === 3) c.classList.add("is-cols-3");
    }

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

    applyPageDimensions(h, w, !isLandscape);
    syncPageSizeUI();
    schedulePaginate();
    scheduleAutosave();
    toast(isLandscape ? "Portrait" : "Landscape", "success");
  }

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

    applyPageDimensions(dim.w, dim.h, false);
    syncPageSizeUI();
    schedulePaginate();
    scheduleAutosave();
    toast("Page size: " + name, "success");
  }

  function applyPageDimensions(pw, ph, isLandscape) {
    curPageW = pw;
    curPageH = ph;
    var root = document.documentElement;
    root.style.setProperty("--emu-pw", pw + "px");
    root.style.setProperty("--emu-ph", ph + "px");
    root.style.setProperty("--emu-ppw", (pw / 96 * 25.4).toFixed(2) + "mm");
    root.style.setProperty("--emu-pph", (ph / 96 * 25.4).toFixed(2) + "mm");

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

    applyPdfPageSizes();
    scheduleThumbnailsUpdate();
  }

  function selectionInside(sel, selector) {
    if (!sel || !sel.rangeCount || !sel.anchorNode) return false;
    var el = sel.anchorNode.nodeType === Node.ELEMENT_NODE
      ? sel.anchorNode
      : sel.anchorNode.parentElement;
    return !!(el && el.closest && el.closest(selector));
  }

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

    var sel = window.getSelection();
    if (!selectionInside(sel, ".page-header.editable, .page-footer.editable")) {
      restoreEditorSelection();
      sel = window.getSelection();
      if (!selectionInside(sel, ".page-content")) {
        var fc = getContent(getPages()[0]);
        if (fc) fc.focus();
      }
    }

    var anchor = sel && sel.anchorNode ? sel.anchorNode : null;
    deepenEndCaret(anchor && anchor.nodeType === Node.ELEMENT_NODE ? anchor : null);
    document.execCommand("insertHTML", false, '<span class="field-dynamic" contenteditable="false" data-field="PAGE">Page 1</span> ');

    normalizeStrayHF();
    updateDynamicFields();
    schedulePaginate();
    scheduleAutosave();
    toast("Page number field inserted", "success");
  }

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

  function refreshHFHint(el) {
    if (el) el.classList.toggle("is-empty", isHFEmpty(el));
  }

  function hfHasContent(html) {
    if (!html) return false;

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

    el.style.setProperty("--hf-hint", kind === "header" ? "Header" : "Footer");
    el.innerHTML = sanitizeStoredHtml(html || "");
    refreshHFHint(el);

    el.addEventListener("input", function () {
      var html2 = el.innerHTML;
      if (kind === "header") headerHTML = html2; else footerHTML = html2;

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
      updateDynamicFields();
      scheduleAutosave();
    });

    el.addEventListener("blur", function () {

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

      range.setStartAfter(range.endContainer);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  var comments = [];

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
        if (dropOrphans) continue;

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

  function _toastIcon(rawMsg, type) {

    var msg = String(rawMsg || "").replace(/^\s*[\u2705\u2714\u2716\u2728\u26a0\ufe0f\u2757\u2753\u2139]+\s*/u, "").trim();
    var m = msg.toLowerCase();

    var INK = "#111";

    var svg = function (paths) {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
    };

    if (m.indexOf("reconnected") !== -1) {
      return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg: msg };
    }
    if (m.indexOf("reconnect") !== -1) {
      return { icon: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'), msg: msg };
    }

    if (m.indexOf("generating") === 0 || m.indexOf("importing") === 0 || m.indexOf("recording") === 0 ||
        m.indexOf("reading") === 0 || m.indexOf("previewing") === 0 ||
        m.indexOf("searching") === 0 || m.indexOf("loading") === 0 || m.indexOf("this may take") !== -1) {
      return { icon: svg('<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>'), msg: msg };
    }

    if (m.indexOf("clipboard") !== -1 || m.indexOf("copied") !== -1 || m.indexOf("pasted") !== -1 || m.indexOf("paste ") !== -1) {
      return { icon: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'), msg: msg };
    }

    if (m.indexOf("failed") !== -1 || m.indexOf("error") !== -1 || m.indexOf("could not") !== -1 ||
        m.indexOf("not supported") !== -1 || m.indexOf("denied") !== -1 || m.indexOf("invalid") !== -1 ||
        m.indexOf("skipping") !== -1 || m.indexOf("cancelled") === -1 && type === "error" && (
          m.indexOf("do not match") !== -1)) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'), msg: msg };
    }

    if (m.indexOf("must have") !== -1 || m.indexOf("must be") !== -1 || m.indexOf("select ") !== -1 ||
        m.indexOf("place cursor") !== -1 || m.indexOf("no headings") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("no text") !== -1 || m.indexOf("no image") !== -1 || m.indexOf("no comments") !== -1 ||
        m.indexOf("no bookmarks") !== -1 || m.indexOf("no footnote") !== -1 ||
        m.indexOf("no quick parts") !== -1 || m.indexOf("no captions") !== -1 ||
        m.indexOf("enter a ") !== -1 || m.indexOf("provide a url") !== -1 || m.indexOf("coming soon") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), msg: msg };
    }

    if (m.indexOf("deleted") !== -1 || m.indexOf("removed") !== -1) {
      return { icon: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'), msg: msg };
    }

    if (m.indexOf("%") !== -1 || m.indexOf("halfway") !== -1 || m.indexOf("goal") !== -1 || m.indexOf("well done") !== -1) {
      return { icon: svg('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'), msg: msg };
    }

    if (m.indexOf("mode") !== -1 || m.indexOf("read-only") !== -1 || m.indexOf("final") !== -1) {
      return { icon: svg('<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/><path d="M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>'), msg: msg };
    }

    if (m.indexOf("saved") !== -1 || m.indexOf("inserted") !== -1 || m.indexOf("applied") !== -1 ||
        m.indexOf("added") !== -1 || m.indexOf("created") !== -1 || m.indexOf("restored") !== -1 ||
        m.indexOf("exported") !== -1 || m.indexOf("merged") !== -1 || m.indexOf("complete") !== -1 ||
        m.indexOf("finished") !== -1 || m.indexOf("fixed") !== -1 || m.indexOf("cleared") !== -1 ||
        m.indexOf("unlocked") !== -1 || m.indexOf("updated") !== -1 || m.indexOf("jumped to") !== -1 ||
        m.indexOf("toggled") !== -1 || m.indexOf("stopped") !== -1 || m.indexOf("reset") !== -1 ||
        m.indexOf("protected") !== -1 || m.indexOf("marked") !== -1 || m.indexOf("protected") !== -1) {
      return { icon: svg('<polyline points="20 6 9 17 4 12"/>'), msg: msg };
    }

    return { icon: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), msg: msg };
  }

  function toast(message, type, ms) {
    var el = $("toast");
    if (!el) return;
    var pair = _toastIcon(message, type);

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

    toastTimer = setTimeout(function () { el.className = "toast"; }, ms || 3000);
  }

  var _docDisconnected = false;
  var _docReconnectTimer = null;

  function setupConnectionMonitor() {
    var onOffline = function () {
      if (_docDisconnected) return;
      _docDisconnected = true;
      toast("Reconnecting…", "info", 99999);
      _docReconnectTimer = setTimeout(function () {
        if (_docDisconnected) showDisconnectModal();
      }, 15000);
    };
    var onOnline = function () {
      if (!_docDisconnected) return;
      _docDisconnected = false;
      clearTimeout(_docReconnectTimer);
      _docReconnectTimer = null;

      if (!$("connectionLostModal")) toast("Reconnected!", "success", 4000);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
  }

  function showDisconnectModal() {
    if ($("connectionLostModal")) { openModal("connectionLostModal"); return; }
    var overlay = document.createElement("div");
    overlay.id = "connectionLostModal";
    overlay.className = "modal-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML =
      '<div class="modal modal-sm" role="dialog" aria-modal="true" aria-label="Connection Lost">' +
        '<div class="modal-head">' +
          '<div class="modal-icon" style="background:#ee5a52;">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
              '<line x1="1" y1="1" x2="23" y2="23"/>' +
              '<path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>' +
              '<path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>' +
              '<path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>' +
              '<path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>' +
              '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>' +
              '<line x1="12" y1="20" x2="12.01" y2="20"/>' +
            '</svg>' +
          '</div>' +
          '<h3>Connection Lost</h3>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p style="font-size:14px;color:#383838;text-align:center;margin:0;font-family:\'DM Sans\',sans-serif;line-height:1.6;">' +
            "Your internet connection was lost. Check your connection then reload to continue working." +
          '</p>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn primary" id="connectionLostReloadBtn" type="button">Reload</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var reloadBtn = overlay.querySelector("#connectionLostReloadBtn");
    reloadBtn.addEventListener("click", function () { window.location.reload(); });
    openModal("connectionLostModal");
  }

  function hideDisconnectModal() {
    if ($("connectionLostModal")) closeModal("connectionLostModal");
  }

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

  async function init() {
    if (window.EmeraldAuth && window.EmeraldAuth.ready) await window.EmeraldAuth.ready();

    idb = window.EmeraldIDBStorage || null;
    if (idb) {

      try { await idb.ready(); } catch (e) {}
    }

    ensureFirstPage();
    paginate();
    setupConnectionMonitor();

    setupTableToolbar();
    if (window.EMTableKit && $(PAGES_WRAPPER_ID)) {
      emTableKitInstance = window.EMTableKit.attach({
        root: $(PAGES_WRAPPER_ID),
        minColWidth: 44,
        isEditable: function () {

          return !!currentDocId;
        },
        onChange: function (payload) {
          scheduleAutosave();

          schedulePaginate();
        },
        onEngaged: function (table) {
          syncTableDesignTab(table);
        },
        onSync: function (table) {
          var ctl = window._docsTableToolbar;
          if (!ctl) return;
          if (!table) ctl.hide();
          else if (ctl.activeCell && document.contains(ctl.activeCell)) ctl.reposition();
        }
      });
    }

    loadFootnotes();
    loadEndnotes();

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

        await openDocument(ownedParam, false);
      } else {

        history.replaceState({}, document.title, location.pathname);
      }
    }

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

    var msDropdowns = document.querySelectorAll(".ms-dropdown");
    for (var d = 0; d < msDropdowns.length; d++) {
      (function (dropdown) {
        var btn = dropdown.querySelector(":scope > .ms-dropdown-btn, :scope > button.ribbon-btn.ms-dropdown-btn");
        var menu = dropdown.querySelector(":scope > .ms-dropdown-menu");
        if (!btn || !menu) return;

        btn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-haspopup", "listbox");

        btn.addEventListener("mousedown", function (e) {

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

    document.addEventListener("mousedown", function (e) {
      if (_portalMenu &&
        !_portalMenu.contains(e.target) &&
        _portalBtn && !_portalBtn.contains(e.target)) {
        closePortalDropdown();
      }
    });

    window.addEventListener("scroll", function (e) {
      if (_portalMenu && (e.target === _portalMenu || _portalMenu.contains(e.target))) return;
      closePortalDropdown();
    }, true);
    window.addEventListener("resize", function () { closePortalDropdown(); });

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

      select.addEventListener("change", function () {
        var lbl = dropdown.querySelector(".dropdown-value");
        if (!lbl) return;
        var chosen = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen) {
          lbl.textContent = chosen.getAttribute("data-label") || chosen.textContent;
        } else {

          var optSel = select.options[select.selectedIndex];
          if (optSel) lbl.textContent = optSel.textContent;
        }
      });

      var lbl0 = dropdown.querySelector(".dropdown-value");
      if (lbl0) {
        var chosen0 = dropdown.querySelector('.ms-dropdown-item[data-value="' + select.value + '"]');
        if (chosen0) lbl0.textContent = chosen0.getAttribute("data-label") || chosen0.textContent;
        else { var o0 = select.options[select.selectedIndex]; if (o0) lbl0.textContent = o0.textContent; }
      }
    }

    wireSelectDropdown("fontFamilyDropdown", "fontFamily");
    wireSelectDropdown("fontSizeDropdown", "fontSize");

    var fontColorDd = $("fontColorDropdown");
    if (fontColorDd) {
      var fcItems = fontColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var f = 0; f < fcItems.length; f++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");

            if (color === "transparent" || isCurrentSwatch(fontColorDd, color)) {

              clearSelectionTint("color", true);
            } else {
              applyTextColor(color);
            }
            fontColorDd.classList.remove("active");
            closePortalDropdown();
            setTimeout(function () { updateToolbarStates(); updateRibbonAvailability(); }, 10);
          });
        })(fcItems[f]);
      }
    }

    var hlColorDd = $("highlightColorDropdown");
    if (hlColorDd) {
      var hlItems = hlColorDd.querySelectorAll(".ms-dropdown-item[data-value]");
      for (var h = 0; h < hlItems.length; h++) {
        (function (item) {
          item.addEventListener("click", function () {
            var color = item.getAttribute("data-value");
            if (color === "transparent" || isCurrentSwatch(hlColorDd, color)) {
              clearSelectionTint("background-color", false);
            } else {
              applyHiliteColor(color);
            }
            hlColorDd.classList.remove("active");
            closePortalDropdown();
            setTimeout(function () { updateToolbarStates(); updateRibbonAvailability(); }, 10);
          });
        })(hlItems[h]);
      }
    }

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

    if ($("btnNew")) $("btnNew").addEventListener("click", newDocument);
    if ($("btnFind")) $("btnFind").addEventListener("click", openFind);
    if ($("btnFind2")) $("btnFind2").addEventListener("click", openFind);
    if ($("btnSave")) $("btnSave").addEventListener("click", function () { saveDocument(true); });
    if ($("btnVersions")) { $("btnVersions").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnVersions").addEventListener("click", showVersions); }
    if ($("btnUndo")) { $("btnUndo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnUndo").addEventListener("click", function () { exec("undo"); }); }
    if ($("btnRedo")) { $("btnRedo").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnRedo").addEventListener("click", function () { exec("redo"); }); }

    initRibbonTabs();
    setupImageFormatTab();
    setupTableDesignTab();

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
    }

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

    $("btnPageBreak").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageBreak").addEventListener("click", insertPageBreak);

    $("btnWordCount").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWordCount").addEventListener("click", showWordCount);

    if ($("btnPrint")) {
      $("btnPrint").addEventListener("mousedown", function (e) { e.preventDefault(); });
      $("btnPrint").addEventListener("click", function () {

        printDocument();
      });
    }

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

    $("btnPrintExit").addEventListener("click", function () { togglePrintPreview(false); });
    $("btnPrintNow").addEventListener("click", function () {
      togglePrintPreview(false);
      printDocument();
    });

    if ($("btnTemplates")) $("btnTemplates").addEventListener("click", function () { buildTemplates(); openModal("templatesModal"); });

    $("btnSymbols").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnSymbols").addEventListener("click", function () { toggleSymbolBar(); });
    initSymbolBar();

    $("btnGoTo").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnGoTo").addEventListener("click", openGoTo);
    $("frGotoBtn").addEventListener("click", performGoTo);
    $("frGotoValue").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); performGoTo(); } });
    setupGotoTypeDropdown();

    $("btnWatermark").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnWatermark").addEventListener("click", openWatermark);
    $("watermarkConfirm").addEventListener("click", function () {
      applyWatermark($("watermarkText").value.trim());
      closeModal("watermarkModal");

      scheduleAutosave();
      setAutosaveState("saving");
      toast("Watermark applied", "success");
    });
    $("watermarkRemove").addEventListener("click", function () {
      applyWatermark(null);
      closeModal("watermarkModal");
      scheduleAutosave();
      setAutosaveState("saving");
      toast("Watermark removed", "success");
    });
    var wmPresets = document.querySelectorAll(".watermark-presets .preset-btn");
    for (var wp = 0; wp < wmPresets.length; wp++) {
      wmPresets[wp].addEventListener("click", function () { $("watermarkText").value = this.getAttribute("data-wm"); });
    }

    $("btnDropCap").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnDropCap").addEventListener("click", toggleDropCap);

    var colBtns = document.querySelectorAll("[data-cols]");
    for (var cb = 0; cb < colBtns.length; cb++) {
      (function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function () {
          setColumns(parseInt(b.getAttribute("data-cols"), 10));
        });
      })(colBtns[cb]);
    }

    document.querySelector("[data-cols='1']").classList.add("active");

    $("btnOrientation").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOrientation").addEventListener("click", toggleOrientation);

    $("btnHeader").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnHeader").addEventListener("click", function () { editHeaderFooter("header"); });
    $("btnFooter").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnFooter").addEventListener("click", function () { editHeaderFooter("footer"); });
    $("btnPageNum").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPageNum").addEventListener("click", insertPageNumber);

    $("btnReadAloud").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnReadAloud").addEventListener("click", readAloud);

    $("btnComment").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnComment").addEventListener("click", addComment);
    $("commentSaveBtn").addEventListener("click", confirmCommentComposer);
    $("commentText").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmCommentComposer(); }
    });

    if ($("fileModalCloseXBtn")) $("fileModalCloseXBtn").addEventListener("click", closeFileModal);
    $("fileModal").addEventListener("click", function (e) {
      if (e.target === $("fileModal")) closeFileModal();
    });

    if ($("fileDeleteBtn")) $("fileDeleteBtn").addEventListener("click", function () {
      var wasCurrent = currentDocId;
      closeFileModal();
      if (wasCurrent) confirmDeleteCurrentDoc();
    });
    if ($("fileCloseBtn")) $("fileCloseBtn").addEventListener("click", function () {
      closeFileModal();
      closeDocument();
    });

    if ($("fileExportTxtBtn")) $("fileExportTxtBtn").addEventListener("click", function () { closeFileModal(); exportDocument("txt"); });
    if ($("fileExportHtmlBtn")) $("fileExportHtmlBtn").addEventListener("click", function () { closeFileModal(); exportDocument("html"); });
    if ($("fileExportPdfBtn")) $("fileExportPdfBtn").addEventListener("click", function () { closeFileModal(); exportDocument("pdf"); });
    if ($("fileExportPrintBtn")) $("fileExportPrintBtn").addEventListener("click", function () { closeFileModal(); exportDocument("print"); });
    if ($("fileExportDocxBtn")) $("fileExportDocxBtn").addEventListener("click", function () { closeFileModal(); exportDocument("docx"); });

    if ($("fileStatsBtn")) $("fileStatsBtn").addEventListener("click", showWordCount);
    if ($("fileVersionsBtn")) $("fileVersionsBtn").addEventListener("click", showVersions);

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

    if ($("welcomeNewBtn")) $("welcomeNewBtn").addEventListener("click", createNewDocument);
    if ($("welcomeImportBtn")) $("welcomeImportBtn").addEventListener("click", function () { $("fileImportInput").click(); });
    var importInput = $("fileImportInput");
    if (importInput) importInput.addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      importDocumentFromFile(file);
      e.target.value = "";
    });

    if ($("deleteDocConfirm")) $("deleteDocConfirm").addEventListener("click", function () {
      var target = _deleteTargetId;

      closeDeleteDocModal();
      if (target) setTimeout(function () { deleteDocument(target); }, 250);
    });
    if ($("deleteDocCancel")) $("deleteDocCancel").addEventListener("click", closeDeleteDocModal);
    var delModal = $("deleteDocModal");
    if (delModal) delModal.addEventListener("click", function (e) {
      if (e.target === delModal) closeDeleteDocModal();
    });

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

    if ($("btnTocRef")) { $("btnTocRef").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnTocRef").addEventListener("click", insertTOC); }
    if ($("btnFootnote")) { $("btnFootnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnFootnote").addEventListener("click", openFootnoteModal); }
    if ($("btnEndnote")) { $("btnEndnote").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnEndnote").addEventListener("click", openEndnoteModal); }
    if ($("btnCitation")) { $("btnCitation").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnCitation").addEventListener("click", openCiteModal); }
    if ($("btnBibliography")) { $("btnBibliography").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnBibliography").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Bibliography</h2><p>Entry 1. Author, Title, Publisher, Year.</p>'); toast("Bibliography inserted", "success"); schedulePaginate(); }); }
    if ($("btnIndexEntry")) { $("btnIndexEntry").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnIndexEntry").addEventListener("click", function () { var sel = window.getSelection(); if (sel && !sel.isCollapsed) { toast("Index entry marked: " + sel.toString(), "success"); } else { toast("Select text first to mark an index entry", "error"); } }); }
    if ($("btnInsertIndex")) { $("btnInsertIndex").addEventListener("mousedown", function (e) { e.preventDefault(); }); $("btnInsertIndex").addEventListener("click", function () { document.execCommand("insertHTML", false, '<h2>Index</h2><p>Term, Page</p>'); toast("Index inserted", "success"); schedulePaginate(); }); }

    var stBtn = $("sessionTimer");
    if (stBtn) {
      stBtn.addEventListener("click", function () {
        if (sessionActive) {
          if (window.confirm("Reset the writing session timer?")) resetSessionTimer();
        }
      });
    }

    $("btnOutline").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnOutline").addEventListener("click", function () { toggleOutline(); });
    $("outlineClose").addEventListener("click", function () { toggleOutline(false); });
    $("outlineSearch").addEventListener("input", filterOutline);

    $("btnPages").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("btnPages").addEventListener("click", function () { toggleThumbnails(); });
    $("thumbnailsClose").addEventListener("click", function () { toggleThumbnails(false); });

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

    var closeBtns = document.querySelectorAll("[data-close]");
    for (var ci = 0; ci < closeBtns.length; ci++) {
      closeBtns[ci].addEventListener("click", function () {
        closeModal(this.getAttribute("data-close"));
      });
    }

    var overlays = document.querySelectorAll(".modal-overlay");
    for (var oi = 0; oi < overlays.length; oi++) {
      (function (ov) {
        ov.addEventListener("mousedown", function (e) {
          if (e.target === ov) closeModal(ov.id);
        });
      })(overlays[oi]);
    }

    $("frFindInput").addEventListener("input", runFind);
    $("frCaseSensitive").addEventListener("change", runFind);
    $("frWholeWord").addEventListener("change", runFind);
    if ($("frRegex")) $("frRegex").addEventListener("change", runFind);
    $("frNextBtn").addEventListener("click", findNext);
    $("frPrevBtn").addEventListener("click", findPrev);
    $("frReplaceOneBtn").addEventListener("click", replaceOne);
    $("frReplaceAllBtn").addEventListener("click", replaceAll);
    $("frCloseBtn").addEventListener("click", closeFindBar);

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

    $("linkConfirm").addEventListener("click", insertLink);
    $("linkUrl").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });
    $("linkText").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); insertLink(); }
    });

    $("tableConfirm").addEventListener("click", insertTable);
    buildTableGrid();

    $("zoomFitBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomFitBtn").addEventListener("click", zoomFitToWindow);
    $("zoom100Btn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoom100Btn").addEventListener("click", function () { setZoom(100); });
    $("zoomInBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomInBtn").addEventListener("click", function () { adjustZoom(10); });
    $("zoomOutBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("zoomOutBtn").addEventListener("click", function () { adjustZoom(-10); });

    $("toggleRulerBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("toggleRulerBtn").addEventListener("click", function (e) {
      var on = document.body.classList.toggle("show-rulers");
      e.currentTarget.classList.toggle("active", on);
      if (on) buildRulerTicks();
    });

    $("toggleGuidesBtn").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("toggleGuidesBtn").addEventListener("click", function (e) {
      var on = document.body.classList.toggle("show-guides");
      e.currentTarget.classList.toggle("active", on);
      var wrapper = $(PAGES_WRAPPER_ID);
      if (wrapper) wrapper.classList.toggle("show-guides", on);
    });

    $("documentScroll").addEventListener("scroll", function () {
      if (document.body.classList.contains("show-rulers")) buildRulerTicks();
    });
    window.addEventListener("resize", function () {
      if (document.body.classList.contains("show-rulers")) buildRulerTicks();
    });

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

    try {
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {}

    loadMargins();
    loadGoal();

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

    window.addEventListener("pagehide", commitSessionTime);

    setTimeout(function () {

      if (!currentDocId) return;
      var firstContent = getContent(getPages()[0]);
      if (firstContent) firstContent.focus();
    }, 120);
  }

  var crossTabIgnoreUntil = 0;
  function initCrossTabSync() {
    if (!idb || !idb.subscribe) return;
    idb.subscribe(function (change) {

      if (!change || !change.key) return;

      if (change.at && change.at < crossTabIgnoreUntil) return;

      if (change.key === DOC_INDEX_KEY) {

        loadIndex().then(function () {
          if (!currentDocId) renderWelcomeCards();
        });
      } else if (currentDocId && change.key === docDataKey(currentDocId)) {

        reloadFromStorageQuietly();
      } else if (change.key === MARGINS_KEY) {
        loadMargins();
        schedulePaginate();
      } else if (change.key === GOAL_KEY) {
        loadGoal();
        updateGoalTracker();
      } else if (change.key === WRITING_TIME_KEY) {
        writingTimeCache = null;
      }
    });
  }

  async function reloadFromStorageQuietly() {
    try {
      if (!currentDocId) return;
      var activeEditor = document.activeElement && document.activeElement.closest && document.activeElement.closest(".page-content");
      if (activeEditor) {
        pendingExternalReload = true;
        return;
      }
      pendingExternalReload = false;
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

      applyWatermark(data.watermark || "");
      paginate();
      setAutosaveState("saved");

      if (caretInfo) restoreCaretSnapshot(caretInfo);
    } catch (e) {  }
  }

  function saveCaretSnapshot() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var block = range.startContainer;
    if (block.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block && !block.classList.contains("page-content")) block = block.parentElement;
    if (!block) return null;

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

  function openCoverPageDialog() {

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

    var firstPage = getPages()[0];
    var content = getContent(firstPage);
    var p = document.createElement("p");
    p.innerHTML = html;

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

  var sectionOrient = "portrait";
  function insertSectionBreak() {

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

    closeModal("sectionBreakModal");

    setTimeout(function () {
      focusEditorAndRestore();
      document.execCommand("insertHTML", false, html);
      schedulePaginate();
      scheduleAutosave();
    }, 0);
    toast("Section break inserted (" + orient + ", " + mt + "cm margins)", "success");
  }

  function applyPdfPageSizes() {
    var pages = getPages();
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var holder = page.querySelector(".emdocs-pdf-page[data-pdf-w]");
      if (!holder) continue;
      var w = parseInt(holder.getAttribute("data-pdf-w"), 10);
      var h = parseInt(holder.getAttribute("data-pdf-h"), 10);
      if (!(w > 0) || !(h > 0)) continue;
      var landscape = w > h;
      page.style.width = w + "px";
      page.style.height = h + "px";
      page.classList.toggle("landscape", landscape);

      page.style.setProperty("--sec-mt", PDF_EXACT_MARGIN + "px");
      page.style.setProperty("--sec-mr", PDF_EXACT_MARGIN + "px");
      page.style.setProperty("--sec-mb", PDF_EXACT_MARGIN + "px");
      page.style.setProperty("--sec-ml", PDF_EXACT_MARGIN + "px");
    }
  }

  function applySectionConfigs() {
    var pages = getPages();
    var currentConfig = null;
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];

      var breaks = page.querySelectorAll(".section-break[data-section-config]");
      if (breaks.length > 0) {

        var firstChild = getContent(page).firstElementChild;
        var breakIsFirst = firstChild && firstChild.classList.contains("section-break");
        if (breakIsFirst) {
          try {
            currentConfig = JSON.parse(breaks[0].getAttribute("data-section-config") || "null");
          } catch (e) {}
        } else {

          try {
            var nextConfig = JSON.parse(breaks[breaks.length - 1].getAttribute("data-section-config") || "null");

            page.setAttribute("data-next-section", "1");

            for (var j = i + 1; j < pages.length; j++) {
              applyConfigToPage(pages[j], nextConfig);
            }

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

  function renderEquation(latex) {

    if (!latex) return "";

    var out = escapeHtml(latex);

    out = out.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">' + a + '</span><span style="display:block;padding:0 4px">' + b + '</span></span>';
    });

    out = out.replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, function (m, a, b) {
      return '(<span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;padding:0 2px">' + a + '</span><span style="display:block;border-top:1px solid currentColor;padding:0 2px">' + b + '</span></span>)';
    });

    out = out.replace(/\\sqrt\{([^{}]*)\}/g, function (m, a) {
      return '<span style="white-space:nowrap">√<span style="border-top:1px solid currentColor;padding:0 2px">' + a + '</span></span>';
    });

    out = out.replace(/\\sum_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∑<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\sum/g, "∑");

    out = out.replace(/\\prod_\{([^{}]*)\}\^\{([^{}]*)\}/g, function (m, lo, hi) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:1.4em">∏<span style="display:block;font-size:0.5em">' + lo + '..' + hi + '</span></span>';
    });
    out = out.replace(/\\prod/g, "∏");

    out = out.replace(/\\int_\{?([^{}]*?)\}?\^\{?([^{}]*?)\}?/g, function (m, lo, hi) {
      return '<span style="font-size:1.4em">∫</span><sub>' + lo + '</sub><sup>' + hi + '</sup>';
    });
    out = out.replace(/\\int/g, "∫");

    out = out.replace(/\\lim_\{([^{}]*)\}/g, function (m, sub) {
      return 'lim<span style="display:inline-block;vertical-align:middle;text-align:center;font-size:0.7em"><span style="display:block">' + sub.replace(/\\to/g, "→") + '</span></span>';
    });
    out = out.replace(/\\lim/g, "lim");

    out = out.replace(/\\log_\{([^{}]*)\}/g, function (m, base) {
      return 'log<span style="font-size:0.7em;vertical-align:sub">' + base + '</span>';
    });
    out = out.replace(/\\ln/g, "ln");

    out = out.replace(/\\frac\{d\}\{d([^{}]*)\}/g, function (m, varname) {
      return '<span style="display:inline-block;vertical-align:middle;text-align:center;font-style:italic"><span style="display:block;border-bottom:1px solid currentColor;padding:0 4px">d</span><span style="display:block;padding:0 4px">d' + varname + '</span></span>';
    });

    out = out.replace(/\\(sin|cos|tan|cot|sec|csc)\b/g, function (m, fn) { return fn; });

    out = out.replace(/\\to/g, "→");

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

    out = out.replace(/\^\{([^{}]*)\}/g, "<sup>$1</sup>");
    out = out.replace(/\^([^\s\\{}])/g, "<sup>$1</sup>");

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

      await new Promise(function (r) { setTimeout(r, 250); });
      var canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);
      var dataUrl = canvas.toDataURL("image/png");
      track.stop();
      document.body.removeChild(video);

      try { window.focus(); } catch (_) {}

      restoreEditorSelection();
      document.execCommand("insertHTML", false, '<img class="screenshot-img" src="' + dataUrl + '" alt="Screenshot" style="max-width:100%" />');
      schedulePaginate();
      scheduleAutosave();
      toast("Screenshot inserted", "success");
    } catch (e) {
      toast("Screenshot cancelled or failed", "error");
    }
  }

  function toggleDrawMode(force) {
    var toolbar = $("drawToolbar");
    var app = $("app");
    var btn = $("btnDraw");
    var shouldOpen = force === undefined ? !drawMode : force;
    drawMode = shouldOpen;
    if (shouldOpen) {

      toggleSymbolBar(false);
      app.classList.add("draw-mode");
      toolbar.classList.add("visible");
      ensureDrawCanvas();
      if (btn) btn.classList.add("active");

    } else {
      app.classList.remove("draw-mode");
      toolbar.classList.remove("visible");

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
      drawCtx.globalAlpha = 0.4;
    } else {
      drawCtx.globalCompositeOperation = "source-over";
      drawCtx.strokeStyle = drawColor;
      drawCtx.fillStyle = drawColor;
      drawCtx.lineWidth = drawWidth || 2;
      drawCtx.globalAlpha = 1;
    }

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

      var hideColor = (tool === "eraser");
      if (colorSection) colorSection.classList.toggle("eraser-hidden", hideColor);
      if (colorDivider && colorDivider.classList.contains("color-divider")) colorDivider.classList.toggle("eraser-hidden", hideColor);
      if (drawCanvas) drawCanvas.classList.toggle("eraser-active", tool === "eraser");
    };
    if (penBtn) penBtn.addEventListener("click", function () { setTool("pen"); });
    if (highlighterBtn) highlighterBtn.addEventListener("click", function () { setTool("highlighter"); });
    if (eraserBtn) eraserBtn.addEventListener("click", function () { setTool("eraser"); });

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

    var clearBtn = $("drawClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearDrawing);
    var doneBtn = $("drawDoneBtn");
    if (doneBtn) doneBtn.addEventListener("click", function () { toggleDrawMode(false); });

    var bDraw = $("btnDraw");
    if (bDraw) {
      bDraw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      bDraw.addEventListener("click", function () { toggleDrawMode(); });
    }
  }

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

          var refEl = document.getElementById(fn.refId);
          if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);

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

            var refEl = document.getElementById(en.refId);
            if (refEl && refEl.parentNode) refEl.parentNode.removeChild(refEl);

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

    if (ordered.length > 0 && ordered.length === footnotes.length) {
      footnotes = ordered;
      saveFootnotes();
    }
  }

  function renderFootnotesSection() {

    var existing = document.querySelectorAll(".footnotes-section");
    for (var i = 0; i < existing.length; i++) existing[i].parentElement && existing[i].parentElement.removeChild(existing[i]);

    var pfa = document.querySelectorAll(".page-footnote-area");
    for (var j = 0; j < pfa.length; j++) pfa[j].parentElement && pfa[j].parentElement.removeChild(pfa[j]);

    var pages = getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var pc = getContent(pages[pi]);
      pc.classList.remove("has-footnotes-ref");
      pc.style.removeProperty("--fn-reserve");
    }
    if (footnotes.length === 0) return;

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
        reservedH += 18;
      }
      if (area.children.length > 0) {
        page.appendChild(area);
        pageContent.classList.add("has-footnotes-ref");
        pageContent.style.setProperty("--fn-reserve", Math.min(160, reservedH + 12) + "px");
      }
    }

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

  function renderEndnotesSection() {

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

  function findProblemMarker(range) {
    function inMarker(node) {
      var el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      if (!el || !el.closest) return null;
      return el.closest("sup.footnote-ref, sup.endnote-ref, sup.comment-ref") || null;
    }

    var m = inMarker(range.startContainer);
    if (m) return m;

    if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
      var ch = range.startContainer.childNodes[range.startOffset];
      if (isInlineMarker(ch)) return ch;
    }

    if (range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startOffset === range.startContainer.nodeValue.length) {
      var nx = range.startContainer.nextSibling;
      if (isInlineMarker(nx)) return nx;
    }
    return null;
  }

  function reAnchorCaretPastMarker(marker, sel) {

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

  function setupMarkerEnterFix() {
    var pagesWrap = $(PAGES_WRAPPER_ID);
    if (!pagesWrap) return;

    pagesWrap.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var marker = findProblemMarker(sel.getRangeAt(0));
      if (!marker) return;

      e.preventDefault();
      reAnchorCaretPastMarker(marker, sel);
      try { document.execCommand("insertParagraph"); } catch (err) {}
      schedulePaginate();
      scheduleAutosave();
    });
  }

  function initNewFeatures() {

      var scrollEl = $("documentScroll");
      if (scrollEl) {
        scrollEl.addEventListener("click", handleInternalLinkClick);

        scrollEl.addEventListener("click", function (e) {
          var tocLink = e.target.closest("a[data-toc]");
          if (!tocLink) return;
          e.preventDefault();
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          jumpToHeadingByTOC(tocLink);
        });

        scrollEl.addEventListener("auxclick", function (e) {
          var tocLink = e.target.closest("a[data-toc]");
          if (!tocLink) return;
          e.preventDefault();
          jumpToHeadingByTOC(tocLink);
        });

      scrollEl.addEventListener("click", function (e) {
        var a = e.target.closest("a");
        if (!a) return;

        if (a.classList.contains("emdocs-internal-link") || a.classList.contains("emdocs-bookmark")) return;
        if (a.closest(".emdocs-toc")) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          var href = a.getAttribute("href");
          if (isSafeExternalUrl(href)) {

            window.open(normalizeExternalUrl(href), "_blank", "noopener");
          }
        } else {

          e.preventDefault();
        }
      });

      scrollEl.addEventListener("click", function (e) {
        var pb = e.target.closest(".emdocs-page-break");
        if (!pb) return;
        e.preventDefault();
        if (pb.parentElement) {

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

      });
    }

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

    var bSA = $("btnSmartArt");
    if (bSA) { bSA.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSA.addEventListener("click", openSmartArtDialog); }

    var bSS = $("btnScreenshot");
    if (bSS) { bSS.addEventListener("mousedown", function (e) { e.preventDefault(); }); bSS.addEventListener("click", takeScreenshot); }

    initDrawToolbar();

    var bFn = $("btnFootnote");
    if (bFn) { bFn.addEventListener("mousedown", function (e) { e.preventDefault(); }); bFn.addEventListener("click", openFootnoteModal); }
    var bFnPanel = $("footnoteAddFromPanel");
    if (bFnPanel) bFnPanel.addEventListener("click", openFootnoteModal);
    var bEnPanel = $("endnoteAddFromPanel");
    if (bEnPanel) bEnPanel.addEventListener("click", openEndnoteModal);
    var bFnClose = $("footnotesClose");
    if (bFnClose) bFnClose.addEventListener("click", function () { toggleFootnotes(false); });

    setupMarkerEnterFix();

    initRound2Features();

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var fp = $("footnotesPanel"); if (fp && fp.classList.contains("open")) { toggleFootnotes(false); return; }
      }
    });
  }

  function initStatusBarControls() {

    var scrollEl = $("documentScroll");
    if (scrollEl) {
      scrollEl.addEventListener("wheel", function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();

        var delta = e.deltaY > 0 ? -1 : 1;
        var factor = 1 + (delta * 0.08);
        zoomByFactor(factor);
      }, { passive: false });
    }

    document.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;

      var target = e.target;
      if (target && target.closest && target.closest(".modal-overlay, .outline-panel, .thumbnails-panel, .footnotes-panel")) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -1 : 1;
      var factor = 1 + (delta * 0.08);
      zoomByFactor(factor);
    }, { passive: false });

    var psLabel = $("pageSizeLabel");
    if (psLabel) {

    }
  }

  function adjustZoom(delta) {
    setZoom(currentZoom + delta);
  }

  function zoomByFactor(factor) {
    setZoom(Math.round(currentZoom * factor));
  }

  function getBasePageSize() {
    var page = getPages()[0];
    if (page) {
      var w = parseFloat(page.style.width);
      var h = parseFloat(page.style.height);
      if (!isNaN(w) && w > 0 && !isNaN(h) && h > 0) return { w: w, h: h };
    }
    return { w: PAGE_WIDTH, h: PAGE_HEIGHT };
  }

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

      totalBlocks += content.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre").length;

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

    var h = str.match(/^#([0-9a-f]{6})$/i);
    if (h) {
      var n = parseInt(h[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }

  function initRound2Features() {
    initStatusBarControls();

    var bA11y = $("btnAccessibilityCheck");
    if (bA11y) { bA11y.addEventListener("mousedown", function (e) { e.preventDefault(); }); bA11y.addEventListener("click", runAccessibilityCheck); }

    setInterval(function () { updateRelativeAutosave(); }, 10000);
  }

  var richTip = null;
  var richTipTimer = null;
  function initTooltips() {
    if (richTip) return;
    richTip = document.createElement("div");
    richTip.className = "rich-tip";
    document.body.appendChild(richTip);

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

      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
      clearTimeout(richTipTimer);
      richTipTimer = setTimeout(function () {
        var tip = el.getAttribute("data-tip") || "";
        var shortcut = "";

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

      var tip = el.getAttribute("data-tip");
      if (tip) { el.setAttribute("title", tip); el.removeAttribute("data-tip"); }
    });
  }

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
