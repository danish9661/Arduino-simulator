import manifest from './manifest.json';
import { SpiRadioUI, SpiRadioContextMenu, BOUNDS, contextMenuDuringRun } from './ui';
import { SpiRadioLogic } from './logic';
import { validation } from './validation';

export default {
  manifest,
  UI: SpiRadioUI,
  LogicClass: SpiRadioLogic,
  BOUNDS,
  ContextMenu: SpiRadioContextMenu,
  contextMenuDuringRun,
  validation,
};
