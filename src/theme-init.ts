// Runs synchronously as the first child of <body> in popup/options/onboarding
// HTML. Applies the dark class to document.body BEFORE the rest of the body
// renders, so dark-mode users don't see a light-theme flash on page open.
// Kept intentionally tiny (no imports, no types beyond built-ins) because
// it blocks the parser briefly.
try {
  if (localStorage.getItem('safeplay_theme') === 'dark') {
    document.body.classList.add('dark');
  }
} catch {
  // localStorage access can throw in some privacy modes; fail open to light.
}
