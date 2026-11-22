import {
  advanceExecution,
  createExecutionState,
  parseInputNumber
} from "../src/basic.js";
import {
  continueAfterStop,
  createStopPolicyState,
  DEFAULT_STOP_SETTINGS,
  observeExecutionStep
} from "../src/stop-policy.js";

const EVENT_BATCH_SIZE = 32;
let runId = 0;
let active = false;
let waitingForDecision = false;
let waitingForInput = false;
let currentSteps = 0;
let executionState;
let policyState;
let currentAnalysis;
let pendingStop;
let pendingInput;
let pendingEvents = [];

function flushPendingEvents() {
  if (pendingEvents.length === 0) return;
  self.postMessage({
    type: "events",
    events: pendingEvents,
    steps: currentSteps
  });
  pendingEvents = [];
}

async function runLoop(thisRun) {
  while (active && !waitingForDecision && !waitingForInput && thisRun === runId) {
    const result = advanceExecution(currentAnalysis, executionState);
    executionState = result.state;
    currentSteps = executionState.steps;

    if (!result.event) {
      flushPendingEvents();
      active = false;
      self.postMessage({ type: "finished", steps: executionState.steps });
      return;
    }

    pendingEvents.push(result.event);
    if (result.event.type === "runtime-error") {
      flushPendingEvents();
      active = false;
      self.postMessage({ type: "stopped", steps: currentSteps, reason: "runtime-error" });
      return;
    }
    if (result.event.type === "input-wait") {
      pendingInput = result.event;
      const observed = observeExecutionStep(
        policyState,
        result.event,
        currentAnalysis.complete,
        DEFAULT_STOP_SETTINGS
      );
      policyState = observed.state;
      if (observed.stop) {
        waitingForDecision = true;
        pendingStop = observed.stop;
        flushPendingEvents();
        self.postMessage({ type: "stop-candidate", reason: pendingStop, steps: currentSteps });
        return;
      }
      waitingForInput = true;
      flushPendingEvents();
      self.postMessage({
        type: "input-wait",
        variable: pendingInput.variable,
        prompt: pendingInput.prompt,
        steps: currentSteps
      });
      return;
    }
    if (result.event.type === "end") {
      flushPendingEvents();
      active = false;
      self.postMessage({ type: "finished", steps: currentSteps });
      return;
    }

    const observed = observeExecutionStep(
      policyState,
      result.event,
      currentAnalysis.complete,
      DEFAULT_STOP_SETTINGS
    );
    policyState = observed.state;
    if (observed.stop) {
      waitingForDecision = true;
      pendingStop = observed.stop;
      flushPendingEvents();
      self.postMessage({ type: "stop-candidate", reason: pendingStop, steps: currentSteps });
      return;
    }

    if (pendingEvents.length >= EVENT_BATCH_SIZE) flushPendingEvents();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

self.addEventListener("message", ({ data }) => {
  if (data.type === "stop") {
    active = false;
    waitingForDecision = false;
    waitingForInput = false;
    pendingStop = null;
    pendingInput = null;
    flushPendingEvents();
    self.postMessage({ type: "stopped", steps: currentSteps, reason: "manual" });
    return;
  }

  if (data.type === "resolve-input") {
    if (!active || !waitingForInput || !pendingInput) return;
    const value = parseInputNumber(data.text);
    if (value === null) {
      self.postMessage({ type: "input-invalid" });
      return;
    }
    const variables = { ...(executionState.variables ?? {}) };
    variables[pendingInput.variable] = value;
    executionState = { ...executionState, variables };
    pendingEvents.push({
      type: "input-complete",
      row: pendingInput.row,
      variable: pendingInput.variable,
      value,
      step: pendingInput.step
    });
    waitingForInput = false;
    pendingInput = null;
    flushPendingEvents();
    void runLoop(runId);
    return;
  }

  if (data.type === "cancel-input") {
    if (!active || !waitingForInput) return;
    active = false;
    waitingForDecision = false;
    waitingForInput = false;
    pendingInput = null;
    flushPendingEvents();
    self.postMessage({ type: "stopped", steps: currentSteps, reason: "input-cancel" });
    return;
  }

  if (data.type === "resolve-stop") {
    if (!active || !waitingForDecision || !pendingStop) return;
    if (data.decision === "stop") {
      active = false;
      waitingForDecision = false;
      const reason = pendingStop.type;
      pendingStop = null;
      pendingInput = null;
      self.postMessage({ type: "stopped", steps: currentSteps, reason });
      return;
    }
    if (data.decision !== "continue") return;

    policyState = continueAfterStop(
      policyState,
      pendingStop,
      data.suppressForRun === true,
      DEFAULT_STOP_SETTINGS
    );
    self.postMessage({
      type: "suppression-state",
      suppressedReasons: policyState.suppressedReasons
    });
    waitingForDecision = false;
    pendingStop = null;
    if (pendingInput) {
      waitingForInput = true;
      self.postMessage({
        type: "input-wait",
        variable: pendingInput.variable,
        prompt: pendingInput.prompt,
        steps: currentSteps
      });
      return;
    }
    void runLoop(runId);
    return;
  }

  if (data.type !== "run") return;

  runId += 1;
  active = true;
  waitingForDecision = false;
  waitingForInput = false;
  currentSteps = 0;
  pendingEvents = [];
  currentAnalysis = data.analysis;
  executionState = createExecutionState();
  policyState = createStopPolicyState(DEFAULT_STOP_SETTINGS);
  pendingStop = null;
  pendingInput = null;
  self.postMessage({
    type: "suppression-state",
    suppressedReasons: policyState.suppressedReasons
  });
  self.postMessage({ type: "started" });
  void runLoop(runId);
});
