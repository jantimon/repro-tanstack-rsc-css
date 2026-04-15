# Global CSS HMR broken for server components rendered via `createServerFn` + `renderServerComponent`

Minimal reproduction: a global CSS file imported by a React Server Component does **not** pick up HMR updates when that component is rendered through `createServerFn` / `renderServerComponent` and passed to the router loader. A full `pnpm dev` restart is required for the change to appear.

Setup follows [the TanStack Start RSC guide](https://tanstack.com/blog/react-server-components#introducing-composite-components): `tanstackStart({ rsc: { enabled: true } })` + `rsc()` + `viteReact()` in `vite.config.ts`.

## Repro steps

```sh
pnpm install
pnpm dev
# open http://localhost:3001 — title is purple
```

1. Edit `src/components/Card.css` and change `color: purple` to `color: red`.
2. **Bug:** the page does not update — title stays purple.
3. Kill and restart `pnpm dev` — title is now red.

## Bisect: the indirection is the trigger

HMR works fine when the CSS-importing server component is rendered directly in the route component:

```tsx
// src/routes/index.tsx — works (HMR applies)
import { Card } from "../components/Card";
export const Route = createFileRoute("/")({ component: () => <Card /> });
```

HMR fails only when the component is rendered inside a server function and streamed through the loader:

```tsx
// src/routes/index.tsx — broken (stale CSS until server restart)
const getCard = createServerFn().handler(async () => {
  return renderServerComponent(<Card />);
});

export const Route = createFileRoute("/")({
  loader: async () => ({ Card: await getCard() }),
  component: () => <>{Route.useLoaderData().Card}</>,
});
```

The plugin-rsc e2e suite has a passing `css url server hmr` test (`packages/plugin-rsc/e2e/basic.test.ts:1064`) for the direct render path, so the base HMR plumbing in plugin-rsc works — the bug lives in the `createServerFn` + `renderServerComponent` + loader path.

## Where the bug lives

After tracing the HMR path end-to-end, the bug is in **`@vitejs/plugin-rsc`**, not in TanStack Start:

- TanStack correctly reacts to plugin-rsc's `rsc:update` event and calls `router.invalidate()`, which re-runs the loader and re-executes `renderServerComponent`.
- But in the indirect path, `Card.tsx` lives *only* in the `rsc` Vite environment — it is never imported by the client bundle. `Card.css` is therefore not in the client module graph, so Vite's standard client-side CSS HMR has nothing to update.
- The RSC environment is what holds the `<link rel="stylesheet" href="/src/components/Card.css">` that ends up in the DOM. On a CSS edit, plugin-rsc fires `rsc:update` and tanstack re-renders — but the RSC env re-emits the same un-cache-busted href and the cached intermediate module that produces the `<link>` is not invalidated, so the browser keeps the old stylesheet.
- In the **direct** path (`component: () => <Card />`), `Card.tsx` is pulled into the client bundle too, so `Card.css` is in the client module graph and Vite's ordinary CSS HMR applies. That's why only the indirect path is broken.

## What specifically goes wrong inside `@vitejs/plugin-rsc`

Two cooperating issues in `plugin-rsc`'s dev-mode CSS pipeline. You can verify both by adding `console.log` inside `node_modules/@vitejs/plugin-rsc/dist/plugin-*.js` (search for `normalizeViteImportAnalysisUrl` and the CSS `hotUpdate` handler) and editing `src/components/Card.css` — only the initial render logs fire; no re-render logs fire after the edit.

1. **Stale CSS URLs: no HMR cache-buster is injected for non-client envs.**

   `normalizeViteImportAnalysisUrl` gates the `?t=<HMRTimestamp>` query on `environment.config.consumer === "client"`. The `rsc` environment is `consumer: "server"`, so CSS hrefs emitted into the Flight stream never get a cache-buster — the module graph has a fresh timestamp available, but it's discarded. The browser sees the exact same URL as before the edit, so even if a new `<link>` is inserted, the stylesheet is taken from the HTTP cache.

   Minimal fix:

   ```diff
    function normalizeViteImportAnalysisUrl(environment, id) {
      let url = normalizeResolvedIdToUrl(environment, id, { id })
   -  if (environment.config.consumer === "client") {
   -    const mod = environment.moduleGraph.getModuleById(id)
   -    if (mod && mod.lastHMRTimestamp > 0)
   -      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
   -  }
   +  const mod = environment.moduleGraph.getModuleById(id)
   +  if (mod && mod.lastHMRTimestamp > 0)
   +    url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
      return url
    }
   ```

2. **Stale virtual modules: importers of a changed CSS file aren't invalidated in the `rsc` env.**

   When `Card.css` changes, plugin-rsc correctly sends `rsc:update` (which TanStack picks up and calls `router.invalidate()` on), but it does **not** invalidate `Card.tsx` or the derived `\0virtual:vite-rsc/css?type=rsc&id=…Card.tsx` module in the RSC module graph. That virtual module is what emits the `<link rel="stylesheet">` element into the Flight stream. It stays cached in the runnable RSC environment, so on the re-render after `router.invalidate()`, the server function re-runs but re-uses the cached virtual and emits the same stale URL.

   Minimal fix:

   ```diff
    async hotUpdate(ctx) {
   +  if (isCSSRequest(ctx.file) && this.environment.name === "rsc") {
   +    for (const mod of ctx.modules) {
   +      for (const imp of mod.importers) {
   +        this.environment.moduleGraph.invalidateModule(imp)
   +      }
   +    }
   +  }
      if (isCSSRequest(ctx.file)) {
        if (this.environment.name === "client") return
      }
      …
    }
   ```

With both patches applied locally (inside `node_modules/@vitejs/plugin-rsc/dist/plugin-*.js`), the Playwright test in this repo flips from `rgb(128, 0, 128)` (stale purple) to `rgb(255, 0, 0)` (red) within a few seconds — no full reload, no dev-server restart. These patches are for verification only; the fix belongs upstream in `@vitejs/plugin-rsc`.

## Automated failing test

A Playwright test reproduces the bug headlessly:

```sh
pnpm exec playwright install chromium  # one-time
pnpm test:e2e
```

It loads `/`, asserts the title is purple, rewrites `Card.css` to red, and asserts the new color without reloading. Current output:

```
Expected: "rgb(255, 0, 0)"    (red)
Received: "rgb(128, 0, 128)"  (purple — stale)
```

The test resets `Card.css` in a `finally` so re-running is idempotent.

## Versions

- `@tanstack/react-router`: 1.168.21
- `@tanstack/react-start`: 1.167.39
- `@vitejs/plugin-react`: 6.0.1
- `@vitejs/plugin-rsc`: 0.5.24
- `vite`: 8.0.8
- `react` / `react-dom`: 19.2.5
