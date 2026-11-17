// E948-S129: react/jsx-dev-runtime with every URL in a host element's text as a link (links.ts).
import * as R from "react/jsx-dev-runtime";
import { linkProps } from "./links";

export const Fragment = R.Fragment;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const jsxDEV = (type: any, props: any, key: any, isStatic: boolean, source: any, self: any) => R.jsxDEV(type, linkProps(type, props), key, isStatic, source, self);
