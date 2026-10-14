import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeRules } from "../server/agent-guard.mjs";
import {
  maskAccountNumbers, moneyClickReason, moneyFrames, moneyKeyReason, moneyPage, moneySite, moneyTypeReason,
} from "../server/money-sites.mjs";
// The same corpus runs against JavaScript, the compiled Swift policy and the
// Windows helper's C# (test/agent-desktop-windows-policy.test.mjs).
import { clicks, frames, keys, masks, overview, pages, sites, typing } from "./helpers/desktop-policy-corpus.mjs";

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
