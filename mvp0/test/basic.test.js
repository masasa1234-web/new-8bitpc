import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceExecution,
  analyzeProgram,
  createExecutionState,
  RowStatus
} from "../src/basic.js";
import {
  commitPage,
  completeProgram,
  correctSourceLine,
  createProgramSession,
  getProgramSignal,
  replacePage,
  updateDraft
} from "../src/program-session.js";

test("the two-line sample is understood and executes in BASIC line order", () => {
  const analysis = analyzeProgram('10 PRINT "HELLO"\n20 GOTO 10');
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20]);

  let state = createExecutionState();
  const first = advanceExecution(analysis, state);
  state = first.state;
  assert.equal(first.event.type, "print");
  assert.equal(first.event.value, "HELLO");
  const second = advanceExecution(analysis, state);
  assert.equal(second.event.type, "goto");
  assert.equal(second.event.targetLine, 10);
  assert.equal(second.state.position, 0);
});

test("input order is preserved while execution order is numeric", () => {
  const raw = '20 GOTO 10\n10 PRINT "HELLO"';
  const analysis = analyzeProgram(raw);
  assert.equal(analysis.raw, raw);
  assert.deepEqual(analysis.rows.map(row => row.sourceText), [
    "20 GOTO 10",
    '10 PRINT "HELLO"'
  ]);
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20]);
  assert.equal(advanceExecution(analysis, createExecutionState()).event.row.lineNumber, 10);
});

test("unknown commands are reported and count as skipped execution steps", () => {
  const analysis = analyzeProgram('10 PRINT "HELLO"\n20 GOTO 10\n30 FOO');
  assert.equal(analysis.rows[2].status, RowStatus.uninterpreted);
  assert.equal(analysis.counts.uninterpreted, 1);
  let state = { position: 2, steps: 2, done: false };
  const result = advanceExecution(analysis, state);
  assert.equal(result.event.type, "skipped");
  assert.equal(result.event.row.sourceText, "30 FOO");
  assert.equal(result.state.steps, 3);
});

test("missing GOTO targets wait until completion, then become errors", () => {
  const raw = "10 GOTO 100";
  assert.equal(analyzeProgram(raw).rows[0].status, RowStatus.referenceWaiting);
  const completed = analyzeProgram(raw, { complete: true });
  assert.equal(completed.rows[0].status, RowStatus.error);
  assert.match(completed.rows[0].reasons.join(" "), /ジャンプ先の行番号100がありません/);
});

test("duplicate line numbers identify both input positions and are shown as skipped", () => {
  const analysis = analyzeProgram('10 PRINT "ONE"\n10 PRINT "TWO"\n20 GOTO 10');
  assert.deepEqual(analysis.rows.slice(0, 2).map(row => row.status), [
    RowStatus.error,
    RowStatus.error
  ]);
  assert.equal(analysis.rows[0].reasons.join(" ").includes("入力行1、入力行2"), true);
  assert.equal(analysis.rows[1].reasons.join(" ").includes("入力行1、入力行2"), true);
  assert.equal(analysis.rows[2].status, RowStatus.error);

  const first = advanceExecution(analysis, createExecutionState());
  assert.equal(first.event.type, "skipped");
  assert.equal(first.event.label, "重複のため実行対象外");
  assert.equal(first.event.row.sourceLine, 1);
  assert.equal(first.event.step, 1);
  const second = advanceExecution(analysis, first.state);
  assert.equal(second.event.label, "重複のため実行対象外");
  assert.equal(second.event.row.sourceLine, 2);
  assert.equal(second.event.step, 2);
});

test("analysis is deterministic and does not change the source", () => {
  const raw = '20 goto 10\n10 print "Hello"\r\n30 FOO';
  const first = analyzeProgram(raw);
  const second = analyzeProgram(raw);
  assert.deepEqual(first, second);
  assert.equal(first.raw, raw);
});

test("malformed line numbers are errors tied to their source positions", () => {
  const analysis = analyzeProgram('x PRINT "HELLO"\n10');
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.error,
    RowStatus.error
  ]);
  assert.match(analysis.rows[0].reasons.join(" "), /行番号が不正/);
  assert.equal(analysis.rows[0].sourceLine, 1);
});

test("unambiguous compact commands are understood without changing source", () => {
  const raw = '10PRINT"A"\n20GOTO10\n30PRINTA';
  const analysis = analyzeProgram(raw);
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.uninterpreted
  ]);
  assert.deepEqual(analysis.rows.map(row => row.sourceText), [
    '10PRINT"A"',
    "20GOTO10",
    "30PRINTA"
  ]);
  assert.equal(analysis.raw, raw);
});

test("committing a later page resolves references and completion only finalizes remaining ones", () => {
  let session = createProgramSession("10 GOTO 100\n20 GOTO 200");
  session = commitPage(session);
  assert.equal(session.analysis.counts.referenceWaiting, 2);
  assert.equal(session.analysis.pageCounts[0].referenceWaiting, 2);

  session = updateDraft(session, '100 PRINT "FOUND"');
  session = commitPage(session);
  assert.deepEqual(session.analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.referenceWaiting,
    RowStatus.understood
  ]);
  assert.deepEqual(session.analysis.pageCounts.map(page => page.referenceWaiting), [1, 0]);

  session = completeProgram(session);
  assert.deepEqual(session.analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.error,
    RowStatus.understood
  ]);
  assert.equal(session.analysis.counts.referenceWaiting, 0);
  assert.equal(session.analysis.counts.errors, 1);
});

test("editing one line preserves other raw text and keeps an independent temporary history", () => {
  const original = '10 PRINT "BAD"\r\n20 GOTO 10';
  let session = commitPage(createProgramSession(original));
  const beforeAnalysis = session.analysis;
  session = correctSourceLine(session, 1, 1, '10 PRINT "GOOD"', "2026-11-17T00:00:00.000Z");

  assert.equal(session.pages[0].raw, '10 PRINT "GOOD"\r\n20 GOTO 10');
  assert.deepEqual(session.analysis.rows.map(row => row.sourceText), [
    '10 PRINT "GOOD"',
    "20 GOTO 10"
  ]);
  assert.equal(beforeAnalysis.rawPages[0], original);
  assert.deepEqual(session.correctionHistory, [{
    timestamp: "2026-11-17T00:00:00.000Z",
    pageNumber: 1,
    pageLine: 1,
    before: '10 PRINT "BAD"',
    after: '10 PRINT "GOOD"'
  }]);

  const unchanged = correctSourceLine(session, 1, 1, '10 PRINT "GOOD"', "later");
  assert.equal(unchanged, session);
});

test("completion commits the current draft and empty delimiters do not create pages", () => {
  const empty = createProgramSession();
  assert.equal(commitPage(empty), empty);
  const complete = completeProgram(createProgramSession("10 GOTO 999"));
  assert.equal(complete.pages.length, 1);
  assert.equal(complete.analysis.rows[0].status, RowStatus.error);
  assert.equal(complete.analysis.rawPages[0], "10 GOTO 999");
});

test("the border signal is derived from current issue counts", () => {
  const normal = analyzeProgram('10 PRINT "A"');
  const attention = analyzeProgram("10 GOTO 99");
  const warning = analyzeProgram("bad");
  assert.deepEqual(getProgramSignal(normal), { state: "normal", label: "通常" });
  assert.deepEqual(getProgramSignal(attention), { state: "attention", label: "注意" });
  assert.deepEqual(getProgramSignal(warning), { state: "warning", label: "警告" });
});

test("editing a committed Raw page replaces it in place, reanalyzes, and records line changes", () => {
  let session = createProgramSession("10 PRINT \"FIRST\"");
  session = commitPage(session);
  session = updateDraft(session, "90 PRINT \"NEXT PAGE\"");
  session = replacePage(
    session,
    1,
    '10PRINT"UPDATED"\n20 GOTO 10',
    "2026-11-17T01:00:00.000Z"
  );

  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0].pageNumber, 1);
  assert.equal(session.pages[0].raw, '10PRINT"UPDATED"\n20 GOTO 10');
  assert.equal(session.draft, "90 PRINT \"NEXT PAGE\"");
  assert.deepEqual(session.analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.deepEqual(session.correctionHistory, [{
    timestamp: "2026-11-17T01:00:00.000Z",
    pageNumber: 1,
    pageLine: 1,
    before: '10 PRINT "FIRST"',
    after: '10PRINT"UPDATED"'
  }, {
    timestamp: "2026-11-17T01:00:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: "",
    after: "20 GOTO 10"
  }]);

  const sameRaw = replacePage(session, 1, session.pages[0].raw, "later");
  assert.deepEqual(sameRaw.correctionHistory, session.correctionHistory);
});

test("editing one line of a two-line page preserves the other line and exact Raw text", () => {
  const raw = '10 PRINT "AAA"\n20 PRINT "BBB"';
  let session = commitPage(createProgramSession(raw));
  session = replacePage(session, 1, '10 PRINT "AAA"\n20 PRINT "CCC"', "2026-11-17T01:30:00.000Z");

  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0].raw, '10 PRINT "AAA"\n20 PRINT "CCC"');
  assert.deepEqual(session.analysis.rows.map(row => row.sourceText), [
    '10 PRINT "AAA"',
    '20 PRINT "CCC"'
  ]);
  assert.deepEqual(session.correctionHistory, [{
    timestamp: "2026-11-17T01:30:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: '20 PRINT "BBB"',
    after: '20 PRINT "CCC"'
  }]);
});

test("page edit history records inserted or deleted lines without marking shifted unchanged lines", () => {
  let session = commitPage(createProgramSession("10 PRINT \"A\"\n20 PRINT \"B\"\n30 PRINT \"C\""));
  session = replacePage(
    session,
    1,
    '10 PRINT "A"\n30 PRINT "C"',
    "2026-11-17T02:00:00.000Z"
  );
  assert.deepEqual(session.correctionHistory, [{
    timestamp: "2026-11-17T02:00:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: '20 PRINT "B"',
    after: ""
  }]);

  session = replacePage(
    session,
    1,
    '10 PRINT "A"\n20 PRINT "NEW"\n30 PRINT "C"',
    "2026-11-17T02:01:00.000Z"
  );
  assert.deepEqual(session.correctionHistory[1], {
    timestamp: "2026-11-17T02:01:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: "",
    after: '20 PRINT "NEW"'
  });
  assert.equal(session.correctionHistory.length, 2);
});
