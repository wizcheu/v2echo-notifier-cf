// Paint the persisted theme before the app loads to avoid a flash.
// Mirrors the shadcn-admin ThemeProvider cookie and falls back to the OS.
try {
  var match = document.cookie.match(/(?:^|;\s*)vite-ui-theme=([^;]+)/);
  var mode = match ? decodeURIComponent(match[1]) : "system";
  var dark =
    mode === "dark" ||
    (mode !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  if (dark) document.documentElement.dataset.theme = "dark";
  var accentMatch = document.cookie.match(/(?:^|;\s*)vite-ui-accent=([^;]+)/);
  var accent = accentMatch ? decodeURIComponent(accentMatch[1]) : "neutral";
  if (accent && accent !== "neutral")
    document.documentElement.dataset.accent = accent;
} catch {
  // Default to the light theme when storage is unavailable.
}
