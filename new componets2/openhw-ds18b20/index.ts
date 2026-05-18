import manifest from './manifest.json';
import { DS18B20BreakoutModifiedUI, DS18B20ContextMenu, BOUNDS } from './ui';
import { DS18B20Logic } from './logic';
import { validation } from './validation';
import docHtml from './doc/index.html?raw';

export default {
    manifest,
    UI:                       DS18B20BreakoutModifiedUI,
    LogicClass:               DS18B20Logic,
    BOUNDS,
    ContextMenu:              DS18B20ContextMenu,
    contextMenuDuringRun:     true,   // slider is live-usable while running
    contextMenuOnlyDuringRun: true,   // hide the menu when simulation is stopped
    validation,
    doc: docHtml,
};