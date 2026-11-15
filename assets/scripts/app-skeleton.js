(function () {
  'use strict';

  const skeleton = document.querySelector('[data-app-skeleton]');
  if (!skeleton) return;

  let hidden = false;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    skeleton.classList.add('is-leaving');
    window.setTimeout(() => { skeleton.hidden = true; }, 240);
  };

  window.AppSkeleton = { hide };
  window.setTimeout(hide, 15000);
})();
