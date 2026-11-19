import { ToolManager } from './manager.js';

// One instance per process: management updates also apply to chat immediately.
let manager: ToolManager | undefined;
export function getToolManager(): ToolManager {
  return (manager ??= new ToolManager());
}
