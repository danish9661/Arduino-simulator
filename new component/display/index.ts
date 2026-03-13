import manifest from './manifest.json';
import { MAX7219UI } from './ui';
import { MAX7219Logic } from './logic';
import { validation } from './validation';

export default { 
    manifest, 
    UI: MAX7219UI, 
    Logic: MAX7219Logic, 
    validation 
};