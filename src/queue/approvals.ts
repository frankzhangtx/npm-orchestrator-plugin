import type { ToolContext } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { invariant } from "./storage.js";

export interface ApprovalProof {
  id: string;
  sessionID: string;
  messageID: string;
  questionCallID: string;
  kind: string;
  binding: string;
  selected: string;
  approvedAt: string;
}
interface Question {
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
}
interface Challenge {
  kind: string;
  binding: string;
  question: Question;
  preparedAt: number;
}
interface Selection extends Challenge { proof: Omit<ApprovalProof, "messageID"> }
const MAX_AGE_MS = 15 * 60 * 1000;
export const PROPOSAL_APPROVAL = "批准方案，生成计划和任务合同。";

/** Only the host's completed question hook creates a receipt. Losing the plugin
 * process loses unconsumed receipts and requires another question, never an
 * automatic approval. The consumed proof is copied into durable queue records. */
export class ApprovalLedger {
  private readonly challenges = new Map<string, Challenge>();
  private readonly pending = new Map<string, Challenge>();
  private readonly selections = new Map<string, Selection>();

  prepare(sessionID: string, kind: string, binding: string, header: string, question: string, approval: string): { questions: Question[] } {
    const challenge: Challenge = { kind, binding, preparedAt: Date.now(), question: {
      header, question, multiple: false,
      options: [{ label: approval, description: "确认已展示的这份方案或成果。" }, { label: "暂不批准。", description: "保留当前内容，调整后重新确认。" }],
    } };
    this.challenges.set(sessionID, challenge);
    this.selections.delete(sessionID);
    return { questions: [challenge.question] };
  }

  before(input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }): void {
    if (input.tool !== "question") return;
    this.selections.delete(input.sessionID);
    const questions = (output.args as { questions?: Question[] })?.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return;
    const question = questions[0]!;
    if (!question || question.multiple === true || !Array.isArray(question.options) || question.options.length !== 2) return;
    let challenge = this.challenges.get(input.sessionID);
    if (question.header === "方案确认" && question.options[0]?.label === PROPOSAL_APPROVAL &&
        question.options[1]?.label !== PROPOSAL_APPROVAL && typeof question.question === "string") {
      challenge = { kind: "proposal", binding: "proposal", question, preparedAt: Date.now() };
    } else if (!challenge || Date.now() - challenge.preparedAt > MAX_AGE_MS ||
        question.header !== challenge.question.header || question.question !== challenge.question.question ||
        question.options.some((option, index) => option.label !== challenge!.question.options[index]?.label)) return;
    this.challenges.delete(input.sessionID);
    this.pending.set(`${input.sessionID}/${input.callID}`, structuredClone(challenge));
  }

  after(input: { tool: string; sessionID: string; callID: string }, output: { metadata: unknown }): void {
    if (input.tool !== "question") return;
    const key = `${input.sessionID}/${input.callID}`;
    const challenge = this.pending.get(key);
    this.pending.delete(key);
    if (!challenge) return;
    const answers = (output.metadata as { answers?: unknown })?.answers;
    if (!Array.isArray(answers) || answers.length !== 1 || !Array.isArray(answers[0]) ||
        answers[0].length !== 1 || answers[0][0] !== challenge.question.options[0]!.label) return;
    this.selections.set(input.sessionID, { ...challenge, proof: {
      id: randomUUID(), sessionID: input.sessionID, questionCallID: input.callID,
      kind: challenge.kind, binding: challenge.binding, selected: answers[0][0] as string, approvedAt: new Date().toISOString(),
    } });
  }

  consume(context: Pick<ToolContext, "sessionID" | "messageID">, kind: string, binding: string): ApprovalProof {
    const selected = this.selections.get(context.sessionID);
    invariant(selected && selected.kind === kind && selected.binding === binding &&
      Date.now() - Date.parse(selected.proof.approvedAt) <= MAX_AGE_MS,
    "A fresh, matching single-choice question selection is required; approval text is not a receipt");
    this.selections.delete(context.sessionID);
    return { ...selected.proof, messageID: context.messageID };
  }
}
