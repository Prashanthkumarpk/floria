/**
 * Component.ts
 *
 * SAP UI5 Application Component — the root entry point for Floria.
 *
 * This class is instantiated once by the UI5 bootstrap when index.html loads.
 * It delegates all routing and model registration to manifest.json, which
 * defines the single route "/chat" mapped to the Chat view.
 *
 * The `manifest: "json"` metadata flag tells UI5 to read the component
 * descriptor from webapp/manifest.json automatically. All application-level
 * configuration (routing, data sources, resource roots, theme, library
 * dependencies) lives there rather than here to keep this class minimal.
 */

import UIComponent from "sap/ui/core/UIComponent";

/**
 * @namespace research.chat
 */
export default class Component extends UIComponent {
  public static readonly metadata = {
    manifest: "json"
  };

  /**
   * Lifecycle: called once after the component is created.
   * Calls super.init() first — required to trigger manifest processing and
   * model/routing initialisation defined in manifest.json.
   * Then initialises the router so the "/" route renders the Chat view.
   */
  public init(): void {
    super.init();
    this.getRouter().initialize();
  }
}
