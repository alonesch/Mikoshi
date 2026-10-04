import type { MikoshiApi } from "../../contracts";

declare global {
  interface Window {
    mikoshi: MikoshiApi;
  }
}
