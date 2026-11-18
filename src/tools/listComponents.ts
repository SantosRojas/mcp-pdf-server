import { catalogForCategory } from '../engine/validate.js';

export function listPdfComponents(category?: string): unknown {
  return catalogForCategory(category);
}
