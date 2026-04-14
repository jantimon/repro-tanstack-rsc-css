# CSS Modules not loaded in RSC routes

Minimal reproduction for CSS Module styles not being applied in TanStack Start when using `renderServerComponent` with `@vitejs/plugin-rsc`.

Setup follows [the docs](https://tanstack.com/start/latest/docs/framework/react/guide/server-components#1-install-the-vite-rsc-plugin) exactly. A single route renders a server component that imports a CSS module:

```css
/* Card.module.css */
.card {
  max-width: 600px;
  margin: 40px auto;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-family: system-ui, sans-serif;
}

.title {
  color: #e85d04;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 2rem;
}
```

## What happens

CSS module class names get hashed and applied to elements correctly (`_card_w83pp_1`, `_title_w83pp_10`), but the actual CSS never makes it to the browser. The page renders completely unstyled in both dev and production:

![dev](screenshot-dev.png)
![production](screenshot-production.png)

**Dev mode:** the SSR html includes a `<link rel="stylesheet" href="/@tanstack-start/styles.css?routes=...">` but that endpoint returns an empty response (`Content-Length: 0`):

```
$ curl -sv "http://localhost:3000/@tanstack-start/styles.css?routes=__root__%2C%2F"
< HTTP/1.1 200 OK
< Content-Type: text/css
< Content-Length: 0
```

**Production build (`pnpm build && pnpm preview`):** the CSS file is actually built with the correct content at `dist/client/assets/routes-*.css`, but no `<link rel="stylesheet">` tag is emitted in the HTML at all. So the file exists but nothing references it.

## Reproduce

```sh
pnpm install
pnpm dev        # open http://localhost:3000 — unstyled
pnpm build && pnpm preview  # open http://localhost:4173 — also unstyled
```

### Versions

- `@tanstack/react-start`: 1.167.39
- `@vitejs/plugin-react`: 6.0.1
- `@vitejs/plugin-rsc`: 0.5.24
- `vite`: 8.0.8
- `react`: 19.2.4
