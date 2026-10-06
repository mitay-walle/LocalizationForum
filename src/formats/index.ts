import { jsonFlat, jsonNested } from './json.js';
import { rimworld } from './rimworld.js';
import type { Format } from './types.js';

export type { Format, ParsedString, OutString } from './types.js';

const FORMATS: Record<string, Format> = {
  [jsonFlat.id]: jsonFlat,
  [jsonNested.id]: jsonNested,
  [rimworld.id]: rimworld,
};

export const formatIds = Object.keys(FORMATS);

export function getFormat(id: string): Format {
  const f = FORMATS[id];
  if (!f) throw new Error(`Unknown format "${id}". Known: ${formatIds.join(', ')}`);
  return f;
}
