/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API?: "mock" | "real";
  /** thread link template, `{env}` = T3 environment id, `{id}` = thread id (both URL-encoded); see threadHref. */
  readonly VITE_T3_THREAD_URL?: string;
  /** dev-copy skin flag (`console` | `social`); unset = console. Replaced by the world's setting from /api/me. */
  readonly VITE_SKIN?: string;
}
