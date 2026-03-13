import manifest from './manifest.json';
import { LdrModuleUI, LdrContextMenu, BOUNDS } from './ui';
import { LdrModuleLogic } from './logic';
import { validation } from './validation';

export default {
    manifest,
    UI: LdrModuleUI,
    Logic: LdrModuleLogic,           // Keeping original format just in case
    LogicClass: LdrModuleLogic,      // Documented format
    BOUNDS,
    ContextMenu: LdrContextMenu,
    contextMenuDuringRun: true,      // Tells simulator not to hide the menu when playing
    contextMenuOnlyDuringRun: true,  // Tells simulator ONLY to show the menu when playing
    validation
};