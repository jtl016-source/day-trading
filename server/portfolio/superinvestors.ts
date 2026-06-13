// ── Tracked superinvestors (13F filers) ──────────────────────────────────────
// Curated list of well-known long-term value/growth managers. Each entry has the
// fund's SEC CIK (used for FMP 13F lookups) and the manager's name.
//
// To ADD a manager: find their fund on SEC EDGAR (https://www.sec.gov/cgi-bin/browse-edgar
// ?action=getcompany&type=13F), copy the 10-digit CIK, and append a row below.
// To REMOVE one: delete its row. Wrong/most-recent CIKs simply yield empty holdings
// (the smartMoneyService degrades gracefully), so a bad row never breaks the module.
//
// NOTE: CIKs drift when funds re-register; verify against EDGAR if a fund returns no data.

export interface Superinvestor {
  cik: string;     // SEC CIK (no leading-zero requirement for FMP)
  manager: string; // person
  fund: string;    // entity
}

export const SUPERINVESTORS: Superinvestor[] = [
  { cik: "1067983", manager: "Warren Buffett",        fund: "Berkshire Hathaway" },
  { cik: "1336528", manager: "Bill Ackman",           fund: "Pershing Square Capital" },
  { cik: "1061768", manager: "Seth Klarman",          fund: "Baupost Group" },
  { cik: "1549575", manager: "Mohnish Pabrai",        fund: "Dalal Street / Pabrai Funds" },
  { cik: "1656456", manager: "David Tepper",          fund: "Appaloosa Management" },
  { cik: "1536411", manager: "Stanley Druckenmiller", fund: "Duquesne Family Office" },
  { cik: "1649339", manager: "Michael Burry",         fund: "Scion Asset Management" },
  { cik: "1040273", manager: "Daniel Loeb",           fund: "Third Point" },
  { cik: "1079114", manager: "David Einhorn",         fund: "Greenlight Capital" },
  { cik: "1350694", manager: "Ray Dalio",             fund: "Bridgewater Associates" },
  { cik: "1029160", manager: "George Soros",          fund: "Soros Fund Management" },
  { cik: "1167483", manager: "Chase Coleman",         fund: "Tiger Global Management" },
  { cik: "1061165", manager: "Stephen Mandel",        fund: "Lone Pine Capital" },
  { cik: "1135730", manager: "Philippe Laffont",      fund: "Coatue Management" },
  { cik: "1103804", manager: "Andreas Halvorsen",     fund: "Viking Global Investors" },
  { cik: "1541617", manager: "Brad Gerstner",         fund: "Altimeter Capital" },
  { cik: "1569205", manager: "Terry Smith",           fund: "Fundsmith" },
  { cik: "1709323", manager: "Li Lu",                 fund: "Himalaya Capital Management" },
  { cik: "1112520", manager: "Chuck Akre",            fund: "Akre Capital Management" },
  { cik: "1096343", manager: "Tom Gayner",            fund: "Markel Group" },
  { cik: "1418814", manager: "Mason Morfit",          fund: "ValueAct Capital" },
  { cik: "1345471", manager: "Nelson Peltz",          fund: "Trian Fund Management" },
  { cik: "1412093", manager: "Carl Icahn",            fund: "Icahn Capital" },
  { cik: "1166559", manager: "Bill Gates",            fund: "Gates Foundation Trust" },
  { cik: "1641864", manager: "Pat Dorsey",            fund: "Dorsey Asset Management" },
  { cik: "1034524", manager: "Polen Capital",         fund: "Polen Capital Management" },
  { cik: "1168087", manager: "David Rolfe",           fund: "Wedgewood Partners" },
  { cik: "1767640", manager: "David Poppe",           fund: "Giverny Capital" },
  { cik: "0860585", manager: "Tom Russo",             fund: "Gardner Russo & Quinn" },
  { cik: "1697868", manager: "Chris Hohn",            fund: "TCI Fund Management" },
  { cik: "1364742", manager: "Larry Fink",            fund: "BlackRock (reference)" },
  { cik: "1067632", manager: "Prem Watsa",            fund: "Fairfax Financial" },
  { cik: "1568820", manager: "Guy Spier",             fund: "Aquamarine Capital" },
  { cik: "1759760", manager: "Fred Liu",              fund: "Hayden Capital" },
  { cik: "1009207", manager: "Bruce Berkowitz",       fund: "Fairholme Capital" },
  { cik: "1135778", manager: "Glenn Greenberg",       fund: "Brave Warrior Advisors" },
  { cik: "1418135", manager: "Norbert Lou",           fund: "Punch Card Management" },
  { cik: "1605703", manager: "Dev Kantesaria",        fund: "Valley Forge Capital" },
  { cik: "1631664", manager: "Christopher Bloomstran",fund: "Semper Augustus" },
  { cik: "1697591", manager: "Terry Smith (US)",      fund: "Fundsmith LLP (US sub)" },
];
