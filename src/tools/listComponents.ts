import { catalogForCategory } from '../engine/validate.js';

export function listPdfComponents(category?: string, includeSchema = false): unknown {
  return catalogForCategory(category, includeSchema);
}
