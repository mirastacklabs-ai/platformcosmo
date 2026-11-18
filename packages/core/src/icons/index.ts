/** Icon system entry points (Track C). */
import type { FetchIconPackFn } from "../contracts/index.js";

export { sanitizeSvg } from "./sanitize.js";
export { createIconResolver } from "./resolver.js";
export const fetchIconPack: FetchIconPackFn = () =>
  Promise.reject(new Error("not implemented: lands in the fetch PR"));
