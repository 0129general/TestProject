// Classic, external head script: extension CSP permits self-hosted scripts, and this runs before
// the first paint. This cache contains only appearance preferences; it never grants wallet access.
(() => {
  let theme;
  let mode;
  try {
    theme = localStorage.getItem('trust:boot-theme');
    mode = localStorage.getItem('trust:boot-color-mode');
  } catch {
    // Private profiles can deny localStorage.
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const selected = mode === 'light' || mode === 'dark' ? mode : dark ? 'dark' : 'light';
  const legacy = theme === 'light-legacy' || theme === 'dark-legacy';
  document.documentElement.setAttribute('data-theme', selected + (legacy ? '-legacy' : ''));
})();
