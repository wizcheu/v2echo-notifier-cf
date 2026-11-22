/** Remove raw credentials and preferences left by pre-shadcn builds. */
export function clearLegacySession() {
  try {
    sessionStorage.removeItem("v2echo-cf-session");
    localStorage.removeItem("v2echo-cf-ui");
  } catch {
    // The HttpOnly session cookie does not depend on browser storage APIs.
  }
}
