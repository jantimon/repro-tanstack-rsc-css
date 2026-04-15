# HMR analysis progress — global CSS in RSC-only server components

Quick writeup of what I found digging into the tanstack-start RSC + global CSS HMR issue. Posting here since it's almost certainly the same class of bug you'd hit with yak once you start emitting CSS from components that live only in the `rsc` environment.

tl;dr: the bug is in `@vitejs/plugin-rsc`, not in tanstack. Two independent issues in the dev-mode CSS pipeline. Repro'd end-to-end with instrumented `console.log` in `node_modules`, verified with a two-line patch.

## Setup of the repro

- `vite 8.0.8`, `@vitejs/plugin-rsc 0.5.24`, `@vitejs/plugin-react 6.0.1`, React 19.2.5
- A `<Card />` server component (no `"use client"`) that does `import "./Card.css"`
- Two render paths:
  - direct: `createFileRoute("/")({ component: () => <Card /> })` → HMR **works**
  - indirect: `createServerFn().handler(() => renderServerComponent(<Card />))` threaded through the route loader → HMR **broken** (stale CSS until dev restart)
- Playwright test asserts `.title` color. Fails with `rgb(128,0,128)` (stale purple) when expected is `rgb(255,0,0)` (red).

## Where the render actually happens

Direct path: `Card.tsx` ends up in both the `rsc` bundle (for the Flight render) **and** the `client` bundle (because the route's `component` prop is client-evaluated and imports it). So `Card.css` is in the client module graph, Vite's standard CSS HMR kicks in, the `<link>` in the DOM gets a `?t=` appended in-place. Classic.

Indirect path: `Card.tsx` is referenced only by the server function. It lives **exclusively** in the `rsc` environment. `Card.css` never enters the client module graph. Vite's client-side CSS HMR has nothing to hook onto.

That alone would be OK — plugin-rsc does have a pipeline for this. It has an `rsc:rsc-css-export-transform` that wraps any server component whose module imports CSS so that it renders a `<Resources>` component alongside, which emits the `<link rel="stylesheet" href=... data-rsc-css-href=...>` into the RSC tree. On a CSS edit plugin-rsc fires a custom `rsc:update` hot-message, which tanstack listens for and responds to with `router.invalidate()`. Loader reruns, `renderServerComponent` reruns, new Flight stream, new tree, new `<link>` — in theory.

In practice it doesn't work, and when I instrumented the relevant bits it became clear why.

## Bug 1 — no cache-buster on CSS hrefs in the rsc env

`plugin-rsc`'s `normalizeViteImportAnalysisUrl` is what turns a module id into a URL that goes into the Flight stream (via `collectCss`):

```ts
function normalizeViteImportAnalysisUrl(environment, id) {
  let url = normalizeResolvedIdToUrl(environment, id, { id });
  if (environment.config.consumer === "client") {
    const mod = environment.moduleGraph.getModuleById(id);
    if (mod && mod.lastHMRTimestamp > 0)
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
  }
  return url;
}
```

The `rsc` environment's `consumer` is `"server"`, so the `?t=` branch is never taken. My log:

```
[DBG plugin-rsc] normalizeViteImportAnalysisUrl
  { env: 'rsc', consumer: 'server',
    id: '/.../Card.css',
    hmrTs: 1776275607854 }
```

The fresh timestamp is **sitting right there** on the module in the graph and gets thrown away. The URL that ends up in the Flight stream is the bare `/src/components/Card.css`. Browser already has that URL cached, so even if a new `<link>` pointing at it is inserted, there's no refetch.

## Bug 2 — CSS changes don't invalidate importers in the rsc env

Even if 1 were fixed, you'd still need the virtual module that generates the `<Resources>` `<link>` to re-run on a CSS change, because that's where `collectCss` is called. It's `\0virtual:vite-rsc/css?type=rsc&id=.../Card.tsx&lang.js`. The plugin's `load` hook correctly calls `this.addWatchFile(cssFile)` so Vite tracks the dep.

But `hotUpdate` in plugin-rsc for the `rsc` env, on a CSS file change, does this:

- iterate `ctx.modules`, skip anything that isn't `.js` (CSS is not)
- send `rsc:update` to the client

It does **not** invalidate `Card.tsx` or the virtual module. The runnable rsc environment keeps them cached. tanstack correctly responds to `rsc:update` and re-invokes the server function, `renderServerComponent` runs again — my log confirms this — but when it reaches into the cached `Card`, the `<Resources>` closure it renders has the old href baked in. No re-call of the virtual's `load` handler, no new `collectCss`, no new URL.

This one I verified with a second instrumentation — printing on the `virtual:vite-rsc/css?...` `load` handler. It fires exactly once, on the initial page render. Edit the CSS file, see `renderServerComponent called` in the log (loader re-ran), but **no** `rsc-css virtual load`. Cached.

## The `cssLinkPrecedence: false` wrinkle (tanstack-specific, aggravates it)

Tanstack's RSC plugin passes `cssLinkPrecedence: false` to plugin-rsc. This strips the `precedence="vite-rsc/importer-resources"` attribute from the emitted `<link>`. They do this because they want to manage stylesheet insertion themselves: they collect `data-rsc-css-href` from the decoded tree via `awaitLazyElements`, then on the client call `ReactDOM.preinit(href, { as: 'style', precedence: 'high' })` inside their `RscNodeRenderer`.

React 19 requires a `precedence` on `<link rel="stylesheet">` outside `<head>` to treat it as a managed Float resource (dedup, hoist, swap-on-update). Without it, React logs:

> Cannot render a `<link rel="stylesheet" />` outside the main document without knowing its precedence

...and refuses to manage it. So in tanstack's setup you end up with:

- one plain `<link>` from plugin-rsc's `<Resources>` — no precedence, unmanaged, stale URL
- one `<link data-precedence="high">` from tanstack's `preinit` — same stale URL

Vite's client CSS HMR does find one of them by pathname and rewrites `href` to append `?t=`, but the other is left pointing at the bare URL, and React's resource manager may reconcile changes back. The net observable symptom in the browser is: stylesheet never updates.

But — and this is the part I keep reminding myself of — **the plugin-rsc bugs are independent of `cssLinkPrecedence`.** I ran a framework-free repro (a route in plugin-rsc's own `examples/basic` fixture that renders a server component through a nested Flight stream via `renderToReadableStream` + `createFromReadableStream`). With default `cssLinkPrecedence` (truthy), the React resource machinery papers over bug 1: React sees the same href, keeps the existing managed `<link>`, Vite rewrites its href, works. Flip `cssLinkPrecedence: false` and bug 1 becomes visible again.

So: two underlying plugin-rsc bugs, one user-visible bug for tanstack users because the `cssLinkPrecedence: false` workaround removes the React-level insulation that otherwise hides bug 1.

## Minimal patch, verified to fix the playwright test

Both in `@vitejs/plugin-rsc`'s plugin source (mine was `node_modules/@vitejs/plugin-rsc/dist/plugin-*.js`):

```diff
 function normalizeViteImportAnalysisUrl(environment, id) {
   let url = normalizeResolvedIdToUrl(environment, id, { id });
-  if (environment.config.consumer === "client") {
-    const mod = environment.moduleGraph.getModuleById(id);
-    if (mod && mod.lastHMRTimestamp > 0)
-      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
-  }
+  const mod = environment.moduleGraph.getModuleById(id);
+  if (mod && mod.lastHMRTimestamp > 0)
+    url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
   return url;
 }
```

```diff
 async hotUpdate(ctx) {
+  if (isCSSRequest(ctx.file) && this.environment.name === "rsc") {
+    for (const mod of ctx.modules) {
+      for (const imp of mod.importers) {
+        this.environment.moduleGraph.invalidateModule(imp);
+      }
+    }
+  }
   if (isCSSRequest(ctx.file)) {
     if (this.environment.name === "client") return;
   }
   ...
 }
```

With both applied the playwright test flips `rgb(128,0,128) → rgb(255,0,0)` within ~3s, no full reload. My debug log on the fixed run:

```
[DBG plugin-rsc] invalidate importer /.../Card.tsx
[DBG plugin-rsc] sending rsc:update { file: '/.../Card.css' }
[DBG tanstack-rsc] renderServerComponent called
[DBG plugin-rsc] rsc-css virtual load { id: 'virtual:vite-rsc/css?...Card.tsx...' }
[DBG plugin-rsc] rsc-css result { hrefs: [ '/src/components/Card.css?t=1776276363883' ] }
```

i.e. the full chain fires on every CSS edit, a new URL hits the Flight stream, the browser fetches fresh CSS.

## Why this matters for next-yak

Yak's model puts the emitted CSS file alongside / derived from the source component, so any component that imports yak-derived CSS lands in the same situation: if that component is RSC-only (which it will be in the new Start + RSC world), you depend on plugin-rsc's rsc-env CSS pipeline for HMR. Two things to keep an eye on:

1. You'll want to make sure your generated CSS participates in plugin-rsc's module graph as a normal CSS import, not via some ad-hoc `?raw` / virtual module, otherwise neither bug 1 nor bug 2 can be fixed by an upstream plugin-rsc fix — the watch-file + importer invalidation logic is keyed on being a regular CSS module in the rsc graph.
2. Don't override `cssLinkPrecedence`. Leave React 19's Float resource machinery to insulate you from bug 1 until plugin-rsc ships the fix. If you *do* need to manage stylesheet insertion yourself (ordering, chunking), use `ReactDOM.preinit` with a `precedence` and don't rely on plugin-rsc's `<Resources>` path at all.

Happy to share the instrumented `plugin-rsc/dist/*.js` and the playwright repro if you want to reproduce locally. The writeup for the upstream plugin-rsc issue is drafted; planning to file it once I've confirmed the fix against their test suite.
