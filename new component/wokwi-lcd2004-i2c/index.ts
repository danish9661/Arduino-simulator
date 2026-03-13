import manifest from './manifest.json';
import { Lcd2004I2CUI } from './ui';
import { Lcd2004I2CLogic } from './logic';
import { validation } from './validation';

export default { manifest, UI: Lcd2004I2CUI, Logic: Lcd2004I2CLogic, validation };