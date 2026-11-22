import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProgram } from "../src/basic.js";

test("stopping during INPUT wait clears the pending request for a rerun", async t => {
  const previousSelf = globalThis.self;
  const listeners = new Map();
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      messages.push(message);
    }
  };
  t.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  });

  const workerUrl = new URL("../app/execution-worker.js", import.meta.url);
  await import(`${workerUrl.href}?test=${Date.now()}`);
  const send = data => listeners.get("message")({ data });
  const waitFor = async (fromIndex, predicate) => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(
        (message, messageIndex) => messageIndex >= fromIndex && predicate(message)
      );
      if (index >= 0) return { index, message: messages[index] };
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Timed out waiting for the worker message");
  };
  const analysis = analyzeProgram("10 INPUT A\n20 END");

  send({ type: "run", analysis });
  const firstWait = await waitFor(0, message => message.type === "input-wait");
  const firstWaitEvent = messages
    .filter(message => message.type === "events")
    .flatMap(message => message.events)
    .find(event => event.type === "input-wait");
  assert.equal(firstWaitEvent.deferredForStop, undefined);
  send({ type: "stop" });
  const stopped = await waitFor(firstWait.index + 1, message => message.type === "stopped");
  assert.equal(stopped.message.reason, "manual");

  const rerunStart = messages.length;
  send({ type: "run", analysis });
  const rerunWait = await waitFor(rerunStart, message => message.type === "input-wait");
  assert.equal(
    messages.slice(rerunStart, rerunWait.index + 1)
      .filter(message => message.type === "input-wait").length,
    1
  );
  assert.equal(
    messages.slice(rerunStart).some(message =>
      message.type === "input-complete" || message.type === "input-invalid"
    ),
    false
  );
  send({ type: "stop" });
});

test("INPUT arrival is counted once before a stop prompt, then resumes into input wait", async t => {
  const previousSelf = globalThis.self;
  const listeners = new Map();
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      messages.push(message);
    }
  };
  t.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  });

  const workerUrl = new URL("../app/execution-worker.js", import.meta.url);
  await import(`${workerUrl.href}?input-stop-test=${Date.now()}`);
  const send = data => listeners.get("message")({ data });
  const waitFor = async (fromIndex, predicate) => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(
        (message, messageIndex) => messageIndex >= fromIndex && predicate(message)
      );
      if (index >= 0) return { index, message: messages[index] };
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Timed out waiting for the worker message");
  };
  const raw = [
    "10 FOO", "20 FOO", "30 FOO", "40 FOO", "50 FOO",
    "60 FOO", "70 FOO", "80 FOO", "90 FOO",
    "100 INPUT A", "110 END"
  ].join("\n");
  const analysis = analyzeProgram(raw);

  send({ type: "run", analysis });
  const stop = await waitFor(0, message => message.type === "stop-candidate");
  assert.equal(stop.message.steps, 10);
  assert.equal(stop.message.reason.type, "skippedMajority");
  const initialEvents = messages
    .filter(message => message.type === "events")
    .flatMap(message => message.events);
  const deferredInput = initialEvents.find(
    event => event.type === "input-wait" && event.step === 10
  );
  assert.ok(deferredInput);
  assert.equal(deferredInput.deferredForStop, true);

  const continueIndex = messages.length;
  send({ type: "resolve-stop", decision: "continue" });
  const inputWait = await waitFor(
    continueIndex,
    message => message.type === "input-wait"
  );
  assert.equal(inputWait.message.steps, 10);
  assert.equal(inputWait.message.variable, "A");

  const inputIndex = messages.length;
  send({ type: "resolve-input", text: "7" });
  const finished = await waitFor(inputIndex, message => message.type === "finished");
  assert.equal(finished.message.steps, 11);
  const resumedEvents = messages
    .slice(inputIndex)
    .filter(message => message.type === "events")
    .flatMap(message => message.events);
  assert.deepEqual(
    resumedEvents.map(event => [event.type, event.step]),
    [["input-complete", 10], ["end", 11]]
  );
  assert.equal(
    messages.slice(inputIndex).some(message => message.type === "stop-candidate"),
    false
  );
});
