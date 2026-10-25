// The site's only data source (PUB-06): resolved at build time by the @public-data alias in rsbuild.config.ts.
// Typed unknown on purpose: data.ts validates it before any page uses it.
declare module '@public-data/*.json' {
  const value: unknown
  export default value
}

// Set by rsbuild.config.ts from ../base-path.mjs: where the private app lives on the same host.
interface ImportMetaEnv {
  readonly PRISM_APP_PATH: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
