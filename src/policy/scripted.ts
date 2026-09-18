import type { FastPolicy, PolicyDecision, PolicyInput } from './types.js';

/** Test helper: delegate each tick to a function, recording inputs. */
export class ScriptedPolicy implements FastPolicy {
  readonly id: string;
  readonly inputs: PolicyInput[] = [];
  constructor(
    private readonly fn: (input: PolicyInput) => PolicyDecision,
    id = 'scripted-policy',
  ) {
    this.id = id;
  }
  decide(input: PolicyInput): PolicyDecision {
    this.inputs.push(input);
    return this.fn(input);
  }
}
