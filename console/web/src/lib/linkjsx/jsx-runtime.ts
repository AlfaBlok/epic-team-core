// E948-S129: react/jsx-runtime with every URL in a host element's text as a link (links.ts).
import * as R from "react/jsx-runtime";
import { linkProps } from "./links";

export const Fragment = R.Fragment;
type Jsx = typeof R.jsx;
export const jsx: Jsx = (type, props, key) => R.jsx(type, linkProps(type, props), key);
export const jsxs: Jsx = (type, props, key) => R.jsxs(type, linkProps(type, props), key);
