// The desktop policy corpus every implementation decides the same way: the
// server's JavaScript (server/agent-guard.mjs, server/money-sites.mjs), a
// Mac's Swift helper and a Windows PC's C# helper (scripts/native/
// agent-desktop.swift and agent-desktop.cs; docs/parity/B-desktop-helper.md
// §13.2). Plain data, then what turns it into checks for each language.
//
// - Bank sites: one corpus, decided by JavaScript, Swift and C#
//   (test/money-sites.test.mjs, test/agent-desktop-windows-policy.test.mjs).
// - The Mac's data (nativeRules for darwin): the cases the Swift policy test
//   checks (test/agent-desktop-policy-native.test.mjs keeps its own copy, a
//   file only a Mac runs), decided here by C#.
// - Windows' data (nativeRules for win32): JavaScript is the oracle where it
//   decides the same question; the rest is Windows' own (Settings pages,
//   package families, the compositor, program files).
import { nativeRules, protectedAppReason, protectedPage, protectedTitle, terminalLikeApp, windowsProgramFile } from "../../server/agent-guard.mjs";
import { MONEY_BUTTON_REASON, MONEY_FIELD_REASON, MONEY_LABEL_REASON, MONEY_PAGE_REASON, MONEY_REASON } from "../../server/money-sites.mjs";

// --- Bank sites ---------------------------------------------------------------
export const overview = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview";
export const signIn = "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline";
export const payBills = "https://secure.chase.com/web/auth/dashboard#/dashboard/payMultipleBills/entry";
export const amex = "https://global.americanexpress.com/activity/statements";
export const home = "https://my.wealthsimple.com/app/home";
export const rbc = "https://www1.royalbank.com/sgw1/olb/index-fr/#/summary";
export const rbcSignIn = "https://secure.royalbank.com/statics/login-service-ui/index#/full/signin?LANGUAGE=FRENCH";
export const rbcTransfer = "https://www1.royalbank.com/sgw1/olb/index-fr/#/virements/entree";
export const sites = [
  [overview, true], ["https://www.bankofamerica.com/", true], ["https://mabanque.bnpparibas/fr/connexion", true],
  ["https://card.apple.com/", true], ["https://www.apple.com/", false], ["https://chase.com.evil.test/", false],
  ["https://notchase.com/", false], ["https://secure.chase.com./", true], ["chrome://newtab/", false], ["", false],
  ["https://user@secure07a.chase.com:443/x", true], ["https://example.com/?next=chase.com", false],
  // The owner's banks: RBC, TD, Wealthsimple, American Express.
  ["https://secure.royalbank.com/statics/login-service-ui/index", true], ["https://www.rbcroyalbank.com/", true],
  ["https://easyweb.td.com/waw/ezw/webbanking", true], ["https://authentication.td.com/uap-ui/", true],
  ["https://my.wealthsimple.com/app/activity", true], ["https://global.americanexpress.com/activity/recent", true],
  ["https://www.americanexpress.com/en-ca/account/login", true], ["https://www.avionrewards.com/", true],
];
export const pages = [
  [overview, "Overview", ""], [payBills, "Chase", "move"], [signIn, "Sign in", "auth"],
  ["https://www.wellsfargo.com/transfers/", "Wells Fargo", "move"], ["https://www.bankofamerica.com/accounts/", "Send money with Zelle", "move"],
  ["https://secure.bankofamerica.com/login/sign-in/signOnV2Screen.go", "Sign in", "auth"],
  ["https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs", "Statements & documents", "read"],
  [amex, "Statements & Activity", "read"], [home, "Home", ""],
  [rbcTransfer, "RBC", "move"], [rbc, "Activité du compte", "read"], [rbc, "Virement Interac", "move"], [rbcSignIn, "Connexion", "auth"],
  [rbc, "Relevés électroniques", "read"], ["https://www.paypal.com/activity", "Activity", "read"],
  // A payment form in a frame served from elsewhere locks the bank's page.
  [`https://pay.processor-example.com/billpay/entry ${overview}`, "Overview", "move"],
  [`about:blank ${overview}`, "Overview", ""],
];
export const frames = [
  [["https://pay.processor-example.com/form", overview], true], [["about:blank", "https://www.chase.com/"], true],
  [["https://pay.processor-example.com/form"], false], [["https://example.com/", "https://example.org/?chase.com"], false],
];
// [url, title, labels, role, refused-with]
export const clicks = [
  [overview, "Overview", ["Statements & documents"], "AXLink", null],
  [overview, "Overview", ["TOTAL CHECKING (...1234)"], "AXLink", null],
  [overview, "Overview", ["Pay card"], "AXButton", MONEY_REASON],
  [overview, "Overview", ["Pay", "Pay card"], "AXButton", MONEY_REASON],
  [overview, "Overview", ["Transfer money"], "AXLink", MONEY_REASON],
  [overview, "Overview", ["Send money with Zelle®"], "AXLink", MONEY_REASON],
  [overview, "Overview", ["Submit"], "AXButton", MONEY_REASON],
  [overview, "Overview", ["Continue"], "AXButton", MONEY_REASON],
  [overview, "Overview", ["Lock card"], "AXSwitch", MONEY_REASON],
  [overview, "Overview", ["Profile & settings"], "AXLink", MONEY_REASON],
  [overview, "Overview", [""], "AXButton", MONEY_LABEL_REASON],
  [overview, "Overview", [], "AXButton", MONEY_LABEL_REASON],
  [overview, "Overview", ["", "Download"], "AXButton", null],
  [overview, "Overview", ["Show more"], "AXButton", null],
  [overview, "Overview", ["Next page"], "AXButton", null],
  [overview, "Overview", ["Sign out"], "AXButton", null],
  [overview, "Overview", ["Search transactions"], "AXTextField", null],
  [overview, "Overview", ["Amount"], "AXTextField", null],
  [overview, "Overview", [""], "AXGroup", null],
  [signIn, "Sign in", ["Sign in"], "AXButton", null],
  [signIn, "Sign in", ["Continue"], "AXButton", null],
  [signIn, "Sign in", ["Send me a code"], "AXButton", null],
  [signIn, "Sign in", ["Send money"], "AXButton", MONEY_REASON],
  [signIn, "Sign in", ["Remember this device"], "AXCheckBox", MONEY_REASON],
  [payBills, "Chase", ["Pay"], "AXButton", MONEY_PAGE_REASON],
  [payBills, "Chase", ["Next"], "AXButton", MONEY_PAGE_REASON],
  [payBills, "Chase", ["Amount"], "AXTextField", MONEY_PAGE_REASON],
  [payBills, "Chase", ["Cancel"], "AXButton", null],
  [payBills, "Chase", ["Accounts"], "AXLink", null],
  [payBills, "Chase", ["Sign out"], "AXButton", null],
  // Buttons say only reading words; a reading page's steps go on.
  [amex, "Statements & Activity", ["Download"], "AXButton", null],
  [amex, "Statements & Activity", ["Continue"], "AXButton", null],
  [amex, "Statements & Activity", ["CSV"], "AXRadioButton", null],
  [amex, "Statements & Activity", ["Include all additional transaction details"], "AXCheckBox", null],
  [amex, "Statements & Activity", ["Télécharger"], "AXButton", null],
  [amex, "Statements & Activity", ["Pay bill"], "AXButton", MONEY_REASON],
  [home, "Home", ["Visa Infinite ••1234"], "AXButton", null],
  [home, "Home", ["Go"], "AXButton", MONEY_BUTTON_REASON],
  [home, "Home", ["Get started"], "AXButton", MONEY_BUTTON_REASON],
  [home, "Home", ["Boost your rate"], "AXButton", MONEY_BUTTON_REASON],
  [home, "Home", ["Enroll in perks"], "AXPressable", MONEY_REASON],
  [home, "Home", [""], "AXPressable", MONEY_LABEL_REASON],
  [home, "Home", ["TFSA", "Personal TFSA $12,345.67"], "AXPressable", null],
  [home, "Home", ["Boost your rate"], "AXLink", MONEY_BUTTON_REASON],
  [home, "Home", ["Offers for you"], "AXPressable", MONEY_BUTTON_REASON],
  [home, "Home", ["Account Services"], "AXLink", null],
  [home, "Home", ["Opportunity 2026"], "AXLink", null],
  // French: the same rules, word for word; any other language presses nothing.
  [rbc, "Sommaire des comptes", ["Payer"], "AXLink", MONEY_REASON],
  [rbc, "Sommaire des comptes", ["Virement Interac"], "AXLink", MONEY_REASON],
  [rbc, "Sommaire des comptes", ["Envoyer de l'argent"], "AXPressable", MONEY_REASON],
  [rbc, "Sommaire des comptes", ["Confirmer"], "AXButton", MONEY_REASON],
  [rbc, "Sommaire des comptes", ["Paramètres"], "AXLink", MONEY_REASON],
  [rbc, "Sommaire des comptes", ["Relevés électroniques"], "AXLink", null],
  [rbc, "Sommaire des comptes", ["Télécharger"], "AXButton", null],
  [rbc, "Sommaire des comptes", ["Activité"], "AXTab", null],
  [rbc, "Sommaire des comptes", ["Visa Infinite Avion ••1234 1 234,56 $"], "AXLink", null],
  [rbc, "Sommaire des comptes", ["Se déconnecter"], "AXButton", null],
  [rbcSignIn, "Connexion", ["Se connecter"], "AXButton", null],
  [rbcSignIn, "Connexion", ["Continuer"], "AXButton", null],
  [rbcSignIn, "Connexion", ["Envoyer le code"], "AXButton", null],
  [rbcTransfer, "RBC", ["Continuer"], "AXButton", MONEY_PAGE_REASON],
  [rbcTransfer, "RBC", ["Annuler"], "AXButton", null],
  [rbc, "Sommaire des comptes", ["Transferir dinero"], "AXLink", MONEY_BUTTON_REASON],
  [rbc, "Sommaire des comptes", ["Überweisen"], "AXButton", MONEY_BUTTON_REASON],
  [rbc, "Sommaire des comptes", ["送金"], "AXButton", MONEY_BUTTON_REASON],
  [rbc, "Sommaire des comptes", ["paypal"], "AXLink", MONEY_BUTTON_REASON],
];
// [url, title, label, secure, secret, refused-with]
export const typing = [
  [signIn, "Sign in", "Username", false, true, null],
  [signIn, "Sign in", "Username", false, false, null],
  [signIn, "Sign in", "Password", true, true, null],
  [signIn, "Sign in", "Password", true, false, MONEY_FIELD_REASON],
  [signIn, "Sign in", "Enter your one-time code", false, false, null],
  [overview, "Overview", "Search transactions", false, false, null],
  [overview, "Overview", "From date", false, false, null],
  [overview, "Overview", "Amount", false, false, MONEY_FIELD_REASON],
  [overview, "Overview", "Amount", false, true, MONEY_FIELD_REASON],
  [overview, "Overview", "Memo", false, false, MONEY_FIELD_REASON],
  [overview, "Overview", "Recipient's email", false, false, MONEY_FIELD_REASON],
  [overview, "Overview", "Routing number", false, false, MONEY_FIELD_REASON],
  [overview, "Overview", "", false, false, MONEY_FIELD_REASON],
  [overview, "Overview", "Nickname", false, false, MONEY_FIELD_REASON],
  [payBills, "Chase", "Search", false, false, MONEY_PAGE_REASON],
  [overview, "Overview", "Email address", false, false, null],
  [overview, "Overview", "Mailing address", false, false, MONEY_FIELD_REASON],
  [rbcSignIn, "Connexion", "Numéro de carte-client ou nom d'utilisateur", false, true, null],
  [rbcSignIn, "Connexion", "Mot de passe", true, true, null],
  [rbcSignIn, "Connexion", "Adresse courriel", false, false, null],
  [rbc, "Sommaire des comptes", "Rechercher des opérations", false, false, null],
  [rbc, "Sommaire des comptes", "Du", false, false, null],
  [rbc, "Sommaire des comptes", "Montant", false, false, MONEY_FIELD_REASON],
  [rbc, "Sommaire des comptes", "Courriel du destinataire", false, false, MONEY_FIELD_REASON],
  [rbc, "Sommaire des comptes", "Numéro de compte", false, false, MONEY_FIELD_REASON],
  [rbc, "Sommaire des comptes", "Betrag", false, false, MONEY_FIELD_REASON],
];
// [url, title, key, command, control, field, secure, labels, role, refused-with]
export const keys = [
  [overview, "Overview", "v", true, false, true, false, ["Search"], "AXTextField", "On a bank site the agent doesn't paste or drag."],
  [overview, "Overview", "[", true, false, false, false, [], "", null],
  [overview, "Overview", "tab", false, false, false, false, [], "", null],
  [overview, "Overview", "pagedown", false, false, false, false, [], "", null],
  [overview, "Overview", "enter", false, false, false, false, ["Pay card"], "AXButton", MONEY_REASON],
  [overview, "Overview", "space", false, false, false, false, ["Statements"], "AXLink", null],
  [overview, "Overview", "enter", true, false, false, false, ["Submit"], "AXButton", MONEY_REASON],
  [overview, "Overview", "enter", false, false, true, false, ["Search transactions"], "AXTextField", null],
  [overview, "Overview", "enter", false, false, true, false, ["Amount"], "AXTextField", MONEY_FIELD_REASON],
  [signIn, "Sign in", "enter", false, false, false, true, ["Password"], "AXSecureTextField", null],
  [overview, "Overview", "5", false, false, true, false, ["Amount"], "AXTextField", MONEY_FIELD_REASON],
  [overview, "Overview", "r", true, false, false, false, [], "", null],
  [payBills, "Chase", "r", true, false, false, false, [], "", MONEY_PAGE_REASON],
  [payBills, "Chase", "escape", false, false, false, false, [], "", null],
  [payBills, "Chase", "enter", false, false, false, false, ["Pay"], "AXButton", MONEY_PAGE_REASON],
];
export const masks = [
  ["Checking 123456789012", "Checking ••••9012"], ["Card 4111 1111 1111 1111", "Card ••••1111"], ["4111-1111-1111-1111", "••••1111"],
  ["Posted 2026-10-10", "Posted 2026-10-10"], ["$12,345,678.90", "$12,345,678.90"], ["...1234", "...1234"], ["12345678.50", "12345678.50"],
];

// --- Reach's own addresses: the shared authority corpus -----------------------
// [url, refused]: an exact copy of agent-desktop-policy-native.test.mjs's
// (checked to stay so by test/agent-desktop-windows-policy.test.mjs).
export const reachUrlCases = [
  ["https://example.com/help/mac.tail1234.ts.net", false],
  ["https://example.com/search?q=localhost:8443", false],
  ["https://example.com/#https://mac.tail1234.ts.net/", false],
  ["https://example.com:443/?next=localhost:8443", false],
  ["https://user:pass@example.com/mac.tail1234.ts.net", false],
  ["http://127.0.0.2:8443/?next=localhost:8443", false],
  ["http://[::2]:8443/?next=localhost:8443", false],
  ["https://example.com./?next=localhost:8443", false],
  ["https://example.com/%20?next=localhost:8443", false],
  ["https://example.com/?price=$5&next=localhost:8443", false],
  ["https://mac.tail1234.ts.net/", true], ["http://localhost:8443/", true],
  ["https://mac.tail1234.ts.net@ordinary.test/", true],
  ["https://ordinary.test@mac.tail1234.ts.net/", true],
  ["https://mac.tail1234.ts.net.evil.test/", true], ["http://localhost:84430/", true],
  ["https://mac.tail1234.ts.net./", true], ["example.com/help/mac.tail1234.ts.net", true],
  ["//example.com/?next=localhost:8443", true], ["ftp://example.com/mac.tail1234.ts.net", true],
  ["https:///example.com/?next=localhost:8443", true],
  ["https://example.com:65536/?next=localhost:8443", true],
  ["https://example.com:bad/?next=localhost:8443", true],
  ["https://example.com/%zz?next=localhost:8443", true],
  ["https://%65xample.com/?next=localhost:8443", true],
  ["https://example.com/space here?next=localhost:8443", true],
  ["https://example.com/\t?next=localhost:8443", true],
  [String.raw`https://example.com\@localhost:8443/`, true],
  ["https://例子.example/?next=localhost:8443", true],
  ["http://127.1/?next=localhost:8443", true], ["http://2130706433/?next=localhost:8443", true],
  ["http://256.1/?next=localhost:8443", true], ["http://[::::]/?next=localhost:8443", true],
  ["http://[1:2:3]/?next=localhost:8443", true],
  ['https://example.com/"localhost:8443"', true],
  ["https://example.com/'localhost:8443'", true],
  ["https://example.com/\u202e?next=localhost:8443", true],
];
const HOSTS = ["mac.tail1234.ts.net", "localhost:8443"];

// --- The Mac's data -----------------------------------------------------------
// Rules as the server sends them, by name, for both platforms' data.
export function corpusRules(platform) {
  const home = platform === "win32" ? String.raw`C:\Users\me` : "/Users/me";
  const rules = (preset, extra = {}) => nativeRules({ preset, ...extra }, { hosts: HOSTS, titles: ["reach"], protectedPaths: [], home, platform });
  if (platform === "win32") {
    const notepad = { id: String.raw`C:\Windows\System32\notepad.exe`, bundleId: "", name: "Notepad" };
    const calculator = { id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", bundleId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator" };
    return {
      restricted: rules("readonly", { hidden: [{ id: String.raw`C:\Program Files\Messenger\Messenger.exe`, bundleId: "exe:messenger.exe", name: "Messenger" }] }),
      apps: rules("apps", { apps: [notepad, calculator] }), view: rules("readonly"), full: rules("full"),
    };
  }
  const chrome = { id: "/Applications/Google Chrome.app", bundleId: "com.google.Chrome" };
  return {
    restricted: rules("readonly", { hidden: [{ id: "/System/Applications/Messages.app", bundleId: "com.apple.MobileSMS", name: "Messages" }] }),
    apps: rules("apps", { apps: [chrome] }), view: rules("readonly"), full: rules("full"),
  };
}
// One check: [function, rules name, arguments, expected]. Expected is a
// reason's name (protectedReason, reachReason, hiddenReason,
// notAllowedReason), null for none, "refused" for any reason, or a value.
const NIL = null;
export const macCases = [];
{
  const c = (fn, rules, args, expected) => macCases.push([fn, rules, args, expected]);
  // Full control bypasses content restrictions; narrow presets keep them.
  for (const title of ["nalebc/reach · GitHub", "Reach", "Password Manager", "DevTools", "Privacy & Security"]) c("titleReason", "full", [title, "com.google.Chrome"], NIL);
  for (const url of ["https://mac.tail1234.ts.net/", "chrome://password-manager/passwords", "devtools://devtools/"]) c("urlReason", "full", [url], NIL);
  c("appReason", "full", ["com.apple.keychainaccess", "Keychain Access", ""], NIL);
  c("appReason", "full", ["io.tailscale.ipn.macos", "Tailscale", ""], NIL);
  c("appReason", "full", ["com.reach.app", "Reach", ""], NIL);
  for (const [bundle, name, path] of [
    ["com.apple.keychainaccess", "Keychain Access", "/System/Applications/Utilities/Keychain Access.app"],
    ["com.apple.Passwords", "Passwords", "/System/Applications/Passwords.app"],
    ["com.1password.1password", "1Password", "/Applications/1Password.app"],
    ["com.bitwarden.desktop", "Bitwarden", "/Applications/Bitwarden.app"],
    ["com.apple.ScreenContinuity", "iPhone Mirroring", "/System/Applications/iPhone Mirroring.app"],
    ["com.apple.ActivityMonitor", "Activity Monitor", "/System/Applications/Utilities/Activity Monitor.app"],
    ["com.apple.SecurityAgent", "SecurityAgent", "/System/Library/CoreServices/SecurityAgent.app"],
    ["io.tailscale.ipn.macos", "Tailscale", "/Applications/Tailscale.app"],
    ["com.reach.app", "Reach", "/Applications/Reach.app"],
    ["", "", "/Applications/Reach.app"],
  ]) for (const rules of ["restricted", "apps", "view"]) c("appReason", rules, [bundle, name, path], "refused");
  c("appReason", "restricted", ["com.apple.keychainaccess", "x", ""], "protectedReason");
  c("appReason", "restricted", ["io.tailscale.ipn.macos", "Tailscale", ""], "reachReason");
  for (const [bundle, name] of [["com.google.Chrome", "Google Chrome"], ["com.apple.Safari", "Safari"], ["com.apple.Terminal", "Terminal"], ["com.apple.finder", "Finder"],
    ["com.apple.mail", "Mail"], ["com.example.Preacher", "Preacher"], ["com.apple.systempreferences", "System Settings"]])
    c("appReason", "restricted", [bundle, name, `/Applications/${name}.app`], NIL);
  c("appReason", "restricted", ["com.apple.MobileSMS", "Messages", "/System/Applications/Messages.app"], "hiddenReason");
  c("appReason", "restricted", ["com.other.Messenger", "Messages", "/Applications/Other.app"], "hiddenReason");
  c("appReason", "apps", ["com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app"], NIL);
  c("appReason", "apps", ["", "", "/Applications/Google Chrome.app"], NIL);
  c("appReason", "apps", ["com.apple.Safari", "Safari", "/Applications/Safari.app"], "notAllowedReason");
  c("appReason", "apps", ["com.apple.finder", "Finder", ""], "notAllowedReason");
  c("appReason", "apps", ["com.google.Chrome.helper", "Google Chrome Helper", ""], "notAllowedReason");
  c("titleReason", "restricted", ["reach — node — 80x24", "com.apple.Terminal"], "reachReason");
  c("titleReason", "restricted", ["Reach", "com.google.Chrome"], "reachReason");
  c("titleReason", "apps", ["Reach", "com.google.Chrome"], "reachReason");
  c("titleReason", "apps", ["Password Manager", "com.google.Chrome"], "protectedReason");
  c("titleReason", "restricted", ["Preacher notes", "com.apple.Notes"], NIL);
  c("titleReason", "restricted", ["Privacy & Security", "com.apple.systempreferences"], "protectedReason");
  c("titleReason", "restricted", ["Displays", "com.apple.systempreferences"], NIL);
  c("titleReason", "restricted", ["Privacy & Security", "com.google.Chrome"], NIL);
  c("titleReason", "restricted", ["DevTools - amazon.com", "com.google.Chrome"], "protectedReason");
  c("titleReason", "restricted", ["Password Manager", "com.google.Chrome"], "protectedReason");
  c("titleReason", "restricted", ["Passwords", "com.apple.Safari"], "protectedReason");
  c("titleReason", "restricted", ["Reset your passwords - Help Center", "com.google.Chrome"], NIL);
  c("titleReason", "restricted", ["Force Quit Applications", "com.apple.loginwindow"], "protectedReason");
  c("titleReason", "restricted", ["", "com.google.Chrome"], NIL);
  // A verified Mail identity's subjects (never verified on Windows, where
  // this context never arrives; the pure rule is the same).
  for (const title of ["Reach out to Alice tomorrow", "Order confirmation: replacement keychain"]) {
    for (const rules of ["restricted", "apps", "view"]) c("titleReason", rules, [title, "com.apple.mail", true], NIL);
    c("titleReason", "restricted", [title, "com.apple.mail"], "refused");
    c("titleReason", "restricted", [title, "com.google.Chrome", true], "refused");
  }
  for (const title of ["Keychain", "Keychain Access", "Unlock your keychain", "Enter the keychain password", "Keychain authentication", "Password Manager", "Saved passwords", "Web Inspector"])
    c("titleReason", "restricted", [title, "com.apple.mail", true], "protectedReason");
  c("titleReason", "restricted", ["Web Inspector tutorial - Example", "com.google.Chrome"], "protectedReason");
  c("appReason", "hiddenMail", ["com.apple.mail", "Mail", "/System/Applications/Mail.app"], "hiddenReason");
  c("appReason", "apps", ["com.apple.mail", "Mail", "/System/Applications/Mail.app"], "notAllowedReason");
  for (const url of ["https://mac.tail1234.ts.net/", "http://localhost:8443/", "chrome://password-manager/passwords", "chrome://settings/passwords", "chrome://settings/payments",
    "brave://password-manager", "edge://wallet", "about:logins", "javascript:alert(1)", "data:text/html,x", "devtools://devtools/"])
    c("urlReason", "restricted", [url], "refused");
  for (const url of ["https://www.amazon.com/", "chrome://newtab", "chrome://settings/appearance", "about:blank", "https://example.com/?next=chrome://settings/passwords", ""])
    c("urlReason", "restricted", [url], NIL);
  for (const [url, blocked] of reachUrlCases) c("urlReason", "restricted", [url], blocked ? "refused" : NIL);
  c("terminalLikeApp", "restricted", ["com.apple.Terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"], true);
  c("terminalLikeApp", "restricted", ["com.microsoft.VSCode", "Code", "/Applications/Visual Studio Code.app"], true);
  c("terminalLikeApp", "restricted", ["com.google.Chrome", "Google Chrome", "/Applications/Google Chrome.app"], false);
  for (const [text, expected] of [["com.reach.app", true], ["Reach — node", true], ["preacher", false], ["outreach", false]]) c("mentionsReach", "restricted", [text], expected);
  for (const key of ["tab", "escape", "esc", "return", "enter", "left", "right", "up", "down"]) {
    c("secureKeyAllowed", "", [key, false], true);
    c("secureKeyAllowed", "", [key, true], false);
  }
  for (const key of ["v", "a", "x", "c", "z", "delete", "backspace", "forwarddelete", "space", "1"]) {
    c("secureKeyAllowed", "", [key, false], false);
    c("secureKeyAllowed", "", [key, true], false);
  }
  for (const [name, wanted, grade] of [["Add to cart", "add to cart", 3], ["Add to cart", "Add", 2], ["Add to cart", "cart", 1], ["Add to cart", "remove", 0], ["", "x", 0], ["x", "", 0], ["  Sign   in ", "sign in", 3]])
    c("nameMatch", "", [name, wanted], grade);
  for (const [text, secrets, expected] of [["Signed in as jane@example.com", ["jane@example.com"], "Signed in as •••"], ["JANE@EXAMPLE.COM", ["jane@example.com"], "•••"],
    ["ab", ["ab"], "ab"], ["Add to cart", ["x"], "Add to cart"]])
    c("hideSecrets", "", [text, secrets], expected);
}

// --- Windows' data ------------------------------------------------------------
// [function, rules name, arguments, expected], expected from JavaScript where
// it decides the same question. An identity is (bundle, name, path) natively
// and { bundleId, name, id } in JavaScript: a program's bundle is exe:<name>
// and its path its .exe; a Store app's bundle and path are both its id.
const win = { platform: "win32" };
const exe = (path, name = "") => [`exe:${path.split("\\").at(-1).toLowerCase()}`, name, path];
const store = (aumid, name = "") => [aumid, name, aumid];
const js = (identity) => ({ bundleId: identity[0], name: identity[1], id: identity[2] });
export const windowsCases = [];
{
  const c = (fn, rules, args, expected) => windowsCases.push([fn, rules, args, expected]);
  const identities = [
    exe(String.raw`C:\Program Files\1Password\app\8\1Password.exe`, "1Password"), exe(String.raw`C:\Program Files\Bitwarden\Bitwarden.exe`, "Bitwarden"),
    exe(String.raw`C:\Program Files\KeePassXC\KeePassXC.exe`, "KeePassXC"), exe(String.raw`C:\Windows\System32\consent.exe`, "Consent UI for administrative applications"),
    exe(String.raw`C:\Windows\System32\CredentialUIBroker.exe`, "Credential Dialog Host"), exe(String.raw`C:\Windows\System32\LogonUI.exe`, "Windows Logon User Interface Host"),
    exe(String.raw`C:\Windows\System32\Taskmgr.exe`, "Task Manager"), exe(String.raw`C:\Windows\regedit.exe`, "Registry Editor"), exe(String.raw`C:\Windows\System32\mmc.exe`),
    exe(String.raw`C:\Program Files\Tailscale\tailscale-ipn.exe`, "Tailscale"), exe(String.raw`C:\Users\me\AppData\Local\Programs\Reach\Reach.exe`),
    store("Microsoft.SecHealthUI_8wekyb3d8bbwe!SecHealthUI", "Windows Security"), store("8bitSolutionsLLC.bitwardendesktop_h4e712dmw3xyy!bitwardendesktop", "Bitwarden"),
    store("Microsoft.YourPhone_8wekyb3d8bbwe!App", "Phone Link"),
    // Not protected.
    exe(String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, "Google Chrome"), exe(String.raw`C:\Windows\System32\notepad.exe`, "Notepad"),
    store("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "Calculator"), store("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "Terminal"),
    exe(String.raw`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`, "Microsoft Word"), exe(String.raw`C:\Tools\preacher.exe`, "Preacher"),
  ];
  for (const identity of identities)
    c("protectedApp", "restricted", identity, protectedAppReason(js(identity), win) ? "refused" : NIL);
  const terminals = [
    exe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "Windows PowerShell"), exe(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, "PowerShell 7"),
    exe(String.raw`C:\Windows\System32\cmd.exe`, "Windows Command Processor"), store("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "Terminal"),
    exe(String.raw`C:\Program Files\Git\bin\bash.exe`), exe(String.raw`C:\Windows\System32\wsl.exe`), exe(String.raw`C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe`, "Visual Studio Code"),
    store("CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc!ubuntu", "Ubuntu"), exe(String.raw`C:\Program Files\Git\usr\bin\mintty.exe`),
    // Not terminals: look-alikes of the short names, and ordinary apps.
    exe(String.raw`C:\Program Files\Newtonsoft\viewer.exe`, "Newtonsoft Viewer"), exe(String.raw`C:\Tools\cmdline-viewer.exe`, "Viewer"), exe(String.raw`C:\Tools\barcode.exe`, "Barcode"),
    exe(String.raw`C:\Tools\bashful.exe`), exe(String.raw`C:\Windows\System32\notepad.exe`, "Notepad"), exe(String.raw`C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`, "Word"),
    exe(String.raw`C:\Program Files\Portfolio\portfolio.exe`, "Portfolio"),
  ];
  for (const identity of terminals) c("terminalLikeApp", "restricted", identity, terminalLikeApp(js(identity), win));
  for (const title of ["Credential Manager", "Windows Security", "Task Manager", "Registry Editor", "User Account Control", "Local Group Policy Editor", "DevTools - example.com",
    "Inbox - Outlook", "Untitled - Notepad"])
    c("titleReason", "restricted", [title, "exe:notepad.exe"], protectedTitle(title, win) ? "refused" : NIL);
  // "passwords" alone, as the Mac's rule reads it (the server's title check
  // is a plain substring one): an article about passwords stays readable.
  c("titleReason", "restricted", ["Passwords", "exe:notepad.exe"], "protectedReason");
  c("titleReason", "restricted", ["Reset your passwords - Help Center", "exe:notepad.exe"], NIL);
  c("titleReason", "restricted", ["Reach", "exe:windowsterminal.exe"], "reachReason");
  c("titleReason", "restricted", ["Administrator: Windows PowerShell", "exe:windowsterminal.exe"], NIL);
  for (const url of ["ms-settings:privacy-webcam", "ms-settings:signinoptions", "ms-settings:network-wifi", "ms-settings:windowsupdate", "windowsdefender://threat",
    "chrome://password-manager/passwords", "edge://wallet", "ms-settings:display", "ms-settings:bluetooth", "https://example.com/", "http://01.1.1.1/?next=localhost:8443",
    "http://[::ffff:1.2.3.4]/?next=localhost:8443", "http://[::ffff:1.2.3.04]/?next=localhost:8443", "https://mac.tail1234.ts.net/"])
    c("urlReason", "restricted", [url], protectedPage(url, HOSTS, win) ? "refused" : NIL);
  // Settings: its window says only "Settings", so the page read from it is
  // part of its title; Control Panel in File Explorer is judged the same way.
  const settings = "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
  for (const [title, bundle, expected] of [
    ["Settings — Privacy & security > Location", settings, "protectedReason"], ["Settings — Accounts > Sign-in options", settings, "protectedReason"],
    ["Settings — Network & internet > Wi-Fi", settings, "protectedReason"], ["Settings — Windows Update", "exe:systemsettings.exe", "protectedReason"],
    ["Settings — System > Display", settings, NIL], ["Settings — Bluetooth & devices", settings, NIL],
    ["Network Connections", "windows.controlpanel", "protectedReason"], ["User Accounts", "windows.controlpanel", "protectedReason"], ["Mouse Properties", "windows.controlpanel", NIL],
    ["Privacy & security", "exe:notepad.exe", NIL],
  ]) c("titleReason", "restricted", [title, bundle], expected);
  // A package family protects every app of its package; a near miss doesn't.
  c("protectedApp", "families", ["AgileBits.1Password_abcdefghjkmnp!App", "", "AgileBits.1Password_abcdefghjkmnp!App"], "protectedReason");
  c("protectedApp", "families", ["AgileBits.1Password_abcdefghjkmnp2!App", "", "AgileBits.1Password_abcdefghjkmnp2!App"], NIL);
  c("protectedApp", "families", ["exe:passwordsafe.exe", "Password Safe", String.raw`C:\Tools\PasswordSafe\pwsafe.exe`, "Signed Publisher Ltd"], "protectedReason");
  c("protectedApp", "families", ["exe:pwsafe.exe", "", String.raw`C:\Tools\PasswordSafe\pwsafe.exe`, ""], NIL);
  // Apps: a Store app by its id; a program by its exact path, never by its name.
  c("appReason", "apps", store("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "Calculator"), NIL);
  c("appReason", "apps", exe(String.raw`C:\Windows\System32\notepad.exe`, "Notepad"), NIL);
  c("appReason", "apps", exe(String.raw`C:\Users\me\Downloads\notepad.exe`, "Notepad"), "notAllowedReason");
  c("appReason", "apps", store("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "Terminal"), "notAllowedReason");
  c("appReason", "restricted", exe(String.raw`C:\Program Files\Messenger\Messenger.exe`, "Messenger"), "hiddenReason");
  c("appReason", "restricted", exe(String.raw`D:\Portable\Messenger.exe`, ""), "hiddenReason");
  // The compositor is no app to click.
  for (const [identity, expected] of [[[...exe(String.raw`C:\Windows\System32\dwm.exe`, "Desktop Window Manager"), 812], false], [[...exe(String.raw`C:\Windows\System32\csrss.exe`), 600], false],
    [[...exe(String.raw`C:\Windows\System32\notepad.exe`, "Notepad"), 4321], true], [[...exe(String.raw`C:\Windows\System32\notepad.exe`, "Notepad"), 0], false]])
    c("pointerIdentityKnown", "", identity, expected);
  // Lowercase as JavaScript reads it.
  for (const text of ["İSTANBUL", "ΟΔΟΣ ΣΟΦΟΣ", "Reach", "ＲＥＡＣＨ", "ǅungla"]) c("lower", "", [text], text.normalize("NFKC").toLowerCase());
  // Files that run when opened: Windows' list from the server, and the helper's own.
  for (const file of ["Report.pdf", "notes.txt", "setup.exe", "run.BAT", "disk.iso", "page.hta", "remote.rdp", "app.appinstaller", "Report.pdf.exe", "notes"])
    c("programFile", "restricted", ["C:\\Users\\me\\Downloads\\" + file], windowsProgramFile(file));
  for (const file of ["addin.xlam", "macro.xlsm", "doc.docm", "cert.pfx", "script.py", "run.sh", "app.jnlp"]) c("programFile", "restricted", ["C:\\Users\\me\\Downloads\\" + file], true);
}

// --- Checks as C# -------------------------------------------------------------
// A C# string literal for any text: ASCII as is, everything else \uXXXX.
export const cs = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i), ch = value[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (unit < 0x20 || unit > 0x7e) out += `\\u${unit.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
};
const strings = (values) => `new List<string> { ${values.map(cs).join(", ")} }`;
const REASONS = { protectedReason: "Policy.ProtectedReason", reachReason: "Policy.ReachReason", hiddenReason: "Policy.HiddenReason", notAllowedReason: "Policy.NotAllowedReason" };
const CALLS = {
  appReason: (r, [bundle, name, path, publisher]) => `Policy.AppReason(${cs(bundle)}, ${cs(name)}, ${cs(path)}, ${r}${publisher !== undefined ? `, ${cs(publisher)}` : ""})`,
  protectedApp: (r, [bundle, name, path, publisher]) => `Policy.ProtectedApp(${cs(bundle)}, ${cs(name)}, ${cs(path)}, ${r}${publisher !== undefined ? `, ${cs(publisher)}` : ""})`,
  titleReason: (r, [title, bundle, verified]) => `Policy.TitleReason(${cs(title)}, ${cs(bundle)}, ${r}${verified ? ", true" : ""})`,
  urlReason: (r, [url]) => `Policy.UrlReason(${cs(url)}, ${r})`,
  terminalLikeApp: (r, [bundle, name, path]) => `Policy.TerminalLikeApp(${cs(bundle)}, ${cs(name)}, ${cs(path)}, ${r})`,
  mentionsReach: (r, [text]) => `Policy.MentionsReach(${cs(text)}, ${r})`,
  secureKeyAllowed: (r, [key, command]) => `Policy.SecureKeyAllowed(${cs(key)}, ${command})`,
  nameMatch: (r, [name, wanted]) => `Policy.NameMatch(${cs(name)}, ${cs(wanted)})`,
  hideSecrets: (r, [text, secrets]) => `Policy.HideSecrets(${cs(text)}, ${strings(secrets)})`,
  pointerIdentityKnown: (r, [bundle, name, path, pid]) => `Policy.PointerIdentityKnown(${cs(bundle)}, ${cs(name)}, ${cs(path)}, ${pid})`,
  lower: (r, [text]) => `Policy.Lower(${cs(text)})`,
  programFile: (r, [path]) => `Policy.ProgramFile(${cs(path)}, ${r})`,
};
const check = (expression, expected) => expected === "refused" ? `${expression} != null`
  : expected === null ? `${expression} == null`
  : typeof expected === "string" && REASONS[expected] ? `${expression} == ${REASONS[expected]}`
  : `${expression} == ${cs(expected)}`;
const caseChecks = (cases, prefix) => cases.map(([fn, rules, args, expected]) => {
  const call = CALLS[fn];
  if (!call) throw Error(`No C# for ${fn}`);
  return `    Check(${check(call(`${prefix}[${cs(rules)}]`, args), expected)}, ${cs(`${prefix} ${fn} ${JSON.stringify(args)}`)});`;
}).join("\n");
// The rules as the server sends them, through the helper's own reader.
const rulesBlock = (name, map) => Object.entries(map).map(([key, rules]) =>
  `    ${name}[${cs(key)}] = Rules.From((Dictionary<string, object>)Json.Parse(${cs(JSON.stringify(rules))}));`).join("\n");
// The sections of agent-desktop.cs a policy test compiles: JSON, then the
// pure URL, policy and text sections (no Windows call in any of them).
export const PURE_SECTIONS = ["JSON", "PURE URL", "PURE DESKTOP POLICY", "PURE DESKTOP TEXT"];
export function pureSections(source) {
  return PURE_SECTIONS.map((name) => {
    const begin = source.indexOf(`// BEGIN ${name}`), end = source.indexOf(`// END ${name}`);
    if (begin < 0 || end < begin) throw Error(`agent-desktop.cs has no ${name} section`);
    return source.slice(begin, end + `// END ${name}`.length);
  }).join("\n\n");
}
/** A whole C# program (agent-desktop.cs's pure sections and the corpus as checks) that prints OK, or each failure. */
export function csharpPolicyProgram(source) {
  const mac = corpusRules("darwin"), windows = corpusRules("win32");
  const macRules = { ...mac, hiddenMail: { ...mac.restricted, hiddenApps: [{ bundleId: "com.apple.mail", id: "/System/Applications/Mail.app" }] } };
  const windowsRules = { ...windows, families: { ...windows.restricted, protectedAppIds: [...windows.restricted.protectedAppIds, "agilebits.1password_abcdefghjkmnp"], protectedPublishers: ["Signed Publisher Ltd"] } };
  const money = nativeRules({ preset: "full" }, { platform: "darwin" });
  const sources = Object.entries(money).filter(([key, value]) => typeof value === "string" && /^(money|accountNumber)/.test(key));
  const samples = ["", "plain text", "café — mañana", "日本語 العربية", "🙂", "👨‍👩‍👧‍👦", "é"];
  return `using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

${pureSections(source)}

static class PolicyChecks {
  static int failures;
  static void Check(bool ok, string label) { if (!ok) { failures++; Console.WriteLine("FAILED: " + label); } }
  static bool Throws(string json) { try { Json.Parse(json); return false; } catch (FormatException) { return true; } }
  static int Main() {
    var mac = new Dictionary<string, Rules>();
${rulesBlock("mac", macRules)}
    var windows = new Dictionary<string, Rules>();
${rulesBlock("windows", windowsRules)}
    // The Mac's data: the cases agent-desktop.swift decides.
${caseChecks(macCases, "mac")}
    // Windows' data: JavaScript's answers, and Windows' own rules.
${caseChecks(windowsCases, "windows")}
    // An installed program is allowed by its path, never by the name Windows gives it.
    Check(windows["apps"].AllowedApps.TrueForAll(app => !app["bundleId"].StartsWith("exe:", StringComparison.Ordinal)), "no exe: bundle allows an app");
    // A numbered control covered since the agent looked (1 window, 10 its
    // button, 11 the button's label, 12 a card link beside it on the same
    // page; 2 a dialog over it, 20 the dialog's button; 300 another app).
    var parents = new Dictionary<string, string> { { "11", "10" }, { "10", "1" }, { "12", "1" }, { "20", "2" }, { "2", "1" } };
    Func<string, string> up = id => parents.ContainsKey(id) ? parents[id] : null;
    Func<string, int> appOf = id => int.Parse(id, CultureInfo.InvariantCulture) >= 300 ? 2 : 1;
    Func<string, string, bool> covered = (hit, target) => Policy.CoveredControl<string>(hit, target, up, (a, b) => a == b, (a, b) => appOf(a) == appOf(b), id => id == "2");
    Check(!covered("10", "10"), "the control itself");
    Check(!covered("11", "10"), "the control's own label");
    Check(!covered("1", "10"), "the window that holds it, nothing over it");
    Check(!covered("12", "10"), "a link of the same page takes the click, as a real one would");
    Check(covered("20", "10"), "a dialog's button over it");
    Check(covered("2", "10"), "a dialog over it");
    Check(covered("300", "10"), "another app's window over it");
    // Picking among matches: the best grade; among equals, the clearly nearest.
    Func<double[], List<KeyValuePair<int, double>>> graded = pairs => {
      var list = new List<KeyValuePair<int, double>>();
      for (int i = 0; i < pairs.Length; i += 2) list.Add(new KeyValuePair<int, double>((int)pairs[i], pairs[i + 1]));
      return list;
    };
    int count;
    double inf = double.PositiveInfinity;
    Check(Policy.PickControl(graded(new[] { 2, inf, 3, inf, 1, inf }), out count) == 1, "the best grade");
    Check(Policy.PickControl(graded(new[] { 3, inf, 3, inf }), out count) == -1 && count == 2, "two the same, nowhere in particular: the agent says which");
    Check(Policy.PickControl(graded(new[] { 3, 300, 3, 4.0 }), out count) == 1, "the one where it was");
    Check(Policy.PickControl(graded(new[] { 3, 10, 3, 20.0 }), out count) == -1, "two about as near: ambiguous");
    Check(Policy.PickControl(graded(new[] { 0, 1, 0, 2.0 }), out count) == -1, "nothing matches");
    Check(Policy.PickControl(graded(new[] { 0, 1.0 }), out count) == -1 && count == 0, "nothing matches, no candidates");
    // Keyboard events: whole characters, at most 16 units, every unit kept.
    foreach (string sample in new[] { ${samples.map(cs).join(", ")} }) {
      for (int padding = 0; padding <= 33; padding++) {
        var text = new StringBuilder(new string('a', padding)).Append(sample);
        for (int i = 0; i < 20; i++) text.Append(${cs("🚀")});
        string whole = text.ToString();
        var chunks = Text.KeyboardChunks(whole);
        var joined = new StringBuilder();
        bool shape = true;
        foreach (var chunk in chunks) {
          shape &= chunk.Length > 0 && chunk.Length <= 16 && !char.IsLowSurrogate((char)chunk[0]) && !char.IsHighSurrogate((char)chunk[chunk.Length - 1]);
          foreach (ushort unit in chunk) joined.Append((char)unit);
        }
        Check(shape, "event length and whole scalars: " + padding);
        Check(joined.ToString() == whole, "code units preserved: " + padding);
      }
    }
    Check(Text.KeyboardChunks("").Count == 0, "empty text emits no events");
    var sevens = Text.KeyboardChunks("7*3");
    Check(sevens.Count == 3 && sevens[0][0] == 55 && sevens[1][0] == 42 && sevens[2][0] == 51, "one character per event");
    Check(Text.KeyboardChunks(${cs("éx")}).Count == 2, "a combined character stays one event");
    // JSON as the server writes it, and nothing looser.
    Check(Throws("{\\"a\\":1,\\"a\\":2}"), "a key twice");
    Check(Throws(new string('[', 33) + new string(']', 33)) && !Throws(new string('[', 32) + new string(']', 32)), "nested at most 32 deep");
    Check(Throws("\\"\\\\ud800\\"") && Throws("\\"\\\\udc00\\\\ud800\\""), "a lone surrogate");
    Check(Throws("01") && Throws("1.") && Throws("1e999") && Throws("+1") && Throws("[1,]") && Throws("{} {}") && Throws("\\"a\\u0001\\""), "malformed");
    Check(Json.IsInt(Json.Parse("1.0")) && !Json.IsInt(Json.Parse("1.5")) && Json.IsInt(Json.Parse("-0")) && !Json.IsInt(Json.Parse("\\"1\\"")), "whole numbers only, as Swift's Int");
    var map = new Dictionary<string, object>();
    map["text"] = "line" + (char)0x2028 + "break" + (char)1 + "x" + (char)0xD800;
    map["n"] = 3;
    map["d"] = 0.5;
    Check(Json.Write(map) == "{\\"text\\":\\"line\\\\u2028break\\\\u0001x\\\\ud800\\",\\"n\\":3,\\"d\\":0.5}", "escaped on the way out");
    map["text"] = "line" + (char)0x2028 + "break \\"quoted\\" \\\\ " + (char)0xD83D + (char)0xDE80;
    var back = (Dictionary<string, object>)Json.Parse(Json.Write(map));
    Check((string)back["text"] == (string)map["text"] && (double)back["n"] == 3 && (double)back["d"] == 0.5, "read back as written");
    // Bank sites: the same corpus as JavaScript and Swift.
    var rules = new Rules();
    rules.MoneySites = ${strings(money.moneySites)};
    rules.MoneyReadWords = new HashSet<string>(${strings(money.moneyReadWords)}, StringComparer.Ordinal);
    var sources = new Dictionary<string, string>();
${sources.map(([key, value]) => `    sources[${cs(key)}] = ${cs(value)};`).join("\n")}
    rules.Money = Policy.MoneyPatterns(sources);
    var none = new Rules();
${moneyChecks()}
    // Rules that didn't arrive refuse rather than allow.
    none.MoneySites = new List<string> { "chase.com" };
    Check(Policy.MoneyClickReason(${cs(overview)}, "Overview", new List<string> { "Statements" }, "AXLink", none) != null, "missing words refuse");
    Check(Policy.MoneyTypeReason(${cs(overview)}, "Overview", "Search", false, false, none) != null, "missing field words refuse");
    // Full control bypasses the entire financial-page policy.
    var full = rules.Copy();
    full.Mode = "full";
    Check(!Policy.MoneySite(${cs(overview)}, full), "Full does not classify protected bank pages");
    Check(Policy.MoneyClickReason(${cs(overview)}, "Transfer", new List<string> { "Confirm transfer" }, "AXButton", full) == null, "Full may press any bank control");
    Check(Policy.MoneyTypeReason(${cs(overview)}, "Transfer", "Amount", false, false, full) == null, "Full may fill any bank field");
    Check(Policy.MoneyKeyReason(${cs(overview)}, "Transfer", "v", true, false, true, false, new List<string> { "Amount" }, "AXTextField", full) == null, "Full may paste");
    Check(Policy.MaskAccountNumbers("1234567890123456", full) == "1234567890123456", "Full sees account numbers");
    if (failures == 0) Console.WriteLine("OK");
    return failures == 0 ? 0 : 1;
  }
}
`;
}
function moneyChecks() {
  const lines = [];
  const list = strings;
  for (const [url, expected] of sites) lines.push(`Check(Policy.MoneySite(${cs(url)}, rules) == ${expected}, ${cs(url)});`);
  for (const [url, title, expected] of pages) lines.push(`Check(Policy.MoneyPage(${cs(url)}, ${cs(title)}, rules) == ${cs(expected)}, ${cs(url)});`);
  for (const [urls, expected] of frames) lines.push(`Check(Policy.MoneyFrames(${list(urls)}, rules) == ${expected}, ${cs(urls.join(" "))});`);
  for (const [url, title, labels, role, expected] of clicks)
    lines.push(`Check(Policy.MoneyClickReason(${cs(url)}, ${cs(title)}, ${list(labels)}, ${cs(role)}, rules) == ${cs(expected)}, ${cs(`${labels} ${url}`)});`);
  for (const [url, title, label, secure, secret, expected] of typing)
    lines.push(`Check(Policy.MoneyTypeReason(${cs(url)}, ${cs(title)}, ${cs(label)}, ${secure}, ${secret}, rules) == ${cs(expected)}, ${cs(`${label} ${url}`)});`);
  for (const [url, title, key, command, control, field, secure, labels, role, expected] of keys)
    lines.push(`Check(Policy.MoneyKeyReason(${cs(url)}, ${cs(title)}, ${cs(key)}, ${command}, ${control}, ${field}, ${secure}, ${list(labels)}, ${cs(role)}, rules) == ${cs(expected)}, ${cs(`${key} ${labels} ${url}`)});`);
  for (const [text, expected] of masks) lines.push(`Check(Policy.MaskAccountNumbers(${cs(text)}, rules) == ${cs(expected)}, ${cs(text)});`);
  return lines.map((line) => `    ${line}`).join("\n");
}
