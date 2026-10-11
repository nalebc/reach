// Bank, card, brokerage and payment sites: an agent may sign in there (from
// its vault), read, search, filter by date, download statements and sign
// out. Nothing that moves money or changes the account. The native checker
// (scripts/native/agent-desktop.swift) applies these rules to every click,
// key and character on such a page, right before it is sent; the same
// decisions are written here for the server and for the shared test corpus.
// When a page, a control or a field can't be read, the answer is no.

// Matched on the page's host: the domain itself or any of its subdomains.
export const MONEY_SITES = [
  // United States
  "chase.com", "bankofamerica.com", "bofa.com", "wellsfargo.com", "citi.com", "citibank.com", "citibankonline.com",
  "capitalone.com", "usbank.com", "pnc.com", "truist.com", "tdbank.com", "ally.com", "discover.com",
  "americanexpress.com", "synchrony.com", "mysynchrony.com", "synchronybank.com", "barclaysus.com", "schwab.com",
  "fidelity.com", "vanguard.com", "etrade.com", "morganstanley.com", "merrilledge.com", "ml.com", "robinhood.com",
  "sofi.com", "chime.com", "paypal.com", "venmo.com", "cash.app", "marcus.com", "goldmansachs.com", "navyfederal.org",
  "usaa.com", "penfed.org", "regions.com", "key.com", "citizensbank.com", "53.com", "huntington.com", "mtb.com",
  "santanderbank.com", "firstrepublic.com", "svb.com", "mercury.com", "brex.com", "ramp.com", "coinbase.com",
  "kraken.com", "betterment.com", "wealthfront.com", "card.apple.com", "bilt.com", "affirm.com", "klarna.com",
  "zellepay.com", "wise.com", "revolut.com", "n26.com",
  // Canada
  "rbcroyalbank.com", "royalbank.com", "rbc.com", "rbcdirectinvesting.com", "avionrewards.com", "td.com", "tdcanadatrust.com",
  "americanexpress.ca", "amex.ca", "scotiabank.com", "cibc.com", "bmo.com", "tangerine.ca", "desjardins.com",
  "nbc.ca", "wealthsimple.com", "questrade.com", "eqbank.ca", "simplii.com",
  // United Kingdom
  "barclays.co.uk", "hsbc.co.uk", "hsbc.com", "lloydsbank.com", "lloydsbank.co.uk", "natwest.com", "santander.co.uk",
  "nationwide.co.uk", "halifax.co.uk", "halifax-online.co.uk", "monzo.com", "starlingbank.com", "tsb.co.uk", "rbs.co.uk",
  "firstdirect.com", "metrobankonline.co.uk", "chase.co.uk", "virginmoney.com", "coventrybuildingsociety.co.uk",
  // France
  "bnpparibas", "bnpparibas.net", "bnpparibas.com", "credit-agricole.fr", "societegenerale.fr", "labanquepostale.fr",
  "lcl.fr", "boursorama.com", "boursobank.com", "caisse-epargne.fr", "banquepopulaire.fr", "creditmutuel.fr", "cic.fr",
  "hellobank.fr", "fortuneo.fr", "qonto.com", "shine.fr", "ing.fr", "axa-banque.fr", "monabanq.com", "bforbank.com",
  "lydia-app.com", "sumeria.eu",
  // Elsewhere in Europe
  "ing.com", "ing.de", "ing.nl", "ing.be", "deutsche-bank.de", "commerzbank.de", "dkb.de", "sparkasse.de", "comdirect.de",
  "bunq.com", "abnamro.nl", "rabobank.nl", "intesasanpaolo.com", "unicredit.it", "bbva.es", "caixabank.es",
  "bancosantander.es", "kbc.be", "belfius.be", "ubs.com", "postfinance.ch", "raiffeisen.ch",
  // Morocco
  "attijariwafabank.com", "attijarinet.ma", "cihbank.ma", "bmcedirect.ma", "bankofafrica.ma", "cdm.co.ma", "cfgbank.com",
  "gbp.ma", "chaabinet.ma", "sgmaroc.com", "saham-bank.ma", "creditagricole.ma",
];

// Where reach_open_bank opens each bank: its sign-in page, or its home page
// with a Sign in link. Every address is on MONEY_SITES (test/money-sites).
export const MONEY_BANKS = [
  { name: "RBC", url: "https://www.rbcroyalbank.com/" },
  { name: "TD", url: "https://easyweb.td.com/" },
  { name: "Wealthsimple", url: "https://my.wealthsimple.com/" },
  { name: "American Express", url: "https://www.americanexpress.com/en-ca/account/login" },
  { name: "BMO", url: "https://www.bmo.com/" },
  { name: "Scotiabank", url: "https://www.scotiabank.com/" },
  { name: "CIBC", url: "https://www.cibc.com/" },
  { name: "Tangerine", url: "https://www.tangerine.ca/" },
  { name: "Desjardins", url: "https://www.desjardins.com/" },
  { name: "National Bank", url: "https://www.nbc.ca/" },
  { name: "EQ Bank", url: "https://www.eqbank.ca/" },
  { name: "Simplii", url: "https://www.simplii.com/" },
  { name: "Questrade", url: "https://www.questrade.com/" },
  { name: "PayPal", url: "https://www.paypal.com/signin" },
];

// Words, matched whole in any script: a letter or digit on either side
// doesn't count ("pay" isn't in "paypal", "activité" ends at its é). English
// and French (Canada's banks are both); a press in another language reads
// as no known word, and is refused.
const word = (body) => `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`;
// What moves money or opens a way to: on a control, a field or the page itself.
export const MONEY_MOVE = word([
  "pay|pays|paying|bill ?pay|billpay|quick ?pay|quickpay|pay ?bills?|paybills?|make an? payments?|schedule (an? )?payments?",
  "one[- ]time payments?|auto ?pay|autopay|transfers?|transferring|move money|send|sending|send money|request money|zelle",
  "wires?|wiring|venmo|withdraw|withdrawals?|deposit ?checks?|deposit ?cheques?|mobile deposit|cash ?out|payees?|billers?",
  "recipients?|beneficiar(y|ies)|buy|sell|trade|trading|place (an? )?order|invest now|redeem|redemption|convert|exchange",
  "donate|checkout|top ?up|add money|e-?transfer|interac",
  "payer|payez|faire un paiement|paiement (de factures?|unique|préautorisé)|régler|virements?|virer|transférer|transferts?",
  "envoyer|envoyez|envoi|retirer|retraits?|déposer|dépôt (de chèques?|mobile)|bénéficiaires?|destinataires?|acheter|achat",
  "vendre|vente|négocier|convertir|échanger|racheter|rachat|donner|ajouter des fonds|approvisionner|recharger",
  "déplacer (des fonds|de l['’]argent)",
].join("|"));
// What commits a step or changes the account, whatever it moves.
export const MONEY_COMMIT = word([
  "submit|confirm|confirmation|authori[sz]e|approve|agree|accept|enroll|activate|deactivate|lock|unlock|freeze|unfreeze|block",
  "report|replace|delete|remove|update|change|edit|save|add|link|unlink|open (an? )?(new )?account|apply|request|dispute|claim",
  "set ?up|turn (on|off)|enable|disable|manage|settings|profile|preferences|alerts|paperless|order (checks|cheques)",
  "stop payment|cancel (my |this |the )?(card|account|payment|transfer|order|subscription)|close (my |this |the )?(account|card)",
  "continue|next|proceed|done|finish|yes|ok|okay|trust|remember (this )?(device|browser|computer)",
  "soumettre|confirmer|autoriser|approuver|accepter|j['’]accepte|valider|validation|inscrire|s['’]inscrire|inscription|adhérer",
  "activer|désactiver|verrouiller|déverrouiller|bloquer|débloquer|geler|signaler|remplacer|supprimer|effacer|modifier|changer",
  "mettre à jour|enregistrer|sauvegarder|ajouter|lier|dissocier|ouvrir un compte|demander|demande|contester|réclamer|configurer",
  "paramètres|réglages|profil|préférences|alertes|sans papier|commander des chèques|arrêt de paiement",
  "annuler (la |ma |cette |le |mon )?(carte|paiement|virement|commande|abonnement)|fermer (le |mon |ce )?compte",
  "continuer|suivant|poursuivre|terminer|oui|faire confiance|se souvenir|mémoriser",
].join("|"));
// A sign-in or verification step: its own buttons may continue.
export const MONEY_AUTH_PAGE = word([
  "log ?in|log ?on|sign ?in|sign ?on|logon|login|signin|signon|authentication|mfa|2fa|otp|verification|verify|one[- ]time",
  "identity|challenge|connexion|se connecter|ouverture de session|authentification|vérification|vérifier|identité",
].join("|"));
export const MONEY_AUTH_OK = `^(${[
  "sign ?in|log ?in|log ?on|sign ?on|continue|next|submit|verify|verify code|send( me)?( an?| the| my)? (code|text|email)|send code",
  "text( me)?( an?| the)?( code)?|call me|email me|get( an?)? code|resend( the)?( code)?|try another (way|method)",
  "use (an? )?(different|another) (method|way|option)|choose (another|a different) (method|way)|(show|hide)( password)?|cancel|back",
  "se connecter|connexion|ouvrir (une|la) session|continuer|suivant|soumettre|vérifier|valider|envoyer( le| un| mon)? code",
  "m['’]envoyer un code|renvoyer( le)? code|recevoir un code|appelez[- ]moi|textez[- ]moi|essayer une autre méthode",
  "(afficher|masquer)( le mot de passe)?|annuler|retour",
].join("|")})$`;
// Ways off a page that moves money; anywhere, the harmless dismissals.
export const MONEY_EXIT = `^(${[
  "back|go back|cancel|close|exit|home|accounts?|my accounts|account summary|summary|overview|dashboard|sign ?out|log ?out|log ?off|sign ?off",
  "retour|revenir|annuler|fermer|quitter|accueil|comptes|mes comptes|sommaire|aperçu|tableau de bord|déconnexion|se déconnecter|fermer la session",
].join("|")})$`;
export const MONEY_SAFE = `^(${[
  "next page|previous page|(next|previous|prev) \\d+|page \\d+|\\d+|show more|load more|see more|view more|show less|see all|view all",
  "got it|not now|skip|no thanks|maybe later|remind me later|dismiss|sign ?out|log ?out|log ?off|sign ?off",
  "page suivante|page précédente|afficher plus|voir plus|charger plus|voir tout|afficher tout|tout afficher|afficher moins|compris",
  "j['’]ai compris|pas maintenant|ignorer|passer|non merci|plus tard|me le rappeler plus tard|déconnexion|se déconnecter",
].join("|")})$`;
// Fields: never these; otherwise only sign-in, code, search and date fields.
export const MONEY_FIELD_DENY = word([
  "amount|amt|sum|total|value|price|quantity|qty|shares|memo|note|notes|message|reason|recipient|payee|beneficiar(y|ies)",
  "to account|from account|routing|transit|institution|account (number|no|#)|iban|swift|bic|sort code|(street|mailing|home|billing|postal) address",
  "street|city|zip|postal|phone|mobile number|ssn|sin|social (security|insurance)|tax|income|pin change|new password|confirm password",
  "montant|somme|valeur|prix|quantité|motif|raison|destinataire|bénéficiaire|vers le compte|du compte|numéro de compte|no de compte",
  "adresse (postale|civique|domicile|de facturation)|rue|ville|code postal|téléphone|cellulaire|nas|assurance sociale|impôt|revenu",
  "nouveau mot de passe|confirmer le mot de passe",
].join("|"));
export const MONEY_FIELD_OK = word([
  "user ?name|user ?id|userid|e-?mail|login|log ?in|sign ?in|online id|customer (id|number)|client (id|number|card)|card number",
  "member (id|number)|password|passcode|code|verification|one[- ]time|otp|token|security (code|answer)|search|filter|find|keyword",
  "merchant|date|from|to|start|end|begin|month|year|period|range|since|until",
  "nom d['’]utilisateur|utilisateur|identifiant|courriel|mot de passe|code de sécurité|vérification|recherche|rechercher|filtrer",
  "commerçant|du|au|date de début|date de fin|début|fin|période|mois|année|depuis|jusqu['’]au",
].join("|"));

// A page for reading or downloading (activity, statements, documents): its
// step buttons (Continue, View, Download) may go on.
export const MONEY_READ_PAGE = word([
  "download|downloads|export|statements?|e ?statements?|documents?|activity|transactions?|history|tax (slips?|documents?|forms?)",
  "télécharger|téléchargements?|exporter|relevés?|e-?relevés?|activité|opérations|historique|feuillets? fiscaux|documents fiscaux",
].join("|"));
export const MONEY_READ_OK = `^(${[
  "(continue|next|go|view|display|download|export|search|show|apply)( (filters?|dates?|range|results))?",
  "(continuer|suivant|afficher|voir|consulter|télécharger|exporter|rechercher|appliquer)( les (filtres|dates|résultats))?",
].join("|")})$`;
// An account's tile or row (a link, or a card the page made clickable)
// shows its number or balance: opening it reads the account.
export const MONEY_TILE = "\\d{4}|\\d[.,]\\d{2}(?!\\d)";
// Anything else is pressed only when every word of its name is one of
// these: words that read, download, filter, choose a period or an account,
// or leave. A word in another language is none of them.
export const MONEY_READ_WORDS = [
  "view", "show", "see", "open", "display", "hide", "expand", "collapse", "more", "less", "all", "details", "detail", "info",
  "information", "help", "print", "download", "downloads", "export", "csv", "pdf", "ofx", "qfx", "qbo", "quicken", "quickbooks",
  "excel", "xls", "xlsx", "txt", "file", "files", "format", "include", "additional", "search", "filter", "filters", "sort", "sorted",
  "statement", "statements", "estatement", "estatements", "e", "document", "documents", "doc", "docs", "tax", "slip", "slips",
  "form", "forms", "activity", "activities", "transaction", "transactions", "history", "recent", "pending", "posted", "account",
  "accounts", "summary", "overview", "balance", "balances", "card", "cards", "credit", "debit", "chequing", "checking", "savings",
  "saving", "investment", "investments", "investing", "portfolio", "holdings", "positions", "performance", "returns", "gains",
  "dividends", "interest", "fees", "rewards", "points", "membership", "loan", "loans", "mortgage", "line", "lines", "banking", "plan",
  "services", "visa", "mastercard", "amex", "american", "express", "infinite", "avion", "cobalt", "gold", "platinum", "green",
  "simplycash", "aeroplan", "cashback", "cash", "crypto", "tfsa", "rrsp", "fhsa", "resp", "rrif", "lira", "rdsp", "personal", "joint",
  "business", "non", "registered", "managed", "self", "directed", "signature", "limit", "unlimited", "everyday", "high", "vip",
  "inclusive", "student", "preferred", "travel", "privilege", "westjet", "marriott", "bonvoy", "british", "airways", "ion",
  "minimum", "package", "usd", "cad", "us", "canadian", "dollar", "dollars", "rbc", "royal", "td", "bank", "wealthsimple", "page",
  "pages", "previous", "prev", "first", "last", "this", "current", "month", "months", "year", "years", "day", "days", "week", "weeks",
  "quarter", "ytd", "today", "yesterday", "custom", "date", "dates", "range", "period", "from", "to", "start", "end", "through",
  "between", "select", "choose", "menu", "main", "navigation", "nav", "close", "dismiss", "cancel", "back", "got", "it", "not", "now",
  "skip", "no", "thanks", "maybe", "later", "remind", "me", "my", "your", "the", "a", "an", "of", "for", "in", "on", "and", "or",
  "with", "s", "sign", "log", "out", "off", "home", "english", "français", "french", "january", "february", "march", "april", "may",
  "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "sept", "oct", "nov", "dec",
  // French
  "afficher", "voir", "consulter", "plus", "moins", "tout", "toutes", "tous", "détails", "détail", "télécharger", "exporter",
  "imprimer", "rechercher", "filtrer", "trier", "relevé", "relevés", "électronique", "électroniques", "opérations", "historique",
  "activité", "compte", "comptes", "chèques", "épargne", "placement", "placements", "carte", "cartes", "crédit", "débit", "solde",
  "soldes", "fichier", "fichiers", "inclure", "supplémentaires", "documents", "document", "fiscal", "fiscaux", "feuillet",
  "feuillets", "impôt", "impôts", "en", "attente", "comptabilisé", "comptabilisées", "récent", "récents", "récentes", "période",
  "mois", "année", "années", "jour", "jours", "semaine", "dernier", "derniers", "dernière", "dernières", "ce", "cette", "précédent",
  "précédente", "aide", "menu", "fermer", "annuler", "retour", "accueil", "aperçu", "sommaire", "déconnexion", "du", "au", "de", "la",
  "le", "les", "des", "d", "l", "à", "et", "ou", "pour", "mon", "mes", "votre", "vos", "personnel", "personnelle", "conjoint",
  "enregistré", "celi", "reer", "ferr", "reee", "celiapp", "cri", "dollars", "américains", "canadiens", "points", "récompenses",
  "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];
export const MONEY_REASON = "On a bank site the agent reads, downloads and signs in or out. It doesn't move money or change the account.";
export const MONEY_BUTTON_REASON = "On a bank site the agent presses only what reads, downloads, filters, opens an account or signs out.";
export const MONEY_LABEL_REASON = "On a bank site the agent presses only controls it can read. This one has no name.";
export const MONEY_FIELD_REASON = "On a bank site the agent types only into sign-in, code, search and date fields.";
export const MONEY_PAGE_REASON = "This bank page moves money. The agent may read it and leave (Back, Accounts, Sign out), nothing else.";
export const MONEY_KEY_REASON = "On a bank site the agent doesn't paste or drag.";
export const MONEY_UNREAD_REASON = "The page here couldn't be read yet. Describe the screen, then try again.";

// AXPressable: something the page made clickable without saying what it is
// (a card, a row): judged like a link.
const ACTIONABLE = new Set(["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox",
  "AXMenuItem", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXSlider", "AXSwitch", "AXToggle", "AXPressable"]);
const TILES = new Set(["AXLink", "AXPressable"]);
const READ_WORDS = new Set(MONEY_READ_WORDS);
const nameWords = (text) => text.match(/[\p{L}\p{N}]+/gu) || [];
const FIELDS = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"]);
const regex = (source) => new RegExp(source, "iu");
const tidy = (value) => String(value || "").normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  .replace(/[_/#?&=+.\-:]+/g, " ").replace(/\s+/g, " ").trim();
const plain = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Whether a page address belongs to a bank, card, brokerage or payment site. */
export function moneySite(url, sites = MONEY_SITES) {
  let host;
  try {
    const parsed = new URL(String(url || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch { return false; }
  return !!host && sites.some((site) => host === site || host.endsWith(`.${site}`));
}
/** A page and the frames it holds: the bank's when any of them is. */
export const moneyFrames = (urls, sites = MONEY_SITES) => urls.some((url) => moneySite(url, sites));
// The page's own words: its path, query and fragment, and its title. Several
// addresses (a page and its frames, separated by spaces): all their words.
const pageWords = (url, title) => {
  let rest = "";
  try { const parsed = new URL(url); rest = `${parsed.pathname} ${parsed.search} ${parsed.hash}`; } catch { rest = String(url || ""); }
  return `${tidy(rest)} ${tidy(title)}`;
};
/** "move" for a page that moves money, "auth" for sign-in, "read" for activity and documents, "" otherwise. */
export function moneyPage(url, title) {
  const words = pageWords(url, title);
  if (regex(MONEY_MOVE).test(words)) return "move";
  if (regex(MONEY_AUTH_PAGE).test(words)) return "auth";
  if (regex(MONEY_READ_PAGE).test(words)) return "read";
  return "";
}
/** A click (or Enter/Space on a focused control) on a bank page: null when allowed. */
export function moneyClickReason(url, title, labels = [], role = "") {
  const page = moneyPage(url, title);
  const own = labels.map(plain).find(Boolean) || "";
  const all = labels.map(plain).filter(Boolean).join(" ");
  if (page === "move") return regex(MONEY_EXIT).test(own) ? null : MONEY_PAGE_REASON;
  if (FIELDS.has(role)) return regex(MONEY_MOVE).test(all) ? MONEY_REASON : null; // focusing a field; typing is judged on its own
  if (page === "auth" && regex(MONEY_AUTH_OK).test(own)) return null;
  if (regex(MONEY_SAFE).test(own) || regex(MONEY_EXIT).test(own)) return null;
  if (page === "read" && regex(MONEY_READ_OK).test(own)) return null;
  if (regex(MONEY_MOVE).test(all) || regex(MONEY_COMMIT).test(all)) return MONEY_REASON;
  if (!all) return ACTIONABLE.has(role) ? MONEY_LABEL_REASON : null;
  if (!ACTIONABLE.has(role)) return null; // text the page didn't make clickable
  if (nameWords(own).every((part) => /^\p{N}+$/u.test(part) || READ_WORDS.has(part))) return null;
  if (TILES.has(role) && regex(MONEY_TILE).test(all)) return null;
  return MONEY_BUTTON_REASON;
}
/** Text typed into a field on a bank page: null when allowed. */
export function moneyTypeReason(url, title, label, { secure = false, secret = false } = {}) {
  if (moneyPage(url, title) === "move") return MONEY_PAGE_REASON;
  if (secure) return secret ? null : MONEY_FIELD_REASON; // a password field takes a vault value only
  const name = plain(label);
  if (!name || regex(MONEY_FIELD_DENY).test(name) || regex(MONEY_MOVE).test(name)) return MONEY_FIELD_REASON;
  return regex(MONEY_FIELD_OK).test(name) ? null : MONEY_FIELD_REASON;
}
const NAVIGATION = new Set(["tab", "escape", "esc", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
const BROWSER_COMMANDS = new Set(["[", "]", "l", "w", "f", "c", "a", "t"]); // back, forward, address bar, close tab, find, copy, select all, new tab
/**
 * A key on a bank page: null when allowed. Enter or Space presses the focused
 * control (judged as a click) or submits its field (judged as the field);
 * a character goes into the field (judged as typing).
 */
export function moneyKeyReason(url, title, key, { command = false, control = false, field = false, secure = false, labels = [], role = "" } = {}) {
  const name = String(key || "").toLowerCase();
  const inField = () => moneyTypeReason(url, title, labels[0], { secure, secret: true });
  if ((command || control) && ["v", "y"].includes(name)) return MONEY_KEY_REASON; // paste
  if (["return", "enter", "space"].includes(name)) return field || secure ? inField() : moneyClickReason(url, title, labels, role);
  if (command && !control && BROWSER_COMMANDS.has(name)) return null;
  if (!command && !control && NAVIGATION.has(name)) return null;
  if (field || secure) return command || control ? (moneyPage(url, title) === "move" ? MONEY_PAGE_REASON : null) : inField();
  return moneyPage(url, title) === "move" ? MONEY_PAGE_REASON : null;
}
// A run of 8 or more digits, or a card number in groups of four; not an
// amount (12,345,678.90) nor a date.
export const ACCOUNT_NUMBER = "(?<![\\d,.])(?:\\d{8,}|\\d{4}(?:[ -]\\d{4}){2,3})(?![\\d,.])";
/** Account and card numbers on a bank page: only their last four digits. */
export function maskAccountNumbers(text) {
  return String(text).replace(new RegExp(ACCOUNT_NUMBER, "g"), (run) => `••••${run.replace(/\D/g, "").slice(-4)}`);
}
/** The same rules as data, for the native checker. */
export const moneyRules = () => ({
  moneySites: MONEY_SITES,
  moneyMove: MONEY_MOVE, moneyCommit: MONEY_COMMIT, moneyAuthPage: MONEY_AUTH_PAGE, moneyAuthOk: MONEY_AUTH_OK,
  moneyExit: MONEY_EXIT, moneySafe: MONEY_SAFE, moneyFieldDeny: MONEY_FIELD_DENY, moneyFieldOk: MONEY_FIELD_OK,
  moneyReadPage: MONEY_READ_PAGE, moneyReadOk: MONEY_READ_OK, moneyReadWords: MONEY_READ_WORDS, moneyTile: MONEY_TILE,
  accountNumber: ACCOUNT_NUMBER,
});
