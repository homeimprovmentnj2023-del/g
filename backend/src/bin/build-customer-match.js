#!/usr/bin/env node
// Build a Google Ads Customer Match upload from a customer export.
//
//   node src/bin/build-customer-match.js customers.csv --preview
//   node src/bin/build-customer-match.js customers.csv --days 30 --out ../out
//   node src/bin/build-customer-match.js telegram.json --days 30 --completed-if-value
//
// --preview prints what WOULD be uploaded and writes nothing. Always run it
// first: it shows which rows were dropped and why, so a bad status column or
// date format shows up before anything reaches Google.
const fs   = require('fs');
const path = require('path');
const { loadFile } = require('../importers');
const cm   = require('../customer-match');

function parseArgs(argv) {
  const a = { days: 30, out: null, preview: false, countryCode: 'US',
              assumeCompleted: false, completedIfValue: false,
              customerId: 'YOUR_CUSTOMER_ID', userListId: 'YOUR_USER_LIST_ID', file: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--days') a.days = Number(argv[++i]);
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--preview' || v === '--dry-run') a.preview = true;
    else if (v === '--country') a.countryCode = argv[++i].toUpperCase();
    else if (v === '--assume-completed') a.assumeCompleted = true;
    else if (v === '--completed-if-value') a.completedIfValue = true;
    else if (v === '--customer-id') a.customerId = argv[++i];
    else if (v === '--user-list-id') a.userListId = argv[++i];
    else if (!v.startsWith('--')) a.file = v;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: node src/bin/build-customer-match.js <customers.csv|telegram.json> [--days 30] [--preview] [--out DIR]');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) { console.error(`No such file: ${args.file}`); process.exit(1); }

  const { records, columns, unmapped } = loadFile(args.file);
  const { members, stats, rejects } = cm.build(records, args);

  const withPhone   = members.filter(m => m.hasPhone).length;
  const withAddress = members.filter(m => m.hasAddress).length;
  const withEmail   = members.filter(m => m.hasEmail).length;

  console.log(`\nSource      ${args.file}`);
  if (Object.keys(columns).length) console.log(`Columns     ${Object.keys(columns).join(', ')}`);
  if (unmapped.length)             console.log(`Unmapped    ${unmapped.join(', ')}  (ignored)`);
  console.log(`Window      last ${args.days} days`);
  console.log(`\n  ${String(stats.input).padStart(6)}  rows read`);
  const drop = (n, label) => { if (n) console.log(`  ${String(-n).padStart(6)}  ${label}`); };
  drop(stats.droppedNotCompleted,  'not a completed job');
  drop(stats.droppedUnknownStatus, 'status missing or unrecognized');
  drop(stats.droppedOutOfWindow,   'outside the date window');
  drop(stats.droppedNoDate,        'no usable date');
  drop(stats.droppedNoIdentifier,  'no usable phone / email / name+ZIP');
  drop(stats.droppedDuplicate,     'duplicate customer');
  console.log(`  ${String(stats.output).padStart(6)}  customers ready`);
  console.log(`\n              phone ${withPhone}   name+ZIP ${withAddress}   email ${withEmail}`);

  if (rejects.length) {
    console.log(`\nDropped rows (first 15 of ${rejects.length}):`);
    for (const r of rejects.slice(0, 15)) console.log(`  row ${String(r.row).padEnd(8)} ${r.why}`);
  }

  if (stats.output > 0 && stats.output < 1000) {
    console.log(`\n  ! ${stats.output} members. Customer Match needs about 1,000 MATCHED members`);
    console.log(`    before a list will serve, and only a fraction of any list matches.`);
    console.log(`    Re-run with a wider --days to build a list that can actually run.`);
  }

  if (args.preview) {
    console.log('\nPreview only — nothing written. Drop --preview to write the upload files.\n');
    if (members.length) {
      console.log('Sample (identities shown only as last-4 + ZIP; full values never leave this machine):');
      for (const m of members.slice(0, 5)) {
        console.log(`  ***${m.phone_last4 || '----'}  ${m.zip || '-----'}  ${m.date ? m.date.toISOString().slice(0, 10) : ''}  ${m.value != null ? '$' + m.value : ''}`);
      }
      console.log('');
    }
    return;
  }

  const outDir = args.out || path.join(__dirname, '..', '..', 'data', 'customer-match');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);

  const plan = cm.toApiPlan(members, args);
  const files = [
    [`customer-match-${stamp}.api.json`, JSON.stringify(plan, null, 2)],
    [`customer-match-${stamp}.operations.json`, JSON.stringify({ enablePartialFailure: true, operations: cm.toApiOperations(members, args) }, null, 2)],
    [`customer-match-${stamp}.csv`, cm.toCsv(members)],
    [`customer-match-${stamp}.report.json`, JSON.stringify({ source: args.file, days: args.days, generatedAt: new Date().toISOString(), stats, rejects }, null, 2)],
  ];
  for (const [name, body] of files) {
    fs.writeFileSync(path.join(outDir, name), body);
    console.log(`  wrote  ${path.join(outDir, name)}`);
  }
  console.log('\nThe .csv holds SHA-256 hashes only — no readable phone numbers or names.\n');
}

main();
