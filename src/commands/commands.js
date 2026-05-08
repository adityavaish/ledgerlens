/**
 * Ledgerlens — Ribbon Commands.
 * Functions referenced by the manifest for ribbon button actions.
 */

/* global Office */

Office.onReady(() => {
  // Commands are ready
});

/**
 * Default action for the ribbon button — opens the taskpane.
 * The manifest uses ShowTaskpane action, so this file simply needs to exist
 * as the FunctionFile. Add future ribbon command functions here.
 */
function openPivotPane(event) {
  // Taskpane opens automatically via ShowTaskpane action
  event.completed();
}

// Register functions for ribbon commands
if (typeof Office !== "undefined" && Office.actions) {
  Office.actions.associate("openPivotPane", openPivotPane);
}
