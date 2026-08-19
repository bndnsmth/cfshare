export function publicOrigin(request: Request, configuredOrigin?: string): string {
  if (configuredOrigin) {
    try {
      const configured = new URL(configuredOrigin);

      if (configured.protocol === "https:" && configured.pathname === "/") {
        return configured.origin;
      }
    } catch {}
  }

  return new URL(request.url).origin;
}
