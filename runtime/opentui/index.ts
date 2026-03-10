import { startOpenTuiBootstrap } from "./bootstrap.js";

await startOpenTuiBootstrap({
  renderer: {
    exitOnCtrlC: true,
    targetFps: 30,
  },
});
