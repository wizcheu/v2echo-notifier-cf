declare const __APP_VERSION__: string | undefined;

export const RELEASE_REPO = "wizcheu/v2echo-notifier-cf";
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPO}/releases`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

export const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Build-time injected SemVer string without leading "v". */
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" && SEMVER_RE.test(__APP_VERSION__)
    ? __APP_VERSION__.replace(/^v/, "")
    : "0.0.1";

export function normalizeVersion(value: string): string | null {
  const match = value.trim().match(SEMVER_RE);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}`;
}

/**
 * Compare two SemVer strings (with or without leading "v").
 * Returns -1 if a < b, 0 if equal, 1 if a > b, or null if either is invalid.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = a.trim().match(SEMVER_RE);
  const right = b.trim().match(SEMVER_RE);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const leftPre = left[4] ?? "";
  const rightPre = right[4] ?? "";
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  const lp = leftPre.split(".");
  const rp = rightPre.split(".");
  const len = Math.max(lp.length, rp.length);
  for (let i = 0; i < len; i++) {
    const x = lp[i];
    const y = rp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
