import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceExecution,
  analyzeProgram,
  createExecutionState,
  parseInputNumber,
  RowStatus
} from "../src/basic.js";
import {
  commitPage,
  completeProgram,
  correctSourceLine,
  createProgramSession,
  getDelimiterAttention,
  getProgramSignal,
  replacePage,
  restoreProgramSession,
  updateDraft
} from "../src/program-session.js";
import {
  createProjectData,
  parseProject,
  serializeProject,
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION
} from "../src/project-store.js";
import {
  continueAfterStop,
  createStopPolicyState,
  DEFAULT_STOP_SETTINGS,
  observeExecutionStep
} from "../src/stop-policy.js";

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

test("REM is preserved as a no-op step and execution continues", () => {
  const raw = '10 REM TITLE SCREEN\n20 PRINT "HELLO"';
  const analysis = analyzeProgram(raw);
  assert.equal(analysis.raw, raw);
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.deepEqual(analysis.rows[0].instruction, { type: "rem" });
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20]);

  const comment = advanceExecution(analysis, createExecutionState());
  assert.equal(comment.event.type, "rem");
  assert.equal(comment.event.step, 1);
  assert.equal(comment.state.position, 1);
  assert.equal(comment.state.steps, 1);

  const print = advanceExecution(analysis, comment.state);
  assert.equal(print.event.type, "print");
  assert.equal(print.event.value, "HELLO");
  assert.equal(print.event.step, 2);
});

test("GOTO can target a REM row and continue with deterministic step counting", () => {
  const analysis = analyzeProgram(
    '10 GOTO 30\n20 PRINT "SKIPPED"\n30 REM COMMENT\n40 PRINT "DONE"'
  );
  let state = createExecutionState();
  const events = [];
  for (let index = 0; index < 3; index += 1) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    events.push(result.event);
  }

  assert.deepEqual(events.map(event => [event.type, event.row.lineNumber, event.step]), [
    ["goto", 10, 1],
    ["rem", 30, 2],
    ["print", 40, 3]
  ]);
  assert.equal(events[2].value, "DONE");
});

test("END stops execution at its row and does not execute later lines", () => {
  const analysis = analyzeProgram('10 PRINT "BEFORE"\n20 END\n30 PRINT "AFTER"');
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20, 30]);

  const before = advanceExecution(analysis, createExecutionState());
  assert.equal(before.event.type, "print");
  assert.equal(before.event.value, "BEFORE");
  assert.equal(before.state.done, false);

  const end = advanceExecution(analysis, before.state);
  assert.equal(end.event.type, "end");
  assert.equal(end.event.row.lineNumber, 20);
  assert.equal(end.state.done, true);
  assert.equal(end.state.steps, 2);

  const after = advanceExecution(analysis, end.state);
  assert.equal(after.event, null);
  assert.equal(after.state.done, true);
  assert.equal(after.state.steps, 2);
});

test("IF true jumps to THEN line and false continues to the next row", () => {
  const analysis = analyzeProgram(
    '10 A=1\n20 IF A=1 THEN 100\n30 PRINT "NG"\n40 END\n100 PRINT "OK"\n110 END'
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood
  ]);

  let state = createExecutionState();
  const trueEvents = [];
  for (let index = 0; index < 4; index += 1) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    trueEvents.push(result.event);
  }
  assert.equal(trueEvents[0].type, "assign");
  assert.equal(trueEvents[1].type, "if");
  assert.equal(trueEvents[1].result, true);
  assert.equal(trueEvents[1].targetLine, 100);
  assert.equal(trueEvents[2].type, "print");
  assert.equal(trueEvents[2].value, "OK");
  assert.equal(trueEvents[3].type, "end");

  const falseAnalysis = analyzeProgram(
    '10 A=0\n20 IF A=1 THEN 100\n30 PRINT "NEXT"\n100 PRINT "SKIPPED"'
  );
  state = createExecutionState();
  const falseEvents = [];
  for (let index = 0; index < 4; index += 1) {
    const result = advanceExecution(falseAnalysis, state);
    state = result.state;
    if (result.event) falseEvents.push(result.event);
  }
  assert.equal(falseEvents[1].type, "if");
  assert.equal(falseEvents[1].result, false);
  assert.equal(falseEvents[1].nextLine, null);
  assert.equal(falseEvents[2].value, "NEXT");
});

test("IF unresolved targets wait and become errors on completion", () => {
  const raw = "10 IF A=1 THEN 999";
  const waiting = analyzeProgram(raw);
  assert.equal(waiting.rows[0].status, RowStatus.referenceWaiting);

  let state = createExecutionState();
  const result = advanceExecution(waiting, state);
  assert.equal(result.event.type, "skipped");
  assert.equal(result.event.row.status, RowStatus.referenceWaiting);
  assert.equal(result.event.label.includes("参照待ち"), true);
  assert.equal(result.state.done, false);
  assert.equal(result.state.position, 1);

  const completed = analyzeProgram(raw, { complete: true });
  assert.equal(completed.rows[0].status, RowStatus.error);
  assert.match(completed.rows[0].reasons.join(" "), /行番号999がありません/);
});

test("IF runtime errors stop on undefined variables and division by zero", () => {
  const undefinedIf = analyzeProgram("10 IF Y=1 THEN 100\n100 END");
  let result = advanceExecution(undefinedIf, createExecutionState());
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /変数Yは未定義/);
  assert.equal(result.state.done, true);

  const divideByZero = analyzeProgram("10 IF 1/0 THEN 100\n100 END");
  result = advanceExecution(divideByZero, createExecutionState());
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /0で除算/);
  assert.equal(result.state.done, true);
});

test("INPUT waits for a numeric value and resumes after one decision", () => {
  const analysis = analyzeProgram('10 INPUT A\n20 PRINT "OK"\n30 END');
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood
  ]);

  const waiting = advanceExecution(analysis, createExecutionState());
  assert.equal(waiting.event.type, "input-wait");
  assert.equal(waiting.event.variable, "A");
  assert.equal(waiting.event.prompt, null);
  assert.equal(waiting.state.position, 1);
  assert.equal(waiting.state.steps, 1);
  assert.deepEqual(waiting.state.variables, {});

  const variables = { ...(waiting.state.variables), A: 123 };
  const resumed = advanceExecution(analysis, { ...waiting.state, variables });
  assert.equal(resumed.event.type, "print");
  assert.equal(resumed.event.value, "OK");
  assert.equal(resumed.state.variables.A, 123);
});

test("prompted INPUT preserves the prompt and target variable", () => {
  const analysis = analyzeProgram('10 INPUT "予想";A\n20 END');
  assert.equal(analysis.rows[0].status, RowStatus.understood);
  const waiting = advanceExecution(analysis, createExecutionState());
  assert.equal(waiting.event.type, "input-wait");
  assert.equal(waiting.event.variable, "A");
  assert.equal(waiting.event.prompt, "予想");
});

test("unsupported INPUT forms remain uninterpreted", () => {
  const analysis = analyzeProgram(
    '10 INPUT A$\n20 INPUT A,B\n30 INPUT #1,A\n40 LINE INPUT A'
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted
  ]);
});

test("INPUT numeric validation accepts decimal and negative values only", () => {
  assert.equal(parseInputNumber("123"), 123);
  assert.equal(parseInputNumber("-5"), -5);
  assert.equal(parseInputNumber("1.5"), 1.5);
  assert.equal(parseInputNumber(""), null);
  assert.equal(parseInputNumber("ABC"), null);
  assert.equal(parseInputNumber("12A"), null);
  assert.equal(parseInputNumber("Infinity"), null);
  assert.equal(parseInputNumber("1e3"), null);
  assert.equal(parseInputNumber("１．５"), null);
});

test("the same INPUT attempts produce the same execution trace on rerun", () => {
  const analysis = analyzeProgram(
    "10 INPUT A\n20 INPUT B\n30 INPUT C\n40 LET D=A*B+C\n50 END"
  );
  const attempts = [["5"], ["7"], ["bad", "9"]];

  const execute = () => {
    let state = createExecutionState();
    let inputIndex = 0;
    const trace = [];

    while (!state.done) {
      const result = advanceExecution(analysis, state);
      state = result.state;
      if (!result.event) break;
      if (result.event.type !== "input-wait") {
        trace.push({
          type: result.event.type,
          variable: result.event.variable,
          value: result.event.value,
          step: result.event.step
        });
        continue;
      }

      trace.push({
        type: result.event.type,
        variable: result.event.variable,
        step: result.event.step
      });
      for (const text of attempts[inputIndex++]) {
        const value = parseInputNumber(text);
        if (value === null) {
          trace.push({ type: "input-invalid" });
          continue;
        }
        state = {
          ...state,
          variables: { ...state.variables, [result.event.variable]: value }
        };
        trace.push({
          type: "input-complete",
          variable: result.event.variable,
          value,
          step: result.event.step
        });
        break;
      }
    }

    return trace;
  };

  const firstRun = execute();
  assert.deepEqual(execute(), firstRun);
  assert.equal(firstRun.filter(event => event.type === "input-invalid").length, 1);
  assert.ok(firstRun.some(event =>
    event.type === "assign" && event.variable === "D" && event.value === 44
  ));
});

test("unsupported IF THEN forms remain uninterpreted", () => {
  const raw =
    '10 IF A=1 THEN PRINT "OK"\n' +
    "20 IF A=1 THEN A=A+1\n" +
    "30 IF A=1 THEN GOTO 100\n" +
    "40 IF A=1 THEN REM TEST\n" +
    "50 IF A=1 THEN 100 ELSE 200\n" +
    '60 IF A$="X" THEN 100\n' +
    '70 IF A=1 THEN 100:PRINT "X"';
  const analysis = analyzeProgram(raw);
  assert.ok(analysis.rows.every(row => row.status === RowStatus.uninterpreted));
  assert.ok(analysis.rows.every(row => row.reasons.join(" ").includes("IF")));
});

test("IF does not change GOTO or assignment behavior", () => {
  const analysis = analyzeProgram(
    '10 A=2\n20 GOTO 40\n30 A=A+1\n40 IF A=2 THEN 60\n50 PRINT "NO"\n60 PRINT "YES"\n70 END'
  );
  let state = createExecutionState();
  const events = [];
  for (let index = 0; index < 6; index += 1) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    if (result.event) events.push(result.event);
  }
  assert.equal(events.some(event => event.type === "assign"), true);
  assert.equal(events.some(event => event.type === "goto"), true);
  assert.equal(events.some(event => event.type === "if"), true);
  assert.equal(events.some(event => event.type === "print" && event.value === "YES"), true);
  assert.equal(events.some(event => event.type === "print" && event.value === "NO"), false);
});

test("LET and bare assignment share arithmetic expression evaluation", () => {
  const analysis = analyzeProgram(
    '10 LET A=-5\n20 b=A*-2\n30 C=(10-3)+(b/2)\n40 D=C>=10'
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood,
    RowStatus.understood
  ]);

  let state = createExecutionState();
  const events = [];
  for (let index = 0; index < 4; index += 1) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    events.push(result.event);
  }

  assert.deepEqual(events.map(event => [event.type, event.variable, event.value]), [
    ["assign", "A", -5],
    ["assign", "B", 10],
    ["assign", "C", 12],
    ["assign", "D", -1]
  ]);
  assert.deepEqual(state.variables, { A: -5, B: 10, C: 12, D: -1 });
  assert.equal(state.steps, 4);
});

test("expression operators follow arithmetic and comparison rules", () => {
  const analysis = analyzeProgram(
    '10 A=1+2*3\n20 B=(1+2)*3\n30 C=10/4\n40 D=5<>5\n50 E=5>=5'
  );
  let state = createExecutionState();
  const values = {};
  for (let index = 0; index < 5; index += 1) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    values[result.event.variable] = result.event.value;
  }
  assert.deepEqual(values, { A: 7, B: 9, C: 2.5, D: 0, E: -1 });
});

test("undefined variables and division by zero are runtime errors", () => {
  const undefinedVariable = analyzeProgram("10 LET A=B+1");
  let state = createExecutionState();
  let result = advanceExecution(undefinedVariable, state);
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /変数Bは未定義/);
  assert.deepEqual(result.state.variables, {});

  state = result.state;
  result = advanceExecution(undefinedVariable, state);
  assert.equal(result.event, null);
  assert.equal(result.state.done, true);

  const divideByZero = analyzeProgram("10 LET A=1/0");
  result = advanceExecution(divideByZero, createExecutionState());
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /0で除算/);
  assert.deepEqual(result.state.variables, {});
});

test("malformed assignment expressions and LET syntax are errors", () => {
  const analysis = analyzeProgram("10 LET A=1+\n20 LET\n30 A=\n40 LET A=1");
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.error,
    RowStatus.error,
    RowStatus.error,
    RowStatus.understood
  ]);
  assert.match(analysis.rows[0].reasons.join(" "), /代入式の書式/);
  assert.match(analysis.rows[1].reasons.join(" "), /LETの代入先または式/);
});

test("expression support does not reinterpret PRINT or out-of-scope commands", () => {
  const analysis = analyzeProgram(
    '10 PRINT "A+B"\n20 PRINT A+1\n30 INPUT A\n40 FOO'
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.uninterpreted,
    RowStatus.understood,
    RowStatus.uninterpreted
  ]);
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
    after: '10 PRINT "GOOD"',
    changedBy: "human"
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

test("delimiter attention requires five rows with a majority uninterpreted, except when all rows are uninterpreted", () => {
  const getAttention = raw => {
    const session = commitPage(createProgramSession(raw));
    return getDelimiterAttention(session.analysis, 1);
  };

  assert.deepEqual(getAttention("10 FOO"), {
    pageNumber: 1,
    total: 1,
    uninterpreted: 1
  });
  assert.deepEqual(getAttention("10 FOO\n20 BAR\n30 BAZ\n40 QUX"), {
    pageNumber: 1,
    total: 4,
    uninterpreted: 4
  });
  assert.deepEqual(getAttention("10 FOO\n20 BAR\n30 BAZ\n40 QUX\n50 XYZ"), {
    pageNumber: 1,
    total: 5,
    uninterpreted: 5
  });
  assert.deepEqual(getAttention('10 FOO\n20 FOO\n30 FOO\n40 FOO\n50 PRINT "OK"'), {
    pageNumber: 1,
    total: 5,
    uninterpreted: 4
  });
  assert.deepEqual(getAttention('10 FOO\n20 FOO\n30 FOO\n40 PRINT "OK"\n50 PRINT "OK"'), {
    pageNumber: 1,
    total: 5,
    uninterpreted: 3
  });
  assert.equal(getAttention('10 FOO\n20 FOO\n30 PRINT "OK"\n40 PRINT "OK"\n50 PRINT "OK"'), null);
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
    after: '10PRINT"UPDATED"',
    changedBy: "human"
  }, {
    timestamp: "2026-11-17T01:00:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: "",
    after: "20 GOTO 10",
    changedBy: "human"
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
    after: '20 PRINT "CCC"',
    changedBy: "human"
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
    after: "",
    changedBy: "human"
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
    after: '20 PRINT "NEW"',
    changedBy: "human"
  });
  assert.equal(session.correctionHistory.length, 2);
});

test("project JSON round-trips exact Raw line endings and history without derived display data", () => {
  let session = commitPage(createProgramSession('10PRINT"A"\r\n20 PRINT "B"'));
  session = correctSourceLine(session, 1, 2, '20 PRINT "日本語"', "2026-11-18T00:00:00.000Z");
  session = updateDraft(session, '90 PRINT "DRAFT"\r\n');
  const json = serializeProject(session, "2026-11-18T00:01:00.000Z");
  const parsedData = JSON.parse(json);
  const restored = parseProject(json);

  assert.equal(parsedData.format, PROJECT_FORMAT);
  assert.equal(parsedData.formatVersion, PROJECT_FORMAT_VERSION);
  assert.equal(parsedData.session.pages[0].raw, '10PRINT"A"\r\n20 PRINT "日本語"');
  assert.equal(parsedData.session.draft, '90 PRINT "DRAFT"\r\n');
  assert.equal(parsedData.session.correctionHistory[0].changedBy, "human");
  assert.equal("analysis" in parsedData.session, false);
  assert.equal("counts" in parsedData.session, false);
  assert.equal("borderColor" in parsedData.session, false);
  assert.equal(restored.session.pages[0].raw, '10PRINT"A"\r\n20 PRINT "日本語"');
  assert.equal(restored.session.draft, '90 PRINT "DRAFT"\r\n');
  assert.deepEqual(restored.session.correctionHistory, [{
    timestamp: "2026-11-18T00:00:00.000Z",
    pageNumber: 1,
    pageLine: 2,
    before: '20 PRINT "B"',
    after: '20 PRINT "日本語"',
    changedBy: "human"
  }]);

  const normalizedFromTextarea = restoreProgramSession({
    pages: [{ pageNumber: 1, raw: '10 PRINT "A"\r\n20 PRINT "B"' }]
  });
  const editedInTextarea = replacePage(
    normalizedFromTextarea,
    1,
    '10 PRINT "A"\n20 PRINT "C"',
    "2026-11-18T00:02:00.000Z"
  );
  assert.equal(editedInTextarea.pages[0].raw, '10 PRINT "A"\r\n20 PRINT "C"');
  assert.equal(editedInTextarea.correctionHistory.length, 1);
  assert.equal(editedInTextarea.correctionHistory[0].pageLine, 2);
});

test("project JSON retains approved-AI change source without logging initial input", () => {
  const session = restoreProgramSession({
    pages: [{ pageNumber: 1, raw: '10 PRINT "A"' }],
    correctionHistory: [{
      timestamp: "2026-11-18T00:03:00.000Z",
      pageNumber: 1,
      pageLine: 1,
      before: '10 PRINT "OLD"',
      after: '10 PRINT "A"',
      changedBy: "ai(承認つき)"
    }]
  });
  const restored = parseProject(serializeProject(session)).session;
  assert.equal(restored.correctionHistory[0].changedBy, "ai(承認つき)");
  assert.equal(createProgramSession('10 PRINT "FIRST"').correctionHistory.length, 0);
});

test("JSON import rejects unsupported project versions", () => {
  const session = createProgramSession("10 PRINT \"A\"");
  const data = createProjectData(session);
  data.formatVersion = PROJECT_FORMAT_VERSION + 1;
  assert.throws(() => parseProject(JSON.stringify(data)), /未対応のデータ形式バージョン/);
});

function runWithStopPolicy(analysis, maximumSteps, settings = DEFAULT_STOP_SETTINGS) {
  let execution = createExecutionState();
  let policy = createStopPolicyState(settings);
  for (let index = 0; index < maximumSteps; index += 1) {
    const advanced = advanceExecution(analysis, execution);
    execution = advanced.state;
    if (!advanced.event) return { policy, stop: null };
    const observed = observeExecutionStep(policy, advanced.event, analysis.complete, settings);
    policy = observed.state;
    if (observed.stop) return { policy, stop: observed.stop };
  }
  return { policy, stop: null };
}

test("B1 stops at the deterministic first step with a skipped-row majority and locations", () => {
  const analysis = analyzeProgram("10 FOO\n20 GOTO 10");
  const { stop } = runWithStopPolicy(analysis, 30);
  assert.equal(stop.type, "skippedMajority");
  assert.equal(stop.step, 10);
  assert.equal(stop.observedSteps, 10);
  assert.equal(stop.skippedCount, 5);
  assert.equal(stop.skippedRatio, 0.5);
  assert.ok(stop.rows.some(row => row.pageNumber === 1 && row.pageLine === 1 && row.lineNumber === 10));
});

test("B1 excludes unresolved references from the pre-completion ratio", () => {
  const settings = { ...DEFAULT_STOP_SETTINGS, minimumObservedSteps: 3, skippedWindowSteps: 5 };
  const missingTarget = analyzeProgram("10 GOTO 100");
  const waitingRow = missingTarget.rows[0];
  let state = createStopPolicyState(settings);
  for (let step = 1; step <= 5; step += 1) {
    const result = observeExecutionStep(
      state,
      { type: "skipped", row: waitingRow, step },
      false,
      settings
    );
    state = result.state;
    assert.equal(result.stop, null);
  }
});

test("B1 continue doubles recheck intervals to the cap, then supports run-only suppression", () => {
  const settings = {
    ...DEFAULT_STOP_SETTINGS,
    minimumObservedSteps: 1,
    skippedWindowSteps: 2,
    maxSkippedRecheckSteps: 8,
    noOutputSteps: 10000
  };
  const analysis = analyzeProgram("10 FOO\n20 GOTO 10");
  let execution = createExecutionState();
  let policy = createStopPolicyState(settings);
  const nextStop = () => {
    for (let index = 0; index < 100; index += 1) {
      const advanced = advanceExecution(analysis, execution);
      execution = advanced.state;
      const observed = observeExecutionStep(policy, advanced.event, false, settings);
      policy = observed.state;
      if (observed.stop) return observed.stop;
    }
    return null;
  };

  assert.equal(nextStop().step, 1);
  policy = continueAfterStop(policy, { type: "skippedMajority" }, false, settings);
  assert.equal(policy.skippedRecheckSteps, 4);
  assert.equal(nextStop().step, 5);
  policy = continueAfterStop(policy, { type: "skippedMajority" }, false, settings);
  assert.equal(policy.skippedRecheckSteps, 8);
  const capped = nextStop();
  assert.equal(capped.step, 13);
  assert.equal(capped.atCap, true);

  policy = continueAfterStop(policy, capped, true, settings);
  assert.equal(policy.suppressedReasons.skippedMajority, true);
  assert.equal(nextStop(), null);
  assert.equal(createStopPolicyState(settings).suppressedReasons.skippedMajority, false);
});

test("B2 stops a no-output GOTO loop at 500 steps but leaves a PRINT loop running", () => {
  const noOutput = runWithStopPolicy(analyzeProgram("10 GOTO 10"), 600);
  assert.equal(noOutput.stop.type, "noOutput");
  assert.equal(noOutput.stop.step, 500);
  assert.equal(noOutput.stop.stepsWithoutOutput, 500);
  assert.deepEqual(noOutput.stop.location, {
    pageNumber: 1,
    pageLine: 1,
    lineNumber: 10
  });

  const printing = runWithStopPolicy(analyzeProgram('10 PRINT "HELLO"\n20 GOTO 10'), 1500);
  assert.equal(printing.stop, null);
});

test("identical source and settings produce identical stop step and location", () => {
  const raw = "10 FOO\n20 GOTO 10";
  const settings = { ...DEFAULT_STOP_SETTINGS };
  const first = runWithStopPolicy(analyzeProgram(raw), 40, settings).stop;
  const second = runWithStopPolicy(analyzeProgram(raw), 40, settings).stop;
  assert.deepEqual(
    { type: first.type, step: first.step, rows: first.rows },
    { type: second.type, step: second.step, rows: second.rows }
  );
});
