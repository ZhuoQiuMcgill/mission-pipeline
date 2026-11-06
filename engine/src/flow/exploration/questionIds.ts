import { idPart, safeId } from '../context.ts';

/** Shared by the question's producer, its notice and the decision applier. */
export const explorationEscalation = (mission: string, exploration: string, what: string): string => safeId(`xp.${mission}.${idPart(exploration)}.${what}`);
export const authorQuestionEscalation = (mission: string, exploration: string, task: string): string => explorationEscalation(mission, exploration, `dq.${task.split('.').at(-2) ?? task}`);
export const findingQuestionEscalation = (mission: string, exploration: string, finding: string, rulings: readonly {findings: readonly string[]}[]): string => explorationEscalation(mission, exploration, `q.${finding.slice(8, 24)}.${rulings.filter((r) => r.findings.includes(finding)).length}`);
