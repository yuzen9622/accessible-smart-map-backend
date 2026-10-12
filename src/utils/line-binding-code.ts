/** Only a complete six-character code is accepted; never extract from prose. */
export function normalizeLineBindingCode(code: string): string | null {
  if (typeof code !== "string") return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(normalized) ? normalized : null;
}
