/** Baileys wraps disconnect causes in a Boom error whose status code says why. */
export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('output' in error)) return undefined;
  const output = error.output;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return undefined;
  const code = output.statusCode;
  return typeof code === 'number' ? code : undefined;
}
