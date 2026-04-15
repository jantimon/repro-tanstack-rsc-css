import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_FILE = path.resolve(__dirname, "../src/components/Card.css");

test("debug css hmr flow", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto("/");
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => ({
    color: getComputedStyle(document.querySelector(".title")!).color,
    stylesheets: [...document.querySelectorAll("link[rel='stylesheet']")].map(
      (n) => ({
        href: (n as HTMLLinkElement).href,
        precedence: (n as HTMLLinkElement).dataset.precedence,
      }),
    ),
    styleTags: [...document.querySelectorAll("style")].map((n) => ({
      text: n.textContent?.slice(0, 100),
      precedence: n.dataset.precedence,
    })),
  }));
  console.log("BEFORE:", JSON.stringify(before, null, 2));

  const original = readFileSync(CSS_FILE, "utf8");
  try {
    writeFileSync(CSS_FILE, original.replace("color: purple", "color: red"));
    await page.waitForTimeout(3000);

    const after = await page.evaluate(() => ({
      color: getComputedStyle(document.querySelector(".title")!).color,
      stylesheets: [
        ...document.querySelectorAll("link[rel='stylesheet']"),
      ].map((n) => ({
        href: (n as HTMLLinkElement).href,
        precedence: (n as HTMLLinkElement).dataset.precedence,
      })),
      styleTags: [...document.querySelectorAll("style")].map((n) => ({
        text: n.textContent?.slice(0, 100),
        precedence: n.dataset.precedence,
      })),
    }));
    console.log("AFTER:", JSON.stringify(after, null, 2));
    console.log("--- BROWSER CONSOLE LOGS ---");
    logs.forEach((l) => console.log(l));
  } finally {
    writeFileSync(CSS_FILE, original);
  }
});
