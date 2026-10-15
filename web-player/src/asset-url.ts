/** Rebase local public assets while preserving external and browser-owned URLs. */
export function assetUrl(path: string, baseUrl = import.meta.env.BASE_URL): string {
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(path)) return path;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  // A manifest may already contain its deployment prefix.
  if (base !== '/' && path.startsWith(base)) return path;
  return `${base}${path.replace(/^(?:\.\/|\/)+/, '')}`;
}
