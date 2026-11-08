document.querySelectorAll('.dropdown').forEach(dropdown => {
    let hideTimeout;
    dropdown.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
      dropdown.classList.add('show');
    });
    dropdown.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(() => {
        dropdown.classList.remove('show');
      }, 300);
    });
  });