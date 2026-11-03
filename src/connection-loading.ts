// The public entry and workspace describe one connection while transports prepare.
export function connectionLoading(slow = false) {
  return {
    title: slow ? "Still connecting" : "Connecting to your computer",
    detail: slow ? "Make sure your computer is awake and Reach is running. We’ll keep trying for you." :
      "Your workspace will open here when the connection is ready.",
    status: slow ? "Taking longer than usual…" : "Connecting securely…",
  };
}
