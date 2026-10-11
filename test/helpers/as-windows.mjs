// Preloaded (`node --import`) into a child Reach so it takes its Windows paths
// on a Mac or Linux: process.platform says win32. Node's path module and the
// programs it can run stay the host's, so only Reach's own branching is tested.
Object.defineProperty(process, "platform", { value: "win32" });
