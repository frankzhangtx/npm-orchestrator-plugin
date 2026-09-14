import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalLedger, PROPOSAL_APPROVAL } from "../dist/queue/approvals.js";

const context = { sessionID: "session-a", messageID: "consume-message" };
function answer(ledger, question, selected, sessionID = context.sessionID, callID = "question-call") {
  const input = { tool: "question", sessionID, callID };
  ledger.before(input, { args: question });
  ledger.after(input, { metadata: { answers: [[selected]] } });
}

test("model-supplied approval text and fabricated question output cannot create a receipt", () => {
  const ledger = new ApprovalLedger();
  ledger.prepare(context.sessionID, "enqueue", "sealed-contract", "合同确认", "Approve A?", "Approve A");
  ledger.after({ tool: "question", sessionID: context.sessionID, callID: "invented" }, { metadata: { answers: [["Approve A"]] } });
  assert.throws(() => ledger.consume(context, "enqueue", "sealed-contract"), /fresh, matching/);
});

test("receipt binds session, contract/candidate and operation and is consumed exactly once", () => {
  const ledger = new ApprovalLedger();
  const question = ledger.prepare(context.sessionID, "integrate", "A:digest:candidate", "最终验收", "Approve this candidate?", "Approve A");
  answer(ledger, question, "Approve A");
  assert.throws(() => ledger.consume({ ...context, sessionID: "session-b" }, "integrate", "A:digest:candidate"), /fresh, matching/);
  assert.throws(() => ledger.consume(context, "integrate", "A:digest:changed"), /fresh, matching/);
  assert.throws(() => ledger.consume(context, "abort", "A:digest:candidate"), /fresh, matching/);
  const proof = ledger.consume(context, "integrate", "A:digest:candidate");
  assert.equal(proof.questionCallID, "question-call");
  assert.equal(proof.messageID, context.messageID);
  assert.throws(() => ledger.consume(context, "integrate", "A:digest:candidate"), /fresh, matching/);
});

test("adjustments, multi-select questions and altered question text cannot approve", () => {
  for (const change of [q => q, q => { q.questions[0].multiple = true; return q; }, q => { q.questions[0].question = "A different contract"; return q; }]) {
    const ledger = new ApprovalLedger();
    const question = ledger.prepare(context.sessionID, "enqueue", "A", "合同确认", "Approve A?", "Approve A");
    const altered = change(structuredClone(question));
    answer(ledger, altered, JSON.stringify(altered) === JSON.stringify(question) ? "暂不批准。" : "Approve A");
    assert.throws(() => ledger.consume(context, "enqueue", "A"), /fresh, matching/);
  }
});

test("a genuine proposal choice permits only one draft and a restart requires a new question", () => {
  const ledger = new ApprovalLedger();
  answer(ledger, { questions: [{ header: "方案确认", question: "Approve the displayed proposal?", options: [{ label: PROPOSAL_APPROVAL }, { label: "调整方案。" }] }] }, PROPOSAL_APPROVAL);
  assert.equal(ledger.consume(context, "proposal", "proposal").selected, PROPOSAL_APPROVAL);
  assert.throws(() => ledger.consume(context, "proposal", "proposal"), /fresh, matching/);
  assert.throws(() => new ApprovalLedger().consume(context, "proposal", "proposal"), /fresh, matching/);
});
