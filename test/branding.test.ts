import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  createContentSecurityPolicy,
  DEFAULT_SITE_BRANDING,
  normalizeSiteBranding,
} from "../src/branding";
import { createLandingPage } from "../src/site";

test("normalizes valid site branding", () => {
  assert.deepEqual(
    normalizeSiteBranding({
      name: " Acme Secure Transfer ",
      summary: "Private file delivery\nfor clients.",
      logoUrl: "https://cdn.example.com/brand/logo.svg",
      background: "#101820",
      foreground: "#F7F4ED",
      accent: "#FFB81C",
    }),
    {
      name: "Acme Secure Transfer",
      summary: "Private file delivery for clients.",
      logoUrl: "https://cdn.example.com/brand/logo.svg",
      background: "#101820",
      foreground: "#f7f4ed",
      accent: "#ffb81c",
    },
  );
});

test("falls back from invalid site branding", () => {
  assert.deepEqual(
    normalizeSiteBranding({
      name: "x".repeat(81),
      summary: "x".repeat(241),
      logoUrl: "http://example.com/logo.svg",
      background: "black",
      foreground: "#fff",
      accent: "#12345g",
    }),
    DEFAULT_SITE_BRANDING,
  );
});

test("escapes branding rendered into a landing page", () => {
  const html = createLandingPage({
    name: "Acme <Files> & Co",
    summary: "Deliver <safely> & quickly.",
    logoUrl: "https://cdn.example.com/logo.svg?theme=dark&version=1",
    background: "#101820",
    foreground: "#f7f4ed",
    accent: "#ffb81c",
  });

  assert.match(html, /<title>Acme &lt;Files&gt; &amp; Co - Temporary transfer<\/title>/);
  assert.match(html, /<p class="brand-summary">Deliver &lt;safely&gt; &amp; quickly\.<\/p>/);
  assert.match(
    html,
    /<img class="brand-logo" src="https:\/\/cdn\.example\.com\/logo\.svg\?theme=dark&amp;version=1" alt="">/,
  );
  assert.match(html, /--ink:#101820; --paper:#f7f4ed; --acid:#ffb81c;/);
  assert.doesNotMatch(html, /Acme <Files>/);
});

test("restricts branding images to the configured HTTPS origin", () => {
  const branding = normalizeSiteBranding({
    logoUrl: "https://cdn.example.com/brand/logo.svg?version=1",
  });
  const policy = createContentSecurityPolicy(branding);

  assert.match(policy, /img-src 'self' data: https:\/\/cdn\.example\.com;/);
  assert.doesNotMatch(policy, /brand\/logo/);
});

test("keeps default Drop landing pages unbranded", () => {
  const html = createLandingPage();

  assert.match(html, /<title>cfshare - Temporary transfer<\/title>/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/bndnsmth\/cfshare"[^>]*>Powered by cfshare<\/a>/,
  );
  assert.doesNotMatch(html, /class="brand-logo"/);
  assert.doesNotMatch(html, /class="brand-summary"/);
});
