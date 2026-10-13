import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules } from "../server/agent-guard.mjs";
import {
  maskAccountNumbers, moneyClickReason, moneyFrames, moneyKeyReason, moneyPage, moneySite, moneyTypeReason,
  MONEY_BUTTON_REASON, MONEY_FIELD_REASON, MONEY_LABEL_REASON, MONEY_PAGE_REASON, MONEY_REASON,
} from "../server/money-sites.mjs";

// The same corpus runs against JavaScript and the compiled Swift policy.
const overview = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview";
const signIn = "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline";
const payBills = "https://secure.chase.com/web/auth/dashboard#/dashboard/payMultipleBills/entry";
const amex = "https://global.americanexpress.com/activity/statements";
const home = "https://my.wealthsimple.com/app/home";
const rbc = "https://www1.royalbank.com/sgw1/olb/index-fr/#/summary";
const rbcSignIn = "https://secure.royalbank.com/statics/login-service-ui/index#/full/signin?LANGUAGE=FRENCH";
const rbcTransfer = "https://www1.royalbank.com/sgw1/olb/index-fr/#/virements/entree";
const sites = [
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
const pages = [
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
const frames = [
  [["https://pay.processor-example.com/form", overview], true], [["about:blank", "https://www.chase.com/"], true],
  [["https://pay.processor-example.com/form"], false], [["https://example.com/", "https://example.org/?chase.com"], false],
];
// [url, title, labels, role, refused-with]
const clicks = [
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
const typing = [
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
const keys = [
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
const masks = [
  ["Checking 123456789012", "Checking ••••9012"], ["Card 4111 1111 1111 1111", "Card ••••1111"], ["4111-1111-1111-1111", "••••1111"],
  ["Posted 2026-10-10", "Posted 2026-10-10"], ["$12,345,678.90", "$12,345,678.90"], ["...1234", "...1234"], ["12345678.50", "12345678.50"],
];

test("bank sites: the shared corpus decides in JavaScript", () => {
  for (const [url, expected] of sites) assert.equal(moneySite(url), expected, url);
  for (const [url, title, expected] of pages) assert.equal(moneyPage(url, title), expected, url);
  for (const [urls, expected] of frames) assert.equal(moneyFrames(urls), expected, urls.join(" "));
  for (const [url, title, labels, role, expected] of clicks) assert.equal(moneyClickReason(url, title, labels, role), expected, `${labels} ${url}`);
  for (const [url, title, label, secure, secret, expected] of typing) assert.equal(moneyTypeReason(url, title, label, { secure, secret }), expected, `${label} ${url}`);
  for (const [url, title, key, command, control, field, secure, labels, role, expected] of keys)
    assert.equal(moneyKeyReason(url, title, key, { command, control, field, secure, labels, role }), expected, `${key} ${labels} ${url}`);
  for (const [text, expected] of masks) assert.equal(maskAccountNumbers(text), expected, text);
});

test("bank sites: every click, drag, key and character is judged natively before it is sent", async () => {
  const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
  const perform = source.split("func perform(")[1].split("\nfunc redacted(")[0];
  assert.match(perform, /case "click":[\s\S]*?checkPoint\(p, rules, expected, activate: true\)/, "a click presses: judged as one");
  assert.match(perform, /case "drag":[\s\S]*?if start\.bank \|\| end\.bank \{ try refuse\(moneyPasteReason\) \}/, "no drag on a bank page");
  assert.match(perform, /case "type":[\s\S]*?moneyAt\(&field, nil, rules\)[\s\S]*?moneyTypeReason\(/, "typing");
  assert.match(perform, /case "key":[\s\S]*?moneyAt\(&focused, nil, rules\)[\s\S]*?moneyKeyReason\(/, "keys");
  const checkPoint = source.split("func checkPoint(")[1].split("\nfunc hostsReach(")[0];
  assert.match(checkPoint, /isBrowser\(window\.bundle\) \{ buildWebTree\(window\.pid\) \}/, "Chrome's page tree is built before the point is read");
  assert.match(checkPoint, /if activate, let reason = moneyClickReason\(page\.url, page\.title, s\.labels, s\.control, rules\) \{ try refuse\(reason\) \}/);
  assert.match(checkPoint, /if var window[\s\S]*?moneyAt\(&window, point, rules\)/, "a point accessibility can't name is still checked");
  const moneyAt = source.split("func moneyAt(")[1].split("\nfunc ")[0];
  assert.match(moneyAt, /let addresses = s\.frames\.filter[\s\S]*?if addresses\.isEmpty \{ try refuse\(moneyUnreadReason, "retry"\) \}[\s\S]*?moneyFrames\(addresses, rules\)/, "every frame counts; a page without an address is refused");
  assert.match(source.split("func seen(")[1].split("\nfunc ")[0], /s\.frames\.append\(address\)/, "the frames up to the tab are all read");
  assert.match(moneyAt, /if point != nil \{ try refuse\(moneyUnreadReason, "retry"\) \}/, "a bank page without a readable control there is refused");
  assert.match(source.split("func focus(")[1].split("\nfunc ")[0], /if isBrowser\(bundle\) \{ buildWebTree\(front\.processIdentifier\) \}/);
  assert.match(source.split("func readScreen(")[1].split("\nfunc elements(")[0], /if bank \{[\s\S]*?maskAccountNumbers\(\$0\.name[\s\S]*?maskAccountNumbers\(\$0, rules\)[\s\S]*?maskAccountNumbers\(\$0\.0, rules\)/, "names, values and text");
  assert.match(source.split("func rules(from")[1], /r\.moneySites = strings\("moneySites"\)[\s\S]*?moneyPatterns\(/);
  const rules = nativeRules({ preset: "full" });
  for (const key of ["moneySites", "moneyMove", "moneyCommit", "moneyAuthPage", "moneyAuthOk", "moneyExit", "moneySafe", "moneyFieldDeny", "moneyFieldOk", "accountNumber", "moneyReadPage", "moneyReadOk", "moneyReadWords"])
    assert.ok(rules[key]?.length, key);
});

test("bank sites: the compiled native policy decides the same corpus", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-money-policy-"));
  try {
    const source = await fs.readFile(new URL("../scripts/native/agent-desktop.swift", import.meta.url), "utf8");
    const policy = source.split("// BEGIN PURE DESKTOP POLICY")[1].split("\n").slice(1).join("\n").split("// END PURE DESKTOP POLICY")[0];
    const swift = (value) => value === null ? "nil" : JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u{$1}");
    const list = (values) => `[${values.map(swift).join(",")}]`;
    const data = nativeRules({ preset: "full" });
    const sources = Object.entries(data).filter(([key, value]) => typeof value === "string" && /^(money|accountNumber)/.test(key));
    const checks = `
import Foundation
var rules = Rules()
rules.moneySites = ${list(data.moneySites)}
rules.moneyReadWords = Set(${list(data.moneyReadWords)})
rules.money = moneyPatterns([${sources.map(([key, value]) => `${swift(key)}: ${swift(value)}`).join(",")}])
var none = Rules()
func check(_ value: Bool, _ label: String) { if !value { print("FAILED: " + label); exit(1) } }
${sites.map(([url, expected]) => `check(moneySite(${swift(url)}, rules) == ${expected}, ${swift(url)})`).join("\n")}
${pages.map(([url, title, expected]) => `check(moneyPage(${swift(url)}, ${swift(title)}, rules) == ${swift(expected)}, ${swift(url)})`).join("\n")}
${frames.map(([urls, expected]) => `check(moneyFrames(${list(urls)}, rules) == ${expected}, ${swift(urls.join(" "))})`).join("\n")}
${clicks.map(([url, title, labels, role, expected]) => `check(moneyClickReason(${swift(url)}, ${swift(title)}, ${list(labels)}, ${swift(role)}, rules) == ${swift(expected)}, ${swift(`${labels} ${url}`)})`).join("\n")}
${typing.map(([url, title, label, secure, secret, expected]) => `check(moneyTypeReason(${swift(url)}, ${swift(title)}, ${swift(label)}, secure: ${secure}, secret: ${secret}, rules) == ${swift(expected)}, ${swift(`${label} ${url}`)})`).join("\n")}
${keys.map(([url, title, key, command, control, field, secure, labels, role, expected]) => `check(moneyKeyReason(${swift(url)}, ${swift(title)}, ${swift(key)}, command: ${command}, control: ${control}, field: ${field}, secure: ${secure}, labels: ${list(labels)}, role: ${swift(role)}, rules) == ${swift(expected)}, ${swift(`${key} ${labels} ${url}`)})`).join("\n")}
${masks.map(([text, expected]) => `check(maskAccountNumbers(${swift(text)}, rules) == ${swift(expected)}, ${swift(text)})`).join("\n")}
// Rules that didn't arrive refuse rather than allow.
none.moneySites = ["chase.com"]
check(moneyClickReason(${swift(overview)}, "Overview", ["Statements"], "AXLink", none) != nil, "missing words refuse")
check(moneyTypeReason(${swift(overview)}, "Overview", "Search", secure: false, secret: false, none) != nil, "missing field words refuse")
// Full control bypasses the entire financial-page policy.
var full = rules; full.mode = "full"
check(!moneySite(${swift(overview)}, full), "Full does not classify protected bank pages")
check(moneyClickReason(${swift(overview)}, "Transfer", ["Confirm transfer"], "AXButton", full) == nil, "Full may press any bank control")
check(moneyTypeReason(${swift(overview)}, "Transfer", "Amount", secure: false, secret: false, full) == nil, "Full may fill any bank field")
check(moneyKeyReason(${swift(overview)}, "Transfer", "v", command: true, control: false, field: true, secure: false, labels: ["Amount"], role: "AXTextField", full) == nil, "Full may paste")
check(maskAccountNumbers("1234567890123456", full) == "1234567890123456", "Full sees account numbers")
print("OK")
`;
    await fs.writeFile(path.join(directory, "main.swift"), `${policy}\n${checks}`);
    const built = spawnSync("/usr/bin/xcrun", ["swiftc", "-O", "-o", path.join(directory, "policy"), path.join(directory, "main.swift")], { encoding: "utf8", timeout: 180000 });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(path.join(directory, "policy"), { encoding: "utf8", timeout: 30000 });
    assert.equal(ran.stdout.trim(), "OK", ran.stdout + ran.stderr);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("reach_open_bank opens only listed banks, each on a bank site, through the same open-url route", async () => {
  const { MONEY_BANKS } = await import("../server/money-sites.mjs");
  const { browserToolsFor, browserToolRequest } = await import("../server/browser-tools.mjs");
  for (const bank of MONEY_BANKS) assert.ok(moneySite(bank.url), bank.name);
  for (const name of ["RBC", "TD", "Wealthsimple", "American Express"]) assert.ok(MONEY_BANKS.some((bank) => bank.name === name), name);
  const access = { preset: "apps", screen: true, control: true, open: true, apps: [], hidden: [] };
  const tool = browserToolsFor(access).find((item) => item.name === "reach_open_bank");
  assert.match(tool.description, /^Read the owner's bank/);
  assert.match(tool.description, /read-only/);
  assert.deepEqual(browserToolRequest("reach_open_bank", { bank: "TD" }, access),
    { route: "/api/browser/desktop/open-url", method: "POST", body: { url: "https://easyweb.td.com/", describe: true }, response: "json" });
  // Like every open, it answers with the page once settled; describe: false skips it.
  assert.deepEqual(browserToolRequest("reach_open_bank", { bank: "TD", describe: false }, access).body, { url: "https://easyweb.td.com/" });
  assert.throws(() => browserToolRequest("reach_open_bank", { bank: "https://evil.test/" }, access), /not a supported value/);
  assert.ok(!browserToolsFor({ ...access, open: false }).some((item) => item.name === "reach_open_bank"), "only with browser:open");
  assert.match(browserToolsFor(access).find((item) => item.name === "reach_open_url").description, /A bank: reach_open_bank\./);
});
