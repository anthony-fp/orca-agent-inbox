// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'
import { EMPTY_VIEW, ONE_AGENT, THREE_AGENTS } from './panel-views'

export default defineCheck({
  empty: { requests: { 'inbox.view': EMPTY_VIEW } },
  oneAgent: { requests: { 'inbox.view': ONE_AGENT } },
  threeAgents: { requests: { 'inbox.view': THREE_AGENTS } },
})
