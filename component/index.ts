import manifest from './manifest.json';
import { LdrModuleUI, LdrContextMenu, BOUNDS } from './ui';
import { LdrModuleLogic } from './logic';
import { validation } from './validation';

export default {
    manifest,
    UI: LdrModuleUI,
    LogicClass: LdrModuleLogic,
    BOUNDS,                          
    ContextMenu: LdrContextMenu,
    contextMenuDuringRun: true,      // Allows the menu to be visible while playing
    contextMenuOnlyDuringRun: true,  // CRITICAL: Forces the menu to hide when simulation is stopped
    validation
};