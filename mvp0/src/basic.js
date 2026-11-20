export const RowStatus = Object.freeze({
  understood: "理解済み",
  error: "誤り",
  uninterpreted: "未解釈",
  referenceWaiting: "参照待ち"
});

class ExpressionParser {
  constructor(text) {
    this.text = text;
    this.tokens = tokenizeExpression(text);
    this.position = 0;
  }

  parse() {
    if (!this.tokens) return null;
    if (this.tokens.length === 0) return null;
    const expression = this.parseComparison();
    if (!expression || this.position !== this.tokens.length) return null;
    return expression;
  }

  parseComparison() {
    let left = this.parseAdditive();
    if (!left) return null;
    while (this.position < this.tokens.length) {
      const operator = this.tokens[this.position];
      if (!["=", "<>", "<", "<=", ">", ">="].includes(operator.value)) break;
      this.position += 1;
      const right = this.parseAdditive();
      if (!right) return null;
      left = { type: "binary", operator: operator.value, left, right };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    if (!left) return null;
    while (this.position < this.tokens.length) {
      const operator = this.tokens[this.position];
      if (operator.value !== "+" && operator.value !== "-") break;
      this.position += 1;
      const right = this.parseMultiplicative();
      if (!right) return null;
      left = { type: "binary", operator: operator.value, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    if (!left) return null;
    while (this.position < this.tokens.length) {
      const operator = this.tokens[this.position];
      if (operator.value !== "*" && operator.value !== "/") break;
      this.position += 1;
      const right = this.parseUnary();
      if (!right) return null;
      left = { type: "binary", operator: operator.value, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.position < this.tokens.length && this.tokens[this.position].value === "-") {
      this.position += 1;
      const operand = this.parseUnary();
      if (!operand) return null;
      return { type: "unary-minus", operand };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    if (this.position >= this.tokens.length) return null;
    const token = this.tokens[this.position];
    this.position += 1;
    if (token.type === "number") {
      return { type: "number", value: token.value };
    }
    if (token.type === "identifier") {
      return { type: "variable", name: token.value.toUpperCase() };
    }
    if (token.value === "(") {
      const expression = this.parseComparison();
      if (!expression) return null;
      if (this.position >= this.tokens.length || this.tokens[this.position].value !== ")") return null;
      this.position += 1;
      return expression;
    }
    this.position -= 1;
    return null;
  }
}

function tokenizeExpression(text) {
  const tokens = [];
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[position + 1] ?? ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(position));
      if (!match) return null;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) return null;
      tokens.push({ type: "number", value });
      position += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(character)) {
      const match = /^[A-Za-z][A-Za-z0-9]*/.exec(text.slice(position));
      if (!match) return null;
      tokens.push({ type: "identifier", value: match[0] });
      position += match[0].length;
      continue;
    }
    const twoCharacters = text.slice(position, position + 2);
    if ([ "<>", "<=", ">="].includes(twoCharacters)) {
      tokens.push({ type: "operator", value: twoCharacters });
      position += 2;
      continue;
    }
    if ("+-*/()=<>".includes(character)) {
      tokens.push({ type: "operator", value: character });
      position += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function parseExpression(text) {
  const parser = new ExpressionParser(text.trim());
  return parser.parse();
}

function evaluateExpression(expression, variables) {
  if (expression.type === "number") return { ok: true, value: expression.value };
  if (expression.type === "variable") {
    if (!Object.prototype.hasOwnProperty.call(variables, expression.name)) {
      return { ok: false, error: `変数${expression.name}は未定義です。` };
    }
    return { ok: true, value: variables[expression.name] };
  }
  if (expression.type === "unary-minus") {
    const operand = evaluateExpression(expression.operand, variables);
    if (!operand.ok) return operand;
    return { ok: true, value: -operand.value };
  }
  const left = evaluateExpression(expression.left, variables);
  if (!left.ok) return left;
  const right = evaluateExpression(expression.right, variables);
  if (!right.ok) return right;
  let value;
  switch (expression.operator) {
    case "+": value = left.value + right.value; break;
    case "-": value = left.value - right.value; break;
    case "*": value = left.value * right.value; break;
    case "/":
      if (right.value === 0) return { ok: false, error: "0で除算することはできません。" };
      value = left.value / right.value;
      break;
    case "=": value = left.value === right.value ? -1 : 0; break;
    case "<>": value = left.value !== right.value ? -1 : 0; break;
    case "<": value = left.value < right.value ? -1 : 0; break;
    case "<=": value = left.value <= right.value ? -1 : 0; break;
    case ">": value = left.value > right.value ? -1 : 0; break;
    case ">=": value = left.value >= right.value ? -1 : 0; break;
    default: return { ok: false, error: `未対応の演算子${expression.operator}です。` };
  }
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, error: "式の計算結果が数値の範囲外です。" };
}

function parseAssignment(text) {
  const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=(.*)$/s.exec(text.trim());
  if (!assignment) return null;
  const variable = assignment[1].toUpperCase();
  const expressionText = assignment[2].trim();
  const expression = parseExpression(expressionText);
  if (!expression) {
    return {
      status: RowStatus.error,
      reason: "代入式の書式が不正です。",
      instruction: null
    };
  }
  return {
    status: RowStatus.understood,
    instruction: { type: "assign", variable, expression }
  };
}

function parseIfStatement(text) {
  const match = /^IF\s+(.+?)\s+THEN\s+(\d+)\s*$/i.exec(text.trim());
  if (!match) {
    if (/^IF\b/i.test(text.trim())) {
      return {
        status: RowStatus.uninterpreted,
        reason: "IF命令は「IF 式 THEN 行番号」の形式のみ対応しています。",
        instruction: null
      };
    }
    return null;
  }

  const expressionText = match[1].trim();
  const targetLine = Number(match[2]);
  const expression = parseExpression(expressionText);
  if (!expression) {
    if (expressionText.includes("$") || expressionText.includes(":") || expressionText.includes("ELSE")) {
      return {
        status: RowStatus.uninterpreted,
        reason: "このIF式の構文は0段階では未対応です。",
        instruction: null
      };
    }
    return {
      status: RowStatus.error,
      reason: "IF式の書式が不正です。",
      instruction: null
    };
  }
  if (!Number.isSafeInteger(targetLine)) {
    return {
      status: RowStatus.error,
      reason: "IFのジャンプ先行番号が安全な整数の範囲外です。",
      instruction: null
    };
  }
  return {
    status: RowStatus.understood,
    instruction: { type: "if", expression, targetLine }
  };
}

function parseStatement(text) {
  const letMatch = /^LET(?:\s+(.*))?$/i.exec(text.trim());
  if (letMatch) {
    if (!letMatch[1]) {
      return { status: RowStatus.error, reason: "LETの代入先または式がありません。" };
    }
    const assignment = parseAssignment(letMatch[1]);
    if (assignment) return assignment;
    return { status: RowStatus.error, reason: "LETの代入式の書式が不正です。" };
  }
  const bareAssignment = parseAssignment(text);
  if (bareAssignment) return bareAssignment;
  const ifStatement = parseIfStatement(text);
  if (ifStatement) return ifStatement;

  const commandMatch = /^([A-Za-z]+)/.exec(text.trimStart());
  if (!commandMatch) {
    return {
      status: RowStatus.error,
      reason: "命令の書式を読み取れません。"
    };
  }

  const commandText = commandMatch[1];
  const command = commandText.toUpperCase();
  const argument = text.trimStart().slice(commandText.length).trim();

  if (command === "REM") {
    return {
      status: RowStatus.understood,
      instruction: { type: "rem" }
    };
  }

  if (command === "END") {
    if (argument) {
      return { status: RowStatus.error, reason: "ENDに余分な内容があります。" };
    }
    return {
      status: RowStatus.understood,
      instruction: { type: "end" }
    };
  }

  if (command === "PRINT") {
    if (!argument) {
      return { status: RowStatus.error, reason: "PRINTの内容がありません。" };
    }
    if (/^"(?:[^"]|"")*"$/.test(argument)) {
      return {
        status: RowStatus.understood,
        instruction: { type: "print", value: argument.slice(1, -1).replaceAll('""', '"') }
      };
    }
    if (argument.startsWith('"')) {
      return { status: RowStatus.error, reason: "PRINTの文字列リテラルが閉じていません。" };
    }
    return {
      status: RowStatus.uninterpreted,
      reason: "0段階ではPRINTの文字列リテラル以外は未対応です。"
    };
  }

  if (command === "GOTO") {
    if (!/^\d+$/.test(argument)) {
      return { status: RowStatus.error, reason: "GOTOの行番号が不正です。" };
    }
    const targetLine = Number(argument);
    if (!Number.isSafeInteger(targetLine)) {
      return { status: RowStatus.error, reason: "GOTOの行番号が安全な整数の範囲外です。" };
    }
    return {
      status: RowStatus.understood,
      instruction: { type: "goto", targetLine }
    };
  }

  return {
    status: RowStatus.uninterpreted,
    reason: `命令「${commandText}」は0段階では未対応です。`
  };
}

function parseRow(sourceText, sourceLine, pageNumber, pageLine) {
  if (!sourceText.trim()) return null;

  const match = /^\s*(\d+)([\s\S]*)$/.exec(sourceText);
  if (!match) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber: null,
      status: RowStatus.error,
      reasons: ["行番号が不正です。"],
      duplicate: false,
      instruction: null
    };
  }

  const lineNumber = Number(match[1]);
  if (!Number.isSafeInteger(lineNumber)) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber: null,
      status: RowStatus.error,
      reasons: ["行番号が安全な整数の範囲外です。"],
      duplicate: false,
      instruction: null
    };
  }

  const statement = match[2].trimStart();
  if (!statement.trim()) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber,
      status: RowStatus.error,
      reasons: ["行番号の後に命令がありません。"],
      duplicate: false,
      instruction: null
    };
  }

  const parsed = parseStatement(statement);
  return {
    sourceLine,
    pageNumber,
    pageLine,
    sourceText,
    lineNumber,
    status: parsed.status,
    reasons: parsed.reason ? [parsed.reason] : [],
    duplicate: false,
    instruction: parsed.instruction ?? null,
    jumpTargetSourceLine: null
  };
}

function getSourceLines(raw) {
  if (raw.length === 0) return [];
  const lines = raw.split(/\r\n|\n|\r/);
  if (/(\r\n|\n|\r)$/.test(raw)) lines.pop();
  return lines;
}

function analyzePagesInternal(pages, { complete = false } = {}) {
  let sourceLine = 0;
  const rows = [];
  for (const page of pages) {
    const lines = getSourceLines(page.raw);
    lines.forEach((text, index) => {
      const row = parseRow(text, sourceLine + index + 1, page.pageNumber, index + 1);
      if (row) rows.push(row);
    });
    sourceLine += lines.length;
  }

  const rowsByNumber = new Map();

  for (const row of rows) {
    if (row.lineNumber === null) continue;
    const group = rowsByNumber.get(row.lineNumber) ?? [];
    group.push(row);
    rowsByNumber.set(row.lineNumber, group);
  }

  for (const [lineNumber, group] of rowsByNumber) {
    if (group.length < 2) continue;
    const sourcePositions = group.map(row => `入力行${row.sourceLine}`).join("、");
    const pagePositions = group
      .map(row => `ページ${row.pageNumber}の入力行${row.pageLine}`)
      .join("、");
    for (const row of group) {
      row.duplicate = true;
      row.status = RowStatus.error;
      row.reasons.push(`行番号${lineNumber}が重複しています（${sourcePositions}；${pagePositions}）。`);
    }
  }

  for (const row of rows) {
    if (row.status !== RowStatus.understood ||
        !["goto", "if"].includes(row.instruction?.type)) continue;
    const targetLine = row.instruction.targetLine;
    const targets = rowsByNumber.get(targetLine) ?? [];
    if (targets.length > 1) {
      row.status = RowStatus.error;
      row.reasons.push(`ジャンプ先の行番号${targetLine}が重複しているため、参照先を特定できません。`);
    } else if (targets.length === 0) {
      if (complete) {
        row.status = RowStatus.error;
        row.reasons.push(`ジャンプ先の行番号${targetLine}がありません。`);
      } else {
        row.status = RowStatus.referenceWaiting;
        row.reasons.push(`ジャンプ先の行番号${targetLine}を待っています。`);
      }
    } else {
      row.jumpTargetSourceLine = targets[0].sourceLine;
    }
  }

  const timeline = rows
    .filter(row => row.lineNumber !== null)
    .toSorted((left, right) => left.lineNumber - right.lineNumber || left.sourceLine - right.sourceLine)
    .map(row => ({ ...row }));
  const executable = timeline
    .filter(row => row.status === RowStatus.understood)
    .map(row => ({
      sourceLine: row.sourceLine,
      lineNumber: row.lineNumber,
      instruction: row.instruction,
      jumpTargetSourceLine: row.jumpTargetSourceLine
    }));

  const counts = {
    errors: rows.filter(row => row.status === RowStatus.error).length,
    uninterpreted: rows.filter(row => row.status === RowStatus.uninterpreted).length,
    referenceWaiting: rows.filter(row => row.status === RowStatus.referenceWaiting).length
  };

  const pageCounts = pages.map(page => {
    const pageRows = rows.filter(row => row.pageNumber === page.pageNumber);
    return {
      pageNumber: page.pageNumber,
      errors: pageRows.filter(row => row.status === RowStatus.error).length,
      uninterpreted: pageRows.filter(row => row.status === RowStatus.uninterpreted).length,
      referenceWaiting: pageRows.filter(row => row.status === RowStatus.referenceWaiting).length
    };
  });

  return {
    rawPages: pages.map(page => page.raw),
    complete,
    rows,
    counts,
    pageCounts,
    timeline,
    executable,
    patchCandidates: []
  };
}

export function analyzePages(pages, options = {}) {
  return analyzePagesInternal(
    pages.map((raw, index) => ({ pageNumber: index + 1, raw })),
    options
  );
}

export function analyzeProgram(raw, options = {}) {
  const analysis = analyzePagesInternal([{ pageNumber: 1, raw }], options);
  return { raw, ...analysis };
}

export function createExecutionState() {
  return { position: 0, steps: 0, done: false, variables: {} };
}

export function advanceExecution(analysis, state) {
  if (state.done || state.position >= analysis.timeline.length) {
    return { state: { ...state, done: true }, event: null };
  }

  const row = analysis.timeline[state.position];
  const steps = state.steps + 1;
  let position = state.position + 1;
  let event;
  let done = false;

  if (row.status !== RowStatus.understood) {
    const label = row.duplicate
      ? "重複のため実行対象外"
      : `${row.status}：${row.reasons.join(" ")}`;
    event = { type: "skipped", row, label, step: steps };
  } else if (row.instruction.type === "print") {
    event = { type: "print", row, value: row.instruction.value, step: steps };
  } else if (row.instruction.type === "rem") {
    event = { type: "rem", row, step: steps };
  } else if (row.instruction.type === "end") {
    event = { type: "end", row, step: steps };
    done = true;
  } else if (row.instruction.type === "assign") {
    const variables = { ...(state.variables ?? {}) };
    const evaluated = evaluateExpression(row.instruction.expression, variables);
    if (!evaluated.ok) {
      done = true;
      done = true;
      event = {
        type: "runtime-error",
        row,
        reason: evaluated.error,
        step: steps
      };
    } else {
      variables[row.instruction.variable] = evaluated.value;
      state = { ...state, variables };
      event = {
        type: "assign",
        row,
        variable: row.instruction.variable,
        value: evaluated.value,
        step: steps
      };
    }
  } else if (row.instruction.type === "if") {
    const variables = { ...(state.variables ?? {}) };
    const evaluated = evaluateExpression(row.instruction.expression, variables);
    if (!evaluated.ok) {
      done = true;
      event = {
        type: "runtime-error",
        row,
        reason: evaluated.error,
        step: steps
      };
    } else {
      const result = evaluated.value !== 0;
      event = {
        type: "if",
        row,
        result,
        targetLine: row.instruction.targetLine,
        nextLine: result ? row.instruction.targetLine : null,
        step: steps
      };
      if (result) {
        const targetPosition = analysis.timeline.findIndex(
          target => target.sourceLine === row.jumpTargetSourceLine
        );
        if (targetPosition !== -1) position = targetPosition;
      }
    }
  } else if (row.instruction.type === "goto") {
    event = {
      type: "goto",
      row,
      targetLine: row.instruction.targetLine,
      step: steps
    };
    const targetPosition = analysis.timeline.findIndex(
      target => target.sourceLine === row.jumpTargetSourceLine
    );
    if (targetPosition !== -1) position = targetPosition;
  } else {
    throw new Error(`未対応の実行命令です: ${row.instruction.type}`);
  }

  return {
    state: { position, steps, done, variables: state.variables ?? {} },
    event
  };
}

/**
 * @typedef {Object} AiPort
 * @property {(request: { raw: string, rows: object[] }) => Promise<object[]>} proposePatches
 */
