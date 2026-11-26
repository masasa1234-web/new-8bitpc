import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceExecution,
  analyzeProgram,
  createExecutionState,
  DEFAULT_RANDOM_SEED,
  parseInputNumber,
  RowStatus,
  TEST_RANDOM_SEED
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
  assert.equal(analysis.rows[2].reasons[0], "命令「FOO」は現在未対応です。");
  assert.equal(analysis.counts.uninterpreted, 1);
  let state = { position: 2, steps: 2, done: false };
  const result = advanceExecution(analysis, state);
  assert.equal(result.event.type, "skipped");
  assert.equal(result.event.row.sourceText, "30 FOO");
  assert.equal(result.state.steps, 3);
});

test("unsupported syntax messages describe current support without changing classification", () => {
  const analysis = analyzeProgram(
    "10 FOO\n20 PRINT A\n30 IF A$=1 THEN 100"
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted
  ]);
  assert.deepEqual(analysis.rows.map(row => row.reasons[0]), [
    "命令「FOO」は現在未対応です。",
    "現在、PRINTは文字列リテラルのみ対応しています。",
    "このIF式の構文は現在未対応です。"
  ]);
  assert.equal(analysis.executable.length, 0);
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

test("CLS clears only the output as one understood execution step", () => {
  const analysis = analyzeProgram(
    '10 PRINT "BEFORE"\n20 cls\n30 PRINT "AFTER"\n40 END'
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));
  assert.deepEqual(analysis.rows[1].instruction, { type: "cls" });

  let state = createExecutionState();
  const before = advanceExecution(analysis, state);
  state = before.state;
  const clear = advanceExecution(analysis, state);
  state = clear.state;
  const after = advanceExecution(analysis, state);

  assert.deepEqual(
    [before.event.type, before.event.step, clear.event.type, clear.event.step,
      after.event.type, after.event.step],
    ["print", 1, "cls", 2, "print", 3]
  );
  assert.equal(clear.event.row.sourceText, "20 cls");
  assert.equal(state.steps, 2);
  assert.equal(analysis.executable.length, 4);
});

test("CLS with arguments remains uninterpreted and is not executable", () => {
  const analysis = analyzeProgram("10 CLS 0\n20 PRINT \"AFTER\"");
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.uninterpreted,
    RowStatus.understood
  ]);
  assert.equal(analysis.rows[0].reasons[0], "CLSは引数なし形式のみ対応しています。");
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [20]);
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

test("numeric INPUT values compare exactly against multi-digit numbers", () => {
  const analysis = analyzeProgram(
    '10 A=76\n' +
    "20 INPUT B\n" +
    '30 IF B=A THEN PRINT "EQ"\n' +
    '40 IF B<A THEN PRINT "LT"\n' +
    '50 IF B>A THEN PRINT "GT"\n' +
    "60 END"
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));

  const executeGuess = text => {
    let state = createExecutionState();
    const output = [];
    while (!state.done) {
      const result = advanceExecution(analysis, state);
      state = result.state;
      if (result.event.type === "input-wait") {
        const value = parseInputNumber(text);
        assert.notEqual(value, null);
        state = {
          ...state,
          variables: { ...state.variables, [result.event.variable]: value }
        };
      } else if (result.event.type === "print") {
        output.push(result.event.value);
      }
    }
    return output;
  };

  assert.deepEqual(executeGuess("7"), ["LT"]);
  assert.deepEqual(executeGuess("70"), ["LT"]);
  assert.deepEqual(executeGuess("76"), ["EQ"]);
  assert.deepEqual(executeGuess("77"), ["GT"]);
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

test("IF THEN single PRINT and assignment execute in the same step when true", () => {
  const analysis = analyzeProgram(
    '10 A=5\n20 IF A=5 THEN PRINT "OK"\n30 IF A=5 THEN A=A+1\n40 END'
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));
  assert.deepEqual(analysis.raw, analysis.rawPages[0]);

  let state = createExecutionState();
  const first = advanceExecution(analysis, state);
  state = first.state;
  assert.equal(first.event.type, "assign");

  const print = advanceExecution(analysis, state);
  state = print.state;
  assert.equal(print.event.type, "print");
  assert.equal(print.event.value, "OK");
  assert.equal(print.event.conditional, true);
  assert.equal(print.event.step, 2);

  const assignment = advanceExecution(analysis, state);
  state = assignment.state;
  assert.equal(assignment.event.type, "assign");
  assert.equal(assignment.event.variable, "A");
  assert.equal(assignment.event.value, 6);
  assert.equal(assignment.event.conditional, true);
  assert.equal(assignment.event.step, 3);
  assert.equal(state.variables.A, 6);

  const end = advanceExecution(analysis, state);
  assert.equal(end.event.type, "end");
  assert.equal(end.event.step, 4);
});

test("true IF THEN CLS clears through one conditional event and advances one row", () => {
  const analysis = analyzeProgram(
    '10 PRINT "BEFORE"\n20 IF 1=1 THEN CLS\n30 PRINT "AFTER"\n40 END'
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));
  assert.deepEqual(analysis.rows[1].instruction.thenInstruction, { type: "cls" });
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20, 30, 40]);

  let state = createExecutionState();
  const before = advanceExecution(analysis, state);
  state = before.state;
  const clear = advanceExecution(analysis, state);
  state = clear.state;
  const after = advanceExecution(analysis, state);

  assert.equal(clear.event.type, "cls");
  assert.equal(clear.event.conditional, true);
  assert.equal(clear.event.step, 2);
  assert.equal(clear.event.row.sourceText, "20 IF 1=1 THEN CLS");
  assert.equal(clear.state.position, 2);
  assert.equal(after.event.type, "print");
  assert.equal(after.event.value, "AFTER");
  assert.equal(after.event.step, 3);
  assert.equal(state.steps, 2);
});

test("true IF THEN END ends in one conditional step without executing later rows", () => {
  const raw = '10 IF 1=1 THEN END\n20 PRINT "AFTER"';
  const analysis = analyzeProgram(raw);
  assert.equal(analysis.raw, raw);
  assert.equal(analysis.rows[0].status, RowStatus.understood);
  assert.deepEqual(analysis.rows[0].instruction.thenInstruction, { type: "end" });
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 20]);

  const result = advanceExecution(analysis, createExecutionState());
  assert.equal(result.event.type, "end");
  assert.equal(result.event.conditional, true);
  assert.equal(result.event.step, 1);
  assert.equal(result.state.steps, 1);
  assert.equal(result.state.done, true);

  const afterEnd = advanceExecution(analysis, result.state);
  assert.equal(afterEnd.event, null);
  assert.equal(afterEnd.state.steps, 1);
});

test("false IF THEN statements are not executed and continue to the next row", () => {
  const analysis = analyzeProgram(
    '10 A=0\n20 IF A=1 THEN PRINT "NO"\n30 IF A=1 THEN A=99\n40 PRINT "NEXT"'
  );
  let state = createExecutionState();
  const assignment = advanceExecution(analysis, state);
  state = assignment.state;
  const falsePrint = advanceExecution(analysis, state);
  state = falsePrint.state;
  const falseAssignment = advanceExecution(analysis, state);
  state = falseAssignment.state;
  const next = advanceExecution(analysis, state);

  assert.equal(falsePrint.event.type, "if");
  assert.equal(falsePrint.event.result, false);
  assert.equal(falsePrint.state.position, 2);
  assert.equal(falseAssignment.event.type, "if");
  assert.equal(falseAssignment.event.result, false);
  assert.equal(falseAssignment.state.variables.A, 0);
  assert.equal(next.event.type, "print");
  assert.equal(next.event.value, "NEXT");
  assert.equal(analysis.rows.some(row => row.sourceText.includes('"NO"')), true);
});

test("false IF THEN END records one IF step and continues to the next row", () => {
  const analysis = analyzeProgram(
    '10 IF 1=0 THEN END\n20 PRINT "NEXT"\n30 END'
  );
  const conditional = advanceExecution(analysis, createExecutionState());
  assert.equal(conditional.event.type, "if");
  assert.equal(conditional.event.result, false);
  assert.equal(conditional.event.step, 1);
  assert.equal(conditional.state.done, false);

  const next = advanceExecution(analysis, conditional.state);
  assert.equal(next.event.type, "print");
  assert.equal(next.event.value, "NEXT");
  assert.equal(next.event.step, 2);
});

test("false IF THEN CLS emits no clear event and continues to the next row", () => {
  const analysis = analyzeProgram(
    '10 PRINT "BEFORE"\n20 IF 1=0 THEN CLS\n30 PRINT "AFTER"\n40 END'
  );
  let state = createExecutionState();
  const before = advanceExecution(analysis, state);
  state = before.state;
  const conditional = advanceExecution(analysis, state);
  state = conditional.state;
  const after = advanceExecution(analysis, state);

  assert.equal(conditional.event.type, "if");
  assert.equal(conditional.event.result, false);
  assert.equal(conditional.event.step, 2);
  assert.equal(conditional.state.position, 2);
  assert.equal(after.event.type, "print");
  assert.equal(after.event.value, "AFTER");
  assert.equal(after.event.step, 3);
  assert.equal(state.steps, 2);
});

test("out-of-scope IF THEN tails remain uninterpreted as whole rows", () => {
  const raw =
    "10 IF A=1 THEN GOTO 100\n" +
    "20 IF A=1 THEN REM TEST\n" +
    "30 IF A=1 THEN STOP\n" +
    "40 IF A=1 THEN INPUT A\n" +
    '50 IF A=1 THEN PRINT "OK":A=A+1\n' +
    '60 IF A=1 THEN PRINT "OK" ELSE PRINT "NO"\n' +
    "70 IF A=1 THEN BEEP\n" +
    '80 IF A=1 THEN PRINT "ELSE"\n' +
    '90 IF A=1 THEN PRINT "A:B"\n' +
    "100 IF A=1 THEN CLS 0\n" +
    '110 IF A=1 THEN CLS:PRINT "NO"\n' +
    "120 IF A=1 THEN CLS ELSE CLS\n" +
    "130 IF A$=1 THEN CLS\n" +
    "140 IF A= THEN CLS";
  const analysis = analyzeProgram(raw);
  assert.deepEqual(
    analysis.rows.map(row => row.status),
    [
      ...Array(7).fill(RowStatus.uninterpreted),
      RowStatus.understood,
      RowStatus.understood,
      RowStatus.uninterpreted,
      RowStatus.uninterpreted,
      RowStatus.uninterpreted,
      RowStatus.uninterpreted,
      RowStatus.error
    ]
  );
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [80, 90]);
  assert.ok(analysis.rows.slice(0, 7).every(row => row.instruction === null));
  assert.ok(analysis.rows.slice(9).every(row => row.instruction === null));
  assert.ok(analysis.rows.filter(row => row.instruction === null)
    .every(row => row.reasons.join(" ").length > 0));
});

test("IF THEN supported statements retain parseStatement error classifications", () => {
  const analysis = analyzeProgram(
    '10 IF A=1 THEN PRINT "BROKEN\n' +
    "20 IF A=1 THEN A=\n" +
    "30 IF A=1 THEN PRINT A"
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.error,
    RowStatus.error,
    RowStatus.uninterpreted
  ]);
  assert.ok(analysis.rows.every(row => row.instruction === null));
  assert.equal(analysis.executable.length, 0);
  assert.match(analysis.rows[0].reasons.join(" "), /閉じていません/);
  assert.match(analysis.rows[1].reasons.join(" "), /代入式の書式/);
  assert.match(analysis.rows[2].reasons.join(" "), /未対応/);
});

test("unsupported IF THEN forms are uninterpreted and malformed END/conditions are errors", () => {
  const analysis = analyzeProgram(
    "10 IF A=1 THEN CLS:END\n" +
    "20 IF A=1 THEN END ELSE END\n" +
    "30 IF A=1 THEN END EXTRA\n" +
    "40 IF A= THEN END\n" +
    "50 IF A$=1 THEN END"
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.error,
    RowStatus.error,
    RowStatus.uninterpreted
  ]);
  assert.deepEqual(analysis.executable, []);
  assert.ok(analysis.rows.every(row => row.instruction === null));
  assert.match(analysis.rows[2].reasons.join(" "), /ENDに余分な内容/);
  assert.match(analysis.rows[3].reasons.join(" "), /IF式の書式/);
});

test("malformed and unsupported rows are excluded while execution reaches AFTER and END", () => {
  const analysis = analyzeProgram(
    '10 A=1\n' +
    '20 PRINT "BROKEN\n' +
    '30 A=\n' +
    '40 PRINT A\n' +
    '50 PRINT "AFTER"\n' +
    '60 END'
  );

  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.error,
    RowStatus.error,
    RowStatus.uninterpreted,
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.match(analysis.rows[1].reasons.join(" "), /文字列リテラルが閉じていません/);
  assert.match(analysis.rows[2].reasons.join(" "), /代入式の書式/);
  assert.match(analysis.rows[3].reasons.join(" "), /文字列リテラルのみ対応/);
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 50, 60]);

  let state = createExecutionState();
  const events = [];
  while (!state.done) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    if (result.event) events.push(result.event);
  }

  assert.deepEqual(
    events.map(event => [event.type, event.row.lineNumber]),
    [
      ["assign", 10],
      ["skipped", 20],
      ["skipped", 30],
      ["skipped", 40],
      ["print", 50],
      ["end", 60]
    ]
  );
  assert.deepEqual(
    events.filter(event => event.type === "print").map(event => event.value),
    ["AFTER"]
  );
  assert.equal(state.done, true);
});

test("inline IF PRINT clears the no-output counter as one output step", () => {
  const analysis = analyzeProgram('10 IF 1=1 THEN PRINT "OK"\n20 END');
  const result = advanceExecution(analysis, createExecutionState());
  assert.equal(result.event.type, "print");
  assert.equal(result.event.conditional, true);

  const previous = {
    ...createStopPolicyState(DEFAULT_STOP_SETTINGS),
    steps: DEFAULT_STOP_SETTINGS.noOutputSteps - 1,
    stepsSinceOutput: DEFAULT_STOP_SETTINGS.noOutputSteps - 1,
    nextNoOutputCheckAt: DEFAULT_STOP_SETTINGS.noOutputSteps
  };
  const observed = observeExecutionStep(previous, result.event, false, DEFAULT_STOP_SETTINGS);
  assert.equal(observed.stop, null);
  assert.equal(observed.state.stepsSinceOutput, 0);
  assert.equal(
    observed.state.nextNoOutputCheckAt,
    DEFAULT_STOP_SETTINGS.noOutputSteps * 2
  );
});

test("standalone and conditional CLS do not clear the no-output counter", () => {
  const previous = {
    ...createStopPolicyState(DEFAULT_STOP_SETTINGS),
    steps: DEFAULT_STOP_SETTINGS.noOutputSteps - 1,
    stepsSinceOutput: DEFAULT_STOP_SETTINGS.noOutputSteps - 1,
    nextNoOutputCheckAt: DEFAULT_STOP_SETTINGS.noOutputSteps
  };
  const singleCls = advanceExecution(
    analyzeProgram("10 CLS"),
    createExecutionState()
  ).event;
  const conditionalCls = advanceExecution(
    analyzeProgram("10 IF 1=1 THEN CLS"),
    createExecutionState()
  ).event;
  const falseIf = advanceExecution(
    analyzeProgram("10 IF 1=0 THEN CLS"),
    createExecutionState()
  ).event;

  assert.equal(singleCls.type, "cls");
  assert.equal(conditionalCls.type, "cls");
  assert.equal(conditionalCls.conditional, true);
  for (const event of [singleCls, conditionalCls]) {
    const observed = observeExecutionStep(previous, event, false, DEFAULT_STOP_SETTINGS);
    assert.equal(observed.stop.type, "noOutput");
    assert.equal(observed.stop.step, DEFAULT_STOP_SETTINGS.noOutputSteps);
    assert.equal(observed.state.stepsSinceOutput, DEFAULT_STOP_SETTINGS.noOutputSteps);
  }

  assert.equal(falseIf.type, "if");
  assert.equal(falseIf.result, false);
  const observedFalse = observeExecutionStep(previous, falseIf, false, DEFAULT_STOP_SETTINGS);
  assert.equal(observedFalse.stop.type, "noOutput");
  assert.equal(observedFalse.state.stepsSinceOutput, DEFAULT_STOP_SETTINGS.noOutputSteps);
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

test("INT floors positive and negative values and composes with expressions", () => {
  const analysis = analyzeProgram(
    "10 A=INT(2.8)\n" +
    "20 B=INT(2.0)\n" +
    "30 C=INT(-2.8)\n" +
    "40 D=INT(-2.0)\n" +
    "50 E=INT(-0.2)\n" +
    "60 F=INT(0.2)\n" +
    "70 G=INT(1+2*3)\n" +
    "80 H=10\n" +
    "90 I=INT((H+10)/2)\n" +
    "100 J=(INT(H)+1)*2\n" +
    "110 K=INT(INT(2.8)+0.5)\n" +
    "120 L=INT(-2.8)\n" +
    "130 M=-(INT(2.8))"
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));

  let state = createExecutionState();
  const values = {};
  while (state.position < analysis.executable.length) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    values[result.event.variable] = result.event.value;
  }

  assert.deepEqual(values, {
    A: 2,
    B: 2,
    C: -3,
    D: -2,
    E: -1,
    F: 0,
    G: 7,
    H: 10,
    I: 10,
    J: 22,
    K: 2,
    L: -3,
    M: -2
  });
  assert.equal(state.steps, 13);
});

test("INT is available in IF conditions without adding execution steps", () => {
  const analysis = analyzeProgram(
    '10 A=5\n' +
    '20 IF INT(A)=5 THEN PRINT "INT IF"\n' +
    '30 X=4\n' +
    '40 IF INT(X/2)>0 THEN PRINT "DIV IF"\n' +
    '50 END'
  );
  assert.ok(analysis.rows.every(row => row.status === RowStatus.understood));

  let state = createExecutionState();
  const events = [];
  while (!state.done) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    if (result.event) events.push(result.event);
  }

  assert.deepEqual(
    events.map(event => [event.type, event.row.lineNumber, event.step]),
    [
      ["assign", 10, 1],
      ["print", 20, 2],
      ["assign", 30, 3],
      ["print", 40, 4],
      ["end", 50, 5]
    ]
  );
  assert.deepEqual(
    events.filter(event => event.type === "print").map(event => event.value),
    ["INT IF", "DIV IF"]
  );
  assert.ok(events.filter(event => event.type === "print").every(event => event.conditional));
});

test("invalid INT calls are errors and unknown functions keep whole rows uninterpreted", () => {
  const analysis = analyzeProgram(
    '10 A=1\n' +
    '20 B=INT()\n' +
    '30 C=INT(1,2)\n' +
    '40 D=INT(1+)\n' +
    '50 E=INT((1+2)\n' +
    '60 F=INT(1+2))\n' +
    '70 G=RND(2)\n' +
    '80 H=INT(RND(2))\n' +
    '90 I=1+RND(2)\n' +
    '100 IF RND(2)>0 THEN 200\n' +
    '110 PRINT "AFTER"\n' +
    '120 END'
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.error,
    RowStatus.error,
    RowStatus.error,
    RowStatus.error,
    RowStatus.error,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.understood,
    RowStatus.understood
  ]);
  assert.deepEqual(analysis.executable.map(row => row.lineNumber), [10, 110, 120]);
  assert.ok(analysis.rows.slice(1, 6).every(row => row.instruction === null));
  assert.ok(analysis.rows.slice(6, 10).every(row => row.instruction === null));

  let state = createExecutionState();
  const events = [];
  while (!state.done) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    if (result.event) events.push(result.event);
  }

  assert.deepEqual(state.variables, { A: 1 });
  assert.deepEqual(
    events.filter(event => event.type === "print").map(event => event.value),
    ["AFTER"]
  );
  assert.ok(events.filter(event => event.type === "skipped").every(event =>
    [20, 30, 40, 50, 60, 70, 80, 90, 100].includes(event.row.lineNumber)
  ));
});

test("INT preserves runtime errors and expressions are limited to depth 64", () => {
  const undefinedVariable = analyzeProgram("10 A=INT(B)");
  assert.equal(undefinedVariable.rows[0].status, RowStatus.understood);
  let result = advanceExecution(undefinedVariable, createExecutionState());
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /変数Bは未定義/);

  const divideByZero = analyzeProgram("10 A=INT(1/0)");
  result = advanceExecution(divideByZero, createExecutionState());
  assert.equal(result.event.type, "runtime-error");
  assert.match(result.event.reason, /0で除算/);

  const depth64 = `${"INT(".repeat(64)}1${")".repeat(64)}`;
  const depth65 = `${"INT(".repeat(65)}1${")".repeat(65)}`;
  const chain64 = `${"1+".repeat(64)}1`;
  const chain65 = `${"1+".repeat(65)}1`;
  const depthAnalysis = analyzeProgram(
    `10 A=${depth64}\n20 B=${depth65}\n30 C=${chain64}\n40 D=${chain65}`
  );
  assert.deepEqual(depthAnalysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.error,
    RowStatus.understood,
    RowStatus.error
  ]);
  result = advanceExecution(depthAnalysis, createExecutionState());
  assert.equal(result.event.type, "assign");
  assert.equal(result.event.value, 1);
});

test("RND uses a fixed default seed when RANDOMIZE is not called", () => {
  const analysis = analyzeProgram("10 A=RND(1)\n20 B=RND(1)\n30 END");
  const run = () => {
    let state = createExecutionState();
    const values = {};
    for (let index = 0; index < 3; index += 1) {
      const result = advanceExecution(analysis, state);
      state = result.state;
      if (result.event?.type === "assign") values[result.event.variable] = result.event.value;
    }
    return values;
  };
  assert.deepEqual(run(), run());
  assert.equal(createExecutionState().randomSeed, DEFAULT_RANDOM_SEED);
  assert.equal(createExecutionState({ randomSeed: TEST_RANDOM_SEED }).randomSeed, TEST_RANDOM_SEED);
});

test("bare RND is equivalent to RND(1) and uses the same deterministic seed", () => {
  const bare = analyzeProgram(
    "10 A=RND\n" +
    "20 B=INT(RND*100+1)\n" +
    "30 END"
  );
  const parenthesized = analyzeProgram(
    "10 A=RND(1)\n" +
    "20 B=INT(RND(1)*100+1)\n" +
    "30 END"
  );
  assert.ok(bare.rows.every(row => row.status === RowStatus.understood));

  const run = analysis => {
    let state = createExecutionState();
    const values = {};
    while (!state.done) {
      const result = advanceExecution(analysis, state);
      state = result.state;
      if (result.event?.type === "assign") {
        values[result.event.variable] = result.event.value;
      }
    }
    return values;
  };

  assert.deepEqual(run(bare), run(parenthesized));
  assert.deepEqual(run(bare), run(bare));
});

test("RANDOMIZE specified and decimal seeds reset RND for deterministic replay", () => {
  const analysis = analyzeProgram(
    "10 RANDOMIZE 123.75\n" +
    "20 A=RND(1)\n" +
    "30 B=RND(1)\n" +
    "40 END"
  );
  const run = () => {
    let state = createExecutionState();
    const events = [];
    while (!state.done) {
      const result = advanceExecution(analysis, state);
      state = result.state;
      if (result.event) events.push(result.event);
    }
    return {
      events,
      state,
      values: Object.fromEntries(
        events
          .filter(event => event.type === "assign")
          .map(event => [event.variable, event.value])
      )
    };
  };
  const first = run();
  const replay = run();
  assert.equal(first.events[0].type, "randomize");
  assert.equal(first.events[0].seed, 123);
  assert.equal(first.events[0].seedSource, "specified");
  assert.deepEqual(replay.values, first.values);

  const replayAnalysis = analyzeProgram(
    `10 RANDOMIZE ${first.events[0].seed}\n` +
    "20 A=RND(1)\n" +
    "30 B=RND(1)\n" +
    "40 END"
  );
  const replayEvents = [];
  let replayState = createExecutionState();
  while (!replayState.done) {
    const result = advanceExecution(replayAnalysis, replayState);
    replayState = result.state;
    if (result.event) replayEvents.push(result.event);
  }
  assert.deepEqual(
    replayEvents.filter(event => event.type === "assign").map(event => event.value),
    Object.values(first.values)
  );
});

test("argument-less RANDOMIZE records a generated seed and resets the generator", () => {
  const analysis = analyzeProgram("10 RANDOMIZE\n20 A=RND(1)\n30 END");
  let state = createExecutionState();
  const randomize = advanceExecution(analysis, state);
  state = randomize.state;
  assert.equal(randomize.event.type, "randomize");
  assert.equal(randomize.event.seedSource, "new");
  assert.equal(Number.isFinite(randomize.event.seed), true);
  assert.equal(randomize.event.seed >= 0 && randomize.event.seed <= 0xffffffff, true);

  const rnd = advanceExecution(analysis, state);
  assert.equal(rnd.event.type, "assign");
  assert.ok(rnd.event.value >= 0 && rnd.event.value < 1);
});

test("RND and RANDOMIZE syntax stays classified by existing parse rules", () => {
  const analysis = analyzeProgram(
    "10 A=RND(1)\n" +
    "20 B=RND()\n" +
    "30 C=RND(1,2)\n" +
    "40 D=RND(2)\n" +
    "50 RANDOMIZE 1.9\n" +
    "60 RANDOMIZE 1,2\n" +
    "70 RANDOMIZE\n" +
    "80 RANDOMIZE (1\n" +
    "90 END"
  );
  assert.deepEqual(analysis.rows.map(row => row.status), [
    RowStatus.understood,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.uninterpreted,
    RowStatus.understood,
    RowStatus.uninterpreted,
    RowStatus.understood,
    RowStatus.error,
    RowStatus.understood
  ]);
  assert.deepEqual(
    analysis.executable.map(row => row.lineNumber),
    [10, 50, 70, 90]
  );

  const stateResults = [];
  let state = createExecutionState({ randomSeed: TEST_RANDOM_SEED });
  while (!state.done) {
    const result = advanceExecution(analysis, state);
    state = result.state;
    if (result.event) stateResults.push(result.event);
  }
  const randomizeEvents = stateResults.filter(event => event.type === "randomize");
  assert.equal(randomizeEvents[0].seed, 1);
  assert.equal(randomizeEvents[1].seedSource, "new");

  const rndEvent = stateResults.find(event => event.type === "assign" && event.variable === "A");
  assert.ok(rndEvent.value >= 0 && rndEvent.value < 1);
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

test("INPUT wait counts once as an external change for stop policy", () => {
  const settings = { ...DEFAULT_STOP_SETTINGS, noOutputSteps: 500 };
  const previous = {
    ...createStopPolicyState(settings),
    steps: 499,
    stepsSinceOutput: 499,
    nextNoOutputCheckAt: 500
  };
  const event = {
    type: "input-wait",
    row: { status: RowStatus.understood, pageNumber: 1, pageLine: 1, lineNumber: 10 }
  };

  const observed = observeExecutionStep(previous, event, false, settings);
  assert.equal(observed.stop, null);
  assert.equal(observed.state.steps, 500);
  assert.equal(observed.state.stepsSinceOutput, 0);
  assert.equal(observed.state.nextNoOutputCheckAt, 1000);
  assert.deepEqual(observed.state.skippedWindow.at(-1), {
    event,
    skipped: false,
    counted: true
  });
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

test("B2 stops no-output GOTO and CLS loops at 500 steps but leaves a PRINT loop running", () => {
  const noOutput = runWithStopPolicy(analyzeProgram("10 GOTO 10"), 600);
  assert.equal(noOutput.stop.type, "noOutput");
  assert.equal(noOutput.stop.step, 500);
  assert.equal(noOutput.stop.stepsWithoutOutput, 500);
  assert.deepEqual(noOutput.stop.location, {
    pageNumber: 1,
    pageLine: 1,
    lineNumber: 10
  });

  const clearingOnly = runWithStopPolicy(analyzeProgram("10 CLS\n20 GOTO 10"), 600);
  assert.equal(clearingOnly.stop.type, "noOutput");
  assert.equal(clearingOnly.stop.step, 500);
  assert.equal(clearingOnly.stop.stepsWithoutOutput, 500);

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
