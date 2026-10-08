export function toolErrorMessage(error: unknown, browser?: string): string {
  const message =
    typeof error === "string"
      ? error
      : (error as { message?: string })?.message ||
        "The tool could not finish.";
  if (
    /Apple Events|JavaScript.*(disabled|allowed|enabled)|not authorized.*Apple|macOS Automation/i.test(
      message,
    )
  )
    return `${browser || "The browser"} needs setup by the owner: ${
      /JavaScript|Apple Events/i.test(message)
        ? `enable “Allow JavaScript from Apple Events”${/Automation/i.test(message) ? " and macOS Automation access for Reach’s Terminal" : ""}`
        : "allow Reach’s Terminal to control it in System Settings → Privacy & Security → Automation"
    }.`;
  if (
    /execution error:|\/(?:Users|home|private|Applications)\/|\.(?:mjs|js|ts):\d+/i.test(
      message,
    )
  )
    return "The browser command failed. The owner may need to check browser setup. You can continue in Screen.";
  return message;
}
