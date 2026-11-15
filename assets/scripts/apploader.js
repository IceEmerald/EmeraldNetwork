/* ============================================================
   EmeraldNetwork — shared app boot loader helper
   Works together with assets/styles/apploader.css and the
   #app-loader markup included right after <body> in app pages.
   Each app calls window.EmeraldAppLoader.hide() once its boot
   sequence is complete (data loaded, first render done).
   ============================================================ */
(function () {
  var el = document.getElementById('app-loader');
  var hidden = false;
  var safetyTimer = null;

  function hide() {
    if (hidden || !el) return;
    hidden = true;
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    el.classList.add('app-loader--done');
    el.setAttribute('aria-busy', 'false');
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 500);
  }

  function setMessage(text) {
    var label = document.getElementById('app-loader-label');
    if (label && typeof text === 'string' && text) {
      label.textContent = text;
    }
  }

  if (el) {
    el.setAttribute('aria-busy', 'true');
    // Failsafe: never trap the user behind the loader if an app fails to boot.
    safetyTimer = setTimeout(hide, 15000);
  }

  window.EmeraldAppLoader = { hide: hide, setMessage: setMessage };
})();
