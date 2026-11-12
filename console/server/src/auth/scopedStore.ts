import type { DB } from "../db.js";
import { createStore, type Store } from "../store.js";
import { currentAuth } from "./identity.js";

/**
 * the one store object every route and module closes over, scoped per request. Inside a request whose auth
 * context carries a scope (CONSOLE_AUTH=on), every call goes to `forTenant(scope)` ('s scoped store: foreign ids are
 * undefined → 404, lists hold only that world, creates are stamped). Outside a request (cycle, sweeps) and with auth off
 * or shadow it is `base`, exactly as before. Scoped stores are cached per tenant.
 */
export function requestScopedStore(db: DB, base: Store): Store {
  const cache = new Map<string, Store>();
  const forScope = (t: string) => {
    let s = cache.get(t);
    if (!s) cache.set(t, (s = createStore(db, { tenant: t })));
    return s;
  };
  return new Proxy(base, {
    get(target, prop) {
      const scope = currentAuth()?.scope;
      const s = scope && scope !== target.tenant ? forScope(scope) : target;
      return Reflect.get(s, prop, s);
    },
  });
}
