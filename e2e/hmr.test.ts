import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_FILE = path.resolve(__dirname, "../src/components/Card.css");

function createEditor(file: string) {
  const original = readFileSync(file, "utf8");
  return {
    edit(transform: (s: string) => string) {
      writeFileSync(file, transform(original));
    },
    reset() {
      writeFileSync(file, original);
    },
  };
}

test("global css hmr on server component rendered via createServerFn", async ({
  page,
}) => {
  await page.goto("/");

  // baseline: purple
  await expect(page.locator(".title")).toHaveCSS("color", "rgb(128, 0, 128)");

  const editor = createEditor(CSS_FILE);
  try {
    editor.edit((s) => s.replace("color: purple", "color: red"));

    // expected: HMR applies the new color without a full reload
    await expect(page.locator(".title")).toHaveCSS(
      "color",
      "rgb(255, 0, 0)",
    );
  } finally {
    editor.reset();
  }
});
