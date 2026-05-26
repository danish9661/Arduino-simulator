#define setup _sim_user_setup
#define loop  _sim_user_loop


#undef setup
#undef loop
#include &quot;SimulatorBridge.h&quot;

void setup() {
    _simBridgeInit_Early();
    _sim_user_setup();
    _simBridgeInit_Late();
    if (!_sim_ready_sent) sim_ready();
}

void loop() {
    _sim_user_loop();
}
