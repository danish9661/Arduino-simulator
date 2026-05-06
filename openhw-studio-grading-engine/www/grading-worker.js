import init, { grade_circuits } from '../pkg/openhw_studio_grading_engine.js';

onmessage = async (e) => {
    const { teacher, student, options } = e.data;
    
    // Initialize WASM
    await init();
    
    // Run comparison
    const result = grade_circuits(
        new Uint8Array(teacher),
        new Uint8Array(student),
        options
    );
    
    postMessage(result);
};
