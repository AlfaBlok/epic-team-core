import type { ApiClient } from "./client";
import { createMockClient } from "./mock";
import { createRealClient } from "./real";

export type { ApiClient, PushInfo } from "./client";
export * from "./types";
export * from "./inbox-types";
export * from "./review-types";

/** VITE_API=mock|real (default: mock until the server lands). */
export const apiMode: "mock" | "real" = import.meta.env.VITE_API === "real" ? "real" : "mock";

export const api: ApiClient = apiMode === "real" ? createRealClient() : createMockClient();
