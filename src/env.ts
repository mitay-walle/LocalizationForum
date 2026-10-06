export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

export const list = (name: string): string[] =>
  (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
