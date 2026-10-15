# Edge entry point

`edge.ts` is the deployed Worker module (`wrangler.toml` `main`). It is the
only file that imports `cloudflare:workers` and `@cloudflare/sandbox`, so it
is excluded from `tsconfig.json` and checked with:

    node node_modules/typescript/bin/tsc --noEmit -p tsconfig.edge.json

`cloudflare-modules.d.ts` declares the few runtime APIs it uses because the
real type packages are not installed here. Replace it with the generated
types (`npx wrangler types`) and the published `@cloudflare/sandbox` types
once they are installed; nothing outside `edge.ts` depends on those shapes.

## Deploying

`@cloudflare/sandbox` is not yet in `package.json` (it can only be added
together with a refreshed lockfile, which needs network). `npm run deploy`
runs `scripts/deploy.mjs`, which installs it with `npm install --no-save` when
it is missing (set `CF_SANDBOX_VERSION` to match the image tag in
`ts/Dockerfile`), then runs `wrangler deploy`. Without the package, wrangler's
bundler fails with `Could not resolve "@cloudflare/sandbox"`.
