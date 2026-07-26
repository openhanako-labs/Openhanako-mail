export default class HanakoMailPlugin {
  async onload() {
    const ctx = this.ctx;
    ctx.log?.info?.("hanako-mail loaded", { pluginId: ctx.pluginId });
  }

  async onunload() {
    this.ctx.log?.info?.("hanako-mail unloaded");
  }
}
