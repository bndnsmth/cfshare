export function inputUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}
