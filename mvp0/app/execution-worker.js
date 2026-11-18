import { advanceExecution, createExecutionState } from "../src/basic.js";
import {
  continueAfterStop,
  createStopPolicyState,
  DEFAULT_STOP_SETTINGS,
  observeExecutionStep
} from "../src/stop-policy.js";

let runId = 0;
let active = false;
let waitingForDecision = false;
let currentSteps = 0;
let executionState;
let policyState;
let currentAnalysis;
let pendingStop;

async function runLoop(thisRun) {
  while (active && !waitingForDecision && thisRun === runId) {
    const result = advanceExecution(currentAnalysis, executionState);
    executionState = result.state;
    currentSteps = executionState.steps;

    if (!result.event) {
      active = false;
      self.postMessage({ type: "finished", steps: executionState.steps });
      return;
    }

    self.postMessage({ type: "event", event: result.event, steps: executionState.steps });
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
      self.postMessage({ type: "stop-candidate", reason: pendingStop, steps: currentSteps });
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

self.addEventListener("message", ({ data }) => {
  if (data.type === "stop") {
    active = false;
    waitingForDecision = false;
    pendingStop = null;
    self.postMessage({ type: "stopped", steps: currentSteps, reason: "manual" });
    return;
  }

  if (data.type === "resolve-stop") {
    if (!active || !waitingForDecision || !pendingStop) return;
    if (data.decision === "stop") {
      active = false;
      waitingForDecision = false;
      const reason = pendingStop.type;
      pendingStop = null;
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
    void runLoop(runId);
    return;
  }

  if (data.type !== "run") return;

  runId += 1;
  active = true;
  waitingForDecision = false;
  currentSteps = 0;
  currentAnalysis = data.analysis;
  executionState = createExecutionState();
  policyState = createStopPolicyState(DEFAULT_STOP_SETTINGS);
  pendingStop = null;
  self.postMessage({
    type: "suppression-state",
    suppressedReasons: policyState.suppressedReasons
  });
  self.postMessage({ type: "started" });
  void runLoop(runId);
});
