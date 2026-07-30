/**
 * Ticket Triage — a real, small core/workflow.js definition. Shared by
 * setup.js and the regression test so the demo and test can't drift apart.
 *
 * urgent (filter) -> hasUrgent (if, onFalse: 'skip') -> escalate (set.value)
 *
 * `escalate`'s `_dependsOn: '{{hasUrgent}}'` input is not used by
 * `set.value`'s handler (it only reads `inputs.value`) — it exists purely
 * to force a real DAG dependency. workflow.js infers node ordering ONLY
 * from `{{ref}}` occurrences in a node's own `inputs`; without this,
 * `escalate` never mentions `hasUrgent` at all, so it lands in the SAME
 * DAG level as `hasUrgent` (both depend only on `urgent`) and runs
 * concurrently via `Promise.allSettled` — dispatched before the `if`
 * node's `onFalse: 'skip'` check even happens. Verified live: without this
 * line, `escalate` ran even when there were zero urgent tickets. See
 * README for the full before/after.
 */

export const TRIAGE_WORKFLOW_NAME = 'Ticket Triage';

export const TRIAGE_WORKFLOW_DEFINITION = {
  name: TRIAGE_WORKFLOW_NAME,
  description: 'Filters urgent tickets from a batch and escalates only when at least one exists.',
  trigger: { type: 'manual' },
  nodes: [
    {
      id: 'urgent',
      type: 'filter',
      inputs: { items: '{{_trigger.tickets}}', field: 'priority', operator: '==', value: 'urgent' },
    },
    {
      id: 'hasUrgent',
      type: 'if',
      inputs: { value: '{{urgent.length}}', operator: '>', compare: 0 },
      onFalse: 'skip',
    },
    {
      id: 'escalate',
      type: 'set.value',
      inputs: {
        value: 'Escalating {{urgent.length}} urgent ticket(s)',
        _dependsOn: '{{hasUrgent}}',
      },
    },
  ],
};
