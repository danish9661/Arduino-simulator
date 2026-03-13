import manifest from './manifest.json';
import { ILI9341UI, ILI9341ContextMenu } from './ui';
import { ILI9341Logic } from './logic';
import { validation } from './validation';

export default {
    manifest,
    UI: ILI9341UI,
    Logic: ILI9341Logic,        // Failsafe based on OLED code
    LogicClass: ILI9341Logic,   // As per original spec manual
    ContextMenu: ILI9341ContextMenu,
    contextMenuDuringRun: true, 
    validation
};