import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

test("the approved brand and concept copy appears in its own section", () => {
  const header = /<header class="page-header"[^>]*>([\s\S]*?)<\/header>/.exec(html);
  const conceptSection = /<section class="concept-panel"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(header, "page header exists");
  assert.ok(conceptSection, "concept panel exists");

  for (const phrase of [
    "伝統を、新訳する。",
    "New8bitPC",
    "原典を読み解き、現代の技術で遊び直す。"
  ]) {
    assert.ok(header[1].includes(phrase), `header copy is present: ${phrase}`);
  }

  for (const phrase of [
    "コンセプトの核",
    "伝統を捨てて新しくするのではない。",
    "原典を、分かったふりをせずに読み解く。",
    "現代の技術で、もう一度動かしてみる。",
    "そして、当時にはなかった遊び方を見つける。"
  ]) {
    assert.ok(conceptSection[1].includes(phrase), `concept copy is present: ${phrase}`);
  }

  assert.equal((html.match(/MVP 1-E/g) ?? []).length, 1);
  assert.equal((html.match(/当時にはなかった遊び方/g) ?? []).length, 1);
  assert.doesNotMatch(html.replace(conceptSection[0], ""), /当時にはなかった遊び方/);
  assert.match(html, /<footer>今できること：[^<]*CLS/);
});
