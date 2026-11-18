import { validatePdfAst } from '../engine/validate.js';

export function validateAst(input: unknown) {
  return validatePdfAst(input);
}
