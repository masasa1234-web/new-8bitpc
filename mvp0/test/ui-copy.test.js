import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../app/app.js", import.meta.url), "utf8");

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

  const footer = /<footer>([^<]*)<\/footer>/.exec(html);
  assert.ok(footer, "supported-scope summary exists");
  for (const phrase of [
    "文字列PRINT",
    "数値代入・式（INT／RND／RANDOMIZE）",
    "数値INPUT",
    "制御命令（GOTO／REM／END）",
    "IFのTHEN後は、行番号・単一PRINT・単一代入",
    "細かな書式・制限はREADMEを参照"
  ]) {
    assert.ok(footer[1].includes(phrase), `supported-scope summary includes: ${phrase}`);
  }

  assert.match(html, /id="overall-status">解析状態：通常<\/span>/);
  assert.match(html, /id="analysis-state-help">未解釈・誤りの行は実行時にスキップされます。これらは直ちに実行エラーや実行停止を意味しませんが、停止ポリシーによる確認の対象になる場合があります。<\/p>/);
  assert.match(html, /停止条件に達したため、続行するか終了するか確認しています。実行エラーではありません。/);
  assert.match(html, /id="execution-log-empty" class="empty-state">実行ログはこの実行中の記録です。現在、表示する項目はありません。<\/p>/);
});

test("execution-log empty-state copy follows log and stop-policy display behavior", () => {
  assert.match(appJs, /executionLogEmpty\.hidden = true;/);
  assert.equal((appJs.match(/executionLogEmpty\.hidden = false;/g) ?? []).length, 2);
  assert.match(appJs, /PRINT出力もINPUT待機もありません/);
  assert.match(appJs, /PRINT出力もINPUT待機もない/);
});
