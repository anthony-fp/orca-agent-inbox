// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// T0 has no requests or panel events yet.
export {}

declare module 'orca' {
  interface PluginRequests {}
  interface PluginPanelEvents {}
}
