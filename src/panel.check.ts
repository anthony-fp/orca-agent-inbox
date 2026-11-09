// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'
import { CLOSED_FINDINGS, CODEX_ONLY, EMPTY_VIEW, FINDINGS, MANY_OPTIONS, MIXED, ONE_AGENT, PLAN, ROW_BUTTONS, STEPS, THREE_AGENTS } from './panel-views'

export default defineCheck({
  empty: { requests: { 'inbox.view': EMPTY_VIEW } },
  oneAgent: { requests: { 'inbox.view': ONE_AGENT } },
  threeAgents: { requests: { 'inbox.view': THREE_AGENTS } },
  manyOptions: { requests: { 'inbox.view': MANY_OPTIONS } },
  steps: { requests: { 'inbox.view': STEPS } },
  findings: { requests: { 'inbox.view': FINDINGS } },
  closedFindings: { requests: { 'inbox.view': CLOSED_FINDINGS } },
  plan: { requests: { 'inbox.view': PLAN } },
  noToolsAndCodex: { requests: { 'inbox.view': MIXED } },
  codexOnly: { requests: { 'inbox.view': CODEX_ONLY } },
  rowButtons: { requests: { 'inbox.view': ROW_BUTTONS } },
})
