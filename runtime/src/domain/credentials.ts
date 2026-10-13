export interface ModelCredentials {
  get(reference: string): string | undefined;
  references(): string[];
  save(values: Record<string, string>): void;
}
export function credentialValues(value: unknown, limit = 20): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential entries');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > limit) throw new Error('Credential entry limit exceeded');
  for (const [reference, secret] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,99}_(?:API_KEY|TOKEN|SECRET)$/.test(reference) || /^(?:ROSTER|NODE|PYTHON|GIT|NPM)_/.test(reference) ||
        typeof secret !== 'string' || !secret.trim() || secret.length > 4096 || /[\r\n\0]/.test(secret))
      throw new Error('Invalid credential reference or value');
  }
  return Object.fromEntries(entries);
}
