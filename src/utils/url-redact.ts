/**
 * Redacts userinfo credentials from a URL for safe logging.
 * `https://user:pass@host:8443/path` becomes `https://***@host:8443/path`.
 * URLs without userinfo are returned unchanged.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@");
}
