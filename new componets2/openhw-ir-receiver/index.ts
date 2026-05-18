import { validation } from './validation';
import manifest from './manifest.json';
import { IRReceiverLogic } from './logic';
import { IRReceiverUI, IRReceiverContextMenu } from './ui';

export default {
    manifest,
    LogicClass: IRReceiverLogic,
    UI: IRReceiverUI,
    ContextMenu: IRReceiverContextMenu,
    contextMenuDuringRun: false,
    contextMenuOnlyDuringRun: true,
    validation,
};
