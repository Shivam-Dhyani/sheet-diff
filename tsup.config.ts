import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'bin/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  // xlsx is large and resolved from the SheetJS CDN tarball; keep it external
  // so consumers share a single copy and the bundle stays lean.
  external: ['xlsx', 'officecrypto-tool', '@formulajs/formulajs'],
});
