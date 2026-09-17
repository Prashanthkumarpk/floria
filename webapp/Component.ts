import UIComponent from "sap/ui/core/UIComponent";

/**
 * @namespace research.chat
 */
export default class Component extends UIComponent {
  public static readonly metadata = {
    manifest: "json"
  };

  public init(): void {
    super.init();
    this.getRouter().initialize();
  }
}
