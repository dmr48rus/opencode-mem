// Probe for the config default of opencodeRealSessionFallback.
//
// Run in a subprocess with USERPROFILE/HOME pointing at a throwaway home, so
// the operator's real opencode-mem.jsonc cannot decide the answer. Prints the
// resolved value and nothing else.
const [, , configUrl, directory] = process.argv;
const mod = await import(configUrl);
mod.initConfig(directory);
console.log(String(mod.CONFIG.opencodeRealSessionFallback));
