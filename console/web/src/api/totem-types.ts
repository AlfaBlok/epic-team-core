/** Root L-77: the map, one file per product in docs/totems/ (server totemMap.ts). */
export type TotemShape = "page" | "table" | "tree";
export interface Totem {
  id: string;
  name: string;
  shape: TotemShape;
  tab: string;
  lives: { repo?: string; path?: string; section?: string; board?: string; note?: string };
  live?: string;
  read?: string;
  write?: string;
}
export interface ProductMap {
  product: string;
  name: string;
  line?: string;
  repos: string[];
  objectives: string[];
  totems: Totem[];
  grows: { name: string; from: string; lives: string }[];
}
export interface TotemMaps {
  statement: string;
  every: { totems: Totem[]; grows: { name: string; from: string; lives: string }[] };
  products: ProductMap[];
}
export interface TotemView {
  product: string;
  id: string;
  name: string;
  shape: TotemShape;
  where: string;
  live?: string;
  read?: string;
  write?: string;
  empty: boolean;
  markdown?: string;
  headers?: string[];
  rows?: string[][];
  tree?: { label: string; children: { id: string; label: string; status: string }[] }[];
}
