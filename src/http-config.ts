/** Public URLs are origins; route prefixes remain part of the API contract. */
export function readHttpConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be 1–65535.');
  function origin(name: string, fallback: string) {
    const value = env[name]?.trim() || fallback;
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `${name} must be an HTTP(S) origin without a path or credentials.`,
      );
    }
    return url.origin;
  }
  const apiOrigin = origin('API_ORIGIN', `http://localhost:${port}`);
  const webOrigin = origin('WEB_ORIGIN', 'http://localhost:3000');
  return {
    port,
    host: env.HOST?.trim() || '127.0.0.1',
    apiOrigin,
    webOrigin,
    chatHostnames: [
      'localhost',
      '127.0.0.1',
      '[::1]',
      new URL(apiOrigin).hostname,
    ],
  };
}
