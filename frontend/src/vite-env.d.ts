/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin. Empty (the default) means same-origin requests. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
