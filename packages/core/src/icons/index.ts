/** Entry point owned by Track C (stub until implemented). */
import type { CreateIconResolverFn, FetchIconPackFn, SvgSanitizer } from "../contracts/index.js";

export const sanitizeSvg: SvgSanitizer = () => {
  throw new Error("not implemented: owned by Track C");
};
export const createIconResolver: CreateIconResolverFn = () => {
  throw new Error("not implemented: owned by Track C");
};
export const fetchIconPack: FetchIconPackFn = () =>
  Promise.reject(new Error("not implemented: owned by Track C"));
