// imported first by index.ts: every later module sees the buffered fetch (fetchSafe.ts)
import { installBufferedFetch } from "./fetchSafe.js";
installBufferedFetch();
